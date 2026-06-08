const {createClient}=require('@supabase/supabase-js');
require('dotenv').config({path:'/home/noc/samael_delta/.env'});

const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY);

function stats(trades, label) {
  const done = trades.filter(t => t.status==='won' || t.status==='lost');
  if (!done.length) { console.log(label+': 0 trades'); return; }
  const wins = done.filter(t=>t.status==='won');
  const losses = done.filter(t=>t.status==='lost');
  const pnls = done.map(t=>parseFloat(t.pnl_usd||0));
  const net = pnls.reduce((a,b)=>a+b,0);
  const sumW = pnls.filter(p=>p>0).reduce((a,b)=>a+b,0);
  const sumL = pnls.filter(p=>p<0).reduce((a,b)=>a+b,0);
  const avgW = wins.length ? sumW/wins.length : 0;
  const avgL = losses.length ? sumL/losses.length : 0;
  const wr = 100*wins.length/done.length;
  console.log('');
  console.log('=== '+label+' ===');
  console.log('  Trades: '+done.length+' | WR: '+wr.toFixed(1)+'%');
  console.log('  Net: $'+net.toFixed(2)+' | Wins: $'+sumW.toFixed(2)+' | Losses: $'+sumL.toFixed(2));
  console.log('  Avg win: $'+avgW.toFixed(2)+' | Avg loss: $'+avgL.toFixed(2));
  console.log('  Ratio R:R: '+(Math.abs(avgW/avgL)).toFixed(2)+'x');
  // Monthly breakdown
  const byMonth = {};
  done.forEach(t=>{
    if(!t.opened_at) return;
    const m = t.opened_at.slice(0,7);
    if(!byMonth[m]) byMonth[m]={net:0,n:0,w:0};
    byMonth[m].net += parseFloat(t.pnl_usd||0);
    byMonth[m].n++;
    if(t.status==='won') byMonth[m].w++;
  });
  Object.keys(byMonth).sort().forEach(m=>{
    const b=byMonth[m];
    console.log('  '+m+': Net=$'+b.net.toFixed(2)+' ('+b.n+' trades, WR='+Math.round(100*b.w/b.n)+'%)');
  });
}

(async()=>{
  const {data:all, error} = await sb.from('paper_trades').select('*').in('status',['won','lost']).order('id',{ascending:true});
  if(error){console.log('Error:',error.message);process.exit(1);}
  console.log('Total trades históricos completados:', all.length);
  const sources = [...new Set(all.map(t=>t.source))];
  console.log('Sources encontradas:', sources.join(', '));
  
  stats(all.filter(t=>t.source==='sweep'), 'SWEEP SOLO');
  stats(all.filter(t=>t.source==='meanrev'), 'MEANREV SOLO');
  stats(all.filter(t=>t.source==='sweep'||t.source==='meanrev'), 'SWEEP + MEANREV (combinado)');
  stats(all.filter(t=>t.source==='meanrev'||t.source==='sweep_long'||t.source==='long_momentum'), 'MEANREV + LONGs');
  stats(all, 'TODO (todas las fuentes)');
})();
