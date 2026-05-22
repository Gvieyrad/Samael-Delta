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
// ── Filtro de horario — análisis estadístico 256 trades ─────────────────────
// Horas Lima (UTC-5) con WR <35%: 0,1,2,7,10,11,14,16,22
// Sesiones de Luis: Mañana 7-10h | Tarde 15-19h Lima
// Horas extra rentables: 13h (WR 73%), 21h (WR 50%), 23h (WR 75%)
const HORAS_ACTIVAS_LIMA = new Set([7, 8, 9, 13, 15, 16, 17, 18, 19, 21, 23]);

const WALL_ENABLED       = false; // solo sweep activo
const SCALP_ENABLED      = false; // solo sweep activo
const AUTO_TRADE_ENABLED = false; // solo sweep activo

function isHoraBloqueada() {
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getHours();
  return !HORAS_ACTIVAS_LIMA.has(horaLima);
}

function getSesionActual() {
  const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getHours();
  if (h >= 7 && h <= 9)   return { nombre: 'Mañana', emoji: '🌅', activa: true };
  if (h >= 15 && h <= 19) return { nombre: 'Tarde NY', emoji: '🌆', activa: true };
  if (h === 13)            return { nombre: 'Mediodía', emoji: '☀️', activa: true };
  if (h === 21 || h === 23) return { nombre: 'Noche', emoji: '🌙', activa: true };
  return { nombre: 'Fuera de sesión', emoji: '💤', activa: false };
}


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
app.get('/', (req, res) => res.json({ status: 'Panel Futuros EL CHIMUELO activo', version: '4.4.94' }));

// ══════════════════════════════════════════════════════════════════
// ─── MÓDULO WEBSOCKET — DETECCIÓN EN TIEMPO REAL ─────────────────
// ══════════════════════════════════════════════════════════════════
const wsState = {};
const wsConnections = {};
const killSwitchCooldown = {};

function initWsState(symbol) {
  if (wsState[symbol]) return;
  wsState[symbol] = {
    trades: [], volumes: [], avgVolume1m: 0, lastOI: 0,
    oiHistory: [], lastPrice: 0, lastUpdate: 0, anomaly: null, liqZones: [],
    trailHigh: 0, trailLow: Infinity, // watermarks entre debounce windows
    pollingHigh: 0, pollingLow: Infinity, // watermarks acumulados entre ticks de polling
    lastWsMsgTime: Date.now(),
    _reconnectDelay: 5000,
  };
}

// ── CHECK SL/TP EN TIEMPO REAL v4.4.51 ──
// Se ejecuta en cada tick del WebSocket — cierra trades exactamente al SL/TP
const _slTpLocks = {}; // evitar doble cierre
const _trailingLastUpdate = {}; // throttle trailing SL writes — 30s por trade
const _maxProfitCache = {}; // max unrealized profit por trade id
async function checkSlTpOnTick(symbol, price, trailHigh = price, trailLow = price) {
  if (_slTpLocks[symbol]) return;
  try {
    const { data: openTrades } = await supabase
      .from('paper_trades').select('*')
      .eq('symbol', symbol).eq('status', 'open');
    if (!openTrades?.length) return;

    for (const trade of openTrades) {
      const entry = parseFloat(trade.entry);
      let sl      = parseFloat(trade.sl);
      const tp1   = parseFloat(trade.tp1);
      const lev   = parseFloat(trade.leverage || 10);
      const size  = parseFloat(trade.size_usd);
      const isLong = trade.direction === 'LONG';

      // ── Trailing stop — usa el high/low del ventana para capturar picos ──
      if (!_trailingLastUpdate[trade.id] || Date.now() - _trailingLastUpdate[trade.id] > 5000) {
        const trailExtreme = isLong ? trailHigh : trailLow; // pico favorable del ventana
        const priceDiffPctTr = isLong ? (trailExtreme - entry) / entry * 100 : (entry - trailExtreme) / entry * 100;
        let newSlTr = sl;
        if (trade.source === 'sweep') {
          const sweepPnl = (isLong ? (trailExtreme - entry) / entry : (entry - trailExtreme) / entry) * size * lev;
          if (sweepPnl >= 40) {
            const candidate = isLong ? trailExtreme * (1 - 0.0018) : trailExtreme * (1 + 0.0018);
            newSlTr = isLong ? Math.max(sl, candidate) : Math.min(sl, candidate);
          } else if (sweepPnl >= 25) {
            const candidate = isLong ? trailExtreme * (1 - 0.003) : trailExtreme * (1 + 0.003);
            newSlTr = isLong ? Math.max(sl, candidate) : Math.min(sl, candidate);
          } else if (sweepPnl >= 15) {
            const lockSl = isLong ? entry * (1 + 8 / (size * lev)) : entry * (1 - 8 / (size * lev));
            newSlTr = isLong ? Math.max(sl, lockSl) : Math.min(sl, lockSl);
          }
        } else if (priceDiffPctTr >= 0.5) {
          const beTarget = isLong ? entry * 1.001 : entry * 0.999;
          const trailDistPct = Math.max(0.0025, 0.005 - priceDiffPctTr * 0.001);
          const candidate = isLong ? trailExtreme * (1 - trailDistPct) : trailExtreme * (1 + trailDistPct);
          const slFloor = isLong ? Math.max(beTarget, candidate) : Math.min(beTarget, candidate);
          newSlTr = isLong ? Math.max(sl, slFloor) : Math.min(sl, slFloor);
        }
        if ((isLong && newSlTr > sl) || (!isLong && newSlTr < sl)) {
          const newSlRounded = parseFloat(newSlTr.toFixed(1));
          await supabase.from('paper_trades').update({ sl: newSlRounded }).eq('id', trade.id);
          sl = newSlRounded;
          _trailingLastUpdate[trade.id] = Date.now();
          console.log(`📈 Trailing (WS): ${trade.direction} ${symbol} SL → ${newSlRounded.toFixed(1)} (extreme ${trailExtreme.toFixed(1)}, +${priceDiffPctTr.toFixed(2)}%)`);
        }
      }

      // SL moved past entry by trailing stop → treat as profit lock, not loss
      const slBeyondEntry = isLong ? sl >= entry : sl <= entry;

      let closeReason = null;
      let closePrice  = price;

      // Usar watermarks para detectar si SL/TP fue tocado dentro del ventana de debounce
      if (isLong) {
        if (trailLow <= sl)   { closeReason = slBeyondEntry ? 'trailing_tp' : 'sl'; closePrice = sl; }
        else if (trailHigh >= tp1) { closeReason = 'tp1'; closePrice = tp1; }
      } else {
        if (trailHigh >= sl)  { closeReason = slBeyondEntry ? 'trailing_tp' : 'sl'; closePrice = sl; }
        else if (trailLow <= tp1) { closeReason = 'tp1'; closePrice = tp1; }
      }

      // Actualizar max profit intraday
      const _curPnl = (isLong ? (price - entry) / entry : (entry - price) / entry) * size * lev;
      if (!(_maxProfitCache[trade.id] >= _curPnl)) _maxProfitCache[trade.id] = _curPnl;

      if (!closeReason) continue;

      // Lock para evitar doble cierre
      _slTpLocks[symbol] = true;
      setTimeout(() => { _slTpLocks[symbol] = false; }, 1000);

      const priceDiff = isLong ? (closePrice - entry) / entry : (entry - closePrice) / entry;
      const pnl_usd   = parseFloat((size * priceDiff * lev).toFixed(2));
      const pnl_pct   = parseFloat((priceDiff * lev * 100).toFixed(2));
      const status    = pnl_usd > 0 ? 'won' : 'lost';

      await supabase.from('paper_trades').update({
        status, close_price: closePrice, close_reason: closeReason,
        pnl_usd, pnl_pct, closed_at: new Date().toISOString(),
        max_profit_usd: parseFloat((_maxProfitCache[trade.id] ?? pnl_usd).toFixed(2))
      }).eq('id', trade.id);
      delete _maxProfitCache[trade.id];

      // Circuit breaker
      if (trade.source !== 'manual') circuitBreaker.addPnl(pnl_usd);

      // Loss trackers
      if (trade.source === 'scalping') {
        const tracker = trade.symbol.includes('ETH') ? ethLossTracker
                      : trade.symbol.includes('SOL') ? solLossTracker : null;
        if (tracker) { if (status === 'lost') tracker.recordLoss(); else tracker.recordWin(); }
      }

      console.log(`⚡ WS ${closeReason.toUpperCase()}: ${trade.direction} ${symbol} @ $${closePrice.toFixed(2)} PnL: $${pnl_usd}`);

      // Telegram
      if (process.env.TELEGRAM_CHAT_ID) {
        const _srcIconsWs = { auto: '🤖', scalping: '⚡', manual: '👤', sweep: '🌊', wall: '🧱', meanrev: '📊' };
        const _srcLabelWs = { auto: 'Auto', scalping: 'Scalping', manual: 'Manual', sweep: 'Sweep', wall: 'Wall', meanrev: 'MeanRev' };
        const _srcIconWs = _srcIconsWs[trade.source] || '📊', _srcNameWs = _srcLabelWs[trade.source] || trade.source || '–';
        const _isTrailingWs = closeReason?.includes('trailing');
        const _razonMapWs = { tp1: 'TP1', tp2: 'TP2', sl: 'SL', timeout: 'Timeout 2h', timeout_lateral: 'Timeout lateral', kill_switch: 'Kill switch', signal_reversal: 'Reversión señal', manual_tp: 'TP manual', manual: 'Cierre manual' };
        const _razonWs = _razonMapWs[closeReason] || (closeReason || '–').toUpperCase();
        const _dCw = new Date(), _limaCw = `${_dCw.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dCw.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
        const _closedEmojiWs = pnl_usd >= 0 ? '✅' : '❌';
        const msgWs = _isTrailingWs
          ? `${_closedEmojiWs} ${trade.direction} ${symbol} — ${_srcIconWs} ${_srcNameWs}\n💰 Entry: $${parseInt(entry).toLocaleString()} → $${parseInt(closePrice).toLocaleString()}\n🔒 Trailing SL\n💵 PnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\n🕐 Cierre: ${_limaCw}`
          : `${_closedEmojiWs} ${trade.direction} ${symbol} — ${_srcIconWs} ${_srcNameWs}\n💰 Entry: $${parseInt(entry).toLocaleString()} → $${parseInt(closePrice).toLocaleString()}\n🎯 Razón: ${_razonWs}\n💵 PnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\n🕐 Cierre: ${_limaCw}`;
        try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msgWs); } catch(e) { console.error('Telegram send error:', e.message); }
      }
    }
  } catch(e) { _slTpLocks[symbol] = false; }
}

function connectWebSocket(symbol) {
  if (wsConnections[symbol]) return;
  initWsState(symbol);
  const stream = `${symbol.toLowerCase()}@aggTrade`;
  const url = `${BINANCE_WS}/ws/${stream}`;
  console.log(`🔌 WebSocket conectando: ${symbol}`);
  const ws = new (require('ws'))(url);
  wsConnections[symbol] = ws;
  ws.on('open', () => {
    wsState[symbol].lastWsMsgTime = Date.now();
    wsState[symbol]._reconnectDelay = 5000;
    console.log(`✅ WS conectado: ${symbol}`);
  });
  ws.on('message', (data) => {
    try {
      const t = JSON.parse(data);
      if (!t.p) {
        wsState[symbol]._unknownMsgCount = (wsState[symbol]._unknownMsgCount || 0) + 1;
        if (wsState[symbol]._unknownMsgCount <= 3)
          console.log(`📨 WS msg sin precio ${symbol}: e=${t.e||'?'} keys=${Object.keys(t).join(',')}`);
        return;
      }
      const price = parseFloat(t.p), qty = parseFloat(t.q), usdVal = price * qty;
      if (!price || isNaN(price)) return;
      wsState[symbol]._unknownMsgCount = 0;
      const isBuy = !t.m, now = Date.now();
      if (!wsState[symbol]._firstMsg) {
        console.log(`📡 WS primer msg ${symbol}: price=${price} type=${t.e||'?'}`);
        wsState[symbol]._firstMsg = true;
      }
      wsState[symbol].lastPrice = price;
      wsState[symbol].lastUpdate = now;
      wsState[symbol].lastWsMsgTime = now;
      wsState[symbol].trades.push({ price, qty, usdVal, isBuy, time: now });
      wsState[symbol].trades = wsState[symbol].trades.filter(tr => now - tr.time < 120000);
      // ── Watermarks de high/low para trailing y SL preciso ──
      if (price > wsState[symbol].trailHigh) wsState[symbol].trailHigh = price;
      if (price < wsState[symbol].trailLow)  wsState[symbol].trailLow  = price;
      if (price > wsState[symbol].pollingHigh) wsState[symbol].pollingHigh = price;
      if (price < wsState[symbol].pollingLow)  wsState[symbol].pollingLow  = price;
      // ── Check SL/TP en tiempo real — debounce 200ms usando lastPrice ──
      if (!wsState[symbol]._slTpTimer) {
        wsState[symbol]._slTpTimer = setTimeout(() => {
          wsState[symbol]._slTpTimer = null;
          const _p    = wsState[symbol].lastPrice;
          const _high = wsState[symbol].trailHigh || _p;
          const _low  = wsState[symbol].trailLow  || _p;
          wsState[symbol].trailHigh = _p; // reset tras cada check
          wsState[symbol].trailLow  = _p;
          checkSlTpOnTick(symbol, _p, _high, _low);
        }, 200);
      }
      if (!wsState[symbol]._evalTimer) {
        wsState[symbol]._evalTimer = setTimeout(() => { wsState[symbol]._evalTimer = null; evaluateAnomaly(symbol); }, 500);
      }
    } catch(e) { console.error(`❌ WS msg error ${symbol}:`, e.message); }
  });
  ws.on('close', (code, reason) => {
    const delay = wsState[symbol]?._reconnectDelay || 5000;
    console.log(`⚠️ WS desconectado: ${symbol} (code=${code}) — reconectando en ${delay/1000}s`);
    delete wsConnections[symbol];
    setTimeout(() => connectWebSocket(symbol), delay);
  });
  ws.on('error', (e) => { console.log(`❌ WS error ${symbol}: ${e.message}`); ws.terminate(); });
}

function getWsMetrics(symbol) {
  const state = wsState[symbol];
  if (!state || !state.trades.length) return null;
  const now = Date.now();
  const last60s = state.trades.filter(t => now - t.time < 30000);
  const last10s = state.trades.filter(t => now - t.time < 10000);
  if (!last60s.length) return null;
  const totalVol60s = last60s.reduce((s, t) => s + t.usdVal, 0);
  const buyVol60s = last60s.filter(t => t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const sellVol60s = last60s.filter(t => !t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const cvdLive = (buyVol60s - sellVol60s) / Math.max(totalVol60s, 1) * 100;
  const totalVol10s = last10s.reduce((s, t) => s + t.usdVal, 0);
  const buyVol10s = last10s.filter(t => t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const sellVol10s = last10s.filter(t => !t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const whaleThreshold = symbol.includes('BTC') ? 10000000 : symbol.includes('ETH') ? 3000000 : 1000000;
  const whales60s = last60s.filter(t => t.usdVal >= whaleThreshold);
  const whaleBuyVol = whales60s.filter(t => t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const whaleSellVol = whales60s.filter(t => !t.isBuy).reduce((s, t) => s + t.usdVal, 0);
  const last600s = state.trades.filter(t => now - t.time < 600000);
  const last120s = state.trades.filter(t => now - t.time < 60000 && now - t.time >= 30000);
  let dynamicAvg = state.avgVolume1m / 2;
  if (last600s.length >= 10) dynamicAvg = last600s.reduce((s, t) => s + t.usdVal, 0) / 20;
  else if (last120s.length >= 5) dynamicAvg = last120s.reduce((s, t) => s + t.usdVal, 0) / 2;
  const effectiveAvg = Math.max(dynamicAvg, state.avgVolume1m / 2);
  const volumeMultiplier = effectiveAvg > 0 ? totalVol60s / effectiveAvg : 1;
  return { totalVol60s, buyVol60s, sellVol60s, cvdLive, totalVol10s, buyVol10s, sellVol10s,
    whaleCount: whales60s.length, whaleBuyVol, whaleSellVol, avgVolume1m: effectiveAvg,
    volumeMultiplier, lastPrice: state.lastPrice, anomaly: state.anomaly };
}

async function evaluateAnomaly(symbol) {
  const state = wsState[symbol];
  if (!state) return;
  if (!state.avgVolume1m) return; // baseline no inicializado — esperar primer poll REST
  const metrics = getWsMetrics(symbol);
  if (!metrics) return;
  const volMultiplier = parseInt(process.env.WS_VOLUME_MULTIPLIER || '4');
  const now = Date.now();
  const isVolumeAnomaly = metrics.volumeMultiplier >= volMultiplier;
  const isBearishSweep = metrics.cvdLive < -40 && isVolumeAnomaly;
  const isBullishSweep = metrics.cvdLive > 40 && isVolumeAnomaly;
  const prices60s = state.trades.filter(t => now - t.time < 30000).map(t => t.price);
  const priceMove60s = prices60s.length >= 2 ? Math.abs(prices60s[prices60s.length-1] - prices60s[0]) / prices60s[0] * 100 : 0;
  const cvdExtreme = Math.abs(metrics.cvdLive) >= 70;
  const priceThreshold = cvdExtreme ? 0.05 : 0.15;
  const isPriceMoving = priceMove60s >= priceThreshold;
  const isRealBearishSweep = isBearishSweep && isPriceMoving;
  const isRealBullishSweep = isBullishSweep && isPriceMoving;
  if (isVolumeAnomaly && (isBearishSweep || isBullishSweep) && !isPriceMoving) {
    console.log(`🔍 ${symbol} BLOQUEADO — vol=${metrics.volumeMultiplier.toFixed(1)}x CVD=${metrics.cvdLive.toFixed(1)}% priceMove=${priceMove60s.toFixed(3)}% < ${priceThreshold}%`);
  }
  const realWhaleThreshold = symbol.includes('BTC') ? 10000000 : symbol.includes('ETH') ? 5000000 : 1000000;
  const bigWhale = state.trades.find(t => t.usdVal >= realWhaleThreshold && now - t.time < 30000);
  const massiveWhaleThreshold = symbol.includes('BTC') ? 20000000 : symbol.includes('ETH') ? 8000000 : 3000000;
  const massiveAccumThreshold = symbol.includes('BTC') ? 30000000 : symbol.includes('ETH') ? 20000000 : 5000000;
  const last10sTrades = state.trades.filter(t => now - t.time < 10000);
  const last10sBuyVol = last10sTrades.filter(t => t.isBuy).reduce((s,t) => s + t.usdVal, 0);
  const last10sSellVol = last10sTrades.filter(t => !t.isBuy).reduce((s,t) => s + t.usdVal, 0);
  const massiveWhaleSingle = state.trades.find(t => t.usdVal >= massiveWhaleThreshold && now - t.time < 30000);
  const massiveWhaleBuyAccum = last10sBuyVol >= massiveAccumThreshold;
  const massiveWhaleSellAccum = last10sSellVol >= massiveAccumThreshold;
  const dominanciaRatioBuy = last10sSellVol > 0 ? last10sBuyVol / last10sSellVol : 99;
  const dominanciaRatioSell = last10sBuyVol > 0 ? last10sSellVol / last10sBuyVol : 99;
  const hayDominanciaCompra = dominanciaRatioBuy >= 1.5;
  const hayDominanciaVenta = dominanciaRatioSell >= 1.5;
  const isMassiveWhale = !!(massiveWhaleSingle || (massiveWhaleBuyAccum && hayDominanciaCompra) || (massiveWhaleSellAccum && hayDominanciaVenta));
  const massiveWhaleDirection = massiveWhaleSingle ? (massiveWhaleSingle.isBuy ? 'LONG' : 'SHORT') : massiveWhaleBuyAccum && hayDominanciaCompra ? 'LONG' : 'SHORT';
  const massiveWhaleVol = massiveWhaleSingle ? massiveWhaleSingle.usdVal : Math.max(last10sBuyVol, last10sSellVol);
  const liqZoneBonus = calcLiqZoneBonus(symbol, metrics.lastPrice);
  if (!isRealBearishSweep && !isRealBullishSweep && !bigWhale && !isMassiveWhale) return;
  const isSweep = isRealBearishSweep || isRealBullishSweep;
  const isWhaleOnly = !isSweep && !!bigWhale && !isMassiveWhale;
  const direction = isRealBearishSweep ? 'SHORT' : isRealBullishSweep ? 'LONG' : isMassiveWhale ? massiveWhaleDirection : (bigWhale?.isBuy ? 'LONG' : 'SHORT');
  const reason = isRealBearishSweep ? `Barrida bajista — CVD ${metrics.cvdLive.toFixed(1)}% vol ${metrics.volumeMultiplier.toFixed(1)}x precio -${priceMove60s.toFixed(2)}%` :
                 isRealBullishSweep ? `Barrida alcista — CVD +${metrics.cvdLive.toFixed(1)}% vol ${metrics.volumeMultiplier.toFixed(1)}x precio +${priceMove60s.toFixed(2)}%` :
                 isMassiveWhale ? `🐋 Ballena masiva $${(massiveWhaleVol/1e6).toFixed(1)}M ${massiveWhaleDirection === 'LONG' ? 'comprando' : 'vendiendo'}${massiveWhaleSingle ? ' (orden única)' : ' (acumulada 10s)'}` :
                 `Ballena $${(bigWhale.usdVal/1e6).toFixed(2)}M ${bigWhale.isBuy ? 'comprando' : 'vendiendo'}`;
  const cooldownKey = `${symbol}_${direction}`;
  if (killSwitchCooldown[cooldownKey] && now - killSwitchCooldown[cooldownKey] < 3 * 60 * 1000) {
    const remaining = Math.ceil((3 * 60 * 1000 - (now - killSwitchCooldown[cooldownKey])) / 1000);
    console.log(`⏳ Sweep/Whale descartado — cooldown activo ${symbol} ${direction} — faltan ${remaining}s`);
    return;
  }
  killSwitchCooldown[cooldownKey] = now;
  if (isSweep || isWhaleOnly) {
    state.anomaly = { direction, reason, time: now, volumeMultiplier: metrics.volumeMultiplier, cvdLive: metrics.cvdLive, liqZoneBonus, isSweep: !!(isRealBearishSweep || isRealBullishSweep), isWhale: !!bigWhale && !isSweep };
    setTimeout(() => { if (wsState[symbol]?.anomaly?.time === now) wsState[symbol].anomaly = null; }, 5 * 60 * 1000);
  }
  console.log(`⚡ ANOMALÍA DETECTADA: ${direction} ${symbol} — ${reason} (liq bonus: +${liqZoneBonus})`);
  if (isSweep) {
    await killSwitchOpposite(symbol, direction, reason);
    await openSweepCounterTrade(symbol, direction, metrics, reason, liqZoneBonus);
  } else if (isMassiveWhale) {
    await killSwitchOpposite(symbol, massiveWhaleDirection, reason);
    await openWhaleCounterTrade(symbol, massiveWhaleDirection, metrics, reason, liqZoneBonus);
  }
  if (process.env.TELEGRAM_CHAT_ID) {
    if (isSweep) {
      // Telegram de sweep enviado dentro de openSweepCounterTrade — no duplicar aquí
    } else if (isMassiveWhale) {
      // Telegram de ballena enviado dentro de openWhaleCounterTrade — no duplicar aquí
    }
  }
}

async function openWhaleCounterTrade(symbol, direction, metrics, reason, liqBonus) {
  try {
    // Filtro horario — ballenas fuertes (CVD>85% + Vol>8x) saltan restricción
    if (isHoraBloqueada()) {
      const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getHours();
      const esBallenaFuerte = Math.abs(metrics.cvdLive) > 85 && metrics.volumeMultiplier > 8;
      // Madrugada 1-4h — bloqueo absoluto incluso para ballenas fuertes
      const esMadrugadaAbsoluta = horaLima >= 1 && horaLima <= 4;
      if (!esBallenaFuerte || esMadrugadaAbsoluta) {
        console.log(`⏰ Whale bloqueado — hora ${horaLima}h Lima${esBallenaFuerte ? ' (madrugada absoluta)' : ' fuera de ventana óptima'}`);
        if (process.env.TELEGRAM_CHAT_ID) try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `⏰ 🐋 Ballena ${direction} ${symbol} — *BLOQUEADA*\nRazón: Hora ${horaLima}h Lima fuera de ventana óptima\n🕐 ${new Date().toLocaleTimeString('es-PE')}`, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
        return;
      }
      console.log(`✅ Whale ${direction} ${symbol} — hora ${horaLima}h SALTADA por señal fuerte (CVD:${metrics.cvdLive.toFixed(1)}% Vol:${metrics.volumeMultiplier.toFixed(1)}x)`);
    }
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
    if (existing?.length) { console.log(`⏭ Whale trade omitido — ya hay trade abierto para ${symbol}`); return; }
    const { data: recentWhale } = await supabase.from('paper_trades').select('opened_at').eq('symbol', symbol).eq('source', 'sweep').order('opened_at', { ascending: false }).limit(1);
    if (recentWhale?.length) {
      const lastOpened = new Date(recentWhale[0].opened_at).getTime();
      const cooldownMs = 15 * 60 * 1000;
      if (Date.now() - lastOpened < cooldownMs) { console.log("⏳ Whale cooldown " + symbol + " — esperar " + Math.ceil((cooldownMs - (Date.now() - lastOpened)) / 60000) + " min más"); return; }
    }
    const detectionPrice = metrics.lastPrice;
    if (!detectionPrice) return;
    let currentPriceCheck = detectionPrice;
    try { const tickerCheck = await axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=${symbol}`); currentPriceCheck = parseFloat(tickerCheck.data.price); } catch(_) {}
    const priceMovedAgainstUs = direction === 'SHORT' ? currentPriceCheck > detectionPrice * 1.003 : currentPriceCheck < detectionPrice * 0.997;
    if (priceMovedAgainstUs) { console.log(`⏭ Whale trade omitido — precio ya rebotó desde detección (${symbol})`); return; }
    // v4.4.16 C2: confirmación precio 5min — si ballena vendió pero precio no cayó = absorción compradora
    // Los 3 perdedores ETH SHORT ($10.1M, $10.3M, $15.2M) tenían este patrón exacto
    const prices5mWh = wsState[symbol]?.trades?.filter(t => Date.now() - t.time < 5*60*1000).map(t => t.price) || [];
    if (prices5mWh.length >= 5) {
      const priceMove5m = (prices5mWh[prices5mWh.length-1] - prices5mWh[0]) / prices5mWh[0] * 100;
      if (direction === 'SHORT' && priceMove5m > -0.1) {
        console.log(`⏭ Whale SHORT omitido — precio no confirma bajada en 5min (${priceMove5m.toFixed(2)}%) — absorción compradora (${symbol})`);
        if (process.env.TELEGRAM_CHAT_ID) try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `⚠️ 🐋 Ballena SHORT ${symbol} — *NO ABRIÓ*\nRazón: Precio no confirmó bajada en 5min (${priceMove5m.toFixed(2)}%) — posible absorción compradora\n💡 La señal fue detectada pero el filtro de seguridad la bloqueó\n🕐 ${new Date().toLocaleTimeString('es-PE')}`, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
        return;
      }
      if (direction === 'LONG' && priceMove5m < 0.1) {
        console.log(`⏭ Whale LONG omitido — precio no confirma subida en 5min (${priceMove5m.toFixed(2)}%) — absorción vendedora (${symbol})`);
        if (process.env.TELEGRAM_CHAT_ID) try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `⚠️ 🐋 Ballena LONG ${symbol} — *NO ABRIÓ*\nRazón: Precio no confirmó subida en 5min (${priceMove5m.toFixed(2)}%) — posible absorción vendedora\n💡 La señal fue detectada pero el filtro de seguridad la bloqueó\n🕐 ${new Date().toLocaleTimeString('es-PE')}`, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
        return;
      }
    }
    const price = currentPriceCheck;
    // v4.4.17 C3-whale: bloquear si bias_1d es contrario al trade
    // Fix: C3 solo estaba en openSweepCounterTrade — los whale trades no lo tenían
    // Causa de pérdidas: ETH SHORT -$16, BTC SHORT -$31, BTC LONG -$28 con mercado en tendencia opuesta
    try {
      const k1dWh = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`);
      const bias1dWh = calcBias(k1dWh.data, null, 0);
      if (bias1dWh) {
        // v4.4.18 Fix B: neutral con score tendencial también bloquea
        const blockShortWh = bias1dWh.bias === 'long' || bias1dWh.score > 58;
        const blockLongWh  = bias1dWh.bias === 'short' || bias1dWh.score < 42;
        if (direction === 'SHORT' && blockShortWh) {
          console.log(`⏭ Whale SHORT omitido — bias_1d alcista (score:${bias1dWh.score}) — mercado diario en contra (${symbol})`);
      if (process.env.TELEGRAM_CHAT_ID) try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `⚠️ 🐋 Ballena SHORT ${symbol} — *NO ABRIÓ*\nRazón: Tendencia diaria alcista (score:${bias1dWh.score}) — mercado en contra\n🕐 ${new Date().toLocaleTimeString('es-PE')}`, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
          return;
        }
        if (direction === 'LONG' && blockLongWh) {
          console.log(`⏭ Whale LONG omitido — bias_1d bajista (score:${bias1dWh.score}) — mercado diario en contra (${symbol})`);
      if (process.env.TELEGRAM_CHAT_ID) try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `⚠️ 🐋 Ballena LONG ${symbol} — *NO ABRIÓ*\nRazón: Tendencia diaria bajista (score:${bias1dWh.score}) — mercado en contra\n🕐 ${new Date().toLocaleTimeString('es-PE')}`, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
          return;
        }
      }
    } catch(_) {}
    // v4.4.32 Fix A: vol_multiplier mínimo 6x — backtest 365d confirma: 6x da mejor Z-Score y WR que 4x
    if (metrics.volumeMultiplier < 6) {
      console.log(`⏭ Whale trade omitido — vol ${metrics.volumeMultiplier.toFixed(1)}x insuficiente (<6x) — señal débil (${symbol})`);
      return;
    }
    // v4.4.36 Fix CVD: CVD mínimo 60% — datos reales: CVD>60 WR 58.8% vs CVD 40-60 WR 39.3%
    if (Math.abs(metrics.cvdLive) < 60) {
      console.log(`⏭ Whale trade omitido — CVD ${metrics.cvdLive.toFixed(1)}% insuficiente (<60%) (${symbol})`);
      return;
    }
    // v4.4.34 Fix CVD 5min — confirmar flujo de dinero en contexto amplio
    try {
      const kCvd5m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=3m&limit=10`);
      let buyVol5m = 0, sellVol5m = 0;
      for (const k of kCvd5m.data) {
        const v = parseFloat(k[5]);
        if (parseFloat(k[4]) >= parseFloat(k[1])) buyVol5m += v;
        else sellVol5m += v;
      }
      const totalVol5m = buyVol5m + sellVol5m;
      const cvd5mPct = totalVol5m > 0 ? (buyVol5m - sellVol5m) / totalVol5m * 100 : 0;
      if (direction === 'LONG' && cvd5mPct < -20) {
        console.log(`⏭ Whale LONG omitido — CVD 5min negativo (${cvd5mPct.toFixed(1)}%) instituciones vendiendo (${symbol})`);
        return;
      }
      if (direction === 'SHORT' && cvd5mPct > 20) {
        console.log(`⏭ Whale SHORT omitido — CVD 5min positivo (${cvd5mPct.toFixed(1)}%) instituciones comprando (${symbol})`);
        return;
      }
    } catch(_) {}
    const k5m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=20`);
    const highs5m = k5m.data.map(k => parseFloat(k[2])), lows5m = k5m.data.map(k => parseFloat(k[3]));
    const atr5m = highs5m.slice(-10).reduce((s,h,i) => s + (h - lows5m[i]), 0) / 10;
    const atr = Math.max(atr5m, price * 0.004);
    const isLong = direction === 'LONG';
    const tp1 = isLong ? price + atr * 1.2 : price - atr * 1.2;
    const sl = isLong ? price - atr * 0.8 : price + atr * 0.8;
    if (isLong && sl >= price) return;
    if (!isLong && sl <= price) return;
    const rrVal = Math.abs(tp1 - price) / Math.abs(sl - price);
    if (rrVal < 1.2) { console.log(`⚠️ Whale trade descartado — R:R ${rrVal.toFixed(2)} < 1.2`); return; }
    // v4.4.16 C1: confianza mínima 82 — conf=77 tenía WR 40% y PnL negativo
    const whaleConfidence = Math.max(82, Math.min(92, Math.round(72 + (metrics.volumeMultiplier >= 5 ? 10 : 5) + liqBonus)));
    await supabase.from('paper_trades').insert({ symbol, direction, entry: price, tp1, tp2: isLong ? price + atr * 3.5 : price - atr * 3.5, sl, rr: `1:${rrVal.toFixed(1)}`, confidence: whaleConfidence, size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'), leverage: parseInt(process.env.PAPER_LEVERAGE || '5'), source: 'sweep', status: 'open', opened_at: new Date().toISOString(), market_data: { mode: 'whale', reason, cvd_live: metrics.cvdLive, volume_multiplier: metrics.volumeMultiplier, liq_bonus: liqBonus, timestamp: new Date().toISOString(), ...tradeCtx } });
    console.log(`🐋 Whale trade abierto: ${direction} ${symbol} @ $${price} R:R 1:${rrVal.toFixed(1)} conf:${whaleConfidence}%`);
    if (process.env.TELEGRAM_CHAT_ID) {
      const e = direction === 'SHORT' ? '▼' : '▲';
      const _dW=new Date(), _limaW=`🕐 Apertura: ${_dW.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dW.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
      const msg = `🐋 *Whale Trade Abierto — ${symbol}*\n${e} ${direction} @ $${parseInt(price).toLocaleString()}\n🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}\n📐 R:R 1:${rrVal.toFixed(1)} | ${whaleConfidence}%\n${reason}\n${_limaW}\nFuente: 🐋 Whale`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
    }
  } catch(e) { console.error('Whale trade error:', e.message); }
}

async function killSwitchOpposite(symbol, sweepDirection, reason) {
  try {
    const oppositeDir = sweepDirection === 'SHORT' ? 'LONG' : 'SHORT';
    const { data: openTrades } = await supabase.from('paper_trades').select('*').eq('symbol', symbol).eq('status', 'open').eq('direction', oppositeDir);
    if (!openTrades?.length) return;
    for (const trade of openTrades) {
      const currentPrice = wsState[symbol]?.lastPrice || parseFloat(trade.entry);
      const entry = parseFloat(trade.entry), sl = parseFloat(trade.sl);
      // Trade sweep en profit >= $15 → el trailing ya lo protege, no interferir
      if (trade.source === 'sweep') {
        const _ks_lev = parseFloat(trade.leverage || 10);
        const _ks_pnl = parseFloat(trade.size_usd) * (trade.direction === 'LONG' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry) * _ks_lev;
        if (_ks_pnl >= 15) {
          console.log(`⏭ Kill switch omitido — trade sweep en profit $${_ks_pnl.toFixed(2)}, trailing activo`);
          continue;
        }
      }
      // Solo actuar si precio ya recorrió >60% del camino hacia el SL
      // ETH: 40% por mayor volatilidad (beta 1.4x vs BTC), spec global es 60%
      const slThreshold = symbol.includes('ETH') ? 0.40 : 0.60;
      const totalDistance = Math.abs(sl - entry), currentDistance = Math.abs(currentPrice - entry);
      const slProgress = totalDistance > 0 ? currentDistance / totalDistance : 0;
      if (slProgress < slThreshold) {
        console.log(`⏭ Kill switch omitido — ${trade.direction} ${symbol} al ${(slProgress*100).toFixed(0)}% del SL (umbral: ${(slThreshold*100).toFixed(0)}%)`);
        if (process.env.TELEGRAM_CHAT_ID) {
          const msg = `⏭ Kill Switch omitido — ${trade.direction} ${symbol}\nAl ${(slProgress*100).toFixed(0)}% del SL — margen suficiente\nPrecio: $${parseInt(currentPrice).toLocaleString()} | SL: $${parseInt(sl).toLocaleString()}`;
          try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
        }
        continue;
      }
      const priceDiff = trade.direction === 'LONG' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
      const _lev1 = parseFloat(trade.leverage || 10);
      const pnl_usd = parseFloat((parseFloat(trade.size_usd) * priceDiff * _lev1).toFixed(2));
      const pnl_pct = parseFloat((priceDiff * _lev1 * 100).toFixed(2));
      await supabase.from('paper_trades').update({ status: pnl_usd >= 0 ? 'won' : 'lost', close_price: currentPrice, close_reason: 'kill_switch', pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', trade.id);
      console.log(`🛡️ Kill switch: cerrado ${trade.direction} ${symbol} @ $${currentPrice} PnL: $${pnl_usd} (${(slProgress*100).toFixed(0)}% hacia SL)`);
      if (process.env.TELEGRAM_CHAT_ID) {
        const msg = `🛡️ *Kill Switch activado*\n${trade.direction} ${symbol} cerrado\nEntry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentPrice).toLocaleString()}\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\nRazón: ${reason}`;
        try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
      }
    }
  } catch(e) { console.error('Kill switch error:', e.message); }
}

async function openSweepCounterTrade(symbol, direction, metrics, reason, liqBonus) {
  try {
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
    if (existing?.length) { console.log(`⏭ Sweep trade omitido — ya hay trade abierto para ${symbol}`); return; }
    const price = metrics.lastPrice;
    if (!price) return;
    // v4.4.16 C2b: confirmación precio 5min en sweep — misma lógica que whale trade
    const prices5mSw = wsState[symbol]?.trades?.filter(t => Date.now() - t.time < 5*60*1000).map(t => t.price) || [];
    if (prices5mSw.length >= 5) {
      const priceMove5mSw = (prices5mSw[prices5mSw.length-1] - prices5mSw[0]) / prices5mSw[0] * 100;
      const sweepThreshShort = (metrics.cvdLive < -80 && metrics.volumeMultiplier > 6) ? 0.03 : 0.1;
      if (direction === 'SHORT' && priceMove5mSw > -sweepThreshShort) {
        console.log(`⏭ Sweep SHORT omitido — precio no confirma bajada en 5min (${priceMove5mSw.toFixed(2)}% vs -${sweepThreshShort}%) — ${symbol}`);
        if (process.env.TELEGRAM_CHAT_ID) try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `⚠️ 🌊 Sweep SHORT ${symbol} — *NO ABRIÓ*\nRazón: Precio no confirmó bajada en 5min (${priceMove5mSw.toFixed(2)}%)\n🕐 ${new Date().toLocaleTimeString('es-PE')}`, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
        return;
      }
      const sweepThreshLong = (metrics.cvdLive > 80 && metrics.volumeMultiplier > 6) ? 0.03 : 0.1;
      if (direction === 'LONG' && priceMove5mSw < sweepThreshLong) {
        console.log(`⏭ Sweep LONG omitido — precio no confirma subida en 5min (${priceMove5mSw.toFixed(2)}% vs ${sweepThreshLong}%) — ${symbol}`);
        if (process.env.TELEGRAM_CHAT_ID) try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `⚠️ 🌊 Sweep LONG ${symbol} — *NO ABRIÓ*\nRazón: Precio no confirmó subida en 5min (${priceMove5mSw.toFixed(2)}%)\n🕐 ${new Date().toLocaleTimeString('es-PE')}`, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
        return;
      }
    }
    const k5m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=20`);
    const highs5m = k5m.data.map(k => parseFloat(k[2])), lows5m = k5m.data.map(k => parseFloat(k[3]));
    const atr5m = highs5m.slice(-10).reduce((s,h,i) => s + (h - lows5m[i]), 0) / 10;
    const atrPct = atr5m / price * 100;
    if (atrPct > 0.5) { console.log(`⏭ Sweep descartado — ATR ${atrPct.toFixed(3)}% > 0.5% (riesgo alto)`); return; }
    const atr = Math.max(atr5m, price * 0.003);
    const isShort = direction === 'SHORT';
    const tp1 = isShort ? price - atr * 2.5 : price + atr * 2.5;
    const sl = isShort ? price + atr * 0.8 : price - atr * 0.8;
    const rrVal = Math.abs(tp1 - price) / Math.abs(sl - price);
    if (rrVal < 1.2) { console.log(`⚠️ Sweep trade descartado — R:R ${rrVal.toFixed(2)} < 1.2`); return; }
    const sweepConfidence = Math.min(95, Math.round(70 + (metrics.volumeMultiplier >= 10 ? 15 : metrics.volumeMultiplier >= 7 ? 10 : 5) + (Math.abs(metrics.cvdLive) >= 50 ? 10 : 5) + liqBonus));
    if (sweepConfidence < 80) { console.log(`⏭ Sweep trade descartado — confidence ${sweepConfidence}% < 80%`); return; }
    let bias4hSweep = null, bias1dSweep = null, oiTrend15mSweep = null, fundingSweep = 0, fib15mSweep = null;
    try {
      const [k15mSw, k4hSw, k1dSw, oi15mSw, oi4hSw, fundSw] = await Promise.all([
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=50`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
        fetchOIHistory(symbol,'15m',5), fetchOIHistory(symbol,'4h',5),
        axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      ]);
      fundingSweep = parseFloat(fundSw.data.lastFundingRate);
      bias4hSweep = calcBias(k4hSw.data, oi4hSw, fundingSweep);
      bias1dSweep = calcBias(k1dSw.data, null, fundingSweep);
      oiTrend15mSweep = calcOITrend(oi15mSw);
      fib15mSweep = calcFibonacci(k15mSw.data, price);
    } catch(_) {}
    // v4.4.16 C3: bloquear sweep si bias_1d es contrario — mercado diario manda
    // ETH estaba en acumulación (bias_1d=long), ballenas SHORT de $10-15M no podían revertirlo
    if (bias1dSweep) {
      // v4.4.18 Fix B: neutral con score tendencial también bloquea
      const blockShortSw = bias1dSweep.bias === 'long' || bias1dSweep.score > 58;
      const blockLongSw  = bias1dSweep.bias === 'short' || bias1dSweep.score < 42;
      if (direction === 'SHORT' && blockShortSw) {
        console.log(`⏭ Sweep SHORT omitido — bias_1d alcista (score:${bias1dSweep.score}) — mercado diario en contra (${symbol})`);
        return;
      }
      if (direction === 'LONG' && blockLongSw) {
        console.log(`⏭ Sweep LONG omitido — bias_1d bajista (score:${bias1dSweep.score}) — mercado diario en contra (${symbol})`);
        return;
      }
    }
    const mlDataSweep = { confidence: sweepConfidence, direction, mode: 'sweep', price, sweep_reason: reason, cvd_live: metrics.cvdLive, volume_multiplier: metrics.volumeMultiplier, whale_count: metrics.whaleCount, whale_buy_vol: (metrics.whaleBuyVol/1e6).toFixed(2), whale_sell_vol: (metrics.whaleSellVol/1e6).toFixed(2), liq_bonus: liqBonus, atr_5m: atr.toFixed(1), funding_rate: fundingSweep, oi_trend_15m: oiTrend15mSweep?.trend || 'flat', oi_delta_15m: oiTrend15mSweep?.deltaPct || '0', bias_4h: bias4hSweep?.bias || 'neutral', bias_4h_score: bias4hSweep?.score || 50, bias_1d: bias1dSweep?.bias || 'neutral', bias_1d_score: bias1dSweep?.score || 50, fib_level: fib15mSweep?.nearestRetrace?.label || null, fib_dist: fib15mSweep?.nearestRetrace?.dist || null, fib_signal: fib15mSweep?.retImpact?.signal || null, rsi_15m: null, timestamp: new Date().toISOString() };
    await supabase.from('paper_trades').insert({ symbol, direction, entry: price, tp1, tp2: isShort ? price - atr * 4 : price + atr * 4, sl, rr: `1:${rrVal.toFixed(1)}`, confidence: sweepConfidence, size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'), leverage: parseInt(process.env.PAPER_LEVERAGE || '10'), source: 'sweep', status: 'open', opened_at: new Date().toISOString(), market_data: mlDataSweep });
    console.log(`⚡ Sweep trade abierto: ${direction} ${symbol} @ $${price} R:R 1:${rrVal.toFixed(1)} conf:${sweepConfidence}%`);
    if (process.env.TELEGRAM_CHAT_ID) {
      const e = direction === 'SHORT' ? '▼' : '▲';
      const _dSw=new Date(), _limaSw=`🕐 Apertura: ${_dSw.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dSw.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
      const msg = `⚡ *Sweep Trade Abierto — ${symbol}*\n${e} ${direction} @ $${parseInt(price).toLocaleString()}\n🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}\n📐 R:R 1:${rrVal.toFixed(1)} | ${sweepConfidence}%\n⚡ ${reason}\n${_limaSw}\nFuente: 🌊 Sweep`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
    }
  } catch(e) { console.error('Sweep trade error:', e.message); }
}

// ── ORDER BOOK DINÁMICO ──────────────────────────────────────────
async function calcDynamicLiqZones(symbol, price) {
  try {
    const book = await fetchDeepOrderBook(symbol);
    if (!book?.bidClusters?.length && !book?.askClusters?.length) return null;
    const absThreshold = symbol.includes('BTC') ? 15000000 : symbol.includes('ETH') ? 8000000 : 3000000;
    const relMultiplier = 3.0;
    const zones = [];
    for (const cluster of book.bidClusters) {
      const usdVal = cluster.usdVal, distPct = Math.abs(price - cluster.price) / price * 100;
      if (distPct > 2.0 || usdVal < absThreshold || cluster.strength < relMultiplier) continue;
      const bonus = usdVal > absThreshold * 3 ? 20 : usdVal > absThreshold * 1.5 ? 12 : 6;
      zones.push({ price: cluster.price, side: 'bid', usdVal, distPct, bonus, strength: cluster.strength });
    }
    for (const cluster of book.askClusters) {
      const usdVal = cluster.usdVal, distPct = Math.abs(price - cluster.price) / price * 100;
      if (distPct > 2.0 || usdVal < absThreshold || cluster.strength < relMultiplier) continue;
      const bonus = usdVal > absThreshold * 3 ? 20 : usdVal > absThreshold * 1.5 ? 12 : 6;
      zones.push({ price: cluster.price, side: 'ask', usdVal, distPct, bonus, strength: cluster.strength });
    }
    return zones.length ? zones : null;
  } catch(e) { return null; }
}

function calcLiqZoneBonus(symbol, price) {
  if (!price) return 0;
  const zones = [{ dist: -0.018, size: 240 }, { dist: -0.025, size: 380 }, { dist: -0.042, size: 490 }, { dist: -0.055, size: 620 }, { dist: -0.075, size: 830 }, { dist: 0.015, size: 210 }, { dist: 0.028, size: 320 }, { dist: 0.045, size: 480 }, { dist: 0.068, size: 740 }, { dist: 0.095, size: 950 }];
  let maxBonus = 0;
  for (const z of zones) {
    const zonePrice = price * (1 + z.dist), distPct = Math.abs(price - zonePrice) / price * 100;
    if (distPct < 1.0) { const bonus = z.size > 700 ? 20 : z.size > 500 ? 15 : z.size > 300 ? 10 : 5; if (bonus > maxBonus) maxBonus = bonus; }
  }
  return maxBonus;
}

function applyLiqZoneProbBonus(divergences, price) {
  if (!price || !divergences.length) return divergences;
  const zones = [{ dist: -0.018, size: 240, direction: 'down' }, { dist: -0.025, size: 380, direction: 'down' }, { dist: -0.042, size: 490, direction: 'down' }, { dist: -0.055, size: 620, direction: 'down' }, { dist: -0.075, size: 830, direction: 'down' }, { dist: 0.015, size: 210, direction: 'up' }, { dist: 0.028, size: 320, direction: 'up' }, { dist: 0.045, size: 480, direction: 'up' }, { dist: 0.068, size: 740, direction: 'up' }, { dist: 0.095, size: 950, direction: 'up' }];
  return divergences.map(d => {
    let liqBonus = 0;
    for (const z of zones) {
      const zonePrice = price * (1 + z.dist), distPct = Math.abs(price - zonePrice) / price * 100;
      if (distPct < 1.5) {
        const liqDirection = z.dist < 0 ? 'SHORT' : 'LONG';
        if (d.direction === liqDirection) { const bonus = z.size > 700 ? 12 : z.size > 500 ? 8 : z.size > 300 ? 5 : 3; liqBonus = Math.max(liqBonus, bonus); }
      }
    }
    if (liqBonus > 0) return { ...d, probability: Math.min(95, d.probability + liqBonus), confluence: [...(d.confluence || []), `🧲 Imán liq +${liqBonus}%`] };
    return d;
  });
}

app.get('/api/ws/status', (req, res) => {
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT,ETHUSDT').split(',');
  const status = {};
  for (const sym of symbols) {
    const metrics = getWsMetrics(sym.trim());
    // Si metrics es null pero WS conectado → devolver defaults para que el vol se muestre
    const metricsOut = metrics
      ? { cvdLive: metrics.cvdLive?.toFixed(1), volumeMultiplier: metrics.volumeMultiplier?.toFixed(2), whaleCount: metrics.whaleCount, anomaly: metrics.anomaly }
      : wsConnections[sym.trim()] ? { cvdLive: '0.0', volumeMultiplier: '1.00', whaleCount: 0, anomaly: null } : null;
    status[sym.trim()] = { connected: !!wsConnections[sym.trim()], lastUpdate: wsState[sym.trim()]?.lastUpdate || 0, lastPrice: wsState[sym.trim()]?.lastPrice || 0, metrics: metricsOut };
  }
  res.json(status);
});

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff); }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) { avgGain = (avgGain*(period-1)+diff)/period; avgLoss = (avgLoss*(period-1))/period; } else { avgGain = (avgGain*(period-1))/period; avgLoss = (avgLoss*(period-1)+Math.abs(diff))/period; } }
  return Math.round(100 - 100 / (1 + avgGain/(avgLoss||0.001)));
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period), sma = slice.reduce((a,b) => a+b,0)/period;
  const std = Math.sqrt(slice.reduce((s,v) => s+Math.pow(v-sma,2),0)/period);
  return { upper: sma+mult*std, middle: sma, lower: sma-mult*std };
}

function calcVWAP(klines) {
  let cumTPV = 0, cumVol = 0;
  klines.forEach(k => { const tp=(parseFloat(k[2])+parseFloat(k[3])+parseFloat(k[4]))/3, vol=parseFloat(k[5]); cumTPV+=tp*vol; cumVol+=vol; });
  return cumVol > 0 ? cumTPV/cumVol : 0;
}

function calcCVD(klines) {
  let cumulative = 0;
  const deltas = klines.map(k => { const open=parseFloat(k[1]),close=parseFloat(k[4]),vol=parseFloat(k[5]); const buyRatio = close>open?1:close<open?0:0.5; const delta = vol*buyRatio - vol*(1-buyRatio); cumulative += delta; return { delta, cumulative, vol }; });
  const last5 = deltas.slice(-5), delta5 = last5.reduce((s,d)=>s+d.delta,0), delta3 = deltas.slice(-3).reduce((s,d)=>s+d.delta,0);
  const prevCum = deltas[deltas.length-6]?.cumulative||0;
  const cvdPct = prevCum!==0?((cumulative-prevCum)/Math.abs(prevCum)*100).toFixed(2):'0.00';
  const avgVol = deltas.slice(-20).reduce((s,d)=>s+d.vol,0)/20, lastVol = deltas[deltas.length-1]?.vol||0;
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
  const vah=vah70.length?Math.max(...vah70):poc, val=val70.length?Math.min(...val70):poc;
  return { poc, vah:Math.max(vah,poc), val:Math.min(val,poc) };
}

async function fetchOIHistory(symbol, interval, limit=10) {
  try { const res = await axios.get(`${BINANCE}/futures/data/openInterestHist?symbol=${symbol}&period=${interval}&limit=${limit}`); return res.data||[]; } catch(e){ return []; }
}

function calcOITrend(oiHistory) {
  if(!oiHistory||oiHistory.length<2) return { trend:'flat', deltaPct:'0.000', current:0 };
  const first=parseFloat(oiHistory[0]?.sumOpenInterest||0), last=parseFloat(oiHistory[oiHistory.length-1]?.sumOpenInterest||0);
  const deltaPct=first>0?((last-first)/first*100).toFixed(3):'0.000';
  const trend=parseFloat(deltaPct)>0.1?'rising':parseFloat(deltaPct)<-0.1?'falling':'flat';
  return { trend, deltaPct, current:last };
}

function calcBias(klines, oiData=null, fundingRate=0) {
  if(!klines||!Array.isArray(klines)||klines.length<20) return { bias:'neutral', score:50, rsi:50, cvdPct:0, volPct:0, oiTrend:'flat', oiDeltaPct:'0.000', fundingRate:0 };
  const closes=klines.map(k=>parseFloat(k[4])), highs=klines.map(k=>parseFloat(k[2])), lows=klines.map(k=>parseFloat(k[3]));
  const rsi=calcRSI(closes), cvd=calcCVD(klines), vwap=calcVWAP(klines);
  const last=closes[closes.length-1], prev5avg=closes.slice(-6,-1).reduce((a,b)=>a+b,0)/5;
  const priceVsPrev=prev5avg>0?((last-prev5avg)/prev5avg*100):0;
  const recentHighs=highs.slice(-5), recentLows=lows.slice(-5);
  const hhCount=recentHighs.filter((h,i)=>i>0&&h>recentHighs[i-1]).length, llCount=recentLows.filter((l,i)=>i>0&&l<recentLows[i-1]).length;
  const aboveVwap=last>vwap, oiTrend=oiData?calcOITrend(oiData):{trend:'flat',deltaPct:'0.000',current:0};
  let score=50;
  if(priceVsPrev>0.3) score+=12; else if(priceVsPrev<-0.3) score-=12;
  if(hhCount>=3) score+=10; if(llCount>=3) score-=10;
  if(rsi>70) score-=25; else if(rsi>60) score+=8; else if(rsi<30) score+=25; else if(rsi<40) score-=8;
  const cvdExtreme = Math.abs(cvd.cvdPct) > 15;
  if(cvd.delta5>0) score += cvdExtreme ? 15 : 10; else score -= cvdExtreme ? 15 : 10;
  if(aboveVwap) score+=5; else score-=5;
  if(oiTrend.trend==='rising'&&priceVsPrev>0) score+=8; if(oiTrend.trend==='rising'&&priceVsPrev<0) score-=8;
  if(oiTrend.trend==='falling'&&priceVsPrev<0) score-=5; if(oiTrend.trend==='falling'&&priceVsPrev>0) score+=3;
  if(fundingRate>0.001) score-=5; if(fundingRate<-0.001) score+=5;
  score=Math.min(95,Math.max(5,Math.round(score)));
  return { bias: score>60?'long':score<40?'short':'neutral', score, rsi, cvdPct:cvd.cvdPct, volPct:cvd.volPct, aboveVwap, vwap:vwap.toFixed(1), priceVsPrev: parseFloat(priceVsPrev.toFixed(2)), oiTrend:oiTrend.trend, oiDeltaPct:oiTrend.deltaPct, oiCurrent:oiTrend.current, fundingRate, frBias:fundingRate>0.001?'longs_hot':fundingRate<-0.001?'shorts_hot':'neutral' };
}

function analyzeOB(bids,asks) {
  if(!bids?.length||!asks?.length) return {};
  const bidVol=bids.slice(0,10).reduce((s,b)=>s+parseFloat(b[1]),0), askVol=asks.slice(0,10).reduce((s,a)=>s+parseFloat(a[1]),0);
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

function calcRealLiqMagnets(price, liqData) {
  if (!liqData?.zones?.length) return calcLiqMagnets(price);
  const realZones = liqData.zones.filter(z => z.total >= 50).map(z => { const dist = ((z.price - price) / price * 100), direction = z.price > price ? 'up' : 'down'; const sizeM = Math.round(z.total / 1000 * 10) / 10; const label = z.dominant === 'longs' ? (direction === 'down' ? 'Stop longs reales' : 'Zona longs reales') : (direction === 'up' ? 'Stop shorts reales' : 'Zona shorts reales'); return { price: z.price, size: Math.max(sizeM, 10), label, dist: Math.abs(dist).toFixed(1), direction, isMajor: z.total >= 500, isReal: true, dominant: z.dominant }; }).filter(z => Math.abs(parseFloat(z.dist)) <= 10).sort((a,b) => Math.abs(parseFloat(a.dist)) - Math.abs(parseFloat(b.dist))).slice(0, 15);
  if (realZones.length >= 5) return realZones;
  const staticZones = calcLiqMagnets(price);
  const realPrices = new Set(realZones.map(z => Math.round(z.price / 100) * 100));
  const filteredStatic = staticZones.filter(z => !realPrices.has(Math.round(z.price / 100) * 100));
  return [...realZones, ...filteredStatic].sort((a,b) => Math.abs(parseFloat(a.dist)) - Math.abs(parseFloat(b.dist))).slice(0, 12);
}

function calcFibonacci(klines, price) {
  if (!klines || klines.length < 20) return null;
  const highs = klines.map(k => parseFloat(k[2])), lows = klines.map(k => parseFloat(k[3]));
  const n = klines.length;
  let swingHigh = -Infinity, swingLow = Infinity, swingHighIdx = 0, swingLowIdx = 0;
  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) { if (highs[i] > swingHigh) { swingHigh = highs[i]; swingHighIdx = i; } }
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) { if (lows[i] < swingLow) { swingLow = lows[i]; swingLowIdx = i; } }
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
    // Penalización aumentada (12→20, 6→15) — extensiones contrarias causaban WR 39.3%
    if (!isRetracement && nearest.isKey) return { bonus: 0, penalty: isVeryClose ? 20 : 15, signal: isUptrend ? 'short_exhaustion' : 'long_exhaustion', description: `Precio en extensión Fib ${nearest.label} — zona de agotamiento` };
    // Niveles no clave (23.6%, 78.6%) no suman bonus — WR 39.3% indicó inflación de señales débiles
    return { bonus: 0, penalty: 0, signal: 'none', description: '' };
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
  const highs=klines15m.map(k=>parseFloat(k[2])), lows=klines15m.map(k=>parseFloat(k[3])), volumes=klines15m.map(k=>parseFloat(k[5]));
  const cvd=calcCVD(klines15m), vwap=calcVWAP(klines15m);
  const rsiValues=[];
  for(let i=15;i<closes.length;i++) rsiValues.push(calcRSI(closes.slice(0,i+1)));
  const lastRSI=rsiValues[rsiValues.length-1], prevRSI=rsiValues[rsiValues.length-4], prevRSI8=rsiValues[rsiValues.length-8]||prevRSI;
  const lastHigh=Math.max(...highs.slice(-3)),prevHigh=Math.max(...highs.slice(-8,-3)),prevHigh2=Math.max(...highs.slice(-14,-8));
  const lastLow=Math.min(...lows.slice(-3)),prevLow=Math.min(...lows.slice(-8,-3)),prevLow2=Math.min(...lows.slice(-14,-8));
  const lastClose=closes[closes.length-1], prevClose5=closes.length>=6?closes[closes.length-6]:closes[0]||0, prevClose10=closes.length>=11?closes[closes.length-11]:closes[0]||0;
  const priceUp=lastClose>prevClose5, priceDown=lastClose<prevClose5, priceUp10=lastClose>prevClose10, priceDown10=lastClose<prevClose10;
  const cvdFalling=cvd.delta5<0, cvdRising=cvd.delta5>0, cvdAgressive=Math.abs(cvd.cvdPct)>5;
  const avgVol=volumes.slice(-20).reduce((a,b)=>a+b,0)/20, lastVol=volumes[volumes.length-1];
  const volClimaxUp=lastVol>avgVol*2.5&&priceUp, volClimaxDown=lastVol>avgVol*2.5&&priceDown;
  const trend4h=bias4h?.bias||'neutral', trend1d=bias1d?.bias||'neutral';
  const bearishContext=trend4h==='short'||trend1d==='short', bullishContext=trend4h==='long'||trend1d==='long';
  const oiRising=oiTrend15m?.trend==='rising', oiFalling=oiTrend15m?.trend==='falling';
  const aboveVwap=lastClose>vwap, belowVwap=lastClose<vwap;
  const hasBidWall=(ob.bidWalls?.length||0)>0, hasAskWall=(ob.askWalls?.length||0)>0;
  const wsAnomaly = wsState[Object.keys(wsState).find(k => k.startsWith(price > 10000 ? 'BTC' : 'ETH'))]?.anomaly;
  const wsAnomalyBonus = (dir) => {
    if (!wsAnomaly || Date.now() - wsAnomaly.time > 5 * 60 * 1000) return 0;
    if (wsAnomaly.isSweep) return wsAnomaly.direction === dir ? 10 : -8;
    if (wsAnomaly.isWhale) return wsAnomaly.direction === dir ? 5 : -5;
    return 0;
  };

  if(priceUp&&cvdRising&&cvdAgressive){
    let prob=65; if(hasAskWall) prob+=10; if(oiFalling) prob+=8; if(lastRSI>65) prob+=7; if(lastRSI>75) prob+=8;
    if(bearishContext) prob+=8; if(aboveVwap) prob+=5; if(volClimaxUp) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('SHORT');
    const hasRealSweep = wsAnomalyBonus('SHORT') > 0;
    if (!hasRealSweep) prob = Math.min(82, prob);
    divergences.push({ type:'absorcion_compras', name:'Absorción de Compras', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`CVD +${cvd.cvdPct}% agresivo con muro vendedor — precio se agotará.${bearishContext?' 4H/1D bajista.':''}${!hasRealSweep?' (sin barrida confirmada)':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',hasAskWall&&'Muro ask',oiFalling&&'OI cayendo',bearishContext&&'Contexto bajista',hasRealSweep&&'⚡ Barrida WS confirmada'].filter(Boolean) });
  }
  if(priceDown&&cvdFalling&&cvdAgressive){
    let prob=65; if(hasBidWall) prob+=8; if(lastRSI<35) prob+=10; if(lastRSI<25) prob+=8;
    if(bullishContext) prob+=8; if(belowVwap) prob+=5; if(oiFalling) prob+=5; if(volClimaxDown) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    prob += wsAnomalyBonus('LONG');
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
  const divsWithLiq = applyLiqZoneProbBonus(divergences, price);
  return divsWithLiq.sort((a,b)=>b.probability-a.probability);
  } catch(e) { console.error('detectDivergences error:', e.message); return []; }
}

function calcCombinedSignal(divergences, bias4h, bias1d, whaleData=null, deepOB=null, fib=null, bias1h=null) {
  const absorcionCount = divergences.filter(d => d.type === 'absorcion_compras' || d.type === 'absorcion_ventas').length;
  if(!divergences.length) return { direction:'ESPERAR', probability:30, action:'ESPERAR', reason:'Sin divergencias activas' };
  const shorts=divergences.filter(d=>d.direction==='SHORT'), longs=divergences.filter(d=>d.direction==='LONG');
  const shortScore=shorts.reduce((s,d)=>s+d.probability,0)/(shorts.length||1), longScore=longs.reduce((s,d)=>s+d.probability,0)/(longs.length||1);
  let direction=shorts.length>longs.length?'SHORT':longs.length>shorts.length?'LONG':'ESPERAR';
  let prob=direction==='SHORT'?shortScore:direction==='LONG'?longScore:30;
  const regimeLong = divergences.find(d => d.type === 'regime_change_long'), regimeShort = divergences.find(d => d.type === 'regime_change_short');
  if (regimeLong && direction === 'SHORT') { prob = Math.max(5, prob - 30); if (regimeLong.probability >= 80) prob = 5; }
  if (regimeShort && direction === 'LONG') { prob = Math.max(5, prob - 30); if (regimeShort.probability >= 80) prob = 5; }
  const both4hAnd1dLong = bias4h?.bias==='long' && bias1d?.bias==='long', both4hAnd1dShort = bias4h?.bias==='short' && bias1d?.bias==='short';
  const only4hLong = bias4h?.bias==='long' && bias1d?.bias!=='short', only4hShort = bias4h?.bias==='short' && bias1d?.bias!=='long';
  if(direction==='LONG'){
    if(both4hAnd1dLong) prob=Math.min(95,prob+15); else if(only4hLong) prob=Math.min(95,prob+8);
    if(bias1d?.bias==='short') prob=Math.max(5,prob-10);
    if(bias1h?.bias==='short') prob=Math.max(5,prob-12);
  }
  if(direction==='SHORT'){
    if(both4hAnd1dShort) prob=Math.min(95,prob+15); else if(only4hShort) prob=Math.min(95,prob+8);
    if(bias1d?.bias==='long') prob=Math.max(5,prob-10);
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
    // Bloquear si extensión contraria MUY cercana (<0.3%) — agotamiento inminente
    // Fix WR 39.3%: señales llegaban al umbral pero perdían por estar en zona de agotamiento Fib
    if (fib.nearestExt && fib.nearestExt.dist < 0.3) {
      if (direction === 'LONG' && fib.extImpact.signal === 'long_exhaustion') {
        prob = Math.min(prob, 60);
        console.log('⬟ Fib block LONG — extensión agotamiento cercana dist:' + fib.nearestExt.dist + '%');
      }
      if (direction === 'SHORT' && fib.extImpact.signal === 'short_exhaustion') {
        prob = Math.min(prob, 60);
        console.log('⬟ Fib block SHORT — extensión agotamiento cercana dist:' + fib.nearestExt.dist + '%');
      }
    }
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
    const orders = res.data || [], bucketSize = symbol.includes('BTC') ? 100 : symbol.includes('ETH') ? 10 : 1;
    const buckets = {}; let totalLongs = 0, totalShorts = 0;
    orders.forEach(o => { const price = parseFloat(o.averagePrice || o.price), qty = parseFloat(o.executedQty || o.origQty), usdVal = price * qty, bucket = Math.round(price / bucketSize) * bucketSize; if (!buckets[bucket]) buckets[bucket] = { price: bucket, longLiq: 0, shortLiq: 0, total: 0 }; if (o.side === 'SELL') { buckets[bucket].longLiq += usdVal; totalLongs += usdVal; } else { buckets[bucket].shortLiq += usdVal; totalShorts += usdVal; } buckets[bucket].total += usdVal; });
    const zones = Object.values(buckets).filter(b => b.total > 10000).sort((a, b) => b.total - a.total).slice(0, 20).map(b => ({ price: b.price, longLiq: Math.round(b.longLiq / 1000), shortLiq: Math.round(b.shortLiq / 1000), total: Math.round(b.total / 1000), dominant: b.longLiq > b.shortLiq ? 'longs' : 'shorts' }));
    return { zones, totalLongs: Math.round(totalLongs/1000), totalShorts: Math.round(totalShorts/1000), count: orders.length };
  } catch(e) { return { zones: [], totalLongs: 0, totalShorts: 0, count: 0 }; }
}

async function fetchDeepOrderBook(symbol) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=500`);
    const bids = res.data.bids || [], asks = res.data.asks || [], bucketSize = symbol.includes('BTC') ? 50 : symbol.includes('ETH') ? 5 : 0.5;
    function clusterSide(orders, side) {
      const buckets = {};
      orders.forEach(([priceStr, qtyStr]) => { const price = parseFloat(priceStr), qty = parseFloat(qtyStr), bucket = Math.round(price / bucketSize) * bucketSize; buckets[bucket] = (buckets[bucket] || 0) + qty; });
      const vals = Object.values(buckets), mean = vals.reduce((a,b)=>a+b,0) / vals.length;
      const std = Math.sqrt(vals.reduce((s,v)=>s+Math.pow(v-mean,2),0)/vals.length), threshold = mean + std * 1.2;
      return Object.entries(buckets).filter(([, qty]) => qty > threshold).map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty.toFixed(2)), usdVal: Math.round(parseFloat(price) * qty), side, strength: qty / mean, breakProb: Math.round(Math.min(85, Math.max(15, 100 - (qty/mean)*15))) })).sort((a, b) => b.qty - a.qty).slice(0, 8);
    }
    const bidClusters = clusterSide(bids, 'bid'), askClusters = clusterSide(asks, 'ask');
    const totalBidLiq = bids.reduce((s,[,q])=>s+parseFloat(q),0), totalAskLiq = asks.reduce((s,[,q])=>s+parseFloat(q),0);
    const deepImbalance = ((totalBidLiq - totalAskLiq) / (totalBidLiq + totalAskLiq) * 100).toFixed(1);
    return { bidClusters, askClusters, deepImbalance: parseFloat(deepImbalance), totalBidLiq: totalBidLiq.toFixed(1), totalAskLiq: totalAskLiq.toFixed(1) };
  } catch(e) { return { bidClusters: [], askClusters: [], deepImbalance: 0 }; }
}

async function detectWhales(symbol, price) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/aggTrades?symbol=${symbol}&limit=500`);
    const trades = res.data || [], whaleThreshold = symbol.includes('BTC') ? 10000000 : symbol.includes('ETH') ? 3000000 : 1000000;
    const whales = []; let whaleBuyVol = 0, whaleSellVol = 0, totalBuyVol = 0, totalSellVol = 0;
    trades.forEach(t => { const tradePrice = parseFloat(t.p), qty = parseFloat(t.q), usdVal = tradePrice * qty, isBuy = !t.m; if (isBuy) totalBuyVol += usdVal; else totalSellVol += usdVal; if (usdVal >= whaleThreshold) { whales.push({ price: tradePrice, qty: qty.toFixed(3), usdVal: Math.round(usdVal), side: isBuy ? 'buy' : 'sell', time: t.T, isAggressive: true }); if (isBuy) whaleBuyVol += usdVal; else whaleSellVol += usdVal; } });
    const whaleCVD = whaleBuyVol - whaleSellVol, whaleBias = whaleCVD > 0 ? 'bull' : whaleCVD < 0 ? 'bear' : 'neutral';
    const whaleRatio = (whaleBuyVol + whaleSellVol) / (totalBuyVol + totalSellVol + 1) * 100;
    return { whales: whales.slice(-10), whaleBuyVol: Math.round(whaleBuyVol / 1000), whaleSellVol: Math.round(whaleSellVol / 1000), whaleCVD: Math.round(whaleCVD / 1000), whaleBias, whaleCount: whales.length, whaleRatio: parseFloat(whaleRatio.toFixed(1)), lastWhale: whales[whales.length - 1] || null, dominance: whaleBuyVol > whaleSellVol * 1.5 ? 'buyers' : whaleSellVol > whaleBuyVol * 1.5 ? 'sellers' : 'balanced' };
  } catch(e) { return { whales: [], whaleBuyVol: 0, whaleSellVol: 0, whaleCVD: 0, whaleBias: 'neutral', whaleCount: 0 }; }
}

app.get('/api/market/:symbol', async (req, res) => {
  try {
    const symbol=req.params.symbol||'BTCUSDT';
    const [ticker,oiRes,funding,k15m,k1h,k4h,k1d,obRes,oi15mHist,oi1hHist,oi4hHist] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`), axios.get(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`), axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`), axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=60`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`), axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=20`),
      fetchOIHistory(symbol,'15m',10), fetchOIHistory(symbol,'1h',10), fetchOIHistory(symbol,'4h',10),
    ]);
    const price_temp = parseFloat(ticker.data.lastPrice);
    const [liqData, deepOB, whaleData] = await Promise.all([fetchBestLiqData(symbol, price_temp), fetchDeepOrderBook(symbol), detectWhales(symbol, price_temp)]);
    const price=parseFloat(ticker.data.lastPrice), fundingRate=parseFloat(funding.data.lastFundingRate);
    if(!k15m.data||!Array.isArray(k15m.data)||k15m.data.length<20) throw new Error('Insufficient kline data');
    const closes15m=k15m.data.map(k=>parseFloat(k[4])), cvd15m=calcCVD(k15m.data), vrvp=calcVRVP(k15m.data), bb15m=calcBB(closes15m), vwap15m=calcVWAP(k15m.data), rsi15m=calcRSI(closes15m);
    const ob=analyzeOB(obRes.data.bids,obRes.data.asks), liqMagnets=calcRealLiqMagnets(price, liqData);
    const oiTrend15m=calcOITrend(oi15mHist), oiTrend1h=calcOITrend(oi1hHist), oiTrend4h=calcOITrend(oi4hHist);
    const bias15m=calcBias(k15m.data,oi15mHist,fundingRate), bias1h=calcBias(k1h.data,oi1hHist,fundingRate), bias4h=calcBias(k4h.data,oi4hHist,fundingRate), bias1d=calcBias(k1d.data,null,fundingRate);
    const fib15m = calcFibonacci(k15m.data, price), fib4h = calcFibonacci(k4h.data, price);
    const divergences=detectDivergences(k15m.data,ob,price,fundingRate,bias4h,bias1d,oiTrend15m,fib15m);
    const doublePatterns=detectDoublePatterns(k15m.data,price), allDivs=[...divergences,...doublePatterns];
    const combinedSignal=calcCombinedSignal(allDivs,bias4h,bias1d,whaleData,deepOB,fib15m,bias1h);
    const scalpSignal=calcScalpSignal(allDivs,calcBias(k15m.data,oi15mHist,fundingRate),calcBias(k1h.data,oi1hHist,fundingRate),bias4h);
    const vols=k15m.data.slice(-5).map(k=>parseFloat(k[5])), avgVol5=vols.slice(0,-1).reduce((a,b)=>a+b,0)/4, lastVol=vols[vols.length-1];
    const volDeltaPct=avgVol5>0?((lastVol-avgVol5)/avgVol5*100).toFixed(1):'0.0';
    const wsMetrics = getWsMetrics(symbol);
    res.json({ price, change24h:parseFloat(ticker.data.priceChangePercent), volume24h:parseFloat(ticker.data.quoteVolume), openInterest:parseFloat(oiRes.data.openInterest), fundingRate, markPrice:parseFloat(funding.data.markPrice), indexPrice:parseFloat(funding.data.indexPrice), rsi15m, rsiOverbought:rsi15m>70, rsiOversold:rsi15m<30, cvd15m, vrvp, bb15m, vwap15m:vwap15m.toFixed(1), oiTrends:{ tf15m:oiTrend15m, tf1h:oiTrend1h, tf4h:oiTrend4h }, volDeltaPct:parseFloat(volDeltaPct), orderBook:ob, liqMagnets, divergences:allDivs, combinedSignal, scalpSignal, doublePatterns, bias:{ tf15m:bias15m, tf1h:bias1h, tf4h:bias4h, tf1d:bias1d }, klines:k15m.data.slice(-20), liqData, deepOB, whaleData, fibonacci:{ tf15m:fib15m, tf4h:fib4h }, wsMetrics });
  } catch(e) { console.error('Market error:',e.message); res.status(500).json({ error:e.message }); }
});

app.post('/api/analyze', async (req, res) => {
  // DESACTIVADO — Anthropic API no necesaria en sweep-only mode
  return res.json({ direction: 'ESPERAR', confidence: 0, action: 'DESACTIVADO', reasoning: 'Análisis IA desactivado — modo sweep-only.' });
  /* eslint-disable no-unreachable */
  // try {
  //   const { marketData:d, symbol } = req.body;
  //   const now=Date.now();
  //   if(analyzeCache[symbol]&&now-analyzeCache[symbol].ts<60000) return res.json(analyzeCache[symbol].data);
  //   const strongDivs2 = (d.divergences||[]).filter(dv => dv.probability >= 90);
  //   const _shortCount = (d.divergences||[]).filter(dv => dv.direction === 'SHORT' && dv.probability >= 90).length;
  //   const _longCount  = (d.divergences||[]).filter(dv => dv.direction === 'LONG'  && dv.probability >= 90).length;
  //   const _domCount = Math.max(_shortCount, _longCount), _oppCount = Math.min(_shortCount, _longCount);
  //   const _hasMajority = _domCount >= 2 && _domCount > _oppCount * 1.5, _hasAny = _domCount >= 1 && _oppCount === 0;
  //   if (!_hasMajority && !_hasAny && d.combinedSignal?.direction === 'ESPERAR') {
  //     return res.json({ direction:'ESPERAR', confidence:30, action:'NO ENTRAR', reasoning:'Señales divididas — sin ventaja clara en ninguna dirección.', entry:d.price, tp1:d.price, tp2:d.price, sl:d.price, rr:'1:0' });
  //   }
  //   const divSummary = strongDivs2.length ? strongDivs2.slice(0,4).map(dv=>`${dv.name}: ${dv.direction} ${dv.probability}% — ${dv.description}`).join('\n') : (d.divergences||[]).slice(0,2).map(dv=>`${dv.name}: ${dv.direction} ${dv.probability}% — ${dv.description}`).join('\n') || 'Ninguna';
  //   const b=d.bias;
  //   const wsM = getWsMetrics(symbol);
  //   const wsNote = wsM && Math.abs(wsM.cvdLive) > 20 ? `\nWS TIEMPO REAL: CVD=${wsM.cvdLive.toFixed(1)}% vol=${wsM.volumeMultiplier.toFixed(1)}x ballenas=${wsM.whaleCount}` : '';
  //   const prompt=`...`;
  //   const response=await anthropic.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:600, messages:[{role:'user',content:prompt}] });
  //   const text=response.content[0].text;
  //   const signal=JSON.parse(text.replace(/```json|```/g,'').trim());
  //   analyzeCache[symbol]={ ts:now, data:signal };
  //   res.json(signal);
  // } catch(e) { console.error('Analyze error:',e.message); res.status(500).json({ error:e.message }); }
  /* eslint-enable no-unreachable */
});

app.post('/api/trades', async (req, res) => { try { const {data,error}=await supabase.from('trades').insert(req.body); if(error) throw error; res.json({success:true,data}); } catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/trades', async (req, res) => { try { const {data,error}=await supabase.from('trades').select('*').order('created_at',{ascending:false}).limit(50); if(error) throw error; res.json(data); } catch(e){ res.status(500).json({error:e.message}); } });

let alertCache = {};
const signalHistory = {};

function confirmSignal(symbol, direction, probability) {
  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  const now = Date.now(), minConf = parseInt(process.env.ALERT_MIN_CONFIDENCE || '90');
  if (probability < minConf) return { confirmed: false, count: 0 };
  const history = signalHistory[symbol];
  history.push({ direction, probability, timestamp: now });
  signalHistory[symbol] = history.filter(s => now - s.timestamp < 45 * 60 * 1000).slice(-3);
  const recent = signalHistory[symbol], sameDirection = recent.filter(s => s.direction === direction && now - s.timestamp < 30 * 60 * 1000);
  if (sameDirection.length < 2) return { confirmed: false, count: sameDirection.length };
  if (probability >= 92 && sameDirection.length >= 1) return { confirmed: true, count: sameDirection.length, avgProbability: probability };
  const avgProb = Math.round(sameDirection.reduce((s,r) => s + r.probability, 0) / sameDirection.length);
  return { confirmed: true, count: sameDirection.length, avgProbability: avgProb };
}

function clearSignalHistory(symbol) { signalHistory[symbol] = []; }

const analysisInProgress = {};
async function runAutoAnalysis(symbol = 'BTCUSDT', force = false) {
  if (analysisInProgress[symbol] && !force) { console.log(`⏭ Análisis ${symbol} ya en curso — omitiendo`); return; }
  // ── Filtro horario auto v4.4.75 — bloquear madrugada/noche Lima sin tapar NY ──
  if (!force) {
    const _horaLimaAuto = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getHours();
    if ([0, 1, 2, 22, 23].includes(_horaLimaAuto)) {
      console.log(`💤 Auto análisis bloqueado — hora ${_horaLimaAuto}h Lima`);
      return;
    }
  }
  analysisInProgress[symbol] = true;
  try {
    await new Promise(r => setTimeout(r, 1000));
    const price_temp_res = await axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`);
    const price_temp = parseFloat(price_temp_res.data.lastPrice);
    const [oiRes,funding,k15m,k1h] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`), axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`), axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=60`),
    ]);
    await new Promise(r => setTimeout(r, 500));
    const [k4h,k1d,obRes,oi15mHist,oi1hHist,oi4hHist] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`), axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=20`),
      fetchOIHistory(symbol,'15m',10), fetchOIHistory(symbol,'1h',10), fetchOIHistory(symbol,'4h',10),
    ]);
    const ticker = price_temp_res;
    const [liqData, deepOB, whaleData] = await Promise.all([fetchBestLiqData(symbol, price_temp), fetchDeepOrderBook(symbol), detectWhales(symbol, price_temp)]);
    const price = parseFloat(ticker.data.lastPrice), fundingRate = parseFloat(funding.data.lastFundingRate);
    if (!k15m.data || !Array.isArray(k15m.data) || k15m.data.length < 20) return;
    const closes15m = k15m.data.map(k => parseFloat(k[4])), cvd15m = calcCVD(k15m.data), vrvp = calcVRVP(k15m.data);
    const ob = analyzeOB(obRes.data.bids, obRes.data.asks);
    const oiTrend15m = calcOITrend(oi15mHist), oiTrend1h = calcOITrend(oi1hHist), oiTrend4h = calcOITrend(oi4hHist);
    const bias15m = calcBias(k15m.data, oi15mHist, fundingRate);
    const bias1h  = calcBias(k1h.data?.length >= 20 ? k1h.data : k15m.data, oi1hHist, fundingRate);
    const bias4h  = calcBias(k4h.data?.length >= 20 ? k4h.data : k15m.data, oi4hHist, fundingRate);
    const bias1d  = calcBias(k1d.data?.length >= 20 ? k1d.data : k15m.data, null, fundingRate);
    const fib15m = calcFibonacci(k15m.data, price);
    const divergences = detectDivergences(k15m.data, ob, price, fundingRate, bias4h, bias1d, oiTrend15m, fib15m);
    const combinedSignal = calcCombinedSignal(divergences, bias4h, bias1d, whaleData, deepOB, fib15m, bias1h);
    const minConfidence = parseInt(process.env.ALERT_MIN_CONFIDENCE || '90'), minDivergences = parseInt(process.env.ALERT_MIN_DIVERGENCES || '2');
    if (combinedSignal.direction === 'ESPERAR') { clearSignalHistory(symbol); return; }
    if (combinedSignal.probability < minConfidence) return;
    if (divergences.length < minDivergences) return;
    const shortDivs = divergences.filter(d => d.direction === 'SHORT').length, longDivs = divergences.filter(d => d.direction === 'LONG').length;
    const hasClearMajority = combinedSignal.direction === 'SHORT' ? (shortDivs >= 2 && shortDivs > longDivs * 1.5) : (longDivs >= 2 && longDivs > shortDivs * 1.5);
    if (!hasClearMajority && !force) { console.log(`⏭ Auto-análisis omitido — señales divididas: ${shortDivs}S vs ${longDivs}L para ${symbol}`); clearSignalHistory(symbol); return; }
    if (!hasClearMajority && force) console.log(`⚡ Análisis forzado (campana) — señales divididas: ${shortDivs}S vs ${longDivs}L para ${symbol}`);
    const confirmation = confirmSignal(symbol, combinedSignal.direction, combinedSignal.probability);
    if (!confirmation.confirmed) return;
    const cacheKey = `${symbol}_${combinedSignal.direction}_${Math.floor(price / 100)}`;
    const now = Date.now();
    if (alertCache[cacheKey] && now - alertCache[cacheKey] < 45 * 60 * 1000 && !force) return;
    alertCache[cacheKey] = now;
    const marketData = { price, change24h: parseFloat(ticker.data.priceChangePercent), fundingRate, openInterest: parseFloat(oiRes.data.openInterest), rsi15m: calcRSI(closes15m), cvd15m, vrvp, volDeltaPct: 0, orderBook: ob, liqMagnets: calcLiqMagnets(price).slice(0,5), divergences: divergences.slice(0,4), combinedSignal, bias: { tf15m: bias15m, tf1h: bias1h, tf4h: bias4h, tf1d: bias1d } };
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
    if (_rrVal < 1.2 && signal.direction !== 'ESPERAR') { console.log(`⚠️ Alerta descartada — R:R ${_rrVal.toFixed(2)} < 1.2 para ${symbol}`); return; }
    if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) return;
    const dir = signal.direction, emoji = dir === 'LONG' ? '🟢' : dir === 'SHORT' ? '🔴' : '🟡';
    const fibNote = fib15m?.nearestRetrace?.dist < 0.8 ? `\n⬟ Fib ${fib15m.nearestRetrace.label} — ${fib15m.retImpact.description}` : '';
    const whaleNote = whaleData?.whaleCount >= 3 ? `\n🐋 Ballenas: ${whaleData.dominance} (${whaleData.whaleCount} trades)` : '';
    const wsM = getWsMetrics(symbol);
    const wsNote2 = wsM?.anomaly && Date.now() - wsM.anomaly.time < 5*60*1000 ? `\n⚡ WS: ${wsM.anomaly.reason}` : '';
    // ── Calcular size dinámico para mostrar en alerta v4.4.47 ──
    const _posAlrt = signal.direction !== 'ESPERAR' ? calcPositionSize(signal.entry, signal.sl, signal.direction, 'auto') : null;
    const msg = `${emoji} *${dir}* — ${symbol}\n━━━━━━━━━━━━━━\n💰 Entry: *$${signal.entry?.toLocaleString()}*\n🎯 TP1: $${signal.tp1?.toLocaleString()} | TP2: $${signal.tp2?.toLocaleString()}\n🛑 SL: $${signal.sl?.toLocaleString()} | ${signal.rr}\n━━━━━━━━━━━━━━\n📊 Confianza: *${signal.confidence}%* — ${signal.action}\n📈 ${combinedSignal.shortCount}S · ${combinedSignal.longCount}L activas\n💬 ${signal.reasoning}${signal.warning ? '\n⚠️ ' + signal.warning : ''}${fibNote}${whaleNote}${wsNote2}\n━━━━━━━━━━━━━━\n🕐 ${new Date().toLocaleTimeString('es-PE')}`;
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    console.log(`✅ Alerta enviada: ${dir} ${symbol} ${signal.confidence}%`);
    try { await supabase.from('signals').insert({ symbol, direction: signal.direction, confidence: signal.confidence, entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2, sl: signal.sl, rr: signal.rr, reasoning: signal.reasoning, market_data: marketData, source: 'auto_alert' }); } catch(_) {}
    const autoPaperThreshold = parseInt(process.env.AUTO_PAPER_THRESHOLD || '90'), trend1d = bias1d.bias;
    const trendOk = signal.direction === 'LONG' ? (trend1d !== 'short') : signal.direction === 'SHORT' ? (trend1d !== 'long') : false;
    // ── Bloquear auto con Score macro ≤ -3 ──
    const _macroScore = combinedSignal?.macroScore || 0;
    if (_macroScore <= -3) {
      console.log(`🚫 Auto trade bloqueado — Score macro ${_macroScore} ≤ -3 (mercado adverso)`);
      if (process.env.TELEGRAM_CHAT_ID) try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `🚫 Auto trade ${signal.direction} ${symbol} — *BLOQUEADO*\nRazón: Score macro ${_macroScore} ≤ -3 — mercado adverso\nConfianza era: ${signal.confidence}%\n🕐 ${new Date().toLocaleTimeString('es-PE')}`, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
      return;
    }
    const canAutoTrade = AUTO_TRADE_ENABLED && signal.confidence >= autoPaperThreshold && signal.direction !== 'ESPERAR' && trendOk && divergences.length >= 2 && _rrVal >= 1.2;
    if (canAutoTrade) {
      // ── Max pérdida check ──
      // ── Gestión de riesgo 2% para auto trade v4.4.47 ──
      const { sizeUsd: autoSizeUsd, leverage: autoLeverage, maxLossUsd: autoMaxLoss, effectiveSl: autoEffSl } = calcPositionSize(signal.entry, signal.sl, signal.direction, 'auto');
      console.log(`💰 Auto trade ${signal.direction} ${symbol} — size $${autoSizeUsd.toFixed(0)} lev ${autoLeverage}x riesgo $${autoMaxLoss?.toFixed(2)}`);
      try {
        const oppositeDir = signal.direction === 'LONG' ? 'SHORT' : 'LONG';
        const { data: oppTrades } = await supabase.from('paper_trades').select('*').eq('symbol', symbol).eq('status', 'open').eq('direction', oppositeDir);
        if (oppTrades?.length) {
          for (const oppTrade of oppTrades) {
            const currentPrice = wsState[symbol]?.lastPrice || signal.entry, entry = parseFloat(oppTrade.entry);
            const priceDiff = oppTrade.direction === 'LONG' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
            const _lev2 = parseFloat(oppTrade.leverage || 10);
            const pnl_usd = parseFloat((parseFloat(oppTrade.size_usd) * priceDiff * _lev2).toFixed(2));
            const pnl_pct = parseFloat((priceDiff * _lev2 * 100).toFixed(2));
            await supabase.from('paper_trades').update({ status: pnl_usd >= 0 ? 'won' : 'lost', close_price: currentPrice, close_reason: 'signal_reversal', pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', oppTrade.id);
            console.log(`🔄 Reversión de señal: cerrado ${oppTrade.direction} ${symbol} @ $${currentPrice}`);
            if (process.env.TELEGRAM_CHAT_ID) { const msg = `🔄 *Reversión de señal*\n${oppTrade.direction} ${symbol} cerrado\nEntry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentPrice).toLocaleString()}\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\nRazón: Nueva señal ${signal.direction} ${signal.confidence}%`; try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); } }
          }
        }
        const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
        if (!existing || existing.length === 0) {
          const mlSnapshot = { confidence: signal.confidence, direction: signal.direction, trend_aligned: trendOk, trend_1d: trend1d, rsi_15m: marketData.rsi15m, cvd_pct: cvd15m.cvdPct, cvd_trend: cvd15m.trend, funding_rate: fundingRate, oi_trend_15m: oiTrend15m.trend, oi_delta_15m: oiTrend15m.deltaPct, bias_15m: bias15m.bias, bias_15m_score: bias15m.score, bias_1h: bias1h.bias, bias_1h_score: bias1h.score, bias_4h: bias4h.bias, bias_4h_score: bias4h.score, bias_1d: bias1d.bias, bias_1d_score: bias1d.score, divergence_count: divergences.length, top_divergence: divergences[0]?.type, top_divergence_prob: divergences[0]?.probability, short_count: combinedSignal.shortCount, long_count: combinedSignal.longCount, fib_level: fib15m?.nearestRetrace?.label, fib_dist: fib15m?.nearestRetrace?.dist, fib_signal: fib15m?.retImpact?.signal, fib_bonus: fib15m?.retImpact?.bonus, whale_count: whaleData?.whaleCount, whale_bias: whaleData?.whaleBias, whale_dominance: whaleData?.dominance, whale_ratio: whaleData?.whaleRatio, deep_imbalance: deepOB?.deepImbalance, bid_clusters: deepOB?.bidClusters?.length, ask_clusters: deepOB?.askClusters?.length, price_vs_poc: ((marketData.price - vrvp.poc) / vrvp.poc * 100).toFixed(3), price: marketData.price, timestamp: new Date().toISOString() };
          await supabase.from('paper_trades').insert({ symbol, direction: signal.direction, entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2, sl: autoEffSl, rr: signal.rr, confidence: signal.confidence, size_usd: autoSizeUsd, leverage: autoLeverage, divergences: divergences.slice(0,5), fibonacci: fib15m, source: 'auto', status: 'open', opened_at: new Date().toISOString(), market_data: mlSnapshot }).select().single();
          console.log(`🤖 Auto paper trade: ${signal.direction} ${symbol} @ $${signal.entry}`);
          if (process.env.TELEGRAM_CHAT_ID) { const tradeEmoji = signal.direction === 'LONG' ? '▲' : '▼'; const _dA=new Date(), _limaA=`🕐 Apertura: ${_dA.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dA.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`; const autoMsg = `🤖 *Auto Paper Trade abierto*\n${tradeEmoji} ${signal.direction} ${symbol}\n💰 Entry: $${signal.entry?.toLocaleString()}\n🎯 TP: $${signal.tp1?.toLocaleString()} | 🛑 SL: $${signal.sl?.toLocaleString()}\n📊 ${signal.confidence}% confianza\n📐 ${signal.rr} R:R\n${_limaA}\nFuente: 🤖 Auto`; try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, autoMsg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); } }
        }
      } catch(paperErr) { console.error('Auto paper trade error:', paperErr.message); }
    }
  } catch(e) {
    console.error(`❌ Auto-analysis error ${symbol}:`, e.message, e.response?.status || '');
    if (e.response?.status === 429) { console.log(`⏳ Rate limit 429 — esperando 30s`); await new Promise(r => setTimeout(r, 30000)); }
    if (e.response?.status === 418) { console.log(`🚫 IP ban 418 — esperando 60s`); await new Promise(r => setTimeout(r, 60000)); }
  }
  finally { analysisInProgress[symbol] = false; }
}

function startAlertJob() {
  if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) {
    console.log('⚠️ Alertas Telegram desactivadas');
    setInterval(monitorPaperTrades, 1 * 60 * 1000);
    setTimeout(monitorPaperTrades, 15000);
    return;
  }

    // ── Mean Reversion scanner — cada 1 minuto
  setInterval(runMeanRevScanner, 60 * 1000);
  console.log('📈 Mean Reversion scanner iniciado — cada 1 min');

  setInterval(monitorPaperTrades, 1 * 60 * 1000);
  setTimeout(monitorPaperTrades, 15000);
  // DESACTIVADO — runAutoAnalysis usa Anthropic API, no necesario en sweep-only mode
  // const intervalMin = parseInt(process.env.ALERT_INTERVAL_MIN || '15'), symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  // console.log(`✅ Alertas activas — cada ${intervalMin} min para: ${symbols.join(', ')}`);
  // setInterval(async () => { for (const symbol of symbols) { await runAutoAnalysis(symbol.trim()); await new Promise(r => setTimeout(r, 8000)); } }, intervalMin * 60 * 1000);
  // setTimeout(async () => { for (const symbol of symbols) { await runAutoAnalysis(symbol.trim()); await new Promise(r => setTimeout(r, 8000)); } }, 15000);
  const wsSymbols = (process.env.WS_SYMBOLS || process.env.ALERT_SYMBOLS || 'BTCUSDT,ETHUSDT').split(',');
  wsSymbols.forEach(sym => { setTimeout(() => connectWebSocket(sym.trim()), 2000); });
  console.log(`🔌 WebSocket iniciando para: ${wsSymbols.join(', ')}`);
  setInterval(() => {
    for (const sym of wsSymbols) {
      const s = sym.trim();
      const state = wsState[s];
      if (!state || !wsConnections[s]) continue;
      const elapsed = Date.now() - (state.lastWsMsgTime || 0);
      if (elapsed > 60000) {
        console.log(`⚠️ WS watchdog: sin aggTrade ${(elapsed/1000)|0}s — reconectando ${s}`);
        state._reconnectDelay = Math.min(60000, (state._reconnectDelay || 5000) * 2);
        wsConnections[s].terminate();
        delete wsConnections[s];
        setTimeout(() => connectWebSocket(s), state._reconnectDelay);
      }
    }
  }, 30000);
  setInterval(() => {
    const threshold = parseInt(process.env.WS_VOLUME_MULTIPLIER || '4');
    for (const sym of wsSymbols) {
      const s = sym.trim();
      const metrics = getWsMetrics(s);
      if (!metrics) { console.log(`📊 Vol monitor ${s}: sin datos WS`); continue; }
      const fmtVol = v => v >= 1e6 ? `${(v/1e6).toFixed(2)}M` : v >= 1e3 ? `${(v/1e3).toFixed(1)}K` : v.toFixed(0);
      const pct = metrics.avgVolume1m > 0 ? (metrics.volumeMultiplier / threshold * 100).toFixed(0) : '?';
      console.log(`📊 Vol monitor ${s}: mult=${metrics.volumeMultiplier.toFixed(2)}x baseline=${fmtVol(metrics.avgVolume1m)} vol60s=${fmtVol(metrics.totalVol60s)} cvd=${metrics.cvdLive.toFixed(1)}% → ${pct}% del umbral ${threshold}x`);
    }
  }, 60 * 1000);
  const pollBaseline = async () => {
    for (const sym of wsSymbols) {
      try {
        // FUTURES klines — self-consistent con BINANCE_WS que ahora usa fstream.binance.com (futures)
        const k1m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${sym.trim()}&interval=1m&limit=10`);
        const vols = k1m.data.map(k => parseFloat(k[4]) * parseFloat(k[5]));
        const avg = vols.reduce((a,b)=>a+b,0)/vols.length;
        if (wsState[sym.trim()]) { wsState[sym.trim()].avgVolume1m = avg; }
      } catch(_) {}
    }
  };
  setTimeout(pollBaseline, 10000); // inicializar baseline 10s después de arrancar
  setInterval(pollBaseline, 5 * 60 * 1000);
}

// ── Caché REST para fallback cuando WS no tiene precio ──
const _priceCache = {};
async function _fetchRestPrice(symbol) {
  try {
    const r = await axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=${symbol}`, { timeout: 3000 });
    const p = parseFloat(r.data.price);
    if (p && !isNaN(p)) {
      _priceCache[symbol] = { price: p, ts: Date.now() };
      if (wsState[symbol]) { wsState[symbol].lastPrice = p; wsState[symbol].lastUpdate = Date.now(); }
      console.log(`📊 REST fallback precio ${symbol}: $${p}`);
    }
    return p;
  } catch(_) { return _priceCache[symbol]?.price || 0; }
}

app.get('/api/prices', async (req, res) => {
  const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const now = Date.now();
  const result = { XAUUSDT: wsState['XAUUSDT']?.lastPrice || 0 };
  await Promise.all(syms.map(async sym => {
    const st = wsState[sym];
    const fresh = st?.lastPrice && !isNaN(st.lastPrice) && (now - (st?.lastUpdate || 0)) < 30000;
    if (fresh) { result[sym] = st.lastPrice; return; }
    // WS sin precio o stale — intentar REST
    const cached = _priceCache[sym];
    if (cached && now - cached.ts < 10000) { result[sym] = cached.price; return; }
    result[sym] = await _fetchRestPrice(sym);
  }));
  res.json(result);
});

app.get('/api/ws-debug', (req, res) => {
  const now = Date.now();
  const debug = {};
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    const st = wsState[sym];
    debug[sym] = {
      lastPrice: st?.lastPrice || 0,
      lastUpdate: st?.lastUpdate ? Math.round((now - st.lastUpdate) / 1000) + 's ago' : 'never',
      firstMsg: st?._firstMsg || false,
      tradeCount: st?.trades?.length || 0,
      connected: !!wsConnections[sym],
    };
  }
  res.json(debug);
});

app.post('/api/alert/trigger', async (req, res) => {
  // DESACTIVADO — Anthropic API no necesaria en sweep-only mode
  res.json({ ok: false, message: 'runAutoAnalysis desactivado — modo sweep-only.' });
  // const symbol = req.body.symbol || 'BTCUSDT', force = req.body.force === true;
  // await runAutoAnalysis(symbol, force);
  // res.json({ ok: true, message: `Análisis disparado para ${symbol}${force?' (forzado)':''}` });
});

app.get('/api/alert/status', (req, res) => {
  res.json({ active: !!(process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN), intervalMin: parseInt(process.env.ALERT_INTERVAL_MIN || '15'), symbols: (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(','), minConfidence: parseInt(process.env.ALERT_MIN_CONFIDENCE || '90') });
});

app.post('/api/paper/open', async (req, res) => {
  try {
    const _openIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip;
    const { symbol, direction, entry, tp1, tp2, sl, rr, confidence, size_usd, leverage, divergences, fibonacci, source } = req.body;
    console.log(`📡 POST /api/paper/open — IP: ${_openIp} — ${direction || '?'} ${symbol || '?'} src=${source || 'manual'}`);
    if ((source || 'manual') !== 'sweep') {
      console.log(`⛔ Bloqueo trade no-sweep — source=${source || 'manual'} IP=${_openIp}`);
      return res.status(403).json({ error: 'Solo sweep puede abrir trades.' });
    }
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
    if (existing && existing.length > 0) return res.status(400).json({ error: `Ya hay un trade abierto para ${symbol}. Ciérralo antes de abrir otro.` });
    // ── Filtro confidence mínima 75% para trades manuales v4.4.49 ──
    const tradeSource = source || 'manual';
    if (tradeSource === 'manual' && confidence && parseFloat(confidence) < 75) {
      console.log(`⛔ Trade manual rechazado — confianza ${confidence}% < 75% mínimo`);
      return res.status(400).json({ error: `Confianza ${confidence}% insuficiente — mínimo 75% para ejecutar trades manuales` });
    }
    // ── Gestión de riesgo 2% — siempre calcular size, ignorar el del frontend v4.4.52 ──
    const mode = source || 'manual';
    const { sizeUsd: manualSizeUsd, leverage: manualLeverage, effectiveSl: manualEffSl } = sl && entry
      ? calcPositionSize(parseFloat(entry), parseFloat(sl), direction, mode)
      : { sizeUsd: CAPITAL_USD * RISK_PCT / 0.01, leverage: LEVERAGE_BY_MODE[mode] || 10, effectiveSl: parseFloat(sl) };
    console.log(`💰 Trade ${mode} ${direction} ${symbol} — size $${manualSizeUsd.toFixed(0)} lev ${manualLeverage}x (riesgo 2%)`);
    const { data, error } = await supabase.from('paper_trades').insert({ symbol, direction, entry, tp1, tp2, sl: manualEffSl, rr, confidence, size_usd: manualSizeUsd, leverage: manualLeverage, divergences, fibonacci, source: mode, status: 'open', opened_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    res.json({ ok: true, trade: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/paper/close/:id', async (req, res) => {
  try {
    const { id } = req.params, { close_price, close_reason } = req.body;
    const { data: trade, error: fetchErr } = await supabase.from('paper_trades').select('*').eq('id', id).single();
    if (fetchErr) throw fetchErr;
    const entry = parseFloat(trade.entry), closeP = parseFloat(close_price), size = parseFloat(trade.size_usd);
    const _lev3 = parseFloat(trade.leverage || 10);
    // Cancelar siempre registra pnl 0 y status cancelled
    if (close_reason === 'manual') {
      const { data, error } = await supabase.from('paper_trades').update({ status: 'cancelled', close_price: closeP, close_reason: 'manual', pnl_usd: 0, pnl_pct: 0, closed_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) throw error;
      return res.json({ ok: true, trade: data });
    }
    const priceDiff = trade.direction === 'LONG' ? (closeP - entry) / entry : (entry - closeP) / entry;
    const pnl_usd = parseFloat((size * priceDiff * _lev3).toFixed(2)), pnl_pct = parseFloat((priceDiff * _lev3 * 100).toFixed(2));
    const finalStatus = pnl_usd >= 0 ? 'won' : 'lost';
    const { data, error } = await supabase.from('paper_trades').update({ status: finalStatus, close_price: closeP, close_reason, pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, trade: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/open', async (req, res) => {
  try { const { data, error } = await supabase.from('paper_trades').select('*').eq('status', 'open').order('created_at', { ascending: false }); if (error) throw error; res.json(data); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/stats', async (req, res) => {
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from('paper_trades').select('*').in('status', ['won', 'lost']).gte('opened_at', since30d).order('opened_at', { ascending: false });
    if (error) throw error;
    const total = data.length, won = data.filter(t => t.status === 'won').length, lost = data.filter(t => t.status === 'lost').length;
    const winRate = total > 0 ? ((won / total) * 100).toFixed(1) : 0;
    const totalPnl = data.reduce((s, t) => s + (parseFloat(t.pnl_usd) || 0), 0);
    const avgWin = won > 0 ? data.filter(t=>t.status==='won').reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0) / won : 0;
    const avgLoss = lost > 0 ? Math.abs(data.filter(t=>t.status==='lost').reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0) / lost) : 0;
    const profitFactor = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '∞';
    let peak = 0, maxDD = 0, cumPnl = 0;
    data.slice().reverse().forEach((t, i) => { cumPnl += parseFloat(t.pnl_usd) || 0; if (i === 0 || cumPnl > peak) peak = cumPnl; const dd = peak - cumPnl; if (dd > maxDD) maxDD = dd; });
    res.json({ total, won, lost, winRate: parseFloat(winRate), totalPnl: parseFloat(totalPnl.toFixed(2)), avgWin: parseFloat(avgWin.toFixed(2)), avgLoss: parseFloat(avgLoss.toFixed(2)), profitFactor, maxDrawdown: parseFloat(maxDD.toFixed(2)), recentTrades: data.slice(0, 20) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function monitorPaperTrades() {
  try {
    const { data: openTrades } = await supabase.from('paper_trades').select('*').eq('status', 'open');
    // ── Timeout lateral — cerrar trades zombies ──
    for (const trade of openTrades || []) {
      if (trade.source === 'auto' || trade.source === 'manual') {
        const minutosAbierto = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
        if (minutosAbierto >= 45) {
          const currentWsPrice = wsState[trade.symbol]?.lastPrice;
          if (!currentWsPrice) continue;
          const entry = parseFloat(trade.entry);
          const movPct = Math.abs((currentWsPrice - entry) / entry * 100);
          if (movPct < 0.25) {
            // Precio no se movió ±0.25% en 45 min — trade lateral, cerrar
            const pnl_usd = trade.direction === 'LONG'
              ? (currentWsPrice - entry) / entry * parseFloat(trade.size_usd) * parseFloat(trade.leverage || 5)
              : (entry - currentWsPrice) / entry * parseFloat(trade.size_usd) * parseFloat(trade.leverage || 5);
            const pnl_pct = trade.direction === 'LONG'
              ? (currentWsPrice - entry) / entry * parseFloat(trade.leverage || 5) * 100
              : (entry - currentWsPrice) / entry * parseFloat(trade.leverage || 5) * 100;
            await supabase.from('paper_trades').update({
              status: pnl_usd >= 0 ? 'won' : 'lost',
              close_price: currentWsPrice,
              close_reason: 'timeout_lateral',
              pnl_usd: parseFloat(pnl_usd.toFixed(2)),
              pnl_pct: parseFloat(pnl_pct.toFixed(2)),
              closed_at: new Date().toISOString()
            }).eq('id', trade.id);
            circuitBreaker.addPnl(pnl_usd);
            console.log(`⏱️ Timeout lateral: ${trade.direction} ${trade.symbol} cerrado a $${currentWsPrice} — ${minutosAbierto.toFixed(0)}min sin movimiento — PnL: $${pnl_usd.toFixed(2)}`);
          }
        }
      } else if (trade.source === 'scalping') {
        // ── Timeout 2h scalping ──
        const minutosAbierto = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
        if (minutosAbierto >= 120) {
          const currentWsPrice = wsState[trade.symbol]?.lastPrice;
          if (!currentWsPrice) continue;
          const entry = parseFloat(trade.entry);
          const lev = parseFloat(trade.leverage || 10);
          const pnl_usd = parseFloat((trade.direction === 'LONG'
            ? (currentWsPrice - entry) / entry * parseFloat(trade.size_usd) * lev
            : (entry - currentWsPrice) / entry * parseFloat(trade.size_usd) * lev).toFixed(2));
          const pnl_pct = parseFloat((trade.direction === 'LONG'
            ? (currentWsPrice - entry) / entry * lev * 100
            : (entry - currentWsPrice) / entry * lev * 100).toFixed(2));
          await supabase.from('paper_trades').update({
            status: pnl_usd >= 0 ? 'won' : 'lost',
            close_price: currentWsPrice,
            close_reason: 'timeout',
            pnl_usd, pnl_pct,
            closed_at: new Date().toISOString()
          }).eq('id', trade.id);
          circuitBreaker.addPnl(pnl_usd);
          console.log(`⏱️ Timeout scalping 2h: ${trade.direction} ${trade.symbol} cerrado a $${currentWsPrice} — ${minutosAbierto.toFixed(0)}min — PnL: $${pnl_usd}`);
          if (process.env.TELEGRAM_CHAT_ID) {
            const _dCt = new Date(), _limaCt = `${_dCt.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dCt.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
            const msgT = `${pnl_usd >= 0 ? '✅' : '❌'} ${trade.direction} ${trade.symbol} — ⚡ Scalping\n💰 Entry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentWsPrice).toLocaleString()}\n🎯 Razón: Timeout 2h\n💵 PnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\n🕐 Cierre: ${_limaCt}`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msgT); } catch(e) { console.error('Telegram send error:', e.message); }
          }
        }
      } else {
        // ── Timeout 6h para whale/wall/sweep/meanrev ──
        const minAbierto6h = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
        if (minAbierto6h >= 360) {
          const wsP6h = wsState[trade.symbol]?.lastPrice;
          if (wsP6h) {
            const e6h = parseFloat(trade.entry), lev6h = parseFloat(trade.leverage || 5);
            const pDiff6h = trade.direction === 'LONG' ? (wsP6h - e6h) / e6h : (e6h - wsP6h) / e6h;
            const pnl6h = parseFloat((pDiff6h * parseFloat(trade.size_usd) * lev6h).toFixed(2));
            const pnlPct6h = parseFloat((pDiff6h * lev6h * 100).toFixed(2));
            await supabase.from('paper_trades').update({
              status: pnl6h >= 0 ? 'won' : 'lost', close_price: wsP6h,
              close_reason: 'timeout', pnl_usd: pnl6h, pnl_pct: pnlPct6h,
              closed_at: new Date().toISOString()
            }).eq('id', trade.id);
            circuitBreaker.addPnl(pnl6h);
            console.log(`⏱️ Timeout 6h (${trade.source}): ${trade.direction} ${trade.symbol} a $${wsP6h} — ${minAbierto6h.toFixed(0)}min — PnL: $${pnl6h}`);
          }
        }
      }
    }
    if (!openTrades?.length) return;
    for (const trade of openTrades) {
      try {
        const currentPrice = wsState[trade.symbol]?.lastPrice;
        if (!currentPrice) continue;
        const entryPrice = parseFloat(trade.entry);
        if (Math.abs(currentPrice - entryPrice) / entryPrice * 100 > 50) continue;
        const tp1 = parseFloat(trade.tp1), tp2 = parseFloat(trade.tp2) || tp1;
        let sl = parseFloat(trade.sl);
        const isLong = trade.direction === 'LONG';
        const pollHigh = wsState[trade.symbol]?.pollingHigh || currentPrice;
        const pollLow  = wsState[trade.symbol]?.pollingLow  || currentPrice;
        if (wsState[trade.symbol]) { wsState[trade.symbol].pollingHigh = currentPrice; wsState[trade.symbol].pollingLow = currentPrice; }
        const trailExtremePoll = isLong ? pollHigh : pollLow;
        const priceDiffPct = isLong ? (trailExtremePoll - entryPrice) / entryPrice * 100 : (entryPrice - trailExtremePoll) / entryPrice * 100;
        let newSl = sl;
        if (trade.source === 'sweep') {
          const _lev = parseFloat(trade.leverage || 10), _size = parseFloat(trade.size_usd);
          const sweepPnl = (isLong ? (trailExtremePoll - entryPrice) / entryPrice : (entryPrice - trailExtremePoll) / entryPrice) * _size * _lev;
          if (sweepPnl >= 40) {
            const candidate = isLong ? trailExtremePoll * (1 - 0.0018) : trailExtremePoll * (1 + 0.0018);
            newSl = isLong ? Math.max(sl, candidate) : Math.min(sl, candidate);
          } else if (sweepPnl >= 25) {
            const candidate = isLong ? trailExtremePoll * (1 - 0.003) : trailExtremePoll * (1 + 0.003);
            newSl = isLong ? Math.max(sl, candidate) : Math.min(sl, candidate);
          } else if (sweepPnl >= 15) {
            const lockSl = isLong ? entryPrice * (1 + 8 / (_size * _lev)) : entryPrice * (1 - 8 / (_size * _lev));
            newSl = isLong ? Math.max(sl, lockSl) : Math.min(sl, lockSl);
          }
        } else if (priceDiffPct >= 0.5) {
          const beTarget = isLong ? entryPrice * 1.001 : entryPrice * 0.999;
          const trailDistPct = Math.max(0.0025, 0.005 - priceDiffPct * 0.001);
          const candidate = isLong ? trailExtremePoll * (1 - trailDistPct) : trailExtremePoll * (1 + trailDistPct);
          const slFloor = isLong ? Math.max(beTarget, candidate) : Math.min(beTarget, candidate);
          newSl = isLong ? Math.max(sl, slFloor) : Math.min(sl, slFloor);
        }
        if ((isLong && newSl > sl) || (!isLong && newSl < sl)) {
          const newSlRounded = parseFloat(newSl.toFixed(1));
          await supabase.from('paper_trades').update({ sl: newSlRounded }).eq('id', trade.id);
          sl = newSlRounded;
          console.log(`📈 Trailing stop: ${trade.direction} ${trade.symbol} SL ${parseFloat(trade.sl).toFixed(0)} → ${newSlRounded.toFixed(0)} (precio: ${currentPrice.toFixed(0)}, +${priceDiffPct.toFixed(2)}%)`);
        }
        if (priceDiffPct >= 1.0) {
          try {
            const liqRes = await fetchForceOrders(trade.symbol), currentTp1 = parseFloat(trade.tp1);
            if (liqRes?.zones?.length) {
              const relevantZones = liqRes.zones.filter(z => isLong ? z.price > currentPrice : z.price < currentPrice).filter(z => isLong ? z.price > currentTp1 : z.price < currentTp1).sort((a, b) => isLong ? a.price - b.price : b.price - a.price);
              if (relevantZones.length) { const newTp1 = parseFloat(relevantZones[0].price.toFixed(1)); await supabase.from('paper_trades').update({ tp1: newTp1 }).eq('id', trade.id); console.log(`🎯 TP dinámico: ${trade.direction} ${trade.symbol} TP ${currentTp1.toFixed(0)} → ${newTp1.toFixed(0)}`); }
            }
          } catch(_) {}
        }
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
          const entry = parseFloat(trade.entry), priceDiff = trade.direction === 'LONG' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
          const _lev4 = parseFloat(trade.leverage || 10);
          const pnl_usd = parseFloat((trade.size_usd * priceDiff * _lev4).toFixed(2)), pnl_pct = parseFloat((priceDiff * _lev4 * 100).toFixed(2));
          if (Math.abs(pnl_usd) > parseFloat(trade.size_usd) * _lev4 * 1.1) { await supabase.from('paper_trades').update({ status: 'closed', close_price: currentPrice, close_reason: 'invalid_pnl', pnl_usd: 0, pnl_pct: 0, closed_at: new Date().toISOString() }).eq('id', trade.id); continue; }
          // ── Status basado en PnL real — no en closeReason v4.4.48 ──
          // Si el trailing movió el SL y cerró en ganancia → trailing_tp
          const slFueMovido = parseFloat(trade.sl) !== parseFloat(trade.sl); // placeholder — ver abajo
          const trailingActuo = closeReason === 'sl' && pnl_usd > 0;
          const finalCloseReason = trailingActuo ? 'trailing_tp' : closeReason;
          const tradeStatus = pnl_usd > 0 ? 'won' : 'lost';
          if (trailingActuo) console.log(`🎯 Trailing TP: ${trade.direction} ${trade.symbol} cerró en ganancia $${pnl_usd} vía trailing stop`);
          await supabase.from('paper_trades').update({ status: tradeStatus, close_price: currentPrice, close_reason: finalCloseReason, pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', trade.id);
          // ── Circuit Breaker: acumular PnL diario ──
          if (trade.source === 'scalping' || trade.source === 'sweep' || trade.source === 'auto') {
            circuitBreaker.addPnl(pnl_usd);
          }
          // ── Consecutive loss tracker por símbolo ──
          if (trade.source === 'scalping') {
            const tracker = trade.symbol.includes('ETH') ? ethLossTracker
                          : trade.symbol.includes('SOL') ? solLossTracker
                          : null;
            if (tracker) {
              if (tradeStatus === 'lost') tracker.recordLoss();
              else tracker.recordWin();
            }
          }
          console.log(`📊 Paper trade cerrado: ${trade.direction} ${trade.symbol} → ${closeReason} PnL: $${pnl_usd}`);
          if (process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN) {
            const _srcIconsM = { auto: '🤖', scalping: '⚡', manual: '👤', sweep: '🌊', wall: '🧱', meanrev: '📊' };
            const _srcLabelM = { auto: 'Auto', scalping: 'Scalping', manual: 'Manual', sweep: 'Sweep', wall: 'Wall', meanrev: 'MeanRev' };
            const _srcIconM = _srcIconsM[trade.source] || '📊', _srcNameM = _srcLabelM[trade.source] || trade.source || '–';
            const _isTrailingM = closeReason?.includes('trailing');
            const _razonMapM = { tp1: 'TP1', tp2: 'TP2', sl: 'SL', timeout: 'Timeout 2h', timeout_lateral: 'Timeout lateral', kill_switch: 'Kill switch', signal_reversal: 'Reversión señal', manual_tp: 'TP manual', manual: 'Cierre manual' };
            const _razonM = _razonMapM[closeReason] || (closeReason || '–').toUpperCase();
            const _dCm = new Date(), _limaCm = `${_dCm.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dCm.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
            const _closedEmojiM = pnl_usd >= 0 ? '✅' : '❌';
            const msg = _isTrailingM
              ? `${_closedEmojiM} ${trade.direction} ${trade.symbol} — ${_srcIconM} ${_srcNameM}\n💰 Entry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentPrice).toLocaleString()}\n🔒 Trailing SL\n💵 PnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\n🕐 Cierre: ${_limaCm}`
              : `${_closedEmojiM} ${trade.direction} ${trade.symbol} — ${_srcIconM} ${_srcNameM}\n💰 Entry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentPrice).toLocaleString()}\n🎯 Razón: ${_razonM}\n💵 PnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\n🕐 Cierre: ${_limaCm}`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg); } catch(e) { console.error("Telegram send error:", e.message); }
          }
        }
      } catch(_) {}
    }
  } catch(e) { console.error('Monitor paper trades error:', e.message); }
}

app.get('/api/news/latest', async (req, res) => {
  const sources = [
    async () => { const r = await axios.get('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=12', { timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.data?.Data?.length) throw new Error('empty'); return r.data.Data.map(n => ({ title: n.title, source: n.source_info?.name || n.source || 'CryptoCompare', published_on: n.published_on, url: n.url })); },
    async () => { const r = await axios.get('https://cointelegraph.com/rss', { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }); const items = []; const rx = /<item>([\s\S]*?)<\/item>/g; let m; while ((m = rx.exec(r.data)) !== null && items.length < 8) { const it = m[1]; const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || it.match(/<title>([^<]+)<\/title>/))?.[1]?.trim() || ''; const url = it.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() || ''; const pub = it.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]?.trim() || ''; if (title) items.push({ title, source: 'CoinTelegraph', published_on: pub ? Math.floor(new Date(pub).getTime()/1000) : Math.floor(Date.now()/1000), url }); } if (!items.length) throw new Error('empty'); return items; },
    async () => { const r = await axios.get('https://decrypt.co/feed', { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }); const items = []; const rx = /<item>([\s\S]*?)<\/item>/g; let m; while ((m = rx.exec(r.data)) !== null && items.length < 8) { const it = m[1]; const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || it.match(/<title>([^<]+)<\/title>/))?.[1]?.trim() || ''; const url = it.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() || ''; const pub = it.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]?.trim() || ''; if (title) items.push({ title, source: 'Decrypt', published_on: pub ? Math.floor(new Date(pub).getTime()/1000) : Math.floor(Date.now()/1000), url }); } if (!items.length) throw new Error('empty'); return items; }
  ];
  for (const source of sources) {
    try { const items = await source(); if (items?.length) { console.log(`✅ Noticias: ${items.length} items`); return res.json(items); } } catch(_) {}
  }
  res.json([]);
});

app.get('/api/ml/insights', async (req, res) => {
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: trades, error } = await supabase.from('paper_trades').select('id,symbol,direction,status,pnl_usd,pnl_pct,confidence,market_data,created_at,closed_at,divergences,fibonacci').in('status', ['won','lost']).gte('opened_at', since30d).order('created_at', { ascending: false });
    if (error) throw error;
    if (!trades || trades.length < 10) return res.json({ message: 'Necesitas al menos 10 trades cerrados para análisis ML', trades: trades?.length || 0 });
    const won = trades.filter(t => t.status === 'won'), lost = trades.filter(t => t.status === 'lost');
    function avg(arr, key) { const vals = arr.map(t => parseFloat(t.market_data?.[key])).filter(v => !isNaN(v) && v >= 0 && v <= 100); return vals.length > 0 ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(3) : null; }
    const totalPnl = trades.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0);
    const avgWin = won.length > 0 ? won.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0)/won.length : 0;
    const avgLoss = lost.length > 0 ? Math.abs(lost.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0)/lost.length) : 0;
    let peak=0,maxDD=0,cumPnl=0; [...trades].reverse().forEach(t=>{cumPnl+=parseFloat(t.pnl_usd)||0;if(cumPnl>peak)peak=cumPnl;const dd=peak-cumPnl;if(dd>maxDD)maxDD=dd;});
    const wr = (won.length/trades.length)*100;
    const withFib = trades.filter(t=>t.market_data?.fib_bonus>0), withWhales = trades.filter(t=>t.market_data?.whale_count>=3);
    const withTrailing = trades.filter(t=>t.close_reason==='trailing_tp');
    const trailingWR = withTrailing.length>0 ? (withTrailing.filter(t=>t.status==='won').length/withTrailing.length*100).toFixed(1) : '0';
    const aligned4h = trades.filter(t=>(t.direction==='LONG'&&t.market_data?.bias_4h==='long')||(t.direction==='SHORT'&&t.market_data?.bias_4h==='short'));
    const { data: allTrades } = await supabase.from('paper_trades').select('source,status,pnl_usd').in('status',['won','lost']).gte('opened_at', since30d);
    const bySource = {};
    for (const src of ['scalping','auto','manual','sweep','wall','meanrev','backtest']) {
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
    res.json({ total:trades.length, won:won.length, lost:lost.length, winRate: wr.toFixed(1), totalPnl: totalPnl.toFixed(2), avgWin: avgWin.toFixed(2), avgLoss: avgLoss.toFixed(2), profitFactor: avgLoss>0?(avgWin/avgLoss).toFixed(2):'∞', maxDrawdown: maxDD.toFixed(2), avgConfidenceWon: avg(won,'confidence'), avgConfidenceLost: avg(lost,'confidence'), avgRsiWon: avg(won,'rsi_15m'), avgRsiLost: avg(lost,'rsi_15m'), winRateWithFib: wrFib.toFixed(1), winRateWithWhales: withWhales.length>0?(withWhales.filter(t=>t.status==='won').length/withWhales.length*100).toFixed(1):'0', winRateWithTrailing: trailingWR, countTrailing: withTrailing.length, winRateAligned4h: aligned4h.length>0?(aligned4h.filter(t=>t.status==='won').length/aligned4h.length*100).toFixed(1):'n/a', topDivergencesWon: topDivs, bySource, recommendations: recs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ml/optimize', async (req, res) => {
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: trades } = await supabase.from('paper_trades').select('*').in('status',['won','lost']).not('market_data','is',null).gte('opened_at', since30d);
    if (!trades || trades.length < 50) return res.json({ optimized:false, reason:'insufficient_data', trades:trades?.length||0 });
    const won = trades.filter(t=>t.status==='won'), winRate = won.length/trades.length;
    const adjustments = {}, recommendations = [];
    const highConf = trades.filter(t=>(t.market_data?.confidence||0)>=90), lowConf = trades.filter(t=>(t.market_data?.confidence||0)<90);
    if (highConf.length>=10&&lowConf.length>=10) { const wrH=highConf.filter(t=>t.status==='won').length/highConf.length, wrL=lowConf.filter(t=>t.status==='won').length/lowConf.length; if(wrH>wrL+0.1){adjustments.min_confidence={from:85,to:88};recommendations.push(`Alta confianza WR: ${(wrH*100).toFixed(1)}% vs baja: ${(wrL*100).toFixed(1)}%`);} }
    res.json({ optimized:true, trades:trades.length, winRate:(winRate*100).toFixed(1), adjustments_count:Object.keys(adjustments).length, adjustments, recommendations });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

let scalpingActive = false, scalpingInterval = null;

app.post('/api/scalping/start', (req, res) => {
  if (scalpingActive) return res.json({ ok: false, message: 'Scalping ya activo' });
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(','), intervalMin = parseFloat(process.env.SCALP_INTERVAL_MIN || '3');
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
  res.json({ active: scalpingActive, intervalMin: parseFloat(process.env.SCALP_INTERVAL_MIN || '3'), threshold: parseInt(process.env.SCALP_THRESHOLD || '92'), symbols: (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',') });
});

function detectDoublePatterns(klines15m, price) {
  try {
    if (!klines15m || klines15m.length < 30) return [];
    const patterns = [], highs = klines15m.map(k => parseFloat(k[2])), lows = klines15m.map(k => parseFloat(k[3])), closes = klines15m.map(k => parseFloat(k[4])), volumes = klines15m.map(k => parseFloat(k[5])), n = closes.length, lookback = 20;
    let peaks = [], troughs = [];
    for (let i = n - lookback; i < n - 1; i++) {
      if (highs[i] > highs[i-1] && highs[i] > highs[i+1]) peaks.push({ idx: i, price: highs[i], vol: volumes[i] });
      if (lows[i] < lows[i-1] && lows[i] < lows[i+1]) troughs.push({ idx: i, price: lows[i], vol: volumes[i] });
    }
    if (peaks.length >= 2) {
      const p1 = peaks[peaks.length-2], p2 = peaks[peaks.length-1];
      const priceDiff = Math.abs(p1.price - p2.price) / p1.price * 100, volDivergence = p2.vol < p1.vol * 0.85;
      const rsi1 = calcRSI(closes.slice(0, p1.idx+1)), rsi2 = calcRSI(closes.slice(0, p2.idx+1)), rsiDivergence = rsi2 < rsi1 - 3;
      const neckline = Math.min(...lows.slice(p1.idx, p2.idx+1)), priceBelowPattern = price < p2.price * 0.985;
      if (priceDiff < 0.4 && (volDivergence || rsiDivergence) && !priceBelowPattern) {
        let prob = 74; if(volDivergence) prob+=10; if(rsiDivergence) prob+=8; if(price < p2.price*0.999) prob+=7;
        patterns.push({ type:'double_top', name:'┳ Double Top — Scalping Bajista', direction:'SHORT', probability:Math.min(92,prob), entry:price, tp:neckline-(p2.price-neckline)*0.8, sl:p2.price*1.002, description:`Double Top en $${parseInt(p2.price).toLocaleString()} con ${rsiDivergence?'RSI divergente':'volumen decreciente'} — señal bajista.`, action:prob>=80?'ENTRAR':'ESPERAR', scalpMode:true });
      }
    }
    if (troughs.length >= 2) {
      const t1 = troughs[troughs.length-2], t2 = troughs[troughs.length-1];
      const priceDiff = Math.abs(t1.price - t2.price) / t1.price * 100, volDivergence = t2.vol < t1.vol * 0.85;
      const rsi1 = calcRSI(closes.slice(0, t1.idx+1)), rsi2 = calcRSI(closes.slice(0, t2.idx+1)), rsiDivergence = rsi2 > rsi1 + 3;
      const neckline = Math.max(...highs.slice(t1.idx, t2.idx+1));
      const priceAbovePattern = price > t2.price * 1.015, priceBelowNeckline = price < neckline * 0.998;
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
    let longScore = longs.reduce((s,d)=>s+d.probability,0)/Math.max(longs.length,1), shortScore = shorts.reduce((s,d)=>s+d.probability,0)/Math.max(shorts.length,1);
    if(bias15m?.bias==='long') longScore+=12; if(bias15m?.bias==='short') shortScore+=12;
    if(bias1h?.bias==='long') longScore+=8; if(bias1h?.bias==='short') shortScore+=8;
    if(bias4h?.bias==='long') longScore+=4; if(bias4h?.bias==='short') shortScore+=4;
    if(divergences.some(d=>d.type==='double_top')) shortScore+=15;
    if(divergences.some(d=>d.type==='double_bottom')) longScore+=15;
    const direction = shortScore > longScore ? 'SHORT' : longScore > shortScore ? 'LONG' : 'ESPERAR';
    const prob = direction === 'SHORT' ? shortScore : direction === 'LONG' ? longScore : 30;
    return { direction, probability:Math.min(95,Math.round(prob)), action:prob>=78?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', mode:'scalping' };
  } catch(e) { return { direction:'ESPERAR', probability:30, action:'ESPERAR' }; }
}



// ── FILTRO MACRO DE CONTEXTO v4.4.39 ──
// Bloquea scalping cuando el mercado macro está en condición desfavorable
// Basado en: CVD 1H, OI 4H, precio vs VAH/VAL, Funding Rate, Score macro
function calcMacroScore({ bias1h, bias4h, bias1d, fundingRate, vrvp, price, oi15m, cvd1hPct, scalpDir }) {
  const condiciones = [];
  let penalizaciones = 0;

  // 1. CVD 1H negativo cuando queremos entrar LONG (ventas dominando)
  if (scalpDir === 'LONG' && (bias1h?.cvdPct || 0) < -8) {
    penalizaciones++;
    condiciones.push(`CVD 1H ${bias1h.cvdPct?.toFixed(1)}% — ventas dominando`);
  }
  // CVD 1H positivo cuando queremos entrar SHORT
  if (scalpDir === 'SHORT' && (bias1h?.cvdPct || 0) > 8) {
    penalizaciones++;
    condiciones.push(`CVD 1H ${bias1h.cvdPct?.toFixed(1)}% — compras dominando`);
  }

  // 2. OI 15m cayendo cuando queremos LONG (posiciones cerrando)
  if (scalpDir === 'LONG' && oi15m?.trend === 'down' && parseFloat(oi15m?.deltaPct || 0) < -0.5) {
    penalizaciones++;
    condiciones.push(`OI 15m cayendo ${oi15m.deltaPct}%`);
  }
  // OI 15m subiendo cuando queremos SHORT con precio bajando (short squeeze risk)
  if (scalpDir === 'SHORT' && oi15m?.trend === 'up' && parseFloat(oi15m?.deltaPct || 0) > 0.5) {
    penalizaciones++;
    condiciones.push(`OI 15m subiendo ${oi15m.deltaPct}% — riesgo short squeeze`);
  }

  // 3. Precio sobre VAH → resistencia clave → no entrar LONG
  if (vrvp && price && scalpDir === 'LONG' && price > vrvp.vah * 1.002) {
    penalizaciones++;
    condiciones.push(`Precio $${price.toFixed(0)} sobre VAH $${vrvp.vah} — resistencia`);
  }
  // Precio bajo VAL → soporte clave roto → no entrar SHORT agresivo
  if (vrvp && price && scalpDir === 'SHORT' && price < vrvp.val * 0.998) {
    penalizaciones++;
    condiciones.push(`Precio $${price.toFixed(0)} bajo VAL $${vrvp.val} — sobreextendido`);
  }

  // 4. Funding Rate en contra
  if (scalpDir === 'LONG' && fundingRate > 0.002) {
    penalizaciones++;
    condiciones.push(`Funding +${(fundingRate*100).toFixed(4)}% — longs sobrecalentados`);
  }
  if (scalpDir === 'SHORT' && fundingRate < -0.002) {
    penalizaciones++;
    condiciones.push(`Funding ${(fundingRate*100).toFixed(4)}% — shorts sobrecalentados`);
  }

  // 5. Score macro (1H + 4H) en contra
  const score1h = bias1h?.score || 50;
  const score4h = bias4h?.score || 50;
  const macroContra = scalpDir === 'LONG'
    ? (score1h < 42 && score4h < 45)
    : (score1h > 58 && score4h > 55);
  if (macroContra) {
    penalizaciones++;
    condiciones.push(`Score macro contrario — 1H:${score1h} 4H:${score4h}`);
  }

  const bloqueado = penalizaciones >= 3;
  if (bloqueado) {
    console.log(`🌐 MACRO FILTER bloqueó ${scalpDir} — ${penalizaciones}/5 condiciones: ${condiciones.join(' | ')}`);
  } else if (penalizaciones >= 1) {
    console.log(`🌐 Macro: ${penalizaciones}/5 señales adversas (umbral 3) — ${scalpDir} permitido`);
  }
  return { bloqueado, penalizaciones, condiciones };
}


// ── VOLATILITY GATE v4.4.44 — usa klines 15M para contexto real del mercado ──
function calcVolatilityGate(klines3m, klines15m) {
  try {
    const klines = klines15m && klines15m.length >= 21 ? klines15m : klines3m;
    if (!klines || klines.length < 21) return { activo: true };
    const closes = klines.map(k => parseFloat(k[4]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const vols   = klines.map(k => parseFloat(k[5]));
    const atrs = [];
    for (let i = 1; i < klines.length; i++) {
      atrs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
    }
    const atrActual   = atrs[atrs.length-1];
    const atrPromedio = atrs.slice(-20).reduce((a,b)=>a+b,0)/20;
    const volActual   = vols[vols.length-1];
    const volPromedio = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
    const movPct      = Math.abs(closes[closes.length-1]-closes[closes.length-4])/closes[closes.length-4]*100;
    const atrOk  = (atrActual/atrPromedio) >= 0.5;
    const volOk  = (volActual/volPromedio) >= 0.7;
    const movOk  = movPct >= 0.10;
    const cumplidas = [atrOk,volOk,movOk].filter(Boolean).length;
    const activo = cumplidas >= 2;
    if (!activo) console.log(`💤 Volatility Gate (15M): mercado muerto — ATR ${(atrActual/atrPromedio).toFixed(2)}x Vol ${(volActual/volPromedio).toFixed(2)}x Mov ${movPct.toFixed(3)}%`);
    return { activo, cumplidas, atrRatio: atrActual/atrPromedio, volRatio: volActual/volPromedio, movPct };
  } catch(e) { return { activo: true }; }
}


// ── GESTIÓN DE RIESGO POR PORCENTAJE v4.4.47 ──
// Riesgo máximo: 2% del capital por trade — aplica a todos los modos
// En lugar de rechazar, calcula el tamaño de posición correcto
const RISK_PCT = 0.02;         // 2% del capital por trade
const CAPITAL_USD = parseFloat(process.env.PAPER_SIZE_USD || '1000');

// Leverage diferenciado por modo
const LEVERAGE_BY_MODE = {
  scalping: 10,   // SL ajustado, trades rápidos
  auto:      5,   // SL amplio, timeframes mayores
  sweep:     5,   // señales de barrida
  whale:     3,   // señales de ballena — más volátiles
  meanrev:   5,   // reversión a media
  manual:   10,   // el usuario decide
};

function calcMaxLossUsd(entry, sl, direction, capitalUsd, leverage) {
  const risk = direction === 'LONG' ? (entry - sl) / entry : (sl - entry) / entry;
  return risk * capitalUsd * leverage;
}

// Calcula el tamaño de posición para no superar el riesgo máximo
function calcPositionSize(entry, sl, direction, mode) {
  const MIN_SL_PCT = 0.003; // mínimo 0.3% de distancia al entry
  const rawSlPct = direction === 'LONG' ? (entry - sl) / entry : (sl - entry) / entry;
  const slPct = Math.max(MIN_SL_PCT, rawSlPct > 0 ? rawSlPct : 0);
  const effectiveSl = rawSlPct < MIN_SL_PCT
    ? parseFloat((direction === 'LONG' ? entry * (1 - MIN_SL_PCT) : entry * (1 + MIN_SL_PCT)).toFixed(2))
    : sl;
  const leverage = LEVERAGE_BY_MODE[mode] || 5;
  const maxLossUsd = CAPITAL_USD * RISK_PCT;
  const sizeUsd = Math.min(CAPITAL_USD, maxLossUsd / (slPct * leverage));
  return { sizeUsd: Math.round(sizeUsd * 100) / 100, leverage, maxLossUsd, effectiveSl };
}

const MAX_TRADE_LOSS_USD = CAPITAL_USD * RISK_PCT; // $20 con $1000 — referencia

// ── CIRCUIT BREAKER DIARIO v4.4.38 ──
const circuitBreaker = {
  dailyPnl: {},
  paused: {},
  LIMIT: -50,
  getToday() {
    const lima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
    return lima.toISOString().slice(0, 10);
  },
  addPnl(pnl) {
    const day = this.getToday();
    this.dailyPnl[day] = (this.dailyPnl[day] || 0) + pnl;
    if (this.dailyPnl[day] <= this.LIMIT) {
      this.paused[day] = true;
      console.log(`🔴 CIRCUIT BREAKER activado — PnL día: $${this.dailyPnl[day].toFixed(2)} ≤ $${this.LIMIT}`);
    }
  },
  isActive() {
    const day = this.getToday();
    if (this.paused[day]) {
      console.log('⏸️ Circuit Breaker activo — trades automáticos pausados hoy');
      return true;
    }
    return false;
  }
};

// ── CONSECUTIVE LOSS TRACKER por símbolo v4.4.40 ──
function createLossTracker(sym) {
  return {
    symbol: sym,
    consecutive: 0,
    pausedUntil: null,
    MAX: 2,
    PAUSE_MIN: 30,
    recordLoss() {
      this.consecutive++;
      if (this.consecutive >= this.MAX) {
        this.pausedUntil = Date.now() + this.PAUSE_MIN * 60 * 1000;
        console.log(`⏸️ ${this.symbol} Scalping pausado ${this.PAUSE_MIN}min — ${this.consecutive} pérdidas consecutivas`);
      }
    },
    recordWin() { this.consecutive = 0; },
    isPaused() {
      if (this.pausedUntil && Date.now() < this.pausedUntil) {
        const minLeft = Math.ceil((this.pausedUntil - Date.now()) / 60000);
        console.log(`⏸️ ${this.symbol} pausado — ${minLeft}min restantes`);
        return true;
      }
      if (this.pausedUntil && Date.now() >= this.pausedUntil) {
        this.pausedUntil = null;
        this.consecutive = 0;
        console.log(`✅ ${this.symbol} Scalping reanudado`);
      }
      return false;
    }
  };
}
const ethLossTracker = createLossTracker('ETH');
const solLossTracker = createLossTracker('SOL');

const scalpingInProgress = {};
async function runScalpingAnalysis(symbol = 'BTCUSDT') {
  if (!SCALP_ENABLED) return;
  if (scalpingInProgress[symbol]) return;
  // ── v4.4.77: BTC sin edge estadístico — deshabilitado ──
  if (symbol === 'BTCUSDT') {
    console.log(`⛔ Scalping BTC deshabilitado — sin edge estadístico`);
    return;
  }
  // ── Circuit Breaker diario ──
  if (circuitBreaker.isActive()) return;
  // ── Consecutive loss por símbolo ──
  if (symbol.includes('ETH') && ethLossTracker.isPaused()) return;
  if (symbol.includes('SOL') && solLossTracker.isPaused()) return;
  // ── Filtro horario — solo bloquear madrugada 0-5h Lima ──
  const _horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getHours();
  if (_horaLima >= 0 && _horaLima <= 5) {
    console.log(`💤 Madrugada ${_horaLima}h Lima — scalping bloqueado`);
    return;
  }
  scalpingInProgress[symbol] = true;
  try {
    const [tickerRes, k3m, k15m, obRes, fundingRes] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=3m&limit=60`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=25`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
    ]);
    const price = parseFloat(tickerRes.data.lastPrice), fundingRate = parseFloat(fundingRes.data.lastFundingRate);
    // ── Volatility Gate ──
    const volGate = calcVolatilityGate(k3m.data, k15m?.data);
    if (!volGate.activo) { scalpingInProgress[symbol] = false; return; }
    const ob = analyzeOB(obRes.data.bids, obRes.data.asks), cvd3m = calcCVD(k3m.data), rsi3m = calcRSI(k3m.data.map(k => parseFloat(k[4])));
    const fib3m = calcFibonacci(k3m.data, price), wsM = getWsMetrics(symbol);

    // Ajuste SOL v4.4.40: más volátil, bonifica momentum fuerte
    const isSol = symbol.includes('SOL');

    // v4.4.16 C4: filtros duros de scalping — basados en análisis de ganadores vs perdedores
    // Ganadores: RSI prom 49, |imb| 56%, OI falling 2/3
    // Perdedores: RSI prom 61, |imb| 44%, OI falling 1/4
    // Calcular OI 15m para el filtro (ya se calcula abajo para mlData, anticipamos aquí)
    let oi15mForFilter = null;
    try {
      const oi15mPre = await fetchOIHistory(symbol, '15m', 5);
      oi15mForFilter = calcOITrend(oi15mPre);
    } catch(_) {}

    let longScore = 0, shortScore = 0;
    const imb = parseFloat(ob.imbalance||0);
    if (imb > 20) longScore += 30; if (imb < -20) shortScore += 30;
    if (cvd3m.trend==='bull'&&cvd3m.cvdPct>5) longScore += 25; if (cvd3m.trend==='bear'&&cvd3m.cvdPct<-5) shortScore += 25;
    if (rsi3m < 35) longScore += 15; if (rsi3m > 65) shortScore += 15;
    if (fib3m?.retImpact?.signal==='long_bounce') longScore += 15; if (fib3m?.retImpact?.signal==='short_bounce') shortScore += 15;
    // Wall scoring eliminado — sin edge estadístico (v4.4.38)
    if (wsM?.anomaly && Date.now() - wsM.anomaly.time < 3*60*1000) {
      if (wsM.anomaly.direction === 'LONG') longScore += 20;
      if (wsM.anomaly.direction === 'SHORT') shortScore += 20;
    }
    let bias1hScalp = null, bias4hScalp2 = null, bias1dScalp = null;
    try {
      const [k1hSc, k4hSc, k1dSc, oi1hSc, oi4hSc] = await Promise.all([
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=60`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
        fetchOIHistory(symbol,'1h',5), fetchOIHistory(symbol,'4h',5),
      ]);
      bias1hScalp = calcBias(k1hSc.data, oi1hSc, fundingRate);
      bias4hScalp2 = calcBias(k4hSc.data, oi4hSc, fundingRate);
      bias1dScalp = calcBias(k1dSc.data, null, fundingRate);
    } catch(_) {}
    const bias1hScore = bias1hScalp?.score || 50, bias4hScore = bias4hScalp2?.score || 50;
    const scalpDirPreview = longScore > shortScore ? 'LONG' : 'SHORT';

    // ── FILTRO MACRO v4.4.39 — bloquear si 3+ condiciones adversas ──
    try {
      const vrvpScalp = calcVRVP(k3m.data);
      const macroCheck = calcMacroScore({
        bias1h: bias1hScalp,
        bias4h: bias4hScalp2,
        fundingRate,
        vrvp: vrvpScalp,
        price,
        oi15m: oi15mForFilter,
        scalpDir: scalpDirPreview
      });
      if (macroCheck.bloqueado) {
        console.log(`⛔ Scalp ${scalpDirPreview} ${symbol} bloqueado — Macro Filter (${macroCheck.penalizaciones}/5)`);
        return;
      }
    } catch(_) {}
    const wsAnomaly = wsM?.anomaly;
    // PREMIAR pullback: 4H alineado + 1H en contra = señal de entrada óptima (100% WR)
    if (bias4hScalp2?.bias === 'long' && bias1hScalp?.bias === 'short' && scalpDirPreview === 'LONG') {
      longScore += 20; console.log("✅ Pullback alcista detectado " + symbol + " — bonus +20");
    }
    if (bias4hScalp2?.bias === 'short' && bias1hScalp?.bias === 'long' && scalpDirPreview === 'SHORT') {
      shortScore += 20; console.log("✅ Pullback bajista detectado " + symbol + " — bonus +20");
    }
    // BLOQUEAR sobreextensión: 4H y 1H ambos misma dirección = precio ya corrió mucho (25% WR)
    const hasSweep = wsAnomaly?.isSweep && Date.now() - wsAnomaly.time < 3 * 60 * 1000;
    if (bias4hScalp2?.bias === 'long' && bias1hScalp?.bias === 'long' && scalpDirPreview === 'LONG' && !hasSweep) { console.log("⛔ Scalp LONG " + symbol + " bloqueado — sobreextendido 4H+1H alcistas"); return; }
    if (bias4hScalp2?.bias === 'short' && bias1hScalp?.bias === 'short' && scalpDirPreview === 'SHORT' && !hasSweep) { console.log("⛔ Scalp SHORT " + symbol + " bloqueado — sobreextendido 4H+1H bajistas"); return; }
    if (bias4hScalp2?.bias === 'short' && bias1hScalp?.bias === 'short' && scalpDirPreview === 'LONG') { console.log("⛔ Scalp LONG " + symbol + " bloqueado — 4H y 1H bajistas"); return; }
    if (bias4hScalp2?.bias === 'long' && bias1hScalp?.bias === 'long' && scalpDirPreview === 'SHORT') { console.log("⛔ Scalp SHORT " + symbol + " bloqueado — 4H y 1H alcistas"); return; }
    if (bias4hScalp2?.bias === 'neutral' && bias1hScore >= 35 && bias1hScore <= 65) { console.log("⛔ Scalp " + symbol + " bloqueado — mercado lateral"); return; }

    // v4.4.34 Fix bias_1h score — bloquear scalping cuando 1H contradice fuertemente la señal
    // Si 1H es alcista fuerte (>65) no entrar SHORT — si 1H es bajista fuerte (<35) no entrar LONG
    if (scalpDirPreview === 'SHORT' && bias1hScore > 65) {
      console.log(`⛔ Scalp SHORT ${symbol} bloqueado — 1H alcista fuerte (score:${bias1hScore}) contradice SHORT`);
      return;
    }
    if (scalpDirPreview === 'LONG' && bias1hScore < 35) {
      console.log(`⛔ Scalp LONG ${symbol} bloqueado — 1H bajista fuerte (score:${bias1hScore}) contradice LONG`);
      return;
    }
    // ── FILTRO bias_4h v4.4.66 — bloquear si 4H contradice señal con score >= 65 ──
    if (scalpDirPreview === 'SHORT' && bias4hScalp2?.bias === 'long' && (bias4hScalp2?.score || 50) >= 65) {
      console.log(`⛔ Scalp SHORT ${symbol} bloqueado — bias_4h contrario (score:${bias4hScalp2.score})`);
      return;
    }
    if (scalpDirPreview === 'LONG' && bias4hScalp2?.bias === 'short' && (bias4hScalp2?.score || 50) >= 65) {
      console.log(`⛔ Scalp LONG ${symbol} bloqueado — bias_4h contrario (score:${bias4hScalp2.score})`);
      return;
    }
    // ── FILTRO bias_1d v4.4.77 — bloquear si tendencia diaria contradice la señal ──
    if (scalpDirPreview === 'SHORT' && bias1dScalp?.bias === 'long') {
      console.log(`⛔ Scalp bloqueado — contra tendencia diaria (1D:long, señal:SHORT, ${symbol})`);
      return;
    }
    if (scalpDirPreview === 'LONG' && bias1dScalp?.bias === 'short') {
      console.log(`⛔ Scalp bloqueado — contra tendencia diaria (1D:short, señal:LONG, ${symbol})`);
      return;
    }
    // ── FILTRO fib_level v4.4.74 — bloquear entrada sin soporte Fibonacci válido ──
    const fibLabel = fib3m?.nearestRetrace?.label || null;
    if (!fibLabel || fibLabel === '0%') {
      console.log(`⛔ Scalp ${scalpDirPreview} ${symbol} bloqueado — sin nivel Fibonacci válido (${fibLabel})`);
      return;
    }

    // BONUS ZONAS DE LIQUIDACIÓN DINÁMICAS
    try {
      const dynZones = await calcDynamicLiqZones(symbol, price);
      if (dynZones?.length) {
        const askZones = dynZones.filter(z => z.side === 'ask' && z.price > price);
        if (askZones.length) { const best = askZones.sort((a,b) => a.distPct - b.distPct)[0]; longScore += best.bonus; console.log("🧲 Book real ASK $" + best.price.toFixed(0) + " $" + (best.usdVal/1e6).toFixed(1) + "M " + best.strength.toFixed(1) + "x (+" + best.bonus + " LONG) " + symbol); }
        const bidZones = dynZones.filter(z => z.side === 'bid' && z.price < price);
        if (bidZones.length) { const best = bidZones.sort((a,b) => a.distPct - b.distPct)[0]; shortScore += best.bonus; console.log("🧲 Book real BID $" + best.price.toFixed(0) + " $" + (best.usdVal/1e6).toFixed(1) + "M " + best.strength.toFixed(1) + "x (+" + best.bonus + " SHORT) " + symbol); }
      } else {
        const liqData = await fetchForceOrders(symbol);
        if (liqData?.zones?.length) {
          const nearUp = liqData.zones.filter(z => z.price > price && ((z.price - price) / price * 100) <= 1.5).sort((a,b) => a.price - b.price)[0];
          const nearDown = liqData.zones.filter(z => z.price < price && ((price - z.price) / price * 100) <= 1.5).sort((a,b) => b.price - a.price)[0];
          if (nearUp) { const bonus = nearUp.total > 500 ? 12 : nearUp.total > 200 ? 8 : 4; longScore += bonus; console.log("🧲 Liq estática arriba $" + nearUp.price + " (+" + bonus + " LONG) " + symbol); }
          if (nearDown) { const bonus = nearDown.total > 500 ? 12 : nearDown.total > 200 ? 8 : 4; shortScore += bonus; console.log("🧲 Liq estática abajo $" + nearDown.price + " (+" + bonus + " SHORT) " + symbol); }
        }
      }
    } catch(_) {}

    const totalScore = longScore + shortScore;
    if (!totalScore) return;
    const scalpDir = longScore > shortScore ? 'LONG' : 'SHORT';
    const rawConf = Math.round((Math.max(longScore, shortScore) / Math.max(totalScore, 1)) * 100);
    const b1hConflict = bias1hScalp && ((scalpDir === 'LONG' && bias1hScalp.score < 45) || (scalpDir === 'SHORT' && bias1hScalp.score > 55));
    const b4hConflict = bias4hScalp2 && ((scalpDir === 'LONG' && bias4hScalp2.score < 45) || (scalpDir === 'SHORT' && bias4hScalp2.score > 55));
    const scalpProb = Math.min(95, rawConf - (b1hConflict ? 5 : 0) - (b4hConflict ? 5 : 0));
    if (scalpProb < parseInt(process.env.SCALP_THRESHOLD || '92')) return;

    // v4.4.16 C4b: 3 filtros duros — sólo pasan trades con ventaja estadística real
    // Filtro 1: RSI entre 35-65 (no entrar con momentum extremo)
    if (rsi3m > 65 && scalpDir === 'SHORT') {
      console.log(`⛔ Scalp SHORT bloqueado — RSI ${rsi3m} > 65, momentum sobreextendido (${symbol})`);
      return;
    }
    if (rsi3m < 35 && scalpDir === 'LONG') {
      console.log(`⛔ Scalp LONG bloqueado — RSI ${rsi3m} < 35, momentum sobreextendido (${symbol})`);
      return;
    }
    // Filtro 2: imbalance mínimo 30% en dirección del trade
    const absImb = Math.abs(imb);
    if (absImb < 30) {
      console.log(`⛔ Scalp ${scalpDir} bloqueado — imbalance ${imb.toFixed(1)}% insuficiente (<30%) (${symbol})`);
      return;
    }
    if (scalpDir === 'SHORT' && imb > 0) {
      console.log(`⛔ Scalp SHORT bloqueado — imbalance positivo (bids dominan) ${imb.toFixed(1)}% (${symbol})`);
      return;
    }
    if (scalpDir === 'LONG' && imb < 0) {
      console.log(`⛔ Scalp LONG bloqueado — imbalance negativo (asks dominan) ${imb.toFixed(1)}% (${symbol})`);
      return;
    }
    // Filtro 3: OI falling confirma presión real (no obligatorio pero suma — si OI rising en contra, bloquear)
    if (oi15mForFilter && oi15mForFilter.trend === 'rising') {
      if (scalpDir === 'SHORT' && parseFloat(oi15mForFilter.deltaPct) > 0.2) {
        console.log(`⛔ Scalp SHORT bloqueado — OI rising ${oi15mForFilter.deltaPct}% (nuevos longs entrando) (${symbol})`);
        return;
      }
      if (scalpDir === 'LONG' && parseFloat(oi15mForFilter.deltaPct) > 0.2) {
        console.log(`⛔ Scalp LONG bloqueado — OI rising ${oi15mForFilter.deltaPct}% (nuevos shorts entrando) (${symbol})`);
        return;
      }
    }
    const highs3m = k3m.data.slice(-20).map(k=>parseFloat(k[2])), lows3m = k3m.data.slice(-20).map(k=>parseFloat(k[3]));
    const rawAtr = highs3m.reduce((s,h,i)=>s+(h-lows3m[i]),0)/20, atr3m = Math.max(rawAtr, price*0.008);
    const isLong = scalpDir==='LONG', tp1 = isLong ? price+atr3m*1.5 : price-atr3m*1.5, sl = isLong ? price-atr3m*0.8 : price+atr3m*0.8;
    if (isLong && sl >= price) { console.log(`⚠️ Scalp descartado — SL inválido`); return; }
    if (!isLong && sl <= price) { console.log(`⚠️ Scalp descartado — SL inválido`); return; }
    const rrVal = Math.abs(tp1-price)/Math.abs(sl-price);
    if (rrVal < 1.5) return;
    // ── Gestión de riesgo 2% — calcular tamaño dinámico v4.4.47 ──
    const { sizeUsd: scalpSizeUsd, leverage: scalpLeverage, maxLossUsd: scalpMaxLoss, effectiveSl: scalpEffSl } = calcPositionSize(price, sl, scalpDir, 'scalping');
    console.log(`💰 Scalp ${scalpDir} ${symbol} — size $${scalpSizeUsd.toFixed(0)} lev ${scalpLeverage}x riesgo $${scalpMaxLoss?.toFixed(2)}`);
    // v4.4.16 C5: bloquear scalping si hay sweep/anomalía activa en dirección contraria
    // Elimina colisiones scalping↔sweep que generaban kill_switch pérdidas (4/6 lost)
    const activeAnomaly = wsState[symbol]?.anomaly;
    if (activeAnomaly && Date.now() - activeAnomaly.time < 5 * 60 * 1000) {
      if (activeAnomaly.direction !== scalpDir) {
        console.log(`⛔ Scalp ${scalpDir} ${symbol} bloqueado — sweep/anomalía activa en dirección contraria (${activeAnomaly.direction}): ${activeAnomaly.reason}`);
        return;
      }
    }
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol',symbol).eq('status','open');
    if (existing?.length) return;
    let bias4hScalp = null, oiTrend15mScalp = null, fundingScalp = 0, whaleDataScalp = null;
    try {
      const [k4hS, oi15mS, fundS, oi4hS] = await Promise.all([axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`), fetchOIHistory(symbol,'15m',5), axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`), fetchOIHistory(symbol,'4h',5)]);
      fundingScalp = parseFloat(fundS.data.lastFundingRate); bias4hScalp = calcBias(k4hS.data, oi4hS, fundingScalp); oiTrend15mScalp = calcOITrend(oi15mS); whaleDataScalp = await detectWhales(symbol, price);
    } catch(_) {}
    // v4.4.18 Fix C: confirmación de momentum — precio debe moverse en dirección en los últimos 60s
    const prices60sScalp = (wsState[symbol]?.trades || []).filter(t => Date.now() - t.time < 60000).map(t => t.price);
    if (prices60sScalp.length >= 5) {
      const priceNow60  = prices60sScalp[prices60sScalp.length - 1];
      const price60ago  = prices60sScalp[0];
      const movePct60s  = (priceNow60 - price60ago) / price60ago * 100;
      const noMomentum  = (scalpDir === 'LONG' && movePct60s < 0.05) || (scalpDir === 'SHORT' && movePct60s > -0.05);
      if (noMomentum) {
        console.log(`⛔ Scalp ${scalpDir} bloqueado — sin momentum en 60s (${movePct60s.toFixed(3)}%) — ${symbol}`);
        return;
      }
    }
    const mlDataScalp = { confidence: scalpProb, direction: scalpDir, mode: 'scalping', price, rsi_3m: rsi3m, cvd_3m: cvd3m.cvdPct, cvd_trend: cvd3m.trend, ob_imbalance: imb, funding_rate: fundingScalp, oi_trend_15m: oiTrend15mScalp?.trend || 'flat', oi_delta_15m: oiTrend15mScalp?.deltaPct || '0', bias_1h: bias1hScalp?.bias || 'neutral', bias_1h_score: bias1hScalp?.score || 50, bias_4h: bias4hScalp?.bias || bias4hScalp2?.bias || 'neutral', bias_4h_score: bias4hScalp?.score || bias4hScalp2?.score || 50, fib_level: fib3m?.nearestRetrace?.label || null, fib_dist: fib3m?.nearestRetrace?.dist || null, fib_signal: fib3m?.retImpact?.signal || null, fib_bonus: fib3m?.retImpact?.bonus || 0, whale_count: whaleDataScalp?.whaleCount || 0, whale_bias: whaleDataScalp?.whaleBias || 'neutral', whale_dominance: whaleDataScalp?.dominance || 'balanced', ws_anomaly: wsM?.anomaly?.reason || null, ws_vol_multiplier: wsM?.volumeMultiplier || 1, ws_cvd_live: wsM?.cvdLive || 0, atr_3m: atr3m.toFixed(1), timestamp: new Date().toISOString() };
    await supabase.from('paper_trades').insert({ symbol, direction:scalpDir, entry:price, tp1, tp2:tp1, sl:scalpEffSl, rr:`1:${rrVal.toFixed(1)}`, confidence:scalpProb, size_usd:scalpSizeUsd, leverage:scalpLeverage, source:'scalping', status:'open', opened_at: new Date().toISOString(), market_data: mlDataScalp });
    if (process.env.TELEGRAM_CHAT_ID) {
      const _dSc=new Date(), _limaSc=`🕐 Apertura: ${_dSc.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dSc.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
      const msg = `⚡ *SCALPING ${scalpDir}* — ${symbol}\n💰 Entry: *$${parseInt(price).toLocaleString()}*\n🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}\n📐 R:R 1:${rrVal.toFixed(1)} | ${scalpProb}%${wsM?.anomaly?'\n⚡ WS: '+wsM.anomaly.reason:''}\n${_limaSc}\nFuente: ⚡ Scalping`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode:'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
    }
    console.log(`⚡ Scalp: ${scalpDir} ${symbol} @ $${price} WS:${wsM?.anomaly?.direction||'none'}`);
  } catch(e) {
    console.error('Scalping error:', e.message);
    if (e.response?.status === 418) { console.log(`🚫 IP ban 418 scalping — esperando 60s`); await new Promise(r => setTimeout(r, 60000)); }
  }
  finally { scalpingInProgress[symbol] = false; }
}


// ══════════════════════════════════════════════════════════════════
// ─── WALL ABSORPTION v2 — Streaming depth20 + Anti-spoof ─────────
// ══════════════════════════════════════════════════════════════════
// Arquitectura:
//   WebSocket depth20@100ms → bookState → wallTracker → absorción → trade
// Basado en la estrategia de Luis con LBOrderPulse:
//   1. Detectar pared grande en el book
//   2. Verificar que no es spoof (>10s)
//   3. Medir absorción: ¿rebotó o está perforando?
//   4. Si rebotó (<30% comida) → entrar dirección contraria
//   5. Si perforando (>50% comida) → no entrar

const bookState = {};       // order book en tiempo real por símbolo
const wallTracker = {};     // paredes detectadas con timestamp
const wallAbsorptionCooldown = {};
const wallOpeningLock = {};  // lock en memoria para evitar trades duplicados
const wsDepthConnections = {};

// ── Conectar WebSocket depth20 para cada símbolo ─────────────────
function connectDepthWebSocket(symbol) {
  if (wsDepthConnections[symbol]) return;

  const stream = `${symbol.toLowerCase()}@depth20@100ms`;
  const url = `${BINANCE_WS}/ws/${stream}`;
  console.log(`📊 Depth WS conectando: ${symbol}`);

  const ws = new (require('ws'))(url);
  wsDepthConnections[symbol] = ws;

  ws.on('open', () => console.log(`✅ Depth WS conectado: ${symbol}`));

  ws.on('message', (data) => {
    try {
      const book = JSON.parse(data);
      bookState[symbol] = {
        bids: (book.b || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
        asks: (book.a || []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
        ts: Date.now(),
      };
      // Evaluar paredes en cada actualización del book
      evaluateWalls(symbol);
    } catch(_) {}
  });

  ws.on('close', () => {
    console.log(`⚠️ Depth WS desconectado: ${symbol} — reconectando en 5s`);
    delete wsDepthConnections[symbol];
    setTimeout(() => connectDepthWebSocket(symbol), 5000);
  });

  ws.on('error', (e) => {
    console.log(`❌ Depth WS error ${symbol}: ${e.message}`);
    ws.terminate();
  });
}

// ── PASO 2: Detectar paredes grandes en el book ───────────────────
function findBigWalls(symbol) {
  const book = bookState[symbol];
  if (!book || !book.bids.length || !book.asks.length) return [];

  const walls = [];

  // Calcular promedio de qty en bids y asks
  const bidAvg = book.bids.reduce((s, b) => s + b.qty, 0) / book.bids.length;
  const askAvg = book.asks.reduce((s, a) => s + a.qty, 0) / book.asks.length;

  // Umbral mínimo absoluto — BTC: 1 BTC, ETH: 10 ETH
  const minQty = symbol.includes('BTC') ? 1 : symbol.includes('ETH') ? 10 : 1;

  // Pared = qty > 5x el promedio Y > umbral mínimo
  for (const bid of book.bids) {
    if (bid.qty >= minQty && bid.qty > bidAvg * 5) {
      walls.push({ price: bid.price, qty: bid.qty, side: 'bid', avgQty: bidAvg });
    }
  }
  for (const ask of book.asks) {
    if (ask.qty >= minQty && ask.qty > askAvg * 5) {
      walls.push({ price: ask.price, qty: ask.qty, side: 'ask', avgQty: askAvg });
    }
  }

  return walls;
}

// ── PASO 3 + 4: Evaluar paredes — anti-spoof + absorción ─────────
const wallEvalThrottle = {};
function evaluateWalls(symbol) {
  if (!WALL_ENABLED) return;
  const now = Date.now();
  // Throttle — evaluar máximo cada 2 segundos por símbolo
  if (wallEvalThrottle[symbol] && now - wallEvalThrottle[symbol] < 2000) return;
  wallEvalThrottle[symbol] = now;
  const walls = findBigWalls(symbol);
  const currentPrice = wsState[symbol]?.lastPrice;
  if (!currentPrice) return;

  // Limpiar paredes viejas (>60s sin aparecer)
  if (wallTracker[symbol]) {
    for (const key of Object.keys(wallTracker[symbol])) {
      if (now - wallTracker[symbol][key].lastSeen > 60000) {
        delete wallTracker[symbol][key];
      }
    }
  } else {
    wallTracker[symbol] = {};
  }

  // Actualizar tracker con paredes actuales
  for (const wall of walls) {
    const key = `${wall.side}_${Math.round(wall.price)}`;
    if (!wallTracker[symbol][key]) {
      // Primera vez que vemos esta pared
      wallTracker[symbol][key] = {
        price: wall.price,
        qty: wall.qty,
        avgQty: wall.avgQty,
        side: wall.side,
        firstSeen: now,
        lastSeen: now,
        maxQty: wall.qty,
        minQty: wall.qty,
      };
    } else {
      // Actualizar pared existente
      const w = wallTracker[symbol][key];
      w.lastSeen = now;
      w.qty = wall.qty;
      w.minQty = Math.min(w.minQty, wall.qty);
      w.maxQty = Math.max(w.maxQty, wall.qty);
    }
  }

  // Evaluar paredes confirmadas (>10s en el book = anti-spoof)
  const ANTISPOOF_MS = 15000;  // v4.4.33: 15s más tiempo para descartar spoofs
  const NEAR_THRESHOLD = symbol.includes('BTC') ? 0.0008 : 0.0012;

  for (const [key, wall] of Object.entries(wallTracker[symbol] || {})) {
    const age = now - wall.firstSeen;
    if (age < ANTISPOOF_MS) continue; // aún en período anti-spoof

    // ¿El precio está cerca de la pared?
    const distPct = Math.abs(currentPrice - wall.price) / currentPrice;
    if (distPct > NEAR_THRESHOLD) continue;

    // PASO 4: Medir absorción
    // ¿Cuánto volumen agresivo golpeó este nivel en los últimos 10s?
    const recentTrades = wsState[symbol]?.trades?.filter(t => now - t.time < 10000) || [];
    const wallPriceRange = wall.price * 0.0005; // ±0.05% del nivel

    let aggressiveVol = 0;
    for (const trade of recentTrades) {
      if (Math.abs(trade.price - wall.price) <= wallPriceRange) {
        // Trade agresivo en el nivel de la pared
        if (wall.side === 'bid' && !trade.isBuy) aggressiveVol += trade.usdVal; // vendedores golpeando bid
        if (wall.side === 'ask' && trade.isBuy)  aggressiveVol += trade.usdVal; // compradores golpeando ask
      }
    }

    const wallUsdVal = wall.price * wall.qty;
    const absorptionPct = wallUsdVal > 0 ? (aggressiveVol / wallUsdVal) * 100 : 0;

    // Decisión de absorción:
    // < 30% comida → pared sostuvo → rebote → ENTRAR
    // > 50% comida → pared perforando → NO entrar
    // 30-50%       → indefinido → NO entrar

    if (absorptionPct > 15) {
      continue; // v4.4.33: absorción >15% = pared bajo ataque, ganadores tienen promedio 8% — no entrar
    }

    // Pared sostuvo con <30% absorción → rebote confirmado
    const direction = wall.side === 'bid' ? 'LONG' : 'SHORT';
    const strength = wall.avgQty > 0 ? wall.qty / wall.avgQty : wall.qty;

    // Disparar señal de entrada (async, no bloquea el loop)
    processWallSignal(symbol, wall, direction, strength, absorptionPct, currentPrice).catch(() => {});

    // Marcar pared como procesada para evitar doble entrada
    delete wallTracker[symbol][key];
  }
}

// ── PASO 5: Procesar señal y abrir trade ─────────────────────────
async function processWallSignal(symbol, wall, direction, strength, absorptionPct, price) {
  try {
    const now = Date.now();

    // Lock en memoria — evita trades duplicados simultáneos
    if (wallOpeningLock[symbol]) return;
    wallOpeningLock[symbol] = true;

    // Cooldown 10 min por símbolo
    if (wallAbsorptionCooldown[symbol] && now - wallAbsorptionCooldown[symbol] < 10 * 60 * 1000) {
      wallOpeningLock[symbol] = false; return;
    }

    // No abrir si ya hay trade abierto
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
    if (existing?.length) { wallOpeningLock[symbol] = false; return; }

    // Fix 1 — bias_1d + bias_1h: permite pullbacks en tendencia
    // bias_1d define contexto macro, bias_1h confirma si hay corrección activa
    try {
      const [k1dWall, k1hWall] = await Promise.all([
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=50`),
      ]);
      const bias1dWall = calcBias(k1dWall.data, null, 0);
      const bias1hWall = calcBias(k1hWall.data, null, 0);
      if (bias1dWall && bias1hWall) {
        const trend1d_up   = bias1dWall.bias === 'long'  || bias1dWall.score > 58;
        const trend1d_down = bias1dWall.bias === 'short' || bias1dWall.score < 42;
        const pullback_down = bias1hWall.score < 40;  // 1H claramente bajista = pullback en alcista
        const pullback_up   = bias1hWall.score > 60;  // 1H claramente alcista = rebote en bajista

        // SHORT bloqueado si: 1D alcista Y 1H también alcista (no hay pullback)
        if (direction === 'SHORT' && trend1d_up && !pullback_down) {
          console.log(`Wall v2 SHORT omitido — bias_1d alcista (${bias1dWall.score}) sin pullback 1H (${bias1hWall.score}) (${symbol})`);
          wallOpeningLock[symbol] = false; return;
        }
        // LONG bloqueado si: 1D bajista Y 1H también bajista (no hay rebote)
        if (direction === 'LONG' && trend1d_down && !pullback_up) {
          console.log(`Wall v2 LONG omitido — bias_1d bajista (${bias1dWall.score}) sin rebote 1H (${bias1hWall.score}) (${symbol})`);
          wallOpeningLock[symbol] = false; return;
        }
      }
    } catch(_) {}

    // Fix 2 — tamaño mínimo de pared y strength mínimo 5x
    const minWallUsd = symbol.includes('BTC') ? 5000000 : 2000000; // v4.4.33: $5M BTC, $2M ETH — datos muestran paredes pequeñas tienen WR 21%
    const wallUsdCheck = wall.price * wall.qty;
    if (wallUsdCheck < minWallUsd) {
      console.log(`Wall v2 omitido — pared muy pequeña $${(wallUsdCheck/1e6).toFixed(2)}M < $${minWallUsd/1e6}M (${symbol})`);
      wallOpeningLock[symbol] = false; return;
    }
    if (strength < 5) {
      console.log(`Wall v2 omitido — strength ${strength.toFixed(1)}x < 5x (${symbol})`);
      return;
    }

    // Calcular SL y TP
    const slPct = symbol.includes('BTC') ? 0.0012 : 0.0015;
    const wallLevel = wall.price;
    const sl = direction === 'LONG' ? wallLevel * (1 - slPct) : wallLevel * (1 + slPct);

    // TP = nivel significativo más cercano en la dirección del trade
    const book = bookState[symbol];
    let tp1 = null;
    if (direction === 'LONG' && book?.asks?.length) {
      const nextAsk = book.asks.filter(a => a.price > price * 1.001 && a.qty > 0.5).sort((a, b) => a.price - b.price)[0];
      tp1 = nextAsk ? nextAsk.price : price * (1 + slPct * 2.5);
    } else if (book?.bids?.length) {
      const nextBid = book.bids.filter(b => b.price < price * 0.999 && b.qty > 0.5).sort((a, b) => b.price - a.price)[0];
      tp1 = nextBid ? nextBid.price : price * (1 - slPct * 2.5);
    }
    if (!tp1) tp1 = direction === 'LONG' ? price * (1 + slPct * 2.5) : price * (1 - slPct * 2.5);

    const rrVal = Math.abs(tp1 - price) / Math.abs(sl - price);
    if (rrVal < 1.2) {
      console.log(`Wall v2 descartado — RR ${rrVal.toFixed(2)} < 1.2 (${symbol})`);
      return;
    }

    wallAbsorptionCooldown[symbol] = now;
    wallOpeningLock[symbol] = false;

    const wallUsd = wall.price * wall.qty;
    const wallUsdStr = wallUsd >= 1e6 ? `$${(wallUsd/1e6).toFixed(1)}M` : `$${(wallUsd/1e3).toFixed(0)}K`;
    const wallConf = Math.min(88, Math.round(75 + (rrVal >= 1.5 ? 8 : 3) + (strength >= 8 ? 5 : 0)));
    const wallSide = wall.side === 'ask' ? 'ASK' : 'BID';

    await supabase.from('paper_trades').insert({
      symbol, direction, entry: price, tp1, tp2: tp1, sl,
      rr: `1:${rrVal.toFixed(1)}`, confidence: wallConf,
      size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'),
      leverage: parseInt(process.env.PAPER_LEVERAGE || '5'),
      source: 'wall', status: 'open',
      opened_at: new Date().toISOString(),
      market_data: {
        mode: 'wall_absorption_v2',
        wall_side: wallSide,
        wall_price: wallLevel,
        wall_usd: wallUsd,
        wall_strength: strength,
        wall_age_ms: now - wall.firstSeen,
        absorption_pct: parseFloat(absorptionPct.toFixed(1)),
        timestamp: new Date().toISOString(),
      }
    });

    console.log(`Wall v2: ${direction} ${symbol} @ $${price.toFixed(1)} pared ${wallSide} $${wallLevel} (${wallUsdStr}) strength:${strength.toFixed(1)}x absorcion:${absorptionPct.toFixed(0)}% RR 1:${rrVal.toFixed(1)}`);

    if (process.env.TELEGRAM_CHAT_ID) {
      const e = direction === 'LONG' ? 'LONG' : 'SHORT';
      const _dWl=new Date(), _limaWl=`🕐 Apertura: ${_dWl.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dWl.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
      const msg = `Wall Absorption v2 - ${symbol}\n${e} @ $${parseInt(price).toLocaleString()}\nTP: $${parseInt(tp1).toLocaleString()} | SL: $${parseInt(sl).toLocaleString()}\nRR 1:${rrVal.toFixed(1)} | ${wallConf}%\nPared ${wallSide}: $${parseInt(wallLevel).toLocaleString()} (${wallUsdStr})\nStrength: ${strength.toFixed(1)}x | Absorcion: ${absorptionPct.toFixed(0)}%\n${_limaWl}\nFuente: 🧱 Wall`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg); } catch(e) { console.error("Telegram send error:", e.message); }
    }

  } catch(_) { wallOpeningLock[symbol] = false; }
}

// Endpoint para ver estado del módulo Wall v2
app.get('/api/wall/status', (req, res) => {
  const status = {};
  for (const symbol of Object.keys(wsState)) {
    const cdMs = wallAbsorptionCooldown[symbol]
      ? Math.max(0, 10*60*1000 - (Date.now() - wallAbsorptionCooldown[symbol]))
      : 0;
    const walls = Object.values(wallTracker[symbol] || {});
    const confirmed = walls.filter(w => Date.now() - w.firstSeen >= 10000);
    status[symbol] = {
      lastPrice: wsState[symbol]?.lastPrice || 0,
      depthConnected: !!wsDepthConnections[symbol],
      wallsTracked: walls.length,
      wallsConfirmed: confirmed.length,
      cooldownMin: (cdMs/60000).toFixed(1),
      active: cdMs === 0,
    };
  }
  res.json({ module: 'Wall Absorption v2', version: '4.4.24', status });
});


// ══════════════════════════════════════════════════════════════════
// ─── MÓDULO BACKTEST — Scalping y Sweep sobre datos históricos ────
// ══════════════════════════════════════════════════════════════════

function btCalcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round(100 - 100 / (1 + rs));
}

function btCalcCVD(klines) {
  // CVD aproximado: si close > open → compra, sino venta
  const recent = klines.slice(-10);
  let buyVol = 0, sellVol = 0;
  for (const k of recent) {
    const vol = parseFloat(k[5]);
    if (parseFloat(k[4]) >= parseFloat(k[1])) buyVol += vol;
    else sellVol += vol;
  }
  const total = buyVol + sellVol;
  return total > 0 ? ((buyVol - sellVol) / total * 100) : 0;
}

function btCalcImbalance(klines) {
  const recent = klines.slice(-5);
  let buyVol = 0, sellVol = 0;
  for (const k of recent) {
    const vol = parseFloat(k[5]);
    if (parseFloat(k[4]) >= parseFloat(k[1])) buyVol += vol;
    else sellVol += vol;
  }
  const total = buyVol + sellVol;
  return total > 0 ? ((buyVol - sellVol) / total * 100) : 0;
}

function btCalcATR(klines, period = 10) {
  if (klines.length < period + 1) return parseFloat(klines[0][4]) * 0.005;
  let atrSum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const high = parseFloat(klines[i][2]), low = parseFloat(klines[i][3]);
    const prevClose = parseFloat(klines[i - 1][4]);
    atrSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return atrSum / period;
}

function btCalcBias1d(klines1d) {
  if (!klines1d || klines1d.length < 5) return { bias: 'neutral', score: 50 };
  const closes = klines1d.map(k => parseFloat(k[4]));
  const rsi = btCalcRSI(closes, 14);
  const last = closes[closes.length - 1];
  const prev5 = closes[closes.length - 6];
  const pricePct = (last - prev5) / prev5 * 100;
  let score = 50;
  if (pricePct > 3) score += 20; else if (pricePct > 1) score += 10;
  else if (pricePct < -3) score -= 20; else if (pricePct < -1) score -= 10;
  if (rsi > 60) score += 15; else if (rsi < 40) score -= 15;
  score = Math.max(0, Math.min(100, score));
  const bias = score > 58 ? 'long' : score < 42 ? 'short' : 'neutral';
  return { bias, score };
}

function btCalcBias4h(klines4h) {
  if (!klines4h || klines4h.length < 5) return { bias: 'neutral', score: 50 };
  const closes = klines4h.map(k => parseFloat(k[4]));
  const rsi = btCalcRSI(closes, 14);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 5];
  const pricePct = (last - prev) / prev * 100;
  let score = 50;
  if (pricePct > 1) score += 15; else if (pricePct < -1) score -= 15;
  if (rsi > 60) score += 10; else if (rsi < 40) score -= 10;
  score = Math.max(0, Math.min(100, score));
  return { bias: score > 58 ? 'long' : score < 42 ? 'short' : 'neutral', score };
}

function btCalcBias1h(klines1h) {
  if (!klines1h || klines1h.length < 5) return { bias: 'neutral', score: 50 };
  const closes = klines1h.map(k => parseFloat(k[4]));
  const rsi = btCalcRSI(closes, 14);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 4];
  const pricePct = (last - prev) / prev * 100;
  let score = 50;
  if (pricePct > 0.5) score += 15; else if (pricePct < -0.5) score -= 15;
  if (rsi > 60) score += 10; else if (rsi < 40) score -= 10;
  score = Math.max(0, Math.min(100, score));
  return { bias: score > 55 ? 'long' : score < 45 ? 'short' : 'neutral', score };
}

function simulateScalpEntry(klines3m, klines4h, klines1h, idx, params) {
  const { rsiMin, rsiMax, minImbalance, momentumPct, volMultMin } = params;
  const window3m = klines3m.slice(0, idx + 1);
  if (window3m.length < 20) return null;

  const closes = window3m.map(k => parseFloat(k[4]));
  const rsi = btCalcRSI(closes, 14);
  const cvd = btCalcCVD(window3m);
  const imb = btCalcImbalance(window3m);
  const price = parseFloat(window3m[window3m.length - 1][4]);

  // Simular momentum con diferencia de precio en últimas 20 velas de 3m = 60s
  const prevPrice = parseFloat(window3m[window3m.length - 5]?.[4] || window3m[0][4]);
  const movePct = (price - prevPrice) / prevPrice * 100;

  const bias4h = btCalcBias4h(klines4h.slice(0, Math.floor(idx / 80) + 1));
  const bias1h = btCalcBias1h(klines1h.slice(0, Math.floor(idx / 20) + 1));

  // Determinar dirección
  let longScore = 50, shortScore = 50;
  if (cvd > 10) longScore += 25; else if (cvd < -10) shortScore += 25;
  if (imb > 20) longScore += 30; else if (imb < -20) shortScore += 30;
  if (rsi < 40) longScore += 15; else if (rsi > 60) shortScore += 15;

  const totalScore = longScore + shortScore;
  const scalpDir = longScore > shortScore ? 'LONG' : 'SHORT';
  const scalpProb = Math.round((Math.max(longScore, shortScore) / Math.max(totalScore, 1)) * 100);

  if (scalpProb < 88) return null;
  if (rsi > rsiMax && scalpDir === 'SHORT') return null;
  if (rsi < rsiMin && scalpDir === 'LONG') return null;
  if (Math.abs(imb) < minImbalance) return null;
  if (scalpDir === 'LONG' && imb < 0) return null;
  if (scalpDir === 'SHORT' && imb > 0) return null;

  // Fix C — momentum
  const needsUp = scalpDir === 'LONG' && movePct < momentumPct;
  const needsDown = scalpDir === 'SHORT' && movePct > -momentumPct;
  if (needsUp || needsDown) return null;

  // Pullback 4H+1H
  const isPullback = (bias4h.bias === 'long' && bias1h.bias === 'short') ||
                     (bias4h.bias === 'short' && bias1h.bias === 'long');
  if (!isPullback && (bias4h.score > 70 || bias4h.score < 30)) return null;

  const atr = btCalcATR(window3m);
  const sl = scalpDir === 'LONG' ? price - Math.max(atr * 0.8, price * 0.008)
                                  : price + Math.max(atr * 0.8, price * 0.008);
  const tp = scalpDir === 'LONG' ? price + atr * 1.5 : price - atr * 1.5;
  const rr = Math.abs(tp - price) / Math.abs(sl - price);
  if (rr < 1.5) return null;

  return { dir: scalpDir, entry: price, tp, sl, rr, idx };
}

function simulateSweepEntry(klines15m, klines1d, idx, params) {
  const { minVolMult, minCVD, bias1dScoreBlock } = params;
  const window = klines15m.slice(0, idx + 1);
  if (window.length < 20) return null;

  const closes = window.map(k => parseFloat(k[4]));
  const volumes = window.map(k => parseFloat(k[5]));
  const cvd = btCalcCVD(window);
  const price = parseFloat(window[window.length - 1][4]);
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];
  const volMult = lastVol / Math.max(avgVol, 0.001);

  if (volMult < minVolMult) return null;
  if (Math.abs(cvd) < minCVD) return null;

  // Verificar precio moviéndose
  const prev = parseFloat(window[window.length - 4]?.[4] || window[0][4]);
  const movePct = Math.abs((price - prev) / prev * 100);
  if (movePct < 0.5) return null;

  const dir = cvd > 0 ? 'LONG' : 'SHORT';

  // Fix B — bias_1d bloquea
  const bias1d = btCalcBias1d(klines1d.slice(0, Math.floor(idx / 96) + 1));
  const blockShort = bias1d.bias === 'long' || bias1d.score > bias1dScoreBlock;
  const blockLong = bias1d.bias === 'short' || bias1d.score < (100 - bias1dScoreBlock);
  if (dir === 'SHORT' && blockShort) return null;
  if (dir === 'LONG' && blockLong) return null;

  // Fix C2 — confirmación precio 5 velas (75min ~ 5min original)
  const prev5 = parseFloat(window[window.length - 5]?.[4] || window[0][4]);
  const move5 = (price - prev5) / prev5 * 100;
  if (dir === 'SHORT' && move5 > -0.1) return null;
  if (dir === 'LONG' && move5 < 0.1) return null;

  const atr = btCalcATR(window);
  const sl = dir === 'LONG' ? price - atr * 0.8 : price + atr * 0.8;
  const tp = dir === 'LONG' ? price + atr * 1.2 : price - atr * 1.2;
  const rr = Math.abs(tp - price) / Math.abs(sl - price);
  if (rr < 1.5) return null;

  return { dir, entry: price, tp, sl, rr, idx };
}

function simulateTrade(klines, trade, startIdx) {
  for (let i = startIdx + 1; i < Math.min(startIdx + 100, klines.length); i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    if (trade.dir === 'LONG') {
      if (high >= trade.tp) return { status: 'won', exitIdx: i, exitPrice: trade.tp };
      if (low <= trade.sl) return { status: 'lost', exitIdx: i, exitPrice: trade.sl };
    } else {
      if (low <= trade.tp) return { status: 'won', exitIdx: i, exitPrice: trade.tp };
      if (high >= trade.sl) return { status: 'lost', exitIdx: i, exitPrice: trade.sl };
    }
  }
  return { status: 'timeout', exitIdx: startIdx + 100, exitPrice: parseFloat(klines[Math.min(startIdx + 99, klines.length - 1)][4]) };
}

// ── Backtest modo MOMENTUM — volume spike A FAVOR de la tendencia ──
// Opuesto a mean reversion: el spike continúa en la dirección de la tendencia
function simulateMomentumEntry(klines15m, klines1d, idx, params = {}) {
  const { baseVolMult = 5 } = params;
  const window = klines15m.slice(0, idx + 1);
  if (window.length < 30) return null;

  const volumes = window.map(k => parseFloat(k[5]));
  const closes  = window.map(k => parseFloat(k[4]));
  const price   = closes[closes.length - 1];

  const avgVol  = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];
  const volMult = avgVol > 0 ? lastVol / avgVol : 0;
  if (volMult < baseVolMult) return null;

  const d1idx = Math.min(Math.floor(idx / 96), klines1d.length - 1);
  if (d1idx < 5) return null;
  const bias1d = btCalcBias1d(klines1d.slice(0, d1idx + 1));

  // MOMENTUM: spike en downtrend → SHORT, en uptrend → LONG
  let dir = null;
  if (bias1d.bias === 'short' || bias1d.score < 42) dir = 'SHORT';
  else if (bias1d.bias === 'long' || bias1d.score > 58) dir = 'LONG';
  else return null;

  const atr = btCalcATR(window, 14);
  const sl  = dir === 'LONG' ? price - atr * 1.0 : price + atr * 1.0;
  const tp  = dir === 'LONG' ? price + atr * 1.5 : price - atr * 1.5;
  const rr  = Math.abs(tp - price) / Math.abs(sl - price);
  if (rr < 1.2) return null;

  return { dir, entry: price, tp, sl, rr, volMult, bias1dScore: bias1d.score, idx };
}

// ── Backtest modo BASE — volume spike + tendencia en 15m ──────────
// Usa velas de 15m para capturar mejor el timing del sweep/wall
// Tendencia 1D como contexto macro — mean reversion como edge
function simulateBaseEntry(klines15m, klines1d, idx, params = {}) {
  const { baseVolMult = 5 } = params;
  const window = klines15m.slice(0, idx + 1);
  if (window.length < 30) return null;

  const volumes = window.map(k => parseFloat(k[5]));
  const closes  = window.map(k => parseFloat(k[4]));
  const price   = closes[closes.length - 1];

  // Volume spike: última vela > baseVolMult x promedio últimas 20 velas
  const avgVol  = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];
  const volMult = avgVol > 0 ? lastVol / avgVol : 0;
  if (volMult < baseVolMult) return null;

  // Tendencia 1D — 1 vela diaria = 96 velas de 15m
  const d1idx = Math.min(Math.floor(idx / 96), klines1d.length - 1);
  if (d1idx < 5) return null;
  const bias1d = btCalcBias1d(klines1d.slice(0, d1idx + 1));

  // Mean reversion: spike en downtrend → LONG, en uptrend → SHORT
  let dir = null;
  if (bias1d.bias === 'short' || bias1d.score < 42) dir = 'LONG';
  else if (bias1d.bias === 'long' || bias1d.score > 58) dir = 'SHORT';
  else return null;

  // SL y TP basados en ATR de 15m
  const atr = btCalcATR(window, 14);
  const sl  = dir === 'LONG' ? price - atr * 1.0 : price + atr * 1.0;
  const tp  = dir === 'LONG' ? price + atr * 1.5 : price - atr * 1.5;
  const rr  = Math.abs(tp - price) / Math.abs(sl - price);
  if (rr < 1.2) return null;

  return { dir, entry: price, tp, sl, rr, volMult, bias1dScore: bias1d.score, idx };
}


// ── Backtest modo FILTERED — aplica todos los filtros del sistema real ──
// Replica exactamente la lógica de sweep/whale con datos históricos de 15m
// Fix A: vol mínimo 4x | Fix B: bias_1d + bias_1h | CVD + price move

function simulateFilteredEntry(klines15m, klines1d, klines1h, idx, params = {}) {
  const {
    baseVolMult = 4,       // Fix A — vol mínimo 4x
    bias1dScore = 58,      // Fix B — score umbral 1D
    bias1hScore = 40,      // Fix B2 — score umbral 1H para pullback
    minCVD = 25,           // CVD mínimo en dirección
    minPriceMove = 0.1,    // confirmación precio 5 velas (C2)
  } = params;

  const window15m = klines15m.slice(0, idx + 1);
  if (window15m.length < 30) return null;

  const volumes = window15m.map(k => parseFloat(k[5]));
  const closes  = window15m.map(k => parseFloat(k[4]));
  const price   = closes[closes.length - 1];

  // Fix A — Volume spike mínimo
  const avgVol  = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];
  const volMult = avgVol > 0 ? lastVol / avgVol : 0;
  if (volMult < baseVolMult) return null;

  // CVD aproximado: compras vs ventas en últimas 5 velas
  const last5 = window15m.slice(-5);
  let buyVol = 0, sellVol = 0;
  for (const k of last5) {
    const v = parseFloat(k[5]);
    if (parseFloat(k[4]) >= parseFloat(k[1])) buyVol += v;
    else sellVol += v;
  }
  const totalVol = buyVol + sellVol;
  const cvdPct = totalVol > 0 ? (buyVol - sellVol) / totalVol * 100 : 0;

  // Dirección basada en CVD
  let dir = null;
  if (cvdPct < -minCVD) dir = 'SHORT';      // vendedores dominan → SHORT
  else if (cvdPct > minCVD) dir = 'LONG';   // compradores dominan → LONG
  else return null;

  // C2 — Confirmación de precio en últimas 5 velas
  const prev5Price = parseFloat(window15m[window15m.length - 6]?.[4] || window15m[0][4]);
  const priceMove = (price - prev5Price) / prev5Price * 100;
  if (dir === 'SHORT' && priceMove > -minPriceMove) return null;
  if (dir === 'LONG'  && priceMove < minPriceMove) return null;

  // Fix B — bias_1d bloquea si mercado en tendencia contraria
  const d1idx = Math.min(Math.floor(idx / 96), klines1d.length - 1);
  if (d1idx < 5) return null;
  const bias1d = btCalcBias1d(klines1d.slice(0, d1idx + 1));
  if (!bias1d) return null;

  const trend1d_up   = bias1d.bias === 'long'  || bias1d.score > bias1dScore;
  const trend1d_down = bias1d.bias === 'short' || bias1d.score < (100 - bias1dScore);

  // Fix B2 — bias_1h: permite pullbacks en tendencia
  const h1idx = Math.min(Math.floor(idx / 4), klines1h.length - 1);
  if (h1idx < 5) return null;
  const bias1h = btCalcBias1h(klines1h.slice(0, h1idx + 1));
  if (!bias1h) return null;

  const pullback_down = bias1h.score < bias1hScore;   // 1H bajista = pullback en alcista
  const pullback_up   = bias1h.score > (100 - bias1hScore); // 1H alcista = rebote en bajista

  // Bloquear si: 1D alcista Y 1H también alcista (sin pullback real)
  if (dir === 'SHORT' && trend1d_up && !pullback_down) return null;
  // Bloquear si: 1D bajista Y 1H también bajista (sin rebote real)
  if (dir === 'LONG'  && trend1d_down && !pullback_up) return null;

  // SL y TP basados en ATR de 15m
  const atr = btCalcATR(window15m, 14);
  const sl  = dir === 'LONG' ? price - atr * 0.8 : price + atr * 0.8;
  const tp  = dir === 'LONG' ? price + atr * 1.2 : price - atr * 1.2;
  const rr  = Math.abs(tp - price) / Math.abs(sl - price);
  if (rr < 1.3) return null;

  return {
    dir, entry: price, tp, sl, rr,
    volMult, cvdPct: parseFloat(cvdPct.toFixed(1)),
    bias1dScore: bias1d.score, bias1hScore: bias1h.score,
    idx
  };
}

app.post('/api/backtest', async (req, res) => {
  try {
    const {
      symbol = 'BTCUSDT',
      days = 30,
      module = 'both',
      baseVolMult = 5,
      // Parámetros modo filtered
      filteredVolMult = 4,
      filteredBias1dScore = 58,
      filteredBias1hScore = 40,
      filteredMinCVD = 25,
      filteredMinPriceMove = 0.1,
      // Parámetros ajustables scalping
      scalpRsiMin = 35, scalpRsiMax = 65,
      scalpMinImbalance = 30, scalpMomentumPct = 0.05,
      // Parámetros ajustables sweep
      sweepMinVolMult = 4, sweepMinCVD = 40,
      sweepBias1dScore = 58,
    } = req.body;

    // Descargar hasta 365 días de velas 15m con múltiples requests
    const VELAS_POR_DIA_15M = 96; // 96 velas de 15m por día
    const totalVelas15m = Math.min(days * VELAS_POR_DIA_15M, 35040); // máx 365 días
    const requestsNeeded = Math.ceil(totalVelas15m / 1500);

    // Descargar velas 15m en múltiples batches desde el más antiguo al más reciente
    let klines15m = [];
    let endTime = Date.now();
    for (let r = 0; r < requestsNeeded; r++) {
      try {
        const res = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=1500&endTime=${endTime}`);
        if (!res.data?.length) break;
        klines15m = [...res.data, ...klines15m]; // prepend — más antiguo primero
        endTime = res.data[0][0] - 1; // siguiente batch termina antes del primero actual
      } catch(_) { break; }
    }
    // Limitar al período solicitado
    klines15m = klines15m.slice(-totalVelas15m);

    // Datos auxiliares para scalping y sweep (período más corto)
    const limitShort = Math.min(days * 96, 1500);
    const limit3m = Math.min(days * 480, 1500);
    const [k3m, k4h, k1h, k1d] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=3m&limit=${limit3m}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=200`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=500`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=500`),
    ]);

    const klines3m = k3m.data;
    const klines4h = k4h.data, klines1h = k1h.data, klines1d = k1d.data;
    console.log(`Backtest ${symbol}: ${klines15m.length} velas 15m (${(klines15m.length/96).toFixed(0)} días)`);

    const scalpParams = { rsiMin: scalpRsiMin, rsiMax: scalpRsiMax, minImbalance: scalpMinImbalance, momentumPct: scalpMomentumPct };
    const sweepParams = { minVolMult: sweepMinVolMult, minCVD: sweepMinCVD, bias1dScoreBlock: sweepBias1dScore };

    const results = { scalping: [], sweep: [] };
    const SIZE_USD = 1000, LEVERAGE = 5;

    // ── BACKTEST SCALPING (velas 3m)
    if (module === 'scalping' || module === 'both') {
      let inTrade = false, skipUntil = 0;
      for (let i = 50; i < klines3m.length - 10; i++) {
        if (i < skipUntil) continue;
        if (inTrade) continue;
        const entry = simulateScalpEntry(klines3m, klines4h, klines1h, i, scalpParams);
        if (!entry) continue;
        const result = simulateTrade(klines3m, entry, i);
        const pnl = result.status === 'won'
          ? SIZE_USD * LEVERAGE * Math.abs(entry.tp - entry.entry) / entry.entry
          : result.status === 'lost'
          ? -SIZE_USD * LEVERAGE * Math.abs(entry.entry - entry.sl) / entry.entry
          : 0;
        results.scalping.push({
          time: new Date(klines3m[i][0]).toISOString(),
          dir: entry.dir, entry: entry.entry, tp: entry.tp, sl: entry.sl,
          rr: entry.rr.toFixed(2), status: result.status, pnl: parseFloat(pnl.toFixed(2)),
        });
        skipUntil = result.exitIdx + 5;
      }
    }

    // ── BACKTEST SWEEP (velas 15m)
    if (module === 'sweep' || module === 'both') {
      let skipUntil = 0;
      for (let i = 30; i < klines15m.length - 10; i++) {
        if (i < skipUntil) continue;
        const entry = simulateSweepEntry(klines15m, klines1d, i, sweepParams);
        if (!entry) continue;
        const result = simulateTrade(klines15m, entry, i);
        const pnl = result.status === 'won'
          ? SIZE_USD * LEVERAGE * Math.abs(entry.tp - entry.entry) / entry.entry
          : result.status === 'lost'
          ? -SIZE_USD * LEVERAGE * Math.abs(entry.entry - entry.sl) / entry.entry
          : 0;
        results.sweep.push({
          time: new Date(klines15m[i][0]).toISOString(),
          dir: entry.dir, entry: entry.entry, tp: entry.tp, sl: entry.sl,
          rr: entry.rr.toFixed(2), status: result.status, pnl: parseFloat(pnl.toFixed(2)),
        });
        skipUntil = result.exitIdx + 3;
      }
    }

    // ── Calcular estadísticas
    function calcStats(trades) {
      if (!trades.length) return { total: 0, won: 0, lost: 0, winRate: 0, totalPnl: 0, profitFactor: 0, avgWin: 0, avgLoss: 0, maxDrawdown: 0 };
      const won = trades.filter(t => t.status === 'won');
      const lost = trades.filter(t => t.status === 'lost');
      const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
      const grossWin = won.reduce((s, t) => s + t.pnl, 0);
      const grossLoss = Math.abs(lost.reduce((s, t) => s + t.pnl, 0));
      let peak = 0, equity = 0, maxDD = 0;
      for (const t of trades) {
        equity += t.pnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDD) maxDD = dd;
      }
      return {
        total: trades.length,
        won: won.length, lost: lost.length,
        winRate: Math.round(won.length / trades.length * 100),
        totalPnl: parseFloat(totalPnl.toFixed(2)),
        profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0,
        avgWin: won.length ? parseFloat((grossWin / won.length).toFixed(2)) : 0,
        avgLoss: lost.length ? parseFloat((grossLoss / lost.length).toFixed(2)) : 0,
        maxDrawdown: parseFloat(maxDD.toFixed(2)),
      };
    }

    // ── BACKTEST MOMENTUM (volume spike a favor de tendencia)
    if (module === 'momentum') {
      let skipUntilMom = 0;
      for (let i = 30; i < klines15m.length - 10; i++) {
        if (i < skipUntilMom) continue;
        try {
          const entry = simulateMomentumEntry(klines15m, klines1d, i, { baseVolMult });
          if (!entry) continue;
          const result = simulateTrade(klines15m, entry, i);
          const pnl = result.status === 'won'
            ? SIZE_USD * LEVERAGE * Math.abs(entry.tp - entry.entry) / entry.entry
            : result.status === 'lost'
            ? -SIZE_USD * LEVERAGE * Math.abs(entry.entry - entry.sl) / entry.entry
            : 0;
          results.momentum = results.momentum || [];
          results.momentum.push({
            time: new Date(klines15m[i][0]).toISOString(),
            dir: entry.dir, entry: entry.entry, tp: entry.tp, sl: entry.sl,
            rr: entry.rr.toFixed(2), status: result.status,
            pnl: parseFloat(pnl.toFixed(2)),
            volMult: entry.volMult.toFixed(1),
            bias1dScore: entry.bias1dScore,
          });
          skipUntilMom = result.exitIdx + 2;
        } catch(_) {}
      }
    }

    // ── BACKTEST FILTERED — todos los filtros del sistema real
    if (module === 'filtered') {
      const filteredParams = {
        baseVolMult: filteredVolMult,
        bias1dScore: filteredBias1dScore,
        bias1hScore: filteredBias1hScore,
        minCVD: filteredMinCVD,
        minPriceMove: filteredMinPriceMove,
      };
      let skipUntilFilt = 0;
      for (let i = 30; i < klines15m.length - 10; i++) {
        if (i < skipUntilFilt) continue;
        try {
          const entry = simulateFilteredEntry(klines15m, klines1d, klines1h, i, filteredParams);
          if (!entry) continue;
          const result = simulateTrade(klines15m, entry, i);
          const pnl = result.status === 'won'
            ? SIZE_USD * LEVERAGE * Math.abs(entry.tp - entry.entry) / entry.entry
            : result.status === 'lost'
            ? -SIZE_USD * LEVERAGE * Math.abs(entry.entry - entry.sl) / entry.entry
            : 0;
          results.filtered = results.filtered || [];
          results.filtered.push({
            time: new Date(klines15m[i][0]).toISOString(),
            dir: entry.dir, entry: entry.entry, tp: entry.tp, sl: entry.sl,
            rr: entry.rr.toFixed(2), status: result.status,
            pnl: parseFloat(pnl.toFixed(2)),
            volMult: entry.volMult.toFixed(1),
            cvdPct: entry.cvdPct,
            bias1dScore: entry.bias1dScore,
            bias1hScore: entry.bias1hScore,
          });
          skipUntilFilt = result.exitIdx + 2;
        } catch(_) {}
      }
    }

    // ── BACKTEST BASE (volume spike + mean reversion en 15m)
    if (module === 'base' || module === 'both') {
      let skipUntilBase = 0;
      for (let i = 30; i < klines15m.length - 10; i++) {
        if (i < skipUntilBase) continue;
        const entry = simulateBaseEntry(klines15m, klines1d, i, { baseVolMult });
        if (!entry) continue;
        const result = simulateTrade(klines15m, entry, i);
        const pnl = result.status === 'won'
          ? SIZE_USD * LEVERAGE * Math.abs(entry.tp - entry.entry) / entry.entry
          : result.status === 'lost'
          ? -SIZE_USD * LEVERAGE * Math.abs(entry.entry - entry.sl) / entry.entry
          : 0;
        results.base = results.base || [];
        results.base.push({
          time: new Date(klines15m[i][0]).toISOString(),
          dir: entry.dir, entry: entry.entry, tp: entry.tp, sl: entry.sl,
          rr: entry.rr.toFixed(2), status: result.status,
          pnl: parseFloat(pnl.toFixed(2)),
          volMult: entry.volMult.toFixed(1),
          bias1dScore: entry.bias1dScore,
        });
        skipUntilBase = result.exitIdx + 2;
      }
    }

    // Calcular z-score para validación estadística
    function calcZScore(trades) {
      if (!trades || trades.length < 30) return null;
      const n = trades.length;
      const won = trades.filter(t => t.status === 'won').length;
      const wr = won / n;
      const p0 = 0.5; // hipótesis nula: 50% WR
      const z = (wr - p0) / Math.sqrt(p0 * (1 - p0) / n);
      return parseFloat(z.toFixed(2));
    }

    const response = {
      symbol, days, params: { scalping: scalpParams, sweep: sweepParams, baseVolMult },
      scalping: { stats: calcStats(results.scalping), trades: results.scalping.slice(-50) },
      sweep: { stats: calcStats(results.sweep), trades: results.sweep.slice(-50) },
      base: results.base ? {
        stats: { ...calcStats(results.base), zScore: calcZScore(results.base), n: results.base.length },
        trades: results.base.slice(-50)
      } : null,
      momentum: results.momentum ? {
        stats: { ...calcStats(results.momentum), zScore: calcZScore(results.momentum), n: results.momentum.length },
        trades: results.momentum.slice(-50)
      } : null,
      filtered: results.filtered ? {
        stats: { ...calcStats(results.filtered), zScore: calcZScore(results.filtered), n: results.filtered.length },
        trades: results.filtered.slice(-50)
      } : null,
    };

    console.log(`Backtest ${symbol} ${days}d — Scalp: ${results.scalping.length} trades WR${calcStats(results.scalping).winRate}% | Sweep: ${results.sweep.length} trades WR${calcStats(results.sweep).winRate}%`);
    res.json(response);

  } catch(e) {
    console.error('Backtest error:', e.message);
    res.status(500).json({ error: e.message });
  }
});



// ══════════════════════════════════════════════════════════════════
// ─── MÓDULO MEAN REVERSION — Volume Spike + Agotamiento de tendencia
// ══════════════════════════════════════════════════════════════════
// Basado en Samael Zero v4 con Z-scores BTC=7.20, ETH=7.42
// Lógica: 1H cayó/subió >1% + volume spike >3x en 1m → mean reversion
// SL: 0.3% fijo | TP: 1.0% fijo | R:R 1:3.3 | Exit máx: 60min BTC, 45min ETH

const meanRevCooldown = {};
const MEANREV_COOLDOWN_MS = 15 * 60 * 1000; // 15 min entre trades por símbolo
const _klineCache = {};
async function getCachedKlines(symbol, interval, limit, ttlMs = 3 * 60 * 1000) {
  const key = `${symbol}|${interval}|${limit}`;
  const c = _klineCache[key];
  if (c && Date.now() - c.ts < ttlMs) return c.data;
  const res = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  _klineCache[key] = { data: res.data, ts: Date.now() };
  return res.data;
}

async function runMeanRevScanner() {
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    try {
      await detectMeanReversion(symbol);
    } catch(e) {
      console.log(`MeanRev error ${symbol}: ${e.message}`);
      if (e.response?.status === 418) { console.log(`🚫 IP ban 418 meanrev — esperando 60s`); await new Promise(r => setTimeout(r, 60000)); }
    }
  }
}

async function detectMeanReversion(symbol) {
  const now = Date.now();

  // Filtro horario
  if (isHoraBloqueada()) return;

  // Cooldown
  if (meanRevCooldown[symbol] && now - meanRevCooldown[symbol] < MEANREV_COOLDOWN_MS) return;

  // No abrir si ya hay trade abierto
  const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
  if (existing?.length) return;

  const price = wsState[symbol]?.lastPrice;
  if (!price) return;

  // ── CONDICIÓN 1: Pre-trend 1H >1% ────────────────────────────────
  // ¿El precio de 1H se movió >1% en alguna dirección?
  const k1hData = await getCachedKlines(symbol, '1h', 3);
  const h1Open  = parseFloat(k1hData[0][1]);
  const h1Close = parseFloat(k1hData[k1hData.length - 2][4]);
  const h1Move  = (h1Close - h1Open) / h1Open * 100;
  const absH1   = Math.abs(h1Move);

  if (absH1 < 1.0) return; // movimiento insuficiente en 1H

  // ── CONDICIÓN 2: Filtro 4H — no pelear contra tendencia fuerte ────
  // Si 4H va en la misma dirección que 1H con >1% → NO tradear
  const k4hData = await getCachedKlines(symbol, '4h', 2);
  const h4Open  = parseFloat(k4hData[0][1]);
  const h4Close = parseFloat(k4hData[0][4]);
  const h4Move  = (h4Close - h4Open) / h4Open * 100;

  const h1Dir = h1Move < 0 ? 'down' : 'up';
  const h4Dir = h4Move < 0 ? 'down' : 'up';

  // Si 4H va en misma dirección que 1H con fuerza → tendencia fuerte, no entrar contra ella
  if (h1Dir === h4Dir && Math.abs(h4Move) > 1.0) {
    console.log(`MeanRev ${symbol} omitido — tendencia 4H (${h4Move.toFixed(2)}%) confirma 1H (${h1Move.toFixed(2)}%) — sin reversión`);
    return;
  }

  // ── CONDICIÓN 3: Volume spike >3x mediana en velas 1m ─────────────
  const k1mData = await getCachedKlines(symbol, '1m', 21, 60 * 1000);
  const vols1m  = k1mData.map(k => parseFloat(k[5]));
  const lastVol = vols1m[vols1m.length - 1];

  // Mediana de las últimas 20 velas (excluyendo la última)
  const sorted = [...vols1m.slice(0, -1)].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const volMult = median > 0 ? lastVol / median : 0;

  if (volMult < 3) return; // spike insuficiente

  // ── DIRECCIÓN: Mean reversion contra el movimiento de 1H ──────────
  // 1H cayó >1% + spike → compradores agotaron vendedores → LONG
  // 1H subió >1% + spike → vendedores agotaron compradores → SHORT
  const direction = h1Move < -1.0 ? 'LONG' : 'SHORT';

  // ── CONDICIÓN 4: bias_1d no contradice completamente ─────────────
  const k1dData = await getCachedKlines(symbol, '1d', 30, 15 * 60 * 1000);
  const bias1d = calcBias(k1dData, null, 0);

  // Solo bloquear si 1D es extremamente contrario (score <35 para LONG o >65 para SHORT)
  if (direction === 'LONG'  && bias1d.score < 35) {
    console.log(`MeanRev LONG ${symbol} omitido — 1D muy bajista (score:${bias1d.score})`);
    return;
  }
  if (direction === 'SHORT' && bias1d.score > 65) {
    console.log(`MeanRev SHORT ${symbol} omitido — 1D muy alcista (score:${bias1d.score})`);
    return;
  }

  // ── CALCULAR SL y TP FIJOS v4.4.44 ──────────────────────────────
  // SL: 0.3% fijo | TP: 15% — dejar correr ganadores
  // Basado en backtest: TP20% = 133% APR | TP15% = balance entre frecuencia y magnitud
  const slPct = 0.003;  // 0.3% — cortar rápido
  const tpPct = 0.15;   // 15% — dejar correr
  const sl = direction === 'LONG' ? price * (1 - slPct) : price * (1 + slPct);
  const tp = direction === 'LONG' ? price * (1 + tpPct) : price * (1 - tpPct);
  const rr = tpPct / slPct; // 50

  // ── ABRIR TRADE ───────────────────────────────────────────────────
  meanRevCooldown[symbol] = now;

  const exitMins = symbol.includes('BTC') ? 60 : 45;
  const conf = Math.min(88, Math.round(75 + (volMult >= 5 ? 8 : 4) + (absH1 >= 2 ? 5 : 0)));

  const tradeCtxMR = await captureTradeContext(symbol);
  await supabase.from('paper_trades').insert({
    symbol, direction, entry: price, tp1: tp, tp2: tp, sl,
    rr: `1:${rr.toFixed(1)}`,
    confidence: conf,
    size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'),
    leverage: parseInt(process.env.PAPER_LEVERAGE || '5'),
    source: 'meanrev',
    status: 'open',
    opened_at: new Date().toISOString(),
    market_data: {
      mode: 'mean_reversion',
      h1_move_pct: parseFloat(h1Move.toFixed(3)),
      h4_move_pct: parseFloat(h4Move.toFixed(3)),
      vol_mult: parseFloat(volMult.toFixed(2)),
      vol_median: parseFloat(median.toFixed(0)),
      bias_1d_score: bias1d.score,
      exit_mins: exitMins,
      timestamp: new Date().toISOString(),
      ...tradeCtxMR,
    }
  });

  console.log(`📈 MeanRev: ${direction} ${symbol} @ $${price.toFixed(1)} | 1H:${h1Move.toFixed(2)}% | Vol:${volMult.toFixed(1)}x | SL:$${sl.toFixed(1)} TP:$${tp.toFixed(1)} | RR 1:${rr.toFixed(1)}`);

  if (process.env.TELEGRAM_CHAT_ID) {
    const _dMr=new Date(), _limaMr=`🕐 Apertura: ${_dMr.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dMr.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
    const msg = `📈 Mean Reversion - ${symbol}\n${direction} @ $${parseInt(price).toLocaleString()}\nTP: $${parseInt(tp).toLocaleString()} | SL: $${parseInt(sl).toLocaleString()}\nRR 1:${rr.toFixed(1)} | ${conf}%\n1H move: ${h1Move.toFixed(2)}% | Vol: ${volMult.toFixed(1)}x median\nExit máx: ${exitMins}min\n${_limaMr}\nFuente: 📈 MeanRev`;
    try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg); } catch(e) { console.error("Telegram send error:", e.message); }
  }
}

// Endpoint para ver estado del módulo
app.get('/api/meanrev/status', (req, res) => {
  const status = {};
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    const cdMs = meanRevCooldown[symbol]
      ? Math.max(0, MEANREV_COOLDOWN_MS - (Date.now() - meanRevCooldown[symbol]))
      : 0;
    status[symbol] = {
      lastPrice: wsState[symbol]?.lastPrice || 0,
      cooldownMin: (cdMs / 60000).toFixed(1),
      active: cdMs === 0,
    };
  }
  res.json({ module: 'Mean Reversion', version: '4.4.35', status });
  });

// ── Journal automático — captura contexto macro en cada entrada ──────────────
async function captureTradeContext(symbol) {
  try {
    const [k1h, k4h] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=10`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=5`),
    ]);
    const cvd = (klines) => {
      let b = 0, s = 0;
      for (const k of klines) { const v = parseFloat(k[5]); if (parseFloat(k[4]) >= parseFloat(k[1])) b += v; else s += v; }
      const t = b + s; return t > 0 ? parseFloat(((b - s) / t * 100).toFixed(1)) : 0;
    };
    const sesion = getSesionActual();
    const bias1h = calcBias(k1h.data, null, 0);
    const bias4h = calcBias(k4h.data, null, 0);
    return {
      journal_cvd_1h: cvd(k1h.data),
      journal_cvd_4h: cvd(k4h.data),
      journal_sesion: sesion.nombre,
      journal_hora_lima: new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getHours(),
      journal_bias_1h: bias1h?.score || 50,
      journal_bias_4h: bias4h?.score || 50,
    };
  } catch(_) { return {}; }
}


app.get('/api/sesion', (req, res) => {
  const sesion = getSesionActual();
  const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getHours();
  res.json({ ...sesion, horaLima, bloqueada: isHoraBloqueada() });
});



// ── ENDPOINT: Estado trackers v4.4.38 ──
app.get('/api/tracker/status', (req, res) => {
  const cb = circuitBreaker.isActive();
  const ethPaused = ethLossTracker.isPaused();
  let ethMinLeft = 0;
  if (ethLossTracker.pausedUntil && Date.now() < ethLossTracker.pausedUntil) {
    ethMinLeft = Math.ceil((ethLossTracker.pausedUntil - Date.now()) / 60000);
  }
  const today = circuitBreaker.getToday();
  res.json({
    circuitBreaker: cb,
    dailyPnl: circuitBreaker.dailyPnl[today] || 0,
    ethPaused,
    ethMinLeft,
    ethConsecutive: ethLossTracker.consecutive,
    solPaused: solLossTracker.isPaused(),
    solConsecutive: solLossTracker.consecutive
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Panel Futuros EL CHIMUELO v4.4.87 corriendo en puerto ${PORT}`);
  syncBinanceTime();
  startAlertJob();
  // ── Wall Absorption v2 — DESACTIVADO PERMANENTEMENTE v4.4.76
  // N=89 trades, WR 33.7%, PnL -$108 — sin edge estadístico, peor source del sistema
  // connectDepthWebSocket('BTCUSDT');  // no descomentar
  // connectDepthWebSocket('ETHUSDT');  // no descomentar
  console.log('🧱 Wall Absorption v2 DESACTIVADO permanentemente — WR 33.7% N=89');
});
