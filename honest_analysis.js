const {createClient}=require('@supabase/supabase-js');
require('dotenv').config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY);

sb.from('paper_trades').select('*').neq('source','meanrev').order('id',{ascending:true})
  .then(({data})=>{
    const done = data.filter(t=>t.status==='won'||t.status==='lost');
    const real = done; // ya filtrado sin meanrev

    // ── SHORT solamente — por símbolo
    console.log('\n=== SHORTs por símbolo ===');
    const shorts = real.filter(t=>t.direction==='SHORT');
    const bySym={};
    shorts.forEach(t=>{
      if(!bySym[t.symbol]) bySym[t.symbol]={n:0,wins:0,pnl:0};
      bySym[t.symbol].n++;
      if(t.status==='won') bySym[t.symbol].wins++;
      bySym[t.symbol].pnl+=t.pnl_usd||0;
    });
    Object.entries(bySym).sort((a,b)=>b[1].pnl-a[1].pnl).forEach(([s,v])=>{
      console.log(`${s.replace('USDT','').padEnd(8)} n=${v.n} WR=${(v.wins/v.n*100).toFixed(0)}% PnL=${v.pnl>=0?'+':''}${v.pnl.toFixed(2)}`);
    });

    // ── SHORT por close_reason
    console.log('\n=== SHORTs por close_reason ===');
    const byR={};
    shorts.forEach(t=>{
      const k=t.close_reason||'unknown';
      if(!byR[k]) byR[k]={n:0,wins:0,pnl:0};
      byR[k].n++;if(t.status==='won')byR[k].wins++;byR[k].pnl+=t.pnl_usd||0;
    });
    Object.entries(byR).sort((a,b)=>b[1].n-a[1].n).forEach(([r,v])=>{
      console.log(`${r.padEnd(12)} n=${v.n} WR=${(v.wins/v.n*100).toFixed(0)}% PnL=${v.pnl>=0?'+':''}${v.pnl.toFixed(2)}`);
    });

    // ── SHORT por source (sweep vs whale)
    console.log('\n=== SHORTs por source ===');
    const bySrc={};
    shorts.forEach(t=>{
      const k=t.source||'?';
      if(!bySrc[k]) bySrc[k]={n:0,wins:0,pnl:0};
      bySrc[k].n++;if(t.status==='won')bySrc[k].wins++;bySrc[k].pnl+=t.pnl_usd||0;
    });
    Object.entries(bySrc).forEach(([s,v])=>{
      console.log(`${s.padEnd(8)} n=${v.n} WR=${(v.wins/v.n*100).toFixed(0)}% PnL=${v.pnl>=0?'+':''}${v.pnl.toFixed(2)}`);
    });

    // ── SHORT por hora Lima
    console.log('\n=== SHORTs por hora Lima ===');
    const byH={};
    shorts.forEach(t=>{
      if(!t.opened_at) return;
      const h=new Date(new Date(t.opened_at)-18000000).getHours();
      if(!byH[h]) byH[h]={n:0,wins:0,pnl:0};
      byH[h].n++;if(t.status==='won')byH[h].wins++;byH[h].pnl+=t.pnl_usd||0;
    });
    Object.entries(byH).sort((a,b)=>Number(a[0])-Number(b[0])).forEach(([h,v])=>{
      console.log(`${String(h).padStart(2)}h  n=${v.n} WR=${(v.wins/v.n*100).toFixed(0)}% PnL=${v.pnl>=0?'+':''}${v.pnl.toFixed(2)}`);
    });

    // ── Últimos 10 trades para ver tendencia reciente
    console.log('\n=== Últimos 10 trades (todos) ===');
    real.slice(-10).forEach(t=>{
      const ts=t.opened_at?new Date(new Date(t.opened_at)-18000000).toISOString().slice(5,16).replace('T',' '):'';
      console.log(`#${t.id} ${t.direction.padEnd(5)} ${t.symbol.replace('USDT','').padEnd(6)} ${t.status.padEnd(5)} ${(t.pnl_usd||0).toFixed(2).padStart(6)} ${t.close_reason||'-'} ${ts}`);
    });

    process.exit(0);
  });
