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

app.get('/', (req, res) => res.json({ status: 'Panel Futuros LO activo', version: '2.0.0' }));

// ─── HELPER FUNCTIONS ───────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 1);
  return Math.round(100 - 100 / (1 + rs));
}

function calcCVD(klines) {
  // CVD vela por vela en 15m: si vela alcista → volumen positivo, bajista → negativo
  let cvd = 0;
  const deltas = klines.map(k => {
    const open = parseFloat(k[1]);
    const close = parseFloat(k[4]);
    const vol = parseFloat(k[5]);
    const delta = close >= open ? vol : -vol;
    cvd += delta;
    return delta;
  });
  const recent5 = deltas.slice(-5).reduce((a, b) => a + b, 0);
  const recent3 = deltas.slice(-3).reduce((a, b) => a + b, 0);
  return {
    cumulative: cvd,
    delta5: recent5,   // últimas 5 velas — momentum
    delta3: recent3,   // últimas 3 velas — impulso inmediato
    trend: recent5 > 0 ? 'bull' : 'bear',
    divergence: null   // se calcula después
  };
}

function calcVRVP(klines) {
  // Volume Profile: agrupa volumen por nivel de precio
  const buckets = {};
  klines.forEach(k => {
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const vol = parseFloat(k[5]);
    const mid = Math.round((high + low) / 2 / 100) * 100;
    buckets[mid] = (buckets[mid] || 0) + vol;
  });
  const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  const poc = parseFloat(sorted[0]?.[0] || 0);
  const prices = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  const totalVol = Object.values(buckets).reduce((a, b) => a + b, 0);
  let cumVol = 0;
  let vah = poc, val = poc;
  for (const p of prices.reverse()) {
    cumVol += buckets[p];
    if (cumVol / totalVol <= 0.7) vah = p;
  }
  cumVol = 0;
  for (const p of prices.reverse()) {
    cumVol += buckets[p];
    if (cumVol / totalVol <= 0.3) val = p;
  }
  return { poc, vah, val };
}

function calcOIDelta(oiHistory) {
  if (!oiHistory || oiHistory.length < 3) return { delta: 0, trend: 'neutral', momentum: 'flat' };
  const recent = oiHistory.slice(-3).map(o => parseFloat(o.sumOpenInterest));
  const delta = recent[2] - recent[0];
  const deltaPct = (delta / recent[0]) * 100;
  return {
    delta,
    deltaPct: deltaPct.toFixed(3),
    trend: deltaPct > 0.1 ? 'rising' : deltaPct < -0.1 ? 'falling' : 'flat',
    momentum: Math.abs(deltaPct) > 0.5 ? 'strong' : 'weak'
  };
}

function detectDivergence(price15m, cvd, oiDelta) {
  const closes = price15m.map(k => parseFloat(k[4]));
  const priceUp = closes[closes.length - 1] > closes[closes.length - 5];
  const priceDown = closes[closes.length - 1] < closes[closes.length - 5];
  const cvdBearish = cvd.delta5 < 0;
  const cvdBullish = cvd.delta5 > 0;
  const oiFlat = oiDelta.trend === 'flat';
  const oiFalling = oiDelta.trend === 'falling';

  // Divergencia bajista: precio sube pero CVD cae y OI plano/bajando
  if (priceUp && cvdBearish && (oiFlat || oiFalling)) {
    return { type: 'bearish', strength: 'high', signal: 'SHORT', reason: 'Precio sube sin respaldo — CVD negativo + OI sin nuevas posiciones' };
  }
  // Divergencia alcista: precio baja pero CVD sube y OI subiendo
  if (priceDown && cvdBullish && oiDelta.trend === 'rising') {
    return { type: 'bullish', strength: 'high', signal: 'LONG', reason: 'Precio cae pero compradores entrando — CVD positivo + OI creciendo' };
  }
  // Sin divergencia
  return { type: 'none', strength: 'low', signal: null, reason: 'Sin divergencia detectada' };
}

function calcBiasForTF(klines) {
  if (!klines || klines.length < 10) return { bias: 'neutral', score: 50 };
  const closes = klines.map(k => parseFloat(k[4]));
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const vols = klines.map(k => parseFloat(k[5]));

  const rsi = calcRSI(closes);
  const last = closes[closes.length - 1];
  const prev5avg = closes.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
  const priceVsPrev = ((last - prev5avg) / prev5avg) * 100;

  // HH/HL structure
  const recentHighs = highs.slice(-5);
  const recentLows = lows.slice(-5);
  const hhCount = recentHighs.filter((h, i) => i > 0 && h > recentHighs[i - 1]).length;
  const llCount = recentLows.filter((l, i) => i > 0 && l < recentLows[i - 1]).length;

  // Volume trend
  const recentVol = vols.slice(-3).reduce((a, b) => a + b, 0);
  const prevVol = vols.slice(-6, -3).reduce((a, b) => a + b, 0);
  const volRising = recentVol > prevVol;

  let score = 50;
  if (priceVsPrev > 0.2) score += 15;
  if (priceVsPrev < -0.2) score -= 15;
  if (hhCount >= 3) score += 10;
  if (llCount >= 3) score -= 10;
  if (rsi > 70) score -= 20; // sobrecompra = no entrar long
  if (rsi < 30) score += 20; // sobreventa = no entrar short
  if (rsi > 60 && rsi <= 70) score += 8;
  if (rsi < 40 && rsi >= 30) score -= 8;
  if (volRising && priceVsPrev > 0) score += 8;
  if (volRising && priceVsPrev < 0) score -= 8;

  score = Math.min(95, Math.max(5, score));
  const bias = score > 60 ? 'long' : score < 40 ? 'short' : 'neutral';
  return { bias, score, rsi, priceVsPrev: priceVsPrev.toFixed(2) };
}

function analyzeOrderBook(bids, asks) {
  if (!bids || !asks || bids.length === 0) return {};

  const bidVol = bids.slice(0, 10).reduce((sum, b) => sum + parseFloat(b[1]), 0);
  const askVol = asks.slice(0, 10).reduce((sum, a) => sum + parseFloat(a[1]), 0);
  const imbalance = ((bidVol - askVol) / (bidVol + askVol) * 100).toFixed(1);

  // Detectar paredes (walls) — órdenes 3x mayor que el promedio
  const avgBid = bidVol / 10;
  const avgAsk = askVol / 10;
  const bidWalls = bids.slice(0, 20).filter(b => parseFloat(b[1]) > avgBid * 3)
    .map(b => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) }));
  const askWalls = asks.slice(0, 20).filter(a => parseFloat(a[1]) > avgAsk * 3)
    .map(a => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) }));

  // Spread
  const spread = (parseFloat(asks[0][0]) - parseFloat(bids[0][0]));
  const spreadPct = (spread / parseFloat(bids[0][0]) * 100).toFixed(4);

  // Presión dominante
  const pressure = parseFloat(imbalance) > 15 ? 'bid_dominant' :
    parseFloat(imbalance) < -15 ? 'ask_dominant' : 'balanced';

  return {
    bidVol: bidVol.toFixed(2),
    askVol: askVol.toFixed(2),
    imbalance,
    pressure,
    bidWalls,
    askWalls,
    spread: spread.toFixed(1),
    spreadPct,
    topBid: parseFloat(bids[0][0]),
    topAsk: parseFloat(asks[0][0])
  };
}

// ─── MAIN MARKET ENDPOINT ───────────────────────────────────────

app.get('/api/market/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol || 'BTCUSDT';

    const [ticker, oiRes, funding, klines15m, klines1h, klines4h, klines1d, , obRes] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
      axios.get(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=20`)
    ]);

    const closes15m = klines15m.data.map(k => parseFloat(k[4]));
    const rsi15m = calcRSI(closes15m);
    const cvd15m = calcCVD(klines15m.data);
    const vrvp = calcVRVP(klines15m.data);
    const oiDelta = { delta: 0, deltaPct: '0.000', trend: 'flat', momentum: 'weak' };
    const divergence = detectDivergence(klines15m.data, cvd15m, oiDelta);
    const ob = analyzeOrderBook(obRes.data.bids, obRes.data.asks);

    const bias15m = calcBiasForTF(klines15m.data);
    const bias1h = calcBiasForTF(klines1h.data);
    const bias4h = calcBiasForTF(klines4h.data);
    const bias1d = calcBiasForTF(klines1d.data);

    const price = parseFloat(ticker.data.lastPrice);
    const fundingRate = parseFloat(funding.data.lastFundingRate);
    const change24h = parseFloat(ticker.data.priceChangePercent);

    // RSI extremos bloquean señales contrarias
    const rsiOverbought = rsi15m > 70;
    const rsiOversold = rsi15m < 30;

    res.json({
      price,
      change24h,
      volume24h: parseFloat(ticker.data.quoteVolume),
      openInterest: parseFloat(oiRes.data.openInterest),
      fundingRate,
      markPrice: parseFloat(funding.data.markPrice),
      indexPrice: parseFloat(funding.data.indexPrice),
      rsi15m,
      rsiOverbought,
      rsiOversold,
      cvd: cvd15m,
      vrvp,
      oiDelta,
      divergence,
      orderBook: ob,
      bias: { tf15m: bias15m, tf1h: bias1h, tf4h: bias4h, tf1d: bias1d },
      klines: klines15m.data.slice(-20)
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ORDER BOOK ─────────────────────────────────────────────────

app.get('/api/orderbook/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol || 'BTCUSDT';
    const ob = await axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=20`);
    res.json(analyzeOrderBook(ob.data.bids, ob.data.asks));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI ANALYSIS ────────────────────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  try {
    const { marketData, symbol } = req.body;
    const d = marketData;

    const prompt = `Eres un trader experto en BTC futuros perpetuos. Analiza estos datos y da una señal precisa.

DATOS EN TIEMPO REAL — ${symbol}:
Precio: $${d.price} | Cambio 24h: ${d.change24h}%
Funding Rate: ${(d.fundingRate * 100).toFixed(4)}% | Mark Price: $${d.markPrice}
Open Interest: ${d.openInterest} BTC | OI Delta (15m): ${d.oiDelta?.trend} (${d.oiDelta?.deltaPct}%)
Volumen 24h: $${d.volume24h}

INDICADORES 15M:
RSI: ${d.rsi15m} ${d.rsiOverbought ? '⚠ SOBRECOMPRA — NO entrar long' : d.rsiOversold ? '⚠ SOBREVENTA — NO entrar short' : ''}
CVD acumulado: ${d.cvd?.cumulative?.toFixed(0)} | Delta últimas 5 velas: ${d.cvd?.delta5?.toFixed(0)} | Delta 3 velas: ${d.cvd?.delta3?.toFixed(0)}
CVD tendencia: ${d.cvd?.trend}

DIVERGENCIA DETECTADA: ${d.divergence?.type} — ${d.divergence?.reason}
${d.divergence?.signal ? `⚡ SEÑAL DE DIVERGENCIA: ${d.divergence?.signal} (${d.divergence?.strength})` : ''}

VOLUME PROFILE (VRVP):
POC: $${d.vrvp?.poc} | VAH: $${d.vrvp?.vah} | VAL: $${d.vrvp?.val}

LIBRO DE ÓRDENES:
Presión: ${d.orderBook?.pressure} | Imbalance: ${d.orderBook?.imbalance}%
Bid Vol: ${d.orderBook?.bidVol} | Ask Vol: ${d.orderBook?.askVol}
Paredes BID: ${JSON.stringify(d.orderBook?.bidWalls?.slice(0, 3))}
Paredes ASK: ${JSON.stringify(d.orderBook?.askWalls?.slice(0, 3))}

SESGO MULTI-TEMPORALIDAD:
15m: ${d.bias?.tf15m?.bias} (${d.bias?.tf15m?.score}/100) RSI=${d.bias?.tf15m?.rsi}
1H: ${d.bias?.tf1h?.bias} (${d.bias?.tf1h?.score}/100) RSI=${d.bias?.tf1h?.rsi}
4H: ${d.bias?.tf4h?.bias} (${d.bias?.tf4h?.score}/100) RSI=${d.bias?.tf4h?.rsi}
1D: ${d.bias?.tf1d?.bias} (${d.bias?.tf1d?.score}/100) RSI=${d.bias?.tf1d?.rsi}

REGLAS CRÍTICAS:
1. RSI > 70 = sobrecompra → NO dar señal LONG, considerar SHORT o ESPERAR
2. RSI < 30 = sobreventa → NO dar señal SHORT, considerar LONG o ESPERAR
3. Precio sube + CVD cae + OI plano = divergencia bajista → SHORT
4. Precio baja + CVD sube + OI sube = divergencia alcista → LONG
5. Sesgo 4H y 1D definen dirección macro — no ir contra ellos sin confluencia fuerte
6. Paredes ASK grandes = resistencia → no entrar long sin ruptura
7. Paredes BID grandes = soporte → no entrar short sin ruptura

Responde SOLO en JSON sin texto extra:
{"direction":"LONG|SHORT|ESPERAR","confidence":0-100,"entry":precio,"tp1":precio,"tp2":precio,"sl":precio,"rr":"1:X","reasoning":"análisis en español 2-3 oraciones respetando las reglas críticas","warning":"riesgo principal o vacío","divergence_used":true|false}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const signal = JSON.parse(clean);

    await supabase.from('signals').insert({
      symbol,
      direction: signal.direction,
      confidence: signal.confidence,
      entry: signal.entry,
      tp1: signal.tp1,
      tp2: signal.tp2,
      sl: signal.sl,
      rr: signal.rr,
      reasoning: signal.reasoning,
      market_data: marketData
    }).catch(() => {});

    if (signal.confidence >= 70 && process.env.TELEGRAM_CHAT_ID) {
      const emoji = signal.direction === 'LONG' ? '▲' : signal.direction === 'SHORT' ? '▼' : '◆';
      const msg = `${emoji} SEÑAL ${signal.direction} — ${symbol}\n💰 Entry: $${signal.entry}\n🎯 TP1: $${signal.tp1} | TP2: $${signal.tp2}\n🛑 SL: $${signal.sl} | R:R ${signal.rr}\n📊 Confianza: ${signal.confidence}%\n💬 ${signal.reasoning}${signal.warning ? '\n⚠ ' + signal.warning : ''}`;
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    const { data, error } = await supabase.from('trades').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Panel Futuros LO v2.0 en puerto ${PORT}`));
