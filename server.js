require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const BINANCE = 'https://fapi.binance.com';
const BINANCE_WS = 'wss://fstream.binance.com';
let analyzeCache = {};

// ══════════════════════════════════════════════════════════════════
// ─── BINANCE ACCOUNT — BALANCE REAL (READ-ONLY) ──────────────────
// ══════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET  = process.env.BINANCE_SECRET_KEY;

function binanceSign(timestamp, recvWindow) {
  const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
  const sig = crypto.createHmac('sha256', BINANCE_SECRET || '').update(queryString).digest('hex');
  return `${queryString}&signature=${sig}`;
}

let binanceAccountCache = { data: null, ts: 0, lastError: null };
let binanceTimeOffset = 0;

async function syncBinanceTime() {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/time`, { timeout: 5000 });
    binanceTimeOffset = res.data.serverTime - Date.now();
    console.log(`⏱ Binance time sync OK — offset: ${binanceTimeOffset}ms`);
  } catch(e) { console.log(`⚠️ Binance time sync error: ${e.message}`); }
}

async function fetchBinanceAccount() {
  if (!BINANCE_API_KEY || !BINANCE_SECRET) return null;
  const now = Date.now();
  if (binanceAccountCache.data && now - binanceAccountCache.ts < 30000) return binanceAccountCache.data;
  try {
    const timestamp = Date.now() + binanceTimeOffset;
    const signed = binanceSign(timestamp, 10000);
    const res = await axios.get(`${BINANCE}/fapi/v2/account?${signed}`, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000
    });
    const d = res.data;
    const result = {
      totalWalletBalance: parseFloat(d.totalWalletBalance || 0),
      totalUnrealizedProfit: parseFloat(d.totalUnrealizedProfit || 0),
      totalMarginBalance: parseFloat(d.totalMarginBalance || 0),
      availableBalance: parseFloat(d.availableBalance || 0),
      totalPositionInitialMargin: parseFloat(d.totalPositionInitialMargin || 0),
      assets: (d.assets || []).filter(a => parseFloat(a.walletBalance) > 0).map(a => ({
        asset: a.asset, walletBalance: parseFloat(a.walletBalance),
        unrealizedProfit: parseFloat(a.unrealizedProfit), availableBalance: parseFloat(a.availableBalance)
      })),
      positions: (d.positions || []).filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
        symbol: p.symbol, positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice), unrealizedProfit: parseFloat(p.unrealizedProfit),
        leverage: parseInt(p.leverage), liquidationPrice: parseFloat(p.liquidationPrice)
      }))
    };
    binanceAccountCache = { data: result, ts: now, lastError: null };
    console.log(`✅ Binance account OK — balance: $${result.totalWalletBalance}`);
    return result;
  } catch(e) {
    const binanceErr = e.response?.data?.msg || e.message;
    const binanceCode = e.response?.data?.code || '';
    console.log(`⚠️ Binance account error [${binanceCode}]: ${binanceErr}`);
    binanceAccountCache = { data: null, ts: 0, lastError: `[${binanceCode}] ${binanceErr}` };
    if (binanceCode === -1021 || binanceCode === -1022) syncBinanceTime();
    return null;
  }
}

// fetchBestLiqData — usa Binance forceOrders (Coinglass requiere plan de pago)
async function fetchBestLiqData(symbol, price) {
  return fetchForceOrders(symbol);
}

// IP pública del servidor — para whitelist en Binance API
app.get('/api/myip', async (req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    res.json({ ip: r.data.ip, note: 'Agrega esta IP en Binance → Gestión de API → Restricciones de acceso IP' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/binance/account', async (req, res) => {
  try {
    if (!BINANCE_API_KEY || !BINANCE_SECRET) {
      return res.json({ error: 'Variables BINANCE_API_KEY o BINANCE_SECRET_KEY no encontradas en Railway', available: false });
    }
    const account = await fetchBinanceAccount();
    if (!account) {
      return res.json({ error: binanceAccountCache.lastError || 'Error desconocido', available: false });
    }
    res.json({ ...account, available: true });
  } catch(e) { res.status(500).json({ error: e.message, available: false }); }
});
app.get('/', (req, res) => res.json({ status: 'Panel Futuros LO activo', version: '4.4.15' }));

// ══════════════════════════════════════════════════════════════════
// ─── MÓDULO WEBSOCKET — DETECCIÓN EN TIEMPO REAL ─────────────────
// ══════════════════════════════════════════════════════════════════
// Estado en memoria por símbolo
const wsState = {};
const wsConnections = {};
const killSwitchCooldown = {}; // evitar múltiples kill switches seguidos

function initWsState(symbol) {
  if (wsState[symbol]) return;
  wsState[symbol] = {
    trades: [],          // últimos 120s de trades
    volumes: [],         // volúmenes por minuto (últimos 10 min)
    avgVolume1m: 0,      // promedio de volumen por minuto
    lastOI: 0,           // último OI conocido
    oiHistory: [],       // historial OI (últimos 10 min)
    lastPrice: 0,
    lastUpdate: 0,
    anomaly: null,       // última anomalía detectada
    liqZones: [],        // zonas de liquidación calculadas
  };
}

function connectWebSocket(symbol) {
  if (wsConnections[symbol]) return;
  initWsState(symbol);
  const stream = `${symbol.toLowerCase()}@aggTrade`;
  const url = `${BINANCE_WS}/ws/${stream}`;
  console.log(`🔌 WebSocket conectando: ${symbol}`);

  const ws = new (require('ws'))(url);
  wsConnections[symbol] = ws;

  ws.on('open', () => console.log(`✅ WS conectado: ${symbol}`));

  ws.on('message', (data) => {
    try {
      const t = JSON.parse(data);
      const price = parseFloat(t.p);
      const qty = parseFloat(t.q);
      const usdVal = price * qty;
      const isBuy = !t.m; // m=true significa maker = sell agresivo
      const now = Date.now();

      wsState[symbol].lastPrice = price;
      wsState[symbol].lastUpdate = now;

      // Acumular trades en ventana de 120 segundos
      wsState[symbol].trades.push({ price, qty, usdVal, isBuy, time: now });
      wsState[symbol].trades = wsState[symbol].trades.filter(tr => now - tr.time < 120000);

      // Evaluar anomalía cada 500ms (throttle)
      if (!wsState[symbol]._evalTimer) {
        wsState[symbol]._evalTimer = setTimeout(() => {
          wsState[symbol]._evalTimer = null;
          evaluateAnomaly(symbol);
        }, 500);
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    console.log(`⚠️ WS desconectado: ${symbol} — reconectando en 5s`);
    delete wsConnections[symbol];
    setTimeout(() => connectWebSocket(symbol), 5000);
  });

  ws.on('error', (e) => {
    console.log(`❌ WS error ${symbol}: ${e.message}`);
    ws.terminate();
  });
}

function getWsMetrics(symbol) {
  const state = wsState[symbol];
  if (!state || !state.trades.length) return null;
  const now = Date.now();
  const last60s = state.trades.filter(t => now - t.time < 60000);
  const last10s = state.trades.filter(t => now - t.time < 10000);
  if (!last60s.length) return null;

  const totalVol60s = last60s.reduce((s, t) => s + t.usdVal, 0);
  const buyVol60s = last60s.filter(t => t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const sellVol60s = last60s.filter(t => !t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const cvdLive = (buyVol60s - sellVol60s) / Math.max(totalVol60s, 1) * 100;

  const totalVol10s = last10s.reduce((s, t) => s + t.usdVal, 0);
  const buyVol10s = last10s.filter(t => t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const sellVol10s = last10s.filter(t => !t.isBuy).reduce((s, t) => s + t.usdVal, 0);

  // Ballenas REALES — una sola transacción que realmente mueve el mercado
  // BTC: ≥$10M, ETH: ≥$3M, otros: ≥$1M
  const whaleThreshold = symbol.includes('BTC') ? 10000000 : symbol.includes('ETH') ? 3000000 : 1000000;
  const whales60s = last60s.filter(t => t.usdVal >= whaleThreshold);
  const whaleBuyVol = whales60s.filter(t => t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const whaleSellVol = whales60s.filter(t => !t.isBuy).reduce((s, t) => s + t.usdVal, 0);

  // Calcular avgVolume1m en tiempo real — ventana de 2 a 10 minutos atrás
  // Evita depender del timer externo que tarda 5 min en arrancar
  const last600s = state.trades.filter(t => now - t.time < 600000); // últimos 10 min
  const last120s = state.trades.filter(t => now - t.time < 120000 && now - t.time >= 60000); // 1-2 min atrás
  let dynamicAvg = state.avgVolume1m; // fallback al valor externo
  if (last600s.length >= 10) {
    // Calcular promedio por minuto en los últimos 10 min
    const totalVol600s = last600s.reduce((s, t) => s + t.usdVal, 0);
    dynamicAvg = totalVol600s / 10; // promedio por minuto en ventana de 10 min
  } else if (last120s.length >= 5) {
    dynamicAvg = last120s.reduce((s, t) => s + t.usdVal, 0); // vol del minuto anterior
  }
  const effectiveAvg = Math.max(dynamicAvg, state.avgVolume1m);
  const volumeMultiplier = effectiveAvg > 0 ? totalVol60s / effectiveAvg : 1;

  return {
    totalVol60s, buyVol60s, sellVol60s, cvdLive,
    totalVol10s, buyVol10s, sellVol10s,
    whaleCount: whales60s.length, whaleBuyVol, whaleSellVol,
    avgVolume1m: effectiveAvg,
    volumeMultiplier,
    lastPrice: state.lastPrice,
    anomaly: state.anomaly
  };
}

async function evaluateAnomaly(symbol) {
  const state = wsState[symbol];
  if (!state) return;
  const metrics = getWsMetrics(symbol);
  if (!metrics) return;

  const volMultiplier = parseInt(process.env.WS_VOLUME_MULTIPLIER || '10');
  const whaleThresholdUsd = parseFloat(process.env.WS_WHALE_THRESHOLD || '2000000');
  const now = Date.now();

  // ── DETECCIÓN 1: Volumen anómalo (>10x promedio) ─────────────
  const isVolumeAnomaly = metrics.volumeMultiplier >= volMultiplier;

  // ── DETECCIÓN 2: CVD extremo en 60s (>40% dominancia) ───────
  const isBearishSweep = metrics.cvdLive < -40 && isVolumeAnomaly; // barrida bajista real
  const isBullishSweep = metrics.cvdLive > 40 && isVolumeAnomaly;  // barrida alcista real

  // ── DETECCIÓN 3: Precio moviéndose >0.5% en 60s ─────────────
  // Confirma que la presión está moviendo el mercado, no es solo ruido
  const prices60s = state.trades.filter(t => now - t.time < 60000).map(t => t.price);
  const priceMove60s = prices60s.length >= 2
    ? Math.abs(prices60s[prices60s.length-1] - prices60s[0]) / prices60s[0] * 100
    : 0;
  const isPriceMoving = priceMove60s >= 0.5;

  // Barrida real = las 3 condiciones juntas
  const isRealBearishSweep = isBearishSweep && isPriceMoving;
  const isRealBullishSweep = isBullishSweep && isPriceMoving;

  // ── DETECCIÓN 4: Ballena — individual o acumulada ─────────────
  // Nivel 1 — Ballena normal: BTC ≥$10M, ETH ≥$5M en UNA transacción (últimos 30s)
  const realWhaleThreshold = symbol.includes('BTC') ? 10000000 : symbol.includes('ETH') ? 5000000 : 1000000;
  const bigWhale = state.trades.find(t => t.usdVal >= realWhaleThreshold && now - t.time < 30000);

  // Nivel 2 — Ballena masiva: acumulado en 10s o transacción individual enorme
  // BTC: acumulado ≥$30M en 10s, o individual ≥$20M
  // ETH: acumulado ≥$10M en 10s, o individual ≥$8M
  const massiveWhaleThreshold = symbol.includes('BTC') ? 20000000 : symbol.includes('ETH') ? 8000000 : 3000000;
  const massiveAccumThreshold = symbol.includes('BTC') ? 30000000 : symbol.includes('ETH') ? 10000000 : 5000000;
  const last10sTrades = state.trades.filter(t => now - t.time < 10000);
  const last10sBuyVol  = last10sTrades.filter(t => t.isBuy).reduce((s,t) => s + t.usdVal, 0);
  const last10sSellVol = last10sTrades.filter(t => !t.isBuy).reduce((s,t) => s + t.usdVal, 0);
  const massiveWhaleSingle = state.trades.find(t => t.usdVal >= massiveWhaleThreshold && now - t.time < 30000);
  const massiveWhaleBuyAccum  = last10sBuyVol  >= massiveAccumThreshold;
  const massiveWhaleSellAccum = last10sSellVol >= massiveAccumThreshold;
  const isMassiveWhale = !!(massiveWhaleSingle || massiveWhaleBuyAccum || massiveWhaleSellAccum);
  const massiveWhaleDirection = massiveWhaleSingle
    ? (massiveWhaleSingle.isBuy ? 'LONG' : 'SHORT')
    : massiveWhaleBuyAccum ? 'LONG' : 'SHORT';
  const massiveWhaleVol = massiveWhaleSingle
    ? massiveWhaleSingle.usdVal
    : Math.max(last10sBuyVol, last10sSellVol);

  // Reemplazar referencias a isBearishSweep/isBullishSweep con las versiones "real"
  const _isBearishSweep = isRealBearishSweep;
  const _isBullishSweep = isRealBullishSweep;

  // ── DETECCIÓN 4: Zona de liquidación cercana ─────────────────
  const liqZoneBonus = calcLiqZoneBonus(symbol, metrics.lastPrice);

  if (!isRealBearishSweep && !isRealBullishSweep && !bigWhale && !isMassiveWhale) return;

  const isSweep = isRealBearishSweep || isRealBullishSweep;
  const isWhaleOnly = !isSweep && !!bigWhale && !isMassiveWhale;
  const direction = isRealBearishSweep ? 'SHORT' : isRealBullishSweep ? 'LONG'
    : isMassiveWhale ? massiveWhaleDirection
    : (bigWhale?.isBuy ? 'LONG' : 'SHORT');
  const reason = isRealBearishSweep ? `Barrida bajista — CVD ${metrics.cvdLive.toFixed(1)}% vol ${metrics.volumeMultiplier.toFixed(1)}x precio -${priceMove60s.toFixed(2)}%` :
                 isRealBullishSweep ? `Barrida alcista — CVD +${metrics.cvdLive.toFixed(1)}% vol ${metrics.volumeMultiplier.toFixed(1)}x precio +${priceMove60s.toFixed(2)}%` :
                 isMassiveWhale ? `🐋 Ballena masiva $${(massiveWhaleVol/1e6).toFixed(1)}M ${massiveWhaleDirection === 'LONG' ? 'comprando' : 'vendiendo'}${massiveWhaleSingle ? ' (orden única)' : ' (acumulada 10s)'}` :
                 `Ballena $${(bigWhale.usdVal/1e6).toFixed(2)}M ${bigWhale.isBuy ? 'comprando' : 'vendiendo'}`;

  // Evitar spam — cooldown de 3 minutos por símbolo+dirección
  const cooldownKey = `${symbol}_${direction}`;
  if (killSwitchCooldown[cooldownKey] && now - killSwitchCooldown[cooldownKey] < 3 * 60 * 1000) return;
  killSwitchCooldown[cooldownKey] = now;

  // Solo guardar anomalía si es barrida real (no ballena sola)
  if (isSweep || isWhaleOnly) {
    state.anomaly = {
      direction,
      reason,
      time: now,
      volumeMultiplier: metrics.volumeMultiplier,
      cvdLive: metrics.cvdLive,
      liqZoneBonus,
      isSweep: !!(isRealBearishSweep || isRealBullishSweep),
      isWhale: !!bigWhale && !isSweep
    };
    // Auto-limpiar anomalía después de 5 minutos
    setTimeout(() => {
      if (wsState[symbol]?.anomaly?.time === now) {
        wsState[symbol].anomaly = null;
      }
    }, 5 * 60 * 1000);
  }

  console.log(`⚡ ANOMALÍA DETECTADA: ${direction} ${symbol} — ${reason} (liq bonus: +${liqZoneBonus})`);

  if (isSweep) {
    // ── BARRIDA REAL: Kill switch + Sweep trade ──
    await killSwitchOpposite(symbol, direction, reason);
    await openSweepCounterTrade(symbol, direction, metrics, reason, liqZoneBonus);
  } else if (isMassiveWhale) {
    // ── BALLENA MASIVA: Abre trade en dirección de la ballena ──
    await openWhaleCounterTrade(symbol, massiveWhaleDirection, metrics, reason, liqZoneBonus);
  }
  // Ballena normal: SOLO influye en señales, sin acción automática

  // ── ALERTA TELEGRAM ─────────────────────────────────────────
  if (process.env.TELEGRAM_CHAT_ID) {
    if (isSweep) {
      const sweepLabel = isRealBearishSweep ? '🔴 BARRIDA BAJISTA' : '🟢 BARRIDA ALCISTA';
      const msg = `${sweepLabel} — ${symbol}\n⚡ ${reason}\n💹 Vol: ${metrics.volumeMultiplier.toFixed(1)}x promedio\n📊 CVD 60s: ${metrics.cvdLive.toFixed(1)}%\n🐋 Ballenas: ${metrics.whaleCount} (${(metrics.whaleBuyVol/1e6).toFixed(2)}M buy / ${(metrics.whaleSellVol/1e6).toFixed(2)}M sell)${liqZoneBonus > 0 ? '\n🧲 Imán liq +' + liqZoneBonus + '%' : ''}\n🛡️ Kill Switch + Sweep trade abierto\n🕐 ${new Date().toLocaleTimeString('es-PE')}`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
    } else if (isMassiveWhale) {
      const emoji = massiveWhaleDirection === 'LONG' ? '🟢' : '🔴';
      const msg = `${emoji} 🐋 BALLENA MASIVA — ${symbol}\n${reason}\n📊 CVD 60s: ${metrics.cvdLive.toFixed(1)}%\n💹 Vol: ${metrics.volumeMultiplier.toFixed(1)}x promedio\n⚡ Trade automático abierto en dirección ${massiveWhaleDirection}\n🕐 ${new Date().toLocaleTimeString('es-PE')}`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
    }
    // Ballena normal — sin notificación, solo influye en señales
  }


// ── ABRIR TRADE EN DIRECCIÓN DE BALLENA MASIVA ──────────────────
async function openWhaleCounterTrade(symbol, direction, metrics, reason, liqBonus) {
  try {
    // No abrir si ya hay trade abierto en ese par
    const { data: existing } = await supabase.from('paper_trades')
      .select('id').eq('symbol', symbol).eq('status', 'open');
    if (existing?.length) {
      console.log(`⏭ Whale trade omitido — ya hay trade abierto para ${symbol}`);
      return;
    }

    const price = metrics.lastPrice;
    if (!price) return;

    // Usar klines 5m para ATR — ballenas tienen movimiento más lento que barridas
    const k5m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=20`);
    const highs5m = k5m.data.map(k => parseFloat(k[2]));
    const lows5m  = k5m.data.map(k => parseFloat(k[3]));
    const atr5m   = highs5m.slice(-10).reduce((s,h,i) => s + (h - lows5m[i]), 0) / 10;
    const atr = Math.max(atr5m, price * 0.004); // mínimo 0.4%

    const isLong = direction === 'LONG';

    // TP más amplio que scalping — ballena mueve el precio gradualmente
    const tp1 = isLong ? price + atr * 2.0 : price - atr * 2.0;
    const sl  = isLong ? price - atr * 0.8 : price + atr * 0.8;

    if (isLong && sl >= price) return;
    if (!isLong && sl <= price) return;

    const rrVal = Math.abs(tp1 - price) / Math.abs(sl - price);
    if (rrVal < 1.5) {
      console.log(`⚠️ Whale trade descartado — R:R ${rrVal.toFixed(2)} < 1.5`);
      return;
    }

    // Confianza basada en tamaño de la ballena
    const whaleConfidence = Math.min(92, Math.round(
      72 +
      (metrics.volumeMultiplier >= 5 ? 10 : 5) +
      liqBonus
    ));

    await supabase.from('paper_trades').insert({
      symbol,
      direction,
      entry: price,
      tp1,
      tp2: isLong ? price + atr * 3.5 : price - atr * 3.5,
      sl,
      rr: `1:${rrVal.toFixed(1)}`,
      confidence: whaleConfidence,
      size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'),
      leverage: parseInt(process.env.PAPER_LEVERAGE || '5'),
      source: 'sweep', // reutiliza source sweep para ML
      status: 'open',
      opened_at: new Date().toISOString(),
      market_data: {
        mode: 'whale',
        reason,
        cvd_live: metrics.cvdLive,
        volume_multiplier: metrics.volumeMultiplier,
        whale_count: metrics.whaleCount,
        liq_bonus: liqBonus,
        timestamp: new Date().toISOString()
      }
    });

    console.log(`🐋 Whale trade abierto: ${direction} ${symbol} @ $${price} R:R 1:${rrVal.toFixed(1)} conf:${whaleConfidence}%`);

    if (process.env.TELEGRAM_CHAT_ID) {
      const e = direction === 'SHORT' ? '▼' : '▲';
      const msg = `🐋 *Whale Trade Abierto — ${symbol}*\n${e} ${direction} @ $${parseInt(price).toLocaleString()}\n🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}\n📐 R:R 1:${rrVal.toFixed(1)} | ${whaleConfidence}%\n${reason}`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
    }
  } catch(e) {
    console.error('Whale trade error:', e.message);
  }
}

async function killSwitchOpposite(symbol, sweepDirection, reason) {
  try {
    const oppositeDir = sweepDirection === 'SHORT' ? 'LONG' : 'SHORT';
    const { data: openTrades } = await supabase.from('paper_trades')
      .select('*').eq('symbol', symbol).eq('status', 'open').eq('direction', oppositeDir);
    if (!openTrades?.length) return;

    for (const trade of openTrades) {
      const currentPrice = wsState[symbol]?.lastPrice || parseFloat(trade.entry);
      const entry = parseFloat(trade.entry);
      const sl = parseFloat(trade.sl);

      // Solo actuar si precio ya recorrió >60% del camino hacia el SL
      const totalDistance = Math.abs(sl - entry);
      const currentDistance = Math.abs(currentPrice - entry);
      const slProgress = totalDistance > 0 ? currentDistance / totalDistance : 0;

      if (slProgress < 0.6) {
        console.log(`⏭ Kill switch omitido — ${trade.direction} ${symbol} al ${(slProgress*100).toFixed(0)}% del SL`);
        if (process.env.TELEGRAM_CHAT_ID) {
          const msg = `⏭ Kill Switch omitido — ${trade.direction} ${symbol}\nAl ${(slProgress*100).toFixed(0)}% del SL — margen suficiente\nPrecio: $${parseInt(currentPrice).toLocaleString()} | SL: $${parseInt(sl).toLocaleString()}`;
          try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
        }
        continue;
      }

      const priceDiff = trade.direction === 'LONG'
        ? (currentPrice - entry) / entry
        : (entry - currentPrice) / entry;
      const _lev1 = parseFloat(trade.leverage || 10);
      const pnl_usd = parseFloat((parseFloat(trade.size_usd) * priceDiff * _lev1).toFixed(2));
      const pnl_pct = parseFloat((priceDiff * _lev1 * 100).toFixed(2));

      await supabase.from('paper_trades').update({
        status: pnl_usd >= 0 ? 'won' : 'lost',
        close_price: currentPrice,
        close_reason: 'kill_switch',
        pnl_usd, pnl_pct,
        closed_at: new Date().toISOString()
      }).eq('id', trade.id);

      console.log(`🛡️ Kill switch: cerrado ${trade.direction} ${symbol} @ $${currentPrice} PnL: $${pnl_usd} (${(slProgress*100).toFixed(0)}% hacia SL)`);

      if (process.env.TELEGRAM_CHAT_ID) {
        const msg = `🛡️ *Kill Switch activado*\n${trade.direction} ${symbol} cerrado\nEntry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentPrice).toLocaleString()}\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\nRazón: ${reason}`;
        try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
      }
    }
  } catch(e) { console.error('Kill switch error:', e.message); }
}

// ── ABRIR POSICIÓN CONTRA LA BARRIDA (5m analysis) ──────────────
async function openSweepCounterTrade(symbol, direction, metrics, reason, liqBonus) {
  try {
    // No abrir si ya hay trade abierto en ese par
    const { data: existing } = await supabase.from('paper_trades')
      .select('id').eq('symbol', symbol).eq('status', 'open');
    if (existing?.length) {
      console.log(`⏭ Sweep trade omitido — ya hay trade abierto para ${symbol}`);
      return;
    }

    const price = metrics.lastPrice;
    if (!price) return;

    // Obtener klines de 5m para calcular ATR y niveles precisos
    const k5m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=20`);
    const highs5m = k5m.data.map(k => parseFloat(k[2]));
    const lows5m  = k5m.data.map(k => parseFloat(k[3]));
    const atr5m   = highs5m.slice(-10).reduce((s,h,i) => s + (h - lows5m[i]), 0) / 10;
    const atr = Math.max(atr5m, price * 0.003); // mínimo 0.3%

    const isShort = direction === 'SHORT';

    // TP apunta a la zona de liquidación más cercana en la dirección del sweep
    // SL ajustado — barridas son rápidas, SL estrecho
    const tp1 = isShort ? price - atr * 2.5 : price + atr * 2.5;
    const sl  = isShort ? price + atr * 0.8  : price - atr * 0.8;
    const rrVal = Math.abs(tp1 - price) / Math.abs(sl - price);

    if (rrVal < 1.5) {
      console.log(`⚠️ Sweep trade descartado — R:R ${rrVal.toFixed(2)} < 1.5`);
      return;
    }

    // Confianza basada en intensidad de la barrida
    const sweepConfidence = Math.min(95, Math.round(
      70 +
      (metrics.volumeMultiplier >= 10 ? 15 : metrics.volumeMultiplier >= 7 ? 10 : 5) +
      (Math.abs(metrics.cvdLive) >= 50 ? 10 : 5) +
      liqBonus
    ));

    // Obtener datos adicionales para market_data completo en sweep
    let bias4hSweep = null, bias1dSweep = null, oiTrend15mSweep = null, fundingSweep = 0, fib15mSweep = null;
    try {
      const [k15mSw, k4hSw, k1dSw, oi15mSw, oi4hSw, fundSw] = await Promise.all([
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=50`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
        fetchOIHistory(symbol,'15m',5),
        fetchOIHistory(symbol,'4h',5),
        axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      ]);
      fundingSweep = parseFloat(fundSw.data.lastFundingRate);
      bias4hSweep = calcBias(k4hSw.data, oi4hSw, fundingSweep);
      bias1dSweep = calcBias(k1dSw.data, null, fundingSweep);
      oiTrend15mSweep = calcOITrend(oi15mSw);
      fib15mSweep = calcFibonacci(k15mSw.data, price);
    } catch(_) {}

    const mlDataSweep = {
      confidence: sweepConfidence,
      direction,
      mode: 'sweep',
      price,
      sweep_reason: reason,
      cvd_live: metrics.cvdLive,
      volume_multiplier: metrics.volumeMultiplier,
      whale_count: metrics.whaleCount,
      whale_buy_vol: (metrics.whaleBuyVol/1e6).toFixed(2),
      whale_sell_vol: (metrics.whaleSellVol/1e6).toFixed(2),
      liq_bonus: liqBonus,
      atr_5m: atr.toFixed(1),
      funding_rate: fundingSweep,
      oi_trend_15m: oiTrend15mSweep?.trend || 'flat',
      oi_delta_15m: oiTrend15mSweep?.deltaPct || '0',
      bias_4h: bias4hSweep?.bias || 'neutral',
      bias_4h_score: bias4hSweep?.score || 50,
      bias_1d: bias1dSweep?.bias || 'neutral',
      bias_1d_score: bias1dSweep?.score || 50,
      fib_level: fib15mSweep?.nearestRetrace?.label || null,
      fib_dist: fib15mSweep?.nearestRetrace?.dist || null,
      fib_signal: fib15mSweep?.retImpact?.signal || null,
      rsi_15m: null, // se calcula en k15mSw si está disponible
      timestamp: new Date().toISOString()
    };

    await supabase.from('paper_trades').insert({
      symbol,
      direction,
      entry: price,
      tp1, tp2: isShort ? price - atr * 4 : price + atr * 4,
      sl,
      rr: `1:${rrVal.toFixed(1)}`,
      confidence: sweepConfidence,
      size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'),
      leverage: parseInt(process.env.PAPER_LEVERAGE || '10'),
      source: 'sweep',
      status: 'open',
      opened_at: new Date().toISOString(),
      market_data: mlDataSweep
    });

    console.log(`⚡ Sweep trade abierto: ${direction} ${symbol} @ $${price} R:R 1:${rrVal.toFixed(1)} conf:${sweepConfidence}%`);

    if (process.env.TELEGRAM_CHAT_ID) {
      const e = direction === 'SHORT' ? '▼' : '▲';
      const msg = `⚡ *Sweep Trade Abierto — ${symbol}*
${e} ${direction} @ $${parseInt(price).toLocaleString()}
🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}
📐 R:R 1:${rrVal.toFixed(1)} | ${sweepConfidence}%
⚡ ${reason}`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
    }
  } catch(e) {
    console.error('Sweep trade error:', e.message);
  }
}

// ── LIQUIDEZ COMO SEÑAL ACTIVA ────────────────────────────────────
// Calcula bonus/penalty según cercanía a zonas de liquidación
function calcLiqZoneBonus(symbol, price) {
  if (!price) return 0;
  // Zonas estáticas calibradas para BTC (ajustables por ML en el futuro)
  const zones = [
    { dist: -0.018, size: 240 }, { dist: -0.025, size: 380 },
    { dist: -0.042, size: 490 }, { dist: -0.055, size: 620 },
    { dist: -0.075, size: 830 }, { dist: 0.015, size: 210 },
    { dist: 0.028, size: 320 }, { dist: 0.045, size: 480 },
    { dist: 0.068, size: 740 }, { dist: 0.095, size: 950 }
  ];
  let maxBonus = 0;
  for (const z of zones) {
    const zonePrice = price * (1 + z.dist);
    const distPct = Math.abs(price - zonePrice) / price * 100;
    if (distPct < 1.0) { // dentro del 1% de distancia
      const bonus = z.size > 700 ? 20 : z.size > 500 ? 15 : z.size > 300 ? 10 : 5;
      if (bonus > maxBonus) maxBonus = bonus;
    }
  }
  return maxBonus;
}

// Suma bonus de liquidez a las probabilidades de divergencias
function applyLiqZoneProbBonus(divergences, price) {
  if (!price || !divergences.length) return divergences;
  const zones = [
    { dist: -0.018, size: 240, direction: 'down' }, { dist: -0.025, size: 380, direction: 'down' },
    { dist: -0.042, size: 490, direction: 'down' }, { dist: -0.055, size: 620, direction: 'down' },
    { dist: -0.075, size: 830, direction: 'down' }, { dist: 0.015, size: 210, direction: 'up' },
    { dist: 0.028, size: 320, direction: 'up' }, { dist: 0.045, size: 480, direction: 'up' },
    { dist: 0.068, size: 740, direction: 'up' }, { dist: 0.095, size: 950, direction: 'up' }
  ];

  return divergences.map(d => {
    let liqBonus = 0;
    for (const z of zones) {
      const zonePrice = price * (1 + z.dist);
      const distPct = Math.abs(price - zonePrice) / price * 100;
      if (distPct < 1.5) {
        // Zona de liq ABAJO del precio → atrae SHORT (precio va a barrer stops de longs)
        // Zona de liq ARRIBA del precio → atrae LONG (precio va a barrer stops de shorts)
        const liqDirection = z.dist < 0 ? 'SHORT' : 'LONG';
        if (d.direction === liqDirection) {
          const bonus = z.size > 700 ? 12 : z.size > 500 ? 8 : z.size > 300 ? 5 : 3;
          liqBonus = Math.max(liqBonus, bonus);
        }
      }
    }
    if (liqBonus > 0) {
      return {
        ...d,
        probability: Math.min(95, d.probability + liqBonus),
        confluence: [...(d.confluence || []), `🧲 Imán liq +${liqBonus}%`]
      };
    }
    return d;
  });
}

// Endpoint para estado del WebSocket
app.get('/api/ws/status', (req, res) => {
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT,ETHUSDT').split(',');
  const status = {};
  for (const sym of symbols) {
    const metrics = getWsMetrics(sym.trim());
    status[sym.trim()] = {
      connected: !!wsConnections[sym.trim()],
      lastUpdate: wsState[sym.trim()]?.lastUpdate || 0,
      lastPrice: wsState[sym.trim()]?.lastPrice || 0,
      metrics: metrics ? {
        cvdLive: metrics.cvdLive?.toFixed(1),
        volumeMultiplier: metrics.volumeMultiplier?.toFixed(2),
        whaleCount: metrics.whaleCount,
        anomaly: metrics.anomaly
      } : null
    };
  }
  res.json(status);
});


function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) { avgGain = (avgGain*(period-1)+diff)/period; avgLoss = (avgLoss*(period-1))/period; }
    else { avgGain = (avgGain*(period-1))/period; avgLoss = (avgLoss*(period-1)+Math.abs(diff))/period; }
  }
  return Math.round(100 - 100 / (1 + avgGain/(avgLoss||0.001)));
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a,b) => a+b,0)/period;
  const std = Math.sqrt(slice.reduce((s,v) => s+Math.pow(v-sma,2),0)/period);
  return { upper: sma+mult*std, middle: sma, lower: sma-mult*std };
}

function calcVWAP(klines) {
  let cumTPV = 0, cumVol = 0;
  klines.forEach(k => { const tp=(parseFloat(k[2])+parseFloat(k[3])+parseFloat(k[4]))/3; const vol=parseFloat(k[5]); cumTPV+=tp*vol; cumVol+=vol; });
  return cumVol > 0 ? cumTPV/cumVol : 0;
}

function calcCVD(klines) {
  let cumulative = 0;
  const deltas = klines.map(k => {
    const open=parseFloat(k[1]),close=parseFloat(k[4]),vol=parseFloat(k[5]);
    const buyRatio = close>open?1:close<open?0:0.5;
    const delta = vol*buyRatio - vol*(1-buyRatio);
    cumulative += delta;
    return { delta, cumulative, vol };
  });
  const last5 = deltas.slice(-5);
  const delta5 = last5.reduce((s,d)=>s+d.delta,0);
  const delta3 = deltas.slice(-3).reduce((s,d)=>s+d.delta,0);
  const prevCum = deltas[deltas.length-6]?.cumulative||0;
  const cvdPct = prevCum!==0?((cumulative-prevCum)/Math.abs(prevCum)*100).toFixed(2):'0.00';
  const avgVol = deltas.slice(-20).reduce((s,d)=>s+d.vol,0)/20;
  const lastVol = deltas[deltas.length-1]?.vol||0;
  const volPct = avgVol>0?((lastVol-avgVol)/avgVol*100).toFixed(1):'0.0';
  const isClimax = Math.abs(parseFloat(delta3))>Math.abs(delta5)*0.8 && Math.abs(lastVol)>avgVol*2;
  return { cumulative, delta5, delta3, cvdPct:parseFloat(cvdPct), volPct:parseFloat(volPct), trend:delta5>0?'bull':'bear', isClimax };
}

function calcVRVP(klines) {
  const buckets={};let totalVol=0;
  klines.forEach(k=>{ const high=parseFloat(k[2]),low=parseFloat(k[3]),vol=parseFloat(k[5]); const mid=Math.round((high+low)/2/50)*50; buckets[mid]=(buckets[mid]||0)+vol; totalVol+=vol; });
  const sorted=Object.entries(buckets).sort((a,b)=>b[1]-a[1]);
  const poc=parseFloat(sorted[0]?.[0]||0);
  const prices=Object.keys(buckets).map(Number).sort((a,b)=>a-b);
  let cumVol=0; const vah70=[],val70=[];
  for(const p of [...prices].reverse()){cumVol+=buckets[p];if(cumVol/totalVol<=0.7)vah70.push(p);}
  cumVol=0;
  for(const p of prices){cumVol+=buckets[p];if(cumVol/totalVol<=0.3)val70.push(p);}
  const vah=vah70.length?Math.max(...vah70):poc;
  const val=val70.length?Math.min(...val70):poc;
  return { poc, vah:Math.max(vah,poc), val:Math.min(val,poc) };
}

async function fetchOIHistory(symbol, interval, limit=10) {
  try {
    const res = await axios.get(`${BINANCE}/futures/data/openInterestHist?symbol=${symbol}&period=${interval}&limit=${limit}`);
    return res.data||[];
  } catch(e){ return []; }
}

function calcOITrend(oiHistory) {
  if(!oiHistory||oiHistory.length<2) return { trend:'flat', deltaPct:'0.000', current:0 };
  const first=parseFloat(oiHistory[0]?.sumOpenInterest||0);
  const last=parseFloat(oiHistory[oiHistory.length-1]?.sumOpenInterest||0);
  const deltaPct=first>0?((last-first)/first*100).toFixed(3):'0.000';
  const trend=parseFloat(deltaPct)>0.1?'rising':parseFloat(deltaPct)<-0.1?'falling':'flat';
  return { trend, deltaPct, current:last };
}

function calcBias(klines, oiData=null, fundingRate=0) {
  if(!klines||!Array.isArray(klines)||klines.length<20) return { bias:'neutral', score:50, rsi:50, cvdPct:0, volPct:0, oiTrend:'flat', oiDeltaPct:'0.000', fundingRate:0 };
  const closes=klines.map(k=>parseFloat(k[4]));
  const highs=klines.map(k=>parseFloat(k[2]));
  const lows=klines.map(k=>parseFloat(k[3]));
  const rsi=calcRSI(closes);
  const cvd=calcCVD(klines);
  const vwap=calcVWAP(klines);
  const last=closes[closes.length-1];
  const prev5avg=closes.slice(-6,-1).reduce((a,b)=>a+b,0)/5;
  const priceVsPrev=prev5avg>0?((last-prev5avg)/prev5avg*100):0;
  const recentHighs=highs.slice(-5), recentLows=lows.slice(-5);
  const hhCount=recentHighs.filter((h,i)=>i>0&&h>recentHighs[i-1]).length;
  const llCount=recentLows.filter((l,i)=>i>0&&l<recentLows[i-1]).length;
  const aboveVwap=last>vwap;
  const oiTrend=oiData?calcOITrend(oiData):{trend:'flat',deltaPct:'0.000',current:0};
  let score=50;
  if(priceVsPrev>0.3) score+=12; else if(priceVsPrev<-0.3) score-=12;
  if(hhCount>=3) score+=10; if(llCount>=3) score-=10;
  if(rsi>70) score-=25; else if(rsi>60) score+=8; else if(rsi<30) score+=25; else if(rsi<40) score-=8;
  const cvdExtreme = Math.abs(cvd.cvdPct) > 15;
  if(cvd.delta5>0) score += cvdExtreme ? 15 : 10; else score -= cvdExtreme ? 15 : 10;
  if(aboveVwap) score+=5; else score-=5;
  if(oiTrend.trend==='rising'&&priceVsPrev>0) score+=8;
  if(oiTrend.trend==='rising'&&priceVsPrev<0) score-=8;
  if(oiTrend.trend==='falling'&&priceVsPrev<0) score-=5;
  if(oiTrend.trend==='falling'&&priceVsPrev>0) score+=3;
  if(fundingRate>0.001) score-=5; if(fundingRate<-0.001) score+=5;
  score=Math.min(95,Math.max(5,Math.round(score)));
  return {
    bias: score>60?'long':score<40?'short':'neutral',
    score, rsi, cvdPct:cvd.cvdPct, volPct:cvd.volPct,
    aboveVwap, vwap:vwap.toFixed(1),
    priceVsPrev: parseFloat(priceVsPrev.toFixed(2)),
    oiTrend:oiTrend.trend, oiDeltaPct:oiTrend.deltaPct, oiCurrent:oiTrend.current,
    fundingRate, frBias:fundingRate>0.001?'longs_hot':fundingRate<-0.001?'shorts_hot':'neutral'
  };
}

function analyzeOB(bids,asks) {
  if(!bids?.length||!asks?.length) return {};
  const bidVol=bids.slice(0,10).reduce((s,b)=>s+parseFloat(b[1]),0);
  const askVol=asks.slice(0,10).reduce((s,a)=>s+parseFloat(a[1]),0);
  const imbalance=((bidVol-askVol)/(bidVol+askVol)*100).toFixed(1);
  const avgBid=bidVol/10,avgAsk=askVol/10;
  const bidWalls=bids.slice(0,20).filter(b=>parseFloat(b[1])>avgBid*3).map(b=>({price:parseFloat(b[0]),size:parseFloat(b[1])}));
  const askWalls=asks.slice(0,20).filter(a=>parseFloat(a[1])>avgAsk*3).map(a=>({price:parseFloat(a[0]),size:parseFloat(a[1])}));
  return { bidVol:bidVol.toFixed(2), askVol:askVol.toFixed(2), imbalance, pressure:parseFloat(imbalance)>15?'bid_dominant':parseFloat(imbalance)<-15?'ask_dominant':'balanced', bidWalls, askWalls, spread:(parseFloat(asks[0][0])-parseFloat(bids[0][0])).toFixed(1), spreadPct:((parseFloat(asks[0][0])-parseFloat(bids[0][0]))/parseFloat(bids[0][0])*100).toFixed(4), topBid:parseFloat(bids[0][0]), topAsk:parseFloat(asks[0][0]) };
}

function getNearestLiqMagnet(price,direction) {
  const zones=[{dist:-0.018,size:240,label:'Stop longs'},{dist:-0.025,size:380,label:'Zona shorts'},{dist:-0.042,size:490,label:'Pool liq.'},{dist:-0.055,size:620,label:'Cluster grande'},{dist:-0.075,size:830,label:'Imán mayor'},{dist:0.015,size:210,label:'Stop shorts'},{dist:0.028,size:320,label:'Zona longs'},{dist:0.045,size:480,label:'Pool liq. arriba'},{dist:0.068,size:740,label:'Cluster arriba'}];
  const filtered=zones.filter(z=>direction==='down'?z.dist<0:z.dist>0);
  const nearest=filtered.sort((a,b)=>Math.abs(a.dist)-Math.abs(b.dist))[0];
  if(!nearest) return null;
  const bonus=nearest.size>700?20:nearest.size>500?15:nearest.size>300?10:5;
  return { price:(price*(1+nearest.dist)).toFixed(0), size:nearest.size, label:nearest.label, dist:Math.abs(nearest.dist*100).toFixed(1), bonus };
}

function calcLiqMagnets(price) {
  const zones=[{dist:-0.018,size:240,label:'Stop longs'},{dist:-0.025,size:380,label:'Zona shorts'},{dist:-0.042,size:490,label:'Pool liq.'},{dist:-0.055,size:620,label:'Cluster grande'},{dist:-0.075,size:830,label:'Imán mayor'},{dist:0.015,size:210,label:'Stop shorts'},{dist:0.028,size:320,label:'Zona longs'},{dist:0.045,size:480,label:'Pool liq. arriba'},{dist:0.068,size:740,label:'Cluster arriba'},{dist:0.095,size:950,label:'Imán crítico'}];
  return zones.map(z=>({price:parseFloat((price*(1+z.dist)).toFixed(0)),size:z.size,label:z.label,dist:Math.abs(z.dist*100).toFixed(1),direction:z.dist>0?'up':'down',isMajor:z.size>=600,isEstimated:true})).sort((a,b)=>Math.abs(parseFloat(a.dist))-Math.abs(parseFloat(b.dist)));
}

// ── LIQUIDACIONES REALES — combina fetchForceOrders con zonas estáticas ──
function calcRealLiqMagnets(price, liqData) {
  // Si no hay datos reales, usar estáticos
  if (!liqData?.zones?.length) return calcLiqMagnets(price);

  // Convertir zonas reales de Binance a formato de liqMagnets
  const realZones = liqData.zones
    .filter(z => z.total >= 50) // mínimo $50K para ser relevante
    .map(z => {
      const dist = ((z.price - price) / price * 100);
      const direction = z.price > price ? 'up' : 'down';
      // Tamaño en M USD — usar total de la zona
      const sizeM = Math.round(z.total / 1000 * 10) / 10; // z.total está en K
      const label = z.dominant === 'longs'
        ? (direction === 'down' ? 'Stop longs reales' : 'Zona longs reales')
        : (direction === 'up' ? 'Stop shorts reales' : 'Zona shorts reales');
      return {
        price: z.price,
        size: Math.max(sizeM, 10), // mínimo 10M para visualización
        label,
        dist: Math.abs(dist).toFixed(1),
        direction,
        isMajor: z.total >= 500, // mayor si >$500K
        isReal: true, // dato real de Binance
        dominant: z.dominant
      };
    })
    .filter(z => Math.abs(parseFloat(z.dist)) <= 10) // solo zonas dentro del 10%
    .sort((a,b) => Math.abs(parseFloat(a.dist)) - Math.abs(parseFloat(b.dist)))
    .slice(0, 15);

  // Si hay suficientes zonas reales, usarlas. Si no, mezclar con estáticas
  if (realZones.length >= 5) {
    return realZones;
  }

  // Mezclar: reales primero, completar con estáticas que no se solapan
  const staticZones = calcLiqMagnets(price);
  const realPrices = new Set(realZones.map(z => Math.round(z.price / 100) * 100));
  const filteredStatic = staticZones.filter(z => !realPrices.has(Math.round(z.price / 100) * 100));
  return [...realZones, ...filteredStatic].sort((a,b) => Math.abs(parseFloat(a.dist)) - Math.abs(parseFloat(b.dist))).slice(0, 12);
}

function calcFibonacci(klines, price) {
  if (!klines || klines.length < 20) return null;
  const highs = klines.map(k => parseFloat(k[2]));
  const lows  = klines.map(k => parseFloat(k[3]));
  const n = klines.length;
  let swingHigh = -Infinity, swingLow = Infinity, swingHighIdx = 0, swingLowIdx = 0;
  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      if (highs[i] > swingHigh) { swingHigh = highs[i]; swingHighIdx = i; }
    }
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      if (lows[i] < swingLow) { swingLow = lows[i]; swingLowIdx = i; }
    }
  }
  if (swingHigh === -Infinity || swingLow === Infinity) return null;
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  const isUptrend = swingLowIdx < swingHighIdx;
  const retLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const extLevels = [1.272, 1.414, 1.618, 2.0, 2.618];
  const retracements = retLevels.map(r => ({ level: r, price: isUptrend ? swingHigh - range * r : swingLow + range * r, label: r === 0 ? '0%' : r === 1 ? '100%' : `${(r*100).toFixed(1)}%`, isKey: [0.382, 0.5, 0.618].includes(r) }));
  const extensions = extLevels.map(r => ({ level: r, price: isUptrend ? swingHigh + range * (r - 1) : swingLow - range * (r - 1), label: `${(r*100).toFixed(1)}%`, isKey: [1.618, 2.618].includes(r) }));
  let nearestRetrace = null, nearestExt = null, minRetDist = Infinity, minExtDist = Infinity;
  retracements.forEach(lvl => { const dist = Math.abs(price - lvl.price) / price * 100; if (dist < minRetDist) { minRetDist = dist; nearestRetrace = { ...lvl, dist: parseFloat(dist.toFixed(2)) }; } });
  extensions.forEach(lvl => { const dist = Math.abs(price - lvl.price) / price * 100; if (dist < minExtDist) { minExtDist = dist; nearestExt = { ...lvl, dist: parseFloat(dist.toFixed(2)) }; } });
  function fibImpact(nearest, isRetracement) {
    if (!nearest) return { bonus: 0, penalty: 0, signal: 'none' };
    const isVeryClose = nearest.dist < 0.3, isClose = nearest.dist < 0.8;
    if (!isClose) return { bonus: 0, penalty: 0, signal: 'none', description: '' };
    if (isRetracement && nearest.isKey) return { bonus: isVeryClose ? 15 : 8, penalty: 0, signal: isUptrend ? 'long_bounce' : 'short_bounce', description: `Precio en retroceso Fib ${nearest.label} — zona de rebote clave` };
    if (!isRetracement && nearest.isKey) return { bonus: 0, penalty: isVeryClose ? 12 : 6, signal: isUptrend ? 'short_exhaustion' : 'long_exhaustion', description: `Precio en extensión Fib ${nearest.label} — zona de agotamiento` };
    return { bonus: isVeryClose ? 5 : 3, penalty: 0, signal: 'weak', description: `Nivel Fib ${nearest.label} cercano` };
  }
  const retImpact = fibImpact(nearestRetrace, true);
  const extImpact = fibImpact(nearestExt, false);
  return {
    swingHigh: parseFloat(swingHigh.toFixed(1)), swingLow: parseFloat(swingLow.toFixed(1)),
    isUptrend, range: parseFloat(range.toFixed(1)),
    retracements: retracements.map(r => ({ ...r, price: parseFloat(r.price.toFixed(1)) })),
    extensions: extensions.map(r => ({ ...r, price: parseFloat(r.price.toFixed(1)) })),
    nearestRetrace: nearestRetrace ? { ...nearestRetrace, price: parseFloat(nearestRetrace.price.toFixed(1)) } : null,
    nearestExt: nearestExt ? { ...nearestExt, price: parseFloat(nearestExt.price.toFixed(1)) } : null,
    retImpact, extImpact, totalBonus: retImpact.bonus + extImpact.bonus, totalPenalty: retImpact.penalty + extImpact.penalty
  };
}

function detectDivergences(klines15m, ob, price, fundingRate, bias4h, bias1d, oiTrend15m, fib=null) {
  try {
  if (!klines15m || !Array.isArray(klines15m) || klines15m.length < 20) return [];
  const divergences=[];
  const closes=klines15m.map(k=>parseFloat(k[4]||0));
  if (!closes || closes.length < 20 || closes.every(c => isNaN(c) || c === 0)) return [];
  const highs=klines15m.map(k=>parseFloat(k[2]));
  const lows=klines15m.map(k=>parseFloat(k[3]));
  const volumes=klines15m.map(k=>parseFloat(k[5]));
  const cvd=calcCVD(klines15m);
  const vwap=calcVWAP(klines15m);
  const rsiValues=[];
  for(let i=15;i<closes.length;i++) rsiValues.push(calcRSI(closes.slice(0,i+1)));
  const lastRSI=rsiValues[rsiValues.length-1];
  const prevRSI=rsiValues[rsiValues.length-4];
  const prevRSI8=rsiValues[rsiValues.length-8]||prevRSI;
  const lastHigh=Math.max(...highs.slice(-3)),prevHigh=Math.max(...highs.slice(-8,-3)),prevHigh2=Math.max(...highs.slice(-14,-8));
  const lastLow=Math.min(...lows.slice(-3)),prevLow=Math.min(...lows.slice(-8,-3)),prevLow2=Math.min(...lows.slice(-14,-8));
  const lastClose=closes[closes.length-1];
  const prevClose5=closes.length>=6?closes[closes.length-6]:closes[0]||0;
  const prevClose10=closes.length>=11?closes[closes.length-11]:closes[0]||0;
  const priceUp=lastClose>prevClose5, priceDown=lastClose<prevClose5;
  const priceUp10=lastClose>prevClose10, priceDown10=lastClose<prevClose10;
  const cvdFalling=cvd.delta5<0, cvdRising=cvd.delta5>0;
  const cvdAgressive=Math.abs(cvd.cvdPct)>5;
  const avgVol=volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
  const lastVol=volumes[volumes.length-1];
  const volClimaxUp=lastVol>avgVol*2.5&&priceUp, volClimaxDown=lastVol>avgVol*2.5&&priceDown;
  const trend4h=bias4h?.bias||'neutral', trend1d=bias1d?.bias||'neutral';
  const bearishContext=trend4h==='short'||trend1d==='short', bullishContext=trend4h==='long'||trend1d==='long';
  const oiRising=oiTrend15m?.trend==='rising', oiFalling=oiTrend15m?.trend==='falling';
  const aboveVwap=lastClose>vwap, belowVwap=lastClose<vwap;
  const hasBidWall=(ob.bidWalls?.length||0)>0, hasAskWall=(ob.askWalls?.length||0)>0;

  // ── WebSocket bonus — suma si hay anomalía activa en tiempo real ──
  const wsAnomaly = wsState[Object.keys(wsState).find(k => k.startsWith(price > 10000 ? 'BTC' : 'ETH'))]?.anomaly;
  const wsAnomalyBonus = (dir) => {
    if (!wsAnomaly || Date.now() - wsAnomaly.time > 5 * 60 * 1000) return 0;
    if (wsAnomaly.isSweep) {
      return wsAnomaly.direction === dir ? 10 : -8;
    } else if (wsAnomaly.isWhale) {
      return wsAnomaly.direction === dir ? 5 : -5;
    }
    return 0;
  };

  if(priceUp&&cvdRising&&cvdAgressive){
    let prob=65; if(hasAskWall) prob+=10; if(oiFalling) prob+=8; if(lastRSI>65) prob+=7; if(lastRSI>75) prob+=8;
    if(bearishContext) prob+=8; if(aboveVwap) prob+=5; if(volClimaxUp) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('SHORT');
    // Sin barrida WS confirmada, capear en 82% — evitar falsos positivos
    const hasRealSweep = wsAnomalyBonus('SHORT') > 0;
    if (!hasRealSweep) prob = Math.min(82, prob);
    divergences.push({ type:'absorcion_compras', name:'Absorción de Compras', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`CVD +${cvd.cvdPct}% agresivo con muro vendedor — precio se agotará.${bearishContext?' 4H/1D bajista.':''}${!hasRealSweep?' (sin barrida confirmada)':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',hasAskWall&&'Muro ask',oiFalling&&'OI cayendo',bearishContext&&'Contexto bajista',hasRealSweep&&'⚡ Barrida WS confirmada'].filter(Boolean) });
  }
  if(priceDown&&cvdFalling&&cvdAgressive){
    let prob=65; if(hasBidWall) prob+=8; if(lastRSI<35) prob+=10; if(lastRSI<25) prob+=8;
    if(bullishContext) prob+=8; if(belowVwap) prob+=5; if(oiFalling) prob+=5; if(volClimaxDown) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('LONG');
    // Sin ballena real confirmada (WS o detector), capear en 82% — evitar falsos positivos
    const hasRealWhale = wsAnomalyBonus('LONG') > 0;
    if (!hasRealWhale) prob = Math.min(82, prob);
    divergences.push({ type:'absorcion_ventas', name:'Absorción de Ventas', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`${hasRealWhale?'🐋 Ballena confirmada':'CVD'} ${cvd.cvdPct}% mientras precio baja.${bullishContext?' 4H/1D alcista.':''}${!hasRealWhale?' (sin ballena confirmada)':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',oiFalling&&'OI cayendo',bullishContext&&'Contexto alcista',hasRealWhale&&'⚡ Barrida WS confirmada'].filter(Boolean) });
  }
  if(lastHigh>prevHigh&&lastRSI<prevRSI-3){
    let prob=64; if(cvdFalling) prob+=15; if(oiRising&&priceUp) prob+=5; if(lastRSI>60) prob+=7; if(lastRSI>70) prob+=8;
    if(bearishContext) prob+=8; if(hasAskWall) prob+=8; if(prevHigh>prevHigh2&&prevRSI<prevRSI8-2) prob+=10;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('SHORT');
    divergences.push({ type:'rsi_bajista', name:'Div. RSI Bajista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`Precio HH ($${parseInt(lastHigh).toLocaleString()}) pero RSI LH (${lastRSI} vs ${prevRSI}) — momentum agotado.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[cvdFalling&&'CVD divergente',bearishContext&&'Contexto bajista',hasAskWall&&'Muro ask'].filter(Boolean) });
  }
  if(lastLow<prevLow&&lastRSI>prevRSI+3){
    let prob=64; if(cvdRising) prob+=15; if(lastRSI<40) prob+=7; if(lastRSI<30) prob+=8;
    if(bullishContext) prob+=8; if(hasBidWall) prob+=8; if(prevLow<prevLow2&&prevRSI>prevRSI8+2) prob+=10;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('LONG');
    divergences.push({ type:'rsi_alcista', name:'Div. RSI Alcista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Precio LL ($${parseInt(lastLow).toLocaleString()}) pero RSI HL (${lastRSI} vs ${prevRSI}) — vendedores agotados.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista',hasBidWall&&'Muro bid'].filter(Boolean) });
  }
  if(priceUp&&cvdFalling){
    let prob=65; if(oiRising) prob+=8; if(lastRSI>60) prob+=8; if(cvdAgressive) prob+=7; if(bearishContext) prob+=8; if(aboveVwap) prob+=5;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('SHORT');
    divergences.push({ type:'cvd_precio_bajista', name:'Div. CVD/Precio Bajista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`Precio sube pero CVD ${cvd.cvdPct}% negativo — subida sin respaldo real de volumen.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }
  if(priceDown&&cvdRising){
    let prob=65; if(lastRSI<40) prob+=10; if(cvdAgressive) prob+=7; if(bullishContext) prob+=8; if(belowVwap) prob+=5; if(oiFalling) prob+=5;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('LONG');
    divergences.push({ type:'cvd_precio_alcista', name:'Div. CVD/Precio Alcista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Precio baja pero CVD +${cvd.cvdPct}% — demanda oculta absorbiendo la caída.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'Shorts cerrando',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }
  if(priceUp&&oiFalling&&cvdFalling){
    let prob=72; if(lastRSI>65) prob+=8; if(bearishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('SHORT');
    divergences.push({ type:'bull_trap', name:'Trampa Alcista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:'Subida con OI cayendo y CVD negativo — shorts liquidados sin demanda real. Fakeout.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'OI cayendo',cvdFalling&&'CVD divergente',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }
  if(priceDown&&oiFalling&&cvdRising){
    let prob=72; if(lastRSI<35) prob+=8; if(bullishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('LONG');
    divergences.push({ type:'bear_trap', name:'Trampa Bajista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:'Caída con OI cayendo y CVD positivo — longs liquidados sin oferta real. Fakeout bajista.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'OI cayendo',cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }
  if(oiRising&&priceDown10&&cvdFalling){
    let prob=70; if(lastRSI<50) prob+=8; if(bearishContext) prob+=10; if(cvdAgressive) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('SHORT');
    divergences.push({ type:'short_buildup', name:'Short Buildup', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:'OI sube mientras precio cae — nuevas posiciones cortas con convicción.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',cvdFalling&&'CVD negativo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }
  if(oiRising&&priceUp10&&cvdRising){
    let prob=70; if(lastRSI>50&&lastRSI<70) prob+=8; if(bullishContext) prob+=10; if(cvdAgressive) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('LONG');
    divergences.push({ type:'long_buildup', name:'Long Buildup', direction:'LONG', probability:Math.min(95,prob), entry:price, description:'OI sube mientras precio sube — nuevas posiciones largas con convicción.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }
  if(Math.abs(fundingRate)>0.0008){
    const isBull=fundingRate>0; let prob=68;
    if(Math.abs(fundingRate)>0.002) prob+=12; else if(Math.abs(fundingRate)>0.001) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,isBull?'down':'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'funding_extremo', name:'Funding Extremo', direction:isBull?'SHORT':'LONG', probability:Math.min(90,prob), entry:price, description:`FR ${(fundingRate*100).toFixed(4)}% — ${isBull?'longs sobrecalentados':'shorts en riesgo'}`, action:prob>=75?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:[`FR ${(fundingRate*100).toFixed(4)}%`] });
  }
  if(cvd.isClimax){
    const dir=cvd.delta5>0?'SHORT':'LONG'; let prob=73;
    const nearLiq=getNearestLiqMagnet(price,dir==='SHORT'?'down':'up'); if(nearLiq) prob+=nearLiq.bonus;
    if(dir==='SHORT'&&bearishContext) prob+=8; if(dir==='LONG'&&bullishContext) prob+=8;
    prob += wsAnomalyBonus(dir);
    divergences.push({ type:'volumen_climax', name:'Volumen Clímax', direction:dir, probability:Math.min(92,prob), entry:price, description:`Vol extremo (2.5x avg) — agotamiento inminente. Clímax = reversión.`, action:prob>=80?'ENTRAR':'ESPERAR', liqTarget:nearLiq?.price, confluence:['Vol 2.5x avg'] });
  }
  if(oiRising&&fundingRate<-0.0005&&priceDown){
    let prob=72; if(cvdFalling) prob+=8; if(bearishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'long_squeeze', name:'Squeeze de Longs', direction:'SHORT', probability:Math.min(90,prob), entry:price, description:'OI alto + funding negativo + precio cae — longs liquidados en cascada.', action:prob>=78?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:['OI alto','Funding negativo','Precio cayendo'] });
  }
  if(oiRising&&fundingRate>0.002&&priceUp){
    let prob=72; if(cvdRising) prob+=8; if(bullishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'short_squeeze', name:'Squeeze de Shorts', direction:'LONG', probability:Math.min(90,prob), entry:price, description:'OI alto + funding muy positivo + precio sube — shorts liquidados.', action:prob>=78?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:['OI alto','Funding extremo','Precio subiendo'] });
  }
  if (fib) {
    divergences.forEach(d => {
      const isLong = d.direction === 'LONG'; const isShort = d.direction === 'SHORT';
      if (fib.retImpact.signal === 'long_bounce' && isLong) d.probability = Math.min(95, d.probability + fib.retImpact.bonus);
      if (fib.retImpact.signal === 'short_bounce' && isShort) d.probability = Math.min(95, d.probability + fib.retImpact.bonus);
      if (fib.extImpact.signal === 'short_exhaustion' && isShort) d.probability = Math.min(95, d.probability + 10);
      if (fib.extImpact.signal === 'long_exhaustion' && isLong) d.probability = Math.min(95, d.probability + 10);
      if (fib.extImpact.signal === 'short_exhaustion' && isLong) d.probability = Math.max(5, d.probability - fib.extImpact.penalty);
      if (fib.extImpact.signal === 'long_exhaustion' && isShort) d.probability = Math.max(5, d.probability - fib.extImpact.penalty);
    });
  }
  const priceDownRegime = closes.length >= 6 ? lastClose < closes[closes.length - 6] : false;
  const bearExhaustion = [lastRSI < 35, cvdRising && priceDownRegime, oiFalling && priceDownRegime, fundingRate < -0.0005, lastVol > avgVol * 2 && priceDownRegime].filter(Boolean).length;
  if (bearExhaustion >= 3) {
    let prob = 65 + (bearExhaustion * 6);
    if (bullishContext) prob = Math.min(95, prob + 10); if (hasBidWall) prob = Math.min(95, prob + 8);
    const nearLiq = getNearestLiqMagnet(price, 'up'); if (nearLiq) prob += nearLiq.bonus;
    prob += wsAnomalyBonus('LONG');
    divergences.push({ type:'regime_change_long', name:'Cambio de Régimen — LONG', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`${bearExhaustion}/5 señales agotamiento bajista — ${bearExhaustion>=4?'Señal MUY FUERTE.':'Confirmar con vela alcista.'}`, action:prob>=82?'ENTRAR':prob>=68?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[lastRSI<35&&'RSI sobreventa',cvdRising&&priceDownRegime&&'CVD divergente',oiFalling&&priceDownRegime&&'OI cayendo',fundingRate<-0.0005&&'Funding negativo'].filter(Boolean) });
  }
  const priceUpRegime = closes.length >= 6 ? lastClose > closes[closes.length - 6] : false;
  const bullExhaustion = [lastRSI > 68, cvdFalling && priceUpRegime, oiFalling && priceUpRegime, fundingRate > 0.001, lastVol > avgVol * 2 && priceUpRegime].filter(Boolean).length;
  if (bullExhaustion >= 3) {
    let prob = 65 + (bullExhaustion * 6);
    if (bearishContext) prob = Math.min(95, prob + 10); if (hasAskWall) prob = Math.min(95, prob + 8);
    const nearLiq = getNearestLiqMagnet(price, 'down'); if (nearLiq) prob += nearLiq.bonus;
    prob += wsAnomalyBonus('SHORT');
    divergences.push({ type:'regime_change_short', name:'Cambio de Régimen — SHORT', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`${bullExhaustion}/5 señales agotamiento alcista — ${bullExhaustion>=4?'Señal MUY FUERTE.':'Confirmar con vela bajista.'}`, action:prob>=82?'ENTRAR':prob>=68?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[lastRSI>68&&'RSI sobrecompra',cvdFalling&&priceUpRegime&&'CVD divergente',oiFalling&&priceUpRegime&&'OI cayendo',fundingRate>0.001&&'Funding positivo'].filter(Boolean) });
  }
  // ── Aplicar bonus de zonas de liquidación a todas las divergencias ──
  const divsWithLiq = applyLiqZoneProbBonus(divergences, price);
  return divsWithLiq.sort((a,b)=>b.probability-a.probability);
  } catch(e) { console.error('detectDivergences error:', e.message); return []; }
}

function calcCombinedSignal(divergences, bias4h, bias1d, whaleData=null, deepOB=null, fib=null, bias1h=null) {
  const absorcionCount = divergences.filter(d => d.type === 'absorcion_compras' || d.type === 'absorcion_ventas').length;
  if(!divergences.length) return { direction:'ESPERAR', probability:30, action:'ESPERAR', reason:'Sin divergencias activas' };
  const shorts=divergences.filter(d=>d.direction==='SHORT');
  const longs=divergences.filter(d=>d.direction==='LONG');
  const shortScore=shorts.reduce((s,d)=>s+d.probability,0)/(shorts.length||1);
  const longScore=longs.reduce((s,d)=>s+d.probability,0)/(longs.length||1);
  let direction=shorts.length>longs.length?'SHORT':longs.length>shorts.length?'LONG':'ESPERAR';
  let prob=direction==='SHORT'?shortScore:direction==='LONG'?longScore:30;
  const regimeLong  = divergences.find(d => d.type === 'regime_change_long');
  const regimeShort = divergences.find(d => d.type === 'regime_change_short');
  if (regimeLong && direction === 'SHORT') { prob = Math.max(5, prob - 30); if (regimeLong.probability >= 80) prob = 5; }
  if (regimeShort && direction === 'LONG') { prob = Math.max(5, prob - 30); if (regimeShort.probability >= 80) prob = 5; }
  const both4hAnd1dLong  = bias4h?.bias==='long'  && bias1d?.bias==='long';
  const both4hAnd1dShort = bias4h?.bias==='short' && bias1d?.bias==='short';
  const only4hLong  = bias4h?.bias==='long'  && bias1d?.bias!=='short';
  const only4hShort = bias4h?.bias==='short' && bias1d?.bias!=='long';
  // Si 1H es contrario al 4H, reducir el bonus del 4H a la mitad
  const bias1hContraLong  = bias4h?.bias==='long'  && (bias4h?.tf1h?.bias==='short' || false);
  const bias1hContraShort = bias4h?.bias==='short' && (bias4h?.tf1h?.bias==='long'  || false);
  if(direction==='LONG'){
    if(both4hAnd1dLong) prob=Math.min(95,prob+15);
    else if(only4hLong) prob=Math.min(95,prob+8);
    if(bias1d?.bias==='short') prob=Math.max(5,prob-10);
    // Penalizar si 1H es bajista — contexto de corto plazo en contra
    if(bias1h?.bias==='short') prob=Math.max(5,prob-12);
  }
  if(direction==='SHORT'){
    if(both4hAnd1dShort) prob=Math.min(95,prob+15);
    else if(only4hShort) prob=Math.min(95,prob+8);
    if(bias1d?.bias==='long') prob=Math.max(5,prob-10);
    // Penalizar si 1H es alcista — contexto de corto plazo en contra
    if(bias1h?.bias==='long') prob=Math.max(5,prob-12);
  }
  if(whaleData && whaleData.whaleCount >= 3) {
    if(direction==='LONG' && whaleData.whaleBias==='bull') prob=Math.min(95,prob+10);
    if(direction==='SHORT' && whaleData.whaleBias==='bear') prob=Math.min(95,prob+10);
    if(direction==='LONG' && whaleData.whaleBias==='bear') prob=Math.max(5,prob-8);
    if(direction==='SHORT' && whaleData.whaleBias==='bull') prob=Math.max(5,prob-8);
  }
  if(deepOB) {
    const deepImb = deepOB.deepImbalance || 0;
    if(direction==='LONG' && deepImb > 20) prob=Math.min(95,prob+6);
    if(direction==='SHORT' && deepImb < -20) prob=Math.min(95,prob+6);
  }
  if (fib) {
    if (direction === 'LONG' && fib.retImpact.signal === 'long_bounce') prob = Math.min(95, prob + fib.totalBonus);
    if (direction === 'SHORT' && fib.retImpact.signal === 'short_bounce') prob = Math.min(95, prob + fib.totalBonus);
    if (direction === 'SHORT' && fib.extImpact.signal === 'short_exhaustion') prob = Math.min(95, prob + 10);
    if (direction === 'LONG' && fib.extImpact.signal === 'long_exhaustion') prob = Math.min(95, prob + 10);
    prob = Math.max(5, prob - fib.totalPenalty);
  }
  if (absorcionCount >= 2) prob = Math.min(95, prob + 8);
  const topDiv = divergences[0];
  if (topDiv && absorcionCount >= 1 && divergences.length >= 3) prob = Math.min(95, prob + 5);
  const isRegimeChange = (regimeLong && direction==='LONG') || (regimeShort && direction==='SHORT');
  const action = isRegimeChange && prob >= 75 ? '⚠️ CAMBIO DE RÉGIMEN — ENTRAR' : prob>=82?'ENTRAR':prob>=68?'ESPERAR CONFIRMACIÓN':'NO ENTRAR';
  const fibSummary = fib?.nearestRetrace?.dist < 0.8 ? `Fib ${fib.nearestRetrace.label} cerca` : fib?.nearestExt?.dist < 0.8 ? `Ext Fib ${fib.nearestExt.label} cerca` : null;
  const whaleSummary = whaleData?.whaleCount > 0 ? `${whaleData.whaleCount} ballenas — ${whaleData.dominance}` : null;
  return { direction, probability:Math.round(prob), action, shortCount:shorts.length, longCount:longs.length, whaleSummary, fibSummary };
}

async function fetchForceOrders(symbol) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/allForceOrders?symbol=${symbol}&limit=200`);
    const orders = res.data || [];
    const bucketSize = symbol.includes('BTC') ? 100 : symbol.includes('ETH') ? 10 : 1;
    const buckets = {};
    let totalLongs = 0, totalShorts = 0;
    orders.forEach(o => {
      const price = parseFloat(o.averagePrice || o.price);
      const qty = parseFloat(o.executedQty || o.origQty);
      const usdVal = price * qty;
      const bucket = Math.round(price / bucketSize) * bucketSize;
      if (!buckets[bucket]) buckets[bucket] = { price: bucket, longLiq: 0, shortLiq: 0, total: 0 };
      if (o.side === 'SELL') { buckets[bucket].longLiq += usdVal; totalLongs += usdVal; }
      else { buckets[bucket].shortLiq += usdVal; totalShorts += usdVal; }
      buckets[bucket].total += usdVal;
    });
    const zones = Object.values(buckets).filter(b => b.total > 10000).sort((a, b) => b.total - a.total).slice(0, 20).map(b => ({ price: b.price, longLiq: Math.round(b.longLiq / 1000), shortLiq: Math.round(b.shortLiq / 1000), total: Math.round(b.total / 1000), dominant: b.longLiq > b.shortLiq ? 'longs' : 'shorts' }));
    return { zones, totalLongs: Math.round(totalLongs/1000), totalShorts: Math.round(totalShorts/1000), count: orders.length };
  } catch(e) { return { zones: [], totalLongs: 0, totalShorts: 0, count: 0 }; }
}

async function fetchDeepOrderBook(symbol) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=500`);
    const bids = res.data.bids || [], asks = res.data.asks || [];
    const bucketSize = symbol.includes('BTC') ? 50 : symbol.includes('ETH') ? 5 : 0.5;
    function clusterSide(orders, side) {
      const buckets = {};
      orders.forEach(([priceStr, qtyStr]) => { const price = parseFloat(priceStr), qty = parseFloat(qtyStr); const bucket = Math.round(price / bucketSize) * bucketSize; buckets[bucket] = (buckets[bucket] || 0) + qty; });
      const vals = Object.values(buckets);
      const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
      const std = Math.sqrt(vals.reduce((s,v)=>s+Math.pow(v-mean,2),0)/vals.length);
      const threshold = mean + std * 1.2;
      return Object.entries(buckets).filter(([, qty]) => qty > threshold).map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty.toFixed(2)), usdVal: Math.round(parseFloat(price) * qty), side, strength: qty / mean, breakProb: Math.round(Math.min(85, Math.max(15, 100 - (qty/mean)*15))) })).sort((a, b) => b.qty - a.qty).slice(0, 8);
    }
    const bidClusters = clusterSide(bids, 'bid');
    const askClusters = clusterSide(asks, 'ask');
    const totalBidLiq = bids.reduce((s,[,q])=>s+parseFloat(q),0);
    const totalAskLiq = asks.reduce((s,[,q])=>s+parseFloat(q),0);
    const deepImbalance = ((totalBidLiq - totalAskLiq) / (totalBidLiq + totalAskLiq) * 100).toFixed(1);
    return { bidClusters, askClusters, deepImbalance: parseFloat(deepImbalance), totalBidLiq: totalBidLiq.toFixed(1), totalAskLiq: totalAskLiq.toFixed(1) };
  } catch(e) { return { bidClusters: [], askClusters: [], deepImbalance: 0 }; }
}

async function detectWhales(symbol, price) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/aggTrades?symbol=${symbol}&limit=500`);
    const trades = res.data || [];
    const whaleThreshold = symbol.includes('BTC') ? 10000000 : symbol.includes('ETH') ? 3000000 : 1000000;
    const whales = [];
    let whaleBuyVol = 0, whaleSellVol = 0, totalBuyVol = 0, totalSellVol = 0;
    trades.forEach(t => {
      const tradePrice = parseFloat(t.p), qty = parseFloat(t.q), usdVal = tradePrice * qty;
      const isBuy = !t.m;
      if (isBuy) totalBuyVol += usdVal; else totalSellVol += usdVal;
      if (usdVal >= whaleThreshold) { whales.push({ price: tradePrice, qty: qty.toFixed(3), usdVal: Math.round(usdVal), side: isBuy ? 'buy' : 'sell', time: t.T, isAggressive: true }); if (isBuy) whaleBuyVol += usdVal; else whaleSellVol += usdVal; }
    });
    const whaleCVD = whaleBuyVol - whaleSellVol;
    const whaleBias = whaleCVD > 0 ? 'bull' : whaleCVD < 0 ? 'bear' : 'neutral';
    const whaleRatio = (whaleBuyVol + whaleSellVol) / (totalBuyVol + totalSellVol + 1) * 100;
    return { whales: whales.slice(-10), whaleBuyVol: Math.round(whaleBuyVol / 1000), whaleSellVol: Math.round(whaleSellVol / 1000), whaleCVD: Math.round(whaleCVD / 1000), whaleBias, whaleCount: whales.length, whaleRatio: parseFloat(whaleRatio.toFixed(1)), lastWhale: whales[whales.length - 1] || null, dominance: whaleBuyVol > whaleSellVol * 1.5 ? 'buyers' : whaleSellVol > whaleBuyVol * 1.5 ? 'sellers' : 'balanced' };
  } catch(e) { return { whales: [], whaleBuyVol: 0, whaleSellVol: 0, whaleCVD: 0, whaleBias: 'neutral', whaleCount: 0 }; }
}

app.get('/api/market/:symbol', async (req, res) => {
  try {
    const symbol=req.params.symbol||'BTCUSDT';
    const [ticker,oiRes,funding,k15m,k1h,k4h,k1d,obRes,oi15mHist,oi1hHist,oi4hHist] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=60`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=20`),
      fetchOIHistory(symbol,'15m',10), fetchOIHistory(symbol,'1h',10), fetchOIHistory(symbol,'4h',10),
    ]);
    const price_temp = parseFloat(ticker.data.lastPrice);
    const [liqData, deepOB, whaleData] = await Promise.all([fetchBestLiqData(symbol, price_temp), fetchDeepOrderBook(symbol), detectWhales(symbol, price_temp)]);
    const price=parseFloat(ticker.data.lastPrice);
    const fundingRate=parseFloat(funding.data.lastFundingRate);
    if(!k15m.data||!Array.isArray(k15m.data)||k15m.data.length<20) throw new Error('Insufficient kline data');
    const closes15m=k15m.data.map(k=>parseFloat(k[4]));
    const cvd15m=calcCVD(k15m.data);
    const vrvp=calcVRVP(k15m.data);
    const bb15m=calcBB(closes15m);
    const vwap15m=calcVWAP(k15m.data);
    const rsi15m=calcRSI(closes15m);
    const ob=analyzeOB(obRes.data.bids,obRes.data.asks);
    const liqMagnets=calcRealLiqMagnets(price, liqData);
    const oiTrend15m=calcOITrend(oi15mHist);
    const oiTrend1h=calcOITrend(oi1hHist);
    const oiTrend4h=calcOITrend(oi4hHist);
    const bias15m=calcBias(k15m.data,oi15mHist,fundingRate);
    const bias1h=calcBias(k1h.data,oi1hHist,fundingRate);
    const bias4h=calcBias(k4h.data,oi4hHist,fundingRate);
    const bias1d=calcBias(k1d.data,null,fundingRate);
    const fib15m = calcFibonacci(k15m.data, price);
    const fib4h  = calcFibonacci(k4h.data, price);
    const divergences=detectDivergences(k15m.data,ob,price,fundingRate,bias4h,bias1d,oiTrend15m,fib15m);
    const doublePatterns=detectDoublePatterns(k15m.data,price);
    const allDivs=[...divergences,...doublePatterns];
    const combinedSignal=calcCombinedSignal(allDivs,bias4h,bias1d,whaleData,deepOB,fib15m,bias1h);
    const scalpSignal=calcScalpSignal(allDivs,calcBias(k15m.data,oi15mHist,fundingRate),calcBias(k1h.data,oi1hHist,fundingRate),bias4h);
    const vols=k15m.data.slice(-5).map(k=>parseFloat(k[5]));
    const avgVol5=vols.slice(0,-1).reduce((a,b)=>a+b,0)/4;
    const lastVol=vols[vols.length-1];
    const volDeltaPct=avgVol5>0?((lastVol-avgVol5)/avgVol5*100).toFixed(1):'0.0';
    // Incluir métricas WS en tiempo real
    const wsMetrics = getWsMetrics(symbol);
    res.json({ price, change24h:parseFloat(ticker.data.priceChangePercent), volume24h:parseFloat(ticker.data.quoteVolume), openInterest:parseFloat(oiRes.data.openInterest), fundingRate, markPrice:parseFloat(funding.data.markPrice), indexPrice:parseFloat(funding.data.indexPrice), rsi15m, rsiOverbought:rsi15m>70, rsiOversold:rsi15m<30, cvd15m, vrvp, bb15m, vwap15m:vwap15m.toFixed(1), oiTrends:{ tf15m:oiTrend15m, tf1h:oiTrend1h, tf4h:oiTrend4h }, volDeltaPct:parseFloat(volDeltaPct), orderBook:ob, liqMagnets, divergences:allDivs, combinedSignal, scalpSignal, doublePatterns, bias:{ tf15m:bias15m, tf1h:bias1h, tf4h:bias4h, tf1d:bias1d }, klines:k15m.data.slice(-20), liqData, deepOB, whaleData, fibonacci:{ tf15m:fib15m, tf4h:fib4h }, wsMetrics });
  } catch(e) { console.error('Market error:',e.message); res.status(500).json({ error:e.message }); }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { marketData:d, symbol } = req.body;
    const now=Date.now();
    if(analyzeCache[symbol]&&now-analyzeCache[symbol].ts<60000) return res.json(analyzeCache[symbol].data);
    // Solo divergencias ≥90% al prompt para evitar señales débiles que confundan a Claude
    const strongDivs2 = (d.divergences||[]).filter(dv => dv.probability >= 90);
    // Verificar mayoría clara antes de llamar a Claude
    const _shortCount = (d.divergences||[]).filter(dv => dv.direction === 'SHORT' && dv.probability >= 90).length;
    const _longCount  = (d.divergences||[]).filter(dv => dv.direction === 'LONG'  && dv.probability >= 90).length;
    const _dominant = _shortCount > _longCount ? 'SHORT' : 'LONG';
    const _domCount = Math.max(_shortCount, _longCount);
    const _oppCount = Math.min(_shortCount, _longCount);
    const _hasMajority = _domCount >= 2 && _domCount > _oppCount * 1.5;
    const _hasAny = _domCount >= 1 && _oppCount === 0;
    if (!_hasMajority && !_hasAny && d.combinedSignal?.direction === 'ESPERAR') {
      return res.json({ direction:'ESPERAR', confidence:30, action:'NO ENTRAR', reasoning:'Señales divididas — sin ventaja clara en ninguna dirección.', entry:d.price, tp1:d.price, tp2:d.price, sl:d.price, rr:'1:0' });
    }
    const divSummary = strongDivs2.length
      ? strongDivs2.slice(0,4).map(dv=>`${dv.name}: ${dv.direction} ${dv.probability}% — ${dv.description}`).join('\n')
      : (d.divergences||[]).slice(0,2).map(dv=>`${dv.name}: ${dv.direction} ${dv.probability}% — ${dv.description}`).join('\n') || 'Ninguna';
    const b=d.bias;
    const wsM = getWsMetrics(symbol);
    const wsNote = wsM && Math.abs(wsM.cvdLive) > 20 ? `\nWS TIEMPO REAL: CVD=${wsM.cvdLive.toFixed(1)}% vol=${wsM.volumeMultiplier.toFixed(1)}x ballenas=${wsM.whaleCount}` : '';
    const prompt=`Eres un trader experto en futuros perpetuos de criptomonedas. Analiza y da señal precisa.

MERCADO: ${symbol} — $${d.price} (${d.change24h>0?'+':''}${d.change24h?.toFixed(2)}%)
RSI 15m: ${d.rsi15m} ${d.rsiOverbought?'⚠ SOBRECOMPRA':d.rsiOversold?'⚠ SOBREVENTA':''}
CVD 15m: delta5=${d.cvd15m?.delta5?.toFixed(0)}, tendencia=${d.cvd15m?.trend}, cvdPct=${d.cvd15m?.cvdPct}%
OI: ${d.openInterest?.toFixed(0)} | Funding: ${(d.fundingRate*100)?.toFixed(4)}%
VRVP: POC=$${d.vrvp?.poc} VAH=$${d.vrvp?.vah} VAL=$${d.vrvp?.val}

SESGO MULTI-TF:
15m: ${b?.tf15m?.bias}(${b?.tf15m?.score}) RSI=${b?.tf15m?.rsi} OI=${b?.tf15m?.oiTrend}(${b?.tf15m?.oiDeltaPct}%) FR=${(b?.tf15m?.fundingRate*100)?.toFixed(4)}%
1H:  ${b?.tf1h?.bias}(${b?.tf1h?.score}) RSI=${b?.tf1h?.rsi} OI=${b?.tf1h?.oiTrend}(${b?.tf1h?.oiDeltaPct}%)
4H:  ${b?.tf4h?.bias}(${b?.tf4h?.score}) RSI=${b?.tf4h?.rsi} OI=${b?.tf4h?.oiTrend}(${b?.tf4h?.oiDeltaPct}%)
1D:  ${b?.tf1d?.bias}(${b?.tf1d?.score}) RSI=${b?.tf1d?.rsi}

DIVERGENCIAS (${d.divergences?.length||0}):
${divSummary}

SEÑAL: ${d.combinedSignal?.direction} ${d.combinedSignal?.probability}% — ${d.combinedSignal?.action}
LIBRO: ${d.orderBook?.pressure} imb=${d.orderBook?.imbalance}%
IMÁN: ${d.liqMagnets?.[0]?.direction==='down'?'↓':'↑'} $${d.liqMagnets?.[0]?.price} (${d.liqMagnets?.[0]?.dist}% $${d.liqMagnets?.[0]?.size}M)${wsNote}

REGLAS: RSI>72 no long; RSI<28 no short; OI+precio misma dirección=trend real; OI cae+precio sube=trampa; funding>0.002%=sobrecalentado.
R:R OBLIGATORIO: usa los imanes de liquidación del mapa como TP objetivo. Para SHORT: TP1 = primera zona de liquidación ABAJO del precio (Stop longs). Para LONG: TP1 = primera zona de liquidación ARRIBA (Stop shorts). SL en zona de resistencia/soporte real. TP1 debe ser mínimo 1.5x la distancia del SL. Si no hay zona de liquidación accesible con R:R ≥1:1.5, da direction=ESPERAR.

Responde SOLO JSON sin markdown:
{"direction":"LONG|SHORT|ESPERAR","confidence":0-100,"entry":precio,"tp1":precio,"tp2":precio,"sl":precio,"rr":"1:X","reasoning":"2-3 oraciones en español","warning":"riesgo principal o vacío","action":"ENTRAR|ESPERAR|NO ENTRAR"}`;

    const response=await anthropic.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:600, messages:[{role:'user',content:prompt}] });
    const text=response.content[0].text;
    const signal=JSON.parse(text.replace(/```json|```/g,'').trim());
    const _rrReward = signal.direction === 'SHORT' ? (signal.entry - signal.tp1) : (signal.tp1 - signal.entry);
    const _rrRisk   = signal.direction === 'SHORT' ? (signal.sl - signal.entry) : (signal.entry - signal.sl);
    const _rrVal    = (_rrRisk > 0) ? (_rrReward / _rrRisk) : 0;
    signal.rr = `1:${_rrVal.toFixed(1)}`;
    // Si confianza < 90%, no guardar como señal activa
    if (signal.confidence < 90) {
      signal.direction = 'ESPERAR';
      signal.action = 'NO ENTRAR';
      signal.reasoning = `Confianza ${signal.confidence}% insuficiente (mínimo 90%). ` + signal.reasoning;
    }
    analyzeCache[symbol]={ ts:now, data:signal };
    try { await supabase.from('signals').insert({ symbol, direction:signal.direction, confidence:signal.confidence, entry:signal.entry, tp1:signal.tp1, tp2:signal.tp2, sl:signal.sl, rr:signal.rr, reasoning:signal.reasoning, market_data:d }); } catch(_){}
    if(signal.confidence>=parseInt(process.env.ALERT_MIN_CONFIDENCE||'90')&&process.env.TELEGRAM_CHAT_ID&&signal.rr&&parseFloat(signal.rr.replace('1:',''))>=1.5){
      const e=signal.direction==='LONG'?'▲':signal.direction==='SHORT'?'▼':'◆';
      const msg=`${e} ${signal.direction} — ${symbol}\n💰 Entry: $${signal.entry}\n🎯 TP1: $${signal.tp1} | TP2: $${signal.tp2}\n🛑 SL: $${signal.sl} | ${signal.rr}\n📊 ${signal.confidence}% — ${signal.action}\n💬 ${signal.reasoning}`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID,msg); } catch(_){}
    }
    res.json(signal);
  } catch(e) { console.error('Analyze error:',e.message); res.status(500).json({ error:e.message, detail:e.message.includes('api')||e.message.includes('key')?'Verifica ANTHROPIC_API_KEY en Railway Variables':'Error procesando análisis' }); }
});

app.post('/api/trades', async (req, res) => {
  try { const {data,error}=await supabase.from('trades').insert(req.body); if(error) throw error; res.json({success:true,data}); } catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/trades', async (req, res) => {
  try { const {data,error}=await supabase.from('trades').select('*').order('created_at',{ascending:false}).limit(50); if(error) throw error; res.json(data); } catch(e){ res.status(500).json({error:e.message}); }
});

let alertCache = {};
const signalHistory = {};

function confirmSignal(symbol, direction, probability) {
  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  const now = Date.now();
  const minConf = parseInt(process.env.ALERT_MIN_CONFIDENCE || '90');
  // No acumular señales por debajo del umbral mínimo
  if (probability < minConf) return { confirmed: false, count: 0 };
  const history = signalHistory[symbol];
  history.push({ direction, probability, timestamp: now });
  signalHistory[symbol] = history.filter(s => now - s.timestamp < 45 * 60 * 1000).slice(-3);
  const recent = signalHistory[symbol];
  const sameDirection = recent.filter(s => s.direction === direction && now - s.timestamp < 30 * 60 * 1000);
  if (sameDirection.length < 2) { return { confirmed: false, count: sameDirection.length }; }
  if (probability >= 92 && sameDirection.length >= 1) { return { confirmed: true, count: sameDirection.length, avgProbability: probability }; }
  const avgProb = Math.round(sameDirection.reduce((s,r) => s + r.probability, 0) / sameDirection.length);
  return { confirmed: true, count: sameDirection.length, avgProbability: avgProb };
}

function clearSignalHistory(symbol) { signalHistory[symbol] = []; }

const analysisInProgress = {};
async function runAutoAnalysis(symbol = 'BTCUSDT', force = false) {
  // Evitar análisis simultáneos del mismo símbolo
  if (analysisInProgress[symbol] && !force) { console.log(`⏭ Análisis ${symbol} ya en curso — omitiendo`); return; }
  analysisInProgress[symbol] = true;
  try {
    // Delay pequeño para evitar saturar Binance API
    await new Promise(r => setTimeout(r, 1000));
    const price_temp_res = await axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`);
    const price_temp = parseFloat(price_temp_res.data.lastPrice);
    // Grupo 1: datos base
    const [oiRes,funding,k15m,k1h] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=60`),
    ]);
    await new Promise(r => setTimeout(r, 500));
    // Grupo 2: datos secundarios
    const [k4h,k1d,obRes,oi15mHist,oi1hHist,oi4hHist] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=20`),
      fetchOIHistory(symbol,'15m',10), fetchOIHistory(symbol,'1h',10), fetchOIHistory(symbol,'4h',10),
    ]);
    const ticker = price_temp_res;
    const [liqData, deepOB, whaleData] = await Promise.all([fetchBestLiqData(symbol, price_temp), fetchDeepOrderBook(symbol), detectWhales(symbol, price_temp)]);
    const price = parseFloat(ticker.data.lastPrice);
    const fundingRate = parseFloat(funding.data.lastFundingRate);
    if (!k15m.data || !Array.isArray(k15m.data) || k15m.data.length < 20) return;
    const closes15m = k15m.data.map(k => parseFloat(k[4]));
    const cvd15m = calcCVD(k15m.data);
    const vrvp = calcVRVP(k15m.data);
    const ob = analyzeOB(obRes.data.bids, obRes.data.asks);
    const oiTrend15m = calcOITrend(oi15mHist);
    const oiTrend1h  = calcOITrend(oi1hHist);
    const oiTrend4h  = calcOITrend(oi4hHist);
    const bias15m = calcBias(k15m.data, oi15mHist, fundingRate);
    const bias1h  = calcBias(k1h.data?.length >= 20 ? k1h.data : k15m.data, oi1hHist, fundingRate);
    const bias4h  = calcBias(k4h.data?.length >= 20 ? k4h.data : k15m.data, oi4hHist, fundingRate);
    const bias1d  = calcBias(k1d.data?.length >= 20 ? k1d.data : k15m.data, null, fundingRate);
    const fib15m = calcFibonacci(k15m.data, price);
    const divergences = detectDivergences(k15m.data, ob, price, fundingRate, bias4h, bias1d, oiTrend15m, fib15m);
    const combinedSignal = calcCombinedSignal(divergences, bias4h, bias1d, whaleData, deepOB, fib15m, bias1h);
    const minConfidence = parseInt(process.env.ALERT_MIN_CONFIDENCE || '90');
    const minDivergences = parseInt(process.env.ALERT_MIN_DIVERGENCES || '2');
    if (combinedSignal.direction === 'ESPERAR') { clearSignalHistory(symbol); return; }
    if (combinedSignal.probability < minConfidence) return;
    if (divergences.length < minDivergences) return;

    // ✅ Filtro de mayoría clara — no llamar a Claude si señales están divididas
    // Requiere que la dirección dominante tenga al menos 1.5x más señales que la opuesta
    // force=true (botón campana manual) salta este filtro
    const shortDivs = divergences.filter(d => d.direction === 'SHORT').length;
    const longDivs  = divergences.filter(d => d.direction === 'LONG').length;
    const hasClearMajority = combinedSignal.direction === 'SHORT'
      ? (shortDivs >= 2 && shortDivs > longDivs * 1.5)
      : (longDivs  >= 2 && longDivs  > shortDivs * 1.5);
    if (!hasClearMajority && !force) {
      console.log(`⏭ Auto-análisis omitido — señales divididas: ${shortDivs}S vs ${longDivs}L para ${symbol}`);
      clearSignalHistory(symbol);
      return;
    }
    if (!hasClearMajority && force) {
      console.log(`⚡ Análisis forzado (campana) — señales divididas: ${shortDivs}S vs ${longDivs}L para ${symbol}`);
    }
    const confirmation = confirmSignal(symbol, combinedSignal.direction, combinedSignal.probability);
    if (!confirmation.confirmed) return;
    const cacheKey = `${symbol}_${combinedSignal.direction}_${Math.floor(price / 100)}`;
    const now = Date.now();
    if (alertCache[cacheKey] && now - alertCache[cacheKey] < 45 * 60 * 1000 && !force) return; // 45 min cooldown (forzado lo salta)
    alertCache[cacheKey] = now;
    const marketData = { price, change24h: parseFloat(ticker.data.priceChangePercent), fundingRate, openInterest: parseFloat(oiRes.data.openInterest), rsi15m: calcRSI(closes15m), cvd15m, vrvp, volDeltaPct: 0, orderBook: ob, liqMagnets: calcLiqMagnets(price).slice(0,5), divergences: divergences.slice(0,4), combinedSignal, bias: { tf15m: bias15m, tf1h: bias1h, tf4h: bias4h, tf1d: bias1d } };
    // Solo pasar divergencias ≥90% al prompt — evitar confusión con señales débiles
    const strongDivs = divergences.filter(d => d.probability >= 90);
    const divSummary = strongDivs.slice(0,4).map(d => `${d.name}: ${d.direction} ${d.probability}% — ${d.description}`).join('\n');
    const b = marketData.bias;
    const prompt = `Eres un trader experto en futuros perpetuos. Analiza y da señal precisa.
MERCADO: ${symbol} — $${price}
RSI 15m: ${marketData.rsi15m} | CVD: ${cvd15m.trend} ${cvd15m.cvdPct}%
OI: ${marketData.openInterest?.toFixed(0)} | Funding: ${(fundingRate*100).toFixed(4)}%
VRVP: POC=$${vrvp.poc} VAH=$${vrvp.vah} VAL=$${vrvp.val}
SESGO: 15m=${b.tf15m?.bias}(${b.tf15m?.score}) 1H=${b.tf1h?.bias}(${b.tf1h?.score}) 4H=${b.tf4h?.bias}(${b.tf4h?.score}) 1D=${b.tf1d?.bias}(${b.tf1d?.score})
DIVERGENCIAS (${divergences.length}):
${divSummary}
SEÑAL: ${combinedSignal.direction} ${combinedSignal.probability}% — ${combinedSignal.action}
REGLAS: RSI>72 no long; RSI<28 no short.
R:R OBLIGATORIO: usa los imanes de liquidación del mapa como TP objetivo. Para SHORT: TP1 = primera zona de liquidación ABAJO del precio (Stop longs). Para LONG: TP1 = primera zona de liquidación ARRIBA (Stop shorts). SL en zona de resistencia/soporte real. TP1 debe ser mínimo 1.5x la distancia del SL. Si no hay zona de liquidación accesible con R:R ≥1:1.5, da direction=ESPERAR.
Responde SOLO JSON sin markdown:
{"direction":"LONG|SHORT|ESPERAR","confidence":0-100,"entry":precio,"tp1":precio,"tp2":precio,"sl":precio,"rr":"1:X","reasoning":"2-3 oraciones en español","warning":"riesgo o vacío","action":"ENTRAR|ESPERAR|NO ENTRAR"}`;
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: prompt }] });
    const text = response.content[0].text;
    const signal = JSON.parse(text.replace(/```json|```/g, '').trim());
    const _rrReward = signal.direction === 'SHORT' ? (signal.entry - signal.tp1) : (signal.tp1 - signal.entry);
    const _rrRisk   = signal.direction === 'SHORT' ? (signal.sl - signal.entry) : (signal.entry - signal.sl);
    const _rrVal    = (_rrRisk > 0) ? (_rrReward / _rrRisk) : 0;
    signal.rr = `1:${_rrVal.toFixed(1)}`;
    if (signal.confidence < minConfidence) return;
    // ✅ Filtro R:R — no mandar alerta si R:R < 1.5
    if (_rrVal < 1.5 && signal.direction !== 'ESPERAR') {
      console.log(`⚠️ Alerta descartada — R:R ${_rrVal.toFixed(2)} < 1.5 para ${symbol}`);
      return;
    }
    if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) return;
    const dir = signal.direction;
    const emoji = dir === 'LONG' ? '🟢' : dir === 'SHORT' ? '🔴' : '🟡';
    const fibNote = fib15m?.nearestRetrace?.dist < 0.8 ? `\n⬟ Fib ${fib15m.nearestRetrace.label} — ${fib15m.retImpact.description}` : '';
    const whaleNote = whaleData?.whaleCount >= 3 ? `\n🐋 Ballenas: ${whaleData.dominance} (${whaleData.whaleCount} trades)` : '';
    const wsM = getWsMetrics(symbol);
    const wsNote2 = wsM?.anomaly && Date.now() - wsM.anomaly.time < 5*60*1000 ? `\n⚡ WS: ${wsM.anomaly.reason}` : '';
    const msg = `${emoji} *${dir}* — ${symbol}\n━━━━━━━━━━━━━━\n💰 Entry: *$${signal.entry?.toLocaleString()}*\n🎯 TP1: $${signal.tp1?.toLocaleString()} | TP2: $${signal.tp2?.toLocaleString()}\n🛑 SL: $${signal.sl?.toLocaleString()} | ${signal.rr}\n━━━━━━━━━━━━━━\n📊 Confianza: *${signal.confidence}%* — ${signal.action}\n📈 ${combinedSignal.shortCount}S · ${combinedSignal.longCount}L activas\n💬 ${signal.reasoning}${signal.warning ? '\n⚠️ ' + signal.warning : ''}${fibNote}${whaleNote}${wsNote2}\n━━━━━━━━━━━━━━\n🕐 ${new Date().toLocaleTimeString('es-PE')}`;
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    console.log(`✅ Alerta enviada: ${dir} ${symbol} ${signal.confidence}%`);
    try { await supabase.from('signals').insert({ symbol, direction: signal.direction, confidence: signal.confidence, entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2, sl: signal.sl, rr: signal.rr, reasoning: signal.reasoning, market_data: marketData, source: 'auto_alert' }); } catch(_) {}
    const autoPaperThreshold = parseInt(process.env.AUTO_PAPER_THRESHOLD || '93');
    const trend1d = bias1d.bias;
    const trendOk = signal.direction === 'LONG' ? (trend1d !== 'short') : signal.direction === 'SHORT' ? (trend1d !== 'long') : false;
    const canAutoTrade = signal.confidence >= autoPaperThreshold && signal.direction !== 'ESPERAR' && trendOk && divergences.length >= 2 && _rrVal >= 1.5;
    if (canAutoTrade) {
      try {
        // ✅ Si hay trade abierto en dirección CONTRARIA con señal ≥90%, cerrarlo primero
        const oppositeDir = signal.direction === 'LONG' ? 'SHORT' : 'LONG';
        const { data: oppTrades } = await supabase.from('paper_trades')
          .select('*').eq('symbol', symbol).eq('status', 'open').eq('direction', oppositeDir);
        if (oppTrades?.length) {
          for (const oppTrade of oppTrades) {
            const currentPrice = wsState[symbol]?.lastPrice || signal.entry;
            const entry = parseFloat(oppTrade.entry);
            const priceDiff = oppTrade.direction === 'LONG' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
            const _lev2 = parseFloat(oppTrade.leverage || 10);
            const pnl_usd = parseFloat((parseFloat(oppTrade.size_usd) * priceDiff * _lev2).toFixed(2));
            const pnl_pct = parseFloat((priceDiff * _lev2 * 100).toFixed(2));
            await supabase.from('paper_trades').update({
              status: pnl_usd >= 0 ? 'won' : 'lost',
              close_price: currentPrice, close_reason: 'signal_reversal',
              pnl_usd, pnl_pct, closed_at: new Date().toISOString()
            }).eq('id', oppTrade.id);
            console.log(`🔄 Reversión de señal: cerrado ${oppTrade.direction} ${symbol} @ $${currentPrice} — nueva señal ${signal.direction} ${signal.confidence}%`);
            if (process.env.TELEGRAM_CHAT_ID) {
              const msg = `🔄 *Reversión de señal*\n${oppTrade.direction} ${symbol} cerrado\nEntry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentPrice).toLocaleString()}\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\nRazón: Nueva señal ${signal.direction} ${signal.confidence}%`;
              try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
            }
          }
        }
        const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
        if (!existing || existing.length === 0) {
          const mlSnapshot = { confidence: signal.confidence, direction: signal.direction, trend_aligned: trendOk, trend_1d: trend1d, rsi_15m: marketData.rsi15m, cvd_pct: cvd15m.cvdPct, cvd_trend: cvd15m.trend, funding_rate: fundingRate, oi_trend_15m: oiTrend15m.trend, oi_delta_15m: oiTrend15m.deltaPct, bias_15m: bias15m.bias, bias_15m_score: bias15m.score, bias_1h: bias1h.bias, bias_1h_score: bias1h.score, bias_4h: bias4h.bias, bias_4h_score: bias4h.score, bias_1d: bias1d.bias, bias_1d_score: bias1d.score, divergence_count: divergences.length, top_divergence: divergences[0]?.type, top_divergence_prob: divergences[0]?.probability, short_count: combinedSignal.shortCount, long_count: combinedSignal.longCount, fib_level: fib15m?.nearestRetrace?.label, fib_dist: fib15m?.nearestRetrace?.dist, fib_signal: fib15m?.retImpact?.signal, fib_bonus: fib15m?.retImpact?.bonus, whale_count: whaleData?.whaleCount, whale_bias: whaleData?.whaleBias, whale_dominance: whaleData?.dominance, whale_ratio: whaleData?.whaleRatio, deep_imbalance: deepOB?.deepImbalance, bid_clusters: deepOB?.bidClusters?.length, ask_clusters: deepOB?.askClusters?.length, price_vs_poc: ((marketData.price - vrvp.poc) / vrvp.poc * 100).toFixed(3), price: marketData.price, timestamp: new Date().toISOString() };
          await supabase.from('paper_trades').insert({ symbol, direction: signal.direction, entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2, sl: signal.sl, rr: signal.rr, confidence: signal.confidence, size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'), leverage: parseInt(process.env.PAPER_LEVERAGE || '10'), divergences: divergences.slice(0,5), fibonacci: fib15m, source: 'auto', status: 'open', opened_at: new Date().toISOString(), market_data: mlSnapshot }).select().single();
          console.log(`🤖 Auto paper trade: ${signal.direction} ${symbol} @ $${signal.entry}`);
          if (process.env.TELEGRAM_CHAT_ID) {
            const tradeEmoji = signal.direction === 'LONG' ? '▲' : '▼';
            const autoMsg = `🤖 *Auto Paper Trade abierto*\n${tradeEmoji} ${signal.direction} ${symbol}\n💰 Entry: $${signal.entry?.toLocaleString()}\n🎯 TP: $${signal.tp1?.toLocaleString()} | 🛑 SL: $${signal.sl?.toLocaleString()}\n📊 ${signal.confidence}% confianza\n📐 ${signal.rr} R:R`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, autoMsg, { parse_mode: 'Markdown' }); } catch(_) {}
          }
        }
      } catch(paperErr) { console.error('Auto paper trade error:', paperErr.message); }
    }
  } catch(e) {
    console.error(`❌ Auto-analysis error ${symbol}:`, e.message, e.response?.status || '');
    if (e.response?.status === 429) {
      console.log(`⏳ Rate limit 429 — esperando 30s antes de próximo análisis`);
      await new Promise(r => setTimeout(r, 30000));
    }
  }
  finally { analysisInProgress[symbol] = false; }
}

function startAlertJob() {
  if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) {
    console.log('⚠️ Alertas Telegram desactivadas');
    setInterval(monitorPaperTrades, 2 * 60 * 1000); // cada 2 min — más rápido para scalping
    setTimeout(monitorPaperTrades, 15000);
    return;
  }
  const intervalMin = parseInt(process.env.ALERT_INTERVAL_MIN || '15');
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  console.log(`✅ Alertas activas — cada ${intervalMin} min para: ${symbols.join(', ')}`);
  setInterval(monitorPaperTrades, 2 * 60 * 1000); // cada 2 min — más rápido para scalping
  setTimeout(monitorPaperTrades, 15000);
  setInterval(async () => { for (const symbol of symbols) { await runAutoAnalysis(symbol.trim()); await new Promise(r => setTimeout(r, 8000)); } }, intervalMin * 60 * 1000);
  setTimeout(async () => { for (const symbol of symbols) { await runAutoAnalysis(symbol.trim()); await new Promise(r => setTimeout(r, 8000)); } }, 15000);
  // Iniciar WebSockets para detección en tiempo real
  const wsSymbols = (process.env.WS_SYMBOLS || process.env.ALERT_SYMBOLS || 'BTCUSDT,ETHUSDT').split(',');
  wsSymbols.forEach(sym => { setTimeout(() => connectWebSocket(sym.trim()), 2000); });
  console.log(`🔌 WebSocket iniciando para: ${wsSymbols.join(', ')}`);
  // Actualizar volumen promedio cada 5 minutos
  setInterval(async () => {
    for (const sym of wsSymbols) {
      try {
        const k1m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${sym.trim()}&interval=1m&limit=10`);
        const vols = k1m.data.map(k => {
          const p = parseFloat(k[4]);
          const v = parseFloat(k[5]);
          return p * v;
        });
        if (wsState[sym.trim()]) wsState[sym.trim()].avgVolume1m = vols.reduce((a,b)=>a+b,0)/vols.length;
      } catch(_) {}
    }
  }, 5 * 60 * 1000);
}

app.get('/api/prices', async (req, res) => {
  try {
    const [btc, eth, sol, xau] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=BTCUSDT`),
      axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=ETHUSDT`),
      axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=SOLUSDT`),
      axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=XAUUSDT`).catch(() => ({ data: { price: '0' } })),
    ]);
    res.json({ BTCUSDT: parseFloat(btc.data.price), ETHUSDT: parseFloat(eth.data.price), SOLUSDT: parseFloat(sol.data.price), XAUUSDT: parseFloat(xau.data.price) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alert/trigger', async (req, res) => {
  const symbol = req.body.symbol || 'BTCUSDT';
  const force = req.body.force === true; // true = saltar filtros de mayoría y cooldown
  await runAutoAnalysis(symbol, force);
  res.json({ ok: true, message: `Análisis disparado para ${symbol}${force?' (forzado)':''}` });
});

app.get('/api/alert/status', (req, res) => {
  res.json({ active: !!(process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN), intervalMin: parseInt(process.env.ALERT_INTERVAL_MIN || '15'), symbols: (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(','), minConfidence: parseInt(process.env.ALERT_MIN_CONFIDENCE || '90') });
});

// ─── PAPER TRADING ───────────────────────────────────────────────
app.post('/api/paper/open', async (req, res) => {
  try {
    const { symbol, direction, entry, tp1, tp2, sl, rr, confidence, size_usd, leverage, divergences, fibonacci, source } = req.body;
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
    if (existing && existing.length > 0) return res.status(400).json({ error: `Ya hay un trade abierto para ${symbol}. Ciérralo antes de abrir otro.` });
    const { data, error } = await supabase.from('paper_trades').insert({ symbol, direction, entry, tp1, tp2, sl, rr, confidence, size_usd: size_usd || 1000, leverage: leverage || 10, divergences, fibonacci, source: source || 'manual', status: 'open', opened_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    res.json({ ok: true, trade: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/close/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { close_price, close_reason } = req.body;
    const { data: trade, error: fetchErr } = await supabase.from('paper_trades').select('*').eq('id', id).single();
    if (fetchErr) throw fetchErr;
    const entry = parseFloat(trade.entry);
    const closeP = parseFloat(close_price);
    const size = parseFloat(trade.size_usd);
    const priceDiff = trade.direction === 'LONG' ? (closeP - entry) / entry : (entry - closeP) / entry;
    const _lev3 = parseFloat(trade.leverage || 10);
    const pnl_usd = parseFloat((size * priceDiff * _lev3).toFixed(2));
    const pnl_pct = parseFloat((priceDiff * _lev3 * 100).toFixed(2));
    const finalStatus = close_reason === 'tp1' || close_reason === 'tp2' ? 'won'
      : close_reason === 'sl' ? 'lost'
      : close_reason === 'manual' ? 'cancelled'
      : 'closed';
    const { data, error } = await supabase.from('paper_trades').update({ status: finalStatus, close_price: closeP, close_reason, pnl_usd: finalStatus === 'cancelled' ? 0 : pnl_usd, pnl_pct: finalStatus === 'cancelled' ? 0 : pnl_pct, closed_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, trade: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/open', async (req, res) => {
  try { const { data, error } = await supabase.from('paper_trades').select('*').eq('status', 'open').order('created_at', { ascending: false }); if (error) throw error; res.json(data); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/stats', async (req, res) => {
  try {
    const { data, error } = await supabase.from('paper_trades').select('*').in('status', ['won', 'lost']).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    const total = data.length;
    const won = data.filter(t => t.status === 'won').length;
    const lost = data.filter(t => t.status === 'lost').length;
    const winRate = total > 0 ? ((won / total) * 100).toFixed(1) : 0;
    const totalPnl = data.reduce((s, t) => s + (parseFloat(t.pnl_usd) || 0), 0);
    const avgWin = won > 0 ? data.filter(t=>t.status==='won').reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0) / won : 0;
    const avgLoss = lost > 0 ? Math.abs(data.filter(t=>t.status==='lost').reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0) / lost) : 0;
    const profitFactor = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '∞';
    let peak = 0, maxDD = 0, cumPnl = 0;
    data.slice().reverse().forEach(t => { cumPnl += parseFloat(t.pnl_usd) || 0; if (cumPnl > peak) peak = cumPnl; const dd = peak - cumPnl; if (dd > maxDD) maxDD = dd; });
    res.json({ total, won, lost, winRate: parseFloat(winRate), totalPnl: parseFloat(totalPnl.toFixed(2)), avgWin: parseFloat(avgWin.toFixed(2)), avgLoss: parseFloat(avgLoss.toFixed(2)), profitFactor, maxDrawdown: parseFloat(maxDD.toFixed(2)), recentTrades: data.slice(0, 20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function monitorPaperTrades() {
  try {
    const { data: openTrades } = await supabase.from('paper_trades').select('*').eq('status', 'open');
    if (!openTrades?.length) return;
    for (const trade of openTrades) {
      try {
        const priceRes = await axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=${trade.symbol}`);
        const currentPrice = parseFloat(priceRes.data.price);
        const entryPrice = parseFloat(trade.entry);
        if (Math.abs(currentPrice - entryPrice) / entryPrice * 100 > 50) continue;
        const tp1 = parseFloat(trade.tp1), tp2 = parseFloat(trade.tp2) || tp1;
        let sl = parseFloat(trade.sl);

        // ── TRAILING STOP ────────────────────────────────────────
        const isLong = trade.direction === 'LONG';
        const priceDiffPct = isLong
          ? (currentPrice - entryPrice) / entryPrice * 100
          : (entryPrice - currentPrice) / entryPrice * 100;
        const slDistance = Math.abs(entryPrice - sl);
        let newSl = sl;

        if (priceDiffPct >= 1.5) {
          // Ganando +1.5% → SL sigue al precio con distancia 0.5x SL original
          const trailDistance = slDistance * 0.5;
          newSl = isLong
            ? Math.max(sl, currentPrice - trailDistance)
            : Math.min(sl, currentPrice + trailDistance);
        } else if (priceDiffPct >= 1.0) {
          // Ganando +1% → SL al 50% del recorrido
          newSl = isLong
            ? Math.max(sl, entryPrice + (currentPrice - entryPrice) * 0.5)
            : Math.min(sl, entryPrice - (entryPrice - currentPrice) * 0.5);
        } else if (priceDiffPct >= 0.5) {
          // Ganando +0.5% → SL al breakeven (entry)
          newSl = isLong
            ? Math.max(sl, entryPrice)
            : Math.min(sl, entryPrice);
        }

        // Si el SL mejoró, actualizar en Supabase
        if ((isLong && newSl > sl) || (!isLong && newSl < sl)) {
          const newSlRounded = parseFloat(newSl.toFixed(1));
          await supabase.from('paper_trades').update({ sl: newSlRounded }).eq('id', trade.id);
          sl = newSlRounded;
          console.log(`📈 Trailing stop: ${trade.direction} ${trade.symbol} SL ${parseFloat(trade.sl).toFixed(0)} → ${newSlRounded.toFixed(0)} (precio: ${currentPrice.toFixed(0)}, +${priceDiffPct.toFixed(2)}%)`);
        }

        // ── TP DINÁMICO — mover TP hacia siguiente zona de liquidación ──
        // Solo cuando el precio avanza +1% — nunca acercar el TP
        if (priceDiffPct >= 1.0) {
          try {
            const liqRes = await fetchForceOrders(trade.symbol);
            const currentTp1 = parseFloat(trade.tp1);
            if (liqRes?.zones?.length) {
              // Buscar zona de liquidación más cercana en dirección del trade
              const relevantZones = liqRes.zones
                .filter(z => isLong ? z.price > currentPrice : z.price < currentPrice)
                .filter(z => isLong ? z.price > currentTp1 : z.price < currentTp1) // más lejos que TP actual
                .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);
              if (relevantZones.length) {
                const nextZone = relevantZones[0];
                const newTp1 = parseFloat(nextZone.price.toFixed(1));
                await supabase.from('paper_trades').update({ tp1: newTp1 }).eq('id', trade.id);
                console.log(`🎯 TP dinámico: ${trade.direction} ${trade.symbol} TP ${currentTp1.toFixed(0)} → ${newTp1.toFixed(0)} (zona liq $${nextZone.total}K)`);
              }
            }
          } catch(_) {} // silencioso — no interrumpir el monitor si falla
        }
        // ────────────────────────────────────────────────────────

        let closeReason = null;
        if (trade.direction === 'LONG') {
          if (currentPrice >= tp2 && tp2 > tp1) closeReason = 'tp2';
          else if (currentPrice >= tp1) closeReason = 'tp1';
          else if (currentPrice <= sl) closeReason = 'sl';
        } else {
          if (currentPrice <= tp2 && tp2 < tp1) closeReason = 'tp2';
          else if (currentPrice <= tp1) closeReason = 'tp1';
          else if (currentPrice >= sl) closeReason = 'sl';
        }
        if (closeReason) {
          const entry = parseFloat(trade.entry);
          const priceDiff = trade.direction === 'LONG' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
          const _lev4 = parseFloat(trade.leverage || 10);
          const pnl_usd = parseFloat((trade.size_usd * priceDiff * _lev4).toFixed(2));
          const pnl_pct = parseFloat((priceDiff * _lev4 * 100).toFixed(2));
          if (Math.abs(pnl_usd) > parseFloat(trade.size_usd) * _lev4 * 1.1) { // max = capital * leverage * 110%
            await supabase.from('paper_trades').update({ status: 'closed', close_price: currentPrice, close_reason: 'invalid_pnl', pnl_usd: 0, pnl_pct: 0, closed_at: new Date().toISOString() }).eq('id', trade.id);
            continue;
          }
          await supabase.from('paper_trades').update({ status: closeReason === 'tp1' || closeReason === 'tp2' ? 'won' : 'lost', close_price: currentPrice, close_reason: closeReason, pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', trade.id);
          console.log(`📊 Paper trade cerrado: ${trade.direction} ${trade.symbol} → ${closeReason} PnL: $${pnl_usd}`);
          if (process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN) {
            const emoji = closeReason === 'tp2' ? '🎯' : closeReason === 'tp1' ? '✅' : '❌';
            const msg = `${emoji} Paper Trade Cerrado\n${trade.direction} ${trade.symbol}\nEntry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentPrice).toLocaleString()}\nRazón: ${closeReason.toUpperCase()}\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg); } catch(_){}
          }
        }
      } catch(_) {}
    }
  } catch(e) { console.error('Monitor paper trades error:', e.message); }
}

// ─── NOTICIAS ────────────────────────────────────────────────────
app.get('/api/news/latest', async (req, res) => {
  const sources = [
    async () => { const r = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=12', { timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.data?.Data?.length) throw new Error('empty'); return r.data.Data.map(n => ({ title: n.title, source: n.source_info?.name || n.source || 'CryptoCompare', published_on: n.published_on, url: n.url })); },
    async () => { const r = await axios.get('https://cointelegraph.com/rss', { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }); const items = []; const rx = /<item>([\s\S]*?)<\/item>/g; let m; while ((m = rx.exec(r.data)) !== null && items.length < 8) { const it = m[1]; const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || it.match(/<title>([^<]+)<\/title>/))?.[1]?.trim() || ''; const url = it.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() || ''; const pub = it.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]?.trim() || ''; if (title) items.push({ title, source: 'CoinTelegraph', published_on: pub ? Math.floor(new Date(pub).getTime()/1000) : Math.floor(Date.now()/1000), url }); } if (!items.length) throw new Error('empty'); return items; },
    async () => { const r = await axios.get('https://decrypt.co/feed', { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }); const items = []; const rx = /<item>([\s\S]*?)<\/item>/g; let m; while ((m = rx.exec(r.data)) !== null && items.length < 8) { const it = m[1]; const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || it.match(/<title>([^<]+)<\/title>/))?.[1]?.trim() || ''; const url = it.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() || ''; const pub = it.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]?.trim() || ''; if (title) items.push({ title, source: 'Decrypt', published_on: pub ? Math.floor(new Date(pub).getTime()/1000) : Math.floor(Date.now()/1000), url }); } if (!items.length) throw new Error('empty'); return items; }
  ];
  for (const source of sources) {
    try { const items = await source(); if (items?.length) { console.log(`✅ Noticias: ${items.length} items`); return res.json(items); } } catch(e) { console.log(`⚠️ Fuente noticias falló: ${e.message}`); }
  }
  res.json([]);
});

// ─── ML INSIGHTS ────────────────────────────────────────────────
app.get('/api/ml/insights', async (req, res) => {
  try {
    const { data: trades, error } = await supabase.from('paper_trades').select('id,symbol,direction,status,pnl_usd,pnl_pct,confidence,market_data,created_at,closed_at,divergences,fibonacci').in('status', ['won','lost']).order('created_at', { ascending: false }).limit(2000);
    if (error) throw error;
    if (!trades || trades.length < 10) return res.json({ message: 'Necesitas al menos 10 trades cerrados para análisis ML', trades: trades?.length || 0 });
    const won = trades.filter(t => t.status === 'won'), lost = trades.filter(t => t.status === 'lost');
    function avg(arr, key) { const vals = arr.map(t => parseFloat(t.market_data?.[key])).filter(v => !isNaN(v)); return vals.length > 0 ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(3) : null; }
    const totalPnl = trades.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0);
    const avgWin = won.length > 0 ? won.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0)/won.length : 0;
    const avgLoss = lost.length > 0 ? Math.abs(lost.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0)/lost.length) : 0;
    let peak=0,maxDD=0,cumPnl=0; [...trades].reverse().forEach(t=>{cumPnl+=parseFloat(t.pnl_usd)||0;if(cumPnl>peak)peak=cumPnl;const dd=peak-cumPnl;if(dd>maxDD)maxDD=dd;});
    const wr = (won.length/trades.length)*100;
    const withFib = trades.filter(t=>t.market_data?.fib_bonus>0), withWhales = trades.filter(t=>t.market_data?.whale_count>=3);
    const aligned4h = trades.filter(t=>(t.direction==='LONG'&&t.market_data?.bias_4h==='long')||(t.direction==='SHORT'&&t.market_data?.bias_4h==='short'));
    const { data: allTrades } = await supabase.from('paper_trades').select('source,status,pnl_usd').in('status',['won','lost']);
    const bySource = {};
    for (const src of ['scalping','auto','manual','sweep','backtest']) {
      const st = (allTrades||[]).filter(t=>t.source===src), sw = st.filter(t=>t.status==='won'), sp = st.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0);
      if (!st.length) continue;
      bySource[src] = { total:st.length, won:sw.length, lost:st.length-sw.length, winRate:parseFloat(((sw.length/Math.max(st.length,1))*100).toFixed(1)), totalPnl:parseFloat(sp.toFixed(2)), avgPnl:parseFloat((sp/Math.max(st.length,1)).toFixed(2)) };
    }
    const topDivs = won.reduce((acc,t)=>{const d=t.market_data?.top_divergence;if(d)acc[d]=(acc[d]||0)+1;return acc;},{});
    const recs = [];
    const avgConfW = parseFloat(avg(won,'confidence')), avgConfL = parseFloat(avg(lost,'confidence'));
    if (!isNaN(avgConfW) && !isNaN(avgConfL) && avgConfW > avgConfL+5) recs.push(`Subir umbral a ${Math.round(avgConfW-2)}% (ganadores: ${avgConfW.toFixed(0)}% vs perdedores: ${avgConfL.toFixed(0)}%)`);
    const wrFib = withFib.length > 0 ? (withFib.filter(t=>t.status==='won').length/withFib.length*100) : 0;
    if (wrFib > wr+10) recs.push(`Fibonacci mejora WR en ${(wrFib-wr).toFixed(1)}% — priorizar señales con Fib`);
    res.json({ total:trades.length, won:won.length, lost:lost.length, winRate: wr.toFixed(1), totalPnl: totalPnl.toFixed(2), avgWin: avgWin.toFixed(2), avgLoss: avgLoss.toFixed(2), profitFactor: avgLoss>0?(avgWin/avgLoss).toFixed(2):'∞', maxDrawdown: maxDD.toFixed(2), avgConfidenceWon: avg(won,'confidence'), avgConfidenceLost: avg(lost,'confidence'), avgRsiWon: avg(won,'rsi_15m'), avgRsiLost: avg(lost,'rsi_15m'), winRateWithFib: wrFib.toFixed(1), winRateWithWhales: withWhales.length>0?(withWhales.filter(t=>t.status==='won').length/withWhales.length*100).toFixed(1):'0', winRateAligned4h: aligned4h.length>0?(aligned4h.filter(t=>t.status==='won').length/aligned4h.length*100).toFixed(1):'n/a', topDivergencesWon: topDivs, bySource, recommendations: recs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ml/optimize', async (req, res) => {
  try {
    const { data: trades } = await supabase.from('paper_trades').select('*').in('status',['won','lost']).not('market_data','is',null).limit(1000);
    if (!trades || trades.length < 50) return res.json({ optimized:false, reason:'insufficient_data', trades:trades?.length||0 });
    const won = trades.filter(t=>t.status==='won'), winRate = won.length/trades.length;
    const adjustments = {}, recommendations = [];
    const highConf = trades.filter(t=>(t.market_data?.confidence||0)>=90), lowConf = trades.filter(t=>(t.market_data?.confidence||0)<90);
    if (highConf.length>=10&&lowConf.length>=10) { const wrH=highConf.filter(t=>t.status==='won').length/highConf.length, wrL=lowConf.filter(t=>t.status==='won').length/lowConf.length; if(wrH>wrL+0.1){adjustments.min_confidence={from:85,to:88};recommendations.push(`Alta confianza WR: ${(wrH*100).toFixed(1)}% vs baja: ${(wrL*100).toFixed(1)}%`);} }
    res.json({ optimized:true, trades:trades.length, winRate:(winRate*100).toFixed(1), adjustments_count:Object.keys(adjustments).length, adjustments, recommendations });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── SCALPING ────────────────────────────────────────────────────
let scalpingActive = false, scalpingInterval = null;

app.post('/api/scalping/start', (req, res) => {
  if (scalpingActive) return res.json({ ok: false, message: 'Scalping ya activo' });
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  const intervalMin = parseFloat(process.env.SCALP_INTERVAL_MIN || '3');
  scalpingActive = true;
  scalpingInterval = setInterval(async () => { for (const sym of symbols) { try { await runScalpingAnalysis(sym.trim()); } catch(_) {} await new Promise(r => setTimeout(r, 2000)); } }, intervalMin * 60 * 1000);
  setTimeout(async () => { for (const sym of symbols) { try { await runScalpingAnalysis(sym.trim()); } catch(_) {} } }, 5000);
  res.json({ ok: true, message: `Scalping activado cada ${intervalMin} min` });
});

app.post('/api/scalping/stop', (req, res) => {
  if (!scalpingActive) return res.json({ ok: false, message: 'Scalping no estaba activo' });
  clearInterval(scalpingInterval); scalpingActive = false; scalpingInterval = null;
  res.json({ ok: true, message: 'Scalping desactivado' });
});

app.get('/api/scalping/status', (req, res) => {
  res.json({ active: scalpingActive, intervalMin: parseFloat(process.env.SCALP_INTERVAL_MIN || '3'), threshold: parseInt(process.env.SCALP_THRESHOLD || '88'), symbols: (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',') });
});

function detectDoublePatterns(klines15m, price) {
  try {
    if (!klines15m || klines15m.length < 30) return [];
    const patterns = [], highs = klines15m.map(k => parseFloat(k[2])), lows = klines15m.map(k => parseFloat(k[3])), closes = klines15m.map(k => parseFloat(k[4])), volumes = klines15m.map(k => parseFloat(k[5])), n = closes.length, lookback = 20;
    let peaks = [];
    for (let i = n - lookback; i < n - 1; i++) { if (highs[i] > highs[i-1] && highs[i] > highs[i+1]) peaks.push({ idx: i, price: highs[i], vol: volumes[i] }); }
    if (peaks.length >= 2) {
      const p1 = peaks[peaks.length-2], p2 = peaks[peaks.length-1];
      const priceDiff = Math.abs(p1.price - p2.price) / p1.price * 100;
      const volDivergence = p2.vol < p1.vol * 0.85;
      const rsi1 = calcRSI(closes.slice(0, p1.idx+1)), rsi2 = calcRSI(closes.slice(0, p2.idx+1));
      const rsiDivergence = rsi2 < rsi1 - 3;
      const neckline = Math.min(...lows.slice(p1.idx, p2.idx+1));
      // Invalidar si precio ya superó el techo >1.5% (patrón obsoleto)
      const priceBelowPattern = price < p2.price * 0.985;
      if (priceDiff < 0.4 && (volDivergence || rsiDivergence) && !priceBelowPattern) {
        let prob = 74; if(volDivergence) prob+=10; if(rsiDivergence) prob+=8; if(price < p2.price*0.999) prob+=7;
        patterns.push({ type:'double_top', name:'┳ Double Top — Scalping Bajista', direction:'SHORT', probability:Math.min(92,prob), entry:price, tp:neckline-(p2.price-neckline)*0.8, sl:p2.price*1.002, description:`Double Top en $${parseInt(p2.price).toLocaleString()} con ${rsiDivergence?'RSI divergente':'volumen decreciente'} — señal bajista.`, action:prob>=80?'ENTRAR':'ESPERAR', scalpMode:true });
      }
    }
    if (troughs.length >= 2) {
      const t1 = troughs[troughs.length-2], t2 = troughs[troughs.length-1];
      const priceDiff = Math.abs(t1.price - t2.price) / t1.price * 100;
      const volDivergence = t2.vol < t1.vol * 0.85;
      const rsi1 = calcRSI(closes.slice(0, t1.idx+1)), rsi2 = calcRSI(closes.slice(0, t2.idx+1));
      const rsiDivergence = rsi2 > rsi1 + 3;
      const neckline = Math.max(...highs.slice(t1.idx, t2.idx+1));
      // Invalidar si precio ya se alejó >1.5% del fondo O si ya cayó por debajo del neckline
      const priceAbovePattern = price > t2.price * 1.015;
      const priceBelowNeckline = price < neckline * 0.998;
      if (priceDiff < 0.4 && (volDivergence || rsiDivergence) && !priceAbovePattern && !priceBelowNeckline) {
        let prob = 74; if(volDivergence) prob+=10; if(rsiDivergence) prob+=8; if(price > t2.price*1.001) prob+=7;
        patterns.push({ type:'double_bottom', name:'▲ Double Bottom — Scalping Alcista', direction:'LONG', probability:Math.min(92,prob), entry:price, tp:neckline+(neckline-t2.price)*0.8, sl:t2.price*0.998, description:`Double Bottom en $${parseInt(t2.price).toLocaleString()} con ${rsiDivergence?'RSI divergente':'volumen decreciente'} — señal alcista.`, action:prob>=80?'ENTRAR':'ESPERAR', scalpMode:true });
      }
    }
    return patterns;
  } catch(e) { return []; }
}

function calcScalpSignal(divergences, bias15m, bias1h, bias4h) {
  try {
    if (!divergences.length) return { direction: 'ESPERAR', probability: 30, action: 'ESPERAR' };
    const longs = divergences.filter(d => d.direction === 'LONG'), shorts = divergences.filter(d => d.direction === 'SHORT');
    let longScore = longs.reduce((s,d)=>s+d.probability,0)/Math.max(longs.length,1);
    let shortScore = shorts.reduce((s,d)=>s+d.probability,0)/Math.max(shorts.length,1);
    if(bias15m?.bias==='long') longScore+=12; if(bias15m?.bias==='short') shortScore+=12;
    if(bias15m?.bias==='short') longScore-=10; if(bias15m?.bias==='long') shortScore-=10;
    if(bias1h?.bias==='long') longScore+=8; if(bias1h?.bias==='short') shortScore+=8;
    // Penalizar scalping contra tendencia 1H — evita abrir contra la corriente
    if(bias1h?.bias==='short') longScore-=15; if(bias1h?.bias==='long') shortScore-=15;
    if(bias4h?.bias==='long') longScore+=4; if(bias4h?.bias==='short') shortScore+=4;
    if(bias4h?.bias==='short') longScore-=8; if(bias4h?.bias==='long') shortScore-=8;
    if(divergences.some(d=>d.type==='double_top')) shortScore+=15;
    if(divergences.some(d=>d.type==='double_bottom')) longScore+=15;
    const direction = shortScore > longScore ? 'SHORT' : longScore > shortScore ? 'LONG' : 'ESPERAR';
    const prob = direction === 'SHORT' ? shortScore : direction === 'LONG' ? longScore : 30;
    return { direction, probability:Math.min(95,Math.round(prob)), action:prob>=78?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', mode:'scalping' };
  } catch(e) { return { direction:'ESPERAR', probability:30, action:'ESPERAR' }; }
}

const scalpingInProgress = {};
async function runScalpingAnalysis(symbol = 'BTCUSDT') {
  if (scalpingInProgress[symbol]) return;
  scalpingInProgress[symbol] = true;
  try {
    const [tickerRes, k3m, obRes, fundingRes] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=3m&limit=60`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
    ]);
    const price = parseFloat(tickerRes.data.lastPrice);
    const fundingRate = parseFloat(fundingRes.data.lastFundingRate);
    const ob = analyzeOB(obRes.data.bids, obRes.data.asks);
    const cvd3m = calcCVD(k3m.data);
    const rsi3m = calcRSI(k3m.data.map(k => parseFloat(k[4])));
    const fib3m = calcFibonacci(k3m.data, price);
    const wsM = getWsMetrics(symbol);
    let longScore = 0, shortScore = 0;
    const imb = parseFloat(ob.imbalance||0);
    if (imb > 20) longScore += 30; if (imb < -20) shortScore += 30;
    if (cvd3m.trend==='bull'&&cvd3m.cvdPct>5) longScore += 25; if (cvd3m.trend==='bear'&&cvd3m.cvdPct<-5) shortScore += 25;
    if (rsi3m < 35) longScore += 15; if (rsi3m > 65) shortScore += 15;
    if (fib3m?.retImpact?.signal==='long_bounce') longScore += 15; if (fib3m?.retImpact?.signal==='short_bounce') shortScore += 15;
    if (ob.bidWalls?.length>0) longScore += 10; if (ob.askWalls?.length>0) shortScore += 10;
    // WebSocket boost para scalping
    if (wsM?.anomaly && Date.now() - wsM.anomaly.time < 3*60*1000) {
      if (wsM.anomaly.direction === 'LONG') longScore += 20;
      if (wsM.anomaly.direction === 'SHORT') shortScore += 20;
    }

    // ── PENALIZACIONES DE BIAS — evita abrir contra tendencia ──
    // Obtener bias 1H y 4H en tiempo real
    let bias1hScalp = null, bias4hScalp2 = null;
    try {
      const [k1hSc, k4hSc, oi1hSc, oi4hSc] = await Promise.all([
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=60`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
        fetchOIHistory(symbol,'1h',5),
        fetchOIHistory(symbol,'4h',5),
      ]);
      bias1hScalp  = calcBias(k1hSc.data, oi1hSc, fundingRate);
      bias4hScalp2 = calcBias(k4hSc.data, oi4hSc, fundingRate);
    } catch(_) {}

    // bias 1H — penalización fuerte (contexto inmediato)
    if (bias1hScalp?.bias === 'short') longScore  -= 15;
    if (bias1hScalp?.bias === 'long')  shortScore -= 15;
    // bias 4H — penalización media (tendencia mayor)
    if (bias4hScalp2?.bias === 'short') longScore  -= 10;
    if (bias4hScalp2?.bias === 'long')  shortScore -= 10;
    // Bloquear si ambos 1H y 4H van en contra — señal muy débil
    if (bias1hScalp?.bias === 'short' && bias4hScalp2?.bias === 'short' && longScore > shortScore) {
      console.log(`⛔ Scalp LONG ${symbol} bloqueado — 1H y 4H bajistas`);
      return;
    }
    if (bias1hScalp?.bias === 'long' && bias4hScalp2?.bias === 'long' && shortScore > longScore) {
      console.log(`⛔ Scalp SHORT ${symbol} bloqueado — 1H y 4H alcistas`);
      return;
    }
    // Bloquear si bias score es muy débil (<20) — señal sin convicción
    if (bias1hScalp && bias1hScalp.score < 20 && bias1hScalp.score > 80) {
      // score entre 20-80 = zona muerta sin dirección clara
    }
    // Bloquear mercado lateral: bias4H neutral Y bias1H score entre 40-60
    const bias1hScore = bias1hScalp?.score || 50;
    const bias4hScore = bias4hScalp2?.score || 50;
    if (bias4hScalp2?.bias === 'neutral' && bias1hScore >= 35 && bias1hScore <= 65) {
      console.log(`⛔ Scalp ${symbol} bloqueado — mercado lateral (4H neutral, 1H score ${bias1hScore})`);
      return;
    }
    // Bloquear si bias 1H score < 20 (dirección con muy poca convicción)
    if (bias1hScalp?.bias !== 'neutral' && bias1hScore < 20) {
      console.log(`⛔ Scalp ${symbol} bloqueado — bias 1H score muy bajo: ${bias1hScore}`);
      return;
    }

    const totalScore = longScore + shortScore;
    if (!totalScore) return;
    const scalpDir = longScore > shortScore ? 'LONG' : 'SHORT';
    const scalpProb = Math.round((Math.max(longScore,shortScore)/Math.max(totalScore,1))*100);
    if (scalpProb < parseInt(process.env.SCALP_THRESHOLD || '88')) return;
    const highs3m = k3m.data.slice(-20).map(k=>parseFloat(k[2])), lows3m = k3m.data.slice(-20).map(k=>parseFloat(k[3]));
    const rawAtr = highs3m.reduce((s,h,i)=>s+(h-lows3m[i]),0)/20;
    const atr3m = Math.max(rawAtr, price*0.008); // mínimo 0.8% — evita SL = entry
    const isLong = scalpDir==='LONG';
    const tp1 = isLong ? price+atr3m*1.5 : price-atr3m*1.5; // 1.5x ATR — más alcanzable en mercado lateral
    const sl  = isLong ? price-atr3m*0.8 : price+atr3m*0.8;
    if (isLong && sl >= price) { console.log(`⚠️ Scalp descartado — SL inválido`); return; }
    if (!isLong && sl <= price) { console.log(`⚠️ Scalp descartado — SL inválido`); return; }
    const rrVal = Math.abs(tp1-price)/Math.abs(sl-price);
    if (rrVal < 1.5) return;
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol',symbol).eq('status','open');
    if (existing?.length) return;
    // Obtener datos adicionales para market_data completo (ML)
    let bias4hScalp = null, oiTrend15mScalp = null, fundingScalp = 0, whaleDataScalp = null;
    try {
      const [k4hS, oi15mS, fundS, oi4hS] = await Promise.all([
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
        fetchOIHistory(symbol,'15m',5),
        axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
        fetchOIHistory(symbol,'4h',5),
      ]);
      fundingScalp = parseFloat(fundS.data.lastFundingRate);
      bias4hScalp = calcBias(k4hS.data, oi4hS, fundingScalp);
      oiTrend15mScalp = calcOITrend(oi15mS);
      whaleDataScalp = await detectWhales(symbol, price);
    } catch(_) {}

    const mlDataScalp = {
      confidence: scalpProb,
      direction: scalpDir,
      mode: 'scalping',
      price,
      rsi_3m: rsi3m,
      cvd_3m: cvd3m.cvdPct,
      cvd_trend: cvd3m.trend,
      ob_imbalance: imb,
      funding_rate: fundingScalp,
      oi_trend_15m: oiTrend15mScalp?.trend || 'flat',
      oi_delta_15m: oiTrend15mScalp?.deltaPct || '0',
      bias_1h: bias1hScalp?.bias || 'neutral',
      bias_1h_score: bias1hScalp?.score || 50,
      bias_4h: bias4hScalp?.bias || bias4hScalp2?.bias || 'neutral',
      bias_4h_score: bias4hScalp?.score || bias4hScalp2?.score || 50,
      fib_level: fib3m?.nearestRetrace?.label || null,
      fib_dist: fib3m?.nearestRetrace?.dist || null,
      fib_signal: fib3m?.retImpact?.signal || null,
      fib_bonus: fib3m?.retImpact?.bonus || 0,
      whale_count: whaleDataScalp?.whaleCount || 0,
      whale_bias: whaleDataScalp?.whaleBias || 'neutral',
      whale_dominance: whaleDataScalp?.dominance || 'balanced',
      ws_anomaly: wsM?.anomaly?.reason || null,
      ws_vol_multiplier: wsM?.volumeMultiplier || 1,
      ws_cvd_live: wsM?.cvdLive || 0,
      atr_3m: atr3m.toFixed(1),
      timestamp: new Date().toISOString()
    };

    await supabase.from('paper_trades').insert({
      symbol, direction:scalpDir, entry:price, tp1, tp2:tp1, sl,
      rr:`1:${rrVal.toFixed(1)}`, confidence:scalpProb,
      size_usd:parseFloat(process.env.PAPER_SIZE_USD||'1000'),
      leverage:parseInt(process.env.PAPER_LEVERAGE||'10'),
      source:'scalping', status:'open', opened_at: new Date().toISOString(), market_data: mlDataScalp
    });
    if (process.env.TELEGRAM_CHAT_ID) {
      const msg = `⚡ *SCALPING ${scalpDir}* — ${symbol}\n💰 Entry: *$${parseInt(price).toLocaleString()}*\n🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}\n📐 R:R 1:${rrVal.toFixed(1)} | ${scalpProb}%${wsM?.anomaly?'\n⚡ WS: '+wsM.anomaly.reason:''}`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode:'Markdown' }); } catch(_) {}
    }
    console.log(`⚡ Scalp: ${scalpDir} ${symbol} @ $${price} WS:${wsM?.anomaly?.direction||'none'}`);
  } catch(e) { console.error('Scalping error:', e.message); }
  finally { scalpingInProgress[symbol] = false; }
}

}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Panel Futuros LO v4.4.15 corriendo en puerto ${PORT}`);
  syncBinanceTime();
  startAlertJob();
});
