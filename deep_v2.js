const {createClient}=require('@supabase/supabase-js');
require('dotenv').config();
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY);

sb.from('paper_trades').select('*').neq('source','meanrev').order('id',{ascending:true})
  .then(({data})=>{
    const done = data.filter(t=>t.status==='won'||t.status==='lost');

    // ── close_reason breakdown para SHORTS
    console.log('\n=== SHORTS: ¿por qué perdemos? ===');
    const sl_shorts = done.filter(t=>t.direction==='SHORT'&&t.close_reason==='sl');
    const tp_shorts = done.filter(t=>t.direction==='SHORT'&&t.close_reason==='tp1');
    console.log(`SL hits: ${sl_shorts.length} trades → precio siguió subiendo contra nosotros`);
    console.log(`TP hits: ${tp_shorts.length} trades → nuestra dirección fue correcta`);
    console.log(`Hit rate SL: ${(sl_shorts.length/done.filter(t=>t.direction==='SHORT').length*100).toFixed(0)}%`);
    console.log('');

    // ── ¿Qué pasó después de una barrida alcista? ¿Precio continuó subiendo?
    // Aproximación: cuando abrimos SHORT (señal bajista/barrida bajista) pero nos sacó SL = precio subió
    // Cuando abrimos SHORT y ganamos = precio bajó después de la barrida
    console.log('=== HIPÓTESIS: ¿Los sweeps son señales de CONTINUACIÓN o REVERSIÓN? ===');
    const shorts = done.filter(t=>t.direction==='SHORT');
    const sl_pnl = sl_shorts.reduce((a,t)=>a+(t.pnl_usd||0),0);
    const tp_pnl = tp_shorts.reduce((a,t)=>a+(t.pnl_usd||0),0);
    console.log(`Cuando la señal era bajista y abrimos SHORT:`);
    console.log(`  - Precio SUBIÓ (SL hit): ${sl_shorts.length}x = ${(sl_shorts.length/shorts.length*100).toFixed(0)}% del tiempo → señal era FALSA reversión`);
    console.log(`  - Precio BAJÓ (TP hit): ${tp_shorts.length}x = ${(tp_shorts.length/shorts.length*100).toFixed(0)}% del tiempo → señal era VERDADERA reversión`);
    console.log(`Conclusión: ${sl_shorts.length > tp_shorts.length ? '⚠️ Los sweeps SON señales de CONTINUACIÓN (momentum), no reversión' : '✅ Los sweeps son señales de reversión (contra-tendencia correcta)'}`);
    console.log('');

    // ── Ratio SL/TP por símbolo
    console.log('=== SL/TP ratio por símbolo (SHORTs) ===');
    const syms = [...new Set(shorts.map(t=>t.symbol))];
    syms.forEach(s=>{
      const st = shorts.filter(t=>t.symbol===s);
      const slc = st.filter(t=>t.close_reason==='sl').length;
      const tpc = st.filter(t=>t.close_reason==='tp1').length;
      console.log(`${s.replace('USDT','').padEnd(6)} SL:${slc} TP:${tpc} otros:${st.length-slc-tpc}`);
    });
    console.log('');

    // ── ¿Cuánto duraría un trade promedio antes de SL?
    console.log('=== Duración promedio de trades que perdieron por SL ===');
    const slWithTime = sl_shorts.filter(t=>t.opened_at&&t.closed_at);
    const durations = slWithTime.map(t=>(new Date(t.closed_at)-new Date(t.opened_at))/60000);
    if(durations.length>0){
      const avg = durations.reduce((a,b)=>a+b,0)/durations.length;
      const min = Math.min(...durations);
      const max = Math.max(...durations);
      console.log(`Avg: ${avg.toFixed(1)}min | Min: ${min.toFixed(1)}min | Max: ${max.toFixed(1)}min`);
      console.log(`Trades rápidos (<5min): ${durations.filter(d=>d<5).length} — señal SE REVIRTIÓ inmediatamente`);
    }
    console.log('');

    // ── Entry vs close price para SL trades — ¿cuánto movió contra?
    console.log('=== SL trades: ¿cuánto % movió el precio en nuestra contra? ===');
    sl_shorts.filter(t=>t.entry&&t.close_price).forEach(t=>{
      const entry=parseFloat(t.entry), close=parseFloat(t.close_price);
      // SHORT: precio subió si close > entry
      const movPct = (close-entry)/entry*100;
      const ts=t.opened_at?new Date(new Date(t.opened_at)-18000000).toISOString().slice(5,16).replace('T',' '):'';
      console.log(`#${t.id} ${t.symbol.replace('USDT','').padEnd(5)} entry:${entry.toFixed(2)} sl:${close.toFixed(2)} mov:+${movPct.toFixed(3)}% ${ts}`);
    });

    process.exit(0);
  });
