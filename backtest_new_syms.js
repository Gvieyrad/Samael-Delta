/**
 * Backtest de nuevos símbolos usando klines públicos de Binance Futures.
 * Proxy del sweep: vela con vol > 5x SMA20 + vela alcista (pump) → SHORT (mean reversion bet)
 * TP = entry - 2.5*ATR5, SL = entry + 0.8*ATR5
 * Filtros: solo SHORT, solo horas activas Lima, sin ETH
 */
const axios = require('axios');

const HORAS = new Set([7,8,9,10,13,15,16,17,18,19,21,23]);
const BINANCE = 'https://fapi.binance.com';
const SYMBOLS = ['SOLUSDT','DOGEUSDT','AVAXUSDT'];
const SIZE_USD = 62, LEV = 10, FEE_RT = 0.00028;

async function fetchKlines(symbol, interval='1h', days=90) {
  const limit = Math.min(days * 24, 1500);
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const r = await axios.get(`${BINANCE}/fapi/v1/klines`, {
    params: { symbol, interval, startTime, endTime, limit },
    timeout: 15000
  });
  // [openTime, open, high, low, close, volume, closeTime, ...]
  return r.data.map(k => ({
    t: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5]
  }));
}

function sma(arr, n) {
  if (arr.length < n) return arr.reduce((a,b)=>a+b,0)/arr.length;
  return arr.slice(-n).reduce((a,b)=>a+b,0)/n;
}

function atr(candles, n=5) {
  const trs = candles.slice(-n).map(c => c.high - c.low);
  return trs.reduce((a,b)=>a+b,0)/trs.length;
}

async function backtestSymbol(symbol) {
  const klines = await fetchKlines(symbol);
  const trades = [];

  for (let i = 25; i < klines.length - 10; i++) {
    const c = klines[i];
    const horaLima = new Date(c.t - 18000000).getUTCHours();
    if (!HORAS.has(horaLima)) continue;

    // Señal sweep: volumen > 5x SMA20 + vela alcista (pump → SHORT mean reversion)
    const vols = klines.slice(i-20, i).map(x=>x.vol);
    const avgVol = sma(vols, 20);
    const volMult = c.vol / avgVol;
    const isPump = (c.close - c.open) / c.open > 0.002; // +0.2% mínimo

    if (volMult < 5 || !isPump) continue;

    const entry = c.close;
    const a5 = atr(klines.slice(0, i+1));
    const tp = entry - a5 * 2.5;
    const sl = entry + a5 * 0.8;

    // Walk forward para ver si TP o SL toca primero
    let result = null;
    let closePrice = null;
    let closeReason = null;
    for (let j = i+1; j < Math.min(i+49, klines.length); j++) {
      const f = klines[j];
      if (f.low <= tp) { result='won'; closePrice=tp; closeReason='tp'; break; }
      if (f.high >= sl) { result='lost'; closePrice=sl; closeReason='sl'; break; }
    }
    if (!result) { result='timeout'; closePrice=klines[Math.min(i+48,klines.length-1)].close; closeReason='timeout'; }
    if (result==='timeout') continue; // ignorar trades sin cierre

    const notional = SIZE_USD * LEV;
    const pnlPct = (entry - closePrice) / entry;
    const pnl = parseFloat((notional * pnlPct - SIZE_USD * LEV * FEE_RT).toFixed(2));
    const won = result === 'won';

    trades.push({ symbol, entry, sl, tp, closePrice, closeReason, pnl, won, volMult: volMult.toFixed(1), hora: horaLima });
  }

  const wins = trades.filter(t=>t.won);
  const pnl  = trades.reduce((a,t)=>a+t.pnl,0);
  const fees = trades.length * SIZE_USD * LEV * FEE_RT;
  return { symbol, n: trades.length, wins: wins.length, pnl, fees, trades };
}

(async()=>{
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Backtest nuevos símbolos (90d klines 1h)    ║');
  console.log('║  Señal: vol>5x SMA20 + pump → SHORT          ║');
  console.log('║  Filtro: horas activas Lima + solo SHORT      ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  for (const sym of SYMBOLS) {
    try {
      const r = await backtestSymbol(sym);
      const wr = r.n > 0 ? (r.wins/r.n*100).toFixed(1) : '-';
      const neto = (r.pnl - r.fees).toFixed(2);
      console.log(`${sym.replace('USDT','').padEnd(6)} n=${String(r.n).padStart(3)}  WR=${wr.padStart(5)}%  PnL=${r.pnl>=0?'+':''}$${r.pnl.toFixed(2).padStart(7)}  neto=${parseFloat(neto)>=0?'+':''}$${neto}`);

      // Detalle por hora
      const byH = {};
      r.trades.forEach(t=>{
        if(!byH[t.hora]) byH[t.hora]={n:0,wins:0,pnl:0};
        byH[t.hora].n++; if(t.won) byH[t.hora].wins++; byH[t.hora].pnl+=t.pnl;
      });
      Object.entries(byH).sort((a,b)=>Number(a[0])-Number(b[0])).forEach(([h,v])=>{
        const pnlStr=(v.pnl>=0?'+':'')+'$'+v.pnl.toFixed(2);
        console.log(`  ${String(h).padStart(2)}h  n=${v.n}  WR=${(v.wins/v.n*100).toFixed(0).padStart(3)}%  ${pnlStr}`);
      });
      console.log('');
    } catch(e) {
      console.log(`${sym}: ERROR — ${e.message}`);
    }
  }
  process.exit(0);
})();
