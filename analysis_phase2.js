/**
 * Samael Delta — Phase 2 Analysis
 * 2b: Shadow tracker vs real
 * 2c: SOL paper analysis
 * 2d: Por símbolo breakdown
 */
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const FEE_RT = 0.00028;

function stats(trades) {
  const done = trades.filter(t => t.status === 'won' || t.status === 'lost');
  const wins = done.filter(t => t.status === 'won');
  const pnl  = done.reduce((a, t) => a + (t.pnl_usd || 0), 0);
  const fees = done.reduce((a, t) => a + (t.size_usd || 0) * (t.leverage || 10) * FEE_RT, 0);
  const open = trades.filter(t => t.status === 'open').length;
  const wr   = done.length > 0 ? (wins.length / done.length * 100).toFixed(1) : '-';
  return { n: done.length, wins: wins.length, pnl, fees, neto: pnl - fees, wr, open };
}

function banner(title) {
  const line = '═'.repeat(60);
  console.log(`\n╔${line}╗`);
  console.log(`║  ${title.padEnd(58)}║`);
  console.log(`╚${line}╝`);
}

function printStats(label, s) {
  const pnlStr = (s.neto >= 0 ? '+' : '') + '$' + s.neto.toFixed(2);
  const rawStr = (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2);
  console.log(`  ${label}`);
  console.log(`    n=${s.n}  open=${s.open}  WR=${s.wr}%  wins=${s.wins}  PnL=${rawStr}  fees=-$${s.fees.toFixed(2)}  neto=${pnlStr}`);
}

(async () => {
  const { data: all, error } = await sb
    .from('paper_trades')
    .select('*')
    .order('id', { ascending: true });

  if (error) { console.error('Supabase error:', error.message); process.exit(1); }

  const real      = all.filter(t => !['meanrev', 'shadow', 'sol_paper'].includes(t.source));
  const shadow    = all.filter(t => t.source === 'shadow');
  const solPaper  = all.filter(t => t.source === 'sol_paper');
  const meanrev   = all.filter(t => t.source === 'meanrev');

  // ══════════════════════════════════════════════════════════════
  // 2b. SHADOW TRACKER
  // ══════════════════════════════════════════════════════════════
  banner('2b. SHADOW TRACKER vs REAL');

  const rS = stats(real);
  const sS = stats(shadow);

  printStats('Real  (sweep + whale)', rS);
  printStats('Shadow (counter-trend)', sS);

  // Break-even WR con TP=2.5×ATR / SL=0.8×ATR = 0.8/(2.5+0.8) = 24.2%
  // El veredicto compara shadow WR vs real WR — no usa umbral fijo de 55%
  if (sS.n > 0) {
    const BREAKEVEN = 24.2;
    const shadowWR = sS.wr === '-' ? 0 : parseFloat(sS.wr);
    const realWR   = rS.wr === '-' ? 0 : parseFloat(rS.wr);
    const shadowProfitable = shadowWR > BREAKEVEN;
    const shadowBetterThanReal = shadowWR > realWR + 10; // margen de 10pp para ser concluyente
    const verdict =
      sS.n < 20  ? `🔵 Muestra chica (n=${sS.n}) — re-correr cuando n≥30` :
      !shadowProfitable ? '✅ REAL correcto — shadow bajo break-even (24.2%)' :
      shadowBetterThanReal ? `⚠️  SHADOW ${shadowWR}% vs REAL ${realWR}% (+${(shadowWR-realWR).toFixed(0)}pp) — considerar invertir lógica` :
      `🟡 SHADOW ${shadowWR}% rentable pero similar a REAL ${realWR}% — continuar observando`;
    console.log(`\n  Break-even WR: 24.2%  |  Real WR: ${realWR}%  |  Shadow WR: ${shadowWR}%`);
    console.log(`  Veredicto: ${verdict}`);
  } else {
    console.log('\n  Sin trades shadow cerrados aún — re-correr cuando n≥30');
  }

  // Shadow por símbolo
  if (shadow.length > 0) {
    console.log('\n  Shadow por símbolo:');
    const bySym = {};
    shadow.forEach(t => {
      if (!bySym[t.symbol]) bySym[t.symbol] = [];
      bySym[t.symbol].push(t);
    });
    Object.entries(bySym).sort((a, b) => b[1].length - a[1].length).forEach(([sym, trades]) => {
      const s = stats(trades);
      console.log(`    ${sym.replace('USDT','').padEnd(7)} n=${s.n}  WR=${s.wr}%  neto=${s.neto >= 0 ? '+' : ''}$${s.neto.toFixed(2)}  open=${s.open}`);
    });
  }

  // Shadow por hora
  if (shadow.filter(t => t.status !== 'open').length > 0) {
    console.log('\n  Shadow por hora Lima:');
    const byH = {};
    shadow.filter(t => t.opened_at).forEach(t => {
      const h = new Date(new Date(t.opened_at) - 18000000).getUTCHours();
      if (!byH[h]) byH[h] = [];
      byH[h].push(t);
    });
    Object.entries(byH).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([h, trades]) => {
      const s = stats(trades);
      console.log(`    ${String(h).padStart(2)}h  n=${s.n}  WR=${s.wr}%  neto=${s.neto >= 0 ? '+' : ''}$${s.neto.toFixed(2)}`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 2c. SOL PAPER
  // ══════════════════════════════════════════════════════════════
  banner('2c. SOL PAPER (SOLUSDT paper-only)');

  const spS = stats(solPaper);
  printStats('SOL Paper', spS);

  if (spS.n >= 10) {
    const verdict =
      parseFloat(spS.wr) > 50 && spS.neto > 0
        ? '✅ WR>50% + PnL positivo → CANDIDATO a activar trading real'
        : parseFloat(spS.wr) < 45
        ? '🔴 WR<45% → mantener paper al menos 4 semanas más'
        : '🟡 Neutral — esperar más trades';
    console.log(`\n  Veredicto: ${verdict}`);
  } else {
    console.log(`\n  Insuficiente (n=${spS.n}) — necesita n≥10 para veredicto inicial, n≥30 para activar real`);
  }

  // SOL por hora
  if (solPaper.filter(t => t.status !== 'open').length > 0) {
    console.log('\n  SOL por hora Lima:');
    const byH = {};
    solPaper.filter(t => t.opened_at).forEach(t => {
      const h = new Date(new Date(t.opened_at) - 18000000).getUTCHours();
      if (!byH[h]) byH[h] = [];
      byH[h].push(t);
    });
    Object.entries(byH).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([h, trades]) => {
      const s = stats(trades);
      console.log(`    ${String(h).padStart(2)}h  n=${s.n}  WR=${s.wr}%  neto=${s.neto >= 0 ? '+' : ''}$${s.neto.toFixed(2)}`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 2d. POR SÍMBOLO (real trades)
  // ══════════════════════════════════════════════════════════════
  banner('2d. ANÁLISIS POR SÍMBOLO (trades reales)');

  const bySym = {};
  real.forEach(t => {
    if (!bySym[t.symbol]) bySym[t.symbol] = [];
    bySym[t.symbol].push(t);
  });

  console.log(`  ${'Símbolo'.padEnd(12)} ${'n'.padStart(3)}  ${'WR'.padStart(5)}  ${'PnL bruto'.padStart(10)}  ${'neto'.padStart(10)}  Rol`);
  console.log(`  ${'-'.repeat(65)}`);

  Object.entries(bySym)
    .map(([sym, trades]) => ({ sym, ...stats(trades) }))
    .sort((a, b) => b.neto - a.neto)
    .forEach(s => {
      const rol =
        s.n < 3 ? '?' :
        s.neto > 1 ? '✅ contributor' :
        s.neto < -1 ? '🔴 drag' : '🟡 neutral';
      const netoStr = (s.neto >= 0 ? '+' : '') + '$' + s.neto.toFixed(2);
      const pnlStr  = (s.pnl  >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2);
      console.log(`  ${s.sym.replace('USDT','').padEnd(12)} ${String(s.n).padStart(3)}  ${String(s.wr).padStart(5)}%  ${pnlStr.padStart(10)}  ${netoStr.padStart(10)}  ${rol}`);
    });

  // Breakdown por fuente dentro de real
  console.log('\n  Por fuente (real):');
  ['sweep', 'whale'].forEach(src => {
    const s = stats(real.filter(t => t.source === src));
    if (s.n > 0) printStats(src, s);
  });

  // ══════════════════════════════════════════════════════════════
  // RESUMEN EJECUTIVO
  // ══════════════════════════════════════════════════════════════
  banner('RESUMEN EJECUTIVO');

  console.log(`  Real:      n=${rS.n}  WR=${rS.wr}%  neto=${rS.neto >= 0 ? '+' : ''}$${rS.neto.toFixed(2)}`);
  console.log(`  Shadow:    n=${sS.n}  WR=${sS.wr}%  neto=${sS.neto >= 0 ? '+' : ''}$${sS.neto.toFixed(2)}`);
  console.log(`  SOL paper: n=${spS.n}  WR=${spS.wr}%  neto=${spS.neto >= 0 ? '+' : ''}$${spS.neto.toFixed(2)}`);
  console.log(`  Meanrev:   n=${stats(meanrev).n}  (referencia, nunca ejecuta)`);
  console.log('');

  process.exit(0);
})();
