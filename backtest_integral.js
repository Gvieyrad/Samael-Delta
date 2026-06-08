/**
 * Backtest integral — aplica cada filtro propuesto retroactivamente a los trades históricos.
 * Descarga de Binance al momento de cada trade:
 *   - 4H SMA20 trend (bear/bull)
 *   - BTC 1H momentum (% cambio última vela)
 *   - Funding rate (sesgo de mercado)
 */
const {createClient}=require('@supabase/supabase-js');
const axios=require('axios');
require('dotenv').config();

const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY);
const B='https://fapi.binance.com';
const HORAS=new Set([7,8,9,10,13,15,16,17,18,19,21,23]);
const DELAY=ms=>new Promise(r=>setTimeout(r,ms));

async function klines(symbol,interval,limit=500){
  const r=await axios.get(`${B}/fapi/v1/klines`,{params:{symbol,interval,limit},timeout:15000});
  return r.data.map(k=>({oT:k[0],cT:k[6],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
}
async function fundingHist(symbol){
  const r=await axios.get(`${B}/fapi/v1/fundingRate`,{params:{symbol,limit:500},timeout:15000});
  return r.data.map(f=>({t:+f.fundingTime,rate:+f.fundingRate}));
}

// 4H trend: +1=alcista (close>SMA20) -1=bajista -99=sin datos
function trend4h(ks,ts){
  let idx=-1;
  for(let i=ks.length-1;i>=0;i--){ if(ks[i].cT<ts){idx=i;break;} }
  if(idx<20) return -99;
  const closes=ks.slice(idx-19,idx+1).map(k=>k.c);
  const avg=closes.reduce((a,b)=>a+b,0)/20;
  return ks[idx].c > avg ? 1 : -1;
}

// BTC 1H momentum: % cambio de la última vela 1H cerrada antes de ts
function btcMom(ks,ts){
  for(let i=ks.length-1;i>=0;i--){
    if(ks[i].cT<ts) return (ks[i].c-ks[i].o)/ks[i].o*100;
  }
  return 0;
}

// Funding rate más reciente antes de ts (decimal; 0.0001=0.01%)
function fundAt(rates,ts){
  for(let i=rates.length-1;i>=0;i--){
    if(rates[i].t<=ts) return rates[i].rate;
  }
  return 0;
}

(async()=>{
  const {data:trades}=await sb.from('paper_trades').select('*').neq('source','meanrev').order('id',{ascending:true});
  const done=trades.filter(t=>t.status==='won'||t.status==='lost');

  // Base v4.5.17: SHORT + no ETH + hora activa
  const base=done.filter(t=>{
    if(t.direction!=='SHORT') return false;
    if(t.symbol==='ETHUSDT') return false;
    if(t.opened_at){
      const h=new Date(new Date(t.opened_at)-18000000).getUTCHours();
      if(!HORAS.has(h)) return false;
    }
    return true;
  });

  // Símbolos únicos en base
  const syms=[...new Set(base.map(t=>t.symbol))];
  process.stdout.write('Descargando datos Binance: ');

  const k4={}, fund={};
  for(const s of [...syms,'BTCUSDT']){
    process.stdout.write(s.replace('USDT','')+' ');
    k4[s]=await klines(s,'4h',300);
    fund[s]=await fundingHist(s);
    await DELAY(250);
  }
  const btc1h=await klines('BTCUSDT','1h',500);
  console.log('✓\n');

  // Anotar cada trade
  const ann=base.map(t=>{
    const ts=new Date(t.opened_at).getTime();
    const t4h = k4[t.symbol] ? trend4h(k4[t.symbol],ts) : -99;
    const bm  = btcMom(btc1h,ts);
    const fr  = fundAt(fund[t.symbol]||[],ts);
    return {...t, t4h, bm, fr};
  });

  // Filtros a comparar (acumulativos sobre base v4.5.17)
  const combos=[
    ['v4.5.17 (base)',          ()=>true],
    ['+ 4H bajista (<SMA20)',   t=>t.t4h<=0],         // neutral o bajista
    ['+ BTC 1H mom <+0.8%',    t=>t.bm<0.8],          // BTC no está pumpeando
    ['+ funding <0.05%',        t=>t.fr<0.0005],       // no hay sesgo long extremo
    ['4H + BTC',                t=>t.t4h<=0&&t.bm<0.8],
    ['4H + BTC + funding',      t=>t.t4h<=0&&t.bm<0.8&&t.fr<0.0005],
  ];

  const row=(name,subset)=>{
    const wins=subset.filter(t=>t.status==='won');
    const pnl=subset.reduce((a,t)=>a+(t.pnl_usd||0),0);
    const fees=subset.reduce((a,t)=>a+(t.size_usd||0)*(t.leverage||10)*0.00028,0);
    const neto=pnl-fees;
    return {name,n:subset.length,wins:wins.length,pnl,fees,neto};
  };

  const baseRow=row('v4.5.17 (base)',ann);

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║          BACKTEST INTEGRAL — FILTROS PROPUESTOS              ║');
  console.log('╠══════════════════════════╦═════╦═══════╦════════╦════════════╣');
  console.log('║ Filtro                   ║  n  ║  WR   ║  PnL   ║  Δ vs base ║');
  console.log('╠══════════════════════════╬═════╬═══════╬════════╬════════════╣');

  for(const [name,fn] of combos){
    const s=ann.filter(fn);
    const r=row(name,s);
    const wr=r.n>0?(r.wins/r.n*100).toFixed(0)+'%':'-%';
    const pnlStr=(r.neto>=0?'+':'')+'$'+r.neto.toFixed(2);
    const delta=r.neto-baseRow.neto;
    const dStr=(delta>=0?'+':'')+'$'+delta.toFixed(2);
    console.log(`║ ${name.padEnd(24)} ║ ${String(r.n).padStart(3)} ║ ${wr.padStart(5)} ║ ${pnlStr.padStart(6)} ║ ${dStr.padStart(10)} ║`);
  }
  console.log('╚══════════════════════════╩═════╩═══════╩════════╩════════════╝');

  // Detalle por trade con anotaciones
  console.log('\n── Detalle trades base v4.5.17 con contexto de mercado ─────────');
  console.log('  id   sym    PnL     res    4H     BTC1h    funding');
  ann.forEach(t=>{
    const t4=t.t4h===1?'↑BULL':(t.t4h===-1?'↓bear':'?    ');
    const bm=(t.bm>=0?'+':'')+t.bm.toFixed(2)+'%';
    const fr=(t.fr*100).toFixed(4)+'%';
    const pnl=(t.pnl_usd>=0?'+':'')+'$'+t.pnl_usd.toFixed(2);
    const flag=t.status==='won'?'✅':'❌';
    console.log(`  #${String(t.id).padEnd(5)}${t.symbol.replace('USDT','').padEnd(7)}${pnl.padStart(7)} ${flag} ${t.status.padEnd(5)} ${t4}  ${bm.padStart(7)}  ${fr}`);
  });

  // Resumen: cuántos trades bloquea cada filtro y qué PnL tenían
  console.log('\n── Trades que BLOQUEA cada filtro ───────────────────────────────');
  const filters2=[
    ['4H alcista (bloquea SHORT en uptrend)', t=>t.t4h>0],
    ['BTC pumpeando >+0.8% (bloquea alts)',   t=>t.bm>=0.8],
    ['Funding alto >0.05%',                   t=>t.fr>=0.0005],
  ];
  for(const [name,fn] of filters2){
    const blocked=ann.filter(fn);
    const bpnl=blocked.reduce((a,t)=>a+(t.pnl_usd||0),0);
    const bwr=blocked.length>0?(blocked.filter(t=>t.status==='won').length/blocked.length*100).toFixed(0)+'%':'-%';
    const bfees=blocked.reduce((a,t)=>a+(t.size_usd||0)*(t.leverage||10)*0.00028,0);
    console.log(`  ${name}`);
    console.log(`    Bloqueados: n=${blocked.length}  WR=${bwr}  PnL neto=${((bpnl-bfees)>=0?'+':'')+'$'+(bpnl-bfees).toFixed(2)}`);
    blocked.forEach(t=>console.log(`    #${t.id} ${t.symbol.replace('USDT','').padEnd(5)} ${t.status.padEnd(5)} pnl=$${t.pnl_usd?.toFixed(2)} btc=${(t.bm>=0?'+':'')+t.bm.toFixed(2)}% fund=${(t.fr*100).toFixed(4)}%`));
    console.log('');
  }

  process.exit(0);
})();
