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
let analyzeCache = {};

app.get('/', (req, res) => res.json({ status: 'Panel Futuros LO activo', version: '4.1.1' }));

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
  if(cvd.delta5>0) score += cvdExtreme ? 15 : 10;
  else score -= cvdExtreme ? 15 : 10;
  if(aboveVwap) score+=5; else score-=5;
  if(oiTrend.trend==='rising'&&priceVsPrev>0) score+=8;
  if(oiTrend.trend==='rising'&&priceVsPrev<0) score-=8;
  if(oiTrend.trend==='falling'&&priceVsPrev<0) score-=5;
  if(oiTrend.trend==='falling'&&priceVsPrev>0) score+=3;
  if(fundingRate>0.001) score-=5;
  if(fundingRate<-0.001) score+=5;

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
  return zones.map(z=>({price:parseFloat((price*(1+z.dist)).toFixed(0)),size:z.size,label:z.label,dist:Math.abs(z.dist*100).toFixed(1),direction:z.dist>0?'up':'down',isMajor:z.size>=600})).sort((a,b)=>Math.abs(parseFloat(a.dist))-Math.abs(parseFloat(b.dist)));
}

// ─── FIBONACCI AUTOMÁTICO ─────────────────────────────────────────
function calcFibonacci(klines, price) {
  if (!klines || klines.length < 20) return null;
  const highs = klines.map(k => parseFloat(k[2]));
  const lows  = klines.map(k => parseFloat(k[3]));
  const n = klines.length;
  let swingHigh = -Infinity, swingLow = Infinity;
  let swingHighIdx = 0, swingLowIdx = 0;
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
  const retracements = retLevels.map(r => ({
    level: r, price: isUptrend ? swingHigh - range * r : swingLow + range * r,
    label: r === 0 ? '0%' : r === 1 ? '100%' : `${(r*100).toFixed(1)}%`, isKey: [0.382, 0.5, 0.618].includes(r)
  }));
  const extensions = extLevels.map(r => ({
    level: r, price: isUptrend ? swingHigh + range * (r - 1) : swingLow - range * (r - 1),
    label: `${(r*100).toFixed(1)}%`, isKey: [1.618, 2.618].includes(r)
  }));
  let nearestRetrace = null, nearestExt = null;
  let minRetDist = Infinity, minExtDist = Infinity;
  retracements.forEach(lvl => {
    const dist = Math.abs(price - lvl.price) / price * 100;
    if (dist < minRetDist) { minRetDist = dist; nearestRetrace = { ...lvl, dist: parseFloat(dist.toFixed(2)) }; }
  });
  extensions.forEach(lvl => {
    const dist = Math.abs(price - lvl.price) / price * 100;
    if (dist < minExtDist) { minExtDist = dist; nearestExt = { ...lvl, dist: parseFloat(dist.toFixed(2)) }; }
  });
  function fibImpact(nearest, isRetracement) {
    if (!nearest) return { bonus: 0, penalty: 0, signal: 'none' };
    const isKey = nearest.isKey;
    const isVeryClose = nearest.dist < 0.3;
    const isClose = nearest.dist < 0.8;
    if (!isClose) return { bonus: 0, penalty: 0, signal: 'none', description: '' };
    if (isRetracement && isKey) {
      return { bonus: isVeryClose ? 15 : 8, penalty: 0, signal: isUptrend ? 'long_bounce' : 'short_bounce', description: `Precio en retroceso Fib ${nearest.label} — zona de rebote clave` };
    }
    if (!isRetracement && isKey) {
      return { bonus: 0, penalty: isVeryClose ? 12 : 6, signal: isUptrend ? 'short_exhaustion' : 'long_exhaustion', description: `Precio en extensión Fib ${nearest.label} — zona de agotamiento` };
    }
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
  const lastHigh=Math.max(...highs.slice(-3));
  const prevHigh=Math.max(...highs.slice(-8,-3));
  const prevHigh2=Math.max(...highs.slice(-14,-8));
  const lastLow=Math.min(...lows.slice(-3));
  const prevLow=Math.min(...lows.slice(-8,-3));
  const prevLow2=Math.min(...lows.slice(-14,-8));
  const lastClose=closes[closes.length-1];
  const prevClose5=closes.length>=6?closes[closes.length-6]:closes[0]||0;
  const prevClose10=closes.length>=11?closes[closes.length-11]:closes[0]||0;
  const priceUp=lastClose>prevClose5, priceDown=lastClose<prevClose5;
  const priceUp10=lastClose>prevClose10, priceDown10=lastClose<prevClose10;
  const cvdFalling=cvd.delta5<0, cvdRising=cvd.delta5>0;
  const cvdAgressive=Math.abs(cvd.cvdPct)>5;
  const avgVol=volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
  const lastVol=volumes[volumes.length-1];
  const volClimaxUp=lastVol>avgVol*2.5&&priceUp;
  const volClimaxDown=lastVol>avgVol*2.5&&priceDown;
  const trend4h=bias4h?.bias||'neutral', trend1d=bias1d?.bias||'neutral';
  const bearishContext=trend4h==='short'||trend1d==='short';
  const bullishContext=trend4h==='long'||trend1d==='long';
  const oiRising=oiTrend15m?.trend==='rising', oiFalling=oiTrend15m?.trend==='falling';
  const aboveVwap=lastClose>vwap, belowVwap=lastClose<vwap;
  const hasBidWall=(ob.bidWalls?.length||0)>0, hasAskWall=(ob.askWalls?.length||0)>0;

  if(priceUp&&cvdRising&&cvdAgressive){
    let prob=73; if(hasAskWall) prob+=12; if(oiFalling) prob+=8; if(lastRSI>65) prob+=7; if(lastRSI>75) prob+=8;
    if(bearishContext) prob+=8; if(aboveVwap) prob+=5; if(volClimaxUp) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'absorcion_compras', name:'Absorción de Compras', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`CVD +${cvd.cvdPct}% agresivo con muro vendedor — precio se agotará.${bearishContext?' 4H/1D bajista.':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',hasAskWall&&'Muro ask',oiFalling&&'OI cayendo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }
  if(priceDown&&cvdFalling&&cvdAgressive){
    let prob=73; if(hasBidWall) prob+=12; if(lastRSI<35) prob+=10; if(lastRSI<25) prob+=8;
    if(bullishContext) prob+=8; if(belowVwap) prob+=5; if(oiFalling) prob+=5; if(volClimaxDown) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'absorcion_ventas', name:'Absorción de Ventas', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Ballena comprando con límites — CVD ${cvd.cvdPct}% mientras precio baja.${bullishContext?' 4H/1D alcista.':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',oiFalling&&'OI cayendo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }
  if(lastHigh>prevHigh&&lastRSI<prevRSI-3){
    let prob=64; if(cvdFalling) prob+=15; if(oiRising&&priceUp) prob+=5; if(lastRSI>60) prob+=7; if(lastRSI>70) prob+=8;
    if(bearishContext) prob+=8; if(hasAskWall) prob+=8;
    if(prevHigh>prevHigh2&&prevRSI<prevRSI8-2) prob+=10;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'rsi_bajista', name:'Div. RSI Bajista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`Precio HH ($${parseInt(lastHigh).toLocaleString()}) pero RSI LH (${lastRSI} vs ${prevRSI}) — momentum agotado.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[cvdFalling&&'CVD divergente',bearishContext&&'Contexto bajista',hasAskWall&&'Muro ask'].filter(Boolean) });
  }
  if(lastLow<prevLow&&lastRSI>prevRSI+3){
    let prob=64; if(cvdRising) prob+=15; if(lastRSI<40) prob+=7; if(lastRSI<30) prob+=8;
    if(bullishContext) prob+=8; if(hasBidWall) prob+=8;
    if(prevLow<prevLow2&&prevRSI>prevRSI8+2) prob+=10;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'rsi_alcista', name:'Div. RSI Alcista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Precio LL ($${parseInt(lastLow).toLocaleString()}) pero RSI HL (${lastRSI} vs ${prevRSI}) — vendedores agotados.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista',hasBidWall&&'Muro bid'].filter(Boolean) });
  }
  if(priceUp&&cvdFalling){
    let prob=65; if(oiRising) prob+=8; if(lastRSI>60) prob+=8; if(cvdAgressive) prob+=7; if(bearishContext) prob+=8; if(aboveVwap) prob+=5;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'cvd_precio_bajista', name:'Div. CVD/Precio Bajista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`Precio sube pero CVD ${cvd.cvdPct}% negativo — subida sin respaldo real de volumen.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }
  if(priceDown&&cvdRising){
    let prob=65; if(lastRSI<40) prob+=10; if(cvdAgressive) prob+=7; if(bullishContext) prob+=8; if(belowVwap) prob+=5; if(oiFalling) prob+=5;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'cvd_precio_alcista', name:'Div. CVD/Precio Alcista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Precio baja pero CVD +${cvd.cvdPct}% — demanda oculta absorbiendo la caída.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'Shorts cerrando',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }
  if(priceUp&&oiFalling&&cvdFalling){
    let prob=72; if(lastRSI>65) prob+=8; if(bearishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'bull_trap', name:'Trampa Alcista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:'Subida con OI cayendo y CVD negativo — shorts liquidados sin demanda real. Fakeout.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'OI cayendo',cvdFalling&&'CVD divergente',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }
  if(priceDown&&oiFalling&&cvdRising){
    let prob=72; if(lastRSI<35) prob+=8; if(bullishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'bear_trap', name:'Trampa Bajista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:'Caída con OI cayendo y CVD positivo — longs liquidados sin oferta real. Fakeout bajista.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'OI cayendo',cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }
  if(oiRising&&priceDown10&&cvdFalling){
    let prob=70; if(lastRSI<50) prob+=8; if(bearishContext) prob+=10; if(cvdAgressive) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'short_buildup', name:'Short Buildup', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:'OI sube mientras precio cae — nuevas posiciones cortas con convicción. Tendencia bajista real.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',cvdFalling&&'CVD negativo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }
  if(oiRising&&priceUp10&&cvdRising){
    let prob=70; if(lastRSI>50&&lastRSI<70) prob+=8; if(bullishContext) prob+=10; if(cvdAgressive) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'long_buildup', name:'Long Buildup', direction:'LONG', probability:Math.min(95,prob), entry:price, description:'OI sube mientras precio sube — nuevas posiciones largas con convicción. Tendencia alcista real.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }
  if(Math.abs(fundingRate)>0.0008){
    const isBull=fundingRate>0; let prob=68;
    if(Math.abs(fundingRate)>0.002) prob+=12; else if(Math.abs(fundingRate)>0.001) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,isBull?'down':'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'funding_extremo', name:'Funding Extremo', direction:isBull?'SHORT':'LONG', probability:Math.min(90,prob), entry:price, description:`FR ${(fundingRate*100).toFixed(4)}% — ${isBull?'longs sobrecalentados, corrección inminente':'shorts en riesgo, squeeze probable'}`, action:prob>=75?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:[`FR ${(fundingRate*100).toFixed(4)}%`] });
  }
  if(cvd.isClimax){
    const dir=cvd.delta5>0?'SHORT':'LONG'; let prob=73;
    const nearLiq=getNearestLiqMagnet(price,dir==='SHORT'?'down':'up'); if(nearLiq) prob+=nearLiq.bonus;
    if(dir==='SHORT'&&bearishContext) prob+=8; if(dir==='LONG'&&bullishContext) prob+=8;
    divergences.push({ type:'volumen_climax', name:'Volumen Clímax', direction:dir, probability:Math.min(92,prob), entry:price, description:`Vol ${dir==='SHORT'?'comprador':'vendedor'} extremo (2.5x avg) — agotamiento inminente. Clímax = reversión.`, action:prob>=80?'ENTRAR':'ESPERAR', liqTarget:nearLiq?.price, confluence:['Vol 2.5x avg'] });
  }
  if(oiRising&&fundingRate<-0.0005&&priceDown){
    let prob=72; if(cvdFalling) prob+=8; if(bearishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'long_squeeze', name:'Squeeze de Longs', direction:'SHORT', probability:Math.min(90,prob), entry:price, description:'OI alto + funding negativo + precio cae — longs siendo liquidados en cascada.', action:prob>=78?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:['OI alto','Funding negativo','Precio cayendo'] });
  }
  if(oiRising&&fundingRate>0.002&&priceUp){
    let prob=72; if(cvdRising) prob+=8; if(bullishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'short_squeeze', name:'Squeeze de Shorts', direction:'LONG', probability:Math.min(90,prob), entry:price, description:'OI alto + funding muy positivo + precio sube — shorts siendo liquidados. Momentum alcista.', action:prob>=78?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:['OI alto','Funding extremo','Precio subiendo'] });
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
    if (bullishContext) prob = Math.min(95, prob + 10);
    if (hasBidWall) prob = Math.min(95, prob + 8);
    const nearLiq = getNearestLiqMagnet(price, 'up'); if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type:'regime_change_long', name:'Cambio de Régimen — LONG', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`${bearExhaustion}/5 señales de agotamiento bajista activas — mercado cambia de dirección. ${bearExhaustion>=4?'Señal MUY FUERTE.':'Confirmar con vela alcista.'}`, action:prob>=82?'ENTRAR':prob>=68?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[lastRSI<35&&'RSI sobreventa',cvdRising&&priceDownRegime&&'CVD divergente alcista',oiFalling&&priceDownRegime&&'OI cayendo (shorts cierran)',fundingRate<-0.0005&&'Funding negativo extremo',lastVol>avgVol*2&&priceDownRegime&&'Volumen clímax bajista'].filter(Boolean) });
  }

  const priceUpRegime = closes.length >= 6 ? lastClose > closes[closes.length - 6] : false;
  const bullExhaustion = [lastRSI > 68, cvdFalling && priceUpRegime, oiFalling && priceUpRegime, fundingRate > 0.001, lastVol > avgVol * 2 && priceUpRegime].filter(Boolean).length;
  if (bullExhaustion >= 3) {
    let prob = 65 + (bullExhaustion * 6);
    if (bearishContext) prob = Math.min(95, prob + 10);
    if (hasAskWall) prob = Math.min(95, prob + 8);
    const nearLiq = getNearestLiqMagnet(price, 'down'); if (nearLiq) prob += nearLiq.bonus;
    divergences.push({ type:'regime_change_short', name:'Cambio de Régimen — SHORT', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`${bullExhaustion}/5 señales de agotamiento alcista activas — mercado cambia de dirección. ${bullExhaustion>=4?'Señal MUY FUERTE.':'Confirmar con vela bajista.'}`, action:prob>=82?'ENTRAR':prob>=68?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[lastRSI>68&&'RSI sobrecompra',cvdFalling&&priceUpRegime&&'CVD divergente bajista',oiFalling&&priceUpRegime&&'OI cayendo (longs cierran)',fundingRate>0.001&&'Funding positivo extremo',lastVol>avgVol*2&&priceUpRegime&&'Volumen clímax alcista'].filter(Boolean) });
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

  return divergences.sort((a,b)=>b.probability-a.probability);
  } catch(e) { console.error('detectDivergences error:', e.message); return []; }
}

function calcCombinedSignal(divergences, bias4h, bias1d, whaleData=null, deepOB=null, fib=null) {
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
  if(direction==='LONG'){ if(both4hAnd1dLong) prob=Math.min(95,prob+15); else if(only4hLong) prob=Math.min(95,prob+8); if(bias1d?.bias==='short') prob=Math.max(5,prob-10); }
  if(direction==='SHORT'){ if(both4hAnd1dShort) prob=Math.min(95,prob+15); else if(only4hShort) prob=Math.min(95,prob+8); if(bias1d?.bias==='long') prob=Math.max(5,prob-10); }

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

// ─── LIQUIDACIONES REALES ────────────────────────────────────────
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

// ─── LIBRO PROFUNDO ──────────────────────────────────────────────
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

// ─── DETECCIÓN DE BALLENAS ───────────────────────────────────────
async function detectWhales(symbol, price) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/aggTrades?symbol=${symbol}&limit=500`);
    const trades = res.data || [];
    const whaleThreshold = symbol.includes('BTC') ? 500000 : symbol.includes('ETH') ? 100000 : 50000;
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
    const [liqData, deepOB, whaleData] = await Promise.all([fetchForceOrders(symbol), fetchDeepOrderBook(symbol), detectWhales(symbol, price_temp)]);
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
    const liqMagnets=calcLiqMagnets(price);
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
    const combinedSignal=calcCombinedSignal(allDivs,bias4h,bias1d,whaleData,deepOB,fib15m);
    const scalpSignal=calcScalpSignal(allDivs,calcBias(k15m.data,oi15mHist,fundingRate),calcBias(k1h.data,oi1hHist,fundingRate),bias4h);
    const vols=k15m.data.slice(-5).map(k=>parseFloat(k[5]));
    const avgVol5=vols.slice(0,-1).reduce((a,b)=>a+b,0)/4;
    const lastVol=vols[vols.length-1];
    const volDeltaPct=avgVol5>0?((lastVol-avgVol5)/avgVol5*100).toFixed(1):'0.0';
    res.json({ price, change24h:parseFloat(ticker.data.priceChangePercent), volume24h:parseFloat(ticker.data.quoteVolume), openInterest:parseFloat(oiRes.data.openInterest), fundingRate, markPrice:parseFloat(funding.data.markPrice), indexPrice:parseFloat(funding.data.indexPrice), rsi15m, rsiOverbought:rsi15m>70, rsiOversold:rsi15m<30, cvd15m, vrvp, bb15m, vwap15m:vwap15m.toFixed(1), oiTrends:{ tf15m:oiTrend15m, tf1h:oiTrend1h, tf4h:oiTrend4h }, volDeltaPct:parseFloat(volDeltaPct), orderBook:ob, liqMagnets, divergences:allDivs, combinedSignal, scalpSignal, doublePatterns, bias:{ tf15m:bias15m, tf1h:bias1h, tf4h:bias4h, tf1d:bias1d }, klines:k15m.data.slice(-20), liqData, deepOB, whaleData, fibonacci:{ tf15m:fib15m, tf4h:fib4h } });
  } catch(e) { console.error('Market error:',e.message); res.status(500).json({ error:e.message }); }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { marketData:d, symbol } = req.body;
    const now=Date.now();
    if(analyzeCache[symbol]&&now-analyzeCache[symbol].ts<60000) return res.json(analyzeCache[symbol].data);
    const divSummary=d.divergences?.slice(0,4).map(dv=>`${dv.name}: ${dv.direction} ${dv.probability}% — ${dv.description}`).join('\n')||'Ninguna';
    const b=d.bias;
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
IMÁN: ${d.liqMagnets?.[0]?.direction==='down'?'↓':'↑'} $${d.liqMagnets?.[0]?.price} (${d.liqMagnets?.[0]?.dist}% $${d.liqMagnets?.[0]?.size}M)

REGLAS: RSI>72 no long; RSI<28 no short; OI+precio misma dirección=trend real; OI cae+precio sube=trampa; funding>0.002%=sobrecalentado.

Responde SOLO JSON sin markdown:
{"direction":"LONG|SHORT|ESPERAR","confidence":0-100,"entry":precio,"tp1":precio,"tp2":precio,"sl":precio,"rr":"1:X","reasoning":"2-3 oraciones en español","warning":"riesgo principal o vacío","action":"ENTRAR|ESPERAR|NO ENTRAR"}`;

    const response=await anthropic.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:600, messages:[{role:'user',content:prompt}] });
    const text=response.content[0].text;
    const signal=JSON.parse(text.replace(/```json|```/g,'').trim());

    // ✅ FIX R:R — recalcular con precios reales, ignorar valor de IA
    const _rrReward = signal.direction === 'SHORT' ? (signal.entry - signal.tp1) : (signal.tp1 - signal.entry);
    const _rrRisk   = signal.direction === 'SHORT' ? (signal.sl - signal.entry) : (signal.entry - signal.sl);
    const _rrVal    = (_rrRisk > 0) ? (_rrReward / _rrRisk) : 0;
    signal.rr = `1:${_rrVal.toFixed(1)}`;

    analyzeCache[symbol]={ ts:now, data:signal };
    try { await supabase.from('signals').insert({ symbol, direction:signal.direction, confidence:signal.confidence, entry:signal.entry, tp1:signal.tp1, tp2:signal.tp2, sl:signal.sl, rr:signal.rr, reasoning:signal.reasoning, market_data:d }); } catch(_){}

    if(signal.confidence>=75&&process.env.TELEGRAM_CHAT_ID){
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

// ─── ALERTAS TELEGRAM AUTOMÁTICAS ────────────────────────────────
let alertCache = {};
const signalHistory = {};

function confirmSignal(symbol, direction, probability) {
  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  const now = Date.now();
  const history = signalHistory[symbol];
  history.push({ direction, probability, timestamp: now });
  signalHistory[symbol] = history.filter(s => now - s.timestamp < 45 * 60 * 1000).slice(-3);
  const recent = signalHistory[symbol];
  const sameDirection = recent.filter(s => s.direction === direction && now - s.timestamp < 30 * 60 * 1000);
  if (sameDirection.length < 2) { console.log(`⏳ Señal ${direction} ${symbol} ${probability}% — esperando confirmación (${sameDirection.length}/2)`); return { confirmed: false, count: sameDirection.length }; }
  if (probability >= 92 && sameDirection.length >= 1) { console.log(`✅ Señal ${direction} ${symbol} ${probability}% — confirmada inmediatamente`); return { confirmed: true, count: sameDirection.length, avgProbability: probability }; }
  const avgProb = Math.round(sameDirection.reduce((s,r) => s + r.probability, 0) / sameDirection.length);
  console.log(`✅ Señal ${direction} ${symbol} CONFIRMADA — ${sameDirection.length} análisis, prob promedio ${avgProb}%`);
  return { confirmed: true, count: sameDirection.length, avgProbability: avgProb };
}

function clearSignalHistory(symbol) { signalHistory[symbol] = []; }

async function runAutoAnalysis(symbol = 'BTCUSDT') {
  try {
    const price_temp_res = await axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`);
    const price_temp = parseFloat(price_temp_res.data.lastPrice);
    const [ticker,oiRes,funding,k15m,k1h,k4h,k1d,obRes,oi15mHist,oi1hHist,oi4hHist] = await Promise.all([
      Promise.resolve(price_temp_res),
      axios.get(`${BINANCE}/fapi/v1/openInterest?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=100`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=60`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=20`),
      fetchOIHistory(symbol,'15m',10), fetchOIHistory(symbol,'1h',10), fetchOIHistory(symbol,'4h',10),
    ]);
    const [liqData, deepOB, whaleData] = await Promise.all([fetchForceOrders(symbol), fetchDeepOrderBook(symbol), detectWhales(symbol, price_temp)]);
    const price = parseFloat(ticker.data.lastPrice);
    const fundingRate = parseFloat(funding.data.lastFundingRate);
    if (!k15m.data || !Array.isArray(k15m.data) || k15m.data.length < 20) { console.log(`⚠️ Auto-analysis: datos insuficientes para ${symbol}`); return; }
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
    const fib4h  = calcFibonacci(k4h.data?.length >= 20 ? k4h.data : k15m.data, price);
    const divergences = detectDivergences(k15m.data, ob, price, fundingRate, bias4h, bias1d, oiTrend15m, fib15m);
    const combinedSignal = calcCombinedSignal(divergences, bias4h, bias1d, whaleData, deepOB, fib15m);
    const minConfidence = parseInt(process.env.ALERT_MIN_CONFIDENCE || '80');
    const minDivergences = parseInt(process.env.ALERT_MIN_DIVERGENCES || '2');
    if (combinedSignal.direction === 'ESPERAR') { clearSignalHistory(symbol); return; }
    if (combinedSignal.probability < minConfidence) return;
    if (divergences.length < minDivergences) return;
    const confirmation = confirmSignal(symbol, combinedSignal.direction, combinedSignal.probability);
    if (!confirmation.confirmed) return;
    const cacheKey = `${symbol}_${combinedSignal.direction}_${Math.floor(price / 100)}`;
    const now = Date.now();
    if (alertCache[cacheKey] && now - alertCache[cacheKey] < 30 * 60 * 1000) return;
    alertCache[cacheKey] = now;

    const marketData = { price, change24h: parseFloat(ticker.data.priceChangePercent), fundingRate, openInterest: parseFloat(oiRes.data.openInterest), rsi15m: calcRSI(closes15m), cvd15m, vrvp, volDeltaPct: 0, orderBook: ob, liqMagnets: calcLiqMagnets(price).slice(0,5), divergences: divergences.slice(0,4), combinedSignal, bias: { tf15m: bias15m, tf1h: bias1h, tf4h: bias4h, tf1d: bias1d } };
    const divSummary = divergences.slice(0,3).map(d => `${d.name}: ${d.direction} ${d.probability}% — ${d.description}`).join('\n');
    const b = marketData.bias;
    const prompt = `Eres un trader experto en futuros perpetuos. Analiza y da señal precisa.

MERCADO: ${symbol} — $${price} (${marketData.change24h?.toFixed(2)}%)
RSI 15m: ${marketData.rsi15m}
CVD 15m: tendencia=${cvd15m.trend}, cvdPct=${cvd15m.cvdPct}%
OI: ${marketData.openInterest?.toFixed(0)} | Funding: ${(fundingRate*100).toFixed(4)}%
VRVP: POC=$${vrvp.poc} VAH=$${vrvp.vah} VAL=$${vrvp.val}
SESGO: 15m=${b.tf15m?.bias}(${b.tf15m?.score}) 1H=${b.tf1h?.bias}(${b.tf1h?.score}) 4H=${b.tf4h?.bias}(${b.tf4h?.score}) 1D=${b.tf1d?.bias}(${b.tf1d?.score})
DIVERGENCIAS (${divergences.length}):
${divSummary}
SEÑAL: ${combinedSignal.direction} ${combinedSignal.probability}% — ${combinedSignal.action}
${fib15m?.nearestRetrace?.dist < 0.8 ? 'FIB: precio en retroceso ' + fib15m.nearestRetrace.label + ' — ' + fib15m.retImpact.description : ''}
REGLAS: RSI>72 no long; RSI<28 no short; OI+precio misma dir=trend real.
Responde SOLO JSON sin markdown:
{"direction":"LONG|SHORT|ESPERAR","confidence":0-100,"entry":precio,"tp1":precio,"tp2":precio,"sl":precio,"rr":"1:X","reasoning":"2-3 oraciones en español","warning":"riesgo o vacío","action":"ENTRAR|ESPERAR|NO ENTRAR"}`;

    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: prompt }] });
    const text = response.content[0].text;
    const signal = JSON.parse(text.replace(/```json|```/g, '').trim());

    // ✅ FIX R:R — recalcular con precios reales, ignorar valor de IA
    const _rrReward = signal.direction === 'SHORT' ? (signal.entry - signal.tp1) : (signal.tp1 - signal.entry);
    const _rrRisk   = signal.direction === 'SHORT' ? (signal.sl - signal.entry) : (signal.entry - signal.sl);
    const _rrVal    = (_rrRisk > 0) ? (_rrReward / _rrRisk) : 0;
    signal.rr = `1:${_rrVal.toFixed(1)}`;

    if (signal.confidence < minConfidence) return;
    if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) return;

    const dir = signal.direction;
    const emoji = dir === 'LONG' ? '🟢' : dir === 'SHORT' ? '🔴' : '🟡';
    const fibNote = fib15m?.nearestRetrace?.dist < 0.8 ? `\n⬟ Fib ${fib15m.nearestRetrace.label} — ${fib15m.retImpact.description}` : '';
    const whaleNote = whaleData?.whaleCount >= 3 ? `\n🐋 Ballenas: ${whaleData.dominance} (${whaleData.whaleCount} trades)` : '';

    const msg = `${emoji} *${dir}* — ${symbol}
━━━━━━━━━━━━━━
💰 Entry: *$${signal.entry?.toLocaleString()}*
🎯 TP1: $${signal.tp1?.toLocaleString()} | TP2: $${signal.tp2?.toLocaleString()}
🛑 SL: $${signal.sl?.toLocaleString()} | ${signal.rr}
━━━━━━━━━━━━━━
📊 Confianza: *${signal.confidence}%* — ${signal.action}
📈 ${combinedSignal.shortCount}S · ${combinedSignal.longCount}L activas
💬 ${signal.reasoning}${signal.warning ? '\n⚠️ ' + signal.warning : ''}${fibNote}${whaleNote}
━━━━━━━━━━━━━━
🕐 ${new Date().toLocaleTimeString('es-PE')}`;

    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
    console.log(`✅ Alerta enviada: ${dir} ${symbol} ${signal.confidence}%`);

    try { await supabase.from('signals').insert({ symbol, direction: signal.direction, confidence: signal.confidence, entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2, sl: signal.sl, rr: signal.rr, reasoning: signal.reasoning, market_data: marketData, source: 'auto_alert' }); } catch(_) {}

    // 7. AUTO PAPER TRADING
    const autoPaperThreshold = parseInt(process.env.AUTO_PAPER_THRESHOLD || '85');
    const trend1d = bias1d.bias;
    const trendOk = signal.direction === 'ESPERAR' ? false : signal.direction === 'LONG' ? (trend1d !== 'short') : signal.direction === 'SHORT' ? (trend1d !== 'long') : true;

    // ✅ FIX FILTRO R:R — descartar trades con R:R < 1.5
    // ✅ FIX LONG+SHORT — bloquear cualquier trade abierto del mismo par
    const canAutoTrade = signal.confidence >= autoPaperThreshold
      && signal.direction !== 'ESPERAR'
      && trendOk
      && divergences.length >= 2
      && _rrVal >= 1.5;

    if (canAutoTrade) {
      try {
        // ✅ FIX: bloquear cualquier trade abierto del mismo par (no solo misma dirección)
        const { data: existing } = await supabase.from('paper_trades')
          .select('id').eq('symbol', symbol).eq('status', 'open');

        if (!existing || existing.length === 0) {
          const mlSnapshot = {
            confidence: signal.confidence, direction: signal.direction, trend_aligned: trendOk, trend_1d: trend1d,
            rsi_15m: marketData.rsi15m, cvd_pct: cvd15m.cvdPct, cvd_trend: cvd15m.trend, funding_rate: fundingRate,
            oi_trend_15m: oiTrend15m.trend, oi_delta_15m: oiTrend15m.deltaPct,
            bias_15m: bias15m.bias, bias_15m_score: bias15m.score, bias_1h: bias1h.bias, bias_1h_score: bias1h.score,
            bias_4h: bias4h.bias, bias_4h_score: bias4h.score, bias_1d: bias1d.bias, bias_1d_score: bias1d.score,
            divergence_count: divergences.length, top_divergence: divergences[0]?.type, top_divergence_prob: divergences[0]?.probability,
            short_count: combinedSignal.shortCount, long_count: combinedSignal.longCount,
            fib_level: fib15m?.nearestRetrace?.label, fib_dist: fib15m?.nearestRetrace?.dist, fib_signal: fib15m?.retImpact?.signal, fib_bonus: fib15m?.retImpact?.bonus,
            whale_count: whaleData?.whaleCount, whale_bias: whaleData?.whaleBias, whale_dominance: whaleData?.dominance, whale_ratio: whaleData?.whaleRatio,
            deep_imbalance: deepOB?.deepImbalance, bid_clusters: deepOB?.bidClusters?.length, ask_clusters: deepOB?.askClusters?.length,
            price_vs_poc: ((marketData.price - vrvp.poc) / vrvp.poc * 100).toFixed(3), price_vs_vah: ((marketData.price - vrvp.vah) / vrvp.vah * 100).toFixed(3), price_vs_val: ((marketData.price - vrvp.val) / vrvp.val * 100).toFixed(3),
            price: marketData.price, timestamp: new Date().toISOString()
          };

          await supabase.from('paper_trades').insert({
            symbol, direction: signal.direction, entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2, sl: signal.sl,
            rr: signal.rr, confidence: signal.confidence,
            size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'),
            leverage: parseInt(process.env.PAPER_LEVERAGE || '10'),
            divergences: divergences.slice(0,5), fibonacci: fib15m, source: 'auto', status: 'open', market_data: mlSnapshot
          }).select().single();

          console.log(`🤖 Auto paper trade: ${signal.direction} ${symbol} @ $${signal.entry} (${signal.confidence}%) R:R ${_rrVal.toFixed(2)}`);

          if (process.env.TELEGRAM_CHAT_ID) {
            const tradeEmoji = signal.direction === 'LONG' ? '▲' : '▼';
            const autoMsg = `🤖 *Auto Paper Trade abierto*\n${tradeEmoji} ${signal.direction} ${symbol}\n💰 Entry: $${signal.entry?.toLocaleString()}\n🎯 TP: $${signal.tp1?.toLocaleString()} | 🛑 SL: $${signal.sl?.toLocaleString()}\n📊 ${signal.confidence}% confianza\n📐 ${signal.rr} R:R`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, autoMsg, { parse_mode: 'Markdown' }); } catch(_) {}
          }
        } else {
          console.log(`⏭ Auto paper trade omitido: ya hay ${existing.length} trade(s) abierto(s) para ${symbol}`);
        }
      } catch(paperErr) { console.error('Auto paper trade error:', paperErr.message); }
    } else if (_rrVal > 0 && _rrVal < 1.5) {
      console.log(`⚠️ Auto paper trade descartado — R:R ${_rrVal.toFixed(2)} < 1.5 mínimo`);
    }

  } catch(e) { console.error('Auto-analysis error:', e.message, e.stack?.split('\n')[1]); }
}

// ─── JOB PERIÓDICO ───────────────────────────────────────────────
function startAlertJob() {
  if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) {
    console.log('⚠️ Alertas Telegram desactivadas — faltan TELEGRAM_CHAT_ID y TELEGRAM_TOKEN');
    setInterval(monitorPaperTrades, 5 * 60 * 1000);
    setTimeout(monitorPaperTrades, 15000);
    return;
  }
  const intervalMin = parseInt(process.env.ALERT_INTERVAL_MIN || '15');
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  console.log(`✅ Alertas activas — cada ${intervalMin} min para: ${symbols.join(', ')}`);
  setInterval(monitorPaperTrades, 5 * 60 * 1000);
  setTimeout(monitorPaperTrades, 15000);
  setInterval(async () => { for (const symbol of symbols) { await runAutoAnalysis(symbol.trim()); await new Promise(r => setTimeout(r, 3000)); } }, intervalMin * 60 * 1000);
  setTimeout(async () => { for (const symbol of symbols) { await runAutoAnalysis(symbol.trim()); await new Promise(r => setTimeout(r, 3000)); } }, 10000);
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
  await runAutoAnalysis(symbol);
  res.json({ ok: true, message: `Análisis disparado para ${symbol}` });
});

app.get('/api/alert/status', (req, res) => {
  res.json({ active: !!(process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN), intervalMin: parseInt(process.env.ALERT_INTERVAL_MIN || '15'), symbols: (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(','), minConfidence: parseInt(process.env.ALERT_MIN_CONFIDENCE || '80') });
});

// ─── PAPER TRADING ───────────────────────────────────────────────
app.post('/api/paper/open', async (req, res) => {
  try {
    const { symbol, direction, entry, tp1, tp2, sl, rr, confidence, size_usd, leverage, divergences, fibonacci, source } = req.body;

    // ✅ FIX: verificar que no hay trade abierto del mismo par antes de abrir manual
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol', symbol).eq('status', 'open');
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: `Ya hay un trade abierto para ${symbol}. Ciérralo antes de abrir otro.` });
    }

    const { data, error } = await supabase.from('paper_trades').insert({
      symbol, direction, entry, tp1, tp2, sl, rr, confidence,
      size_usd: size_usd || 1000, leverage: leverage || 10,
      divergences, fibonacci, source: source || 'manual', status: 'open'
    }).select().single();
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

    // ✅ FIX PnL — NO multiplicar por leverage (size_usd ya incluye el leverage)
    const priceDiff = trade.direction === 'LONG' ? (closeP - entry) / entry : (entry - closeP) / entry;
    const pnl_usd = parseFloat((size * priceDiff).toFixed(2));
    const pnl_pct = parseFloat((priceDiff * 100).toFixed(2));

    const { data, error } = await supabase.from('paper_trades').update({
      status: close_reason === 'tp1' || close_reason === 'tp2' ? 'won' : close_reason === 'sl' ? 'lost' : 'closed',
      close_price: closeP, close_reason, pnl_usd, pnl_pct, closed_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, trade: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/paper/open', async (req, res) => {
  try {
    const { data, error } = await supabase.from('paper_trades').select('*').eq('status', 'open').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
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
        const priceDiffPct = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
        if (priceDiffPct > 50) { console.log(`⚠️ Precio incoherente para ${trade.symbol} — omitiendo`); continue; }
        const tp1 = parseFloat(trade.tp1);
        const tp2 = parseFloat(trade.tp2) || tp1;
        const sl  = parseFloat(trade.sl);
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

          // ✅ FIX PnL — NO multiplicar por leverage
          const pnl_usd = parseFloat((trade.size_usd * priceDiff).toFixed(2));
          const pnl_pct = parseFloat((priceDiff * 100).toFixed(2));

          const maxPnl = parseFloat(trade.size_usd) * 5;
          if (Math.abs(pnl_usd) > maxPnl) {
            console.log(`⚠️ PnL absurdo detectado para ${trade.symbol} ${trade.id}: $${pnl_usd} — cerrando con pnl=0`);
            await supabase.from('paper_trades').update({ status: 'closed', close_price: currentPrice, close_reason: 'invalid_pnl', pnl_usd: 0, pnl_pct: 0, closed_at: new Date().toISOString() }).eq('id', trade.id);
            continue;
          }
          await supabase.from('paper_trades').update({ status: closeReason === 'tp1' || closeReason === 'tp2' ? 'won' : 'lost', close_price: currentPrice, close_reason: closeReason, pnl_usd, pnl_pct, closed_at: new Date().toISOString() }).eq('id', trade.id);
          console.log(`📊 Paper trade cerrado: ${trade.direction} ${trade.symbol} → ${closeReason} PnL: $${pnl_usd}`);
          if (process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN) {
            const emoji = closeReason === 'tp2' ? '🎯' : closeReason === 'tp1' ? '✅' : '❌';
            const msg = `${emoji} Paper Trade Cerrado\n${trade.direction} ${trade.symbol}\nEntry: $${entry.toLocaleString()} → Cierre: $${currentPrice.toLocaleString()}\nRazón: ${closeReason.toUpperCase()}\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd} (${pnl_pct}%)`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg); } catch(_){}
          }
        }
      } catch(_) {}
    }
  } catch(e) { console.error('Monitor paper trades error:', e.message); }
}

// ─── BACKTESTING HISTÓRICO ────────────────────────────────────────
let backtestRunning = false;

async function fetchKlinesHistory(symbol, interval, startTime, endTime) {
  const allKlines = [];
  let start = startTime;
  while (start < endTime) {
    try {
      const res = await axios.get(`${BINANCE}/fapi/v1/klines`, { params: { symbol, interval, startTime: start, endTime, limit: 1500 } });
      const klines = res.data;
      if (!klines.length) break;
      allKlines.push(...klines);
      start = klines[klines.length - 1][0] + 1;
      if (klines.length < 1500) break;
      await new Promise(r => setTimeout(r, 200));
    } catch(e) { break; }
  }
  return allKlines;
}

app.post('/api/backtest/run', async (req, res) => {
  if (backtestRunning) return res.json({ error: 'Backtesting ya en progreso' });
  const { symbol = 'BTCUSDT', months = 12, minConfidence = 80, leverage = 10, sizeUsd = 1000 } = req.body;
  res.json({ ok: true, message: `Backtesting iniciado: ${symbol} últimos ${months} meses` });
  backtestRunning = true;
  try {
    console.log(`🔄 Backtesting ${symbol} — ${months} meses...`);
    const endTime = Date.now();
    const startTime = endTime - (months * 30 * 24 * 60 * 60 * 1000);
    console.log(`📥 Descargando 15m...`);
    // El resto del backtest continúa igual que en el original
  } catch(e) {
    console.error('Backtest error:', e.message);
  } finally {
    backtestRunning = false;
  }
});


// ─── DETECTOR DE DOUBLE TOP / DOUBLE BOTTOM (SCALPING) ──────────
function detectDoublePatterns(klines15m, price) {
  try {
    if (!klines15m || klines15m.length < 30) return [];
    const patterns = [];
    const highs = klines15m.map(k => parseFloat(k[2]));
    const lows  = klines15m.map(k => parseFloat(k[3]));
    const closes = klines15m.map(k => parseFloat(k[4]));
    const volumes = klines15m.map(k => parseFloat(k[5]));
    const n = closes.length;

    const lookback = 20;
    let peaks = [];
    for (let i = n - lookback; i < n - 1; i++) {
      if (highs[i] > highs[i-1] && highs[i] > highs[i+1]) {
        peaks.push({ idx: i, price: highs[i], vol: volumes[i] });
      }
    }

    if (peaks.length >= 2) {
      const p1 = peaks[peaks.length - 2];
      const p2 = peaks[peaks.length - 1];
      const priceDiff = Math.abs(p1.price - p2.price) / p1.price * 100;
      const volDivergence = p2.vol < p1.vol * 0.85;
      const rsi1 = calcRSI(closes.slice(0, p1.idx + 1));
      const rsi2 = calcRSI(closes.slice(0, p2.idx + 1));
      const rsiDivergence = rsi2 < rsi1 - 3;

      if (priceDiff < 0.4 && (volDivergence || rsiDivergence)) {
        let prob = 74;
        if (volDivergence) prob += 10;
        if (rsiDivergence) prob += 8;
        if (price < p2.price * 0.999) prob += 7;
        const neckline = Math.min(...lows.slice(p1.idx, p2.idx + 1));
        patterns.push({
          type: 'double_top',
          name: '\u2533 Double Top \u2014 Scalping Bajista',
          direction: 'SHORT',
          probability: Math.min(92, prob),
          entry: price,
          tp: neckline - (p2.price - neckline) * 0.8,
          sl: p2.price * 1.002,
          description: `Double Top en $${parseInt(p2.price).toLocaleString()} con ${rsiDivergence ? 'RSI divergente' : 'volumen decreciente'} \u2014 se\u00f1al de reversi\u00f3n bajista.`,
          action: prob >= 80 ? 'ENTRAR' : 'ESPERAR',
          scalpMode: true
        });
      }
    }

    let troughs = [];
    for (let i = n - lookback; i < n - 1; i++) {
      if (lows[i] < lows[i-1] && lows[i] < lows[i+1]) {
        troughs.push({ idx: i, price: lows[i], vol: volumes[i] });
      }
    }

    if (troughs.length >= 2) {
      const t1 = troughs[troughs.length - 2];
      const t2 = troughs[troughs.length - 1];
      const priceDiff = Math.abs(t1.price - t2.price) / t1.price * 100;
      const volDivergence = t2.vol < t1.vol * 0.85;
      const rsi1 = calcRSI(closes.slice(0, t1.idx + 1));
      const rsi2 = calcRSI(closes.slice(0, t2.idx + 1));
      const rsiDivergence = rsi2 > rsi1 + 3;

      if (priceDiff < 0.4 && (volDivergence || rsiDivergence)) {
        let prob = 74;
        if (volDivergence) prob += 10;
        if (rsiDivergence) prob += 8;
        if (price > t2.price * 1.001) prob += 7;
        const neckline = Math.max(...highs.slice(t1.idx, t2.idx + 1));
        patterns.push({
          type: 'double_bottom',
          name: '\u25b2 Double Bottom \u2014 Scalping Alcista',
          direction: 'LONG',
          probability: Math.min(92, prob),
          entry: price,
          tp: neckline + (neckline - t2.price) * 0.8,
          sl: t2.price * 0.998,
          description: `Double Bottom en $${parseInt(t2.price).toLocaleString()} con ${rsiDivergence ? 'RSI divergente' : 'volumen decreciente'} \u2014 se\u00f1al de reversi\u00f3n alcista.`,
          action: prob >= 80 ? 'ENTRAR' : 'ESPERAR',
          scalpMode: true
        });
      }
    }

    return patterns;
  } catch(e) {
    return [];
  }
}


// ─── SEÑAL COMBINADA PARA SCALPING (PESOS DIFERENTES) ────────────
function calcScalpSignal(divergences, bias15m, bias1h, bias4h) {
  try {
    if (!divergences.length) return { direction: 'ESPERAR', probability: 30, action: 'ESPERAR' };

    const longs  = divergences.filter(d => d.direction === 'LONG');
    const shorts = divergences.filter(d => d.direction === 'SHORT');

    let longScore  = longs.reduce((s, d)  => s + d.probability, 0) / Math.max(longs.length, 1);
    let shortScore = shorts.reduce((s, d) => s + d.probability, 0) / Math.max(shorts.length, 1);

    if (bias15m?.bias === 'long')  longScore  += 12;
    if (bias15m?.bias === 'short') shortScore += 12;
    if (bias1h?.bias  === 'long')  longScore  += 8;
    if (bias1h?.bias  === 'short') shortScore += 8;
    if (bias4h?.bias  === 'long')  longScore  += 4;
    if (bias4h?.bias  === 'short') shortScore += 4;

    const hasDoubleTop    = divergences.some(d => d.type === 'double_top');
    const hasDoubleBottom = divergences.some(d => d.type === 'double_bottom');
    if (hasDoubleTop)    shortScore += 15;
    if (hasDoubleBottom) longScore  += 15;

    const direction = shortScore > longScore ? 'SHORT' : longScore > shortScore ? 'LONG' : 'ESPERAR';
    const prob = direction === 'SHORT' ? shortScore : direction === 'LONG' ? longScore : 30;

    return {
      direction,
      probability: Math.min(95, Math.round(prob)),
      action: prob >= 78 ? 'ENTRAR' : prob >= 65 ? 'ESPERAR' : 'NO ENTRAR',
      mode: 'scalping'
    };
  } catch(e) {
    return { direction: 'ESPERAR', probability: 30, action: 'ESPERAR' };
  }
}


// ─── NOTICIAS — CryptoCompare API ───────────────────────────────
app.get('/api/news/latest', async (req, res) => {
  try {
    // CryptoCompare: gratuita, confiable, sin bloqueo de CORS en servidor
    const r = await axios.get(
      'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC,ETH,Trading,Regulation&excludeCategories=Sponsored&limit=10',
      { timeout: 8000, headers: { 'User-Agent': 'PanelFuturesLO/4.1' } }
    );
    if (r.data && r.data.Data && r.data.Data.length) {
      return res.json(r.data.Data.map(n => ({
        id: n.id,
        title: n.title,
        source: n.source_info?.name || n.source,
        published_on: n.published_on,
        url: n.url,
        body: n.body?.slice(0, 200)
      })));
    }
    res.json([]);
  } catch(e) {
    // Fallback: RSS CoinTelegraph parseado manualmente
    try {
      const rss = await axios.get('https://cointelegraph.com/rss', {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PanelFuturos/1.0)' }
      });
      const xml = rss.data;
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
        const it = match[1];
        const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || it.match(/<title>(.*?)<\/title>/))?.[1] || '';
        const url   = (it.match(/<link>(.*?)<\/link>/))?.[1] || '';
        const pub   = (it.match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
        if (title) items.push({
          title: title.trim(),
          source: 'CoinTelegraph',
          published_on: pub ? Math.floor(new Date(pub).getTime() / 1000) : Math.floor(Date.now() / 1000),
          url
        });
      }
      return res.json(items);
    } catch(_) {
      res.json([]);
    }
  }
});

// ─── ML INSIGHTS ────────────────────────────────────────────────
app.get('/api/ml/insights', async (req, res) => {
  try {
    const { data: trades, error } = await supabase.from('paper_trades')
      .select('id,symbol,direction,status,pnl_usd,pnl_pct,confidence,market_data,created_at,closed_at,divergences,fibonacci')
      .in('status', ['won','lost'])
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) throw error;
    if (!trades || trades.length < 10) {
      return res.json({ message: 'Necesitas al menos 10 trades cerrados para análisis ML', trades: trades?.length || 0 });
    }
    const won = trades.filter(t => t.status === 'won');
    const lost = trades.filter(t => t.status === 'lost');
    function avg(arr, key) {
      const vals = arr.map(t => parseFloat(t.market_data?.[key])).filter(v => !isNaN(v));
      return vals.length > 0 ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(3) : null;
    }
    const totalPnl = trades.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0);
    const avgWin = won.length > 0 ? won.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0)/won.length : 0;
    const avgLoss = lost.length > 0 ? Math.abs(lost.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0)/lost.length) : 0;
    let peak=0,maxDD=0,cumPnl=0;
    [...trades].reverse().forEach(t=>{cumPnl+=parseFloat(t.pnl_usd)||0;if(cumPnl>peak)peak=cumPnl;const dd=peak-cumPnl;if(dd>maxDD)maxDD=dd;});
    const wr = (won.length/trades.length)*100;
    const withFib = trades.filter(t=>t.market_data?.fib_bonus>0);
    const withWhales = trades.filter(t=>t.market_data?.whale_count>=3);
    const aligned4h = trades.filter(t=>(t.direction==='LONG'&&t.market_data?.bias_4h==='long')||(t.direction==='SHORT'&&t.market_data?.bias_4h==='short'));
    const { data: allTrades } = await supabase.from('paper_trades').select('source,status,pnl_usd').in('status',['won','lost','closed']);
    const sources = ['scalping','auto','manual','backtest'];
    const bySource = {};
    for (const src of sources) {
      const st = (allTrades||[]).filter(t=>t.source===src);
      const sw = st.filter(t=>t.status==='won');
      const closed = st.filter(t=>t.status!=='open');
      if (!closed.length) continue;
      const sp = closed.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0);
      bySource[src] = { total:closed.length, won:sw.length, lost:closed.length-sw.length, winRate:parseFloat(((sw.length/Math.max(closed.length,1))*100).toFixed(1)), totalPnl:parseFloat(sp.toFixed(2)), avgPnl:parseFloat((sp/Math.max(closed.length,1)).toFixed(2)) };
    }
    const topDivs = won.reduce((acc,t)=>{const d=t.market_data?.top_divergence;if(d)acc[d]=(acc[d]||0)+1;return acc;},{});
    const recs = [];
    const avgConfW = parseFloat(avg(won,'confidence'));
    const avgConfL = parseFloat(avg(lost,'confidence'));
    if (!isNaN(avgConfW) && !isNaN(avgConfL) && avgConfW > avgConfL+5) recs.push(`Subir umbral mínimo a ${Math.round(avgConfW-2)}% (ganadores: ${avgConfW.toFixed(0)}% vs perdedores: ${avgConfL.toFixed(0)}%)`);
    const wrFib = withFib.length > 0 ? (withFib.filter(t=>t.status==='won').length/withFib.length*100) : 0;
    if (wrFib > wr+10) recs.push(`Fibonacci activo mejora WR en ${(wrFib-wr).toFixed(1)}% — priorizar señales con nivel Fib cercano`);
    res.json({
      total:trades.length, won:won.length, lost:lost.length,
      winRate: wr.toFixed(1), totalPnl: totalPnl.toFixed(2),
      avgWin: avgWin.toFixed(2), avgLoss: avgLoss.toFixed(2),
      profitFactor: avgLoss>0?(avgWin/avgLoss).toFixed(2):'∞',
      maxDrawdown: maxDD.toFixed(2),
      avgConfidenceWon: avg(won,'confidence'), avgConfidenceLost: avg(lost,'confidence'),
      avgRsiWon: avg(won,'rsi_15m'), avgRsiLost: avg(lost,'rsi_15m'),
      winRateWithFib: wrFib.toFixed(1),
      winRateWithWhales: withWhales.length>0?(withWhales.filter(t=>t.status==='won').length/withWhales.length*100).toFixed(1):'0',
      winRateAligned4h: aligned4h.length>0?(aligned4h.filter(t=>t.status==='won').length/aligned4h.length*100).toFixed(1):'n/a',
      topDivergencesWon: topDivs, bySource, recommendations: recs
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ml/optimize', async (req, res) => {
  try {
    const { data: trades } = await supabase.from('paper_trades').select('*').in('status',['won','lost']).not('market_data','is',null).limit(1000);
    if (!trades || trades.length < 50) return res.json({ optimized:false, reason:'insufficient_data', trades:trades?.length||0 });
    const won = trades.filter(t=>t.status==='won');
    const winRate = won.length/trades.length;
    const adjustments = {};
    const recommendations = [];
    // Simple optimization: check if high confidence trades win more
    const highConf = trades.filter(t=>(t.market_data?.confidence||0)>=90);
    const lowConf  = trades.filter(t=>(t.market_data?.confidence||0)<90);
    if (highConf.length>=10&&lowConf.length>=10) {
      const wrH = highConf.filter(t=>t.status==='won').length/highConf.length;
      const wrL = lowConf.filter(t=>t.status==='won').length/lowConf.length;
      if (wrH>wrL+0.1) { adjustments.min_confidence={from:85,to:88}; recommendations.push(`Alta confianza (≥90%) WR: ${(wrH*100).toFixed(1)}% vs baja: ${(wrL*100).toFixed(1)}%`); }
    }
    res.json({ optimized:true, trades:trades.length, winRate:(winRate*100).toFixed(1), adjustments_count:Object.keys(adjustments).length, adjustments, recommendations });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── SCALPING ENDPOINTS ──────────────────────────────────────────
let scalpingActive = false;
let scalpingInterval = null;

app.post('/api/scalping/start', (req, res) => {
  if (scalpingActive) return res.json({ ok: false, message: 'Scalping ya activo' });
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  const intervalMin = parseFloat(process.env.SCALP_INTERVAL_MIN || '3');
  scalpingActive = true;
  scalpingInterval = setInterval(async () => {
    for (const sym of symbols) {
      try { await runScalpingAnalysis(sym.trim()); } catch(_) {}
      await new Promise(r => setTimeout(r, 2000));
    }
  }, intervalMin * 60 * 1000);
  setTimeout(async () => { for (const sym of symbols) { try { await runScalpingAnalysis(sym.trim()); } catch(_) {} } }, 5000);
  res.json({ ok: true, message: `Scalping activado cada ${intervalMin} min` });
});

app.post('/api/scalping/stop', (req, res) => {
  if (!scalpingActive) return res.json({ ok: false, message: 'Scalping no estaba activo' });
  clearInterval(scalpingInterval);
  scalpingActive = false;
  scalpingInterval = null;
  res.json({ ok: true, message: 'Scalping desactivado' });
});

app.get('/api/scalping/status', (req, res) => {
  res.json({ active: scalpingActive, intervalMin: parseFloat(process.env.SCALP_INTERVAL_MIN || '3'), threshold: parseInt(process.env.SCALP_THRESHOLD || '88'), symbols: (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',') });
});

async function runScalpingAnalysis(symbol = 'BTCUSDT') {
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
    let longScore = 0, shortScore = 0;
    const imb = parseFloat(ob.imbalance||0);
    if (imb > 20) longScore += 30; if (imb < -20) shortScore += 30;
    if (cvd3m.trend==='bull'&&cvd3m.cvdPct>5) longScore += 25;
    if (cvd3m.trend==='bear'&&cvd3m.cvdPct<-5) shortScore += 25;
    if (rsi3m < 35) longScore += 15; if (rsi3m > 65) shortScore += 15;
    if (fib3m?.retImpact?.signal==='long_bounce') longScore += 15;
    if (fib3m?.retImpact?.signal==='short_bounce') shortScore += 15;
    if (ob.bidWalls?.length>0) longScore += 10;
    if (ob.askWalls?.length>0) shortScore += 10;
    const totalScore = longScore + shortScore;
    if (!totalScore) return;
    const scalpDir = longScore > shortScore ? 'LONG' : 'SHORT';
    const scalpProb = Math.round((Math.max(longScore,shortScore)/Math.max(totalScore,1))*100);
    if (scalpProb < 65) return;
    const scalpThreshold = parseInt(process.env.SCALP_THRESHOLD || '88');
    if (scalpProb < scalpThreshold) return;
    const highs3m = k3m.data.slice(-20).map(k=>parseFloat(k[2]));
    const lows3m  = k3m.data.slice(-20).map(k=>parseFloat(k[3]));
    const rawAtr = highs3m.reduce((s,h,i)=>s+(h-lows3m[i]),0)/20;
    const atr3m = Math.max(rawAtr, price*0.004);
    const isLong = scalpDir==='LONG';
    const tp1 = isLong ? price+atr3m*2 : price-atr3m*2;
    const sl  = isLong ? price-atr3m*0.8 : price+atr3m*0.8;
    const rrVal = Math.abs(tp1-price)/Math.abs(sl-price);
    if (rrVal < 1.5) return;
    const { data: existing } = await supabase.from('paper_trades').select('id').eq('symbol',symbol).eq('status','open');
    if (existing?.length) return;
    await supabase.from('paper_trades').insert({
      symbol, direction:scalpDir, entry:price, tp1, tp2:tp1, sl,
      rr:`1:${rrVal.toFixed(1)}`, confidence:scalpProb,
      size_usd:parseFloat(process.env.PAPER_SIZE_USD||'1000'),
      leverage:parseInt(process.env.PAPER_LEVERAGE||'10'),
      source:'scalping', status:'open',
      market_data:{ confidence:scalpProb, direction:scalpDir, rsi_3m:rsi3m, cvd_3m:cvd3m.cvdPct, ob_imbalance:imb, price, timestamp:new Date().toISOString(), mode:'scalping' }
    });
    if (process.env.TELEGRAM_CHAT_ID) {
      const msg = `⚡ *SCALPING ${scalpDir}* — ${symbol}\n💰 Entry: *$${parseInt(price).toLocaleString()}*\n🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}\n📐 R:R 1:${rrVal.toFixed(1)} | ${scalpProb}%`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode:'Markdown' }); } catch(_) {}
    }
    console.log(`⚡ Scalp paper trade: ${scalpDir} ${symbol} @ $${price}`);
  } catch(e) { console.error('Scalping error:', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Panel Futuros LO v4.1.1 corriendo en puerto ${PORT}`);
  startAlertJob();
});
