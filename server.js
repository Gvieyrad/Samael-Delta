require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors({ origin: '*' }));
const _FEE_RT = 0.001; // 0.05% taker x2 lados = 0.10% RT — Binance Futures (v4.5.85: corregido de 0.0008)
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY });
const supabase = require('./sqlite_shim'); // v4.5.68: SQLite local reemplaza Supabase (egress quota). createClient ya no se usa.
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const BINANCE = 'https://fapi.binance.com';
// ⚠️ IMPORTANTE: usar stream.binance.com:9443 (SPOT), NO fstream.binance.com (futures)
// fstream conecta pero NO entrega aggTrade desde Railway EU West — causa loop 1006 infinito
// Baseline en pollBaseline también debe ser SPOT (api.binance.com/api/v3/klines) para consistencia
const BINANCE_WS = 'wss://stream.binance.com:9443';
// ── Filtro de horario — análisis estadístico 256 trades ─────────────────────
// Horas Lima (UTC-5) con WR <35%: 0,1,2,7,10,11,14,16,22
// Sesiones de Luis: Mañana 7-10h | Tarde 15-19h Lima
// Horas extra rentables: 13h (WR 73%), 21h (WR 50%), 23h (WR 75%)
const HORAS_ACTIVAS_LIMA = new Set([1, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 16, 17, 18, 23]); // v4.5.78: 11 temp // v4.5.77: 10 temporal // v4.5.40: +12h Lima (UTC17) para data meanrev: backtest 2.5y — Lima→UTC: 1→6(+$29),4→9(+$45),5→10(+$22),6→11(+$29),7→12(+$100),9→14(+$55),14→19(+$44),16→21(+$17),17→22(+$36),18→23(+$23),23→4(+$38)

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
const _marketCache = {}; // cache /api/market — 60s TTL para no hammear Binance REST

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
app.get('/', (req, res) => res.json({ status: 'Samael Delta activo', version: '4.5.24' }));

app.get('/samael', async (req, res) => {
  try {
    const { data: trades } = await supabase.from('paper_trades').select('*').order('id', { ascending: false }).limit(500); // v4.5.39: aumentado para mostrar todos los trades reales
    const done  = trades.filter(t => t.status === 'won' || t.status === 'lost');
    const open  = trades.filter(t => t.status === 'open' && t.source !== 'shadow' && t.source !== 'sol_paper' && t.source !== 'bull_run_long'); // v4.5.39: meanrev incluido
    const real  = done.filter(t => t.source !== 'shadow' && t.source !== 'sol_paper' && t.source !== 'bull_run_long'); // v4.5.39: meanrev incluido
    const wins  = done.filter(t => t.status === 'won');
    const realWins = real.filter(t => t.status === 'won');
    const pnlTotal = done.reduce((a,t) => a + (t.pnl_usd||0), 0);
    const pnlReal  = real.reduce((a,t) => a + (t.pnl_usd||0), 0);
    const totalFees = real.reduce((a,t) => a + (t.size_usd||0) * (t.leverage||10) * 0.00028, 0);
    const shorts   = real.filter(t => t.direction === 'SHORT');
    const longs    = real.filter(t => t.direction === 'LONG');
    const shortWins= shorts.filter(t => t.status === 'won');
    const longWins = longs.filter(t => t.status === 'won');
    const wrD = (w,n) => n.length > 0 ? (w.length/n.length*100).toFixed(1)+'%' : '-';
    const shadow     = done.filter(t => t.source === 'shadow');
    const shadowWins = shadow.filter(t => t.status === 'won');
    const shadowPnl  = shadow.reduce((a,t) => a + (t.pnl_usd||0), 0);
    const solPaper     = done.filter(t => t.source === 'sol_paper');
    const solPaperWins = solPaper.filter(t => t.status === 'won');
    const solPaperPnl  = solPaper.reduce((a,t) => a + (t.pnl_usd||0), 0);

    const realTrades = trades.filter(t => t.source !== 'shadow' && t.source !== 'sol_paper' && t.source !== 'bull_run_long'); // v4.5.39: meanrev incluido
    const tradeRows = trades.slice(0,50).map(t => {
      const icon = t.status === 'won' ? '&#x2705;' : t.status === 'lost' ? '&#x274C;' : '&#x23F3;';
      const pnl  = t.pnl_usd != null ? (t.pnl_usd >= 0 ? '<span class="pos">+$'+t.pnl_usd.toFixed(2)+'</span>' : '<span class="neg">$'+t.pnl_usd.toFixed(2)+'</span>') : '<span class="muted">open</span>';
      const dir  = t.direction === 'LONG' ? '<span class="long">&#x25B2; LONG</span>' : '<span class="short">&#x25BC; SHORT</span>';
      const sig  = t.source === 'sweep' ? 'sweep' : t.source === 'whale' ? '<span style="color:#e3b341">whale</span>' : (t.source||'');
      const ts   = t.opened_at ? new Date(new Date(t.opened_at)-18000000).toISOString().slice(5,16).replace('T',' ') : '';
      const reason = t.close_reason || (t.status === 'open' ? '<span class="muted">open</span>' : '&#x2014;');
      return '<tr style="'+(t.source==='shadow'?'opacity:0.45':'')+'"><td>'+t.id+'</td><td>'+t.symbol.replace('USDT','')+'</td><td>'+dir+'</td><td>'+pnl+'</td><td>'+reason+'</td><td class="muted">'+sig+'</td><td class="muted">'+ts+'</td><td>'+icon+'</td></tr>';
    }).join('');

    const openRows = open.length > 0 ? open.map(t => {
      const dir = t.direction === 'LONG' ? '<span class="long">&#x25B2; LONG</span>' : '<span class="short">&#x25BC; SHORT</span>';
      const since = t.opened_at ? new Date(new Date(t.opened_at)-18000000).toISOString().slice(11,16)+' Lima' : '';
      return '<tr><td>'+t.symbol.replace('USDT','')+'</td><td>'+dir+'</td><td>$'+t.entry+'</td><td>$'+(t.tp1?t.tp1.toFixed(4):'-')+'</td><td>$'+(t.sl?t.sl.toFixed(4):'-')+'</td><td class="muted">'+since+'</td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted center">Sin trades abiertos</td></tr>';

    // Funding fees de Binance (últimos 30 días)
    let fundingTotal = 0;
    let fundingCount = 0;
    let walletBalance = null;
    try {
      const ts = Date.now() + binanceTimeOffset;
      const startTime30d = ts - 30 * 24 * 60 * 60 * 1000;
      const qFunding = `timestamp=${ts}&recvWindow=10000&incomeType=FUNDING_FEE&limit=1000&startTime=${Math.round(startTime30d)}`;
      const sigFunding = crypto.createHmac('sha256', BINANCE_SECRET || '').update(qFunding).digest('hex');
      const rFunding = await axios.get(`${BINANCE}/fapi/v1/income?${qFunding}&signature=${sigFunding}`,
        { headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000 });
      if (Array.isArray(rFunding.data)) {
        fundingTotal = rFunding.data.reduce((a, x) => a + parseFloat(x.income || 0), 0);
        fundingCount = rFunding.data.length;
      }
      const acc = await fetchBinanceAccount();
      if (acc) walletBalance = acc.totalWalletBalance;
    } catch(eFund) { /* sin keys o error — omitir */ }

    const pnlRealSign = pnlReal >= 0 ? '+' : '';
    const pnlTotalSign = pnlTotal >= 0 ? '+' : '';
    const pnlRealClass = pnlReal >= 0 ? 'pos' : 'neg';
    const pnlTotalClass = pnlTotal >= 0 ? 'pos' : 'neg';
    const longWRnum = longs.length > 0 ? longWins.length/longs.length : 0;
    const longClass = longWRnum > 0.35 ? 'pos' : 'neg';
    const realWRstr = real.length > 0 ? (realWins.length/real.length*100).toFixed(1) : '0';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Samael Delta</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;padding:20px}
h1{font-size:22px;font-weight:700;margin-bottom:4px}
.sub{color:#8b949e;font-size:12px;margin-bottom:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin-bottom:20px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card .label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.card .val{font-size:26px;font-weight:700}
.card .sub2{font-size:11px;color:#8b949e;margin-top:4px}
.pos{color:#3fb950}.neg{color:#f85149}.muted{color:#8b949e;font-size:12px}.long{color:#3fb950}.short{color:#f85149}.center{text-align:center}
.section{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:14px;overflow:hidden}
.section h2{font-size:11px;font-weight:600;padding:10px 14px;border-bottom:1px solid #30363d;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:7px 12px;font-size:11px;color:#8b949e;border-bottom:1px solid #21262d;text-transform:uppercase}
td{padding:7px 12px;border-bottom:1px solid #1c2128;font-size:13px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1c2128}
.refresh{position:fixed;bottom:14px;right:14px;font-size:11px;color:#484f58}
</style>
</head>
<body>
<h1>&#9889; Samael Delta</h1>
<div class="sub">v4.5.75 &middot; Auto-refresh 30s &middot; <span id="ts"></span><script>document.getElementById('ts').textContent=new Date().toLocaleTimeString('es-PE',{timeZone:'America/Lima'})+' Lima'</script></div>

<div class="cards">
  <div class="card">
    <div class="label">PnL Real</div>
    <div class="val ${pnlRealClass}">${pnlRealSign}$${pnlReal.toFixed(2)}</div>
    <div class="sub2">${real.length} trades (sin meanrev)</div>
  </div>
  <div class="card">
    <div class="label">WR Real</div>
    <div class="val">${realWRstr}%</div>
    <div class="sub2">${realWins.length}W / ${real.length - realWins.length}L</div>
  </div>
  <div class="card">
    <div class="label">SHORT WR</div>
    <div class="val pos">${wrD(shortWins, shorts)}</div>
    <div class="sub2">${shorts.length} trades</div>
  </div>
  <div class="card">
    <div class="label">LONG WR</div>
    <div class="val ${longClass}">${wrD(longWins, longs)}</div>
    <div class="sub2">${longs.length} trades</div>
  </div>
  <div class="card">
    <div class="label">Abiertos</div>
    <div class="val">${open.length}</div>
    <div class="sub2">${open.map(t=>t.symbol.replace('USDT','')).join(', ')||'&mdash;'}</div>
  </div>
  <div class="card">
    <div class="label">Fees Pagados</div>
    <div class="val neg">-$${totalFees.toFixed(2)}</div>
    <div class="sub2">${real.length} trades reales</div>
  </div>

  ${fundingCount > 0 ? `<div class="card">
    <div class="label">Funding 30d</div>
    <div class="val ${fundingTotal >= 0 ? 'pos' : 'neg'}">${fundingTotal >= 0 ? '+' : ''}$${fundingTotal.toFixed(4)}</div>
    <div class="sub2">${fundingCount} cobros/pagos</div>
  </div>` : ''}
  ${walletBalance !== null ? `<div class="card">
    <div class="label">Wallet Real</div>
    <div class="val">${'$'+walletBalance.toFixed(2)}</div>
    <div class="sub2">Binance Futures USDT</div>
  </div>` : ''}
  ${shadow.length > 0 ? `<div class="card" style="border-color:#8b949e4d">
    <div class="label" style="color:#6e7681">&#x1F52E; Shadow CT</div>
    <div class="val ${shadowPnl >= 0 ? 'pos' : 'neg'}">${(shadowPnl >= 0 ? '+$' : '-$') + Math.abs(shadowPnl).toFixed(2)}</div>
    <div class="sub2">${shadow.length} trades &middot; WR ${(shadowWins.length/Math.max(shadow.length,1)*100).toFixed(0)}%</div>
  </div>` : ''}
  ${solPaper.length > 0 ? `<div class="card" style="border-color:#8b949e4d">
    <div class="label" style="color:#6e7681">&#x1F4C4; SOL Paper</div>
    <div class="val ${solPaperPnl >= 0 ? 'pos' : 'neg'}">${(solPaperPnl >= 0 ? '+$' : '-$') + Math.abs(solPaperPnl).toFixed(2)}</div>
    <div class="sub2">${solPaper.length} trades &middot; WR ${(solPaperWins.length/Math.max(solPaper.length,1)*100).toFixed(0)}%</div>
  </div>` : ''}
</div>

<div class="section">
  <h2>&#9203; Trades Abiertos</h2>
  <table><thead><tr><th>Par</th><th>Dir</th><th>Entry</th><th>TP1</th><th>SL</th><th>Desde</th></tr></thead>
  <tbody>${openRows}</tbody></table>
</div>

<div class="section">
  <h2>&#128203; Últimos 25 Trades</h2>
  <table><thead><tr><th>#</th><th>Par</th><th>Dir</th><th>PnL</th><th>Razón</th><th>Fuente</th><th>Apertura</th><th></th></tr></thead>
  <tbody>${tradeRows}</tbody></table>
</div>

<div class="refresh">&#x21BA; cada 30s</div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});


// ══════════════════════════════════════════════════════════════════
// ─── BINANCE FUTURES EXECUTION LAYER (Patch 11) ──────────────────
// Activo solo si BINANCE_API_KEY + BINANCE_SECRET_KEY + LIVE_TRADING=true
// Sin esas 3 variables el bot sigue en paper mode (comportamiento anterior)
// ══════════════════════════════════════════════════════════════════
let _LIVE_TRADING = process.env.LIVE_TRADING === 'true' && !!BINANCE_API_KEY && !!BINANCE_SECRET; // v4.5.47: let para que weekly CB pueda apagarlo
// Símbolos en paper-only: WS conectado + paper_trades, sin orden real en Binance
const PAPER_ONLY_SYMBOLS = new Set(['DOGEUSDT','BTCUSDT']); // v4.5.60: Cantera — 30 paper trades + WR>45% para promover a live // v4.5.24: SOL promovido a real (paper WR=63% n=16)
const _futuresInfoCache = {};   // symbol → { stepSize, quantityPrecision }
const _leverageSet     = new Set(); // `${symbol}_${lev}` ya configurado

async function _getFuturesStepSize(symbol) {
  if (_futuresInfoCache[symbol]) return _futuresInfoCache[symbol];
  try {
    const r = await axios.get(`${BINANCE}/fapi/v1/exchangeInfo`, { timeout: 15000 });
    for (const s of (r.data.symbols || [])) {
      const lot = s.filters?.find(f => f.filterType === 'LOT_SIZE');
      if (lot) _futuresInfoCache[s.symbol] = { stepSize: parseFloat(lot.stepSize), quantityPrecision: s.quantityPrecision ?? 3 };
    }
    return _futuresInfoCache[symbol] ?? { stepSize: 0.001, quantityPrecision: 3 };
  } catch(e) { console.error('_getFuturesStepSize error:', e.message); return { stepSize: 0.001, quantityPrecision: 3 }; }
}

function _roundStep(value, stepSize) {
  if (!stepSize || stepSize <= 0) return Math.floor(value * 1000) / 1000;
  const prec = Math.max(0, -Math.floor(Math.log10(stepSize)));
  return parseFloat((Math.floor(value / stepSize) * stepSize).toFixed(prec));
}

function _signParams(paramStr) {
  return crypto.createHmac('sha256', BINANCE_SECRET || '').update(paramStr).digest('hex');
}

async function _setFuturesLeverage(symbol, leverage) {
  const key = `${symbol}_${leverage}`;
  if (_leverageSet.has(key)) return;
  try {
    const ts = Date.now() + binanceTimeOffset;
    const p = `symbol=${symbol}&leverage=${leverage}&timestamp=${ts}&recvWindow=5000`;
    await axios.post(`${BINANCE}/fapi/v1/leverage?${p}&signature=${_signParams(p)}`, null,
      { headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000 });
    _leverageSet.add(key);
    console.log(`⚙️ Leverage ${symbol}: ${leverage}x`);
  } catch(e) { console.error(`_setLeverage ${symbol}: ${e.response?.data?.msg || e.message}`); throw e; } // v4.5.89: propagate — order must not open at wrong leverage
}

async function _placeFuturesMarket(symbol, side, qty, reduceOnly = false) {
  const ts = Date.now() + binanceTimeOffset;
  const parts = [`symbol=${symbol}`, `side=${side}`, `type=MARKET`, `quantity=${qty}`,
                 reduceOnly ? 'reduceOnly=true' : null,
                 `timestamp=${ts}`, `recvWindow=5000`].filter(Boolean);
  const p = parts.join('&');
  const r = await axios.post(`${BINANCE}/fapi/v1/order?${p}&signature=${_signParams(p)}`, null,
    { headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000 });
  return r.data;
}

/**
 * Abrir posición: calcula qty desde sizeUsd, configura leverage y coloca MARKET order.
 * Retorna { orderId, qty, avgPrice } o null si paper mode o error.
 */
async function openFuturesPosition(symbol, direction, sizeUsd, leverage, price) {
  if (!_LIVE_TRADING) return null;
  try {
    const info = await _getFuturesStepSize(symbol);
    const rawQty = (sizeUsd * leverage) / price;
    const qty = _roundStep(rawQty, info.stepSize);
    if (qty <= 0) { console.error(`openFuturesPosition: qty=0 ${symbol} sizeUsd=${sizeUsd} price=${price}`); return null; }
    await _setFuturesLeverage(symbol, leverage);
    const side = direction === 'LONG' ? 'BUY' : 'SELL';
    const res = await _placeFuturesMarket(symbol, side, qty, false);
    // v4.5.31: cumQuote/executedQty da el precio real de fill (avgPrice="0" para market orders)
    const _cumQ = parseFloat(res.cumQuote || 0);
    const _execQ = parseFloat(res.executedQty || qty);
    const avgPrice = (_cumQ > 0 && _execQ > 0) ? parseFloat((_cumQ / _execQ).toFixed(4)) : parseFloat(res.avgPrice) || price;
    console.log(`✅ LIVE OPEN: ${side} ${symbol} qty=${qty} avgPrice=$${avgPrice} orderId=${res.orderId}`);
    sendWaDelta(`🟢 *SAMAEL DELTA — OPEN*\n${side} ${symbol}\nQty: ${qty} | Precio: $${avgPrice}\nSize: $${sizeUsd} x${leverage} | Order: ${res.orderId}`);
    return { orderId: res.orderId, qty, avgPrice };
  } catch(e) {
    const msg = e.response?.data?.msg || e.message;
    const code = e.response?.data?.code || '';
    console.error(`openFuturesPosition error [${code}]: ${msg}`);
    return null;
  }
}

/**
 * Cerrar posición: obtiene qty actual de /positionRisk y coloca MARKET reduce-only.
 * Retorna orderId o null.
 */
async function closeFuturesPosition(symbol, direction, pnl_usd = null, closePrice = null) {
  if (!_LIVE_TRADING) return null;
  try {
    const ts = Date.now() + binanceTimeOffset;
    const p = `symbol=${symbol}&timestamp=${ts}&recvWindow=5000`;
    const posR = await axios.get(`${BINANCE}/fapi/v2/positionRisk?${p}&signature=${_signParams(p)}`,
      { headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, timeout: 10000 });
    const pos = (posR.data || []).find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
    if (!pos) { console.log(`closeFuturesPosition: sin posición abierta para ${symbol}`); return null; }
    const posAmt = Math.abs(parseFloat(pos.positionAmt));
    const info = await _getFuturesStepSize(symbol);
    const qty = _roundStep(posAmt, info.stepSize);
    const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
    const res = await _placeFuturesMarket(symbol, closeSide, qty, true);
    const _fillPx = res.cumQuote && res.executedQty ? parseFloat(res.cumQuote) / parseFloat(res.executedQty) : null;
    console.log(`✅ LIVE CLOSE: ${closeSide} ${symbol} qty=${qty} fillPx=${_fillPx ? _fillPx.toFixed(4) : "n/a"} orderId=${res.orderId}`);
    // v4.5.31: incluir PnL y precio de salida en notificación WA
    const _pnlStr = pnl_usd !== null ? `\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}` : '';
    const _closePxStr = closePrice !== null ? ` | Exit: $${parseFloat(closePrice).toFixed(4)}` : '';
    sendWaDelta(`🔴 *SAMAEL DELTA — CLOSE*\n${closeSide} ${symbol}\nQty: ${qty}${_closePxStr} | Order: ${res.orderId}${_pnlStr}`);
    return res.orderId;
  } catch(e) {
    const msg = e.response?.data?.msg || e.message;
    console.error(`closeFuturesPosition error: ${msg}`);
    return null;
  }
}

if (_LIVE_TRADING) {
  console.log('🔴 LIVE_TRADING=true — órdenes reales en Binance Futures ACTIVAS');
} else {
  console.log('📄 Paper mode — sin ejecución real en Binance');
}
// ── WhatsApp notifications → grupo "Samael trading" ──────────────────────────
const _WA_GROUP_JID = process.env.WA_GROUP_JID || '120363425022083138@g.us';
const _WA_URL       = process.env.WA_BRIDGE_URL || 'http://127.0.0.1:3001/send';

async function sendWaDelta(msg) {
  try {
    await axios.post(_WA_URL, { chatId: _WA_GROUP_JID, message: msg }, { timeout: 5000 });
  } catch(e) { console.error('[WA] sendWaDelta error:', e.message); }
}
// ─────────────────────────────────────────────────────────────────────────────



// ══════════════════════════════════════════════════════════════════
// ─── MÓDULO WEBSOCKET — DETECCIÓN EN TIEMPO REAL ─────────────────
// ══════════════════════════════════════════════════════════════════
const wsState = {};
const wsConnections = {};
const killSwitchCooldown = {};
const _cooldownLastLog = {}; // throttle cooldown logs — 1x por minuto por clave
const _nearWhaleLastLog = {}; // v4.5.22: throttle near-whale monitor logs — 1x por 5min por símbolo
const _bullRunBlocked = new Set(); // v4.5.23: símbolos auto-bloqueados por bull run detector
const _consecSLData  = {};          // v4.5.28: {times:[ts1,ts2]} por símbolo para cooldown
const _consecSLPause = {};          // v4.5.28: {until:timestamp} si 2 SLs consecutivos en <3h
const _consecSLCount = {};          // v4.5.29: {count:N, blockedUntil:ts} 3 SLs consecutivos = block hasta midnight
const _wsNoDataCount = {}; // contador fallos WS consecutivos por símbolo
const _openLock = new Set(); // lock síncrono anti-race: previene doble apertura por aggTrade concurrente

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
const _openingTrades = new Set(); // mutex sincrono para apertura de trades (evita TOCTOU)
const _trailingLastUpdate = {}; // throttle trailing SL writes — 30s por trade
const _maxProfitCache = {}; // max unrealized profit por trade id
const _partialTpTrades = {}; // trades con partial TP activado (BE stop + TP2)
// v4.5.67: cache open trades por simbolo (TTL 5s) — checkSlTpOnTick consultaba Supabase en CADA tick WS (~25/s) y revento la cuota egress (Jun 22). _slTpLocks (10s>TTL) previene doble-cierre aunque el cache muestre un trade ya cerrado por <=5s.
const _slCache = {};
const _SL_CACHE_MS = 5000;
function _invalidateSlCache(symbol) { delete _slCache[symbol]; }
async function checkSlTpOnTick(symbol, price, trailHigh = price, trailLow = price) {
  try {
    let openTrades;
    const _cached = _slCache[symbol];
    if (_cached && Date.now() - _cached.time < _SL_CACHE_MS) {
      openTrades = _cached.trades; // v4.5.67: cache en memoria, no query por tick (fix exceed_egress_quota)
    } else {
      const { data: _slData, error: _slErr } = await supabase
        .from('paper_trades').select('*')
        .eq('symbol', symbol).eq('status', 'open');
      if (_slErr) { console.error(`checkSlTpOnTick Supabase error (${symbol}): ${_slErr.message}`); return; } // v4.5.52: don't silently bypass SL
      openTrades = _slData || [];
      _slCache[symbol] = { trades: openTrades, time: Date.now() };
    }
    if (!openTrades.length) return;

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
          const _slDec = trailExtreme >= 100 ? 2 : trailExtreme >= 1 ? 4 : 6; // v4.5.57: adaptive precision
          const newSlRounded = parseFloat(newSlTr.toFixed(_slDec));
          await supabase.from('paper_trades').update({ sl: newSlRounded }).eq('id', trade.id);
          sl = newSlRounded;
          _trailingLastUpdate[trade.id] = Date.now();
          _invalidateSlCache(symbol); // v4.5.67: SL cambio -> refrescar cache
          console.log(`📈 Trailing (WS): ${trade.direction} ${symbol} SL → ${newSlRounded.toFixed(_slDec)} (extreme ${trailExtreme.toFixed(1)}, +${priceDiffPctTr.toFixed(2)}%)`);
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

      if (_slTpLocks[trade.id]) continue; // per-trade lock guard (Bug #1+2)
      if (!closeReason) continue;

      // P8C: Partial TP — ETH y PEPE: TP1 tocado → mover SL a entry, extender a TP2
      if (closeReason === 'tp1' && trade.source === 'sweep' &&
          (symbol === 'ETHUSDT' || symbol === '1000PEPEUSDT') &&
          !_partialTpTrades[trade.id]) {
        _partialTpTrades[trade.id] = true;
        const _tp2val = parseFloat(trade.tp2);
        if (_tp2val && !isNaN(_tp2val)) {
          await supabase.from('paper_trades').update({ sl: entry, tp1: _tp2val }).eq('id', trade.id);
          console.log(`🔄 Partial TP activado: ${symbol} SL→entry=$${entry} TP→$${_tp2val.toFixed(1)}`);
        }
        _invalidateSlCache(symbol); // v4.5.67: partial TP cambio tp1/sl
        continue;
      }

      // v4.5.75: slippage guard — trailing_tp meanrev: si precio ya rebotó >0.3% del trigger, reanclar SL
      if (closeReason === 'trailing_tp' && trade.source === 'meanrev') {
        const _slipPct = isLong ? (closePrice - price) / closePrice : (price - closePrice) / closePrice;
        if (_slipPct > 0.003) {
          console.log(`⚠️ Slippage guard ${symbol}: price=${price.toFixed(4)} trigger=${closePrice.toFixed(4)} desliz=${(_slipPct*100).toFixed(2)}% — reancl SL`);
          await supabase.from('paper_trades').update({ sl: isLong ? price * 0.997 : price * 1.003 }).eq('id', trade.id);
          _invalidateSlCache(symbol); // v4.5.67
          continue;
        }
      }
      // Lock para evitar doble cierre
      _slTpLocks[trade.id] = true;
      setTimeout(() => { delete _slTpLocks[trade.id]; }, 10000); // v4.5.48: 1s → 10s to cover Supabase round-trip

      const priceDiff = isLong ? (closePrice - entry) / entry : (entry - closePrice) / entry;
      const pnl_usd   = parseFloat((size * priceDiff * lev - size * lev * _FEE_RT).toFixed(2));
      const pnl_pct   = parseFloat((priceDiff * lev * 100).toFixed(2));
      const status    = pnl_usd > 0 ? 'won' : 'lost';

      await supabase.from('paper_trades').update({
        status, close_price: closePrice, close_reason: closeReason,
        pnl_usd, pnl_pct, closed_at: new Date().toISOString(),
        max_profit_usd: parseFloat((_maxProfitCache[trade.id] ?? pnl_usd).toFixed(2))
      }).eq('id', trade.id);
      delete _maxProfitCache[trade.id]; delete _trailingLastUpdate[trade.id]; delete _partialTpTrades[trade.id];
      _invalidateSlCache(symbol); // v4.5.67: refrescar cache tras cierre

      // Circuit breaker global diario
      if (trade.source !== 'manual' && trade.source !== 'shadow' && trade.source !== 'bull_run_long' && trade.source !== 'sol_paper' && !PAPER_ONLY_SYMBOLS.has(symbol)) circuitBreaker.addPnl(pnl_usd); // v4.5.58: consistent with initFromSupabase
      // Circuit breaker por símbolo (sweep/whale)
      if ((trade.source === 'sweep' || trade.source === 'whale') && _symTrackers[symbol]) {
        if (status === 'lost') _symTrackers[symbol].recordLoss();
        else _symTrackers[symbol].recordWin();
      }

      // v4.5.28: consecutive-SL cooldown (SLs rápidos <3h)
      // v4.5.29: 3-consecutive-SL daily block (rachas largas)
      if (trade.source === 'sweep' || trade.source === 'whale' || trade.source === 'meanrev') { // v4.5.83
        if (!_consecSLData[symbol])  _consecSLData[symbol]  = { times: [] };
        if (!_consecSLCount[symbol]) _consecSLCount[symbol] = { count: 0 };
        if (closeReason === 'sl') {
          // v4.5.28: ventana 3h
          _consecSLData[symbol].times.push(Date.now());
          _consecSLData[symbol].times = _consecSLData[symbol].times.slice(-2);
          const [t1, t2] = _consecSLData[symbol].times;
          if (t1 && t2 && (t2 - t1) < 3 * 60 * 60 * 1000) {
            const _csPauseMs = (trade.source === 'meanrev') ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000; // v4.5.83: meanrev=30min, sweep/whale=2h
            const _csPauseLabel = (trade.source === 'meanrev') ? '30min' : '2h';
            _consecSLPause[symbol] = { until: Date.now() + _csPauseMs };
            console.log(`⏸ Consec-SL cooldown ${symbol}: 2 SLs en ${Math.round((t2-t1)/60000)}min → pausa ${_csPauseLabel}`);
            if (process.env.TELEGRAM_CHAT_ID) bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `⏸ ${symbol} pausado ${_csPauseLabel} — 2 SLs consecutivos en ${Math.round((t2-t1)/60000)}min`).catch(()=>{});
          }
          // v4.5.29: contador sin límite de tiempo — 3 consecutivos = midnight block
          _consecSLCount[symbol].count++;
          if (_consecSLCount[symbol].count >= 3) {
            const midnight = new Date(); midnight.setUTCHours(24,0,0,0);
            _consecSLCount[symbol].blockedUntil = midnight.getTime();
            console.log(`🚫 3-SL block ${symbol}: ${_consecSLCount[symbol].count} SLs consecutivos → bloqueado hasta medianoche UTC`);
            if (process.env.TELEGRAM_CHAT_ID) bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `🚫 ${symbol} bloqueado hasta medianoche — ${_consecSLCount[symbol].count} SLs consecutivos`).catch(()=>{});
          }
        } else if (closeReason === 'tp1' || closeReason === 'trailing_tp') {
          _consecSLData[symbol] = { times: [] };
          _consecSLCount[symbol] = { count: 0 };
          delete _consecSLPause[symbol];
        }
      }

      // Loss trackers
      if (trade.source === 'scalping') {
        const tracker = trade.symbol.includes('ETH') ? ethLossTracker
                      : trade.symbol.includes('SOL') ? solLossTracker : null;
        if (tracker) { if (status === 'lost') tracker.recordLoss(); else tracker.recordWin(); }
      }

      // v4.5.27: si MEANREV_REAL=true, meanrev sí cierra posición real en Binance
      const _mrRealClose = process.env.MEANREV_REAL === 'true' && _LIVE_TRADING;
      const _shRealClose = process.env.SHADOW_REAL==='true' && trade.source==='shadow' && trade.market_data?.shadow_real===true; // v4.5.38
      const _PAPER_SRCS = new Set(_mrRealClose ? (_shRealClose?['bull_run_long','sol_paper']:[ 'shadow','bull_run_long','sol_paper']) : (_shRealClose?['bull_run_long','sol_paper','meanrev']:[ 'shadow','bull_run_long','sol_paper','meanrev'])); // v4.5.24-fix+v4.5.38
      if (!_PAPER_SRCS.has(trade.source) && !PAPER_ONLY_SYMBOLS.has(symbol)) await closeFuturesPosition(symbol, trade.direction, pnl_usd, closePrice);
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
  } catch(e) { console.error('checkSlTpOnTick error:', e.message); }
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
      // ── WS h1Move trigger (v4.5.76b) ──
      if (!wsState[symbol]._mrWsTrig) { wsState[symbol]._mrWsTrig = setTimeout(() => { wsState[symbol]._mrWsTrig = null; try { const _hl=((new Date().getUTCHours()-5)+24)%24; if (!HORAS_ACTIVAS_LIMA.has(_hl)) return; const _hc=_klineCache[symbol+'|1h|3']; if (!_hc||Date.now()-_hc.ts>180000) return; const _ho=parseFloat(_hc.data[1][1]); const _cp=wsState[symbol].lastPrice; if (!_ho||!_cp) return; const _mv=(_cp-_ho)/_ho*100; if (Math.abs(_mv)>=0.3&&!wsState[symbol]._mrWsCd) { wsState[symbol]._mrWsCd=true; setTimeout(()=>{wsState[symbol]._mrWsCd=false;},3*60*1000); console.log('⚡ WS h1Trig '+symbol+': mv='+_mv.toFixed(2)+'% → scanner NOW (v4.5.76b)'); runMeanRevScanner().catch(()=>{}); } } catch(_e){} },2000); }
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
          checkSlTpOnTick(symbol, _p, _high, _low).catch(e => console.error('[tick SL]', symbol, e.message)); // v4.5.73
        }, 200);
      }
      if (!wsState[symbol]._evalTimer) {
        wsState[symbol]._evalTimer = setTimeout(() => { wsState[symbol]._evalTimer = null; evaluateAnomaly(symbol).catch(e => console.error('[anomaly]', symbol, e.message)); }, 500); // v4.5.73
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
  const _symCfg = { BTCUSDT:{vm:5,cvd:60,pm:0.07}, ETHUSDT:{vm:10,cvd:70,pm:0.15}, '1000PEPEUSDT':{vm:5,cvd:60,pm:0.05}, WLDUSDT:{vm:5,cvd:60,pm:0.05}, SUIUSDT:{vm:7,cvd:60,pm:0.05}, XRPUSDT:{vm:10,cvd:60,pm:0.05} };
  const _sc = _symCfg[symbol] || { vm: parseInt(process.env.WS_VOLUME_MULTIPLIER || '10'), cvd: 60, pm: 0.10 }; // v4.5.33: default 7x→10x (backtest: 7-10x negativo)
  const volMultiplier = _sc.vm;
  const now = Date.now();
  const isVolumeAnomaly = metrics.volumeMultiplier >= volMultiplier;
  const isBearishSweep = metrics.cvdLive < -_sc.cvd && isVolumeAnomaly;
  const isBullishSweep = metrics.cvdLive > _sc.cvd && isVolumeAnomaly;
  const prices60s = state.trades.filter(t => now - t.time < 60000).map(t => t.price);
  const priceMove60s = prices60s.length >= 2 ? Math.abs(prices60s[prices60s.length-1] - prices60s[0]) / prices60s[0] * 100 : 0;
  const cvdExtreme = Math.abs(metrics.cvdLive) >= _sc.cvd + 10;
  // v4.5.2: BTC mueve menos % que ETH/SOL — threshold específico por símbolo
  const isBtcSym = symbol === 'BTCUSDT';
  const priceThreshold = cvdExtreme ? Math.max(_sc.pm * 0.5, 0.03) : _sc.pm;
  const isPriceMoving = priceMove60s >= priceThreshold;
  const isRealBearishSweep = isBearishSweep && isPriceMoving;
  const isRealBullishSweep = isBullishSweep && isPriceMoving;
  if (isVolumeAnomaly && (isBearishSweep || isBullishSweep) && !isPriceMoving) {
    console.log(`🔍 ${symbol} BLOQUEADO — vol=${metrics.volumeMultiplier.toFixed(1)}x CVD=${metrics.cvdLive.toFixed(1)}% priceMove=${priceMove60s.toFixed(3)}% < ${priceThreshold}%`);
  }
  const realWhaleThreshold = symbol.includes('BTC') ? 10000000 : symbol.includes('ETH') ? 5000000 : 1000000;
  const bigWhale = state.trades.find(t => t.usdVal >= realWhaleThreshold && now - t.time < 30000);
  // v4.5.22: near-whale monitor — loggear cuando la mayor orden llega al 20%+ del umbral
  if (!bigWhale) {
    const _maxTrade60s = state.trades.filter(t => now - t.time < 60000).reduce((mx, t) => Math.max(mx, t.usdVal), 0);
    if (_maxTrade60s >= realWhaleThreshold * 0.20) {
      if (!_nearWhaleLastLog[symbol] || now - _nearWhaleLastLog[symbol] > 300000) {
        _nearWhaleLastLog[symbol] = now;
        console.log(`🔭 Near-whale ${symbol}: max orden $${(_maxTrade60s/1000).toFixed(0)}K = ${(_maxTrade60s/realWhaleThreshold*100).toFixed(0)}% del umbral whale ($${(realWhaleThreshold/1e6).toFixed(2)}M)`);
      }
    }
  }
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
    if (!_cooldownLastLog[cooldownKey] || now - _cooldownLastLog[cooldownKey] > 60000) {
      console.log(`⏳ Cooldown activo ${symbol} ${direction} — faltan ~${remaining}s`);
      _cooldownLastLog[cooldownKey] = now;
    }
    return;
  }
  // Lock síncrono antes del primer await — previene race condition TOCTOU entre aggTrades concurrentes
  const lockKey = `${symbol}_${direction}`;
  if (_openLock.has(lockKey)) return;
  _openLock.add(lockKey);
  if (isSweep || isWhaleOnly) {
    state.anomaly = { direction, reason, time: now, volumeMultiplier: metrics.volumeMultiplier, cvdLive: metrics.cvdLive, liqZoneBonus, isSweep: !!(isRealBearishSweep || isRealBullishSweep), isWhale: !!bigWhale && !isSweep };
    setTimeout(() => { if (wsState[symbol]?.anomaly?.time === now) wsState[symbol].anomaly = null; }, 5 * 60 * 1000);
  }
  console.log(`⚡ ANOMALÍA DETECTADA: ${direction} ${symbol} — ${reason} (liq bonus: +${liqZoneBonus})`);
  try {
    if (isSweep) {
      // v4.5.2: kill_switch solo en sweeps vol≥7x — sweeps débiles no deben cerrar trades existentes sin abrir compensación
      if (metrics.volumeMultiplier >= 10) await killSwitchOpposite(symbol, direction, reason);
      await openSweepCounterTrade(symbol, direction, metrics, reason, liqZoneBonus);
      openShadowTrade(symbol, direction, metrics.lastPrice).catch(e => console.error('Shadow error:', e.message));
      openRealLong(symbol, direction, metrics.lastPrice).catch(e => console.error('LONG real error:', e.message)); // v4.5.26
    } else if (isMassiveWhale) {
      await killSwitchOpposite(symbol, massiveWhaleDirection, reason);
      await openWhaleCounterTrade(symbol, massiveWhaleDirection, metrics, reason, liqZoneBonus);
    } else if (isWhaleOnly) {
      // v4.5.22: fix bug — bigWhale detectado pero sin rama de ejecución desde siempre (n=0 whale trades)
      await openWhaleCounterTrade(symbol, direction, metrics, reason, liqZoneBonus);
    }
  } finally {
    _openLock.delete(lockKey); // siempre liberar — cooldown en openSweepCounterTrade protege reentrada post-open
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
  if (_openingTrades.has(symbol)) { console.log('Whale omitido -- apertura en curso para ' + symbol); return; }
  _openingTrades.add(symbol);
  try {
    // v4.5.34: LONGs habilitados (backtest +$177 Net, WR=24.1%). Safeguards: conf>=92%, bias_1d, bull_run, precio_5min
    // Circuit breaker por símbolo
    if (_symTrackers[symbol]?.isPaused()) { console.log(`⏸️ ${symbol} Whale pausado — 3 SL consecutivos`); return; }
    // v4.5.17: bloquear ETH
    // v4.5.24: ETH desbloqueado — shadow 30% LONG, bull run normalizado
    // v4.5.19: bloquear WLD (bull run — WR SHORT 14%, mismo perfil que ETH)
    // v4.5.25: WLD desbloqueado — shadow 7d WR=48% n=95, bull run normalizado (52% LONG)
    // v4.5.21: bloquear SUI (bull run — 6 losses consecutivos May-31, LONG anomalías dominantes)
    if (symbol === 'SUIUSDT') { console.log(`⏭ Whale SUI bloqueado — no confiable en bull run (${direction})`); return; }
    // v4.5.23: auto-bloqueo dinámico por bull run detector
    if (_consecSLPause[symbol] && _consecSLPause[symbol].until > Date.now()) {
      const minLeft = Math.ceil((_consecSLPause[symbol].until - Date.now()) / 60000);
      console.log(`⏸ Whale ${symbol} en cooldown post-SLs — ${minLeft}min restantes`); return;
    }
    if (_consecSLCount[symbol]?.blockedUntil > Date.now()) {
      const minLeft = Math.ceil((_consecSLCount[symbol].blockedUntil - Date.now()) / 60000);
      console.log(`🚫 Whale ${symbol} bloqueado por 3-SL diario — ${minLeft}min hasta medianoche`); return;
    }
    if (_bullRunBlocked.has(symbol) && direction === 'LONG') { console.log(`⏭ Whale ${symbol} LONG bloqueado — bull run (>65% LONG 24h)`); return; } // v4.5.49
    // Filtro horario — ballenas fuertes (CVD>85% + Vol>8x) saltan restricción
    if (isHoraBloqueada()) {
      const horaLima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })).getHours();
      const esBallenaFuerte = Math.abs(metrics.cvdLive) > 85 && metrics.volumeMultiplier > 8;
      // Madrugada 1-4h — bloqueo absoluto incluso para ballenas fuertes
      const esMadrugadaAbsoluta = horaLima >= 1 && horaLima <= 4;
      if (!esBallenaFuerte || esMadrugadaAbsoluta) {
        console.log(`⏰ Whale bloqueado — hora ${horaLima}h Lima${esBallenaFuerte ? ' (madrugada absoluta)' : ' fuera de ventana óptima'}`);
        return;
      }
      console.log(`✅ Whale ${direction} ${symbol} — hora ${horaLima}h SALTADA por señal fuerte (CVD:${metrics.cvdLive.toFixed(1)}% Vol:${metrics.volumeMultiplier.toFixed(1)}x)`);
    }
    // v4.5.20: excluir shadow/sol_paper/meanrev de caps
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open').neq('source', 'shadow').neq('source', 'sol_paper').neq('source', 'meanrev').neq('source', 'bull_run_long');
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
        return;
      }
      if (direction === 'LONG' && priceMove5m < 0.1) {
        console.log(`⏭ Whale LONG omitido — precio no confirma subida en 5min (${priceMove5m.toFixed(2)}%) — absorción vendedora (${symbol})`);
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
          return;
        }
        if (direction === 'LONG' && blockLongWh) {
          console.log(`⏭ Whale LONG omitido — bias_1d bajista (score:${bias1dWh.score}) — mercado diario en contra (${symbol})`);
          return;
        }
      }
    } catch(e) { console.error('sweep whale bias fetch error:', e.message); } // v4.5.72
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
    } catch(e) { console.error('sweep CVD5m fetch error:', e.message); } // v4.5.72
    const k5m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=20`);
    const highs5m = k5m.data.map(k => parseFloat(k[2])), lows5m = k5m.data.map(k => parseFloat(k[3]));
    const atr5m = highs5m.slice(-10).reduce((s,h,i) => s + (h - lows5m[lows5m.length - 10 + i]), 0) / 10;
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
    const tradeCtx = await captureTradeContext(symbol);
    // Bug2 fix: abrir en Binance primero — si falla no queda phantom trade en Supabase
    const _isPaperOnlyW = PAPER_ONLY_SYMBOLS.has(symbol);
    const _whaleFillResult = _isPaperOnlyW ? null : await openFuturesPosition(symbol, direction,
      parseFloat(process.env['PAPER_SIZE_USD_' + symbol] || process.env.PAPER_SIZE_USD || '62'),
      parseInt(process.env.PAPER_LEVERAGE || '5'), price);
    if (!_whaleFillResult && _LIVE_TRADING && !_isPaperOnlyW) { console.error(`Whale trade abortado — Binance rechazó orden ${symbol}`); return; }
    await supabase.from('paper_trades').insert({ symbol, direction, entry: _whaleFillResult?.avgPrice || price, tp1, tp2: isLong ? price + atr * 3.5 : price - atr * 3.5, sl, rr: `1:${rrVal.toFixed(1)}`, confidence: whaleConfidence, size_usd: parseFloat(process.env['PAPER_SIZE_USD_' + symbol] || process.env.PAPER_SIZE_USD || '62'), leverage: parseInt(process.env.PAPER_LEVERAGE || '5'), source: _isPaperOnlyW ? 'sol_paper' : 'sweep', status: 'open', opened_at: new Date().toISOString(), market_data: { mode: 'whale', reason, cvd_live: metrics.cvdLive, volume_multiplier: metrics.volumeMultiplier, liq_bonus: liqBonus, timestamp: new Date().toISOString(), ...tradeCtx } });
    console.log(`🐋 Whale trade abierto: ${direction} ${symbol} @ $${price} R:R 1:${rrVal.toFixed(1)} conf:${whaleConfidence}%`);
    if (process.env.TELEGRAM_CHAT_ID) {
      const e = direction === 'SHORT' ? '▼' : '▲';
      const _dW=new Date(), _limaW=`🕐 Apertura: ${_dW.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dW.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
      const msg = `🐋 *Whale Trade Abierto — ${symbol}*\n${e} ${direction} @ $${parseInt(price).toLocaleString()}\n🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}\n📐 R:R 1:${rrVal.toFixed(1)} | ${whaleConfidence}%\n${reason}\n${_limaW}\nFuente: 🐋 Whale`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
    }
  } catch(e) { console.error('Whale trade error:', e.message); } finally { _openingTrades.delete(symbol); }
}

async function killSwitchOpposite(symbol, sweepDirection, reason) {
  try {
    // v4.5.10: si CB activo no hay trade compensatorio que abrir — no cerrar sin reemplazo
    if (circuitBreaker.isActive()) {
      console.log(`⏭ Kill switch omitido — Circuit Breaker activo, sin trade compensatorio disponible (${symbol})`);
      return;
    }
    const oppositeDir = sweepDirection === 'SHORT' ? 'LONG' : 'SHORT';
    const { data: openTrades } = await supabase.from('paper_trades').select('*').eq('symbol', symbol).eq('status', 'open').eq('direction', oppositeDir).not('source', 'in', '(shadow,bull_run_long,sol_paper)'); // v4.5.48: excluir trades de papel
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
      // Fix: medir progreso HACIA el SL, no distancia absoluta
      // Bug previo: abs(price-entry) disparaba kill_switch en trades en profit
      const totalDistance = Math.abs(sl - entry);
      if (totalDistance < 0.0001) { console.log(`⏭ Kill switch omitido — totalDistance≈0 (SL≈entry) ${trade.direction} ${symbol}`); continue; }
      const slProgress = trade.direction === 'LONG'
        ? (entry - currentPrice) / totalDistance
        : (currentPrice - entry) / totalDistance; // v4.5.48: fix SHORT denominator (was sl-entry, should be totalDistance)
      if (slProgress <= 0) {
        console.log(`⏭ Kill switch omitido — trade en profit (sl=${(slProgress*100).toFixed(0)}%) ${trade.direction} ${symbol}`);
        continue;
      }
      if (slProgress < slThreshold) {
        console.log(`⏭ Kill switch omitido — ${trade.direction} ${symbol} al ${(slProgress*100).toFixed(0)}% del SL (umbral: ${(slThreshold*100).toFixed(0)}%)`);
        continue;
      }
      if (_slTpLocks[trade.id]) continue; // v4.5.59: prevent double-close
      _slTpLocks[trade.id] = true; setTimeout(() => { delete _slTpLocks[trade.id]; }, 10000);
      const priceDiff = trade.direction === 'LONG' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
      const _lev1 = parseFloat(trade.leverage || 10);
      const pnl_usd = parseFloat((parseFloat(trade.size_usd) * priceDiff * _lev1 - parseFloat(trade.size_usd) * _lev1 * _FEE_RT).toFixed(2));
      const pnl_pct = parseFloat((priceDiff * _lev1 * 100).toFixed(2));
      await supabase.from('paper_trades').update({ status: pnl_usd >= 0 ? 'won' : 'lost', close_price: currentPrice, close_reason: 'kill_switch', pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', trade.id);
      _invalidateSlCache(symbol); // v4.5.73
      if (trade.source !== 'shadow' && trade.source !== 'bull_run_long' && trade.source !== 'sol_paper' && trade.source !== 'manual' && !PAPER_ONLY_SYMBOLS.has(symbol)) circuitBreaker.addPnl(pnl_usd); // v4.5.59
      delete _maxProfitCache[trade.id]; delete _trailingLastUpdate[trade.id]; delete _partialTpTrades[trade.id];
      try { await closeFuturesPosition(symbol, trade.direction); } catch(_ksCloseErr) { console.error(`🚨 killSwitch: DB cerrado pero Binance close FALLÓ ${symbol}:`, _ksCloseErr.message); if (process.env.TELEGRAM_CHAT_ID) bot.sendMessage(process.env.TELEGRAM_CHAT_ID, `🚨 URGENTE Kill Switch: DB actualizado pero Binance close falló ${symbol} — verificar posición manualmente`).catch(()=>{}); } // v4.5.72
      console.log(`🛡️ Kill switch: cerrado ${trade.direction} ${symbol} @ $${currentPrice} PnL: $${pnl_usd} (${(slProgress*100).toFixed(0)}% hacia SL)`);
      if (process.env.TELEGRAM_CHAT_ID) {
        const msg = `🛡️ *Kill Switch activado*\n${trade.direction} ${symbol} cerrado\nEntry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentPrice).toLocaleString()}\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\nRazón: ${reason}`;
        try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
      }
    }
  } catch(e) { console.error('Kill switch error:', e.message); }
}

// v4.5.26: LONG real para WLD/XRP/BTC cuando sweep bajista falla (shadow WR>42%)
const LONG_REAL_SYMBOLS = new Set((process.env.LONG_REAL_SYMBOLS || '').split(',').map(s=>s.trim()).filter(Boolean)); // v4.5.64: vacio/unset=desactivado (era footgun: default WLD,XRP,BTC abria LONGs reales pese a .env vaciado)
const _realLongLocks = new Set(); // v4.5.31: lock para evitar race condition doble apertura
async function openRealLong(symbol, sweepDirection, price) {
  if (sweepDirection !== 'SHORT') return;
  if (!LONG_REAL_SYMBOLS.has(symbol)) return;
  if (_realLongLocks.has(symbol)) { console.log('LONG real omitido -- lock activo ' + symbol); return; }
  _realLongLocks.add(symbol);
  try {
    const { data: existing } = await supabase.from('paper_trades').select('id,direction')
      .eq('symbol', symbol).eq('status', 'open')
      .not('source', 'in', '(shadow,sol_paper,meanrev,bull_run_long)');
    if (existing?.length) { console.log('LONG real omitido -- ya hay trade abierto ' + symbol); _realLongLocks.delete(symbol); return; }
    const { data: allOpen } = await supabase.from('paper_trades').select('id')
      .eq('status', 'open').eq('direction', 'LONG')
      .not('source', 'in', '(shadow,sol_paper,meanrev,bull_run_long)');
    if ((allOpen?.length || 0) >= 1) { console.log('LONG real omitido -- ya hay 1 LONG abierto (max 1)'); _realLongLocks.delete(symbol); return; }
    // v4.5.46: bias_1d + bias_4h filter — no LONG en mercado bajista diario
    try {
      const [k4hLong, k1dLong] = await Promise.all([
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
        axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
      ]);
      const bias1dLong = calcBias(k1dLong.data, null, 0);
      const bias4hLong = calcBias(k4hLong.data, null, 0);
      if (bias1dLong && (bias1dLong.bias === 'short' || bias1dLong.score < 42)) {
        console.log(`LONG real omitido -- bias_1d bajista (score:${bias1dLong.score}) ${symbol}`);
        _realLongLocks.delete(symbol); return;
      }
      if (bias4hLong && (bias4hLong.bias === 'short' || bias4hLong.score < 42)) {
        console.log(`LONG real omitido -- bias_4h bajista (score:${bias4hLong.score}) ${symbol}`);
        _realLongLocks.delete(symbol); return;
      }
    } catch(biasErr) { console.error('LONG real abortado -- error fetching bias (' + symbol + '): ' + biasErr.message); _realLongLocks.delete(symbol); return; }
    const sz = parseFloat(process.env.LONG_SIZE_USD || '8');
    const lev = parseInt(process.env.LONG_LEVERAGE || '3');
    const fill = _LIVE_TRADING ? await openFuturesPosition(symbol, 'LONG', sz, lev, price) : { price };
    if (!fill && _LIVE_TRADING) { console.error('LONG real abortado -- Binance rechazo ' + symbol); _realLongLocks.delete(symbol); return; }
    const ep = fill?.avgPrice || price; // v4.5.47: avgPrice es el campo correcto de openFuturesPosition
    const atr = ep * 0.003;
    const tp1 = ep + atr * 2.5;
    const sl  = ep - atr * 0.8;
    await supabase.from('paper_trades').insert({
      symbol, direction: 'LONG', entry: ep, tp1, sl,
      rr: '1:3.1', size_usd: sz, leverage: lev,
      source: 'sweep', status: 'open', opened_at: new Date().toISOString()
    });
    console.log('LONG real abierto: ' + symbol + ' @ ' + ep.toFixed(4) + ' $' + sz + '/lev=' + lev);
    _realLongLocks.delete(symbol); // v4.5.31: liberar lock tras apertura exitosa
  } catch(e) { console.error('openRealLong error:', e.message); _realLongLocks.delete(symbol); }
}

async function openShadowTrade(symbol, sweepDirection, price) {
  // Counter-trend tracker: bearish sweep -> shadow counter-trend
  const shadowDir = sweepDirection === 'SHORT' ? 'LONG' : 'SHORT';
  // v4.5.38: SHADOW_REAL — ejecutar en Binance si configurado
  const _shSyms = new Set((process.env.SHADOW_REAL_SYMBOLS||'').split(',').map(s=>s.trim()).filter(Boolean));
  const _shDir = process.env.SHADOW_REAL_DIRECTION||'BOTH';
  const _shReal = process.env.SHADOW_REAL==='true' && _LIVE_TRADING && _shSyms.has(symbol) && (_shDir==='BOTH'||shadowDir===_shDir);
  const _shSz = parseFloat(process.env['SHADOW_REAL_SIZE_USD_'+symbol]||process.env.SHADOW_REAL_SIZE_USD||'8');
  const _shLv = parseInt(process.env.SHADOW_REAL_LEVERAGE||'5');
  try {
    const { data: existing } = await supabase.from('paper_trades').select('id')
      .eq('symbol', symbol).eq('status', 'open').eq('source', 'shadow');
    if (existing?.length) return;
    const atr = price * 0.003;
    const isShadowShort = shadowDir === 'SHORT';
    const tp1 = isShadowShort ? price - atr * 2.5 : price + atr * 2.5;
    const sl  = isShadowShort ? price + atr * 0.8  : price - atr * 0.8;
    if (_shReal) {
      const _shFill = await openFuturesPosition(symbol, shadowDir, _shSz, _shLv, price);
      if (!_shFill) { console.error('Shadow real abortado — Binance rechazó ('+symbol+')'); return; }
      console.log('Shadow REAL: '+shadowDir+' '+symbol+' @ '+price.toFixed(4)+' $'+_shSz+'/lev='+_shLv);
      try {
        await supabase.from('paper_trades').insert({
          symbol, direction: shadowDir, entry: price, tp1, sl,
          size_usd: _shSz, leverage: _shLv,
          source: 'shadow', status: 'open', opened_at: new Date().toISOString(),
          market_data: { shadow_real: true }
        });
      } catch(dbErr) {
        // v4.5.38 bug fix: si DB falla, cerrar posición real para no dejar huérfana
        console.error('Shadow DB error — cerrando posición real:', dbErr.message);
        await closeFuturesPosition(symbol, shadowDir, 0, price).catch(e=>console.error('Shadow rollback error:',e.message));
        return;
      }
      const _shTag = ' [REAL]';
      console.log('Shadow CT: '+shadowDir+' '+symbol+' @ '+price.toFixed(2)+' (sweep fue '+sweepDirection+')'+_shTag);
    } else {
      await supabase.from('paper_trades').insert({
        symbol, direction: shadowDir, entry: price, tp1, sl,
        size_usd: 62, leverage: 10,
        source: 'shadow', status: 'open', opened_at: new Date().toISOString(),
        market_data: null
      });
      console.log('Shadow CT: '+shadowDir+' '+symbol+' @ '+price.toFixed(2)+' (sweep fue '+sweepDirection+')');
    }
  } catch(e) { console.error('Shadow trade error:', e.message); }
}

// v4.5.24: paper LONG con real sizing cuando sweep detecta bull run — observar WR antes de activar real
async function openBullRunLong(symbol, price) {
  try {
    const { data: existing } = await supabase.from('paper_trades').select('id')
      .eq('symbol', symbol).eq('status', 'open').eq('source', 'bull_run_long');
    if (existing?.length) return; // ya hay bull_run_long abierto para este símbolo
    const atr = price * 0.003;
    const sizeUsd = parseFloat(process.env['PAPER_SIZE_USD_' + symbol] || process.env.PAPER_SIZE_USD || '62');
    const lev = parseInt(process.env.PAPER_LEVERAGE || '5');
    await supabase.from('paper_trades').insert({
      symbol, direction: 'LONG', entry: price,
      tp1: price + atr * 2.5, sl: price - atr * 0.8,
      size_usd: sizeUsd, leverage: lev, source: 'bull_run_long', status: 'open',
      opened_at: new Date().toISOString()
    });
    console.log(`📈 Bull-run LONG paper: ${symbol} @ ${price.toFixed(2)} size=$${sizeUsd}/lev=${lev} (observando WR antes de activar real)`);
  } catch(e) { console.error('bull_run_long error:', e.message); }
}

async function openSweepCounterTrade(symbol, direction, metrics, reason, liqBonus) {
  if (process.env.SWEEP_ENABLED === 'false') { console.log('⏸ Sweep deshabilitado vía SWEEP_ENABLED=false'); return; } // v4.5.35
  if (_openingTrades.has(symbol)) { console.log('Sweep omitido -- apertura en curso para ' + symbol); return; }
  _openingTrades.add(symbol);
  try {
    // v4.5.30: filtro horario re-activado — datos reales UTC 2,17,18,20h = 0% WR (Lima 21,12,13,15)
    // US morning (UTC 12-16 = Lima 7-11) WR>50%; madrugada y tarde-Lima muy pobres
    if (isHoraBloqueada()) { console.log(`⏸ Sweep ${symbol} omitido — hora bloqueada (${new Date().toISOString().slice(11,16)} UTC)`); return; }
    // v4.5.20: excluir shadow/sol_paper/meanrev de caps — no deben bloquear trades reales
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open').neq('source', 'shadow').neq('source', 'sol_paper').neq('source', 'meanrev').neq('source', 'bull_run_long');
    if (existing?.length) { console.log(`⏭ Sweep trade omitido — ya hay trade abierto para ${symbol}`); return; }
    // v4.5.4: límite global trades simultáneos
    const { data: allOpen } = await supabase.from('paper_trades').select('id,direction').eq('status', 'open').neq('source', 'shadow').neq('source', 'sol_paper').neq('source', 'meanrev').neq('source', 'bull_run_long');
    if ((allOpen?.length || 0) >= 3) { console.log(`⏭ Sweep omitido — ${allOpen.length} trades reales abiertos (máx 3 simultáneos)`); return; }
    // v4.5.7: cap por dirección — máx 1 trade por dirección — previene BTC+ETH+SOL todos LONG/SHORT simultáneos
    const sameDir = (allOpen || []).filter(t => t.direction === direction).length;
    if (sameDir >= 1) { console.log(`⏭ Sweep omitido — ya hay ${sameDir} trade(s) ${direction} abierto(s) (máx 1 por dirección)`); return; }
    // v4.5.9: Circuit Breaker — sweep no lo consultaba, seguía abriendo trades aunque CB activo
    // v4.5.34: LONGs habilitados (safeguards: conf>=92%, bias_1d, bull_run, precio_5min)
    // Circuit breaker por símbolo
    if (_symTrackers[symbol]?.isPaused()) { console.log(`⏸️ ${symbol} Sweep pausado — 3 SL consecutivos`); return; }
    // v4.5.17: bloquear ETH (bull run — sweeps bajistas revertidos de inmediato)
    // v4.5.24: ETH desbloqueado — shadow 30% LONG, bull run normalizado
    // v4.5.19: bloquear WLD (bull run — WR SHORT 14%, mismo perfil que ETH)
    // v4.5.25: WLD desbloqueado — shadow 7d WR=48% n=95, bull run normalizado (52% LONG)
    // v4.5.21: bloquear SUI (bull run — 6 losses consecutivos May-31, LONG anomalías dominantes)
    if (symbol === 'SUIUSDT') { console.log(`⏭ Sweep SUI bloqueado — no confiable en bull run (${direction})`); return; }
    // v4.5.23: auto-bloqueo dinámico por bull run detector
    if (_consecSLPause[symbol] && _consecSLPause[symbol].until > Date.now()) {
      const minLeft = Math.ceil((_consecSLPause[symbol].until - Date.now()) / 60000);
      console.log(`⏸ Sweep ${symbol} en cooldown post-SLs — ${minLeft}min restantes`); return;
    }
    if (_consecSLCount[symbol]?.blockedUntil > Date.now()) {
      const minLeft = Math.ceil((_consecSLCount[symbol].blockedUntil - Date.now()) / 60000);
      console.log(`🚫 Sweep ${symbol} bloqueado por 3-SL diario — ${minLeft}min hasta medianoche`); return;
    }
    if (_bullRunBlocked.has(symbol) && direction === 'LONG') { // v4.5.49: solo bloquear LONGs
      console.log(`⏭ Sweep ${symbol} LONG bloqueado — bull run (>65% LONG 24h)`);
      openBullRunLong(symbol, metrics.lastPrice).catch(e => console.error('bull_run_long error:', e.message));
      return;
    }
    // v4.5.17: restaurar filtro horario (WR madrugada Lima era 0-20%, removido en v4.5.8)
    if (isHoraBloqueada()) { console.log(`⏸️ Sweep ${direction} ${symbol} bloqueado — hora Lima fuera de ventana`); return; }
    if (circuitBreaker.isActive()) { console.log(`⏸️ Sweep ${direction} ${symbol} bloqueado — Circuit Breaker activo hoy`); return; }
    const price = metrics.lastPrice;
    if (!price) { console.log(`⏭ Sweep omitido — sin precio WS para ${symbol}`); return; }
    // v4.4.16 C2b: confirmación precio 5min en sweep — misma lógica que whale trade
    const prices5mSw = wsState[symbol]?.trades?.filter(t => Date.now() - t.time < 5*60*1000).map(t => t.price) || [];
    if (prices5mSw.length >= 5) {
      const priceMove5mSw = (prices5mSw[prices5mSw.length-1] - prices5mSw[0]) / prices5mSw[0] * 100;
      // v4.5.3: BTC mueve menos % — umbral 5min específico por símbolo
      const _isBtc5m = symbol === 'BTCUSDT';
      // v4.5.7: señal extrema (CVD>90% + vol>10x) → threshold mínimo — BTC no mueve % aunque la señal sea real
      const _shortExtreme = _isBtc5m && metrics.cvdLive < -90 && metrics.volumeMultiplier > 10;
      const sweepThreshShort = _shortExtreme ? 0.001 : (metrics.cvdLive < (_isBtc5m ? -70 : -60) && metrics.volumeMultiplier > 6) ? (_isBtc5m ? 0.02 : 0.03) : (_isBtc5m ? 0.07 : 0.1);
      if (direction === 'SHORT' && priceMove5mSw > -sweepThreshShort) {
        console.log(`⏭ Sweep SHORT omitido — precio no confirma bajada en 5min (${priceMove5mSw.toFixed(2)}% vs -${sweepThreshShort}%) — ${symbol}`);
        return;
      }
      const _longExtreme = _isBtc5m && metrics.cvdLive > 90 && metrics.volumeMultiplier > 10;
      const sweepThreshLong = _longExtreme ? 0.001 : (metrics.cvdLive > (_isBtc5m ? 70 : 60) && metrics.volumeMultiplier > 6) ? (_isBtc5m ? 0.02 : 0.03) : (_isBtc5m ? 0.03 : 0.05);
      if (direction === 'LONG' && priceMove5mSw < sweepThreshLong) {
        console.log(`⏭ Sweep LONG omitido — precio no confirma subida en 5min (${priceMove5mSw.toFixed(2)}% vs +${sweepThreshLong}%) — ${symbol}`);
        return;
      }
    }
    const k5m = await axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=20`);
    const highs5m = k5m.data.map(k => parseFloat(k[2])), lows5m = k5m.data.map(k => parseFloat(k[3]));
    const atr5m = highs5m.slice(-10).reduce((s,h,i) => s + (h - lows5m[lows5m.length - 10 + i]), 0) / 10;
    const atrPct = atr5m / price * 100;
    // P8E: Regime ATR filter BTC — ATR trending (expansión de rango) → señal counter es ruido
    if (symbol === 'BTCUSDT') {
      const _atrSeries = highs5m.map((h, i) => h - lows5m[i]);
      const _atrCur = _atrSeries.slice(-1)[0];
      const _atrMa = _atrSeries.reduce((s, v) => s + v, 0) / _atrSeries.length;
      if (_atrCur > _atrMa * 1.5) {
        console.log(`⏭ BTC Sweep omitido — régimen ATR trending (ATR=${_atrCur.toFixed(1)} > MA×1.5=${(_atrMa*1.5).toFixed(1)})`);
        return;
      }
    }
    // v4.4.95: ATR filter eliminado — sweeps reales ocurren exactamente en alta volatilidad; R:R y confidence ya filtran riesgo
    const atr = Math.max(atr5m, price * 0.003);
    const isShort = direction === 'SHORT';
    const tp1 = isShort ? price - atr * 2.5 : price + atr * 2.5;
    const sl = isShort ? price + atr * 0.8 : price - atr * 0.8;
    if (isShort && sl <= price) { console.log(`⚠️ Sweep trade descartado — SL inválido SHORT: sl=${sl.toFixed(4)} <= entry=${price.toFixed(4)} (ATR=${atr5m.toFixed(4)})`); return; }
    if (!isShort && sl >= price) { console.log(`⚠️ Sweep trade descartado — SL inválido LONG: sl=${sl.toFixed(4)} >= entry=${price.toFixed(4)} (ATR=${atr5m.toFixed(4)})`); return; }
    const rrVal = Math.abs(tp1 - price) / Math.abs(sl - price);
    if (rrVal < 1.2) { console.log(`⚠️ Sweep trade descartado — R:R ${rrVal.toFixed(2)} < 1.2`); return; }
    const sweepConfidence = Math.min(95, Math.round(70 + (metrics.volumeMultiplier >= 15 ? 15 : metrics.volumeMultiplier >= 10 ? 10 : 5) + (Math.abs(metrics.cvdLive) >= 50 ? 10 : 5) + liqBonus));
    // v4.5.2: 80→86 — vol<7x da conf=85, bloqueado. Solo vol≥7x (conf≥90) abre. Corta pérdidas de señales débiles.
    if (sweepConfidence < 86) { console.log(`⏭ Sweep trade descartado — confidence ${sweepConfidence}% < 86% (requiere vol≥7x)`); return; }
    // v4.5.13: LONG tiene WR 20% vs SHORT 40% — LONG requiere señal más fuerte
    if (direction === 'LONG' && sweepConfidence < 92) { console.log(`⏭ LONG descartado — conf ${sweepConfidence}% < 92% (LONG requiere señal más fuerte, WR histórico bajo)`); return; }
    let bias4hSweep = null, bias1dSweep = null, oiTrend15mSweep = null, fundingSweep = 0, fib15mSweep = null, sma20dSweep = null;
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
      const _sw1dCloses = k1dSw.data.slice(-21,-1).map(k=>parseFloat(k[4])); sma20dSweep = _sw1dCloses.length>=20 ? _sw1dCloses.reduce((s,v)=>s+v,0)/_sw1dCloses.length : null; // v4.5.81
      oiTrend15mSweep = calcOITrend(oi15mSw);
      fib15mSweep = calcFibonacci(k15mSw.data, price);
    } catch(e) { console.error('sweep 4h/1d bias fetch error:', e.message); } // v4.5.72
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
    // v4.5.4: filtro bias_4h — sweep en contra de tendencia 4h bloqueado (alta tasa de pérdida)
    if (bias4hSweep?.bias === 'long' && direction === 'SHORT') {
      console.log(`⏭ Sweep SHORT omitido — bias_4h alcista (score:${bias4hSweep.score}) — tendencia 4h en contra (${symbol})`);
      return;
    }
    if (bias4hSweep?.bias === 'short' && direction === 'LONG') {
      console.log(`⏭ Sweep LONG omitido — bias_4h bajista (score:${bias4hSweep.score}) — tendencia 4h en contra (${symbol})`);
      return;
    }
    // v4.5.81: SMA20d check — no LONG sweep si activo >3% bajo SMA20d (downtrend macro)
    if (direction === 'LONG' && sma20dSweep !== null && price < sma20dSweep * 0.97) {
      console.log(`⏭ Sweep LONG omitido — precio bajo SMA20d (${price.toFixed(4)} < ${(sma20dSweep*0.97).toFixed(4)}) — v4.5.81`);
      return;
    }
    // v4.5.9: sobreextensión — b4h score > 90 = mercado sobrecomprado, sweep LONG en techo (0W 9L en datos)
    if (bias4hSweep && bias4hSweep.bias === 'long' && bias4hSweep.score > 90 && direction === 'LONG') {
      console.log(`⏭ Sweep LONG omitido — bias_4h sobreextendido (score:${bias4hSweep.score} > 90) — sobrecompra 4h (${symbol})`);
      return;
    }
    // v4.5.9: igual para SHORT sobrevendido
    if (bias4hSweep && bias4hSweep.bias === 'short' && bias4hSweep.score < 10 && direction === 'SHORT') {
      console.log(`⏭ Sweep SHORT omitido — bias_4h sobreextendido (score:${bias4hSweep.score} < 10) — sobreventa 4h (${symbol})`);
      return;
    }
    const mlDataSweep = { confidence: sweepConfidence, direction, mode: 'sweep', price, sweep_reason: reason, cvd_live: metrics.cvdLive, volume_multiplier: metrics.volumeMultiplier, whale_count: metrics.whaleCount, whale_buy_vol: (metrics.whaleBuyVol/1e6).toFixed(2), whale_sell_vol: (metrics.whaleSellVol/1e6).toFixed(2), liq_bonus: liqBonus, atr_5m: atr.toFixed(1), funding_rate: fundingSweep, oi_trend_15m: oiTrend15mSweep?.trend || 'flat', oi_delta_15m: oiTrend15mSweep?.deltaPct || '0', bias_4h: bias4hSweep?.bias || 'neutral', bias_4h_score: bias4hSweep?.score || 50, bias_1d: bias1dSweep?.bias || 'neutral', bias_1d_score: bias1dSweep?.score || 50, fib_level: fib15mSweep?.nearestRetrace?.label || null, fib_dist: fib15mSweep?.nearestRetrace?.dist || null, fib_signal: fib15mSweep?.retImpact?.signal || null, rsi_15m: null, timestamp: new Date().toISOString() };
    // v4.5.5: reset watermarks WS al abrir — previene stale trailHigh/Low de antes del trade
    if (wsState[symbol]) { wsState[symbol].trailHigh = price; wsState[symbol].trailLow = price; wsState[symbol].pollingHigh = price; wsState[symbol].pollingLow = price; }
    // Bug2 fix: abrir en Binance primero — si falla no queda phantom trade en Supabase
    const _isPaperOnlyS = PAPER_ONLY_SYMBOLS.has(symbol);
    const _sweepFillResult = _isPaperOnlyS ? null : await openFuturesPosition(symbol, direction,
      parseFloat(process.env['PAPER_SIZE_USD_' + symbol] || process.env.PAPER_SIZE_USD || '62'),
      parseInt(process.env.PAPER_LEVERAGE || '10'), price);
    if (!_sweepFillResult && _LIVE_TRADING && !_isPaperOnlyS) { console.error(`Sweep trade abortado — Binance rechazó orden ${symbol}`); return; }
    await supabase.from('paper_trades').insert({ symbol, direction, entry: _sweepFillResult?.avgPrice || price, tp1, tp2: isShort ? price - atr * 4 : price + atr * 4, sl, rr: `1:${rrVal.toFixed(1)}`, confidence: sweepConfidence, size_usd: parseFloat(process.env['PAPER_SIZE_USD_' + symbol] || process.env.PAPER_SIZE_USD || '62'), leverage: parseInt(process.env.PAPER_LEVERAGE || '10'), source: _isPaperOnlyS ? 'sol_paper' : 'sweep', status: 'open', opened_at: new Date().toISOString(), market_data: mlDataSweep });
    // Cooldown se setea aquí — solo cuando trade realmente abre, no en detección de anomalía
    const _ck = `${symbol}_${direction}`;
    killSwitchCooldown[_ck] = Date.now();
    console.log(`⚡ Sweep trade abierto: ${direction} ${symbol} @ $${price} R:R 1:${rrVal.toFixed(1)} conf:${sweepConfidence}%`);
    if (process.env.TELEGRAM_CHAT_ID) {
      const e = direction === 'SHORT' ? '▼' : '▲';
      const _dSw=new Date(), _limaSw=`🕐 Apertura: ${_dSw.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dSw.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
      const msg = `⚡ *Sweep Trade Abierto — ${symbol}*\n${e} ${direction} @ $${parseInt(price).toLocaleString()}\n🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}\n📐 R:R 1:${rrVal.toFixed(1)} | ${sweepConfidence}%\n⚡ ${reason}\n${_limaSw}\nFuente: 🌊 Sweep`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(e) { console.error("Telegram send error:", e.message); }
    }
  } catch(e) { console.error('Sweep trade error:', e.message); } finally { _openingTrades.delete(symbol); }
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
    // Cache 60s — evita hammear Binance REST y previene IP ban
    const _mc = _marketCache[symbol];
    if (_mc && Date.now() - _mc.ts < 60000) {
      const cached = { ..._mc.data };
      // Actualizar precio y métricas WS en tiempo real sobre datos cacheados
      const wsLive = getWsMetrics(symbol);
      if (wsLive?.lastPrice) cached.price = wsLive.lastPrice;
      if (wsLive) cached.wsMetrics = wsLive;
      return res.json(cached);
    }
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
    const responseData = { price, change24h:parseFloat(ticker.data.priceChangePercent), volume24h:parseFloat(ticker.data.quoteVolume), openInterest:parseFloat(oiRes.data.openInterest), fundingRate, markPrice:parseFloat(funding.data.markPrice), indexPrice:parseFloat(funding.data.indexPrice), rsi15m, rsiOverbought:rsi15m>70, rsiOversold:rsi15m<30, cvd15m, vrvp, bb15m, vwap15m:vwap15m.toFixed(1), oiTrends:{ tf15m:oiTrend15m, tf1h:oiTrend1h, tf4h:oiTrend4h }, volDeltaPct:parseFloat(volDeltaPct), orderBook:ob, liqMagnets, divergences:allDivs, combinedSignal, scalpSignal, doublePatterns, bias:{ tf15m:bias15m, tf1h:bias1h, tf4h:bias4h, tf1d:bias1d }, klines:k15m.data.slice(-20), liqData, deepOB, whaleData, fibonacci:{ tf15m:fib15m, tf4h:fib4h }, wsMetrics };
    _marketCache[symbol] = { ts: Date.now(), data: responseData };
    res.json(responseData);
  } catch(e) {
    console.error('Market error:',e.message);
    // Fallback: si hay cache aunque sea viejo, devuelvo con precio WS actualizado
    const _mc = _marketCache[symbol];
    if (_mc) {
      console.log(`📦 Market fallback cache para ${symbol} (${Math.round((Date.now()-_mc.ts)/1000)}s old)`);
      const cached = { ..._mc.data, _stale: true, _staleReason: e.message };
      const wsLive = getWsMetrics(symbol);
      if (wsLive?.lastPrice) cached.price = wsLive.lastPrice;
      if (wsLive) cached.wsMetrics = wsLive;
      return res.json(cached);
    }
    // Sin cache: devolver precio WS mínimo para que el panel no quede en blanco
    const wsLive = getWsMetrics(symbol);
    const wsPrice = wsLive?.lastPrice || wsState[symbol]?.lastPrice || 0;
    res.status(503).json({ error: e.message, price: wsPrice, wsMetrics: wsLive, _noCache: true });
  }
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
        const { data: oppTrades } = await supabase.from('paper_trades').select('*').eq('symbol', symbol).eq('status', 'open').eq('direction', oppositeDir).in('source', ['auto', 'manual']); // v4.5.52: only close paper auto/manual, not real sweep/whale
        if (oppTrades?.length) {
          for (const oppTrade of oppTrades) {
            const currentPrice = wsState[symbol]?.lastPrice || signal.entry, entry = parseFloat(oppTrade.entry);
            const priceDiff = oppTrade.direction === 'LONG' ? (currentPrice - entry) / entry : (entry - currentPrice) / entry;
            const _lev2 = parseFloat(oppTrade.leverage || 10);
            const pnl_usd = parseFloat((parseFloat(oppTrade.size_usd) * priceDiff * _lev2 - parseFloat(oppTrade.size_usd) * _lev2 * _FEE_RT).toFixed(2));
            const pnl_pct = parseFloat((priceDiff * _lev2 * 100).toFixed(2));
            _slTpLocks[oppTrade.id] = true; setTimeout(() => { delete _slTpLocks[oppTrade.id]; }, 10000); // v4.5.52
            await supabase.from('paper_trades').update({ status: pnl_usd >= 0 ? 'won' : 'lost', close_price: currentPrice, close_reason: 'signal_reversal', pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', oppTrade.id);
            _invalidateSlCache(symbol); // v4.5.70: invalidate cache on signal_reversal close
            if (oppTrade.source !== 'manual' && oppTrade.source !== 'shadow' && oppTrade.source !== 'bull_run_long' && oppTrade.source !== 'sol_paper' && !PAPER_ONLY_SYMBOLS.has(symbol)) circuitBreaker.addPnl(pnl_usd); // v4.5.59, v4.5.73
            delete _maxProfitCache[oppTrade.id]; delete _trailingLastUpdate[oppTrade.id]; delete _partialTpTrades[oppTrade.id];
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

// ── RESUMEN DIARIO 23:00 Lima ──────────────────────────────────────
let _dailySummarySentToday = '';

async function sendDailySummary() {
  if (!process.env.TELEGRAM_CHAT_ID) return;
  try {
    const startUTC = circuitBreaker.getLimaStartOfDayUTC();
    const { data: trades } = await supabase
      .from('paper_trades')
      .select('symbol,direction,entry,close_price,pnl_usd,status,source,close_reason,opened_at,closed_at')
      .gte('opened_at', startUTC)
      .neq('source', 'manual')
      .order('opened_at', { ascending: true });

    const closed = (trades || []).filter(t => t.status !== 'open');
    const open = (trades || []).filter(t => t.status === 'open');
    const wins = closed.filter(t => t.status === 'won');
    const losses = closed.filter(t => t.status === 'lost');
    const totalPnl = closed.reduce((s, t) => s + parseFloat(t.pnl_usd || 0), 0);
    const wr = closed.length ? Math.round(wins.length / closed.length * 100) : 0;

    // PnL por fuente
    const bySource = {};
    closed.forEach(t => {
      const src = t.source || 'unknown';
      if (!bySource[src]) bySource[src] = { w: 0, l: 0, pnl: 0 };
      if (t.status === 'won') bySource[src].w++;
      else bySource[src].l++;
      bySource[src].pnl += parseFloat(t.pnl_usd || 0);
    });
    const srcLines = Object.entries(bySource)
      .map(([src, d]) => `  ${src}: ${d.w}W ${d.l}L $${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}`)
      .join('\n');

    const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
    const resultEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const fecha = new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric' });

    const msg = `📊 *Resumen del día — ${fecha}*\n━━━━━━━━━━━━━━\n${resultEmoji} PnL total: *${pnlStr}*\n📈 ${wins.length}W / ${losses.length}L — WR ${wr}%\n🔄 ${closed.length} trades cerrados${open.length ? ` | ${open.length} abierto(s)` : ''}\n━━━━━━━━━━━━━━\n${srcLines || '  Sin trades'}\n━━━━━━━━━━━━━━\n⏸️ Circuit Breaker: ${circuitBreaker.isActive() ? 'ACTIVO' : 'OK'} (PnL acum: $${(circuitBreaker.dailyPnl[circuitBreaker.getToday()] || 0).toFixed(2)})`;

    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    console.log(`📊 Resumen diario enviado — ${closed.length} trades, PnL ${pnlStr}`);
  } catch(e) { console.error('Daily summary error:', e.message); }
}


async function checkOrphanPositions() {
  if (!_LIVE_TRADING) return;
  try {
    const ts=Date.now()+binanceTimeOffset;
    const sig=require('crypto').createHmac('sha256',BINANCE_SECRET).update('timestamp='+ts).digest('hex');
    const r=await axios.get('https://fapi.binance.com/fapi/v2/positionRisk?timestamp='+ts+'&signature='+sig,{headers:{'X-MBX-APIKEY':BINANCE_API_KEY},timeout:10000});
    const open=(r.data||[]).filter(p=>Math.abs(parseFloat(p.positionAmt))>0);
    if(!open.length){console.log('Orphan check OK');return;}
    for(const pos of open){
      const sym=pos.symbol;
      const {data:db}=await supabase.from('paper_trades').select('id').eq('symbol',sym).eq('status','open').not('source','in','(shadow,bull_run_long,sol_paper)');
      if(!db?.length){
        const amt=parseFloat(pos.positionAmt),dir=amt>0?'LONG':'SHORT';
        console.error('ORPHAN DETECTADA: '+dir+' '+sym+' cerrando...');
        await closeFuturesPosition(sym,dir,0,parseFloat(pos.markPrice||pos.entryPrice)).catch(e=>console.error('close err:',e));
        sendWaDelta('Posicion huerfana cerrada: '+dir+' '+sym).catch(()=>{});
      }
    }
    console.log('Orphan check: '+open.length+' pos verificadas');
  }catch(e){console.error('Orphan error:',e.message);}
}
function startAlertJob() {
  // WebSocket y monitoreo corren siempre, con o sin Telegram
  setInterval(monitorPaperTrades, 1 * 60 * 1000);
  setTimeout(monitorPaperTrades, 15000);
  if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) {
    console.log("Alertas Telegram desactivadas — sweep WS activo");
  }

  // ── Resumen diario 23:00 Lima — check cada minuto
  setInterval(() => {
    const _dSummary = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
    const today = circuitBreaker.getToday();
    if (_dSummary.getHours() === 23 && _dSummary.getMinutes() === 0 && _dailySummarySentToday !== today) {
      _dailySummarySentToday = today;
      sendDailySummary().catch(e => console.error('[daily summary]', e.message)); // v4.5.73
    }
  }, 60 * 1000);

    // ── Mean Reversion scanner — cada 1 minuto

  // v4.5.44: Auto-update WEEKLY_CB_BALANCE cada lunes 00:00 Lima
  setInterval(()=>{
    if(!_LIVE_TRADING) return;
    const d=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Lima'}));
    if(d.getDay()===1&&d.getHours()===0&&d.getMinutes()===0){
      const t=Date.now()+binanceTimeOffset;
      const s=require('crypto').createHmac('sha256',BINANCE_SECRET).update('timestamp='+t).digest('hex');
      axios.get('https://fapi.binance.com/fapi/v2/balance?timestamp='+t+'&signature='+s,{headers:{'X-MBX-APIKEY':BINANCE_API_KEY}}).then(r=>{
        const b=(r.data||[]).find(a=>a.asset==='USDT');
        if(b){
          process.env.WEEKLY_CB_BALANCE=parseFloat(b.balance).toFixed(2);
          try { require('fs').writeFileSync('/home/noc/samael_delta/.wcb_state.json', JSON.stringify({base:process.env.WEEKLY_CB_BALANCE,ts:Date.now()})); } catch(_){} // v4.5.51: persist across restarts
          console.log('Weekly CB auto-actualizado: $'+process.env.WEEKLY_CB_BALANCE);
          sendWaDelta('Balance semanal: $'+process.env.WEEKLY_CB_BALANCE).catch(()=>{});
        }
      }).catch(e=>console.error('Weekly CB auto:',e.message));
    }
  },60*1000);
  setInterval(runMeanRevScanner, 30 * 1000); // v4.5.76: 30s catches brief h1Move spikes
  // v4.5.76b: pre-warm h1 klines cada 3min (WS trigger funciona en horas bloqueadas)
  setInterval(async () => { const _pw = (process.env.WS_SYMBOLS||'').split(',').map(s=>s.trim()).filter(Boolean); for (const _s of _pw) { try { await getCachedKlines(_s,'1h',3); } catch(_){} } }, 3*60*1000);
  console.log('📈 MeanRev 30s + WS h1Trig activo (v4.5.76b)');

  // DESACTIVADO — runAutoAnalysis usa Anthropic API, no necesario en sweep-only mode
  // const intervalMin = parseInt(process.env.ALERT_INTERVAL_MIN || '15'), symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  // console.log(`✅ Alertas activas — cada ${intervalMin} min para: ${symbols.join(', ')}`);
  // setInterval(async () => { for (const symbol of symbols) { await runAutoAnalysis(symbol.trim()); await new Promise(r => setTimeout(r, 8000)); } }, intervalMin * 60 * 1000);
  // setTimeout(async () => { for (const symbol of symbols) { await runAutoAnalysis(symbol.trim()); await new Promise(r => setTimeout(r, 8000)); } }, 15000);
  const wsSymbols = (process.env.WS_SYMBOLS || process.env.ALERT_SYMBOLS || 'BTCUSDT,ETHUSDT').split(',');
  wsSymbols.forEach(sym => { setTimeout(() => connectWebSocket(sym.trim()), 2000); });
  console.log(`🔌 WebSocket iniciando para: ${wsSymbols.join(', ')}`);
  // v4.5.55: cleanup zombie paper trades cuyos símbolos salieron de WS_SYMBOLS
  setTimeout(async () => {
    try {
      const activeSet = new Set(wsSymbols.map(s => s.trim()));
      const { data: openAll } = await supabase.from('paper_trades').select('id,symbol,direction,entry,size_usd,leverage').eq('status','open');
      if (!openAll?.length) return;
      const zombies = openAll.filter(t => !activeSet.has(t.symbol));
      if (!zombies.length) return;
      const now = new Date().toISOString();
      for (const t of zombies) {
        await supabase.from('paper_trades').update({ status:'cancelled', close_reason:'zombie_cleanup', pnl_usd:0, closed_at:now }).eq('id',t.id); // v4.5.59: phantom
        console.log(`🧹 Zombie cleanup: #${t.id} ${t.symbol} ${t.direction} (símbolo fuera de WS_SYMBOLS)`);
      }
    } catch(e) { console.error('zombie cleanup error:', e.message); }
  }, 10000);
  setInterval(async () => {
    for (const sym of wsSymbols) {
      const s = sym.trim();
      const state = wsState[s];
      if (!state || !wsConnections[s]) continue;
      const elapsed = Date.now() - (state.lastWsMsgTime || 0);
      const watchdogMs = (s.includes('BTC') || s.includes('ETH')) ? 60000 : 180000;
      if (elapsed > watchdogMs) {
        _wsNoDataCount[s] = (_wsNoDataCount[s] || 0) + 1;
        console.log(`⚠️ WS watchdog: sin aggTrade ${(elapsed/1000)|0}s — reconectando ${s} (fallo #${_wsNoDataCount[s]})`);
        // Alerta Telegram si 3+ fallos consecutivos — WS stream roto a nivel de red
        if (_wsNoDataCount[s] === 3 && process.env.TELEGRAM_CHAT_ID) {
          try {
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID,
              `🚨 *WS CRÍTICO: ${s} sin datos ${_wsNoDataCount[s]} reconexiones seguidas*\nStream aggTrade no entrega datos — posible bloqueo de red o URL incorrecta.\nServidor: v${require('./package.json').version || '?'}\n🕐 ${new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })}`,
              { parse_mode: 'Markdown' });
          } catch(e) { console.error('Telegram WS alert error:', e.message); }
        }
        state._reconnectDelay = Math.min(60000, (state._reconnectDelay || 5000) * 2);
        wsConnections[s].terminate();
        delete wsConnections[s];
        setTimeout(() => connectWebSocket(s), state._reconnectDelay);
      } else {
        _wsNoDataCount[s] = 0; // reset en cuanto llegan datos
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
        // SPOT klines — self-consistent con BINANCE_WS spot stream (stream.binance.com:9443)
        const k1m = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${sym.trim()}&interval=1m&limit=10`);
        const vols = k1m.data.map(k => parseFloat(k[4]) * parseFloat(k[5]));
        const avg = vols.reduce((a,b)=>a+b,0)/vols.length;
        if (wsState[sym.trim()]) { wsState[sym.trim()].avgVolume1m = avg; }
      } catch(e) { console.error(`pollBaseline ${sym} error:`, e.message); } // v4.5.72
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
    const lastAggTradeSec = st?.lastWsMsgTime ? Math.round((now - st.lastWsMsgTime) / 1000) : null;
    const tradesLast60s = st?.trades?.filter(t => now - t.time < 60000).length || 0;
    debug[sym] = {
      healthy: !!wsConnections[sym] && lastAggTradeSec !== null && lastAggTradeSec < 30,
      connected: !!wsConnections[sym],
      lastAggTrade: lastAggTradeSec !== null ? `${lastAggTradeSec}s ago` : 'never',
      tradesLast60s,
      lastPrice: st?.lastPrice || 0,
      noDataStreak: _wsNoDataCount?.[sym] || 0,
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
    const _admS=process.env.ADMIN_SECRET; if(!_admS||req.headers['x-admin-secret']!==_admS) return res.status(401).json({error:'Unauthorized'}); // v4.5.71
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
    const _admS=process.env.ADMIN_SECRET; if(!_admS||req.headers['x-admin-secret']!==_admS) return res.status(401).json({error:'Unauthorized'}); // v4.5.71
    const { id } = req.params, { close_price, close_reason } = req.body;
    const { data: trade, error: fetchErr } = await supabase.from('paper_trades').select('*').eq('id', id).single();
    if (fetchErr) throw fetchErr;
    const entry = parseFloat(trade.entry), closeP = parseFloat(close_price), size = parseFloat(trade.size_usd);
    const _lev3 = parseFloat(trade.leverage || 10);
    // Cancelar siempre registra pnl 0 y status cancelled
    if (close_reason === 'manual') {
      const { data, error } = await supabase.from('paper_trades').update({ status: 'cancelled', close_price: closeP, close_reason: 'manual', pnl_usd: 0, pnl_pct: 0, closed_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) throw error;
      _invalidateSlCache(trade.symbol); // v4.5.70: invalidate cache on manual cancel
      return res.json({ ok: true, trade: data });
    }
    const priceDiff = trade.direction === 'LONG' ? (closeP - entry) / entry : (entry - closeP) / entry;
    const pnl_usd = parseFloat((size * priceDiff * _lev3 - size * _lev3 * _FEE_RT).toFixed(2)), pnl_pct = parseFloat((priceDiff * _lev3 * 100).toFixed(2));
    const finalStatus = pnl_usd >= 0 ? 'won' : 'lost';
    const { data, error } = await supabase.from('paper_trades').update({ status: finalStatus, close_price: closeP, close_reason, pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) throw error;
    _invalidateSlCache(trade.symbol); // v4.5.70: invalidate cache on close
    if (trade.source !== 'manual' && trade.source !== 'shadow' && trade.source !== 'bull_run_long' && trade.source !== 'sol_paper' && !PAPER_ONLY_SYMBOLS.has(trade.symbol)) circuitBreaker.addPnl(pnl_usd); // v4.5.59
    delete _maxProfitCache[id]; delete _trailingLastUpdate[id]; delete _partialTpTrades[id];
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

let _monitorRunning = false; // v4.5.59: prevent setInterval overlap
async function monitorPaperTrades() {
  if (_monitorRunning) return;
  _monitorRunning = true;
  try {
    const { data: openTrades } = await supabase.from('paper_trades').select('*').eq('status', 'open');
    const _closedInThisRun = new Set();
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
            const _levLat = parseFloat(trade.leverage || 5);
            const pnl_usd = parseFloat(((trade.direction === 'LONG'
              ? (currentWsPrice - entry) / entry * parseFloat(trade.size_usd) * _levLat
              : (entry - currentWsPrice) / entry * parseFloat(trade.size_usd) * _levLat) - parseFloat(trade.size_usd) * _levLat * _FEE_RT).toFixed(2)); // v4.5.59: fee
            const pnl_pct = trade.direction === 'LONG'
              ? (currentWsPrice - entry) / entry * _levLat * 100
              : (entry - currentWsPrice) / entry * _levLat * 100;
            _slTpLocks[trade.id] = true; setTimeout(() => { delete _slTpLocks[trade.id]; }, 10000); // v4.5.50
            await supabase.from('paper_trades').update({
              status: pnl_usd >= 0 ? 'won' : 'lost',
              close_price: currentWsPrice,
              close_reason: 'timeout_lateral',
              pnl_usd: parseFloat(pnl_usd.toFixed(2)),
              pnl_pct: parseFloat(pnl_pct.toFixed(2)),
              closed_at: new Date().toISOString()
            }).eq('id', trade.id);
            _invalidateSlCache(trade.symbol); // v4.5.73
            if (trade.source !== 'manual' && !PAPER_ONLY_SYMBOLS.has(trade.symbol)) circuitBreaker.addPnl(pnl_usd); // v4.5.59: manual is paper
            _closedInThisRun.add(trade.id);
            delete _maxProfitCache[trade.id]; delete _trailingLastUpdate[trade.id]; delete _partialTpTrades[trade.id];
            await closeFuturesPosition(trade.symbol, trade.direction);
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
            ? (currentWsPrice - entry) / entry * parseFloat(trade.size_usd) * lev - parseFloat(trade.size_usd) * lev * _FEE_RT
            : (entry - currentWsPrice) / entry * parseFloat(trade.size_usd) * lev - parseFloat(trade.size_usd) * lev * _FEE_RT).toFixed(2)); // v4.5.50: fee
          const pnl_pct = parseFloat((trade.direction === 'LONG'
            ? (currentWsPrice - entry) / entry * lev * 100
            : (entry - currentWsPrice) / entry * lev * 100).toFixed(2));
          _slTpLocks[trade.id] = true; setTimeout(() => { delete _slTpLocks[trade.id]; }, 10000); // v4.5.50
          await supabase.from('paper_trades').update({
            status: pnl_usd >= 0 ? 'won' : 'lost',
            close_price: currentWsPrice,
            close_reason: 'timeout',
            pnl_usd, pnl_pct,
            closed_at: new Date().toISOString()
          }).eq('id', trade.id);
          _invalidateSlCache(trade.symbol); // v4.5.73
          if (trade.source !== "shadow" && trade.source !== "manual" && trade.source !== "bull_run_long" && trade.source !== "sol_paper" && !PAPER_ONLY_SYMBOLS.has(trade.symbol)) circuitBreaker.addPnl(pnl_usd); // v4.5.63: scalping timeout source guard
          _closedInThisRun.add(trade.id);
          delete _maxProfitCache[trade.id]; delete _trailingLastUpdate[trade.id]; delete _partialTpTrades[trade.id];
          if (_LIVE_TRADING) await closeFuturesPosition(trade.symbol, trade.direction).catch(e => console.error('Scalping timeout close err:', e.message)); // v4.5.50
          console.log(`⏱️ Timeout scalping 2h: ${trade.direction} ${trade.symbol} cerrado a $${currentWsPrice} — ${minutosAbierto.toFixed(0)}min — PnL: $${pnl_usd}`);
          if (process.env.TELEGRAM_CHAT_ID) {
            const _dCt = new Date(), _limaCt = `${_dCt.toLocaleDateString('es-PE',{timeZone:'America/Lima',day:'2-digit',month:'2-digit'})} ${_dCt.toLocaleTimeString('es-PE',{timeZone:'America/Lima',hour:'2-digit',minute:'2-digit',hour12:true})}`;
            const msgT = `${pnl_usd >= 0 ? '✅' : '❌'} ${trade.direction} ${trade.symbol} — ⚡ Scalping\n💰 Entry: $${parseInt(entry).toLocaleString()} → $${parseInt(currentWsPrice).toLocaleString()}\n🎯 Razón: Timeout 2h\n💵 PnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd}\n🕐 Cierre: ${_limaCt}`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msgT); } catch(e) { console.error('Telegram send error:', e.message); }
          }
        }
      } else {
        // ── Timeout 60min para meanrev, 6h para whale/wall/sweep ──
        const minAbierto6h = (Date.now() - new Date(trade.opened_at).getTime()) / 60000;
        const timeoutMin = trade.source === 'meanrev' ? (trade.market_data?.exit_mins || 60) : 360; // v4.5.82: respect exit_mins from market_data
        if (minAbierto6h >= timeoutMin) {
          const wsP6h = wsState[trade.symbol]?.lastPrice;
          if (wsP6h) {
            const e6h = parseFloat(trade.entry), lev6h = parseFloat(trade.leverage || 5);
            const pDiff6h = trade.direction === 'LONG' ? (wsP6h - e6h) / e6h : (e6h - wsP6h) / e6h;
            const pnl6h = parseFloat((pDiff6h * parseFloat(trade.size_usd) * lev6h - parseFloat(trade.size_usd) * lev6h * _FEE_RT).toFixed(2)); // v4.5.49: fee deducted
            const pnlPct6h = parseFloat((pDiff6h * lev6h * 100).toFixed(2));
            _slTpLocks[trade.id] = true; setTimeout(() => { delete _slTpLocks[trade.id]; }, 10000); // v4.5.49: lock to prevent double-close
            await supabase.from('paper_trades').update({
              status: pnl6h >= 0 ? 'won' : 'lost', close_price: wsP6h,
              close_reason: 'timeout', pnl_usd: pnl6h, pnl_pct: pnlPct6h,
              closed_at: new Date().toISOString()
            }).eq('id', trade.id);
            _invalidateSlCache(trade.symbol); // v4.5.73
            const _paperSrcs6h = new Set(process.env.MEANREV_REAL === 'true' ? ['shadow','bull_run_long','sol_paper'] : ['shadow','bull_run_long','sol_paper','meanrev']);
            if (!_paperSrcs6h.has(trade.source) && !PAPER_ONLY_SYMBOLS.has(trade.symbol)) { circuitBreaker.addPnl(pnl6h); await closeFuturesPosition(trade.symbol, trade.direction); } // v4.5.56, v4.5.73
            _closedInThisRun.add(trade.id);
            delete _maxProfitCache[trade.id]; delete _trailingLastUpdate[trade.id]; delete _partialTpTrades[trade.id];
            console.log(`⏱️ Timeout 6h (${trade.source}): ${trade.direction} ${trade.symbol} a $${wsP6h} — ${minAbierto6h.toFixed(0)}min — PnL: $${pnl6h}`);
          }
        }
      }
    }
    if (!openTrades?.length) return;
    for (const trade of openTrades) {
      if (_closedInThisRun.has(trade.id)) continue;
      if (_slTpLocks[trade.id]) continue; // v4.5.59: prevent double-close with WS path
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
          const _slDecP = currentPrice >= 100 ? 2 : currentPrice >= 1 ? 4 : 6; // v4.5.57: adaptive precision
          const newSlRounded = parseFloat(newSl.toFixed(_slDecP));
          await supabase.from('paper_trades').update({ sl: newSlRounded }).eq('id', trade.id);
          sl = newSlRounded;
          _invalidateSlCache(trade.symbol); // v4.5.69: mirror WS path — polling also must invalidate cache
          console.log(`📈 Trailing stop: ${trade.direction} ${trade.symbol} SL ${parseFloat(trade.sl).toFixed(_slDecP)} → ${newSlRounded.toFixed(_slDecP)} (precio: ${currentPrice.toFixed(0)}, +${priceDiffPct.toFixed(2)}%)`);
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
          const entry = parseFloat(trade.entry);
          const _lev4 = parseFloat(trade.leverage || 10);
          // v4.5.4: usar precio exacto SL/TP — simula stop-limit (no slippage en paper trading)
          const closeAtPrice = closeReason === 'sl' ? sl : closeReason === 'tp2' ? tp2 : tp1;
          const priceDiff = trade.direction === 'LONG' ? (closeAtPrice - entry) / entry : (entry - closeAtPrice) / entry;
          const pnl_usd = parseFloat((trade.size_usd * priceDiff * _lev4 - trade.size_usd * _lev4 * _FEE_RT).toFixed(2)), pnl_pct = parseFloat((priceDiff * _lev4 * 100).toFixed(2));
          if (Math.abs(pnl_usd) > parseFloat(trade.size_usd) * _lev4 * 1.1) { await supabase.from('paper_trades').update({ status: 'cancelled', close_price: closeAtPrice, close_reason: 'invalid_pnl', pnl_usd: 0, pnl_pct: 0, closed_at: new Date().toISOString() }).eq('id', trade.id); _invalidateSlCache(trade.symbol); continue; } // v4.5.59, v4.5.73
          // Si el trailing movió el SL al profit zone y cierra en ganancia → trailing_tp
          const trailingActuo = closeReason === 'sl' && pnl_usd > 0;
          const finalCloseReason = trailingActuo ? 'trailing_tp' : closeReason;
          const tradeStatus = pnl_usd > 0 ? 'won' : 'lost';
          if (trailingActuo) console.log(`🎯 Trailing TP: ${trade.direction} ${trade.symbol} cerró en ganancia $${pnl_usd} vía trailing stop`);
          _slTpLocks[trade.id] = true; setTimeout(() => { delete _slTpLocks[trade.id]; }, 10000); // v4.5.50
          await supabase.from('paper_trades').update({ status: tradeStatus, close_price: closeAtPrice, close_reason: finalCloseReason, pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', trade.id);
          _invalidateSlCache(trade.symbol); // v4.5.73
          // ── Circuit Breaker: acumular PnL diario ──
          if ((trade.source === 'scalping' || trade.source === 'sweep' || trade.source === 'auto' || trade.source === 'meanrev') && !PAPER_ONLY_SYMBOLS.has(trade.symbol)) {
            circuitBreaker.addPnl(pnl_usd); // v4.5.61: exclude Cantera paper trades from CB
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
          // v4.5.50: cerrar posicion real en Binance si WS gap perdio el evento
          const _paperSrcsM = new Set(process.env.MEANREV_REAL === 'true' ? ['shadow','bull_run_long','sol_paper'] : ['shadow','bull_run_long','sol_paper','meanrev']);
          if (!_paperSrcsM.has(trade.source) && _LIVE_TRADING && !PAPER_ONLY_SYMBOLS.has(trade.symbol)) await closeFuturesPosition(trade.symbol, trade.direction).catch(e => console.error('Monitor poll close err:', e.message));
        }
      } catch(e) { console.error(`monitorPaperTrades trade #${trade.id} ${trade.symbol} error:`, e.message); }
    }
  } catch(e) { console.error('Monitor paper trades error:', e.message); }
  finally { _monitorRunning = false; } // v4.5.59
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
  const _admS=process.env.ADMIN_SECRET; if(!_admS||req.headers['x-admin-secret']!==_admS) return res.status(401).json({error:'Unauthorized'}); // v4.5.71
  if (scalpingActive) return res.json({ ok: false, message: 'Scalping ya activo' });
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(','), intervalMin = parseFloat(process.env.SCALP_INTERVAL_MIN || '3');
  scalpingActive = true;
  scalpingInterval = setInterval(async () => { for (const sym of symbols) { try { await runScalpingAnalysis(sym.trim()); } catch(_) {} await new Promise(r => setTimeout(r, 2000)); } }, intervalMin * 60 * 1000);
  setTimeout(async () => { for (const sym of symbols) { try { await runScalpingAnalysis(sym.trim()); } catch(_) {} } }, 5000);
  res.json({ ok: true, message: `Scalping activado cada ${intervalMin} min` });
});

app.post('/api/scalping/stop', (req, res) => {
  const _admS=process.env.ADMIN_SECRET; if(!_admS||req.headers['x-admin-secret']!==_admS) return res.status(401).json({error:'Unauthorized'}); // v4.5.71
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
    // Fecha Lima (UTC-5, sin DST) como YYYY-MM-DD
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  },
  getLimaStartOfDayUTC() {
    const today = this.getToday(); // YYYY-MM-DD en Lima
    return new Date(`${today}T00:00:00-05:00`).toISOString(); // Lima medianoche → UTC
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
  },
  // v4.5.10: inicializar desde Supabase — sobrevive restarts de Railway
  async initFromSupabase() {
    try {
      const startUTC = this.getLimaStartOfDayUTC();
      const { data } = await supabase
        .from('paper_trades')
        .select('pnl_usd')
        .gte('closed_at', startUTC)
        .neq('source', 'manual')
        .neq('source', 'shadow')
        .neq('source', 'sol_paper')
        .neq('source', 'bull_run_long')
        .not('pnl_usd', 'is', null)
        .not('symbol', 'in', '(DOGEUSDT,BTCUSDT)'); // v4.5.47, v4.5.73: excluir Cantera symbols del CB
      if (!data?.length) { console.log('✅ CB init — sin trades cerrados hoy, PnL=0'); return; }
      const totalPnl = data.reduce((s, t) => s + parseFloat(t.pnl_usd || 0), 0);
      const day = this.getToday();
      this.dailyPnl[day] = totalPnl;
      if (totalPnl <= this.LIMIT) {
        this.paused[day] = true;
        console.log(`🔴 CB init desde Supabase — PnL hoy: $${totalPnl.toFixed(2)} → CIRCUIT BREAKER ACTIVO`);
      } else {
        console.log(`✅ CB init desde Supabase — PnL hoy: $${totalPnl.toFixed(2)} (límite: $${this.LIMIT})`);
      }
    } catch(e) { console.error('CB init error:', e.message); }
  }
};

// ── CONSECUTIVE LOSS TRACKER por símbolo v4.4.40 ──
function createLossTracker(sym, maxLosses = 2, pauseMin = 30) {
  return {
    symbol: sym,
    consecutive: 0,
    pausedUntil: null,
    MAX: maxLosses,
    PAUSE_MIN: pauseMin,
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

// Circuit breaker por símbolo — sweep/whale — 3 SL consecutivos → 24h pausa
const _symTrackers = {};
['BTCUSDT','ETHUSDT','DOGEUSDT','WLDUSDT','SUIUSDT','XRPUSDT','BNBUSDT','SOLUSDT'].forEach(s => { // v4.5.24-fix: DOGE+BNB, removed PEPE+WIF
  _symTrackers[s] = createLossTracker(s.replace('1000PEPE','PEPE').replace('USDT','') + '-sweep', 3, 1440);
});

// v4.5.21: reconstruir estado pausado de symTrackers desde Supabase tras restart
// El estado era in-memory y se perdía en cada deploy/restart — reanudaba SUI tras 3 losses
async function initSymTrackers() {
  for (const symbol of Object.keys(_symTrackers)) {
    try {
      const { data } = await supabase
        .from('paper_trades')
        .select('status, closed_at')
        .eq('symbol', symbol)
        .in('source', ['sweep', 'whale'])
        .not('status', 'eq', 'open')
        .order('closed_at', { ascending: false })
        .limit(5);
      if (!data?.length) continue;
      let consecutive = 0;
      let lastLossTime = null;
      for (const trade of data) {
        if (trade.status === 'lost') {
          consecutive++;
          if (!lastLossTime) lastLossTime = new Date(trade.closed_at);
        } else { break; }
      }
      if (consecutive >= 3 && lastLossTime) {
        const pauseEnd = new Date(lastLossTime.getTime() + 1440 * 60 * 1000);
        if (pauseEnd > new Date()) {
          _symTrackers[symbol].pausedUntil = pauseEnd.getTime();
          _symTrackers[symbol].consecutive = consecutive;
          const minLeft = Math.ceil((pauseEnd - new Date()) / 60000);
          console.log(`⏸️ symTracker restored: ${symbol} pausado ${minLeft}min más (${consecutive} losses consecutivos)`);
        }
      }
    } catch(e) { console.error(`symTracker init error ${symbol}:`, e.message); }
  }
}

// v4.5.23: bull run auto-detector — chequea ratio LONG/SHORT en shadow trades 24h
async function updateBullRunState() {
  const symbols = ['BTCUSDT','ETHUSDT','DOGEUSDT','WLDUSDT','SUIUSDT','XRPUSDT','BNBUSDT','SOLUSDT']; // v4.5.24: DOGE+BNB reemplazan PEPE+WIF
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const symbol of symbols) {
    try {
      const { data } = await supabase
        .from('paper_trades')
        .select('direction')
        .eq('symbol', symbol)
        .eq('source', 'shadow')
        .gte('opened_at', since);
      if (!data || data.length < 5) continue; // necesita mín 5 señales
      const longs = data.filter(t => t.direction === 'LONG').length;
      const ratio = longs / data.length;
      const wasBlocked = _bullRunBlocked.has(symbol);
      if (ratio >= 0.65 && !wasBlocked) {
        _bullRunBlocked.add(symbol);
        console.log(`🔴 Bull run auto-block ${symbol}: ${(ratio*100).toFixed(0)}% LONG en 24h (n=${data.length}) — SHORTs sistémicamente perdedores`);
      } else if (ratio < 0.58 && wasBlocked) { // v4.5.24: was 0.50
        _bullRunBlocked.delete(symbol);
        console.log(`🟢 Bull run unblock ${symbol}: ${(ratio*100).toFixed(0)}% LONG en 24h (n=${data.length}) — mercado normalizado`);
      }
    } catch(e) { console.error(`Bull run check error ${symbol}:`, e.message); }
  }
}

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
      wallOpeningLock[symbol] = false; return;
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
      wallOpeningLock[symbol] = false; return;
    }

    wallAbsorptionCooldown[symbol] = now;

    const wallUsd = wall.price * wall.qty;
    const wallUsdStr = wallUsd >= 1e6 ? `$${(wallUsd/1e6).toFixed(1)}M` : `$${(wallUsd/1e3).toFixed(0)}K`;
    const wallConf = Math.min(88, Math.round(75 + (rrVal >= 1.5 ? 8 : 3) + (strength >= 8 ? 5 : 0)));
    const wallSide = wall.side === 'ask' ? 'ASK' : 'BID';

    await supabase.from('paper_trades').insert({
      symbol, direction, entry: price, tp1, tp2: tp1, sl,
      rr: `1:${rrVal.toFixed(1)}`, confidence: wallConf,
      size_usd: parseFloat(process.env['PAPER_SIZE_USD_' + symbol] || process.env.PAPER_SIZE_USD || '62'),
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

    wallOpeningLock[symbol] = false;
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
  // Prune stale entries to avoid unbounded growth (Bug M4)
  const _now = Date.now();
  for (const k of Object.keys(_klineCache)) {
    if (_now - _klineCache[k].ts > 300000) delete _klineCache[k];
  }
  return res.data;
}

let _scannerRunning = false; // v4.5.60: prevent setInterval overlap on 418 sleep
async function runMeanRevScanner() {
  if (_scannerRunning) return;
  _scannerRunning = true;
  try {
    const _mrSymbols = (process.env.WS_SYMBOLS || 'BTCUSDT,ETHUSDT').split(',').map(s => s.trim());
    for (const symbol of _mrSymbols) {
      try {
        await detectMeanReversion(symbol);
      } catch(e) {
        console.log(`MeanRev error ${symbol}: ${e.message}`);
        if (e.response?.status === 418) { console.log(`🚫 IP ban 418 meanrev — esperando 60s`); await new Promise(r => setTimeout(r, 60000)); }
      }
    }
  } finally {
    _scannerRunning = false; // v4.5.60
  }
}

async function detectMeanReversion(symbol) {
  const now = Date.now();

  // Filtro horario
  if (isHoraBloqueada()) return;

  // Cooldown + v4.5.87: set in-memory mutex BEFORE async ops to prevent h1Trig/scanner race
  if (meanRevCooldown[symbol] && now - meanRevCooldown[symbol] < MEANREV_COOLDOWN_MS) return;
  meanRevCooldown[symbol] = now; // mutex: block concurrent triggers (cleared on failure below)
  // v4.5.83: DB-backed cooldown — survives restarts (in-memory resets on restart lose per-symbol state)
  { const _mrCdDb = await supabase.from('paper_trades').select('id').eq('symbol', symbol).in('source', ['meanrev']).gte('opened_at', new Date(now - 30 * 60 * 1000).toISOString()); if (_mrCdDb.data?.length) /* v4.5.85: 30min DB cooldown */ { return; /* keep cooldown set — DB has recent trade */ } }

  // v4.5.75: bloquear meanrev si BTC sweep activo en <90s
  const _btcAnomalyAge = wsState['BTCUSDT']?.anomaly?.time ? (now - wsState['BTCUSDT'].anomaly.time) : Infinity;
  const _earlyDir = (() => { try { const _ch=_klineCache[symbol+'|1h|3']; if(!_ch) return null; const _ho=parseFloat(_ch.data[1][1]); const _cp=wsState[symbol]?.lastPrice; if(!_cp) return null; const _mv=(_cp-_ho)/_ho*100; return _mv < -0.3 ? 'LONG' : _mv > 0.3 ? 'SHORT' : null; } catch(e){return null;} })(); // v4.5.82: sync with v4.5.79d threshold
  if (_btcAnomalyAge < 5000 && _earlyDir === 'LONG') { console.log(`MeanRev LONG ${symbol} omitido — BTC sweep activo`); return; } // v4.5.79c: solo LONG

  if (circuitBreaker.isActive()) { console.log(`MeanRev omitido — Circuit Breaker activo (${symbol})`); return; }
  if (_consecSLPause[symbol] && _consecSLPause[symbol].until > Date.now()) { const _mrMinLeft = Math.ceil((_consecSLPause[symbol].until - Date.now()) / 60000); console.log(`MeanRev omitido — consecSL pause ${symbol} (${_mrMinLeft}min restantes)`); return; } // v4.5.84: check consecSL pause before opening meanrev
  if (_consecSLCount[symbol]?.blockedUntil > Date.now()) { const _mrMinLeft2 = Math.ceil((_consecSLCount[symbol].blockedUntil - Date.now()) / 60000); console.log(`MeanRev omitido — 3-SL diario ${symbol} (${_mrMinLeft2}min hasta medianoche)`); return; } // v4.5.84: check 3-SL daily block

  // v4.5.42: Weekly Circuit Breaker
  const _wcbBase = parseFloat(process.env.WEEKLY_CB_BALANCE || '0');
  if (_wcbBase > 0 && _LIVE_TRADING) {
    try {
      const _ts42 = Date.now() + binanceTimeOffset;
      const _sig42 = require('crypto').createHmac('sha256', BINANCE_SECRET).update('timestamp='+_ts42).digest('hex');
      const _wbal42 = await axios.get('https://fapi.binance.com/fapi/v2/balance?timestamp='+_ts42+'&signature='+_sig42, {headers:{'X-MBX-APIKEY':BINANCE_API_KEY}}).catch(()=>null);
      const _bal42 = _wbal42 ? parseFloat((_wbal42.data||[]).find(a=>a.asset==='USDT')?.balance||0) : 0;
      if (_bal42 > 0) {
        const _drop42 = (_wcbBase - _bal42) / _wcbBase;
        if (_drop42 >= 0.08) {
          console.error('Weekly CB ACTIVADO: $'+_bal42.toFixed(2)+' (-'+(_drop42*100).toFixed(1)+'%) vs inicio semana $'+_wcbBase);
          if (process.env.TELEGRAM_CHAT_ID) bot.sendMessage(process.env.TELEGRAM_CHAT_ID, 'Weekly CB activado: $'+_bal42.toFixed(2)+' (-'+(_drop42*100).toFixed(1)+'%) — LIVE_TRADING=false').catch(()=>{});
          process.env.LIVE_TRADING = 'false'; _LIVE_TRADING = false; // v4.5.47: sincronizar variable
          try { require('fs').writeFileSync('/home/noc/samael_delta/.wcb_state.json', JSON.stringify({base:process.env.WEEKLY_CB_BALANCE, ts:Date.now(), triggered:true})); } catch(_){} // v4.5.71: latch triggered
          return;
        } else if (_drop42 >= 0.04) {
          console.warn('Weekly CB warning: -'+(_drop42*100).toFixed(1)+'% vs $'+_wcbBase);
        }
      }
    } catch(e) { /* no bloquear si falla */ }
  }
  // No abrir si ya hay trade real abierto para este símbolo (excluir shadow/paper que no deben bloquear meanrev)
  const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open').not('source', 'in', '(shadow,bull_run_long,sol_paper)'); // v4.5.57: shadow no bloquea
  if (existing?.length) return;
  // v4.5.27: cap global — excluir shadow/bull_run_long (no deben bloquear meanrev)
  const { data: _mrAllOpen } = await supabase.from('paper_trades').select('id').eq('status', 'open').not('source','in','(shadow,bull_run_long,sol_paper)').not('symbol','in','(BTCUSDT,DOGEUSDT)'); // v4.5.80: excluir PAPER_ONLY de conteo real
  if ((_mrAllOpen?.length || 0) >= 3) { console.log(`MeanRev omitido — ${_mrAllOpen.length} trades reales abiertos (máx 3)`); return; }

  const price = wsState[symbol]?.lastPrice;
  const _mrPriceAge = Date.now() - (wsState[symbol]?.lastWsMsgTime || 0);
  if (!price || _mrPriceAge > 60000) {
    console.log('MeanRev omitido -- lastPrice obsoleto (' + Math.round(_mrPriceAge/1000) + 's) para ' + symbol);
    return;
  }

  // ── CONDICIÓN 1: Pre-trend 1H >1% ────────────────────────────────
  // ¿El precio de 1H se movió >1% en alguna dirección?
  const k1hData = await getCachedKlines(symbol, '1h', 3);
  const h1Open  = parseFloat(k1hData[1][1]); // open del candle cerrado previo
  const h1Close = wsState[symbol]?.lastPrice || parseFloat(k1hData[2][4]); // precio actual vs hora atras v4.5.51
  const h1Move  = (h1Close - h1Open) / h1Open * 100;
  const absH1   = Math.abs(h1Move);

  if (absH1 < 0.3) return; // v4.5.79d: 0.3% umbral

  // ── CONDICIÓN 2: Filtro 4H — no pelear contra tendencia fuerte ────
  // Si 4H va en la misma dirección que 1H con >1% → NO tradear
  const k4hData = await getCachedKlines(symbol, '4h', 2);
  const h4Open  = parseFloat(k4hData[0][1]);
  const h4Close = parseFloat(k4hData[0][4]);
  const h4Move  = (h4Close - h4Open) / h4Open * 100;

  const h1Dir = h1Move < 0 ? 'down' : 'up';
  const h4Dir = h4Move < 0 ? 'down' : 'up';

  // v4.5.74: filtro 4H eliminado — backtest mostró -$1024 vs base sin él

  // ── CONDICIÓN 3: Volume spike >3x mediana en velas 1m ─────────────
  const k1mData = await getCachedKlines(symbol, '1m', 21, 60 * 1000);
  const vols1m  = k1mData.map(k => parseFloat(k[5]));
  const lastVol = vols1m[vols1m.length - 1];

  // Mediana de las últimas 20 velas (excluyendo la última)
  const sorted = [...vols1m.slice(0, -1)].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const volMult = median > 0 ? lastVol / median : 0;

  if (volMult < parseFloat(process.env.MR_VOL_MIN||2.5)) return; // v4.5.77: env MR_VOL_MIN

  // ── DIRECCIÓN: Mean reversion contra el movimiento de 1H ──────────
  // 1H cayó >1% + spike → compradores agotaron vendedores → LONG
  // 1H subió >1% + spike → vendedores agotaron compradores → SHORT
  const direction = h1Move < -0.3 ? 'LONG' : 'SHORT'; // v4.5.79d
  if (process.env.MEANREV_SHORT_ONLY === 'true' && direction === 'LONG') { console.log(`MeanRev LONG ${symbol} omitido — MEANREV_SHORT_ONLY (LONGs -EV: backtest -0.7% vs SHORT-only +2.1%; XRP LONG 0% WR historico)`); return; } // v4.5.66

  // ── CONDICIÓN 4: bias_1d no contradice completamente ─────────────
  const k1dData = await getCachedKlines(symbol, '1d', 30, 15 * 60 * 1000);
  const bias1d = calcBias(k1dData, null, 0);
  // v4.5.53-54: bias_1d dual filter LONG (falling knife + bull run) SHORT (extreme bull + bear run)
  // Solo bloquear si 1D es extremamente contrario (score <35 para LONG o >65 para SHORT)
  if (direction === 'LONG'  && bias1d.score < 35) {
    console.log(`MeanRev LONG ${symbol} omitido — 1D muy bajista (score:${bias1d.score})`);
    return;
  }
  if (direction === 'LONG' && bias1d.bias === 'long' && bias1d.score > 75) { // v4.5.79b: 60→75
    console.log(`MeanRev LONG ${symbol} omitido - bias_1d alcista (score:${bias1d.score}) - bull run`);
    return;
  }
  if (direction === 'SHORT' && bias1d.score > 80) { // v4.5.79c: 65→80
    console.log(`MeanRev SHORT ${symbol} omitido — 1D muy alcista (score:${bias1d.score})`);
    return;
  }
  if (direction === 'SHORT' && bias1d.bias === 'short' && bias1d.score < 20) {
    console.log(`MeanRev SHORT ${symbol} omitido - bias_1d bajista (score:${bias1d.score}) - bear run, squeeze risk`);
    return;
  }

  // ── CONDICIÓN 5: SMA20 diaria — no pelear contra régimen macro (v4.5.41) ──────
  const sma20closes = k1dData.slice(-21, -1).map(k => parseFloat(k[4]));
  const sma20d = sma20closes.reduce((s,v) => s+v, 0) / sma20closes.length;
  if (direction === 'LONG' && price < sma20d * 0.90) {
    console.log('MeanRev LONG '+symbol+' omitido — precio bajo SMA20d ('+price.toFixed(2)+' < '+(sma20d*0.90).toFixed(2)+') v4.5.81');
    return;
  }
  if (direction === 'SHORT' && price > sma20d * 1.15) {
    console.log('MeanRev SHORT '+symbol+' omitido — precio sobre SMA20d ('+price.toFixed(2)+' > '+(sma20d*1.15).toFixed(2)+') v4.5.81');
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
  const exitMins = symbol.includes('BTC') ? 60 : 45;
  const conf = Math.min(88, Math.round(75 + (volMult >= 5 ? 8 : 4) + (absH1 >= 2 ? 5 : 0)));

  // v4.5.27: meanrev real — si MEANREV_REAL=true, abrir posición Binance con tamaño pequeño
  const _mrRealSyms = new Set((process.env.MEANREV_REAL_SYMBOLS || '').split(",").map(s=>s.trim()).filter(Boolean)); const _mrReal = process.env.MEANREV_REAL === "true" && _LIVE_TRADING && _mrRealSyms.has(symbol) && !PAPER_ONLY_SYMBOLS.has(symbol); // v4.5.65: real requiere lista explicita; vacio/unset = sin real (footgun gemelo de LONG_REAL_SYMBOLS L1075); v4.5.61: PAPER_ONLY guard; v4.5.54: per-symbol override
  const _mrSizeUsd = parseFloat(process.env['MEANREV_SIZE_USD_' + symbol] || process.env.MEANREV_SIZE_USD || '5'); // v4.5.36: per-symbol override
  const _mrLeverage = parseInt(process.env.MEANREV_LEVERAGE || '3');
  let _mrFill = null; // v4.5.48: hoisted so it's in scope at supabase.insert
  if (_mrReal) {
    const _mrExisting = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open').not('source', 'in', '(shadow,bull_run_long,sol_paper,sweep,whale)'); // v4.5.52: exclude sweep/whale to prevent double-LONG
    if (_mrExisting.data?.length) { console.log(`MeanRev real omitido — ya hay trade real abierto (${symbol})`); return; }
    _mrFill = await openFuturesPosition(symbol, direction, _mrSizeUsd, _mrLeverage, price);
    if (!_mrFill) { console.error(`MeanRev real abortado — Binance rechazó (${symbol})`); return; }
    console.log(`📊 MeanRev REAL: ${direction} ${symbol} @ ${price.toFixed(4)} $${_mrSizeUsd}/lev=${_mrLeverage}`);
  }
  const tradeCtxMR = await captureTradeContext(symbol);
  const { error: _mrInsErr } = await supabase.from('paper_trades').insert({
    symbol, direction, entry: _mrReal ? (_mrFill?.avgPrice || price) : price, tp1: tp, tp2: tp, sl, // v4.5.47: precio real de ejecucion
    rr: `1:${rr.toFixed(1)}`,
    confidence: conf,
    size_usd: _mrReal ? _mrSizeUsd : parseFloat(process.env['PAPER_SIZE_USD_' + symbol] || process.env.PAPER_SIZE_USD || '62'),
    leverage: _mrReal ? _mrLeverage : parseInt(process.env.PAPER_LEVERAGE || '5'),
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
  if (_mrInsErr) {
    console.error(`MeanRev DB insert failed (${symbol}): ${_mrInsErr.message}`);
    if (_mrReal && _mrFill) { // v4.5.52: rollback Binance position if DB write failed
      await closeFuturesPosition(symbol, direction).catch(e => console.error('MeanRev DB rollback error:', e.message));
    }
    return;
  }
  meanRevCooldown[symbol] = now; // Bug #8: cooldown solo si INSERT exitoso
  _invalidateSlCache(symbol); // v4.5.67: nuevo trade visible al monitor WS sin esperar TTL

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
// ── Reset Circuit Breaker manual — usar tras deploy con nuevas reglas
app.post('/api/reset-cb', (req, res) => {
  const authSecret = process.env.ADMIN_SECRET;
  if (!authSecret || req.headers['x-admin-secret'] !== authSecret) return res.status(401).json({ error: 'Unauthorized' }); // v4.5.59
  const today = circuitBreaker.getToday();
  const prevPnl = circuitBreaker.dailyPnl[today] || 0;
  delete circuitBreaker.dailyPnl[today];
  delete circuitBreaker.paused[today];
  console.log(`🔄 Circuit Breaker reseteado manualmente — PnL anterior: $${prevPnl.toFixed(2)}`);
  res.json({ ok: true, prevPnl, message: 'CB reseteado — trades habilitados' });
});

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
app.listen(PORT, async () => {
  console.log(`🚀 Samael Delta v4.5.74 corriendo (SQLite) en puerto ${PORT}`);
  // v4.5.51: Supabase health check — if down, disable live trading to prevent blind orders
  try {
    const { error: _sbStartErr } = await supabase.from('paper_trades').select('id').limit(1);
    if (_sbStartErr) throw _sbStartErr;
    console.log('✅ Supabase OK');
  } catch(_sbEx) {
    console.error('🚨 Supabase unreachable — LIVE_TRADING=false:', _sbEx.message);
    _LIVE_TRADING = false; process.env.LIVE_TRADING = 'false';
    if (process.env.TELEGRAM_CHAT_ID) bot.sendMessage(process.env.TELEGRAM_CHAT_ID, '🚨 Samael Delta: Supabase caído al iniciar — LIVE DESACTIVADO').catch(()=>{});
  }
  // CB arranca limpio en cada restart/deploy — nuevo deploy = nuevas reglas = fresh start
  syncBinanceTime();
  // v4.5.51: restore weekly CB base persisted before last restart
  try { const _wcbF='/home/noc/samael_delta/.wcb_state.json'; if(require('fs').existsSync(_wcbF)){const _s=JSON.parse(require('fs').readFileSync(_wcbF));if((Date.now()-_s.ts)<7*24*3600*1000&&parseFloat(_s.base)>0){process.env.WEEKLY_CB_BALANCE=_s.base;console.log('Weekly CB base restaurado: $'+_s.base); if(_s.triggered){_LIVE_TRADING=false;process.env.LIVE_TRADING='false';console.log('Weekly CB fue activado antes del restart, LIVE=false');}}} } catch(e){console.error('Weekly CB state load:',e.message);} // v4.5.71
  circuitBreaker.initFromSupabase().catch(e => console.error('CB init error:', e.message));
  // v4.5.86: restore consecSL daily block from DB — 3-SL blocks were lost on restart
  (async()=>{ try {
    const _mrRestSyms=(process.env.MEANREV_REAL_SYMBOLS||'').split(',').filter(Boolean);
    for (const _rSym of _mrRestSyms) {
      const {data:_rc}=await supabase.from('paper_trades').select('close_reason').eq('symbol',_rSym).eq('source','meanrev').not('status','eq','open').order('opened_at',{ascending:false}).limit(30);
      if(!_rc?.length) continue;
      let _csl=0;
      for (const t of _rc) { // most recent first
        const r=t.close_reason;
        if (r==='sl') _csl++; // only sl increments (kill_switch is neutral in live code)
        else if (r==='tp1'||r==='trailing_tp') break; // win resets
        // timeout, kill_switch: neutral, skip
      }
      if(_csl>=3){const _mid=new Date();_mid.setUTCHours(24,0,0,0);if(!_consecSLCount[_rSym])_consecSLCount[_rSym]={};_consecSLCount[_rSym].count=_csl;_consecSLCount[_rSym].blockedUntil=_mid.getTime();console.log(`[Restore] 3-SL block ${_rSym}: ${_csl} SLs consecutivos → bloqueado hasta medianoche UTC`);}
    }
  } catch(_rErr){console.error('[Restore] consecSL state:',_rErr.message);}})();
  if(_LIVE_TRADING) { setTimeout(()=>checkOrphanPositions().catch(e=>console.error('Orphan:',e)),8000); setInterval(()=>checkOrphanPositions().catch(e=>console.error('Orphan periodic:',e)),10*60*1000); } // v4.5.83: periodic every 10min
  initSymTrackers().catch(e => console.error('symTracker init error:', e.message));
  updateBullRunState().catch(e => console.error('Bull run init error:', e.message));
  setInterval(() => updateBullRunState().catch(e => console.error('Bull run check error:', e.message)), 30 * 60 * 1000); // v4.5.23: re-evaluar cada 30min

// -- Symbol Performance Monitor v4.5.52 --
// Cada 6h: NET<WARN(-0.50)->alerta. NET<KILL(-2.00)->auto-elimina de WS_SYMBOLS
const SYMPERF_WARN = parseFloat(process.env.SYMPERF_WARN || '-0.50');
const SYMPERF_KILL = parseFloat(process.env.SYMPERF_KILL || '-2.00');
async function checkSymbolPerformance() {
  if (!BINANCE_API_KEY || !BINANCE_SECRET) return;
  try {
    const _st7 = Date.now()-7*24*3600*1000, _ts=Date.now()+binanceTimeOffset;
    const _sig=(p)=>require('crypto').createHmac('sha256',BINANCE_SECRET).update(p).digest('hex');
    const bySym={};
    for (const itype of ['REALIZED_PNL','COMMISSION']) {
      const _p='incomeType='+itype+'&startTime='+_st7+'&limit=1000&timestamp='+_ts;
      const _r=await axios.get('https://fapi.binance.com/fapi/v1/income?'+_p+'&signature='+_sig(_p),
        {headers:{'X-MBX-APIKEY':BINANCE_API_KEY}}).catch(()=>null);
      for (const t of (_r?.data||[])) {
        if (!bySym[t.symbol]) bySym[t.symbol]={pnl:0,comm:0};
        bySym[t.symbol][itype==='REALIZED_PNL'?'pnl':'comm']+=parseFloat(t.income);
      }
    }
    const syms=(process.env.WS_SYMBOLS||'').split(',').filter(Boolean).filter(s=>!PAPER_ONLY_SYMBOLS.has(s)); // v4.5.63: skip Cantera symbols from kill eval
    let lines=['Samael Delta - Perf 7d'], toKill=[];
    for (const sym of syms) {
      const d=bySym[sym]||{pnl:0,comm:0}, net=d.pnl+d.comm;
      const e=net>=0?'OK':net<SYMPERF_KILL?'KILL':'WARN';
      lines.push(e+' '+sym+': PnL='+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+' COMM='+d.comm.toFixed(2)+' NET='+(net>=0?'+':'')+net.toFixed(2));
      if (net<SYMPERF_KILL) toKill.push(sym);
    }
    const hasWarn=syms.some(s=>((bySym[s]||{pnl:0,comm:0}).pnl+(bySym[s]||{pnl:0,comm:0}).comm)<SYMPERF_WARN);
    if (!hasWarn){console.log('[SymPerf] todos OK');return;}
    const msg=lines.join('\n');
    if(process.env.TELEGRAM_CHAT_ID)bot.sendMessage(process.env.TELEGRAM_CHAT_ID,msg).catch(()=>{});
    sendWaDelta(msg).catch(()=>{});
    console.log('[SymPerf]',msg);
    if(toKill.length){
      const newSyms=syms.filter(s=>!toKill.includes(s));
      process.env.WS_SYMBOLS=newSyms.join(',');
      const fs=require('fs'),ep='/home/noc/samael_delta/.env';
      let env=fs.readFileSync(ep,'utf8');
      env=env.replace(/^WS_SYMBOLS=.*/m,'WS_SYMBOLS='+newSyms.join(','));
      fs.writeFileSync(ep,env);
      const km='[AUTO-KILL] Eliminados: '+toKill.join(', ')+' | Nuevo WS: '+newSyms.join(',');
      if(process.env.TELEGRAM_CHAT_ID)bot.sendMessage(process.env.TELEGRAM_CHAT_ID,km).catch(()=>{});
      sendWaDelta(km).catch(()=>{});
      console.error('[SymPerf] AUTO-KILL:',toKill.join(','),'| nuevo:',newSyms.join(','));
    }
  } catch(e){console.error('[SymPerf] error:',e.message);}
}

  startAlertJob();
  checkSymbolPerformance().catch(e=>console.error('[SymPerf] init:',e.message));
  setInterval(()=>checkSymbolPerformance().catch(e=>console.error('[SymPerf]:',e.message)),6*60*60*1000);

  // ── Wall Absorption v2 — DESACTIVADO PERMANENTEMENTE v4.4.76
  // N=89 trades, WR 33.7%, PnL -$108 — sin edge estadístico, peor source del sistema
  // connectDepthWebSocket('BTCUSDT');  // no descomentar
  // connectDepthWebSocket('ETHUSDT');  // no descomentar
  console.log('🧱 Wall Absorption v2 DESACTIVADO permanentemente — WR 33.7% N=89');
});
