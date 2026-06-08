const {createClient}=require('@supabase/supabase-js');
require('dotenv').config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY);

const HORAS_ACTIVAS = new Set([7,8,9,13,15,16,17,18,19,21,23]);

sb.from('paper_trades').select('*').neq('source','meanrev').order('id',{ascending:true})
  .then(({data})=>{
    const done = data.filter(t=>t.status==='won'||t.status==='lost');
    const real = done; // sin meanrev

    // ── BASELINE: todos los reales (pre-v4.5.17)
    const base = real;
    const baseWins = base.filter(t=>t.status==='won');
    const basePnl  = base.reduce((a,t)=>a+(t.pnl_usd||0),0);
    const baseFees = base.reduce((a,t)=>a+(t.size_usd||0)*(t.leverage||10)*0.00028,0);

    // ── FILTROS v4.5.17
    // 1. Solo SHORT (v4.5.16 ya bloqueó LONGs, pero aplicamos igual)
    // 2. Sin ETH
    // 3. Solo horas activas Lima (UTC-5)
    const v17 = real.filter(t=>{
      if(t.direction!=='SHORT') return false;
      if(t.symbol==='ETHUSDT') return false;
      if(t.opened_at){
        const h = new Date(new Date(t.opened_at)-18000000).getHours();
        if(!HORAS_ACTIVAS.has(h)) return false;
      }
      return true;
    });
    const v17Wins = v17.filter(t=>t.status==='won');
    const v17Pnl  = v17.reduce((a,t)=>a+(t.pnl_usd||0),0);
    const v17Fees = v17.reduce((a,t)=>a+(t.size_usd||0)*(t.leverage||10)*0.00028,0);

    // ── TRADES ELIMINADOS
    const eliminated = real.filter(t=>!v17.includes(t));
    const elimPnl = eliminated.reduce((a,t)=>a+(t.pnl_usd||0),0);

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║     BACKTEST v4.5.17 (filtros retroactivos)  ║');
    console.log('╚══════════════════════════════════════════════╝');

    console.log('\n── BASELINE (real, sin filtros v4.5.17) ──────');
    console.log(`Trades:  ${base.length}`);
    console.log(`WR:      ${(baseWins.length/base.length*100).toFixed(1)}%  (${baseWins.length}W / ${base.length-baseWins.length}L)`);
    console.log(`PnL:     ${basePnl>=0?'+':''}$${basePnl.toFixed(2)}`);
    console.log(`Fees:    -$${baseFees.toFixed(2)}`);
    console.log(`Neto:    ${(basePnl-baseFees)>=0?'+':''}$${(basePnl-baseFees).toFixed(2)}`);

    console.log('\n── v4.5.17 SIM (ETH off + hour filter) ───────');
    console.log(`Trades:  ${v17.length}  (${real.length-v17.length} eliminados)`);
    console.log(`WR:      ${(v17Wins.length/v17.length*100).toFixed(1)}%  (${v17Wins.length}W / ${v17.length-v17Wins.length}L)`);
    console.log(`PnL:     ${v17Pnl>=0?'+':''}$${v17Pnl.toFixed(2)}`);
    console.log(`Fees:    -$${v17Fees.toFixed(2)}`);
    console.log(`Neto:    ${(v17Pnl-v17Fees)>=0?'+':''}$${(v17Pnl-v17Fees).toFixed(2)}`);
    console.log(`Delta vs base: ${(v17Pnl-basePnl)>=0?'+':''}$${(v17Pnl-basePnl).toFixed(2)}`);

    // ── TRADES ELIMINADOS — qué se pierde/gana
    console.log('\n── Trades eliminados por filtros ──────────────');
    // por razón
    const elimEth    = real.filter(t=>t.symbol==='ETHUSDT');
    const elimLong   = real.filter(t=>t.direction==='LONG'&&t.symbol!=='ETHUSDT');
    const elimHour   = real.filter(t=>{
      if(t.direction!=='SHORT'||t.symbol==='ETHUSDT') return false;
      if(!t.opened_at) return false;
      const h=new Date(new Date(t.opened_at)-18000000).getHours();
      return !HORAS_ACTIVAS.has(h);
    });
    const pnl=(arr)=>arr.reduce((a,t)=>a+(t.pnl_usd||0),0);
    const wr=(arr)=>arr.length?`${(arr.filter(t=>t.status==='won').length/arr.length*100).toFixed(0)}%`:'-';
    console.log(`ETH (todos):   n=${elimEth.length.toString().padStart(3)}  WR=${wr(elimEth).padStart(4)}  PnL=${pnl(elimEth)>=0?'+':''}$${pnl(elimEth).toFixed(2)}`);
    console.log(`LONGs (no ETH):n=${elimLong.length.toString().padStart(3)}  WR=${wr(elimLong).padStart(4)}  PnL=${pnl(elimLong)>=0?'+':''}$${pnl(elimLong).toFixed(2)}`);
    console.log(`Hour blocked:  n=${elimHour.length.toString().padStart(3)}  WR=${wr(elimHour).padStart(4)}  PnL=${pnl(elimHour)>=0?'+':''}$${pnl(elimHour).toFixed(2)}`);

    // ── Hour filter detail
    console.log('\n── v4.5.17 SHORT (no ETH) por hora Lima ──────');
    const byH={};
    real.filter(t=>t.direction==='SHORT'&&t.symbol!=='ETHUSDT'&&t.opened_at).forEach(t=>{
      const h=new Date(new Date(t.opened_at)-18000000).getHours();
      if(!byH[h]) byH[h]={n:0,wins:0,pnl:0,active:HORAS_ACTIVAS.has(h)};
      byH[h].n++;if(t.status==='won')byH[h].wins++;byH[h].pnl+=t.pnl_usd||0;
    });
    Object.entries(byH).sort((a,b)=>Number(a[0])-Number(b[0])).forEach(([h,v])=>{
      const flag = v.active ? '✅' : '🔴';
      console.log(`${flag} ${String(h).padStart(2)}h  n=${v.n}  WR=${v.n?(v.wins/v.n*100).toFixed(0)+'%':'-%'}  PnL=${v.pnl>=0?'+':''}$${v.pnl.toFixed(2)}`);
    });

    // ── Por símbolo en v4.5.17
    console.log('\n── v4.5.17 por símbolo ───────────────────────');
    const bySym={};
    v17.forEach(t=>{
      if(!bySym[t.symbol]) bySym[t.symbol]={n:0,wins:0,pnl:0};
      bySym[t.symbol].n++;if(t.status==='won')bySym[t.symbol].wins++;bySym[t.symbol].pnl+=t.pnl_usd||0;
    });
    Object.entries(bySym).sort((a,b)=>b[1].pnl-a[1].pnl).forEach(([s,v])=>{
      console.log(`${s.replace('USDT','').padEnd(8)} n=${v.n}  WR=${(v.wins/v.n*100).toFixed(0).padStart(3)}%  PnL=${v.pnl>=0?'+':''}$${v.pnl.toFixed(2)}`);
    });

    process.exit(0);
  });
