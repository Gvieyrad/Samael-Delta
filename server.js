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

app.get('/', (req, res) => res.json({ status: 'Panel Futuros LO activo', version: '4.1.0' }));

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
  const oiDeltaNum=parseFloat(oiTrend.deltaPct);

  let score=50;
  if(priceVsPrev>0.3) score+=12; else if(priceVsPrev<-0.3) score-=12;
  if(hhCount>=3) score+=10; if(llCount>=3) score-=10;
  if(rsi>70) score-=25; else if(rsi>60) score+=8; else if(rsi<30) score+=25; else if(rsi<40) score-=8;
  // ML: CVD es el mejor discriminador — más peso cuando es extremo
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

  // Detectar swing high y swing low recientes (ventana de 5 velas)
  let swingHigh = -Infinity, swingLow = Infinity;
  let swingHighIdx = 0, swingLowIdx = 0;

  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] &&
        highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      if (highs[i] > swingHigh) { swingHigh = highs[i]; swingHighIdx = i; }
    }
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] &&
        lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      if (lows[i] < swingLow) { swingLow = lows[i]; swingLowIdx = i; }
    }
  }

  if (swingHigh === -Infinity || swingLow === Infinity) return null;

  const range = swingHigh - swingLow;
  if (range <= 0) return null;

  // Determinar dirección del swing: ¿el high vino antes o después del low?
  const isUptrend = swingLowIdx < swingHighIdx; // low primero = tendencia alcista

  // Niveles de retroceso de Fibonacci
  const retLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  // Niveles de extensión
  const extLevels = [1.272, 1.414, 1.618, 2.0, 2.618];

  const retracements = retLevels.map(r => ({
    level: r,
    price: isUptrend ? swingHigh - range * r : swingLow + range * r,
    label: r === 0 ? '0%' : r === 1 ? '100%' : `${(r*100).toFixed(1)}%`,
    isKey: [0.382, 0.5, 0.618].includes(r)
  }));

  const extensions = extLevels.map(r => ({
    level: r,
    price: isUptrend ? swingHigh + range * (r - 1) : swingLow - range * (r - 1),
    label: `${(r*100).toFixed(1)}%`,
    isKey: [1.618, 2.618].includes(r)
  }));

  // Detectar en qué nivel de Fibonacci está el precio actual
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

  // Calcular impacto en probabilidad
  // Precio tocando nivel clave de Fibonacci = señal más fuerte
  function fibImpact(nearest, isRetracement) {
    if (!nearest) return { bonus: 0, penalty: 0, signal: 'none' };
    const isKey = nearest.isKey;
    const isVeryClose = nearest.dist < 0.3; // dentro del 0.3%
    const isClose = nearest.dist < 0.8;     // dentro del 0.8%

    if (!isClose) return { bonus: 0, penalty: 0, signal: 'none', description: '' };

    // En retrocesos: precio en 0.618 o 0.382 = rebote probable
    if (isRetracement && isKey) {
      return {
        bonus: isVeryClose ? 15 : 8,
        penalty: 0,
        signal: isUptrend ? 'long_bounce' : 'short_bounce',
        description: `Precio en retroceso Fib ${nearest.label} — zona de rebote clave`
      };
    }
    // En extensiones: precio alcanzando 1.618 = agotamiento probable
    if (!isRetracement && isKey) {
      return {
        bonus: 0,
        penalty: isVeryClose ? 12 : 6,
        signal: isUptrend ? 'short_exhaustion' : 'long_exhaustion',
        description: `Precio en extensión Fib ${nearest.label} — zona de agotamiento`
      };
    }
    return { bonus: isVeryClose ? 5 : 3, penalty: 0, signal: 'weak', description: `Nivel Fib ${nearest.label} cercano` };
  }

  const retImpact = fibImpact(nearestRetrace, true);
  const extImpact = fibImpact(nearestExt, false);

  return {
    swingHigh: parseFloat(swingHigh.toFixed(1)),
    swingLow: parseFloat(swingLow.toFixed(1)),
    isUptrend,
    range: parseFloat(range.toFixed(1)),
    retracements: retracements.map(r => ({ ...r, price: parseFloat(r.price.toFixed(1)) })),
    extensions: extensions.map(r => ({ ...r, price: parseFloat(r.price.toFixed(1)) })),
    nearestRetrace: nearestRetrace ? { ...nearestRetrace, price: parseFloat(nearestRetrace.price.toFixed(1)) } : null,
    nearestExt: nearestExt ? { ...nearestExt, price: parseFloat(nearestExt.price.toFixed(1)) } : null,
    retImpact,
    extImpact,
    totalBonus: retImpact.bonus + extImpact.bonus,
    totalPenalty: retImpact.penalty + extImpact.penalty
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

  // 1. Absorción de Compras (SHORT) — ML: más victorias del sistema
  if(priceUp&&cvdRising&&cvdAgressive){
    let prob=73; // ML: subido de 68 a 73
    if(hasAskWall) prob+=12; if(oiFalling) prob+=8; if(lastRSI>65) prob+=7; if(lastRSI>75) prob+=8;
    if(bearishContext) prob+=8; if(aboveVwap) prob+=5; if(volClimaxUp) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'absorcion_compras', name:'Absorción de Compras', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`CVD +${cvd.cvdPct}% agresivo con muro vendedor — precio se agotará.${bearishContext?' 4H/1D bajista.':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',hasAskWall&&'Muro ask',oiFalling&&'OI cayendo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }

  // 2. Absorción de Ventas (LONG) — ML: segunda divergencia con más victorias
  if(priceDown&&cvdFalling&&cvdAgressive){
    let prob=73; // ML: subido de 68 a 73
    if(hasBidWall) prob+=12; if(lastRSI<35) prob+=10; if(lastRSI<25) prob+=8;
    if(bullishContext) prob+=8; if(belowVwap) prob+=5; if(oiFalling) prob+=5; if(volClimaxDown) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'absorcion_ventas', name:'Absorción de Ventas', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Ballena comprando con límites — CVD ${cvd.cvdPct}% mientras precio baja.${bullishContext?' 4H/1D alcista.':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',oiFalling&&'OI cayendo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }

  // 3. Divergencia RSI Bajista — ML: 41 victorias
  if(lastHigh>prevHigh&&lastRSI<prevRSI-3){
    let prob=64; // ML: ajustado
    if(cvdFalling) prob+=15; if(oiRising&&priceUp) prob+=5; if(lastRSI>60) prob+=7; if(lastRSI>70) prob+=8;
    if(bearishContext) prob+=8; if(hasAskWall) prob+=8;
    if(prevHigh>prevHigh2&&prevRSI<prevRSI8-2) prob+=10; // triple
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'rsi_bajista', name:'Div. RSI Bajista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`Precio HH ($${parseInt(lastHigh).toLocaleString()}) pero RSI LH (${lastRSI} vs ${prevRSI}) — momentum agotado.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[cvdFalling&&'CVD divergente',bearishContext&&'Contexto bajista',hasAskWall&&'Muro ask'].filter(Boolean) });
  }

  // 4. Divergencia RSI Alcista — ML: 23 victorias
  if(lastLow<prevLow&&lastRSI>prevRSI+3){
    let prob=64; // ML: ajustado
    if(cvdRising) prob+=15; if(lastRSI<40) prob+=7; if(lastRSI<30) prob+=8;
    if(bullishContext) prob+=8; if(hasBidWall) prob+=8;
    if(prevLow<prevLow2&&prevRSI>prevRSI8+2) prob+=10; // triple
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'rsi_alcista', name:'Div. RSI Alcista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Precio LL ($${parseInt(lastLow).toLocaleString()}) pero RSI HL (${lastRSI} vs ${prevRSI}) — vendedores agotados.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista',hasBidWall&&'Muro bid'].filter(Boolean) });
  }

  // 5. Divergencia CVD/Precio Bajista
  if(priceUp&&cvdFalling){
    let prob=65;
    if(oiRising) prob+=8; if(lastRSI>60) prob+=8; if(cvdAgressive) prob+=7; if(bearishContext) prob+=8; if(aboveVwap) prob+=5;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'cvd_precio_bajista', name:'Div. CVD/Precio Bajista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`Precio sube pero CVD ${cvd.cvdPct}% negativo — subida sin respaldo real de volumen.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }

  // 6. Divergencia CVD/Precio Alcista
  if(priceDown&&cvdRising){
    let prob=65;
    if(lastRSI<40) prob+=10; if(cvdAgressive) prob+=7; if(bullishContext) prob+=8; if(belowVwap) prob+=5; if(oiFalling) prob+=5;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'cvd_precio_alcista', name:'Div. CVD/Precio Alcista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Precio baja pero CVD +${cvd.cvdPct}% — demanda oculta absorbiendo la caída.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'Shorts cerrando',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }

  // 7. Bull Trap
  if(priceUp&&oiFalling&&cvdFalling){
    let prob=72; if(lastRSI>65) prob+=8; if(bearishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'bull_trap', name:'Trampa Alcista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:'Subida con OI cayendo y CVD negativo — shorts liquidados sin demanda real. Fakeout.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'OI cayendo',cvdFalling&&'CVD divergente',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }

  // 8. Bear Trap
  if(priceDown&&oiFalling&&cvdRising){
    let prob=72; if(lastRSI<35) prob+=8; if(bullishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'bear_trap', name:'Trampa Bajista', direction:'LONG', probability:Math.min(95,prob), entry:price, description:'Caída con OI cayendo y CVD positivo — longs liquidados sin oferta real. Fakeout bajista.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiFalling&&'OI cayendo',cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }

  // 9. Short Buildup
  if(oiRising&&priceDown10&&cvdFalling){
    let prob=70; if(lastRSI<50) prob+=8; if(bearishContext) prob+=10; if(cvdAgressive) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'short_buildup', name:'Short Buildup', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:'OI sube mientras precio cae — nuevas posiciones cortas con convicción. Tendencia bajista real.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',cvdFalling&&'CVD negativo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }

  // 10. Long Buildup
  if(oiRising&&priceUp10&&cvdRising){
    let prob=70; if(lastRSI>50&&lastRSI<70) prob+=8; if(bullishContext) prob+=10; if(cvdAgressive) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'long_buildup', name:'Long Buildup', direction:'LONG', probability:Math.min(95,prob), entry:price, description:'OI sube mientras precio sube — nuevas posiciones largas con convicción. Tendencia alcista real.', action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[oiRising&&'OI subiendo',cvdRising&&'CVD positivo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }

  // 11. Funding Extremo
  if(Math.abs(fundingRate)>0.0008){
    const isBull=fundingRate>0; let prob=68;
    if(Math.abs(fundingRate)>0.002) prob+=12; else if(Math.abs(fundingRate)>0.001) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,isBull?'down':'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'funding_extremo', name:'Funding Extremo', direction:isBull?'SHORT':'LONG', probability:Math.min(90,prob), entry:price, description:`FR ${(fundingRate*100).toFixed(4)}% — ${isBull?'longs sobrecalentados, corrección inminente':'shorts en riesgo, squeeze probable'}`, action:prob>=75?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:[`FR ${(fundingRate*100).toFixed(4)}%`] });
  }

  // 12. Volumen Clímax
  if(cvd.isClimax){
    const dir=cvd.delta5>0?'SHORT':'LONG'; let prob=73;
    const nearLiq=getNearestLiqMagnet(price,dir==='SHORT'?'down':'up'); if(nearLiq) prob+=nearLiq.bonus;
    if(dir==='SHORT'&&bearishContext) prob+=8; if(dir==='LONG'&&bullishContext) prob+=8;
    divergences.push({ type:'volumen_climax', name:'Volumen Clímax', direction:dir, probability:Math.min(92,prob), entry:price, description:`Vol ${dir==='SHORT'?'comprador':'vendedor'} extremo (2.5x avg) — agotamiento inminente. Clímax = reversión.`, action:prob>=80?'ENTRAR':'ESPERAR', liqTarget:nearLiq?.price, confluence:['Vol 2.5x avg'] });
  }

  // 13. Long Squeeze
  if(oiRising&&fundingRate<-0.0005&&priceDown){
    let prob=72; if(cvdFalling) prob+=8; if(bearishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'long_squeeze', name:'Squeeze de Longs', direction:'SHORT', probability:Math.min(90,prob), entry:price, description:'OI alto + funding negativo + precio cae — longs siendo liquidados en cascada.', action:prob>=78?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:['OI alto','Funding negativo','Precio cayendo'] });
  }

  // 14. Short Squeeze
  if(oiRising&&fundingRate>0.002&&priceUp){
    let prob=72; if(cvdRising) prob+=8; if(bullishContext) prob+=8;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'short_squeeze', name:'Squeeze de Shorts', direction:'LONG', probability:Math.min(90,prob), entry:price, description:'OI alto + funding muy positivo + precio sube — shorts siendo liquidados. Momentum alcista.', action:prob>=78?'ESPERAR CONFIRMACIÓN':'MONITOREAR', liqTarget:nearLiq?.price, confluence:['OI alto','Funding extremo','Precio subiendo'] });
  }

  // Aplicar impacto de Fibonacci a todas las divergencias
  if (fib) {
    divergences.forEach(d => {
      const isLong = d.direction === 'LONG';
      const isShort = d.direction === 'SHORT';
      // Retroceso en zona clave: suma si la dirección coincide con el rebote esperado
      if (fib.retImpact.signal === 'long_bounce' && isLong) d.probability = Math.min(95, d.probability + fib.retImpact.bonus);
      if (fib.retImpact.signal === 'short_bounce' && isShort) d.probability = Math.min(95, d.probability + fib.retImpact.bonus);
      // Extensión en zona clave: suma a reversión, penaliza continuación
      if (fib.extImpact.signal === 'short_exhaustion' && isShort) d.probability = Math.min(95, d.probability + 10);
      if (fib.extImpact.signal === 'long_exhaustion' && isLong) d.probability = Math.min(95, d.probability + 10);
      if (fib.extImpact.signal === 'short_exhaustion' && isLong) d.probability = Math.max(5, d.probability - fib.extImpact.penalty);
      if (fib.extImpact.signal === 'long_exhaustion' && isShort) d.probability = Math.max(5, d.probability - fib.extImpact.penalty);
    });
  }

  // ── 15. DETECTOR DE CAMBIO DE RÉGIMEN ────────────────────────
  // El patrón más importante: mercado caía → señales de reversión acumulándose
  // Detecta cuando el sistema debe CAMBIAR de SHORT a LONG o viceversa

  // REVERSIÓN ALCISTA: precio cayendo pero múltiples señales de agotamiento bajista
  const priceDownRegime = closes.length >= 6 ? lastClose < closes[closes.length - 6] : false;

  // Condiciones de agotamiento bajista (al menos 3 de 5)
  const bearExhaustion = [
    lastRSI < 35,                          // RSI sobreventa
    cvdRising && priceDownRegime,               // CVD positivo mientras baja = absorción
    oiFalling && priceDownRegime,               // OI cae mientras baja = shorts cerrando
    fundingRate < -0.0005,                 // Funding negativo = shorts sobrecalentados
    lastVol > avgVol * 2 && priceDownRegime,    // Volumen climax bajista
  ].filter(Boolean).length;

  if (bearExhaustion >= 3) {
    let prob = 65 + (bearExhaustion * 6); // 65-95 según cuántas condiciones
    if (bullishContext) prob = Math.min(95, prob + 10);
    if (hasBidWall) prob = Math.min(95, prob + 8);
    const nearLiq = getNearestLiqMagnet(price, 'up');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({
      type: 'regime_change_long',
      name: 'Cambio de Régimen — LONG',
      direction: 'LONG',
      probability: Math.min(95, prob),
      entry: price,
      description: `${bearExhaustion}/5 señales de agotamiento bajista activas — mercado cambia de dirección. ${bearExhaustion >= 4 ? 'Señal MUY FUERTE.' : 'Confirmar con vela alcista.'}`,
      action: prob >= 82 ? 'ENTRAR' : prob >= 68 ? 'ESPERAR' : 'NO ENTRAR',
      liqTarget: nearLiq?.price,
      confluence: [
        lastRSI < 35 && 'RSI sobreventa',
        cvdRising && priceDownRegime && 'CVD divergente alcista',
        oiFalling && priceDownRegime && 'OI cayendo (shorts cierran)',
        fundingRate < -0.0005 && 'Funding negativo extremo',
        lastVol > avgVol * 2 && priceDownRegime && 'Volumen clímax bajista',
      ].filter(Boolean)
    });
  }

  // REVERSIÓN BAJISTA: precio subiendo pero múltiples señales de agotamiento alcista
  const priceUpRegime = closes.length >= 6 ? lastClose > closes[closes.length - 6] : false;

  const bullExhaustion = [
    lastRSI > 68,                          // RSI sobrecompra
    cvdFalling && priceUpRegime,                // CVD negativo mientras sube = distribución
    oiFalling && priceUpRegime,                 // OI cae mientras sube = longs cerrando
    fundingRate > 0.001,                   // Funding positivo = longs sobrecalentados
    lastVol > avgVol * 2 && priceUpRegime,      // Volumen clímax alcista
  ].filter(Boolean).length;

  if (bullExhaustion >= 3) {
    let prob = 65 + (bullExhaustion * 6);
    if (bearishContext) prob = Math.min(95, prob + 10);
    if (hasAskWall) prob = Math.min(95, prob + 8);
    const nearLiq = getNearestLiqMagnet(price, 'down');
    if (nearLiq) prob += nearLiq.bonus;
    divergences.push({
      type: 'regime_change_short',
      name: 'Cambio de Régimen — SHORT',
      direction: 'SHORT',
      probability: Math.min(95, prob),
      entry: price,
      description: `${bullExhaustion}/5 señales de agotamiento alcista activas — mercado cambia de dirección. ${bullExhaustion >= 4 ? 'Señal MUY FUERTE.' : 'Confirmar con vela bajista.'}`,
      action: prob >= 82 ? 'ENTRAR' : prob >= 68 ? 'ESPERAR' : 'NO ENTRAR',
      liqTarget: nearLiq?.price,
      confluence: [
        lastRSI > 68 && 'RSI sobrecompra',
        cvdFalling && priceUpRegime && 'CVD divergente bajista',
        oiFalling && priceUpRegime && 'OI cayendo (longs cierran)',
        fundingRate > 0.001 && 'Funding positivo extremo',
        lastVol > avgVol * 2 && priceUpRegime && 'Volumen clímax alcista',
      ].filter(Boolean)
    });
  }

  // Aplicar impacto de Fibonacci a todas las divergencias
  if (fib) {
    divergences.forEach(d => {
      const isLong = d.direction === 'LONG';
      const isShort = d.direction === 'SHORT';
      if (fib.retImpact.signal === 'long_bounce' && isLong) d.probability = Math.min(95, d.probability + fib.retImpact.bonus);
      if (fib.retImpact.signal === 'short_bounce' && isShort) d.probability = Math.min(95, d.probability + fib.retImpact.bonus);
      if (fib.extImpact.signal === 'short_exhaustion' && isShort) d.probability = Math.min(95, d.probability + 10);
      if (fib.extImpact.signal === 'long_exhaustion' && isLong) d.probability = Math.min(95, d.probability + 10);
      if (fib.extImpact.signal === 'short_exhaustion' && isLong) d.probability = Math.max(5, d.probability - fib.extImpact.penalty);
      if (fib.extImpact.signal === 'long_exhaustion' && isShort) d.probability = Math.max(5, d.probability - fib.extImpact.penalty);
    });
  }

  return divergences.sort((a,b)=>b.probability-a.probability);
  } catch(e) {
    console.error('detectDivergences error:', e.message);
    return [];
  }
}

function calcCombinedSignal(divergences, bias4h, bias1d, whaleData=null, deepOB=null, fib=null) {
  // Bonus ML: si hay 2+ divergencias de absorción = señal muy fuerte
  const absorcionCount = divergences.filter(d =>
    d.type === 'absorcion_compras' || d.type === 'absorcion_ventas'
  ).length;
  if(!divergences.length) return { direction:'ESPERAR', probability:30, action:'ESPERAR', reason:'Sin divergencias activas' };
  const shorts=divergences.filter(d=>d.direction==='SHORT');
  const longs=divergences.filter(d=>d.direction==='LONG');
  const shortScore=shorts.reduce((s,d)=>s+d.probability,0)/(shorts.length||1);
  const longScore=longs.reduce((s,d)=>s+d.probability,0)/(longs.length||1);
  let direction=shorts.length>longs.length?'SHORT':longs.length>shorts.length?'LONG':'ESPERAR';
  let prob=direction==='SHORT'?shortScore:direction==='LONG'?longScore:30;

  // ── BLOQUEO DE SEÑAL CONTRARIA AL RÉGIMEN ──────────────────
  // Si hay señal de cambio de régimen, bloquear la dirección contraria
  const regimeLong  = divergences.find(d => d.type === 'regime_change_long');
  const regimeShort = divergences.find(d => d.type === 'regime_change_short');

  if (regimeLong && direction === 'SHORT') {
    // Mercado está cambiando a LONG — penalizar fuertemente señales SHORT
    prob = Math.max(5, prob - 30);
    if (regimeLong.probability >= 80) prob = 5; // bloqueo total si es fuerte
  }
  if (regimeShort && direction === 'LONG') {
    // Mercado está cambiando a SHORT — penalizar fuertemente señales LONG
    prob = Math.max(5, prob - 30);
    if (regimeShort.probability >= 80) prob = 5; // bloqueo total si es fuerte
  }

  // Bonus por contexto multi-TF — MEJORADO con datos ML
  // Ambos 4H y 1D alineados = bonus mayor
  const both4hAnd1dLong  = bias4h?.bias==='long'  && bias1d?.bias==='long';
  const both4hAnd1dShort = bias4h?.bias==='short' && bias1d?.bias==='short';
  const only4hLong  = bias4h?.bias==='long'  && bias1d?.bias!=='short';
  const only4hShort = bias4h?.bias==='short' && bias1d?.bias!=='long';

  if(direction==='LONG'){
    if(both4hAnd1dLong)  prob=Math.min(95,prob+15); // ambos alineados = +15%
    else if(only4hLong)  prob=Math.min(95,prob+8);  // solo 4H = +8%
    if(bias1d?.bias==='short') prob=Math.max(5,prob-10); // 1D en contra = penalizar
  }
  if(direction==='SHORT'){
    if(both4hAnd1dShort)  prob=Math.min(95,prob+15);
    else if(only4hShort)  prob=Math.min(95,prob+8);
    if(bias1d?.bias==='long')  prob=Math.max(5,prob-10);
  }

  // Bonus por ballenas: si las ballenas confirman la dirección
  if(whaleData && whaleData.whaleCount >= 3) {
    if(direction==='LONG' && whaleData.whaleBias==='bull') prob=Math.min(95,prob+10);
    if(direction==='SHORT' && whaleData.whaleBias==='bear') prob=Math.min(95,prob+10);
    if(direction==='LONG' && whaleData.whaleBias==='bear') prob=Math.max(5,prob-8);
    if(direction==='SHORT' && whaleData.whaleBias==='bull') prob=Math.max(5,prob-8);
  }

  // Bonus por libro profundo
  if(deepOB) {
    const deepImb = deepOB.deepImbalance || 0;
    if(direction==='LONG' && deepImb > 20) prob=Math.min(95,prob+6);
    if(direction==='SHORT' && deepImb < -20) prob=Math.min(95,prob+6);
  }

  // Fibonacci: rebote en nivel clave suma a la señal
  if (fib) {
    if (direction === 'LONG' && fib.retImpact.signal === 'long_bounce') prob = Math.min(95, prob + fib.totalBonus);
    if (direction === 'SHORT' && fib.retImpact.signal === 'short_bounce') prob = Math.min(95, prob + fib.totalBonus);
    if (direction === 'SHORT' && fib.extImpact.signal === 'short_exhaustion') prob = Math.min(95, prob + 10);
    if (direction === 'LONG' && fib.extImpact.signal === 'long_exhaustion') prob = Math.min(95, prob + 10);
    prob = Math.max(5, prob - fib.totalPenalty);
  }

  // Bonus absorción doble (ML: las más ganadoras)
  if (absorcionCount >= 2) prob = Math.min(95, prob + 8);

  // Bonus ML: CVD como discriminador clave
  // BTC ganadores: CVD muy positivo en LONGs
  // ETH/SOL ganadores: CVD muy negativo en SHORTs
  const cvdPct = divergences[0] ? 0 : 0; // placeholder — el CVD real viene del mercado
  // Usamos el bias cvdPct del 15m si está disponible en las divergencias
  const topDiv = divergences[0];
  if (topDiv) {
    // Si la divergencia principal es de absorción y hay múltiples confirmaciones
    if (absorcionCount >= 1 && divergences.length >= 3) {
      prob = Math.min(95, prob + 5); // bonus por confluencia alta
    }
  }

  // Acción especial para cambio de régimen
  const isRegimeChange = (regimeLong && direction==='LONG') || (regimeShort && direction==='SHORT');
  const action = isRegimeChange && prob >= 75
    ? '⚠️ CAMBIO DE RÉGIMEN — ENTRAR'
    : prob>=82?'ENTRAR':prob>=68?'ESPERAR CONFIRMACIÓN':'NO ENTRAR';
  const fibSummary = fib?.nearestRetrace?.dist < 0.8 ? `Fib ${fib.nearestRetrace.label} cerca` : fib?.nearestExt?.dist < 0.8 ? `Ext Fib ${fib.nearestExt.label} cerca` : null;
  const whaleSummary = whaleData?.whaleCount > 0 ? `${whaleData.whaleCount} ballenas — ${whaleData.dominance}` : null;
  return { direction, probability:Math.round(prob), action, shortCount:shorts.length, longCount:longs.length, whaleSummary, fibSummary };
}


// ─── LIQUIDACIONES REALES (allForceOrders) ───────────────────────
async function fetchForceOrders(symbol) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/allForceOrders?symbol=${symbol}&limit=200`);
    const orders = res.data || [];
    // Agrupar por rango de precio ($50 buckets para BTC)
    const bucketSize = symbol.includes('BTC') ? 100 : symbol.includes('ETH') ? 10 : 1;
    const buckets = {};
    let totalLongs = 0, totalShorts = 0;
    orders.forEach(o => {
      const price = parseFloat(o.averagePrice || o.price);
      const qty = parseFloat(o.executedQty || o.origQty);
      const usdVal = price * qty;
      const bucket = Math.round(price / bucketSize) * bucketSize;
      if (!buckets[bucket]) buckets[bucket] = { price: bucket, longLiq: 0, shortLiq: 0, total: 0 };
      // SELL = liquidación de LONG (long fue liquidado), BUY = liquidación de SHORT
      if (o.side === 'SELL') { buckets[bucket].longLiq += usdVal; totalLongs += usdVal; }
      else { buckets[bucket].shortLiq += usdVal; totalShorts += usdVal; }
      buckets[bucket].total += usdVal;
    });
    const zones = Object.values(buckets)
      .filter(b => b.total > 10000)
      .sort((a, b) => b.total - a.total)
      .slice(0, 20)
      .map(b => ({
        price: b.price,
        longLiq: Math.round(b.longLiq / 1000),   // en $K
        shortLiq: Math.round(b.shortLiq / 1000),
        total: Math.round(b.total / 1000),
        dominant: b.longLiq > b.shortLiq ? 'longs' : 'shorts'
      }));
    return { zones, totalLongs: Math.round(totalLongs/1000), totalShorts: Math.round(totalShorts/1000), count: orders.length };
  } catch(e) {
    return { zones: [], totalLongs: 0, totalShorts: 0, count: 0 };
  }
}

// ─── LIBRO PROFUNDO — CLUSTERS DE ÓRDENES PASIVAS ────────────────
async function fetchDeepOrderBook(symbol) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=500`);
    const bids = res.data.bids || [], asks = res.data.asks || [];
    const bucketSize = symbol.includes('BTC') ? 50 : symbol.includes('ETH') ? 5 : 0.5;

    function clusterSide(orders, side) {
      const buckets = {};
      orders.forEach(([priceStr, qtyStr]) => {
        const price = parseFloat(priceStr), qty = parseFloat(qtyStr);
        const bucket = Math.round(price / bucketSize) * bucketSize;
        buckets[bucket] = (buckets[bucket] || 0) + qty;
      });
      // Calcular media y std para detectar clusters significativos
      const vals = Object.values(buckets);
      const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
      const std = Math.sqrt(vals.reduce((s,v)=>s+Math.pow(v-mean,2),0)/vals.length);
      const threshold = mean + std * 1.2; // 1.2 sigma = más sensible
      return Object.entries(buckets)
        .filter(([, qty]) => qty > threshold)
        .map(([price, qty]) => ({
          price: parseFloat(price),
          qty: parseFloat(qty.toFixed(2)),
          usdVal: Math.round(parseFloat(price) * qty),
          side,
          strength: qty / mean, // cuántas veces el promedio
          breakProb: side === 'ask'
            ? Math.round(Math.min(85, Math.max(15, 100 - (qty/mean)*15)))
            : Math.round(Math.min(85, Math.max(15, 100 - (qty/mean)*15)))
        }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 8);
    }

    const bidClusters = clusterSide(bids, 'bid');
    const askClusters = clusterSide(asks, 'ask');

    // Total de liquidez en libro profundo
    const totalBidLiq = bids.reduce((s,[,q])=>s+parseFloat(q),0);
    const totalAskLiq = asks.reduce((s,[,q])=>s+parseFloat(q),0);
    const deepImbalance = ((totalBidLiq - totalAskLiq) / (totalBidLiq + totalAskLiq) * 100).toFixed(1);

    return { bidClusters, askClusters, deepImbalance: parseFloat(deepImbalance), totalBidLiq: totalBidLiq.toFixed(1), totalAskLiq: totalAskLiq.toFixed(1) };
  } catch(e) {
    return { bidClusters: [], askClusters: [], deepImbalance: 0 };
  }
}

// ─── DETECCIÓN DE BALLENAS (aggTrades) ───────────────────────────
async function detectWhales(symbol, price) {
  try {
    const res = await axios.get(`${BINANCE}/fapi/v1/aggTrades?symbol=${symbol}&limit=500`);
    const trades = res.data || [];
    const whaleThreshold = symbol.includes('BTC') ? 500000 : symbol.includes('ETH') ? 100000 : 50000; // USD

    const whales = [];
    let whaleBuyVol = 0, whaleSellVol = 0;
    let totalBuyVol = 0, totalSellVol = 0;

    trades.forEach(t => {
      const tradePrice = parseFloat(t.p);
      const qty = parseFloat(t.q);
      const usdVal = tradePrice * qty;
      const isBuy = !t.m; // m=true significa market maker = sell side agressor
      if (isBuy) totalBuyVol += usdVal; else totalSellVol += usdVal;
      if (usdVal >= whaleThreshold) {
        whales.push({
          price: tradePrice,
          qty: qty.toFixed(3),
          usdVal: Math.round(usdVal),
          side: isBuy ? 'buy' : 'sell',
          time: t.T,
          isAggressive: true // aggTrades son siempre agresivas (market orders)
        });
        if (isBuy) whaleBuyVol += usdVal; else whaleSellVol += usdVal;
      }
    });

    // CVD de ballenas
    const whaleCVD = whaleBuyVol - whaleSellVol;
    const whaleBias = whaleCVD > 0 ? 'bull' : whaleCVD < 0 ? 'bear' : 'neutral';
    const whaleCount = whales.length;
    const lastWhale = whales[whales.length - 1] || null;

    // Ratio de absorción: ballenas vs volumen total
    const whaleRatio = (whaleBuyVol + whaleSellVol) / (totalBuyVol + totalSellVol + 1) * 100;

    return {
      whales: whales.slice(-10), // últimas 10
      whaleBuyVol: Math.round(whaleBuyVol / 1000),
      whaleSellVol: Math.round(whaleSellVol / 1000),
      whaleCVD: Math.round(whaleCVD / 1000),
      whaleBias,
      whaleCount,
      whaleRatio: parseFloat(whaleRatio.toFixed(1)),
      lastWhale,
      dominance: whaleBuyVol > whaleSellVol * 1.5 ? 'buyers' : whaleSellVol > whaleBuyVol * 1.5 ? 'sellers' : 'balanced'
    };
  } catch(e) {
    return { whales: [], whaleBuyVol: 0, whaleSellVol: 0, whaleCVD: 0, whaleBias: 'neutral', whaleCount: 0 };
  }
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
      fetchOIHistory(symbol,'15m',10),
      fetchOIHistory(symbol,'1h',10),
      fetchOIHistory(symbol,'4h',10),
    ]);

    const price_temp = parseFloat(ticker.data.lastPrice);
    const [liqData, deepOB, whaleData] = await Promise.all([
      fetchForceOrders(symbol),
      fetchDeepOrderBook(symbol),
      detectWhales(symbol, price_temp),
    ]);

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

    // Enriquecer divergencias con datos de ballenas y liquidaciones reales
    // El bias de ballenas suma/resta a la señal combinada

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
    const combinedSignal=calcCombinedSignal(divergences,bias4h,bias1d,whaleData,deepOB,fib15m);

    const vols=k15m.data.slice(-5).map(k=>parseFloat(k[5]));
    const avgVol5=vols.slice(0,-1).reduce((a,b)=>a+b,0)/4;
    const lastVol=vols[vols.length-1];
    const volDeltaPct=avgVol5>0?((lastVol-avgVol5)/avgVol5*100).toFixed(1):'0.0';

    res.json({
      price, change24h:parseFloat(ticker.data.priceChangePercent),
      volume24h:parseFloat(ticker.data.quoteVolume),
      openInterest:parseFloat(oiRes.data.openInterest),
      fundingRate, markPrice:parseFloat(funding.data.markPrice),
      indexPrice:parseFloat(funding.data.indexPrice),
      rsi15m, rsiOverbought:rsi15m>70, rsiOversold:rsi15m<30,
      cvd15m, vrvp, bb15m, vwap15m:vwap15m.toFixed(1),
      oiTrends:{ tf15m:oiTrend15m, tf1h:oiTrend1h, tf4h:oiTrend4h },
      volDeltaPct:parseFloat(volDeltaPct),
      orderBook:ob, liqMagnets, divergences, combinedSignal,
      bias:{ tf15m:bias15m, tf1h:bias1h, tf4h:bias4h, tf1d:bias1d },
      klines:k15m.data.slice(-20),
      liqData, deepOB, whaleData,
      fibonacci:{ tf15m:fib15m, tf4h:fib4h }
    });
  } catch(e) {
    console.error('Market error:',e.message);
    res.status(500).json({ error:e.message });
  }
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
    const clean=text.replace(/```json|```/g,'').trim();
    const signal=JSON.parse(clean);

    analyzeCache[symbol]={ ts:now, data:signal };

    try { await supabase.from('signals').insert({ symbol, direction:signal.direction, confidence:signal.confidence, entry:signal.entry, tp1:signal.tp1, tp2:signal.tp2, sl:signal.sl, rr:signal.rr, reasoning:signal.reasoning, market_data:d }); } catch(_){}

    if(signal.confidence>=75&&process.env.TELEGRAM_CHAT_ID){
      const e=signal.direction==='LONG'?'▲':signal.direction==='SHORT'?'▼':'◆';
      const msg=`${e} ${signal.direction} — ${symbol}\n💰 Entry: $${signal.entry}\n🎯 TP1: $${signal.tp1} | TP2: $${signal.tp2}\n🛑 SL: $${signal.sl} | ${signal.rr}\n📊 ${signal.confidence}% — ${signal.action}\n💬 ${signal.reasoning}`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID,msg); } catch(_){}
    }

    res.json(signal);
  } catch(e) {
    console.error('Analyze error:',e.message);
    res.status(500).json({ error:e.message, detail:e.message.includes('api')||e.message.includes('key')?'Verifica ANTHROPIC_API_KEY en Railway Variables':'Error procesando análisis' });
  }
});

app.post('/api/trades', async (req, res) => {
  try { const {data,error}=await supabase.from('trades').insert(req.body); if(error) throw error; res.json({success:true,data}); } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/trades', async (req, res) => {
  try { const {data,error}=await supabase.from('trades').select('*').order('created_at',{ascending:false}).limit(50); if(error) throw error; res.json(data); } catch(e){ res.status(500).json({error:e.message}); }
});


// ─── ALERTAS TELEGRAM AUTOMÁTICAS ────────────────────────────────
let alertCache = {}; // evitar alertas duplicadas por señal

// ─── SISTEMA DE CONFIRMACIÓN TEMPORAL ────────────────────────────
// Una señal debe mantenerse en 2 análisis consecutivos (30min)
// antes de considerarse válida para alertas y paper trading
const signalHistory = {}; // { 'BTCUSDT': [{direction, prob, timestamp}] }

function confirmSignal(symbol, direction, probability) {
  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  const now = Date.now();
  const history = signalHistory[symbol];

  // Agregar señal actual
  history.push({ direction, probability, timestamp: now });

  // Mantener solo las últimas 3 señales de los últimos 45 minutos
  signalHistory[symbol] = history.filter(s => now - s.timestamp < 45 * 60 * 1000).slice(-3);

  const recent = signalHistory[symbol];

  // Necesitamos al menos 2 señales en la misma dirección en los últimos 30 min
  const sameDirection = recent.filter(s =>
    s.direction === direction &&
    now - s.timestamp < 30 * 60 * 1000
  );

  // Primera señal: guardar pero no confirmar aún
  if (sameDirection.length < 2) {
    console.log(`⏳ Señal ${direction} ${symbol} ${probability}% — esperando confirmación (${sameDirection.length}/2)`);
    return { confirmed: false, count: sameDirection.length };
  }
  // Si la probabilidad es muy alta (>=92%), confirmar en el primer análisis
  if (probability >= 92 && sameDirection.length >= 1) {
    console.log(`✅ Señal ${direction} ${symbol} ${probability}% — confirmada inmediatamente (prob muy alta)`);
    return { confirmed: true, count: sameDirection.length, avgProbability: probability };
  }

  // 2+ señales en la misma dirección = confirmada
  const avgProb = Math.round(sameDirection.reduce((s,r) => s + r.probability, 0) / sameDirection.length);
  console.log(`✅ Señal ${direction} ${symbol} CONFIRMADA — ${sameDirection.length} análisis consecutivos, prob promedio ${avgProb}%`);
  return { confirmed: true, count: sameDirection.length, avgProbability: avgProb };
}

function clearSignalHistory(symbol) {
  signalHistory[symbol] = [];
}

async function runAutoAnalysis(symbol = 'BTCUSDT') {
  try {
    // 1. Obtener datos de mercado
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
      fetchOIHistory(symbol,'15m',10),
      fetchOIHistory(symbol,'1h',10),
      fetchOIHistory(symbol,'4h',10),
    ]);

    const [liqData, deepOB, whaleData] = await Promise.all([
      fetchForceOrders(symbol),
      fetchDeepOrderBook(symbol),
      detectWhales(symbol, price_temp),
    ]);

    const price = parseFloat(ticker.data.lastPrice);
    const fundingRate = parseFloat(funding.data.lastFundingRate);

    // Validar que los datos llegaron correctamente
    if (!k15m.data || !Array.isArray(k15m.data) || k15m.data.length < 20) {
      console.log(`⚠️ Auto-analysis: datos insuficientes para ${symbol}`);
      return;
    }

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

    // 2. Verificar si hay señal fuerte
    const minConfidence = parseInt(process.env.ALERT_MIN_CONFIDENCE || '80');
    const minDivergences = parseInt(process.env.ALERT_MIN_DIVERGENCES || '2');

    if (combinedSignal.direction === 'ESPERAR') {
      clearSignalHistory(symbol); // Reset cuando no hay señal clara
      return;
    }
    if (combinedSignal.probability < minConfidence) return;
    if (divergences.length < minDivergences) return;

    // 3. Confirmación temporal: la señal debe mantenerse en 2 análisis consecutivos
    const confirmation = confirmSignal(symbol, combinedSignal.direction, combinedSignal.probability);
    if (!confirmation.confirmed) return; // Esperar segunda confirmación

    // Evitar spam: no repetir la misma señal confirmada en 30 minutos
    const cacheKey = `${symbol}_${combinedSignal.direction}_${Math.floor(price / 100)}`;
    const now = Date.now();
    if (alertCache[cacheKey] && now - alertCache[cacheKey] < 30 * 60 * 1000) return;
    alertCache[cacheKey] = now;

    // 4. Llamar a Claude para análisis completo
    const marketData = {
      price, change24h: parseFloat(ticker.data.priceChangePercent),
      fundingRate, openInterest: parseFloat(oiRes.data.openInterest),
      rsi15m: calcRSI(closes15m), cvd15m, vrvp,
      volDeltaPct: 0, orderBook: ob,
      liqMagnets: calcLiqMagnets(price).slice(0,5),
      divergences: divergences.slice(0,4),
      combinedSignal,
      bias: { tf15m: bias15m, tf1h: bias1h, tf4h: bias4h, tf1d: bias1d }
    };

    const divSummary = divergences.slice(0,3).map(d =>
      `${d.name}: ${d.direction} ${d.probability}% — ${d.description}`
    ).join('\n');

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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text;
    const signal = JSON.parse(text.replace(/```json|```/g, '').trim());

    if (signal.confidence < minConfidence) return;

    // 5. Enviar alerta a Telegram
    if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) return;

    const dir = signal.direction;
    const emoji = dir === 'LONG' ? '🟢' : dir === 'SHORT' ? '🔴' : '🟡';
    const fibNote = fib15m?.nearestRetrace?.dist < 0.8
      ? `\n⬟ Fib ${fib15m.nearestRetrace.label} — ${fib15m.retImpact.description}`
      : '';
    const whaleNote = whaleData?.whaleCount >= 3
      ? `\n🐋 Ballenas: ${whaleData.dominance} (${whaleData.whaleCount} trades)`
      : '';

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

    // 6. Guardar señal en Supabase
    try {
      await supabase.from('signals').insert({
        symbol, direction: signal.direction, confidence: signal.confidence,
        entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2,
        sl: signal.sl, rr: signal.rr, reasoning: signal.reasoning,
        market_data: marketData, source: 'auto_alert'
      });
    } catch(_) {}

    // 7. AUTO PAPER TRADING — si confianza >= umbral, abrir trade simulado
    const autoPaperThreshold = parseInt(process.env.AUTO_PAPER_THRESHOLD || '85');
    // Filtro de tendencia macro: no ir contra el 1D
    const trend1d = bias1d.bias;
    const trendOk = signal.direction === 'ESPERAR' ? false :
      signal.direction === 'LONG'  ? (trend1d !== 'short') :
      signal.direction === 'SHORT' ? (trend1d !== 'long')  : true;

    // Filtro Fibonacci: bonus si hay nivel activo cercano
    const fibActive = fib15m?.nearestRetrace?.dist < 0.8 || fib15m?.nearestExt?.dist < 0.8;
    // Filtro 4H + 1D: requiere al menos 4H alineado
    const tfAligned = signal.direction === 'LONG'  ? bias4h.bias === 'long'  :
                      signal.direction === 'SHORT' ? bias4h.bias === 'short' : false;

    // Condiciones finales para auto paper trade:
    // 1. Confianza >= umbral
    // 2. No contra tendencia 1D
    // 3. Mínimo 2 divergencias activas
    // (4H alineado da bonus en la probabilidad pero no es requisito obligatorio)
    const canAutoTrade = signal.confidence >= autoPaperThreshold
      && signal.direction !== 'ESPERAR'
      && trendOk
      && divergences.length >= 2;

    if (canAutoTrade) {
      try {
        // Verificar que no hay ya un trade abierto del mismo par y dirección
        const { data: existing } = await supabase.from('paper_trades')
          .select('id').eq('symbol', symbol).eq('status', 'open').eq('direction', signal.direction);

        if (!existing || existing.length === 0) {
          // Capturar snapshot completo de indicadores para ML futuro
          const mlSnapshot = {
            // Señal
            confidence: signal.confidence,
            direction: signal.direction,
            trend_aligned: trendOk,
            trend_1d: trend1d,
            // Indicadores principales
            rsi_15m: marketData.rsi15m,
            cvd_pct: cvd15m.cvdPct,
            cvd_trend: cvd15m.trend,
            funding_rate: fundingRate,
            oi_trend_15m: oiTrend15m.trend,
            oi_delta_15m: oiTrend15m.deltaPct,
            // Bias por TF
            bias_15m: bias15m.bias, bias_15m_score: bias15m.score,
            bias_1h: bias1h.bias, bias_1h_score: bias1h.score,
            bias_4h: bias4h.bias, bias_4h_score: bias4h.score,
            bias_1d: bias1d.bias, bias_1d_score: bias1d.score,
            // Divergencias
            divergence_count: divergences.length,
            top_divergence: divergences[0]?.type,
            top_divergence_prob: divergences[0]?.probability,
            short_count: combinedSignal.shortCount,
            long_count: combinedSignal.longCount,
            // Fibonacci
            fib_level: fib15m?.nearestRetrace?.label,
            fib_dist: fib15m?.nearestRetrace?.dist,
            fib_signal: fib15m?.retImpact?.signal,
            fib_bonus: fib15m?.retImpact?.bonus,
            // Ballenas
            whale_count: whaleData?.whaleCount,
            whale_bias: whaleData?.whaleBias,
            whale_dominance: whaleData?.dominance,
            whale_ratio: whaleData?.whaleRatio,
            // Libro profundo
            deep_imbalance: deepOB?.deepImbalance,
            bid_clusters: deepOB?.bidClusters?.length,
            ask_clusters: deepOB?.askClusters?.length,
            // VRVP
            price_vs_poc: ((marketData.price - vrvp.poc) / vrvp.poc * 100).toFixed(3),
            price_vs_vah: ((marketData.price - vrvp.vah) / vrvp.vah * 100).toFixed(3),
            price_vs_val: ((marketData.price - vrvp.val) / vrvp.val * 100).toFixed(3),
            // Precio y contexto
            price: marketData.price,
            timestamp: new Date().toISOString()
          };

          const { data: newTrade } = await supabase.from('paper_trades').insert({
            symbol,
            direction: signal.direction,
            entry: signal.entry,
            tp1: signal.tp1,
            tp2: signal.tp2,
            sl: signal.sl,
            rr: signal.rr,
            confidence: signal.confidence,
            size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'),
            leverage: parseInt(process.env.PAPER_LEVERAGE || '10'),
            divergences: divergences.slice(0,5),
            fibonacci: fib15m,
            source: 'auto',
            status: 'open',
            // Snapshot ML completo
            market_data: mlSnapshot
          }).select().single();

          console.log(`🤖 Auto paper trade: ${signal.direction} ${symbol} @ $${signal.entry} (${signal.confidence}%) R:R ${rrNum.toFixed(2)}`);

          // Notificar por Telegram que se abrió un trade automático
          if (process.env.TELEGRAM_CHAT_ID) {
            const tradeEmoji = signal.direction === 'LONG' ? '▲' : '▼';
            const autoMsg = `🤖 *Auto Paper Trade abierto*
${tradeEmoji} ${signal.direction} ${symbol}
💰 Entry: $${signal.entry?.toLocaleString()}
🎯 TP: $${signal.tp1?.toLocaleString()} | 🛑 SL: $${signal.sl?.toLocaleString()}
📊 ${signal.confidence}% confianza
📐 ${signal.rr} R:R`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, autoMsg, { parse_mode: 'Markdown' }); } catch(_) {}
          }
        } else {
          console.log(`⏭ Auto paper trade omitido: ya hay ${existing.length} trade(s) ${signal.direction} abierto(s) para ${symbol}`);
        }
      } catch(paperErr) {
        console.error('Auto paper trade error:', paperErr.message);
      }
    }

  } catch(e) {
    console.error('Auto-analysis error:', e.message, e.stack?.split('\n')[1]);
  }
}

// ─── JOB PERIÓDICO ───────────────────────────────────────────────
function startAlertJob() {
  if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) {
    console.log('⚠️ Alertas Telegram desactivadas — faltan TELEGRAM_CHAT_ID y TELEGRAM_TOKEN');
  // Igual monitorear paper trades aunque no haya Telegram
  setInterval(monitorPaperTrades, 5 * 60 * 1000);
  setTimeout(monitorPaperTrades, 15000);
  return;
  }
  const intervalMin = parseInt(process.env.ALERT_INTERVAL_MIN || '15');
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  console.log(`✅ Alertas activas — cada ${intervalMin} min para: ${symbols.join(', ')}`);
  // Monitor de paper trades cada 5 minutos
  setInterval(monitorPaperTrades, 5 * 60 * 1000);
  setTimeout(monitorPaperTrades, 15000); // primer chequeo a los 15s

  setInterval(async () => {
    for (const symbol of symbols) {
      await runAutoAnalysis(symbol.trim());
      await new Promise(r => setTimeout(r, 3000)); // 3s entre símbolos
    }
  }, intervalMin * 60 * 1000);

  // Correr inmediatamente al arrancar
  setTimeout(async () => {
    for (const symbol of symbols) {
      await runAutoAnalysis(symbol.trim());
      await new Promise(r => setTimeout(r, 3000));
    }
  }, 10000); // 10 segundos después de arrancar
}

// Endpoint precios de todos los pares
app.get('/api/prices', async (req, res) => {
  try {
    const [btc, eth, sol, xau] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=BTCUSDT`),
      axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=ETHUSDT`),
      axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=SOLUSDT`),
      axios.get(`${BINANCE}/fapi/v1/ticker/price?symbol=XAUUSDT`).catch(() => ({ data: { price: '0' } })),
    ]);
    res.json({
      BTCUSDT: parseFloat(btc.data.price),
      ETHUSDT: parseFloat(eth.data.price),
      SOLUSDT: parseFloat(sol.data.price),
      XAUUSDT: parseFloat(xau.data.price),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint manual para disparar análisis ahora
app.post('/api/alert/trigger', async (req, res) => {
  const symbol = req.body.symbol || 'BTCUSDT';
  await runAutoAnalysis(symbol);
  res.json({ ok: true, message: `Análisis disparado para ${symbol}` });
});

app.get('/api/alert/status', (req, res) => {
  res.json({
    active: !!(process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN),
    intervalMin: parseInt(process.env.ALERT_INTERVAL_MIN || '15'),
    symbols: (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(','),
    minConfidence: parseInt(process.env.ALERT_MIN_CONFIDENCE || '80'),
  });
});


// ─── PAPER TRADING ───────────────────────────────────────────────

// Abrir trade simulado
app.post('/api/paper/open', async (req, res) => {
  try {
    const { symbol, direction, entry, tp1, tp2, sl, rr, confidence,
            size_usd, leverage, divergences, fibonacci, source } = req.body;
    const { data, error } = await supabase.from('paper_trades').insert({
      symbol, direction, entry, tp1, tp2, sl, rr, confidence,
      size_usd: size_usd || 1000,
      leverage: leverage || 10,
      divergences, fibonacci,
      source: source || 'manual',
      status: 'open'
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, trade: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Cerrar trade simulado
app.post('/api/paper/close/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { close_price, close_reason } = req.body;

    // Obtener el trade
    const { data: trade, error: fetchErr } = await supabase
      .from('paper_trades').select('*').eq('id', id).single();
    if (fetchErr) throw fetchErr;

    const entry = parseFloat(trade.entry);
    const closeP = parseFloat(close_price);
    const size = parseFloat(trade.size_usd);
    const lev = parseFloat(trade.leverage);

    // Calcular PnL
    const priceDiff = trade.direction === 'LONG'
      ? (closeP - entry) / entry
      : (entry - closeP) / entry;
    const pnl_pct = parseFloat((priceDiff * 100 * lev).toFixed(2));
    const pnl_usd = parseFloat((size * priceDiff * lev).toFixed(2));

    const { data, error } = await supabase.from('paper_trades').update({
      status: close_reason === 'tp1' || close_reason === 'tp2' ? 'won'
            : close_reason === 'sl' ? 'lost' : 'closed',
      close_price: closeP,
      close_reason,
      pnl_usd,
      pnl_pct,
      closed_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ ok: true, trade: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Obtener trades abiertos
app.get('/api/paper/open', async (req, res) => {
  try {
    const { data, error } = await supabase.from('paper_trades')
      .select('*').eq('status', 'open')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Historial y estadísticas
app.get('/api/paper/stats', async (req, res) => {
  try {
    const { data, error } = await supabase.from('paper_trades')
      .select('*')
      .in('status', ['won', 'lost'])  // solo trades reales, no cancelados
      .order('created_at', { ascending: false }).limit(100);
    if (error) throw error;

    const total = data.length;
    const won = data.filter(t => t.status === 'won').length;
    const lost = data.filter(t => t.status === 'lost').length;
    const winRate = total > 0 ? ((won / total) * 100).toFixed(1) : 0;
    const totalPnl = data.reduce((s, t) => s + (parseFloat(t.pnl_usd) || 0), 0);
    const avgWin = won > 0
      ? data.filter(t=>t.status==='won').reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0) / won
      : 0;
    const avgLoss = lost > 0
      ? Math.abs(data.filter(t=>t.status==='lost').reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0) / lost)
      : 0;
    const profitFactor = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '∞';

    // Max drawdown
    let peak = 0, maxDD = 0, cumPnl = 0;
    data.slice().reverse().forEach(t => {
      cumPnl += parseFloat(t.pnl_usd) || 0;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    });

    res.json({
      total, won, lost,
      winRate: parseFloat(winRate),
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      profitFactor,
      maxDrawdown: parseFloat(maxDD.toFixed(2)),
      recentTrades: data.slice(0, 20)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Monitor automático: cierra trades que llegaron a TP o SL
async function monitorPaperTrades() {
  try {
    const { data: openTrades } = await supabase.from('paper_trades')
      .select('*').eq('status', 'open');
    if (!openTrades?.length) return;

    for (const trade of openTrades) {
      try {
        const priceRes = await axios.get(
          `${BINANCE}/fapi/v1/ticker/price?symbol=${trade.symbol}`
        );
        const currentPrice = parseFloat(priceRes.data.price);
        const entryPrice = parseFloat(trade.entry);
        
        // Validar que el precio es coherente con el entry (máximo 50% de diferencia)
        // Esto evita que el precio de BTC se use para calcular PnL de ETH o SOL
        const priceDiffPct = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
        if (priceDiffPct > 50) {
          console.log(`⚠️ Precio incoherente para ${trade.symbol}: entry=$${entryPrice}, current=$${currentPrice} (${priceDiffPct.toFixed(1)}% diferencia) — omitiendo`);
          continue;
        }
        const tp1 = parseFloat(trade.tp1);
        const sl  = parseFloat(trade.sl);

        let closeReason = null;
        if (trade.direction === 'LONG') {
          if (currentPrice >= tp1) closeReason = 'tp1';
          else if (currentPrice <= sl) closeReason = 'sl';
        } else {
          if (currentPrice <= tp1) closeReason = 'tp1';
          else if (currentPrice >= sl) closeReason = 'sl';
        }

        if (closeReason) {
          const entry = parseFloat(trade.entry);
          const priceDiff = trade.direction === 'LONG'
            ? (currentPrice - entry) / entry
            : (entry - currentPrice) / entry;
          const pnl_pct = parseFloat((priceDiff * 100 * trade.leverage).toFixed(2));
          const pnl_usd = parseFloat((trade.size_usd * priceDiff * trade.leverage).toFixed(2));

          // Validar que el PnL no sea absurdo (max 500% del capital)
          const maxPnl = parseFloat(trade.size_usd) * 5;
          if (Math.abs(pnl_usd) > maxPnl) {
            console.log(`⚠️ PnL absurdo detectado para ${trade.symbol} ${trade.id}: $${pnl_usd} — cerrando con pnl=0`);
            await supabase.from('paper_trades').update({
              status: 'closed', close_price: currentPrice,
              close_reason: 'invalid_pnl', pnl_usd: 0, pnl_pct: 0,
              closed_at: new Date().toISOString()
            }).eq('id', trade.id);
            continue;
          }
          await supabase.from('paper_trades').update({
            status: closeReason === 'tp1' ? 'won' : 'lost',
            close_price: currentPrice,
            close_reason: closeReason,
            pnl_usd, pnl_pct,
            closed_at: new Date().toISOString()
          }).eq('id', trade.id);

          console.log(`📊 Paper trade cerrado: ${trade.direction} ${trade.symbol} → ${closeReason} PnL: $${pnl_usd}`);

          // Notificar por Telegram
          if (process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN) {
            const emoji = closeReason === 'tp1' ? '✅' : '❌';
            const msg = `${emoji} Paper Trade Cerrado\n${trade.direction} ${trade.symbol}\nEntry: $${entry.toLocaleString()} → Cierre: $${currentPrice.toLocaleString()}\nRazón: ${closeReason.toUpperCase()}\nPnL: ${pnl_usd >= 0 ? '+' : ''}$${pnl_usd} (${pnl_pct}%)`;
            try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg); } catch(_){}
          }
        }
      } catch(_) {}
    }
  } catch(e) {
    console.error('Monitor paper trades error:', e.message);
  }
}



// ─── BACKTESTING HISTÓRICO ────────────────────────────────────────
// Descarga klines históricos de Binance y simula el sistema completo
// Corre UNA sola vez via POST /api/backtest/run

let backtestRunning = false;

async function fetchKlinesHistory(symbol, interval, startTime, endTime) {
  const allKlines = [];
  let start = startTime;
  while (start < endTime) {
    try {
      const res = await axios.get(`${BINANCE}/fapi/v1/klines`, {
        params: { symbol, interval, startTime: start, endTime, limit: 1500 }
      });
      const klines = res.data;
      if (!klines.length) break;
      allKlines.push(...klines);
      start = klines[klines.length - 1][0] + 1;
      if (klines.length < 1500) break;
      await new Promise(r => setTimeout(r, 200)); // rate limit
    } catch(e) { break; }
  }
  return allKlines;
}

app.post('/api/backtest/run', async (req, res) => {
  if (backtestRunning) return res.json({ error: 'Backtesting ya en progreso' });

  const {
    symbol = 'BTCUSDT',
    months = 12,        // cuántos meses hacia atrás
    minConfidence = 80, // umbral mínimo de señal
    leverage = 10,
    sizeUsd = 1000
  } = req.body;

  // Responder inmediatamente — el proceso corre en background
  res.json({ ok: true, message: `Backtesting iniciado: ${symbol} últimos ${months} meses` });
  backtestRunning = true;

  try {
    console.log(`🔄 Backtesting ${symbol} — ${months} meses...`);

    const endTime = Date.now();
    const startTime = endTime - (months * 30 * 24 * 60 * 60 * 1000);

    // Descargar datos históricos secuencialmente para evitar rate limits
    console.log(`📥 Descargando 15m...`);
    const klines15m = await fetchKlinesHistory(symbol, '15m', startTime, endTime);
    await new Promise(r => setTimeout(r, 500));
    console.log(`📥 Descargando 1h...`);
    const klines1h = await fetchKlinesHistory(symbol, '1h', startTime, endTime);
    await new Promise(r => setTimeout(r, 500));
    console.log(`📥 Descargando 4h...`);
    const klines4h = await fetchKlinesHistory(symbol, '4h', startTime, endTime);
    await new Promise(r => setTimeout(r, 500));
    console.log(`📥 Descargando 1d...`);
    const klines1d = await fetchKlinesHistory(symbol, '1d', startTime - 30*24*60*60*1000, endTime);
    const oiHistory = [];

    console.log(`📊 Datos descargados: ${klines15m.length} velas 15m | ${klines1h.length} 1h | ${klines4h.length} 4h`);
    
    if (klines15m.length === 0) {
      console.error('❌ No se descargaron datos — verificar conexión a Binance');
      backtestRunning = false;
      return;
    }

    let tradesInserted = 0, tradesWon = 0, tradesLost = 0;
    const batchInsert = [];

    // Iterar desde la vela 100 (necesitamos historial para calcular indicadores)
    for (let i = 100; i < klines15m.length - 20; i++) {
      const slice15m = klines15m.slice(Math.max(0, i - 100), i + 1);
      const currentKline = klines15m[i];
      const price = parseFloat(currentKline[4]); // close price
      const timestamp = currentKline[0];

      // Encontrar velas correspondientes en otros TF
      const slice1h  = klines1h.filter(k => k[0] <= timestamp).slice(-60);
      const slice4h  = klines4h.filter(k => k[0] <= timestamp).slice(-50);
      const slice1d  = klines1d.filter(k => k[0] <= timestamp).slice(-30);

      if (slice1h.length < 20 || slice4h.length < 20) continue;

      // Calcular indicadores
      const cvd15m   = calcCVD(slice15m);
      const vrvp     = calcVRVP(slice15m);
      const rsi15m   = calcRSI(slice15m.map(k => parseFloat(k[4])));
      const fib15m   = calcFibonacci(slice15m, price);
      const fib4h    = calcFibonacci(slice4h, price);

      // Bias por TF (sin OI histórico — aproximación)
      const bias15m  = calcBias(slice15m, null, 0);
      const bias1h   = calcBias(slice1h, null, 0);
      const bias4h   = calcBias(slice4h, null, 0);
      const bias1d   = calcBias(slice1d, null, 0);

      // OB simulado — no disponible históricamente, usar valores neutros
      const ob = { bidWalls: [], askWalls: [], imbalance: '0', pressure: 'balanced' };

      const divergences = detectDivergences(slice15m, ob, price, 0, bias4h, bias1d, { trend: 'flat' }, fib15m);
      const combinedSignal = calcCombinedSignal(divergences, bias4h, bias1d, null, null, fib15m);

      if (combinedSignal.direction === 'ESPERAR') continue;
      if (combinedSignal.probability < minConfidence) continue;
      if (divergences.length < 3) continue; // ML: mínimo 3 divergencias
      // Filtro macro: no ir contra tendencia 1D
      if (combinedSignal.direction === 'LONG'  && bias1d.bias === 'short') continue;
      if (combinedSignal.direction === 'SHORT' && bias1d.bias === 'long')  continue;
      // Filtro 4H alineado (dato ML: mejora WR significativamente)
      if (combinedSignal.direction === 'LONG'  && bias4h.bias !== 'long')  continue;
      if (combinedSignal.direction === 'SHORT' && bias4h.bias !== 'short') continue;

      // Calcular TP y SL basados en ATR (Average True Range) para realismo
      const highs = slice15m.slice(-14).map(k => parseFloat(k[2]));
      const lows  = slice15m.slice(-14).map(k => parseFloat(k[3]));
      const atr   = highs.reduce((s,h,i) => s + (h - lows[i]), 0) / 14;

      const isLong = combinedSignal.direction === 'LONG';
      const tp1 = isLong ? price + atr * 2 : price - atr * 2;
      const sl  = isLong ? price - atr * 1  : price + atr * 1;
      const rr  = '1:2.0';

      // Simular resultado: buscar qué tocó primero en las siguientes 20 velas
      let closePrice = null, closeReason = null, closedAt = null;
      for (let j = i + 1; j < Math.min(i + 48, klines15m.length); j++) {
        const futureHigh = parseFloat(klines15m[j][2]);
        const futureLow  = parseFloat(klines15m[j][3]);
        const futureTime = klines15m[j][0];
        if (isLong) {
          if (futureLow <= sl)  { closePrice = sl;  closeReason = 'sl';  closedAt = futureTime; break; }
          if (futureHigh >= tp1){ closePrice = tp1; closeReason = 'tp1'; closedAt = futureTime; break; }
        } else {
          if (futureHigh >= sl) { closePrice = sl;  closeReason = 'sl';  closedAt = futureTime; break; }
          if (futureLow <= tp1) { closePrice = tp1; closeReason = 'tp1'; closedAt = futureTime; break; }
        }
      }

      // Si no llegó a ninguno en 48 velas (12 horas), cerrar al precio final
      if (!closePrice) {
        const lastIdx = Math.min(i + 48, klines15m.length - 1);
        closePrice = parseFloat(klines15m[lastIdx][4]);
        closeReason = 'timeout';
        closedAt = klines15m[lastIdx][0];
      }

      const priceDiff = isLong ? (closePrice - price) / price : (price - closePrice) / price;
      const pnlUsd = parseFloat((sizeUsd * priceDiff * leverage).toFixed(2));
      const pnlPct = parseFloat((priceDiff * 100 * leverage).toFixed(2));
      const status = closeReason === 'tp1' ? 'won' : closeReason === 'sl' ? 'lost' : (pnlUsd >= 0 ? 'won' : 'lost');

      if (status === 'won') tradesWon++; else tradesLost++;

      // Snapshot ML completo
      const mlSnapshot = {
        confidence: combinedSignal.probability,
        direction: combinedSignal.direction,
        rsi_15m: rsi15m,
        cvd_pct: cvd15m.cvdPct,
        cvd_trend: cvd15m.trend,
        funding_rate: 0,
        oi_trend_15m: 'flat',
        bias_15m: bias15m.bias, bias_15m_score: bias15m.score,
        bias_1h: bias1h.bias, bias_1h_score: bias1h.score,
        bias_4h: bias4h.bias, bias_4h_score: bias4h.score,
        bias_1d: bias1d.bias, bias_1d_score: bias1d.score,
        divergence_count: divergences.length,
        top_divergence: divergences[0]?.type,
        top_divergence_prob: divergences[0]?.probability,
        short_count: combinedSignal.shortCount,
        long_count: combinedSignal.longCount,
        fib_level: fib15m?.nearestRetrace?.label,
        fib_dist: fib15m?.nearestRetrace?.dist,
        fib_signal: fib15m?.retImpact?.signal,
        fib_bonus: fib15m?.retImpact?.bonus,
        whale_count: 0, whale_bias: 'neutral',
        price_vs_poc: vrvp.poc > 0 ? ((price - vrvp.poc) / vrvp.poc * 100).toFixed(3) : 0,
        price_vs_vah: vrvp.vah > 0 ? ((price - vrvp.vah) / vrvp.vah * 100).toFixed(3) : 0,
        price_vs_val: vrvp.val > 0 ? ((price - vrvp.val) / vrvp.val * 100).toFixed(3) : 0,
        price, timestamp: new Date(timestamp).toISOString(),
        atr: atr.toFixed(2)
      };

      batchInsert.push({
        symbol, direction: combinedSignal.direction,
        entry: price, tp1, tp2: tp1, sl, rr,
        confidence: combinedSignal.probability,
        size_usd: sizeUsd, leverage,
        status, close_price: closePrice,
        close_reason: closeReason,
        pnl_usd: pnlUsd, pnl_pct: pnlPct,
        created_at: new Date(timestamp).toISOString(),
        closed_at: closedAt ? new Date(closedAt).toISOString() : null,
        divergences: divergences.slice(0,3),
        fibonacci: fib15m ? { nearestRetrace: fib15m.nearestRetrace, retImpact: fib15m.retImpact } : null,
        market_data: mlSnapshot,
        source: 'backtest'
      });

      // Insertar en batches de 20 (más pequeño = más estable)
      if (batchInsert.length >= 20) {
        const batch = batchInsert.splice(0, 20);
        const { error: insertErr } = await supabase.from('paper_trades').insert(batch);
        if (insertErr) {
          console.error('Insert error:', insertErr.message);
          // Intentar de a uno si falla el batch
          for (const trade of batch) {
            try { await supabase.from('paper_trades').insert([trade]); tradesInserted++; } catch(_) {}
          }
        } else {
          tradesInserted += batch.length;
        }
        if (tradesInserted % 100 === 0) console.log(`📈 Progreso: ${tradesInserted} trades (${tradesWon}W/${tradesLost}L)`);
        await new Promise(r => setTimeout(r, 150));
      }

      // Saltar 4 velas (1 hora) para evitar trades superpuestos
      i += 4;
    }

    // Insertar resto en lotes de 20
    while (batchInsert.length > 0) {
      const batch = batchInsert.splice(0, 20);
      const { error: insertErr } = await supabase.from('paper_trades').insert(batch);
      if (!insertErr) { tradesInserted += batch.length; }
      else {
        for (const trade of batch) {
          try { await supabase.from('paper_trades').insert([trade]); tradesInserted++; } catch(_) {}
        }
      }
      await new Promise(r => setTimeout(r, 150));
    }

    const finalWinRate = tradesInserted > 0 ? ((tradesWon / (tradesWon + tradesLost)) * 100).toFixed(1) : 0;
    console.log(`✅ Backtesting completado: ${tradesInserted} trades | WR: ${finalWinRate}% | ${tradesWon}W/${tradesLost}L`);

    if (process.env.TELEGRAM_CHAT_ID) {
      try {
        await bot.sendMessage(process.env.TELEGRAM_CHAT_ID,
          `✅ *Backtesting completado*\n📊 ${symbol} — ${months} meses\n🔢 ${tradesInserted} trades históricos\n📈 Win Rate inicial: ${finalWinRate}%\n✓ ${tradesWon} ganados | ✗ ${tradesLost} perdidos`,
          { parse_mode: 'Markdown' }
        );
      } catch(_) {}
    }

  } catch(e) {
    console.error('Backtest error:', e.message);
  } finally {
    backtestRunning = false;
  }
});

app.get('/api/backtest/status', async (req, res) => {
  const { data } = await supabase.from('paper_trades')
    .select('status, source').eq('source', 'backtest');
  const total = data?.length || 0;
  const won   = data?.filter(t => t.status === 'won').length || 0;
  const lost  = data?.filter(t => t.status === 'lost').length || 0;
  res.json({
    running: backtestRunning,
    total, won, lost,
    winRate: total > 0 ? ((won/total)*100).toFixed(1) : 0
  });
});

// ─── ANÁLISIS ML — PATRONES GANADORES ────────────────────────────
app.get('/api/ml/insights', async (req, res) => {
  try {
    const { data: trades, error: tradesErr } = await supabase.from('paper_trades')
      .select('id,symbol,direction,status,pnl_usd,pnl_pct,confidence,market_data,created_at,closed_at,divergences,fibonacci')
      .in('status', ['won','lost'])  // solo trades reales, no cancelados
      .order('created_at', { ascending: false })
      .limit(2000);

    if (tradesErr) throw tradesErr;

    if (!trades || trades.length < 10) {
      return res.json({ message: `Necesitas al menos 10 trades cerrados para análisis ML`, trades: trades?.length || 0 });
    }

    const won = trades.filter(t => t.status === 'won');
    const lost = trades.filter(t => t.status === 'lost');

    // Analizar qué indicadores correlacionan con trades ganadores
    function avg(arr, key) {
      const vals = arr.map(t => parseFloat(t.market_data?.[key])).filter(v => !isNaN(v));
      return vals.length > 0 ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(3) : null;
    }
    function pct(arr, key, value) {
      const matches = arr.filter(t => t.market_data?.[key] === value).length;
      return arr.length > 0 ? ((matches/arr.length)*100).toFixed(1) : 0;
    }

    const totalPnlCalc = trades.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0);
    const avgWinCalc = won.length > 0 ? won.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0)/won.length : 0;
    const avgLossCalc = lost.length > 0 ? Math.abs(lost.reduce((s,t)=>s+(parseFloat(t.pnl_usd)||0),0)/lost.length) : 0;

    // Max drawdown
    let peak=0, maxDD=0, cumPnl=0;
    [...trades].reverse().forEach(t=>{ cumPnl+=parseFloat(t.pnl_usd)||0; if(cumPnl>peak)peak=cumPnl; const dd=peak-cumPnl; if(dd>maxDD)maxDD=dd; });

    const insights = {
      total: trades.length,
      won: won.length,
      lost: lost.length,
      winRate: ((won.length/trades.length)*100).toFixed(1),
      totalPnl: totalPnlCalc.toFixed(2),
      avgWin: avgWinCalc.toFixed(2),
      avgLoss: avgLossCalc.toFixed(2),
      profitFactor: avgLossCalc > 0 ? (avgWinCalc/avgLossCalc).toFixed(2) : '∞',
      maxDrawdown: maxDD.toFixed(2),

      // Confianza promedio ganadores vs perdedores
      avgConfidenceWon: avg(won, 'confidence'),
      avgConfidenceLost: avg(lost, 'confidence'),

      // RSI — ¿en qué rango se gana más?
      avgRsiWon: avg(won, 'rsi_15m'),
      avgRsiLost: avg(lost, 'rsi_15m'),

      // CVD — ¿agresividad correlaciona?
      avgCvdWon: avg(won, 'cvd_pct'),
      avgCvdLost: avg(lost, 'cvd_pct'),

      // Fibonacci — ¿cuándo está activo se gana más?
      winRateWithFib: won.filter(t=>t.market_data?.fib_bonus>0).length / Math.max(1, trades.filter(t=>t.market_data?.fib_bonus>0).length) * 100,

      // Ballenas — ¿cuando hay ballenas se gana más?
      winRateWithWhales: won.filter(t=>t.market_data?.whale_count>=3).length / Math.max(1, trades.filter(t=>t.market_data?.whale_count>=3).length) * 100,

      // Bias 4H alineado con dirección
      winRateAligned4h: (() => {
        const aligned = trades.filter(t =>
          (t.direction==='LONG' && t.market_data?.bias_4h==='long') ||
          (t.direction==='SHORT' && t.market_data?.bias_4h==='short')
        );
        const alignedWon = aligned.filter(t=>t.status==='won').length;
        return aligned.length > 0 ? ((alignedWon/aligned.length)*100).toFixed(1) : 'n/a';
      })(),

      // Top divergencias en trades ganadores
      topDivergencesWon: won.reduce((acc, t) => {
        const d = t.market_data?.top_divergence;
        if (d) acc[d] = (acc[d]||0) + 1;
        return acc;
      }, {}),

      // Recomendaciones automáticas
      recommendations: []
    };

    // Stats por fuente — obtener TODOS los trades cerrados de Supabase
    const { data: allTrades } = await supabase.from('paper_trades')
      .select('source, status, pnl_usd')
      .in('status', ['won','lost','closed']);

    const sources = ['scalping', 'auto', 'manual', 'backtest'];
    insights.bySource = {};
    for (const src of sources) {
      const srcTrades = (allTrades || []).filter(t => t.source === src);
      const srcWon  = srcTrades.filter(t => t.status === 'won');
      const srcLost = srcTrades.filter(t => t.status === 'lost' || t.status === 'closed');
      const closed  = srcTrades.filter(t => t.status !== 'open');
      if (closed.length === 0) continue;
      const srcPnl = closed.reduce((s,t) => s + (parseFloat(t.pnl_usd)||0), 0);
      insights.bySource[src] = {
        total: closed.length,
        won: srcWon.length,
        lost: srcLost.length,
        winRate: parseFloat(((srcWon.length / Math.max(closed.length,1)) * 100).toFixed(1)),
        totalPnl: parseFloat(srcPnl.toFixed(2)),
        avgPnl: parseFloat((srcPnl / Math.max(closed.length,1)).toFixed(2))
      };
    }

    // Generar recomendaciones basadas en los datos
    if (parseFloat(insights.avgConfidenceWon) > parseFloat(insights.avgConfidenceLost) + 5) {
      insights.recommendations.push(`Subir umbral mínimo a ${Math.round(parseFloat(insights.avgConfidenceWon)-2)}% (ganadores tienen ${insights.avgConfidenceWon}% vs ${insights.avgConfidenceLost}% perdedores)`);
    }
    if (parseFloat(insights.winRateWithFib) > parseFloat(insights.winRate) + 10) {
      insights.recommendations.push(`Fibonacci activo mejora win rate en ${(parseFloat(insights.winRateWithFib)-parseFloat(insights.winRate)).toFixed(1)}% — priorizar señales con nivel Fib cercano`);
    }
    if (parseFloat(insights.winRateAligned4h) > parseFloat(insights.winRate) + 10) {
      insights.recommendations.push(`Bias 4H alineado mejora win rate en ${(parseFloat(insights.winRateAligned4h)-parseFloat(insights.winRate)).toFixed(1)}% — requerir confirmación 4H`);
    }
    if (parseFloat(insights.winRateWithWhales) > parseFloat(insights.winRate) + 8) {
      insights.recommendations.push(`Ballenas activas mejoran resultados — agregar como requisito mínimo 3 whale trades`);
    }

    res.json(insights);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ─── MODO SCALPING — análisis cada 3 minutos ─────────────────────
let scalpingActive = false;
let scalpingInterval = null;
const scalpingHistory = {}; // historial de señales para confirmación rápida

async function runScalpingAnalysis(symbol = 'BTCUSDT') {
  try {
    const [tickerRes, k3m, k1m, obRes, fundingRes] = await Promise.all([
      axios.get(`${BINANCE}/fapi/v1/ticker/24hr?symbol=${symbol}`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=3m&limit=60`),
      axios.get(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=30`),
      axios.get(`${BINANCE}/fapi/v1/depth?symbol=${symbol}&limit=50`),
      axios.get(`${BINANCE}/fapi/v1/premiumIndex?symbol=${symbol}`),
    ]);

    const price = parseFloat(tickerRes.data.lastPrice);
    const fundingRate = parseFloat(fundingRes.data.lastFundingRate);
    const ob = analyzeOB(obRes.data.bids, obRes.data.asks);
    const cvd3m = calcCVD(k3m.data);
    const cvd1m = calcCVD(k1m.data);
    const rsi3m = calcRSI(k3m.data.map(k => parseFloat(k[4])));
    const fib3m = calcFibonacci(k3m.data, price);

    // Señal scalping — más rápida, prioriza libro y CVD inmediato
    let scalpDir = null;
    let scalpProb = 0;
    const signals = [];

    // Libro de órdenes — más confiable para scalping
    const imb = parseFloat(ob.imbalance || 0);
    if (imb > 20) { signals.push({ dir: 'LONG', w: 30, reason: `Imbalance bid +${imb}%` }); }
    if (imb < -20) { signals.push({ dir: 'SHORT', w: 30, reason: `Imbalance ask ${imb}%` }); }

    // CVD 1m — más inmediato
    if (cvd1m.trend === 'bull' && cvd1m.cvdPct > 5) signals.push({ dir: 'LONG', w: 25, reason: `CVD 1m +${cvd1m.cvdPct}%` });
    if (cvd1m.trend === 'bear' && cvd1m.cvdPct < -5) signals.push({ dir: 'SHORT', w: 25, reason: `CVD 1m ${cvd1m.cvdPct}%` });

    // CVD 3m — confirmación
    if (cvd3m.trend === 'bull') signals.push({ dir: 'LONG', w: 20, reason: 'CVD 3m alcista' });
    if (cvd3m.trend === 'bear') signals.push({ dir: 'SHORT', w: 20, reason: 'CVD 3m bajista' });

    // RSI 3m
    if (rsi3m < 35) signals.push({ dir: 'LONG', w: 15, reason: `RSI 3m ${rsi3m} (sobreventa)` });
    if (rsi3m > 65) signals.push({ dir: 'SHORT', w: 15, reason: `RSI 3m ${rsi3m} (sobrecompra)` });

    // Fibonacci 3m
    if (fib3m?.retImpact?.signal === 'long_bounce') signals.push({ dir: 'LONG', w: 15, reason: `Fib ${fib3m.nearestRetrace?.label}` });
    if (fib3m?.retImpact?.signal === 'short_bounce') signals.push({ dir: 'SHORT', w: 15, reason: `Fib ${fib3m.nearestRetrace?.label}` });

    // Muro en el libro
    if (ob.bidWalls?.length > 0) signals.push({ dir: 'LONG', w: 10, reason: 'Muro BID detectado' });
    if (ob.askWalls?.length > 0) signals.push({ dir: 'SHORT', w: 10, reason: 'Muro ASK detectado' });

    // Calcular dirección dominante
    const longScore  = signals.filter(s => s.dir === 'LONG').reduce((a, s) => a + s.w, 0);
    const shortScore = signals.filter(s => s.dir === 'SHORT').reduce((a, s) => a + s.w, 0);
    const totalScore = longScore + shortScore;

    if (totalScore === 0) return;

    scalpDir  = longScore > shortScore ? 'LONG' : 'SHORT';
    scalpProb = Math.round((Math.max(longScore, shortScore) / Math.max(totalScore, 1)) * 100);

    if (scalpProb < 65) return; // umbral mínimo scalping

    // Confirmación rápida: 2 señales en la misma dirección en 6 minutos
    if (!scalpingHistory[symbol]) scalpingHistory[symbol] = [];
    const now = Date.now();
    scalpingHistory[symbol].push({ dir: scalpDir, prob: scalpProb, ts: now });
    scalpingHistory[symbol] = scalpingHistory[symbol].filter(s => now - s.ts < 6 * 60 * 1000);

    const confirmed = scalpingHistory[symbol].filter(s => s.dir === scalpDir);
    if (confirmed.length < 2) {
      console.log(`⚡ Scalping ${scalpDir} ${symbol} ${scalpProb}% — esperando confirmación (${confirmed.length}/2)`);
      return;
    }

    // Señal confirmada — calcular TP y SL basados en ATR 3m
    const highs3m = k3m.data.slice(-20).map(k => parseFloat(k[2]));
    const lows3m  = k3m.data.slice(-20).map(k => parseFloat(k[3]));
    const rawAtr  = highs3m.reduce((s, h, i) => s + (h - lows3m[i]), 0) / 20;
    // Mínimo garantizado: 0.4% del precio para todos los activos
    const minAtr  = price * 0.004;
    const atr3m   = Math.max(rawAtr, minAtr);
    
    // Validación extra: TP y SL deben tener distancia mínima del 0.3% del precio
    const minDistance = price * 0.003;

    const isLong = scalpDir === 'LONG';
    const tp1 = isLong ? price + atr3m * 2.0 : price - atr3m * 2.0;
    const sl  = isLong ? price - atr3m * 0.8  : price + atr3m * 0.8;
    const rrVal = Math.abs(tp1 - price) / Math.abs(sl - price);
    const rr  = rrVal.toFixed(1);
    
    // Validar distancias mínimas
    if (Math.abs(tp1 - price) < minDistance || Math.abs(sl - price) < minDistance) {
      console.log(`⚠️ Scalping ${scalpDir} ${symbol} descartado — distancia TP/SL muy pequeña (ATR: ${atr3m.toFixed(2)})`);
      return;
    }
    
    // Filtro R:R mínimo 1.5 — si no es rentable no enviamos señal
    if (rrVal < 1.5) {
      console.log(`⚠️ Scalping ${scalpDir} ${symbol} descartado — R:R ${rr} < 1.5 mínimo`);
      return;
    }

    const topReasons = signals
      .filter(s => s.dir === scalpDir)
      .sort((a, b) => b.w - a.w)
      .slice(0, 3)
      .map(s => s.reason)
      .join(' · ');

    console.log(`⚡ Scalping CONFIRMADO: ${scalpDir} ${symbol} ${scalpProb}% — ${topReasons}`);

    // Notificar Telegram
    if (process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN) {
      const emoji = isLong ? '⚡🟢' : '⚡🔴';
      const msg = `${emoji} *SCALPING ${scalpDir}* — ${symbol}
━━━━━━━━━━━━━━
💰 Entry: *$${parseInt(price).toLocaleString()}*
🎯 TP: $${parseInt(tp1).toLocaleString()} | 🛑 SL: $${parseInt(sl).toLocaleString()}
📐 R:R 1:${rr}
━━━━━━━━━━━━━━
📊 ${scalpProb}% confianza | ATR: $${atr3m.toFixed(2)}
⚡ ${topReasons}
🕐 ${new Date().toLocaleTimeString('es-PE')} — ACTUAR EN 2-3 MIN`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
    }

    // Auto paper trade scalping si prob >= 80%
    const scalpThreshold = parseInt(process.env.SCALP_THRESHOLD || '80');
    if (scalpProb >= scalpThreshold) {
      try {
        const { data: existing } = await supabase.from('paper_trades')
          .select('id, direction').eq('symbol', symbol).eq('status', 'open');
        const hasConflict = existing?.some(t => t.direction !== scalpDir);
        const hasSame = existing?.some(t => t.direction === scalpDir);
        if (!hasConflict && !hasSame) {
          await supabase.from('paper_trades').insert({
            symbol, direction: scalpDir,
            entry: price, tp1, tp2: tp1, sl,
            rr: `1:${rr}`, confidence: scalpProb,
            size_usd: parseFloat(process.env.PAPER_SIZE_USD || '1000'),
            leverage: parseInt(process.env.PAPER_LEVERAGE || '10'),
            source: 'scalping', status: 'open',
            market_data: {
              confidence: scalpProb, direction: scalpDir,
              rsi_3m: rsi3m, cvd_1m: cvd1m.cvdPct, cvd_3m: cvd3m.cvdPct,
              ob_imbalance: imb, long_score: longScore, short_score: shortScore,
              price, timestamp: new Date().toISOString(), mode: 'scalping'
            }
          });
          console.log(`⚡ Auto scalp paper trade: ${scalpDir} ${symbol} @ $${price}`);
        }
      } catch(e) { console.error('Scalp paper trade error:', e.message); }
    }

    // Limpiar historial para no repetir
    scalpingHistory[symbol] = [];

  } catch(e) {
    console.error('Scalping error:', e.message);
  }
}

// Endpoints para controlar el modo scalping
app.post('/api/scalping/start', (req, res) => {
  if (scalpingActive) return res.json({ ok: false, message: 'Scalping ya activo' });
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  const intervalMin = parseFloat(process.env.SCALP_INTERVAL_MIN || '3');
  scalpingActive = true;
  scalpingInterval = setInterval(async () => {
    for (const sym of symbols) {
      await runScalpingAnalysis(sym.trim());
      await new Promise(r => setTimeout(r, 2000));
    }
  }, intervalMin * 60 * 1000);
  // Primera corrida inmediata
  setTimeout(async () => {
    for (const sym of symbols) {
      await runScalpingAnalysis(sym.trim());
      await new Promise(r => setTimeout(r, 2000));
    }
  }, 5000);
  console.log(`⚡ Modo scalping activado — cada ${intervalMin} min para: ${symbols.join(', ')}`);
  res.json({ ok: true, message: `Scalping activado cada ${intervalMin} min`, symbols });
});

app.post('/api/scalping/stop', (req, res) => {
  if (!scalpingActive) return res.json({ ok: false, message: 'Scalping no estaba activo' });
  clearInterval(scalpingInterval);
  scalpingActive = false;
  scalpingInterval = null;
  console.log('⚡ Modo scalping desactivado');
  res.json({ ok: true, message: 'Scalping desactivado' });
});

app.get('/api/scalping/status', (req, res) => {
  res.json({
    active: scalpingActive,
    intervalMin: parseFloat(process.env.SCALP_INTERVAL_MIN || '3'),
    threshold: parseInt(process.env.SCALP_THRESHOLD || '80'),
    symbols: (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',')
  });
});


// ─── JOB DE OPTIMIZACIÓN ML AUTOMÁTICA ───────────────────────────
// Corre cada domingo o cuando se llama manualmente
// Lee patrones de Supabase y ajusta pesos del sistema

let mlWeights = {
  // Pesos base de cada tipo de divergencia (probabilidad base)
  absorcion_compras: 73,
  absorcion_ventas: 73,
  rsi_bajista: 64,
  rsi_alcista: 64,
  cvd_precio_bajista: 65,
  cvd_precio_alcista: 65,
  bull_trap: 68,
  bear_trap: 68,
  short_buildup: 65,
  long_buildup: 65,
  funding_extremo: 62,
  volumen_climax: 65,
  long_squeeze: 68,
  short_squeeze: 68,
  regime_change_long: 65,
  regime_change_short: 65,
  // Bonuses de contexto
  bonus_4h_aligned: 15,
  bonus_both_tf: 15,
  bonus_fib_active: 8,
  bonus_whale_active: 8,
  bonus_double_absorption: 8,
  // Umbrales
  min_confidence_alert: 80,
  min_confidence_auto: 85,
  min_rr_swing: 1.3,
  min_rr_scalp: 1.5,
  last_optimized: null
};

async function runMLOptimization() {
  try {
    console.log('🧠 Iniciando optimización ML...');

    // Obtener todos los trades cerrados con market_data
    const { data: trades } = await supabase.from('paper_trades')
      .select('*')
      .in('status', ['won', 'lost'])
      .not('market_data', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (!trades || trades.length < 50) {
      console.log(`⚠️ ML: Solo ${trades?.length || 0} trades — necesita al menos 50 para optimizar`);
      return { optimized: false, reason: 'insufficient_data', trades: trades?.length || 0 };
    }

    const won = trades.filter(t => t.status === 'won');
    const lost = trades.filter(t => t.status === 'lost');
    const winRate = won.length / trades.length;

    console.log(`📊 ML: ${trades.length} trades analizados | WR: ${(winRate*100).toFixed(1)}%`);

    const adjustments = {};
    const recommendations = [];

    // 1. Analizar win rate por tipo de divergencia
    const divTypes = [
      'absorcion_compras','absorcion_ventas','rsi_bajista','rsi_alcista',
      'cvd_precio_bajista','cvd_precio_alcista','bull_trap','bear_trap',
      'short_buildup','long_buildup','funding_extremo','volumen_climax',
      'long_squeeze','short_squeeze','regime_change_long','regime_change_short'
    ];

    for (const divType of divTypes) {
      const withDiv = trades.filter(t => t.market_data?.top_divergence === divType);
      if (withDiv.length < 5) continue;
      const divWon = withDiv.filter(t => t.status === 'won');
      const divWR = divWon.length / withDiv.length;
      const currentWeight = mlWeights[divType] || 65;
      
      // Ajustar peso según win rate vs promedio general
      const wrDiff = (divWR - winRate) * 100;
      let newWeight = currentWeight;
      
      if (wrDiff > 10) newWeight = Math.min(85, currentWeight + 3); // mejor que promedio → subir
      if (wrDiff > 20) newWeight = Math.min(85, currentWeight + 5);
      if (wrDiff < -10) newWeight = Math.max(50, currentWeight - 3); // peor que promedio → bajar
      if (wrDiff < -20) newWeight = Math.max(50, currentWeight - 5);

      if (newWeight !== currentWeight) {
        adjustments[divType] = { from: currentWeight, to: newWeight, wr: (divWR*100).toFixed(1), trades: withDiv.length };
        mlWeights[divType] = newWeight;
        recommendations.push(`${divType}: ${currentWeight} → ${newWeight} (WR: ${(divWR*100).toFixed(1)}% con ${withDiv.length} trades)`);
      }
    }

    // 2. Analizar si 4H alineado mejora resultados
    const with4h = trades.filter(t =>
      (t.direction === 'LONG' && t.market_data?.bias_4h === 'long') ||
      (t.direction === 'SHORT' && t.market_data?.bias_4h === 'short')
    );
    if (with4h.length >= 10) {
      const wr4h = with4h.filter(t => t.status === 'won').length / with4h.length;
      const improvement = (wr4h - winRate) * 100;
      if (improvement > 5) {
        const newBonus = Math.min(20, mlWeights.bonus_4h_aligned + 2);
        adjustments.bonus_4h_aligned = { from: mlWeights.bonus_4h_aligned, to: newBonus };
        mlWeights.bonus_4h_aligned = newBonus;
        recommendations.push(`Bonus 4H alineado: +${mlWeights.bonus_4h_aligned} → +${newBonus} (mejora WR +${improvement.toFixed(1)}%)`);
      }
    }

    // 3. Ajustar umbral de confianza mínima
    const highConf = trades.filter(t => (t.market_data?.confidence || t.confidence || 0) >= 90);
    const lowConf = trades.filter(t => (t.market_data?.confidence || t.confidence || 0) < 90);
    if (highConf.length >= 10 && lowConf.length >= 10) {
      const wrHigh = highConf.filter(t => t.status === 'won').length / highConf.length;
      const wrLow = lowConf.filter(t => t.status === 'won').length / lowConf.length;
      if (wrHigh > wrLow + 0.1) {
        const newThreshold = Math.min(90, mlWeights.min_confidence_auto + 2);
        adjustments.min_confidence_auto = { from: mlWeights.min_confidence_auto, to: newThreshold };
        mlWeights.min_confidence_auto = newThreshold;
        recommendations.push(`Umbral auto trade: ${mlWeights.min_confidence_auto-2}% → ${newThreshold}% (alta confianza WR: ${(wrHigh*100).toFixed(1)}%)`);
      }
    }

    // 4. Guardar resultado en Supabase
    mlWeights.last_optimized = new Date().toISOString();
    const result = {
      timestamp: mlWeights.last_optimized,
      trades_analyzed: trades.length,
      win_rate: parseFloat((winRate*100).toFixed(2)),
      adjustments_count: Object.keys(adjustments).length,
      adjustments,
      recommendations,
      weights: mlWeights
    };

    await supabase.from('signals').insert({
      symbol: 'ML_OPTIMIZATION',
      direction: 'AUTO',
      confidence: Math.round(winRate * 100),
      reasoning: `Optimización ML: ${recommendations.length} ajustes aplicados`,
      market_data: result,
      source: 'ml_optimizer'
    }).catch(() => {});

    // Notificar por Telegram
    if (process.env.TELEGRAM_CHAT_ID && recommendations.length > 0) {
      const msg = `🧠 *Optimización ML completada*
📊 ${trades.length} trades analizados
📈 Win Rate actual: ${(winRate*100).toFixed(1)}%
🔧 ${recommendations.length} ajustes aplicados:
${recommendations.slice(0,5).map(r => '• ' + r).join('\n')}
🕐 ${new Date().toLocaleString('es-PE')}`;
      try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
    } else if (recommendations.length === 0) {
      console.log('✅ ML: Sistema ya está optimizado — sin ajustes necesarios');
    }

    console.log(`✅ ML Optimización completada: ${recommendations.length} ajustes | WR: ${(winRate*100).toFixed(1)}%`);
    return result;

  } catch(e) {
    console.error('ML Optimization error:', e.message);
    return { error: e.message };
  }
}

// Endpoint para ejecutar optimización manualmente
app.post('/api/ml/optimize', async (req, res) => {
  const result = await runMLOptimization();
  res.json(result);
});

// Endpoint para ver pesos actuales
app.get('/api/ml/weights', (req, res) => {
  res.json(mlWeights);
});

// Job automático: optimizar cada domingo a las 3am
function startMLOptimizationJob() {
  setInterval(async () => {
    const now = new Date();
    // Domingo = 0, 3am hora Lima (UTC-5 = 8am UTC)
    if (now.getUTCDay() === 0 && now.getUTCHours() === 8 && now.getUTCMinutes() < 16) {
      console.log('🧠 Iniciando optimización ML semanal automática...');
      await runMLOptimization();
    }
  }, 15 * 60 * 1000); // verificar cada 15 minutos
}


// ─── SOPORTE PARA ORO (XAUUSDT) ──────────────────────────────────
// Binance tiene XAUUSDT como par de futuros perpetuos
// El análisis es igual que crypto pero con parámetros ajustados

const ASSET_CONFIG = {
  'BTCUSDT':  { decimals: 0, minATR: 0.004, name: 'Bitcoin' },
  'ETHUSDT':  { decimals: 0, minATR: 0.004, name: 'Ethereum' },
  'SOLUSDT':  { decimals: 2, minATR: 0.004, name: 'Solana' },
  'XAUUSDT':  { decimals: 2, minATR: 0.002, name: 'Oro (Gold)' }
};

function getAssetConfig(symbol) {
  return ASSET_CONFIG[symbol] || { decimals: 2, minATR: 0.003, name: symbol };
}


// ─── NOTICIAS AUTOMÁTICAS ────────────────────────────────────────
let _processedNews = new Set();

async function fetchAndAnalyzeNews() {
  try {
    const res = await axios.get('https://min-api.cryptocompare.com/data/v2/news/', {
      params: { lang: 'EN', sortOrder: 'latest', limit: 10 },
      timeout: 8000
    });
    const items = res.data?.Data || [];
    
    for (const item of items.slice(0, 5)) {
      const newsId = item.id?.toString();
      if (!newsId || _processedNews.has(newsId)) continue;
      _processedNews.add(newsId);
      
      const title = (item.title || '').toLowerCase();
      const isCrypto = title.includes('bitcoin') || title.includes('btc') || 
                       title.includes('ethereum') || title.includes('eth') ||
                       title.includes('crypto') || title.includes('solana') ||
                       title.includes('fed') || title.includes('sec') ||
                       title.includes('gold') || title.includes('war');
      if (!isCrypto) continue;
      
      // Analizar con Claude solo si es relevante
      try {
        const analysis = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          messages: [{ role: 'user', content: `Analiza esta noticia cripto en JSON sin markdown:
{"sentiment":"ALCISTA|BAJISTA|NEUTRO","impact":"ALTO|MEDIO|BAJO","action":"COMPRAR|VENDER|ESPERAR","reasoning":"1 oración"}
Noticia: "${item.title}"` }]
        });
        
        const text = analysis.content[0].text;
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        
        if (parsed.impact === 'BAJO') continue;
        
        // Notificar por Telegram
        if (process.env.TELEGRAM_CHAT_ID) {
          const emoji = parsed.sentiment === 'ALCISTA' ? '🟢' : parsed.sentiment === 'BAJISTA' ? '🔴' : '🟡';
          const msg = `${parsed.impact === 'ALTO' ? '🚨' : '⚠️'} *Noticia ${parsed.impact}*\n${emoji} ${parsed.sentiment} — ${parsed.action}\n━━━━━━━━━━━━━━\n📰 ${item.title}\n💬 ${parsed.reasoning}\n🕐 ${new Date().toLocaleTimeString('es-PE')}`;
          try { await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch(_) {}
        }
        
        // Si impacto ALTO → análisis automático
        if (parsed.impact === 'ALTO') {
          const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT,ETHUSDT').split(',');
          for (const sym of symbols.slice(0, 2)) {
            await new Promise(r => setTimeout(r, 3000));
            runAutoAnalysis(sym).catch(() => {});
          }
        }
      } catch(_) {}
      
      await new Promise(r => setTimeout(r, 1000));
    }
    
    if (_processedNews.size > 100) _processedNews = new Set([..._processedNews].slice(-50));
  } catch(e) {
    // Silencioso — no crashear el servidor por noticias
  }
}

app.get('/api/news/latest', async (req, res) => {
  try {
    const res2 = await axios.get('https://min-api.cryptocompare.com/data/v2/news/', {
      params: { lang: 'EN', sortOrder: 'latest', limit: 8 },
      timeout: 8000
    });
    res.json(res2.data?.Data?.slice(0, 8) || []);
  } catch(e) { res.json([]); }
});

const PORT=process.env.PORT||3001;
app.listen(PORT,()=>{
  console.log(`Panel Futuros LO v4.1 corriendo en puerto ${PORT}`);
  startAlertJob();
  startMLOptimizationJob();
  console.log('🧠 Job de optimización ML activo — corre automático cada domingo 3am');
  setInterval(fetchAndAnalyzeNews, 5 * 60 * 1000);
  setTimeout(fetchAndAnalyzeNews, 30000);
  console.log('📰 Monitor de noticias activo — cada 5 min');
});
