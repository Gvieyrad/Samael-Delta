require('dotenv').config({path:'/home/noc/samael_delta/.env'});
const {createClient}=require('@supabase/supabase-js');
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY);

function avg(arr){return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;}
function pct(a,b){return b?((a/b)*100).toFixed(1)+'%':'n/a';}

(async()=>{
  const {data}=await sb.from('paper_trades').select('*').in('source',['sweep','meanrev']).in('status',['won','lost']).order('id',{ascending:true});
  const wins=data.filter(t=>t.status==='won');
  const losses=data.filter(t=>t.status==='lost');
  
  console.log('\n=== ANÁLISIS DE PATRONES: WINS vs LOSSES ===\n');
  console.log('Total:', data.length, '| Wins:', wins.length, '| Losses:', losses.length);

  // 1. CVD
  const wcvd=wins.map(t=>t.market_data?.cvd_live).filter(v=>v!=null);
  const lcvd=losses.map(t=>t.market_data?.cvd_live).filter(v=>v!=null);
  console.log('\n[CVD Live]');
  console.log('  Wins avg:  ', avg(wcvd).toFixed(1)+'%  | positivo:', pct(wcvd.filter(v=>v>0).length,wcvd.length));
  console.log('  Losses avg:', avg(lcvd).toFixed(1)+'%  | positivo:', pct(lcvd.filter(v=>v>0).length,lcvd.length));

  // 2. Vol multiplier
  const wvol=wins.map(t=>t.market_data?.volume_multiplier).filter(v=>v!=null);
  const lvol=losses.map(t=>t.market_data?.volume_multiplier).filter(v=>v!=null);
  console.log('\n[Volume Multiplier]');
  console.log('  Wins avg:  ', avg(wvol).toFixed(1)+'x');
  console.log('  Losses avg:', avg(lvol).toFixed(1)+'x');
  console.log('  Wins >10x: ', pct(wvol.filter(v=>v>=10).length,wvol.length));
  console.log('  Losses >10x:', pct(lvol.filter(v=>v>=10).length,lvol.length));

  // 3. Bias 1D
  const biasBuckets={};
  data.forEach(t=>{
    const k=(t.market_data?.bias_1d||'?')+'/'+t.status;
    biasBuckets[k]=(biasBuckets[k]||0)+1;
  });
  console.log('\n[Bias 1D]');
  ['long','short','neutral'].forEach(b=>{
    const w=biasBuckets[b+'/won']||0, l=biasBuckets[b+'/lost']||0;
    if(w+l>0) console.log('  '+b.padEnd(8)+': '+w+'W / '+l+'L → WR '+pct(w,w+l));
  });

  // 4. Confidence
  const wconf=wins.map(t=>t.market_data?.confidence).filter(v=>v!=null);
  const lconf=losses.map(t=>t.market_data?.confidence).filter(v=>v!=null);
  console.log('\n[Confidence]');
  console.log('  Wins avg:  ', avg(wconf).toFixed(1)+'%');
  console.log('  Losses avg:', avg(lconf).toFixed(1)+'%');
  // buckets
  [86,90,92,95].forEach(th=>{
    const wn=wconf.filter(v=>v>=th).length, ln=lconf.filter(v=>v>=th).length;
    if(wn+ln>0) console.log('  ≥'+th+'%: '+wn+'W/'+ln+'L WR='+pct(wn,wn+ln));
  });

  // 5. Direction
  console.log('\n[Dirección]');
  ['SHORT','LONG'].forEach(dir=>{
    const dt=data.filter(t=>t.market_data?.direction===dir||t.direction===dir);
    const dw=dt.filter(t=>t.status==='won');
    if(dt.length>0) console.log('  '+dir+': '+dw.length+'W/'+dt.length+' → WR '+pct(dw.length,dt.length));
  });

  // 6. Hora Lima
  console.log('\n[Hora Lima (apertura)]');
  const hourBuckets={};
  data.forEach(t=>{
    if(!t.opened_at) return;
    const h=new Date(new Date(t.opened_at).getTime()-18000000).getUTCHours();
    if(!hourBuckets[h]) hourBuckets[h]={w:0,l:0};
    if(t.status==='won') hourBuckets[h].w++; else hourBuckets[h].l++;
  });
  Object.keys(hourBuckets).sort((a,b)=>+a-+b).forEach(h=>{
    const b=hourBuckets[h]; const tot=b.w+b.l;
    if(tot>=2) console.log('  '+String(h).padStart(2,'0')+'h: '+b.w+'W/'+tot+' WR='+pct(b.w,tot));
  });

  // 7. Symbol
  console.log('\n[Símbolo]');
  const symB={};
  data.forEach(t=>{
    const s=t.symbol; if(!symB[s]) symB[s]={w:0,l:0};
    if(t.status==='won') symB[s].w++; else symB[s].l++;
  });
  Object.entries(symB).sort((a,b)=>(b[1].w+b[1].l)-(a[1].w+a[1].l)).forEach(([s,b])=>{
    console.log('  '+s.replace('USDT','').padEnd(6)+': '+b.w+'W/'+String(b.w+b.l).padEnd(3)+' WR='+pct(b.w,b.w+b.l));
  });

  // 8. Funding rate
  const wfund=wins.map(t=>t.market_data?.funding_rate*100||0).filter(v=>v!=null);
  const lfund=losses.map(t=>t.market_data?.funding_rate*100||0).filter(v=>v!=null);
  console.log('\n[Funding Rate]');
  console.log('  Wins avg:  ', avg(wfund).toFixed(4)+'%');
  console.log('  Losses avg:', avg(lfund).toFixed(4)+'%');

  // 9. Sweep reason
  console.log('\n[Sweep Reason]');
  const reasonB={};
  data.forEach(t=>{
    const r=t.market_data?.sweep_reason||t.market_data?.reason||'?';
    const key=r.slice(0,30)+'/'+t.status;
    reasonB[key]=(reasonB[key]||0)+1;
  });
  const reasons=[...new Set(Object.keys(reasonB).map(k=>k.split('/')[0]))];
  reasons.forEach(r=>{
    const w=reasonB[r+'/won']||0, l=reasonB[r+'/lost']||0;
    if(w+l>=2) console.log('  '+r.slice(0,35).padEnd(35)+': '+w+'W/'+l+'L WR='+pct(w,w+l));
  });
})();
