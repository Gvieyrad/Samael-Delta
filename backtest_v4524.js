require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const Lima = t => new Date(new Date(t).getTime()-18000000);
const BREAKEVEN = 0.242;
function stats(trades) {
  if (!trades.length) return {n:0,wr:0,pnl:0};
  const w = trades.filter(t=>t.status==="won");
  return {n:trades.length, wr:w.length/trades.length, pnl:trades.reduce((s,t)=>s+(t.pnl_usd||0),0)};
}
function invert(sh, realSize, realLev) {
  const scale = (realSize/62)*(realLev/10);
  return sh.map(t=>({...t, status:t.status==="won"?"lost":"won", pnl_usd:-(t.pnl_usd||0)*scale}));
}
async function main() {
  const now = Date.now();
  const p7=new Date(now-7*86400000).toISOString();
  const p14=new Date(now-14*86400000).toISOString();
  const p30=new Date(now-30*86400000).toISOString();
  const {data:wldSh}=await sb.from("paper_trades").select("direction,status,pnl_usd,opened_at").eq("symbol","WLDUSDT").eq("source","shadow").in("status",["won","lost"]);
  const wldShort=(wldSh||[]).filter(t=>t.direction==="LONG");
  console.log("\n=== 1. WLD SHORT BACKTEST (shadow inversion) ===");
  console.log("Periodo | n    | WR   | PnL sim | Edge vs breakeven");
  [[p7,"7d"],[p14,"14d"],[p30,"30d"],["2000-01-01","Total"]].forEach(([since,label])=>{
    const sub=invert(wldShort.filter(t=>t.opened_at>=since),14,5);
    const s=stats(sub);
    const edge=(s.wr-BREAKEVEN)*100;
    const v=s.wr>=BREAKEVEN+0.10?"RENTABLE":s.wr>=BREAKEVEN?"MARGINAL":"NEGATIVO";
    console.log(label.padEnd(8)+"|"+String(s.n).padStart(5)+" | "+((s.wr*100).toFixed(0)+"%").padStart(4)+" | $"+(s.pnl>=0?"+":"")+s.pnl.toFixed(2).padStart(6)+" | "+edge.toFixed(1)+"pp "+v);
  });
  const directWR=wldShort.filter(t=>t.status==="lost").length/Math.max(wldShort.length,1);
  console.log("Validacion directa (shadow lost=SHORT won): WR="+(directWR*100).toFixed(0)+"% n="+wldShort.length);
  const {data:realAll}=await sb.from("paper_trades").select("pnl_usd,status,opened_at").not("source","in","(meanrev,shadow,sol_paper,bull_run_long)").in("status",["won","lost"]);
  const ACTUAL=new Set([7,8,9,10,11,12,15,16,17,18,19,21,23]);
  const MINUS1112=new Set([7,8,9,10,15,16,17,18,19,21,23]);
  const MAÑANA=new Set([7,8,9,10]);
  const sim=h=>stats((realAll||[]).filter(t=>h.has(Lima(t.opened_at).getHours())));
  const ra=sim(ACTUAL),rp=sim(MINUS1112),rm=sim(MAÑANA);
  console.log("\n=== 2. HOUR FILTER SIMULATION ===");
  console.log("Config        | n  | WR  | PnL");
  console.log("Actual (13h)  |"+String(ra.n).padStart(3)+"|"+(ra.wr*100).toFixed(0)+"%| $"+ra.pnl.toFixed(2));
  console.log("-h11-h12 (11h)|"+String(rp.n).padStart(3)+"|"+(rp.wr*100).toFixed(0)+"%| $"+rp.pnl.toFixed(2)+" (delta: $"+(rp.pnl-ra.pnl).toFixed(2)+")");
  console.log("Solo h7-10(4h)|"+String(rm.n).padStart(3)+"|"+(rm.wr*100).toFixed(0)+"%| $"+rm.pnl.toFixed(2)+" (delta: $"+(rm.pnl-ra.pnl).toFixed(2)+")");
  console.log("\n=== 3. DETALLE POR HORA (n>=1) ===");
  const byH={};
  (realAll||[]).filter(t=>ACTUAL.has(Lima(t.opened_at).getHours())).forEach(t=>{
    const h=Lima(t.opened_at).getHours();
    if(!byH[h])byH[h]={n:0,w:0,pnl:0};
    byH[h].n++;if(t.status==="won")byH[h].w++;byH[h].pnl+=t.pnl_usd||0;
  });
  Object.keys(byH).sort((a,b)=>+a-+b).forEach(h=>{
    const v=byH[h],wr=Math.round(v.w/v.n*100);
    const sig=v.n>=5?(wr>30?"BUENA":wr<15?"MALA":"OK"):"pocos datos";
    console.log("  h"+String(h).padStart(2,"0")+" n="+v.n+" WR="+wr+"% PnL=$"+v.pnl.toFixed(2)+" ["+sig+"]");
  });
  const {data:ethR}=await sb.from("paper_trades").select("pnl_usd,status").eq("symbol","ETHUSDT").not("source","in","(meanrev,shadow,sol_paper,bull_run_long)").in("status",["won","lost"]);
  const e14=stats(ethR||[]);
  const e8=stats((ethR||[]).map(t=>({...t,pnl_usd:(t.pnl_usd||0)*(8/14)})));
  console.log("\n=== 4. ETH SIZE $14 vs $8 ===");
  console.log("$14 (actual):  n="+e14.n+" WR="+(e14.wr*100).toFixed(0)+"% PnL=$"+e14.pnl.toFixed(2)+" (datos de bull run, no representativo)");
  console.log("$8  (propuesta):n="+e8.n+" WR="+(e8.wr*100).toFixed(0)+"% PnL=$"+e8.pnl.toFixed(2)+" delta=$"+(e8.pnl-e14.pnl).toFixed(2));
}
main().catch(e=>console.error(e.message));
