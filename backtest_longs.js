require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const Lima = t => new Date(new Date(t).getTime()-18000000);
const HORAS = new Set([7,8,9,10,11,12,15,16,17,18,19,21,23]);
const BE = 0.242;
const scale = (tr,sz,lv) => { const f=(sz/62)*(lv/10); return tr.map(t=>({...t,pnl_usd:(t.pnl_usd||0)*f})); };
const stats = tr => {
  if(!tr.length) return {n:0,wr:0,pnl:0,aw:0,al:0};
  const w=tr.filter(t=>t.status==='won'), l=tr.filter(t=>t.status==='lost');
  return {n:tr.length, wr:w.length/tr.length, pnl:tr.reduce((s,t)=>s+(t.pnl_usd||0),0),
    aw:w.length?w.reduce((s,t)=>s+(t.pnl_usd||0),0)/w.length:0,
    al:l.length?l.reduce((s,t)=>s+(t.pnl_usd||0),0)/l.length:0};
};

async function main() {
  const {data:sh}=await sb.from('paper_trades')
    .select('symbol,status,pnl_usd,opened_at')
    .eq('source','shadow').eq('direction','LONG')
    .in('status',['won','lost'])
    .order('opened_at',{ascending:true});

  const all=sh||[], now=Date.now(), p14=new Date(now-14*86400000).toISOString();
  const f1=all.filter(t=>HORAS.has(Lima(t.opened_at).getHours()));
  const f3=f1.filter(t=>t.opened_at>=p14 && t.symbol!=='SUIUSDT');

  console.log('=== BACKTEST LONGs REALES (shadow inversion) ===');
  console.log('Shadow LONG = sweep fue SHORT. Shadow gano = SHORT perdio = LONG gano.');
  console.log('Escala: shadow $62/lev=10 -> LONG real $14/lev=5 (factor 0.113)\n');

  [['sin filtros',all],['+ hora Lima activa',f1],['+ 2 semanas sin SUI',f3]].forEach(([lbl,tr]) => {
    const s=stats(scale(tr,14,5));
    const edge=((s.wr-BE)*100).toFixed(1)+'pp';
    const v=s.wr>=BE+0.15?'RENTABLE':s.wr>=BE?'MARGINAL':'NEGATIVO';
    console.log(lbl.padEnd(22)+' n='+String(s.n).padStart(4)+' WR='+(s.wr*100).toFixed(0)+'% PnL=$'+s.pnl.toFixed(2).padStart(7)+' edge='+edge+' '+v);
  });

  console.log('\n--- Por simbolo (ultimas 2 semanas, sin SUI) ---');
  const byS={};
  scale(f3,14,5).forEach(t=>{if(!byS[t.symbol])byS[t.symbol]=[];byS[t.symbol].push(t);});
  Object.entries(byS).sort((a,b)=>b[1].length-a[1].length).forEach(([sym,tr]) => {
    const s=stats(tr);
    const e=((s.wr-BE)*100).toFixed(1)+'pp';
    const v=s.wr>=BE+0.15?'RENT':s.wr>=BE?'MARG':'NEG';
    console.log('  '+sym.padEnd(12)+' n='+String(s.n).padStart(3)+' WR='+(s.wr*100).toFixed(0)+'% PnL=$'+s.pnl.toFixed(2)+' aw=$'+s.aw.toFixed(3)+' al=$'+s.al.toFixed(3)+' '+e+' '+v);
  });

  console.log('\n--- Por hora Lima (F1 todos los tiempos) ---');
  const byH={};
  scale(f1,14,5).forEach(t=>{
    const h=Lima(t.opened_at).getHours();
    if(!byH[h])byH[h]={n:0,w:0,pnl:0};
    byH[h].n++; if(t.status==='won')byH[h].w++; byH[h].pnl+=(t.pnl_usd||0);
  });
  Object.keys(byH).sort((a,b)=>+a-+b).forEach(h=>{
    const v=byH[h], wr=Math.round(v.w/v.n*100);
    const sig=v.n>=10?(wr>35?'BUENA':wr<20?'MALA':'OK'):'n<10';
    console.log('  h'+String(h).padStart(2,'0')+': n='+v.n+' WR='+wr+'% PnL=$'+v.pnl.toFixed(2)+' ['+sig+']');
  });

  const ds=stats(scale(f3,14,5));
  console.log('\n--- Proyeccion operacional (F3) ---');
  console.log('  Trades 14d: '+f3.length+' -> ~'+(f3.length/14).toFixed(1)+'/dia');
  console.log('  PnL/dia estimado: $'+(ds.pnl/14).toFixed(2));
  console.log('  MaxRisk/dia (3 trades x avgLoss): $'+(Math.abs(ds.al)*3).toFixed(2));
}
main().catch(e=>console.error(e.message));
