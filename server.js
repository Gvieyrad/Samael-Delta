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

const BINANCE_BASE = 'https://fapi.binance.com';

app.get('/', (req, res) => {
  res.json({ status: 'Panel Futuros LO activo', version: '1.0.0' });
});

app.get('/api/market/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol || 'BTCUSDT';
    const [ticker, oi, funding, klines] = await Promise.all([
      axios.get(`${BINANCE_BASE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
      axios.get(`${BINANCE_BASE}/fapi/v1/openInterest?symbol=${symbol}`),
      axios.get(`${BINANCE_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      axios.get(`${BINANCE_BASE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`)
    ]);
    res.json({
      price: parseFloat(ticker.data.lastPrice),
      change24h: parseFloat(ticker.data.priceChangePercent),
      volume24h: parseFloat(ticker.data.quoteVolume),
      openInterest: parseFloat(oi.data.openInterest),
      fundingRate: parseFloat(funding.data.lastFundingRate),
      markPrice: parseFloat(funding.data.markPrice),
      indexPrice: parseFloat(funding.data.indexPrice),
      klines: klines.data
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orderbook/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol || 'BTCUSDT';
    const ob = await axios.get(`${BINANCE_BASE}/fapi/v1/depth?symbol=${symbol}&limit=20`);
    res.json(ob.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { marketData, symbol } = req.body;
    const prompt = `Analiza estos datos de mercado para ${symbol} futuros perpetuos y da una señal de trading:
Precio: $${marketData.price}
Cambio 24h: ${marketData.change24h}%
Funding Rate: ${(marketData.fundingRate * 100).toFixed(4)}%
Open Interest: ${marketData.openInterest}
Volumen 24h: $${marketData.volume24h}
Score técnico: ${marketData.score}/100
Responde SOLO en JSON sin texto extra:
{"direction":"LONG|SHORT|ESPERAR","confidence":0-100,"entry":precio,"tp1":precio,"tp2":precio,"sl":precio,"rr":"1:X","reasoning":"explicación en español de 2-3 oraciones","warning":"riesgo principal"}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
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
      reasoning: signal.reasoning,
      market_data: marketData
    });

    if (signal.confidence >= 70 && process.env.TELEGRAM_CHAT_ID) {
      const msg = `🤖 SEÑAL ${signal.direction} — ${symbol}\n💰 Entry: $${signal.entry}\n🎯 TP1: $${signal.tp1} | TP2: $${signal.tp2}\n🛑 SL: $${signal.sl}\n📊 Confianza: ${signal.confidence}%\n💬 ${signal.reasoning}`;
      bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg);
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
app.listen(PORT, () => console.log(`Panel Futuros LO corriendo en puerto ${PORT}`));
