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

app.get('/', (req, res) => res.json({ status: 'Panel Futuros LO activo', version: '3.4.0' }));

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
  if(!klines||klines.length<20) return { bias:'neutral', score:50, rsi:50, cvdPct:0, volPct:0, oiTrend:'flat', oiDeltaPct:'0.000', fundingRate:0 };
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
  if(cvd.delta5>0) score+=10; else score-=10;
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
  const divergences=[];
  const closes=klines15m.map(k=>parseFloat(k[4]));
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
  const prevClose5=closes[closes.length-6];
  const prevClose10=closes[closes.length-11];
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

  // 1. Absorción de Compras (SHORT)
  if(priceUp&&cvdRising&&cvdAgressive){
    let prob=68;
    if(hasAskWall) prob+=12; if(oiFalling) prob+=8; if(lastRSI>65) prob+=7; if(lastRSI>75) prob+=8;
    if(bearishContext) prob+=8; if(aboveVwap) prob+=5; if(volClimaxUp) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'absorcion_compras', name:'Absorción de Compras', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`CVD +${cvd.cvdPct}% agresivo con muro vendedor — precio se agotará.${bearishContext?' 4H/1D bajista.':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',hasAskWall&&'Muro ask',oiFalling&&'OI cayendo',bearishContext&&'Contexto bajista'].filter(Boolean) });
  }

  // 2. Absorción de Ventas (LONG)
  if(priceDown&&cvdFalling&&cvdAgressive){
    let prob=68;
    if(hasBidWall) prob+=12; if(lastRSI<35) prob+=10; if(lastRSI<25) prob+=8;
    if(bullishContext) prob+=8; if(belowVwap) prob+=5; if(oiFalling) prob+=5; if(volClimaxDown) prob+=7;
    const nearLiq=getNearestLiqMagnet(price,'up'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'absorcion_ventas', name:'Absorción de Ventas', direction:'LONG', probability:Math.min(95,prob), entry:price, description:`Ballena comprando con límites — CVD ${cvd.cvdPct}% mientras precio baja.${bullishContext?' 4H/1D alcista.':''}`, action:prob>=82?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[hasBidWall&&'Muro bid',oiFalling&&'OI cayendo',bullishContext&&'Contexto alcista'].filter(Boolean) });
  }

  // 3. Divergencia RSI Bajista
  if(lastHigh>prevHigh&&lastRSI<prevRSI-3){
    let prob=62;
    if(cvdFalling) prob+=15; if(oiRising&&priceUp) prob+=5; if(lastRSI>60) prob+=7; if(lastRSI>70) prob+=8;
    if(bearishContext) prob+=8; if(hasAskWall) prob+=8;
    if(prevHigh>prevHigh2&&prevRSI<prevRSI8-2) prob+=10; // triple
    const nearLiq=getNearestLiqMagnet(price,'down'); if(nearLiq) prob+=nearLiq.bonus;
    divergences.push({ type:'rsi_bajista', name:'Div. RSI Bajista', direction:'SHORT', probability:Math.min(95,prob), entry:price, description:`Precio HH ($${parseInt(lastHigh).toLocaleString()}) pero RSI LH (${lastRSI} vs ${prevRSI}) — momentum agotado.`, action:prob>=80?'ENTRAR':prob>=65?'ESPERAR':'NO ENTRAR', liqTarget:nearLiq?.price, confluence:[cvdFalling&&'CVD divergente',bearishContext&&'Contexto bajista',hasAskWall&&'Muro ask'].filter(Boolean) });
  }

  // 4. Divergencia RSI Alcista
  if(lastLow<prevLow&&lastRSI>prevRSI+3){
    let prob=62;
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

  return divergences.sort((a,b)=>b.probability-a.probability);
}

function calcCombinedSignal(divergences, bias4h, bias1d, whaleData=null, deepOB=null, fib=null) {
  if(!divergences.length) return { direction:'ESPERAR', probability:30, action:'ESPERAR', reason:'Sin divergencias activas' };
  const shorts=divergences.filter(d=>d.direction==='SHORT');
  const longs=divergences.filter(d=>d.direction==='LONG');
  const shortScore=shorts.reduce((s,d)=>s+d.probability,0)/(shorts.length||1);
  const longScore=longs.reduce((s,d)=>s+d.probability,0)/(longs.length||1);
  let direction=shorts.length>longs.length?'SHORT':longs.length>shorts.length?'LONG':'ESPERAR';
  let prob=direction==='SHORT'?shortScore:direction==='LONG'?longScore:30;

  // Bonus por contexto multi-TF
  if(direction==='SHORT'&&(bias4h?.bias==='short'||bias1d?.bias==='short')) prob=Math.min(95,prob+8);
  if(direction==='LONG'&&(bias4h?.bias==='long'||bias1d?.bias==='long')) prob=Math.min(95,prob+8);

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

  const action=prob>=82?'ENTRAR':prob>=68?'ESPERAR CONFIRMACIÓN':'NO ENTRAR';
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
    const closes15m = k15m.data.map(k => parseFloat(k[4]));

    const cvd15m = calcCVD(k15m.data);
    const vrvp = calcVRVP(k15m.data);
    const ob = analyzeOB(obRes.data.bids, obRes.data.asks);

    const oiTrend15m = calcOITrend(oi15mHist);
    const oiTrend1h  = calcOITrend(oi1hHist);
    const oiTrend4h  = calcOITrend(oi4hHist);

    const bias15m = calcBias(k15m.data, oi15mHist, fundingRate);
    const bias1h  = calcBias(k1h.data, oi1hHist, fundingRate);
    const bias4h  = calcBias(k4h.data, oi4hHist, fundingRate);
    const bias1d  = calcBias(k1d.data, null, fundingRate);

    const fib15m = calcFibonacci(k15m.data, price);
    const fib4h  = calcFibonacci(k4h.data, price);

    const divergences = detectDivergences(k15m.data, ob, price, fundingRate, bias4h, bias1d, oiTrend15m, fib15m);
    const combinedSignal = calcCombinedSignal(divergences, bias4h, bias1d, whaleData, deepOB, fib15m);

    // 2. Verificar si hay señal fuerte
    const minConfidence = parseInt(process.env.ALERT_MIN_CONFIDENCE || '80');
    const minDivergences = parseInt(process.env.ALERT_MIN_DIVERGENCES || '2');

    if (combinedSignal.direction === 'ESPERAR') return;
    if (combinedSignal.probability < minConfidence) return;
    if (divergences.length < minDivergences) return;

    // 3. Evitar spam: no repetir la misma señal en 30 minutos
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

    // 6. Guardar en Supabase
    try {
      await supabase.from('signals').insert({
        symbol, direction: signal.direction, confidence: signal.confidence,
        entry: signal.entry, tp1: signal.tp1, tp2: signal.tp2,
        sl: signal.sl, rr: signal.rr, reasoning: signal.reasoning,
        market_data: marketData, source: 'auto_alert'
      });
    } catch(_) {}

  } catch(e) {
    console.error('Auto-analysis error:', e.message);
  }
}

// ─── JOB PERIÓDICO ───────────────────────────────────────────────
function startAlertJob() {
  if (!process.env.TELEGRAM_CHAT_ID || !process.env.TELEGRAM_TOKEN) {
    console.log('⚠️ Alertas Telegram desactivadas — faltan TELEGRAM_CHAT_ID y TELEGRAM_TOKEN');
    return;
  }
  const intervalMin = parseInt(process.env.ALERT_INTERVAL_MIN || '15');
  const symbols = (process.env.ALERT_SYMBOLS || 'BTCUSDT').split(',');
  console.log(`✅ Alertas activas — cada ${intervalMin} min para: ${symbols.join(', ')}`);

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

const PORT=process.env.PORT||3001;
app.listen(PORT,()=>{
  console.log(`Panel Futuros LO v3.4 corriendo en puerto ${PORT}`);
  startAlertJob();
});
