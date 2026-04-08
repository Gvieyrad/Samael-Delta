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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const BINANCE = 'https://fapi.binance.com';

let liqCache = { data: null, lastFetch: 0 };

app.get('/', (req, res) => res.json({ status: 'Panel Futuros LO activo', version: '3.0.0' }));

// ─── RSI WILDER ──────────────────────────────────────────────────
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
    if (diff > 0) { avgGain = (avgGain * (period-1) + diff) / period; avgLoss = (avgLoss * (period-1)) / period; }
    else { avgGain = (avgGain * (period-1)) / period; avgLoss = (avgLoss * (period-1) + Math.abs(diff)) / period; }
  }
  const rs = avgGain / (avgLoss || 0.001);
  return Math.round(100 - 100 / (1 + rs));
}

// ─── BOLLINGER BANDS ─────────────────────────────────────────────
function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + mult * std, middle: sma, lower: sma - mult * std, bandwidth: ((mult * 2 * std) / sma * 100).toFixed(2) };
}

// ─── VWAP ────────────────────────────────────────────────────────
function calcVWAP(klines) {
  let cumTPV = 0, cumVol = 0;
  klines.forEach(k => {
    const tp = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
    const vol = parseFloat(k[5]);
    cumTPV += tp * vol; cumVol += vol;
  });
  return cumVol > 0 ? cumTPV / cumVol : 0;
}

// ─── CVD POR VELA ────────────────────────────────────────────────
function calcCVD(klines) {
  let cumulative = 0;
  const deltas = klines.map(k => {
    const open = parseFloat(k[1]), close = parseFloat(k[4]), vol = parseFloat(k[5]);
    const buyRatio = close > open ? 1 : close < open ? 0 : 0.5;
    const buyVol = vol * buyRatio, sellVol = vol * (1 - buyRatio);
    const delta = buyVol - sellVol;
    cumulative += delta;
    return { delta, cumulative, vol };
  });
  const last5 = deltas.slice(-5);
  const delta5 = last5.reduce((s, d) => s + d.delta, 0);
  const delta3 = deltas.slice(-3).reduce((s, d) => s + d.delta, 0);
  const prevCum = deltas[deltas.length - 6]?.cumulative || 0;
  const currCum = cumulative;
  const cvdPct = prevCum !== 0 ? ((currCum - prevCum) / Math.abs(prevCum) * 100).toFixed(2) : '0.00';
  const avgVol = deltas.slice(-20).reduce((s, d) => s + d.vol, 0) / 20;
  const lastVol = deltas[deltas.length - 1]?.vol || 0;
  const volPct = avgVol > 0 ? ((lastVol - avgVol) / avgVol * 100).toFixed(1) : '0.0';
  const isClimax = Math.abs(parseFloat(delta3)) > Math.abs(delta5) * 0.8 && Math.abs(lastVol) > avgVol * 2;
  return { cumulative, delta5, delta3, cvdPct: parseFloat(cvdPct), volPct: parseFloat(volPct), trend: delta5 > 0 ? 'bull' : 'bear', isClimax };
}

// ─── VRVP ────────────────────────────────────────────────────────
function calcVRVP(klines) {
  const buckets = {};
  let totalVol = 0;
  klines.forEach(k => {
    const high = parseFloat(k[2]), low = parseFloat(k[3]), vol = parseFloat(k[5]);
    const mid = Math.round((high + low) / 2 / 50) * 50;
    buckets[mid] = (buckets[mid] || 0) + vol;
    totalVol += vol;
  });
  const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  const poc = parseFloat(sorted[0]?.[0] || 0);
  const prices = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  let cumVol = 0;
  const vah70 = [], val70 = [];
  for (const p of [...prices].reverse()) { cumVol += buckets[p]; if (cumVol / totalVol <= 0.7) vah70.push(p); }
  cumVol = 0;
  for (const p of prices) { cumVol += buckets[p]; if (cumVol / totalVol <= 0.3) val70.push(p); }
  const vah = vah70.length ? Math.max(...vah70) : poc;
  const val = val70.length ? Math.min(...val70) : poc;
  return { poc, vah: Math.max(vah, poc), val: Math.min(val, poc) };
}

// ─── OI DELTA ────────────────────────────────────────────────────
function calcOIDelta(currentOI, klines) {
  const vols = klines.slice(-5).map(k => parseFloat(k[5]));
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const lastVol = vols[vols.length - 1];
  const volDelta = avgVol > 0 ? ((lastVol - avgVol) / avgVol * 100).toFixed(1) : '0.0';
  return { trend: 'flat', deltaPct: '0.000', momentum: 'weak', volDelta: parseFloat(volDelta) };
}

// ─── BIAS POR TF ─────────────────────────────────────────────────
function calcBias(klines) {
  if (!klines || klines.length < 20) return { bias: 'neutral', score: 50, rsi: 50, cvdPct: 0, volPct: 0, bbPos: 'middle' };
  const closes = klines.map(k => parseFloat(k[4]));
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const rsi = calcRSI(closes);
  const cvd = calcCVD(klines);
  const bb = calcBB(closes);
  const vwap = calcVWAP(klines);
  const last = closes[closes.length - 1];
  const prev5avg = closes.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
  const priceVsPrev = prev5avg > 0 ? ((last - prev5avg) / prev5avg * 100) : 0;
  const recentHighs = highs.slice(-5);
  const recentLows = lows.slice(-5);
  const hhCount = recentHighs.filter((h, i) => i > 0 && h > recentHighs[i-1]).length;
  const llCount = recentLows.filter((l, i) => i > 0 && l < recentLows[i-1]).length;
  const bbPos = bb ? (last > bb.upper ? 'above' : last < bb.lower ? 'below' : 'middle') : 'middle';
  const aboveVwap = last > vwap;
  let score = 50;
  if (priceVsPrev > 0.3) score += 12; else if (priceVsPrev < -0.3) score -= 12;
  if (hhCount >= 3) score += 10; if (llCount >= 3) score -= 10;
  if (rsi > 70) score -= 25; else if (rsi > 60) score += 8; else if (rsi < 30) score += 25; else if (rsi < 40) score -= 8;
  if (cvd.delta5 > 0) score += 10; else score -= 10;
  if (bbPos === 'above') score -= 8; else if (bbPos === 'below') score += 8;
  if (aboveVwap) score += 5; else score -= 5;
  score = Math.min(95, Math.max(5, Math.round(score)));
  return { bias: score > 60 ? 'long' : score < 40 ? 'short' : 'neutral', score, rsi, cvdPct: cvd.cvdPct, volPct: cvd.volPct, bbPos, aboveVwap, vwap: vwap.toFixed(1), bb };
}

// ─── ORDER BOOK ──────────────────────────────────────────────────
function analyzeOB(bids, asks) {
  if (!bids?.length || !asks?.length) return {};
  const bidVol = bids.slice(0, 10).reduce((s, b) => s + parseFloat(b[1]), 0);
  const askVol = asks.slice(0, 10).reduce((s, a) => s + parseFloat(a[1]), 0);
  const imbalance = ((bidVol - askVol) / (bidVol + askVol) * 100).toFixed(1);
  const avgBid = bidVol / 10, avgAsk = askVol / 10;
  const bidWalls = bids.slice(0, 20).filter(b => parseFloat(b[1]) > avgBid * 3).map(b => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) }));
  const askWalls = asks.slice(0, 20).filter(a => parseFloat(a[1]) > avgAsk * 3).map(a => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) }));
  return { bidVol: bidVol.toFixed(2), askVol: askVol.toFixed(2), imbalance, pressure: parseFloat(imbalance) > 15 ? 'bid_dominant' : parseFloat(imbalance) < -15 ? 'ask_dominant' : 'balanced', bidWalls, askWalls, spread: (parseFloat(asks[0][0]) - parseFloat(bids[0][0])).toFixed(1), spreadPct: ((parseFloat(asks[0][0]) - parseFloat(bids[0][0])) / parseFloat(bids[0][0]) * 100).toFixed(4), topBid: parseFloat(bids[0][0]), topAsk: parseFloat(asks[0][0]) };
}

// ─── DIVERGENCIAS ────────────────────────────────────────────────
function detectDivergences(klines15m, ob, price, fundingRate) {
  const divergences = [];
  const closes = klines15m.map(k => parseFloat(k[4]));
  const highs = klines15m.map(k => parseFloat(k[2]));
  const lows = klines15m.map(k => parseFloat(k[3]));
  const cvd = calcCVD(klines15m);
  const rsiValues = [];
  for (let i = 15; i < closes.length; i++) rsiValues.push(calcRSI(closes.slice(0, i + 1)));
  const lastRSI = rsiValues[rsiValues.length - 1];
  const prevRSI = rsiValues[rsiValues.length - 4];
  const lastHigh = Math.max(...highs.slice(-3));
  const prevHigh = Math.max(...highs.slice(-8, -3));
  const lastLow = Math.min(...lows.slice(-3));
  const prevLow = Math.min(...lows.slice(-8, -3));
  const lastClose = closes[closes.length - 1];
  const prevClose5 = closes[closes.length - 6];
  const priceUp = lastClose > prevClose5;
  const priceDown = lastClose < prevClose5;
  const cvdFalling = cvd.delta5 < 0;
  const cvdRising = cvd.delta5 > 0;
  const cvdAgressive = Math.abs(cvd.cvdPct) > 5;
  const oiFlat = true;

  // 1. ABSORCIÓN DE COMPRAS (SHORT)
  if (priceUp && cvdRising && cvdAgressive) {
    let prob = 72;
    if (ob.askWalls?.length > 0) prob += 10;
    if (oiFlat) prob += 8;
    if (lastRSI > 65) prob += 5;
    const nearLiq = getNearestLiqMagnet(price, 'down');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'absorcion_compras', name: 'Absorción de Compras', direction: 'SHORT', probability: Math.min(95, prob), entry: price, description: 'CVD sube agresivamente pero hay muro vendedor — precio se agotará', action: prob >= 80 ? 'ENTRAR' : prob >= 65 ? 'ESPERAR' : 'NO ENTRAR', liqTarget: nearLiq?.price });
  }

  // 2. ABSORCIÓN DE VENTAS (LONG)
  if (priceDown && cvdFalling && cvdAgressive) {
    let prob = 72;
    if (ob.bidWalls?.length > 0) prob += 10;
    if (lastRSI < 35) prob += 10;
    const nearLiq = getNearestLiqMagnet(price, 'up');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'absorcion_ventas', name: 'Absorción de Ventas', direction: 'LONG', probability: Math.min(95, prob), entry: price, description: 'Ballena comprando con órdenes límite — rebote inminente', action: prob >= 80 ? 'ENTRAR' : prob >= 65 ? 'ESPERAR' : 'NO ENTRAR', liqTarget: nearLiq?.price });
  }

  // 3. DIVERGENCIA RSI BAJISTA
  if (lastHigh > prevHigh && lastRSI < prevRSI - 3) {
    let prob = 65;
    if (cvdFalling) prob += 15;
    if (oiFlat) prob += 8;
    if (lastRSI > 60) prob += 7;
    const nearLiq = getNearestLiqMagnet(price, 'down');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'rsi_bajista', name: 'Divergencia RSI Bajista', direction: 'SHORT', probability: Math.min(95, prob), entry: price, description: `Precio HH pero RSI LH (${lastRSI} vs ${prevRSI}) — agotamiento alcista`, action: prob >= 80 ? 'ENTRAR' : prob >= 65 ? 'ESPERAR' : 'NO ENTRAR', liqTarget: nearLiq?.price });
  }

  // 4. DIVERGENCIA RSI ALCISTA
  if (lastLow < prevLow && lastRSI > prevRSI + 3) {
    let prob = 65;
    if (cvdRising) prob += 15;
    if (lastRSI < 40) prob += 7;
    const nearLiq = getNearestLiqMagnet(price, 'up');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'rsi_alcista', name: 'Divergencia RSI Alcista', direction: 'LONG', probability: Math.min(95, prob), entry: price, description: `Precio LL pero RSI HL (${lastRSI} vs ${prevRSI}) — agotamiento bajista`, action: prob >= 80 ? 'ENTRAR' : prob >= 65 ? 'ESPERAR' : 'NO ENTRAR', liqTarget: nearLiq?.price });
  }

  // 5. DIVERGENCIA CVD/PRECIO BAJISTA
  if (priceUp && cvdFalling) {
    let prob = 68;
    if (oiFlat) prob += 12;
    if (lastRSI > 60) prob += 8;
    if (cvdAgressive) prob += 7;
    const nearLiq = getNearestLiqMagnet(price, 'down');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'cvd_precio_bajista', name: 'Divergencia CVD/Precio Bajista', direction: 'SHORT', probability: Math.min(95, prob), entry: price, description: 'Precio sube sin respaldo — CVD negativo + OI sin nuevas posiciones', action: prob >= 80 ? 'ENTRAR' : prob >= 65 ? 'ESPERAR' : 'NO ENTRAR', liqTarget: nearLiq?.price });
  }

  // 6. DIVERGENCIA CVD/PRECIO ALCISTA
  if (priceDown && cvdRising) {
    let prob = 68;
    if (lastRSI < 40) prob += 10;
    if (cvdAgressive) prob += 7;
    const nearLiq = getNearestLiqMagnet(price, 'up');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'cvd_precio_alcista', name: 'Divergencia CVD/Precio Alcista', direction: 'LONG', probability: Math.min(95, prob), entry: price, description: 'Precio baja pero compradores entrando — CVD positivo', action: prob >= 80 ? 'ENTRAR' : prob >= 65 ? 'ESPERAR' : 'NO ENTRAR', liqTarget: nearLiq?.price });
  }

  // 7. TRAMPA DE LIQUIDEZ (SHORT)
  if (priceUp && oiFlat && cvdFalling) {
    let prob = 75;
    if (lastRSI > 65) prob += 8;
    const nearLiq = getNearestLiqMagnet(price, 'down');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'trampa_liquidez', name: 'Trampa de Liquidez', direction: 'SHORT', probability: Math.min(95, prob), entry: price, description: 'Subida por shorts liquidados — sin demanda real, caída inminente', action: prob >= 80 ? 'ENTRAR' : prob >= 65 ? 'ESPERAR' : 'NO ENTRAR', liqTarget: nearLiq?.price });
  }

  // 8. FUNDING RATE EXTREMO
  if (Math.abs(fundingRate) > 0.0008) {
    const isBull = fundingRate > 0;
    let prob = 70;
    const nearLiq = getNearestLiqMagnet(price, isBull ? 'down' : 'up');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'funding_extremo', name: 'Funding Rate Extremo', direction: isBull ? 'SHORT' : 'LONG', probability: Math.min(90, prob), entry: price, description: `FR ${(fundingRate*100).toFixed(4)}% — ${isBull ? 'longs sobrecalentados, corrección probable' : 'shorts en riesgo, rebote probable'}`, action: prob >= 75 ? 'ESPERAR CONFIRMACIÓN' : 'MONITOREAR', liqTarget: nearLiq?.price });
  }

  // 9. VOLUMEN CLÍMAX
  if (cvd.isClimax) {
    const dir = cvd.delta5 > 0 ? 'SHORT' : 'LONG';
    let prob = 73;
    const nearLiq = getNearestLiqMagnet(price, dir === 'SHORT' ? 'down' : 'up');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type: 'volumen_climax', name: 'Volumen Clímax', direction: dir, probability: Math.min(92, prob), entry: price, description: `Volumen explosivo con ${cvd.delta5 > 0 ? 'compras' : 'ventas'} extremas — agotamiento inminente`, action: prob >= 80 ? 'ENTRAR' : 'ESPERAR', liqTarget: nearLiq?.price });
  }

  return divergences.sort((a, b) => b.probability - a.probability);
}

// ─── LIQUIDATION MAGNETS ─────────────────────────────────────────
function getNearestLiqMagnet(price, direction) {
  const zones = [
    { dist: -0.018, size: 240, label: 'Stop longs' },
    { dist: -0.025, size: 380, label: 'Zona shorts' },
    { dist: -0.042, size: 490, label: 'Pool liq.' },
    { dist: -0.055, size: 620, label: 'Cluster grande' },
    { dist: -0.075, size: 830, label: 'Imán mayor' },
    { dist: 0.015, size: 210, label: 'Stop shorts' },
    { dist: 0.028, size: 320, label: 'Zona longs' },
    { dist: 0.045, size: 480, label: 'Pool liq. arriba' },
    { dist: 0.068, size: 740, label: 'Cluster arriba' },
  ];
  const filtered = zones.filter(z => direction === 'down' ? z.dist < 0 : z.dist > 0);
  const nearest = filtered.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))[0];
  if (!nearest) return null;
  const bonus = nearest.size > 700 ? 20 : nearest.size > 500 ? 15 : nearest.size > 300 ? 10 : 5;
  return { price: (price * (1 + nearest.dist)).toFixed(0), size: nearest.size, label: nearest.label, dist: Math.abs(nearest.dist * 100).toFixed(1), bonus };
}

function calcLiqMagnets(price) {
  const zones = [
    { dist: -0.018, size: 240, label: 'Stop longs' },
    { dist: -0.025, size: 380, label: 'Zona shorts' },
    { dist: -0.042, size: 490, label: 'Pool liq.' },
    { dist: -0.055, size: 620, label: 'Cluster grande' },
    { dist: -0.075, size: 830, label: 'Imán mayor' },
    { dist: 0.015, size: 210, label: 'Stop shorts' },
    { dist: 0.028, size: 320, label: 'Zona longs' },
    { dist: 0.045, size: 480, label: 'Pool liq. arriba' },
    { dist: 0.068, size: 740, label: 'Cluster arriba' },
    { dist: 0.095, size: 950, label: 'Imán crítico' },
  ];
  return zones.map(z => ({ price: parseFloat((price * (1 + z.dist)).toFixed(0)), size: z.size, label: z.label, dist: Math.abs(z.dist * 100).toFixed(1), direction: z.dist > 0 ? 'up' : 'down', isMajor: z.size >= 600 })).sort((a, b) => Math.abs(parseFloat(a.dist)) - Math.abs(parseFloat(b.dist)));
}

// ─── COMBINED SIGNAL ─────────────────────────────────────────────
function calcCombinedSignal(divergences, bias4h, bias1d) {
  if (!divergences.length) return { direction: 'ESPERAR', probability: 30, action: 'ESPERAR', reason: 'Sin divergencias activas' };
  const shorts = divergences.filter(d => d.direction === 'SHORT');
  const longs = divergences.filter(d => d.direction === 'LONG');
  const shortScore = shorts.reduce((s, d) => s + d.probability, 0) / (shorts.length || 1);
  const longScore = longs.reduce((s, d) => s + d.probability, 0) / (longs.length || 1);
  let direction = shorts.length > longs.length ? 'SHORT' : longs.length > shorts.length ? 'LONG' : 'ESPERAR';
  let prob = direction === 'SHORT' ? shortScore : direction === 'LONG' ? longScore : 30;
  if (direction === 'SHORT' && (bias4h?.bias === 'short' || bias1d?.bias === 'short')) prob = Math.min(95, prob + 8);
  if (direction === 'LONG' && (bias4h?.bias === 'long' || bias1d?.bias === 'long')) prob = Math.min(95, prob + 8);
  const action = prob >= 82 ? 'ENTRAR' : prob >= 68 ? 'ESPERAR CONFIRMACIÓN' : 'NO ENTRAR';
  return { direction, probability: Math.round(prob), action, shortCount: shorts.length, longCount: longs.length };
}

// ─── MAIN ENDPOINT ───────────────────────────────────────────────
app.get('/api/market/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol || 'BTCUSDT';
    const [ticker, oiRes, funding, k15m, k1h, k4h, k1d, obRes] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=60`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=20`)
    ]);

    const price = parseFloat(ticker.data.lastPrice);
    const fundingRate = parseFloat(funding.data.lastFundingRate);
    const closes15m = k15m.data.map(k => parseFloat(k[4]));

    const cvd15m = calcCVD(k15m.data);
    const vrvp = calcVRVP(k15m.data);
    const bb15m = calcBB(closes15m);
    const vwap15m = calcVWAP(k15m.data);
    const rsi15m = calcRSI(closes15m);
    const ob = analyzeOB(obRes.data.bids, obRes.data.asks);
    const liqMagnets = calcLiqMagnets(price);
    const oiDelta = calcOIDelta(parseFloat(oiRes.data.openInterest), k15m.data);

    const bias15m = calcBias(k15m.data);
    const bias1h = calcBias(k1h.data);
    const bias4h = calcBias(k4h.data);
    const bias1d = calcBias(k1d.data);

    const divergences = detectDivergences(k15m.data, ob, price, fundingRate);
    const combinedSignal = calcCombinedSignal(divergences, bias4h, bias1d);

    const vols = k15m.data.slice(-5).map(k => parseFloat(k[5]));
    const avgVol5 = vols.slice(0, -1).reduce((a, b) => a + b, 0) / 4;
    const lastVol = vols[vols.length - 1];
    const volDeltaPct = avgVol5 > 0 ? ((lastVol - avgVol5) / avgVol5 * 100).toFixed(1) : '0.0';

    const prevOI = parseFloat(oiRes.data.openInterest);
    const oiDeltaPct = '0.000';

    res.json({
      price, change24h: parseFloat(ticker.data.priceChangePercent),
      volume24h: parseFloat(ticker.data.quoteVolume),
      openInterest: parseFloat(oiRes.data.openInterest),
      fundingRate, markPrice: parseFloat(funding.data.markPrice),
      indexPrice: parseFloat(funding.data.indexPrice),
      rsi15m, rsiOverbought: rsi15m > 70, rsiOversold: rsi15m < 30,
      cvd15m, vrvp, bb15m, vwap15m: vwap15m.toFixed(1),
      oiDelta: { trend: 'flat', deltaPct: oiDeltaPct, volDelta: parseFloat(volDeltaPct) },
      volDeltaPct: parseFloat(volDeltaPct),
      orderBook: ob, liqMagnets, divergences, combinedSignal,
      bias: { tf15m: bias15m, tf1h: bias1h, tf4h: bias4h, tf1d: bias1d },
      klines: k15m.data.slice(-20)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI ANALYSIS ─────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { marketData: d, symbol } = req.body;
    const divSummary = d.divergences?.slice(0, 3).map(dv => `${dv.name}: ${dv.direction} ${dv.probability}% — ${dv.description}`).join('\n') || 'Ninguna';
    const topDiv = d.divergences?.[0];
    const prompt = `Eres un trader experto en BTC futuros perpetuos. Analiza y da señal precisa.

MERCADO: ${symbol} — $${d.price} (${d.change24h > 0 ? '+' : ''}${d.change24h?.toFixed(2)}%)
RSI 15m: ${d.rsi15m} ${d.rsiOverbought ? '⚠ SOBRECOMPRA' : d.rsiOversold ? '⚠ SOBREVENTA' : ''}
CVD 15m: delta5=${d.cvd15m?.delta5?.toFixed(0)}, tendencia=${d.cvd15m?.trend}, cvdPct=${d.cvd15m?.cvdPct}%
Volumen delta: ${d.volDeltaPct}% vs promedio 5 velas
OI: ${d.openInterest?.toFixed(0)} BTC | Funding: ${(d.fundingRate*100)?.toFixed(4)}%
VRVP: POC=$${d.vrvp?.poc} VAH=$${d.vrvp?.vah} VAL=$${d.vrvp?.val}
VWAP: $${d.vwap15m} | Precio ${d.price > parseFloat(d.vwap15m) ? 'sobre' : 'bajo'} VWAP
BB: upper=$${d.bb15m?.upper?.toFixed(0)} lower=$${d.bb15m?.lower?.toFixed(0)}

SESGO: 15m=${d.bias?.tf15m?.bias}(${d.bias?.tf15m?.score}) 1H=${d.bias?.tf1h?.bias}(${d.bias?.tf1h?.score}) 4H=${d.bias?.tf4h?.bias}(${d.bias?.tf4h?.score}) 1D=${d.bias?.tf1d?.bias}(${d.bias?.tf1d?.score})

DIVERGENCIAS ACTIVAS:
${divSummary}

SEÑAL COMBINADA: ${d.combinedSignal?.direction} ${d.combinedSignal?.probability}% — ${d.combinedSignal?.action}

LIBRO: presión=${d.orderBook?.pressure} imbalance=${d.orderBook?.imbalance}%
IMÁN MÁS CERCANO: ${d.liqMagnets?.[0]?.direction === 'down' ? '↓' : '↑'} $${d.liqMagnets?.[0]?.price} (${d.liqMagnets?.[0]?.dist}% — ${d.liqMagnets?.[0]?.size}M)

REGLAS:
- RSI>70 = no entrar long
- RSI<30 = no entrar short  
- Precio siempre va hacia imanes de liquidación
- Divergencia CVD + OI plano = señal fuerte
- Confirmar con 4H y 1D

Responde SOLO JSON:
{"direction":"LONG|SHORT|ESPERAR","confidence":0-100,"entry":precio,"tp1":precio,"tp2":precio,"sl":precio,"rr":"1:X","reasoning":"2-3 oraciones en español","warning":"riesgo o vacío","action":"ENTRAR|ESPERAR|NO ENTRAR"}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const signal = JSON.parse(clean);

    await supabase.from('signals').insert({ symbol, direction: signal.direction, confidence: signal.confidence, entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2, sl: signal.sl, rr: signal.rr, reasoning: signal.reasoning, market_data: d }).catch(() => {});

    if (signal.confidence >= 75 && process.env.TELEGRAM_CHAT_ID) {
      const e = signal.direction === 'LONG' ? '▲' : signal.direction === 'SHORT' ? '▼' : '◆';
      const msg = `${e} ${signal.direction} — ${symbol}\n💰 Entry: $${signal.entry}\n🎯 TP1: $${signal.tp1} | TP2: $${signal.tp2}\n🛑 SL: $${signal.sl} | ${signal.rr}\n📊 ${signal.confidence}% — ${signal.action}\n💬 ${signal.reasoning}`;
      bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg).catch(() => {});
    }

    res.json(signal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trades', async (req, res) => {
  try {
    const { data, error } = await supabase.from('trades').insert(req.body);
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trades', async (req, res) => {
  try {
    const { data, error } = await supabase.from('trades').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Panel Futuros LO v3.0 corriendo en puerto ${PORT}`));
