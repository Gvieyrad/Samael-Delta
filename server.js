<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Panel Futuros EL CHIMUELO v4.4.16</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080a0d;color:#e2e4ea;font-family:system-ui,sans-serif;font-size:13px;line-height:1.4}
.mono{font-family:'SF Mono',monospace}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.15}}
@keyframes glow-red{0%,100%{box-shadow:0 0 6px rgba(255,77,109,.4)}50%{box-shadow:0 0 14px rgba(255,77,109,.9)}}
@keyframes glow-green{0%,100%{box-shadow:0 0 6px rgba(0,214,143,.4)}50%{box-shadow:0 0 14px rgba(0,214,143,.9)}}
.blink-red{animation:blink .6s infinite,glow-red 1s infinite}
@keyframes blink-urgent{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.2;transform:scale(1.04)}}
@keyframes glow-urgent-green{0%,100%{box-shadow:0 0 12px rgba(0,214,143,.6)}50%{box-shadow:0 0 28px rgba(0,214,143,1),0 0 50px rgba(0,214,143,.4)}}
@keyframes glow-urgent-red{0%,100%{box-shadow:0 0 12px rgba(255,77,109,.6)}50%{box-shadow:0 0 28px rgba(255,77,109,1),0 0 50px rgba(255,77,109,.4)}}
.blink-urgent-long{animation:blink-urgent .4s infinite,glow-urgent-green .6s infinite}
.blink-urgent-short{animation:blink-urgent .4s infinite,glow-urgent-red .6s infinite}
.blink-green{animation:blink .6s infinite,glow-green 1s infinite}
.hdr{background:#0d1017;border-bottom:1px solid #1e2330;padding:9px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;position:sticky;top:0;z-index:100}
.logo{font-family:monospace;font-size:13px;font-weight:700;letter-spacing:2px;color:#f59e0b}
.price-big{font-family:monospace;font-size:22px;font-weight:700}
.chg{font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px}
.up{color:#00d68f;background:rgba(0,214,143,.12)}.dn{color:#ff4d6d;background:rgba(255,77,109,.12)}.nt{color:#f59e0b;background:rgba(245,158,11,.1)}
.dot{width:7px;height:7px;border-radius:50%;background:#00d68f;animation:pulse 2s infinite;display:inline-block;margin-right:5px}
.pairbtn{background:transparent;border:1px solid #1e2330;color:#6b7280;font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;font-family:monospace;font-weight:700;transition:all .15s}
.pairbtn.on{background:#f59e0b;border-color:#f59e0b;color:#000}
.btn{background:transparent;border:1px solid #1e2330;color:#e2e4ea;font-size:11px;padding:5px 11px;border-radius:4px;cursor:pointer;transition:all .15s;font-family:inherit}
.btn:hover{border-color:#f59e0b;color:#f59e0b}
.layout{display:grid;grid-template-columns:1fr 320px;gap:1px;background:#1e2330;margin-top:1px}
.lcol,.rcol{background:#080a0d;display:flex;flex-direction:column;gap:1px}
.card{background:#0d1017}
.ch{padding:9px 14px;border-bottom:1px solid #1e2330;display:flex;align-items:center;justify-content:space-between}
.ct{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#4b5563;font-weight:600}
.cb{padding:11px 14px}
.tf-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.tf-card{background:#111520;border:1px solid #1e2330;border-radius:6px;padding:10px;position:relative}
.tf-label{font-size:10px;font-weight:700;color:#4b5563;letter-spacing:.8px;margin-bottom:8px}
.tf-bias{font-size:13px;font-weight:700;margin-bottom:6px}
.tf-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.03)}
.tf-key{font-size:10px;color:#4b5563}
.tf-val{font-size:11px;font-weight:600;font-family:monospace}
.tf-bar{height:3px;border-radius:2px;margin-top:5px;overflow:hidden;background:#1e2330}
.tf-fill{height:100%;border-radius:2px;transition:width .5s}
.div-section{display:flex;flex-direction:column;gap:10px}
.div-card{border-radius:8px;padding:13px;border:1px solid transparent;position:relative}
.div-short{background:rgba(255,77,109,.06);border-color:rgba(255,77,109,.3)}
.div-long{background:rgba(0,214,143,.06);border-color:rgba(0,214,143,.3)}
.div-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.div-name{font-size:12px;font-weight:700}
.div-prob{font-family:monospace;font-size:15px;font-weight:700}
.div-desc{font-size:11px;color:#6b7280;margin-bottom:7px;line-height:1.5}
.div-confluence{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}
.div-conf-tag{font-size:9px;padding:2px 7px;border-radius:3px;background:rgba(245,158,11,.12);color:#f59e0b;font-weight:600;letter-spacing:.3px}
.div-body{display:flex;align-items:center;gap:10px;justify-content:space-between}
.div-levels{display:flex;gap:6px;flex:1}
.div-level{background:rgba(0,0,0,.35);border-radius:5px;padding:5px 8px;text-align:center;flex:1}
.div-level-lbl{font-size:9px;color:#4b5563;margin-bottom:2px;text-transform:uppercase;letter-spacing:.4px}
.div-level-val{font-family:monospace;font-size:11px;font-weight:700}
.div-dir-indicator{display:flex;align-items:center;justify-content:center;min-width:48px;padding-left:8px;border-left:1px solid rgba(255,255,255,.06)}
.div-dir-arrow{font-size:32px;line-height:1}
.div-dir-prob{font-size:11px;font-weight:700}
.div-action-btn{border-radius:7px;padding:12px 18px;font-size:15px;font-weight:800;cursor:pointer;border:none;font-family:inherit;min-width:100px;text-align:center;flex-shrink:0;transition:all .15s;letter-spacing:.5px}
.div-action-btn:hover{opacity:.85;transform:scale(1.03)}
.div-action-btn:active{transform:scale(.97)}
.btn-long{background:#00d68f;color:#000;box-shadow:0 0 12px rgba(0,214,143,.35)}
.btn-short{background:#ff4d6d;color:#fff;box-shadow:0 0 12px rgba(255,77,109,.35)}
.btn-wait-long{background:rgba(0,214,143,.15);color:#00d68f;border:2px solid rgba(0,214,143,.4);font-size:13px}
.btn-wait-short{background:rgba(255,77,109,.15);color:#ff4d6d;border:2px solid rgba(255,77,109,.4);font-size:13px}
.btn-no{background:rgba(255,255,255,.05);color:#4b5563;border:1px solid #1e2330;font-size:13px}
.btn-exec{border-radius:7px;padding:10px 16px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;min-width:90px;text-align:center;transition:all .15s;letter-spacing:.3px;border:none}
.btn-exec:disabled{opacity:.4;cursor:not-allowed;transform:none!important}
.btn-exec-long{background:#00d68f;color:#000;box-shadow:0 0 10px rgba(0,214,143,.3)}
.btn-exec-short{background:#ff4d6d;color:#fff;box-shadow:0 0 10px rgba(255,77,109,.3)}
.btn-exec-lock{background:rgba(255,255,255,.05);color:#4b5563;border:1px solid #1e2330!important}
.action-badge{font-size:11px;font-weight:700;padding:4px 10px;border-radius:4px}
.act-enter{background:rgba(0,214,143,.15);color:#00d68f}
.act-wait{background:rgba(245,158,11,.15);color:#f59e0b}
.act-no{background:rgba(255,77,109,.15);color:#ff4d6d}
.combined-box{border-radius:8px;padding:13px;border:1px solid transparent;margin-bottom:8px}
.comb-long{background:rgba(0,214,143,.08);border-color:rgba(0,214,143,.3)}
.comb-short{background:rgba(255,77,109,.08);border-color:rgba(255,77,109,.3)}
.comb-wait{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.25)}
.comb-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.comb-dir{font-size:18px;font-weight:700}
.comb-prob{font-family:monospace;font-size:22px;font-weight:700}
.ai-box{border-radius:8px;padding:12px 13px;border:1px solid transparent}
.ai-long{background:rgba(0,214,143,.07);border-color:rgba(0,214,143,.25)}
.ai-short{background:rgba(255,77,109,.07);border-color:rgba(255,77,109,.25)}
.ai-wait{background:rgba(245,158,11,.07);border-color:rgba(245,158,11,.2)}
.ai-error{background:rgba(255,77,109,.07);border-color:rgba(255,77,109,.2)}
.ai-loading{background:rgba(139,92,246,.07);border-color:rgba(139,92,246,.2)}
.ai-hdr{display:flex;align-items:center;gap:8px;margin-bottom:7px}
.ai-reasoning{font-size:11px;line-height:1.65;color:#6b7280;margin-bottom:9px}
.ai-levels{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px}
.ai-level{background:rgba(0,0,0,.25);border-radius:5px;padding:6px 8px;text-align:center}
.ai-level-lbl{font-size:9px;color:#4b5563;margin-bottom:2px}
.ai-level-val{font-family:monospace;font-size:12px;font-weight:700}
.scalp-active{animation:pulse .8s infinite}
.badge-confirmed{background:rgba(0,214,143,.15);color:#00d68f;border:1px solid rgba(0,214,143,.3);font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700}
.badge-pending{background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.3);font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700}
.badge-scalp{background:rgba(139,92,246,.15);color:#8b5cf6;border:1px solid rgba(139,92,246,.3);font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700}
.btn-ai{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.35);color:#8b5cf6;font-size:12px;padding:5px 13px;border-radius:5px;cursor:pointer;font-weight:600;font-family:inherit;display:flex;align-items:center;gap:5px}
.btn-ai:hover{background:rgba(139,92,246,.18)}
.btn-ai:disabled{opacity:.5;cursor:not-allowed}
.ob-wrap{padding:8px 14px}
.wall-badge{font-size:10px;font-family:monospace;padding:1px 5px;border-radius:3px;font-weight:700}
.wall-bid{background:rgba(0,214,143,.12);color:#00d68f}
.wall-ask{background:rgba(255,77,109,.12);color:#ff4d6d}
.liq-row{display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.03)}
.liq-major{background:rgba(245,158,11,.08);border-radius:4px;padding:4px 8px;margin:2px 0}
.calc-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.calc-lbl{font-size:11px;color:#4b5563;width:50px;flex-shrink:0}
input[type=number]{background:#111520;border:1px solid #1e2330;border-radius:4px;color:#e2e4ea;font-family:monospace;font-size:12px;padding:5px 8px;width:100%;outline:none}
input[type=number]:focus{border-color:#f59e0b}
.res-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.03)}
.res-lbl{font-size:11px;color:#4b5563}
.res-val{font-family:monospace;font-size:12px;font-weight:700}
.vrvp-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.03)}
.thinking{display:inline-block;animation:pulse .7s infinite}
.no-div{text-align:center;padding:20px;color:#4b5563;font-size:12px}
</style>
</head>
<body>

<div class="hdr">
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <div class="logo">⬡ PANEL FUTUROS EL CHIMUELO</div>
    <span class="price-big mono" id="price">–</span>
    <span class="chg" id="chg">–%</span>
    <div style="display:flex;gap:4px">
      <button class="pairbtn on" onclick="setPair('BTCUSDT',this)">BTC</button>
      <button class="pairbtn" onclick="setPair('ETHUSDT',this)">ETH</button>
      <button class="pairbtn" onclick="setPair('SOLUSDT',this)">SOL</button>
      <button class="pairbtn" onclick="setPair('XAUUSDT',this)" style="color:#f59e0b">XAU</button>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:10px">
    <span><span class="dot"></span><span style="font-size:10px;color:#2a3040" id="upd">conectando...</span></span>
    <button class="btn" onclick="fetchAll()">↻</button>
  </div>
</div>

<!-- 📊 Dashboard Macro -->
<div id="macro-dashboard" style="padding:5px 16px;border-bottom:1px solid #0d1420;background:#060a12;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
  <span style="font-size:8px;color:#1e2330;font-family:monospace;text-transform:uppercase;letter-spacing:1px;font-weight:700">MACRO</span>
  <div id="macro-cvd1h" style="font-size:10px;font-family:monospace;color:#2a3040">CVD 1H: —</div>
  <div style="width:1px;height:10px;background:#1e2330;display:inline-block"></div>
  <div id="macro-cvd4h" style="font-size:10px;font-family:monospace;color:#2a3040">CVD 4H: —</div>
  <div style="width:1px;height:10px;background:#1e2330;display:inline-block"></div>
  <div id="macro-funding" style="font-size:10px;font-family:monospace;color:#2a3040">FR: —</div>
  <div style="width:1px;height:10px;background:#1e2330;display:inline-block"></div>
  <div id="macro-oi" style="font-size:10px;font-family:monospace;color:#2a3040">OI 4H: —</div>
  <div style="width:1px;height:10px;background:#1e2330;display:inline-block"></div>
  <div id="macro-score" style="font-size:10px;font-family:monospace;font-weight:700;padding:1px 8px;border-radius:3px;background:rgba(30,35,48,.5);color:#4b5563">Score: —</div>
</div>

<!-- ⚡ Widget WebSocket Tiempo Real -->
<div id="ws-widget" style="background:#080e18;border-bottom:2px solid #1e2330;padding:8px 16px;display:flex;gap:20px;align-items:center;flex-wrap:wrap">
  <span style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#f59e0b;font-weight:700;display:flex;align-items:center;gap:5px">
    <span style="width:6px;height:6px;border-radius:50%;background:#f59e0b;animation:pulse 1s infinite;display:inline-block"></span>
    Flujo en vivo
  </span>
  <div id="ws-btc" style="display:flex;align-items:center;gap:8px;background:#0d1520;padding:5px 10px;border-radius:6px;border:1px solid #1e2330">
    <span style="font-size:11px;font-weight:800;color:#f59e0b;font-family:monospace;letter-spacing:1px">BTC</span>
    <span id="ws-btc-cvd" style="font-size:13px;font-family:monospace;font-weight:800">–</span>
    <span id="ws-btc-vol" style="font-size:10px;color:#4b5563;font-family:monospace">vol –x</span>
    <span id="ws-btc-status" style="font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700">–</span>
  </div>
  <div id="ws-eth" style="display:flex;align-items:center;gap:8px;background:#0d1520;padding:5px 10px;border-radius:6px;border:1px solid #1e2330">
    <span style="font-size:11px;font-weight:800;color:#8b5cf6;font-family:monospace;letter-spacing:1px">ETH</span>
    <span id="ws-eth-cvd" style="font-size:13px;font-family:monospace;font-weight:800">–</span>
    <span id="ws-eth-vol" style="font-size:10px;color:#4b5563;font-family:monospace">vol –x</span>
    <span id="ws-eth-status" style="font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700">–</span>
  </div>
  <div id="ws-anomaly-banner" style="display:none;margin-left:auto;font-size:11px;font-weight:800;padding:4px 14px;border-radius:6px"></div>
</div>

<div class="layout">
<div class="lcol">

  <div class="card">
    <div class="ch"><span class="ct">Análisis por temporalidad</span></div>
    <div class="cb"><div class="tf-grid" id="tf-grid"></div></div>
  </div>

  <div class="card">
    <div class="ch"><span class="ct">⚡ Análisis técnico — indicadores</span></div>
    <div class="cb"><div class="div-section" id="div-section"></div></div>
  </div>

  <div class="card">
    <div class="ch">
      <span class="ct">🤖 Señal IA — Claude</span>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn-ai" id="ai-btn" onclick="runAI()"><span id="ai-icon">✦</span> Analizar</button>
        <button class="btn-ai" id="alert-btn" onclick="triggerAlert()" style="background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.35);color:#f59e0b" title="Disparar alerta Telegram ahora"><span id="alert-icon">🔔</span></button>
        <button class="btn-ai" id="scalp-btn" onclick="toggleScalping()" style="background:rgba(139,92,246,.1);border-color:rgba(139,92,246,.35);color:#8b5cf6" title="Modo Scalping — análisis cada 3 min"><span id="scalp-icon">⚡</span> Scalp</button>
        <span id="scalp-signal-badge" style="font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700;display:none;margin-left:4px"></span>
        <button id="lock-btn" onclick="toggleLock()" title="Candado — desbloquear para modo prueba/clases" style="background:transparent;border:1px solid #1e2330;color:#4b5563;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:13px">🔒</button>
      </div>
    </div>
    <div class="cb">
      <div id="combined-box" class="combined-box comb-wait" style="display:none"></div>
      <div id="ai-result" class="ai-box ai-wait">
        <div class="ai-hdr"><span>◆</span><span style="font-size:13px;font-weight:700;color:#f59e0b">Esperando análisis</span></div>
        <div class="ai-reasoning">Presiona "Analizar" — Claude con divergencias, imanes y sesgo multi-TF.</div>
      </div>
      <div id="ai-exec-row" style="display:none;margin-top:10px;gap:8px;flex-direction:column">
        <div style="display:flex;gap:8px">
          <button id="exec-long-btn" class="btn-exec btn-exec-long" style="flex:1" onclick="openPaperTradeFromAI('LONG')">▲ Ejecutar LONG</button>
          <button id="exec-short-btn" class="btn-exec btn-exec-short" style="flex:1" onclick="openPaperTradeFromAI('SHORT')">▼ Ejecutar SHORT</button>
        </div>
        <div id="exec-status" style="font-size:10px;color:#4b5563;text-align:center"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="ch"><span class="ct">Calculadora de posición</span></div>
    <div class="cb">
      <div class="calc-row"><span class="calc-lbl">Capital $</span><input type="number" id="c-cap" value="1000" oninput="calc()"></div>
      <div class="calc-row"><span class="calc-lbl">Leverage</span><input type="number" id="c-lev" value="10" oninput="calc()"></div>
      <div class="calc-row"><span class="calc-lbl">Entry $</span><input type="number" id="c-ent" placeholder="auto" oninput="calc()"></div>
      <div class="calc-row"><span class="calc-lbl">TP $</span><input type="number" id="c-tp" oninput="aiRR=null;calc()"></div>
      <div class="calc-row"><span class="calc-lbl">SL $</span><input type="number" id="c-sl" oninput="aiRR=null;calc()"></div>
      <div style="margin-top:5px">
        <div class="res-row"><span class="res-lbl">Tamaño</span><span class="res-val" id="r-sz" style="color:#f59e0b">–</span></div>
        <div class="res-row"><span class="res-lbl">Profit</span><span class="res-val" id="r-pr" style="color:#00d68f">–</span></div>
        <div class="res-row"><span class="res-lbl">Pérdida</span><span class="res-val" id="r-ls" style="color:#ff4d6d">–</span></div>
        <div class="res-row"><span class="res-lbl">R:R</span><span class="res-val" id="r-rr">–</span></div>
        <div class="res-row"><span class="res-lbl">Liquidación</span><span class="res-val" id="r-lq" style="color:#ff4d6d">–</span></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="ch">
      <span class="ct">📰 Noticias — Impacto en tiempo real</span>
      <button class="btn" onclick="refreshNews()" style="padding:3px 8px;font-size:10px">↻</button>
    </div>
    <div id="news-panel" style="padding:0">
      <div style="padding:12px 14px;text-align:center;font-size:11px;color:#2a3040">Cargando noticias...</div>
    </div>
  </div>

  <div class="card" id="paper-card">
    <div class="ch">
      <span class="ct">Posiciones — Paper Trading</span>
      <div style="display:flex;gap:6px;align-items:center">
        <span id="paper-stats-summary" style="font-size:10px;color:#4b5563"></span>
        <button class="btn" onclick="refreshPaper()" style="padding:3px 8px;font-size:10px">↻</button>
      </div>
    </div>
    <div id="paper-panel" style="padding:0"></div>
  </div>

  <div class="card" id="binance-account-card">
    <div class="ch">
      <span class="ct">💼 Cuenta Binance Real</span>
      <span id="binance-acct-status" style="font-size:10px;color:#4b5563">—</span>
    </div>
    <div id="binance-acct-body" class="cb">
      <div style="color:#2a3040;font-size:11px;text-align:center">Cargando...</div>
    </div>
  </div>

  <div class="card">
    <div class="ch">
      <span class="ct">ML Insights</span>
      <div style="display:flex;gap:5px">
        <button class="btn" onclick="runMLOptimize()" id="ml-opt-btn" style="padding:3px 8px;font-size:10px;background:rgba(139,92,246,.1);border-color:rgba(139,92,246,.3);color:#8b5cf6">🧠 Optimizar</button>
        <button class="btn" onclick="refreshML()" style="padding:3px 8px;font-size:10px">↻</button>
      </div>
    </div>
    <div id="ml-panel" style="padding:0"></div>
  </div>


  <div class="card" id="backtest-card">
    <div class="ch">
      <span class="ct">🔬 Backtest — Simulación histórica</span>
      <div style="display:flex;gap:5px;align-items:center">
        <select id="bt-symbol" style="background:#111520;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:3px 6px;border-radius:4px;font-family:monospace">
          <option value="BTCUSDT">BTC</option>
          <option value="ETHUSDT">ETH</option>
        </select>
        <select id="bt-days" style="background:#111520;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:3px 6px;border-radius:4px;font-family:monospace">
          <option value="30">30d</option>
          <option value="60">60d</option>
          <option value="90">90d</option>
          <option value="180">180d</option>
          <option value="365" selected>365d ★</option>
        </select>
        <select id="bt-mode" style="background:#111520;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:3px 6px;border-radius:4px;font-family:monospace">
          <option value="both">Scalp+Sweep</option>
          <option value="base">📊 Base</option>
          <option value="momentum">📈 Momentum</option>
          <option value="filtered">🔬 Filtered</option>
          <option value="scalping">Scalping</option>
          <option value="sweep">Sweep</option>
        </select>
        <button class="btn" onclick="runBacktest()" id="bt-btn" style="padding:3px 8px;font-size:10px;background:rgba(139,92,246,.1);border-color:rgba(139,92,246,.3);color:#8b5cf6">▶ Correr</button>
      </div>
    </div>
    <div class="cb" style="padding:10px 14px">
      <!-- Parámetros ajustables -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <div style="background:#111520;border-radius:6px;padding:8px">
          <div style="font-size:9px;color:#8b5cf6;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">⚡ Scalping</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:10px;color:#4b5563">RSI min/max</span>
            <div style="display:flex;gap:4px">
              <input type="number" id="bt-rsi-min" value="35" style="width:40px;background:#0d1017;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:2px 4px;border-radius:3px;text-align:center">
              <input type="number" id="bt-rsi-max" value="65" style="width:40px;background:#0d1017;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:2px 4px;border-radius:3px;text-align:center">
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:10px;color:#4b5563">Imbalance min %</span>
            <input type="number" id="bt-imb" value="30" style="width:45px;background:#0d1017;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:2px 4px;border-radius:3px;text-align:center">
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:10px;color:#4b5563">Momentum % 60s</span>
            <input type="number" id="bt-mom" value="0.05" step="0.01" style="width:50px;background:#0d1017;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:2px 4px;border-radius:3px;text-align:center">
          </div>
        </div>
        <div style="background:#111520;border-radius:6px;padding:8px">
          <div style="font-size:9px;color:#38bdf8;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🌊 Sweep</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:10px;color:#4b5563">Vol min x</span>
            <input type="number" id="bt-vol" value="4" step="0.5" style="width:45px;background:#0d1017;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:2px 4px;border-radius:3px;text-align:center">
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:10px;color:#4b5563">CVD min %</span>
            <input type="number" id="bt-cvd" value="40" style="width:45px;background:#0d1017;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:2px 4px;border-radius:3px;text-align:center">
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:10px;color:#4b5563">Bias1d score</span>
            <input type="number" id="bt-bias" value="58" style="width:45px;background:#0d1017;border:1px solid #1e2330;color:#e2e4ea;font-size:10px;padding:2px 4px;border-radius:3px;text-align:center">
          </div>
        </div>
      </div>
      <!-- Resultados -->
      <div id="bt-results" style="font-size:11px;color:#2a3040;text-align:center;padding:10px">
        Configura los parámetros y presiona ▶ Correr
      </div>
    </div>
  </div>
</div>
<div class="rcol">

  <div class="card">
    <div class="ch"><span class="ct">Libro de órdenes + CVD</span></div>
    <div class="ob-wrap" id="ob-panel"></div>
  </div>

  <div class="card">
    <div class="ch"><span class="ct">Órdenes pasivas — clusters</span></div>
    <div class="cb" style="padding:7px 14px" id="deep-ob-panel"></div>
  </div>

  <div class="card">
    <div class="ch"><span class="ct">Radar de ballenas</span></div>
    <div class="cb" style="padding:7px 14px" id="whale-panel"></div>
  </div>

  <div class="card">
    <div class="ch"><span class="ct">Mapa de liquidaciones</span><span style="font-size:9px;color:#2a3040">datos reales Binance</span></div>
    <div class="cb" style="padding:7px 14px" id="liq-panel"></div>
  </div>

  <div class="card">
    <div class="ch"><span class="ct">Volume Profile (VRVP)</span></div>
    <div class="cb" id="vrvp-panel"></div>
  </div>

  <div class="card">
    <div class="ch"><span class="ct">Fibonacci — 15m</span><span style="font-size:9px;color:#2a3040">retrocesos y extensiones</span></div>
    <div class="cb" style="padding:7px 14px" id="fib-panel"></div>
  </div>

</div>
</div>

<script>
(function() {
  const PASS = 'LO2024$';
  const saved = sessionStorage.getItem('panel_auth');
  if (saved !== PASS) {
    const input = prompt('Panel Futuros EL CHIMUELO — Contraseña:');
    if (input !== PASS) {
      document.body.innerHTML = '<div style="background:#080a0d;color:#ff4d6d;height:100vh;display:flex;align-items:center;justify-content:center;font-size:18px;font-family:monospace">⛔ Acceso denegado</div>';
      throw new Error('Unauthorized');
    }
    sessionStorage.setItem('panel_auth', PASS);
  }
})();

const API='https://panel-futuros-lo-production.up.railway.app';
let pair='BTCUSDT',mkt={};
let aiSignal=null; let aiRR=null;
let allPrices={};
let lockUnlocked = false;
let autoAiTriggered = false;
let lastAutoAiTime = 0;

function setPair(p,btn){pair=p;document.querySelectorAll('.pairbtn').forEach(b=>b.classList.remove('on'));btn.classList.add('on');fetchAll();}
function fmt(n,d=2){if(n===null||n===undefined||isNaN(n))return'–';return parseFloat(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function fmtB(n){if(!n&&n!==0)return'–';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(0)+'K';return n.toFixed(0);}
function pctColor(v,invert=false){const val=parseFloat(v);if(isNaN(val))return'#4b5563';const pos=invert?val<0:val>0,neg=invert?val>0:val<0,strong=Math.abs(val)>5;if(pos&&strong)return'#00d68f';if(pos)return'#34d399';if(neg&&strong)return'#ff4d6d';if(neg)return'#f87171';return'#f59e0b';}
function pctClass(v,invert=false){const val=parseFloat(v);if(isNaN(val))return'';const pos=invert?val<0:val>0,neg=invert?val>0:val<0,strong=Math.abs(val)>5;if(strong&&pos)return'blink-green';if(strong&&neg)return'blink-red';return'';}
function frColor(fr){if(fr>0.001)return'#ff4d6d';if(fr<-0.001)return'#00d68f';return'#f59e0b';}

function toggleLock() {
  lockUnlocked = !lockUnlocked;
  const btn = document.getElementById('lock-btn');
  if (lockUnlocked) {
    btn.textContent = '🔓';
    btn.style.color = '#f59e0b';
    btn.style.borderColor = 'rgba(245,158,11,.4)';
    showToast('🔓 Modo prueba/clases desbloqueado', '#f59e0b');
  } else {
    btn.textContent = '🔒';
    btn.style.color = '#4b5563';
    btn.style.borderColor = '#1e2330';
    showToast('🔒 Ejecución bloqueada — solo ≥85%', '#4b5563');
  }
  updateExecButtons();
}

function updateExecButtons() {
  const row = document.getElementById('ai-exec-row');
  const longBtn = document.getElementById('exec-long-btn');
  const shortBtn = document.getElementById('exec-short-btn');
  const status = document.getElementById('exec-status');
  if (!row || !aiSignal) return;
  row.style.display = 'flex';
  const conf = aiSignal.confidence || 0;
  const dir = aiSignal.direction;
  const _aiRrVal = (()=>{
    if(!aiSignal||!aiSignal.entry||!aiSignal.tp1||!aiSignal.sl) return 0;
    const _r=Math.abs(aiSignal.tp1-aiSignal.entry);
    const _k=Math.abs(aiSignal.entry-aiSignal.sl);
    return _k>0?_r/_k:0;
  })();
  if (dir === 'ESPERAR' || aiSignal.action === 'NO ENTRAR') {
    if (!lockUnlocked) {
      row.style.display = 'none';
      return;
    }
  }

  const canExec = lockUnlocked || (conf >= 90 && _aiRrVal >= 1.5);
  if (dir === 'LONG') {
    longBtn.disabled = !canExec;
    longBtn.className = canExec ? 'btn-exec btn-exec-long' : 'btn-exec btn-exec-lock';
    shortBtn.disabled = true;
    shortBtn.className = 'btn-exec btn-exec-lock';
  } else if (dir === 'SHORT') {
    shortBtn.disabled = !canExec;
    shortBtn.className = canExec ? 'btn-exec btn-exec-short' : 'btn-exec btn-exec-lock';
    longBtn.disabled = true;
    longBtn.className = 'btn-exec btn-exec-lock';
  } else {
    longBtn.disabled = false;
    shortBtn.disabled = false;
  }
  if (lockUnlocked) {
    status.textContent = '🔓 Modo prueba — ejecución desbloqueada';
    status.style.color = '#f59e0b';
  } else if (conf >= 85) {
    if (_aiRrVal < 1.5) {
      status.textContent = `⛔ R:R 1:${_aiRrVal.toFixed(1)} insuficiente — mínimo 1:1.5 (desbloquea con 🔓)`;
      status.style.color = '#ff4d6d';
    } else {
      status.textContent = `✅ ${conf}% confianza · R:R 1:${_aiRrVal.toFixed(1)} — ejecución habilitada`;
      status.style.color = '#00d68f';
    }
    status.style.color = '#00d68f';
  } else {
    status.textContent = `🔒 ${conf}% confianza — se requiere ≥85% para ejecutar`;
    status.style.color = '#4b5563';
  }
}

async function openPaperTradeFromAI(directionOverride) {
  if (!aiSignal) return;
  const direction = directionOverride || aiSignal.direction;
  if (!direction || direction === 'ESPERAR') return;
  await openPaperTrade(direction);
}

function checkAutoAI() {
  if (!mkt.divergences || mkt.divergences.length < 2) return;
  const highProb = mkt.divergences.filter(d => d.probability >= 90);
  if (highProb.length < 2) return;

  const shortDivs = highProb.filter(d => d.direction === 'SHORT').length;
  const longDivs  = highProb.filter(d => d.direction === 'LONG').length;
  const dominantDir = shortDivs > longDivs ? 'SHORT' : 'LONG';
  const dominantCount = Math.max(shortDivs, longDivs);
  const oppositeCount = Math.min(shortDivs, longDivs);
  const hasClearMajority = dominantCount >= 2 && dominantCount > oppositeCount * 1.5;

  if (!hasClearMajority) {
    console.log('⏭ Auto-análisis omitido — señales divididas: ' + shortDivs + 'S vs ' + longDivs + 'L');
    return;
  }

  const now = Date.now();
  if (now - lastAutoAiTime < 5 * 60 * 1000) return;
  const btn = document.getElementById('ai-btn');
  if (btn && btn.disabled) return;
  lastAutoAiTime = now;
  console.log('⚡ Auto-análisis: ' + highProb.length + ' divergencias ≥90% — mayoría ' + dominantDir + ' (' + dominantCount + 'vs' + oppositeCount + ')');
  showToast('⚡ ' + dominantCount + ' señales ' + dominantDir + ' ≥90% — analizando automáticamente...', '#f59e0b');
  runAI(true);
}

async function refreshWsWidget() {
  try {
    const data = await fetch(`${API}/api/ws/status`).then(r=>r.json());
    for (const [sym, info] of Object.entries(data)) {
      const key = sym === 'BTCUSDT' ? 'btc' : sym === 'ETHUSDT' ? 'eth' : null;
      if (!key || !info.metrics) continue;
      const cvd = parseFloat(info.metrics.cvdLive);
      const vol = parseFloat(info.metrics.volumeMultiplier);
      const anomaly = info.metrics.anomaly;
      const cvdCol = cvd > 10 ? '#00d68f' : cvd < -10 ? '#ff4d6d' : '#f59e0b';
      const cvdEl = document.getElementById(`ws-${key}-cvd`);
      if (cvdEl) { cvdEl.textContent = (cvd>=0?'+':'')+cvd+'%'; cvdEl.style.color = cvdCol; }
      const volEl = document.getElementById(`ws-${key}-vol`);
      if (volEl) { volEl.textContent = `vol ${vol.toFixed(1)}x`; volEl.style.color = vol>=5?'#ff4d6d':vol>=2?'#f59e0b':'#4b5563'; }
      const stEl = document.getElementById(`ws-${key}-status`);
      if (stEl) {
        if (anomaly && anomaly.isSweep) {
          stEl.textContent = anomaly.direction==='SHORT'?'🔴 BARRIDA':'🟢 BARRIDA';
          stEl.style.background = anomaly.direction==='SHORT'?'rgba(255,77,109,.2)':'rgba(0,214,143,.2)';
          stEl.style.color = anomaly.direction==='SHORT'?'#ff4d6d':'#00d68f';
          stEl.style.border = anomaly.direction==='SHORT'?'1px solid rgba(255,77,109,.4)':'1px solid rgba(0,214,143,.4)';
        } else if (anomaly && anomaly.isWhale) {
          stEl.textContent = anomaly.direction==='SHORT'?'🐋 Venta':'🐋 Compra';
          stEl.style.background = 'rgba(245,158,11,.15)';
          stEl.style.color = '#f59e0b';
          stEl.style.border = '1px solid rgba(245,158,11,.3)';
        } else {
          stEl.textContent = 'Normal'; stEl.style.background='rgba(0,214,143,.15)'; stEl.style.color='#00d68f'; stEl.style.border='1px solid rgba(0,214,143,.3)';
        }
      }
      const banner = document.getElementById('ws-anomaly-banner');
      if (banner) {
        const anyAnomaly = Object.values(data).find(i => i.metrics?.anomaly?.isSweep);
        if (anyAnomaly?.metrics?.anomaly) {
          const a = anyAnomaly.metrics.anomaly;
          banner.style.display='block';
          banner.textContent = `⚡ ${a.direction} — ${a.reason}`;
          banner.style.background = a.direction==='SHORT'?'rgba(255,77,109,.2)':'rgba(0,214,143,.2)';
          banner.style.color = a.direction==='SHORT'?'#ff4d6d':'#00d68f';
          banner.style.border = `1px solid ${a.direction==='SHORT'?'rgba(255,77,109,.4)':'rgba(0,214,143,.4)'}`;
        } else {
          banner.style.display='none';
        }
      }
    }
  } catch(_) {}
}

async function fetchAll(){
  document.getElementById('upd').textContent='actualizando...';
  try{mkt=await fetch(`${API}/api/market/${pair}`).then(r=>r.json());renderAll(); updateMacroDashboard();document.getElementById('upd').textContent=new Date().toLocaleTimeString('es-PE');}
  catch(e){document.getElementById('upd').textContent='error — reintentando...';}
}

function renderAll(){
  if(!mkt.price)return;
  const p=mkt.price,ch=mkt.change24h||0;
  document.getElementById('price').textContent='$'+fmt(p);
  const cb=document.getElementById('chg');
  const chVal = parseFloat(ch)||0;
  cb.textContent=(chVal>=0?'+':'')+chVal.toFixed(2)+'%';
  cb.className='chg '+(chVal>1?'up':chVal<-1?'dn':'nt');
  cb.style.display='inline-block';
  renderTFGrid();renderDivergences();renderCombined();
  checkAutoAI();renderVRVP();renderOB();renderLiq();renderDeepOB();renderWhales();renderFib();
  const sb=document.getElementById('scalp-signal-badge');
  if(sb&&mkt.scalpSignal&&mkt.scalpSignal.direction&&mkt.scalpSignal.direction!=='ESPERAR'){
    const sc=mkt.scalpSignal;
    const col=sc.direction==='LONG'?'#00d68f':'#ff4d6d';
    sb.style.display='inline';sb.style.background=col+'22';sb.style.color=col;sb.style.border='1px solid '+col+'55';
    sb.textContent='⚡'+sc.direction+' '+sc.probability+'%';
  } else if(sb){sb.style.display='none';}
  setTimeout(()=>{const e=document.getElementById('c-ent');if(!e.value&&mkt.price){e.value=mkt.price.toFixed(1);calc();}},300);
}

function renderTFGrid(){
  const b=mkt.bias;if(!b)return;
  const tfs=[{tf:'15m',d:b.tf15m},{tf:'1H',d:b.tf1h},{tf:'4H',d:b.tf4h},{tf:'1D',d:b.tf1d}];
  document.getElementById('tf-grid').innerHTML=tfs.map(t=>{
    const d=t.d;if(!d)return'';
    const bColor=d.bias==='long'?'#00d68f':d.bias==='short'?'#ff4d6d':'#f59e0b';
    const bLabel=d.bias==='long'?'LONG':d.bias==='short'?'SHORT':'NEUTRO';
    const rsiColor=d.rsi>70?'#ff4d6d':d.rsi<30?'#00d68f':d.rsi>60?'#34d399':'#e2e4ea';
    const rsiClass=(d.rsi>75||d.rsi<25)?'blink-red':'';
    const cvdColor=pctColor(d.cvdPct),cvdClass=pctClass(d.cvdPct);
    const volColor=pctColor(d.volPct),volClass=pctClass(d.volPct);
    const pct=d.bias==='long'?d.score:d.bias==='short'?(100-d.score):50;
    const oiTrend=d.oiTrend||'flat';const oiDelta=d.oiDeltaPct||'0.000';
    const oiColor=oiTrend==='rising'?'#ff4d6d':oiTrend==='falling'?'#00d68f':'#4b5563';
    const oiIcon=oiTrend==='rising'?'↑':oiTrend==='falling'?'↓':'→';
    const fr=d.fundingRate||0;const frCol=frColor(fr);const frStr=(fr>=0?'+':'')+(fr*100).toFixed(4)+'%';
    const pvp = parseFloat(d.priceVsPrev||0);
    const pvpStr = (pvp>=0?'+':'')+pvp.toFixed(2)+'%';
    const pvpCol = pvp>0.3?'#00d68f':pvp<-0.3?'#ff4d6d':'#6b7280';
    return `<div class="tf-card">
      <div class="tf-label">${t.tf}</div>
      <div class="tf-bias" style="color:${bColor};display:flex;justify-content:space-between;align-items:baseline">
        <span>${bLabel} <span style="font-size:10px;color:#4b5563;font-weight:400">${d.score}/100</span></span>
        <span style="font-size:12px;font-weight:700;color:${pvpCol}">${pvpStr}</span>
      </div>
      <div class="tf-row"><span class="tf-key">RSI</span><span class="tf-val ${rsiClass}" style="color:${rsiColor}">${d.rsi}</span></div>
      <div class="tf-row"><span class="tf-key">CVD%</span><span class="tf-val ${cvdClass}" style="color:${cvdColor}">${d.cvdPct>=0?'+':''}${d.cvdPct}%</span></div>
      <div class="tf-row"><span class="tf-key">Vol%</span><span class="tf-val ${volClass}" style="color:${volColor}">${d.volPct>=0?'+':''}${d.volPct}%</span></div>
      <div class="tf-row"><span class="tf-key">OI</span><span class="tf-val" style="color:${oiColor}">${oiIcon} ${parseFloat(oiDelta)>=0?'+':''}${oiDelta}%</span></div>
      <div class="tf-row"><span class="tf-key">FR</span><span class="tf-val" style="color:${frCol};font-size:10px">${frStr}</span></div>
      <div class="tf-bar"><div class="tf-fill" style="width:${pct}%;background:${bColor}"></div></div>
    </div>`;
  }).join('');
}

function calcTP(entry,direction,liqTarget){if(liqTarget)return parseFloat(liqTarget);const p=parseFloat(entry);return direction==='SHORT'?p*0.975:p*1.025;}
function calcSL(entry,direction){const p=parseFloat(entry);return direction==='SHORT'?p*1.012:p*0.988;}

function renderDivergences(){
  const divs=mkt.divergences,el=document.getElementById('div-section');
  if(!divs||!divs.length){el.innerHTML='<div class="no-div">Sin divergencias activas en este momento</div>';return;}
  el.innerHTML=divs.slice(0,6).map(d=>{
    const isShort=d.direction==='SHORT',col=isShort?'#ff4d6d':'#00d68f';
    const tp1=calcTP(d.entry,d.direction,d.liqTarget),sl=calcSL(d.entry,d.direction);
    const reward = Math.abs(tp1 - d.entry);
    const risk   = Math.abs(d.entry - sl);
    const rr     = risk > 0 ? (reward / risk).toFixed(1) : '0';
    const probClass=d.probability>=90?(isShort?'blink-red':'blink-green'):'';
    const confluenceHtml=d.confluence?.length?`<div class="div-confluence">${d.confluence.map(c=>`<span class="div-conf-tag">${c}</span>`).join('')}</div>`:'';
    const arrow = isShort ? '▼' : '▲';
    return `<div class="div-card ${isShort?'div-short':'div-long'}">
      <div class="div-header">
        <span class="div-name" style="color:${col}">${arrow} ${d.name}</span>
        <span class="div-prob ${probClass}" style="color:${col};font-size:17px;font-weight:800">${d.probability}%</span>
      </div>
      <div class="div-desc">${d.description}</div>
      ${confluenceHtml}
      <div class="div-body">
        <div class="div-levels">
          <div class="div-level">
            <div class="div-level-lbl">Entry</div>
            <div class="div-level-val">$${parseInt(d.entry).toLocaleString()}</div>
          </div>
          <div class="div-level">
            <div class="div-level-lbl">TP</div>
            <div class="div-level-val" style="color:#00d68f">$${parseInt(tp1).toLocaleString()}</div>
          </div>
          <div class="div-level">
            <div class="div-level-lbl">SL</div>
            <div class="div-level-val" style="color:#ff4d6d">$${parseInt(sl).toLocaleString()}</div>
          </div>
          <div class="div-level">
            <div class="div-level-lbl">R:R</div>
            <div class="div-level-val" style="color:${parseFloat(rr)>=1.5?'#00d68f':parseFloat(rr)>=1?'#f59e0b':'#ff4d6d'}">1:${rr}</div>
          </div>
        </div>
        <div class="div-dir-indicator">
          <span class="div-dir-arrow ${probClass}" style="color:${col}">${arrow}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function prefillCalc(entry,tp,sl){
  document.getElementById('c-ent').value=parseFloat(entry).toFixed(1);
  document.getElementById('c-tp').value=parseFloat(tp).toFixed(1);
  document.getElementById('c-sl').value=parseFloat(sl).toFixed(1);
  calc();
  document.getElementById('c-ent').scrollIntoView({behavior:'smooth',block:'center'});
}

function renderCombined(){
  const cs=mkt.combinedSignal,box=document.getElementById('combined-box');
  if(!cs||!mkt.divergences?.length){box.style.display='none';return;}
  box.style.display='block';
  const hasActiveAI = aiSignal && aiSignal.confidence >= 90 && aiSignal.direction !== 'ESPERAR' && aiSignal.action !== 'NO ENTRAR';
  const direction = hasActiveAI ? aiSignal.direction : cs.direction;
  const probability = hasActiveAI ? aiSignal.confidence : cs.probability;
  const isAIOverride = hasActiveAI && direction !== cs.direction;
  const isShort=direction==='SHORT',isLong=direction==='LONG';
  const col=isLong?'#00d68f':isShort?'#ff4d6d':'#f59e0b';
  const bgClass=isShort?'comb-short':isLong?'comb-long':'comb-wait';
  box.className=`combined-box ${bgClass}`;
  const aiNote = hasActiveAI ? `<span style="font-size:9px;background:rgba(139,92,246,.15);color:#8b5cf6;padding:1px 6px;border-radius:3px;font-weight:700;margin-left:6px">🤖 IA</span>` : '';
  const overrideNote = isAIOverride ? `<div style="font-size:10px;color:#8b5cf6;margin-top:3px">⚡ IA sobrescribe señal combinada (algoritmo: ${cs.direction} ${cs.probability}%)</div>` : '';
  box.innerHTML=`
    <div class="comb-header">
      <span style="font-size:26px">${isShort?'▼':isLong?'▲':'◆'}</span>
      <div style="flex:1">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span class="comb-dir" style="color:${col}">${direction}</span>
          <span class="comb-prob" style="color:${col}">${probability}%</span>
          ${aiNote}
        </div>
        <div style="font-size:11px;color:#4b5563;margin-top:2px">${cs.shortCount||0} SHORT · ${cs.longCount||0} LONG activas${cs.fibSummary?'<span style="color:#f59e0b;margin-left:6px">⬟ '+cs.fibSummary+'</span>':''}</div>
        ${overrideNote}
      </div>
      <span id="signal-confirmation-badge"></span>
    </div>`;
}

function renderVRVP(){
  const v=mkt.vrvp,p=mkt.price;if(!v||!p)return;
  const pocDist=(((p-v.poc)/v.poc)*100).toFixed(2),vahDist=(((p-v.vah)/v.vah)*100).toFixed(2),valDist=(((p-v.val)/v.val)*100).toFixed(2);
  document.getElementById('vrvp-panel').innerHTML=`<div style="display:flex;flex-direction:column;gap:0">
    <div class="vrvp-row"><span style="font-size:11px;color:#4b5563">VAH <span style="font-size:9px">(resistencia)</span></span><span class="mono" style="font-size:13px;font-weight:700;color:#ff4d6d">$${parseInt(v.vah).toLocaleString()}</span><span style="font-size:10px;color:${parseFloat(vahDist)>0?'#00d68f':'#ff4d6d'}">${vahDist>0?'+':''}${vahDist}%</span></div>
    <div class="vrvp-row" style="background:rgba(245,158,11,.06);border-radius:4px;padding:6px 0"><span style="font-size:11px;color:#f59e0b;font-weight:700">POC <span style="font-size:9px">(máx. volumen)</span></span><span class="mono" style="font-size:13px;font-weight:700;color:#f59e0b">$${parseInt(v.poc).toLocaleString()}</span><span style="font-size:10px;color:${parseFloat(pocDist)>0?'#00d68f':'#ff4d6d'}">${pocDist>0?'+':''}${pocDist}%</span></div>
    <div class="vrvp-row"><span style="font-size:11px;color:#4b5563">VAL <span style="font-size:9px">(soporte)</span></span><span class="mono" style="font-size:13px;font-weight:700;color:#00d68f">$${parseInt(v.val).toLocaleString()}</span><span style="font-size:10px;color:${parseFloat(valDist)>0?'#00d68f':'#ff4d6d'}">${valDist>0?'+':''}${valDist}%</span></div>
    <div style="font-size:10px;color:#2a3040;margin-top:6px;padding-top:5px;border-top:1px solid #1e2330">${p>v.poc?'▲ Precio sobre POC — zona de valor superada':'▼ Precio bajo POC — busca soporte en VAL'}${Math.abs(p-v.vah)/v.vah<0.005?' · ⚠ Precio tocando VAH — resistencia clave':''}</div>
  </div>`;
}

function renderOB(){
  const ob=mkt.orderBook,p=mkt.price,cvd=mkt.cvd15m;if(!ob)return;
  const imb=parseFloat(ob.imbalance||0);
  const col=imb>15?'#00d68f':imb<-15?'#ff4d6d':'#f59e0b';
  const press=ob.pressure==='bid_dominant'?'Presión compradora':ob.pressure==='ask_dominant'?'Presión vendedora':'Equilibrado';
  const cvdVal=cvd?.cvdPct||0;
  const cvdCol=cvdVal>5?'#00d68f':cvdVal<-5?'#ff4d6d':cvdVal>0?'#34d399':'#f87171';
  const cvdTrend=cvd?.trend==='bull'?'▲':'▼';
  const cvdLabel=cvd?.trend==='bull'?'Compras':'Ventas';
  const cvdAgresivo=Math.abs(cvdVal)>10;
  const cvdClass=cvdAgresivo?(cvd?.trend==='bull'?'blink-green':'blink-red'):'';
  let wallsHtml='';
  (ob.bidWalls||[]).slice(0,2).forEach(w=>{wallsHtml+=`<div style="display:flex;justify-content:space-between;padding:3px 0"><span class="wall-badge wall-bid">BID WALL</span><span class="mono" style="font-size:11px">$${w.price.toLocaleString()}</span><span style="font-size:10px;color:#4b5563">${w.size.toFixed(1)} BTC</span></div>`;});
  (ob.askWalls||[]).slice(0,2).forEach(w=>{wallsHtml+=`<div style="display:flex;justify-content:space-between;padding:3px 0"><span class="wall-badge wall-ask">ASK WALL</span><span class="mono" style="font-size:11px">$${w.price.toLocaleString()}</span><span style="font-size:10px;color:#4b5563">${w.size.toFixed(1)} BTC</span></div>`;});
  document.getElementById('ob-panel').innerHTML=`
    <div style="background:#111520;border-radius:7px;padding:9px 11px;margin-bottom:10px;border:1px solid #1e2330">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
        <span style="font-size:10px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px">CVD 15m</span>
        <span class="mono ${cvdClass}" style="font-size:16px;font-weight:800;color:${cvdCol}">${cvdTrend} ${cvdVal>=0?'+':''}${cvdVal}%</span>
      </div>
      <div style="position:relative;height:8px;background:#1e2330;border-radius:4px;overflow:hidden;margin-bottom:4px">
        <div style="position:absolute;left:50%;top:0;width:1px;height:100%;background:#4b5563;z-index:2"></div>
        ${Math.abs(cvdVal)>2?`<div style="position:absolute;${cvdVal>0?'left:50%':'right:50%'};top:0;height:100%;width:${Math.min(50,Math.abs(cvdVal)*1.2)}%;background:${cvdVal>0?'#00d68f':'#ff4d6d'};border-radius:${cvdVal>0?'0 4px 4px 0':'4px 0 0 4px'};transition:all .5s"></div>`:''}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:#2a3040">
        <span>Ventas agresivas</span>
        <span style="color:${Math.abs(cvdVal)<2?'#2a3040':cvdCol};font-weight:600">${Math.abs(cvdVal)<2?'Neutro':cvdLabel}${cvdAgresivo?' ⚡ AGRESIVO':''}</span>
        <span>Compras agresivas</span>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:11px;color:#4b5563">${press}</span>
      <span class="mono" style="font-size:12px;font-weight:700;color:${col}">Imb: ${imb}%</span>
    </div>
    <div style="height:5px;background:#111520;border-radius:3px;overflow:hidden;margin-bottom:8px">
      <div style="height:100%;width:${Math.min(100,Math.max(0,50+imb/2))}%;background:${col};border-radius:3px;transition:width .5s"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:8px">
      <span style="color:#00d68f">BID ${ob.bidVol} BTC</span>
      <span class="mono" style="font-weight:700">$${fmt(p)}</span>
      <span style="color:#ff4d6d">ASK ${ob.askVol} BTC</span>
    </div>
    ${wallsHtml||'<div style="font-size:10px;color:#2a3040">Sin paredes significativas</div>'}
    <div style="font-size:10px;color:#2a3040;margin-top:4px">Spread: $${ob.spread} (${ob.spreadPct}%)</div>`;
}

function liqProbability(z){
  const dist=parseFloat(z.dist),size=z.size,isUp=z.direction==='up';
  let prob=dist<1.5?85:dist<2.5?72:dist<4?58:dist<6?44:dist<8?32:22;
  if(size>=800)prob+=15;else if(size>=500)prob+=10;else if(size>=300)prob+=5;
  const b=mkt.bias?.tf15m?.bias||'neutral',b4h=mkt.bias?.tf4h?.bias||'neutral';
  if(isUp&&(b==='long'||b4h==='long'))prob+=8;if(!isUp&&(b==='short'||b4h==='short'))prob+=8;
  if(isUp&&b==='short')prob-=10;if(!isUp&&b==='long')prob-=10;
  const cvdTrend=mkt.cvd15m?.trend;
  if(isUp&&cvdTrend==='bull')prob+=5;if(!isUp&&cvdTrend==='bear')prob+=5;
  return Math.min(95,Math.max(8,Math.round(prob)));
}
function liqHeatColor(size,alpha=1){
  if(size>=800)return`rgba(255,59,48,${alpha})`;if(size>=600)return`rgba(255,149,0,${alpha})`;
  if(size>=400)return`rgba(255,204,0,${alpha})`;if(size>=250)return`rgba(52,199,89,${alpha})`;
  return`rgba(90,132,255,${alpha})`;
}
function renderLiq(){
  const liq=mkt.liqMagnets,p=mkt.price;if(!liq||!p)return;
  const above=liq.filter(z=>z.direction==='up').sort((a,b)=>parseFloat(a.dist)-parseFloat(b.dist));
  const below=liq.filter(z=>z.direction==='down').sort((a,b)=>parseFloat(a.dist)-parseFloat(b.dist));
  const maxSize=Math.max(...liq.map(z=>z.size));
  function zoneRow(z){
    const prob=liqProbability(z);const isUp=z.direction==='up';const isMajor=z.size>=600;
    const heatCol=liqHeatColor(z.size),heatFaint=liqHeatColor(z.size,0.12);
    const barW=Math.round((z.size/maxSize)*100);const arrow=isUp?'↑':'↓';
    const probColor=prob>=75?'#ff4d6d':prob>=55?'#f59e0b':'#4b5563';
    const priceCol=isMajor?'#f59e0b':isUp?'#ff4d6d':'#00d68f';
    return`<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.03);position:relative">
      <div style="position:absolute;left:0;top:0;height:100%;width:${barW}%;background:${heatFaint};border-radius:2px;pointer-events:none"></div>
      <div style="width:4px;height:30px;border-radius:2px;background:${heatCol};flex-shrink:0;${isMajor?'box-shadow:0 0 5px '+heatCol:''}"></div>
      <div style="flex:1;position:relative">
        <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">
          <span class="mono" style="font-size:12px;font-weight:700;color:${priceCol}">${arrow} $${parseInt(z.price).toLocaleString()}</span>
          ${isMajor?'<span style="font-size:9px;background:rgba(245,158,11,.15);color:#f59e0b;padding:1px 4px;border-radius:3px;font-weight:700">MAYOR</span>':''}
        </div>
        <div style="display:flex;gap:5px;align-items:center">
          <span style="font-size:10px;color:#4b5563">${z.label}</span>
          <span style="font-size:10px;color:${heatCol};font-weight:600">$${z.size}M</span>
          <span style="font-size:10px;color:#2a3040">${z.dist}%</span>
          ${z.isReal?'<span style="font-size:8px;background:rgba(0,214,143,.15);color:#00d68f;padding:1px 4px;border-radius:2px;font-weight:700">REAL</span>':''}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;position:relative">
        <div class="mono" style="font-size:13px;font-weight:700;color:${probColor}">${prob}%</div>
        <div style="font-size:9px;color:#2a3040">prob</div>
      </div>
    </div>`;
  }
  const aboveHtml=above.slice(0,4).reverse().map(z=>zoneRow(z)).join('');
  const belowHtml=below.slice(0,4).map(z=>zoneRow(z)).join('');
  document.getElementById('liq-panel').innerHTML=`<div style="padding:0 0 4px">
    ${aboveHtml}
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:5px;margin:4px 0;background:#ffffff;border:none">
      <div style="width:4px;height:20px;border-radius:2px;background:#080a0d;flex-shrink:0"></div>
      <span style="font-size:10px;color:#080a0d;font-weight:700;text-transform:uppercase;letter-spacing:.5px">Precio actual</span>
      <span class="mono" style="font-size:14px;font-weight:800;color:#080a0d;margin-left:auto">$${parseInt(p).toLocaleString()}</span>
      <span style="font-size:10px;color:#4b5563;background:#e5e7eb;padding:1px 6px;border-radius:3px">◄</span>
    </div>
    ${belowHtml}
    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;padding-top:4px;border-top:1px solid rgba(255,255,255,.03)">
      <span style="font-size:9px;color:#2a3040">Intensidad:</span>
      <span style="font-size:9px;color:rgba(90,132,255,1)">■ baja</span>
      <span style="font-size:9px;color:rgba(52,199,89,1)">■ media</span>
      <span style="font-size:9px;color:rgba(255,204,0,1)">■ alta</span>
      <span style="font-size:9px;color:rgba(255,149,0,1)">■ crítica</span>
      <span style="font-size:9px;color:rgba(255,59,48,1)">■ extrema</span>
    </div>
  </div>`;
}

async function runAI(autoMode=false){
  const btn=document.getElementById('ai-btn'),icon=document.getElementById('ai-icon'),result=document.getElementById('ai-result');
  btn.disabled=true;icon.innerHTML='<span class="thinking">●</span>';
  result.className='ai-box ai-loading';
  result.innerHTML='<div class="ai-hdr"><span>✦</span><span style="font-size:13px;font-weight:700;color:#8b5cf6">Claude analizando...</span></div><div class="ai-reasoning">Procesando divergencias, OI, funding y sesgo multi-TF...</div>';
  try{
    const marketData={price:mkt.price,change24h:mkt.change24h,fundingRate:mkt.fundingRate,openInterest:mkt.openInterest,volume24h:mkt.volume24h,rsi15m:mkt.rsi15m,rsiOverbought:mkt.rsiOverbought,rsiOversold:mkt.rsiOversold,cvd15m:mkt.cvd15m,vrvp:mkt.vrvp,bb15m:mkt.bb15m,vwap15m:mkt.vwap15m,volDeltaPct:mkt.volDeltaPct,orderBook:{pressure:mkt.orderBook?.pressure,imbalance:mkt.orderBook?.imbalance,bidWalls:mkt.orderBook?.bidWalls?.slice(0,2),askWalls:mkt.orderBook?.askWalls?.slice(0,2)},liqMagnets:mkt.liqMagnets?.slice(0,5),divergences:mkt.divergences?.slice(0,4),combinedSignal:mkt.combinedSignal,bias:{tf15m:{bias:mkt.bias?.tf15m?.bias,score:mkt.bias?.tf15m?.score,rsi:mkt.bias?.tf15m?.rsi,oiTrend:mkt.bias?.tf15m?.oiTrend,oiDeltaPct:mkt.bias?.tf15m?.oiDeltaPct,fundingRate:mkt.bias?.tf15m?.fundingRate},tf1h:{bias:mkt.bias?.tf1h?.bias,score:mkt.bias?.tf1h?.score,rsi:mkt.bias?.tf1h?.rsi,oiTrend:mkt.bias?.tf1h?.oiTrend,oiDeltaPct:mkt.bias?.tf1h?.oiDeltaPct},tf4h:{bias:mkt.bias?.tf4h?.bias,score:mkt.bias?.tf4h?.score,rsi:mkt.bias?.tf4h?.rsi,oiTrend:mkt.bias?.tf4h?.oiTrend,oiDeltaPct:mkt.bias?.tf4h?.oiDeltaPct},tf1d:{bias:mkt.bias?.tf1d?.bias,score:mkt.bias?.tf1d?.score,rsi:mkt.bias?.tf1d?.rsi}}};
    const res=await fetch(`${API}/api/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:pair,marketData})});
    if(!res.ok){const errData=await res.json().catch(()=>({}));throw new Error(errData.detail||errData.error||`HTTP ${res.status}`);}
    const d=JSON.parse(await res.text());
    const isLong=d.direction==='LONG',isShort=d.direction==='SHORT';
    const col=isLong?'#00d68f':isShort?'#ff4d6d':'#f59e0b';
    result.className='ai-box '+(isLong?'ai-long':isShort?'ai-short':'ai-wait');
    const actClass=d.action==='ENTRAR'?'act-enter':d.action?.includes('ESPERAR')?'act-wait':'act-no';
    const isUrgent = d.confidence >= 95;
    const urgentClass = isUrgent ? (isLong ? 'blink-urgent-long' : 'blink-urgent-short') : '';
    result.innerHTML=`<div class="ai-hdr" style="margin-bottom:10px"><span style="font-size:22px">${isLong?'▲':isShort?'▼':'◆'}</span><span style="font-size:22px;font-weight:800;color:${col};margin-left:4px">${d.direction} — ${d.confidence}%</span></div>
    <div style="margin-bottom:9px"><span class="action-badge ${actClass} ${urgentClass}" style="font-size:14px;padding:7px 18px;border-radius:6px;display:inline-block">${d.action||'ESPERAR'}</span>${isUrgent?'<span style="font-size:11px;color:'+col+';margin-left:8px;font-weight:700;animation:blink-urgent .4s infinite">⚡ SEÑAL CRÍTICA ≥95%</span>':''}</div><div class="ai-reasoning" style="font-size:12px;line-height:1.7">${d.reasoning||''}${d.warning?'<br><span style="color:#f59e0b">⚠ '+d.warning+'</span>':''}</div><div class="ai-levels"><div class="ai-level"><div class="ai-level-lbl">Entry</div><div class="ai-level-val">$${(d.entry||0).toLocaleString()}</div></div><div class="ai-level"><div class="ai-level-lbl">TP1 / TP2</div><div class="ai-level-val" style="color:#00d68f">$${(d.tp1||0).toLocaleString()} <span style="font-size:9px;color:#4b5563">R:R base</span><br><span style="font-size:11px;color:#00d68f">$${(d.tp2||0).toLocaleString()} <span style="font-size:9px;color:#4b5563">R:R extendido</span></span></div></div><div class="ai-level"><div class="ai-level-lbl">SL · R:R</div><div class="ai-level-val" style="color:#ff4d6d">$${(d.sl||0).toLocaleString()}<br><span style="font-size:10px;color:#4b5563">${d.rr||'–'}</span></div></div></div>`;
    if(d.entry){
      aiSignal=d; aiRR=d.rr||null;
      document.getElementById('c-ent').value=d.entry.toFixed(1);
      document.getElementById('c-tp').value=d.tp1.toFixed(1);
      document.getElementById('c-sl').value=d.sl.toFixed(1);
      calc();
    const _realRr = d.entry && d.tp1 && d.sl ? Math.abs(d.tp1 - d.entry) / Math.abs(d.entry - d.sl) : 0;
    const _realRrStr = '1:' + _realRr.toFixed(1);
    aiRR = _realRrStr;
    document.getElementById('r-rr').textContent = _realRrStr;
    document.getElementById('r-rr').style.color = _realRr >= 1.5 ? '#00d68f' : _realRr >= 1 ? '#f59e0b' : '#ff4d6d';
      updateExecButtons();
      if (autoMode && d.confidence >= 95 && d.direction !== 'ESPERAR') {
        const _autoRr = d.entry && d.tp1 && d.sl ? Math.abs(d.tp1 - d.entry) / Math.abs(d.entry - d.sl) : 0;
        if (_autoRr >= 1.5) {
          fetch(`${API}/api/alert/trigger`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:pair,urgent:true,confidence:d.confidence})}).catch(()=>{});
          showToast(`🚨 SEÑAL CRÍTICA ${d.confidence}% — abriendo paper trade automático`, d.direction==='LONG'?'#00d68f':'#ff4d6d');
          setTimeout(() => openPaperTrade(d.direction), 1500);
        } else {
          fetch(`${API}/api/alert/trigger`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:pair,urgent:true,confidence:d.confidence})}).catch(()=>{});
          showToast(`⚠️ Señal ${d.confidence}% — alerta enviada, R:R insuficiente (${_autoRr.toFixed(1)})`, '#f59e0b');
        }
      } else if (autoMode && d.confidence >= 90) {
        fetch(`${API}/api/alert/trigger`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:pair,urgent:false,confidence:d.confidence})}).catch(()=>{});
        showToast(`🔔 Señal ${d.confidence}% detectada — alerta enviada`, '#f59e0b');
      }
    }
  }catch(e){
    result.className='ai-box ai-error';
    result.innerHTML=`<div class="ai-hdr"><span>⚠</span><span style="font-size:13px;font-weight:700;color:#ff4d6d">Error</span></div><div class="ai-reasoning" style="color:#ff4d6d">${e.message}</div>`;
  }
  btn.disabled=false;icon.textContent='✦';
}

function calc(){
  const cap=parseFloat(document.getElementById('c-cap').value)||0;
  const lev=parseFloat(document.getElementById('c-lev').value)||1;
  const ent=parseFloat(document.getElementById('c-ent').value)||0;
  const tp=parseFloat(document.getElementById('c-tp').value)||0;
  const sl=parseFloat(document.getElementById('c-sl').value)||0;
  const sz=cap*lev;
  document.getElementById('r-sz').textContent=sz?'$'+fmt(sz):'–';
  if(ent&&tp&&sl){
    const pr=sz*(tp-ent)/ent;
    const ls=sz*(ent-sl)/ent;
    const reward=Math.abs(tp-ent);
    const risk=Math.abs(ent-sl);
    const rr=risk>0?(reward/risk):0;
    document.getElementById('r-pr').textContent=(pr>0?'+':'')+'$'+fmt(Math.abs(pr));
    document.getElementById('r-ls').textContent='-$'+fmt(Math.abs(ls));
    if(aiRR){
      document.getElementById('r-rr').textContent=aiRR;
      document.getElementById('r-rr').style.color='#00d68f';
    } else {
      document.getElementById('r-rr').textContent='1:'+rr.toFixed(1);
      document.getElementById('r-rr').style.color=rr>=1.5?'#00d68f':rr>=1?'#f59e0b':'#ff4d6d';
    }
    document.getElementById('r-lq').textContent='$'+fmt(ent*(1-1/lev*0.9));
  }
}

function renderDeepOB(){
  const dob=mkt.deepOB;const el=document.getElementById('deep-ob-panel');
  if(!dob||(!dob.bidClusters?.length&&!dob.askClusters?.length)){el.innerHTML='<div style="font-size:11px;color:#4b5563;text-align:center;padding:10px">Sin clusters significativos</div>';return;}
  const imb=dob.deepImbalance||0;const imbCol=imb>15?'#00d68f':imb<-15?'#ff4d6d':'#f59e0b';
  function clusterRow(c){
    const isBid=c.side==='bid';const col=isBid?'#00d68f':'#ff4d6d';
    const usd=c.usdVal>=1000000?(c.usdVal/1000000).toFixed(1)+'M':(c.usdVal/1000).toFixed(0)+'K';
    const strengthBar=Math.min(100,Math.round((c.strength-1)/4*100));
    const breakColor=c.breakProb>65?'#00d68f':c.breakProb>40?'#f59e0b':'#ff4d6d';
    return`<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03)">
      <div style="width:3px;height:24px;border-radius:2px;background:${col};flex-shrink:0"></div>
      <div style="flex:1"><div style="display:flex;justify-content:space-between;align-items:center"><span class="mono" style="font-size:11px;font-weight:700;color:${col}">$${parseInt(c.price).toLocaleString()}</span><span style="font-size:10px;color:#4b5563">${c.qty} BTC · ${usd}</span></div><div style="height:3px;background:#1e2330;border-radius:2px;margin-top:3px;overflow:hidden"><div style="height:100%;width:${strengthBar}%;background:${col};border-radius:2px"></div></div></div>
      <div style="text-align:right;min-width:42px"><div style="font-size:11px;font-weight:700;color:${breakColor}">${c.breakProb}%</div><div style="font-size:9px;color:#2a3040">rotura</div></div>
    </div>`;
  }
  const askHtml=[...(dob.askClusters||[])].reverse().map(c=>clusterRow(c)).join('');
  const bidHtml=(dob.bidClusters||[]).map(c=>clusterRow(c)).join('');
  el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-size:10px;color:#4b5563">Imbalance profundo 500 niveles</span><span class="mono" style="font-size:12px;font-weight:700;color:${imbCol}">${imb>0?'+':''}${imb}%</span></div>
    <div style="font-size:9px;color:#4b5563;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Muros vendedores (ask)</div>${askHtml||'<div style="font-size:10px;color:#2a3040;padding:4px 0">Sin clusters ask</div>'}
    <div style="height:1px;background:#1e2330;margin:6px 0"></div>
    <div style="font-size:9px;color:#4b5563;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Muros compradores (bid)</div>${bidHtml||'<div style="font-size:10px;color:#2a3040;padding:4px 0">Sin clusters bid</div>'}
    <div style="font-size:9px;color:#2a3040;margin-top:6px">% rotura = probabilidad de que el precio traspase el muro</div>`;
}

function renderWhales(){
  const w=mkt.whaleData;const el=document.getElementById('whale-panel');
  if(!w){el.innerHTML='<div style="font-size:11px;color:#4b5563;text-align:center;padding:10px">Sin datos</div>';return;}
  const biasCol=w.whaleBias==='bull'?'#00d68f':w.whaleBias==='bear'?'#ff4d6d':'#f59e0b';
  const biasLabel=w.whaleBias==='bull'?'▲ Alcista':w.whaleBias==='bear'?'▼ Bajista':'◆ Neutro';
  const domCol=w.dominance==='buyers'?'#00d68f':w.dominance==='sellers'?'#ff4d6d':'#f59e0b';
  const recentWhales=(w.whales||[]).slice(-5).reverse().map(wh=>{
    const isBuy=wh.side==='buy';const col=isBuy?'#00d68f':'#ff4d6d';
    const usd=wh.usdVal>=1000000?(wh.usdVal/1000000).toFixed(2)+'M':(wh.usdVal/1000).toFixed(0)+'K';
    const time=new Date(wh.time).toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    return`<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.03)"><span style="font-size:12px">${isBuy?'▲':'▼'}</span><span class="mono" style="font-size:11px;font-weight:700;color:${col}">${usd}</span><span class="mono" style="font-size:10px;color:#4b5563">$${parseInt(wh.price).toLocaleString()}</span><span style="font-size:10px;color:#2a3040;margin-left:auto">${time}</span></div>`;
  }).join('');
  const totalWhaleVol=(w.whaleBuyVol||0)+(w.whaleSellVol||0);
  const buyPct=totalWhaleVol>0?Math.round((w.whaleBuyVol/totalWhaleVol)*100):50;
  el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div><span style="font-size:14px;font-weight:700;color:${biasCol}">${biasLabel}</span><span style="font-size:10px;color:#4b5563;margin-left:6px">${w.whaleCount} trades detectados</span></div><span style="font-size:11px;font-weight:700;color:${domCol}">${w.dominance}</span></div>
    <div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:10px;color:#4b5563;margin-bottom:3px"><span style="color:#00d68f">Compras $${w.whaleBuyVol}K</span><span>CVD ballenas</span><span style="color:#ff4d6d">Ventas $${w.whaleSellVol}K</span></div><div style="height:5px;background:#1e2330;border-radius:3px;overflow:hidden"><div style="height:100%;width:${buyPct}%;background:#00d68f;border-radius:3px;transition:width .5s"></div></div></div>
    <div style="font-size:9px;color:#4b5563;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">Últimas transacciones ≥$500K</div>
    ${recentWhales||'<div style="font-size:10px;color:#2a3040;padding:4px 0">Sin ballenas recientes</div>'}
    <div style="font-size:9px;color:#2a3040;margin-top:5px">Ratio dominancia: ${w.whaleRatio||0}% del volumen total</div>`;
}

function renderFib(){
  const fib=mkt.fibonacci?.tf15m;const el=document.getElementById('fib-panel');if(!fib||!el)return;
  const p=mkt.price;const isUp=fib.isUptrend;const trendCol=isUp?'#00d68f':'#ff4d6d';const trendLabel=isUp?'▲ Alcista':'▼ Bajista';
  const allLevels=[...fib.retracements.map(r=>({...r,type:'ret'})),...fib.extensions.map(r=>({...r,type:'ext'}))].sort((a,b)=>b.price-a.price);
  function levelRow(lvl){
    const isCurrent=Math.abs(p-lvl.price)/p*100<0.5;const isAbove=lvl.price>p;const isKey=lvl.isKey;const isExt=lvl.type==='ext';
    const col=isKey?(isExt?'#8b5cf6':'#f59e0b'):isExt?'#534AB7':'#4b5563';
    const bg=isCurrent?'rgba(245,158,11,.08)':'transparent';const dist=Math.abs(p-lvl.price)/p*100;
    return`<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;background:${bg};${isCurrent?'border:1px solid rgba(245,158,11,.3)':'border:1px solid transparent'}">
      <span style="width:3px;height:16px;border-radius:2px;background:${col};flex-shrink:0;${isKey?'box-shadow:0 0 4px '+col:''}"></span>
      <span style="font-size:10px;color:${col};font-weight:${isKey?'700':'400'};width:42px">${lvl.label}${isExt?' ext':''}</span>
      <span class="mono" style="font-size:11px;font-weight:700;color:${isCurrent?'#f59e0b':isAbove?'#ff4d6d':'#00d68f'}">$${parseInt(lvl.price).toLocaleString()}</span>
      <span style="font-size:9px;color:#2a3040;margin-left:auto">${dist.toFixed(2)}%</span>
      ${isCurrent?'<span style="font-size:9px;background:rgba(245,158,11,.15);color:#f59e0b;padding:1px 4px;border-radius:3px;font-weight:700">◄ PRECIO</span>':''}
    </div>`;
  }
  let fibSignalHtml='';
  if(fib.retImpact.signal!=='none'&&fib.nearestRetrace?.dist<0.8){
    const sigCol=fib.retImpact.signal==='long_bounce'?'#00d68f':'#ff4d6d';
    fibSignalHtml=`<div style="padding:6px 8px;background:rgba(${fib.retImpact.signal==='long_bounce'?'0,214,143':'255,77,109'},.08);border-radius:5px;border:1px solid rgba(${fib.retImpact.signal==='long_bounce'?'0,214,143':'255,77,109'},.25);margin-bottom:8px"><div style="font-size:11px;font-weight:700;color:${sigCol}">⬟ ${fib.retImpact.description||'Zona de rebote Fibonacci activa'}</div><div style="font-size:10px;color:#4b5563;margin-top:2px">Bonus aplicado: +${fib.retImpact.bonus||0}% a probabilidades</div></div>`;
  } else if(fib.extImpact.signal!=='none'&&fib.nearestExt?.dist<0.8){
    fibSignalHtml=`<div style="padding:6px 8px;background:rgba(139,92,246,.08);border-radius:5px;border:1px solid rgba(139,92,246,.25);margin-bottom:8px"><div style="font-size:11px;font-weight:700;color:#8b5cf6">⬟ ${fib.extImpact.description||'Zona de agotamiento Fibonacci'}</div><div style="font-size:10px;color:#4b5563;margin-top:2px">Zona de agotamiento — ${fib.extImpact.penalty>0?'penaliza continuación -'+fib.extImpact.penalty+'%':'confirma reversión'}</div></div>`;
  }
  el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div><span style="font-size:12px;font-weight:700;color:${trendCol}">${trendLabel}</span><span style="font-size:10px;color:#4b5563;margin-left:6px">Rango: $${parseInt(fib.swingLow).toLocaleString()} — $${parseInt(fib.swingHigh).toLocaleString()}</span></div></div>
    ${fibSignalHtml}
    <div style="display:flex;flex-direction:column;gap:2px">${allLevels.map(lvl=>levelRow(lvl)).join('')}</div>
    <div style="display:flex;gap:10px;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.03)"><span style="font-size:9px;color:#f59e0b">■ retroceso clave</span><span style="font-size:9px;color:#8b5cf6">■ extensión clave</span><span style="font-size:9px;color:#4b5563">■ nivel menor</span></div>`;
}

async function triggerAlert(){
  const btn=document.getElementById('alert-btn');const icon=document.getElementById('alert-icon');
  btn.disabled=true;icon.textContent='⏳';
  try{await fetch(`${API}/api/alert/trigger`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:pair,force:true})});icon.textContent='✅';setTimeout(()=>{icon.textContent='🔔';btn.disabled=false;},3000);}
  catch(e){icon.textContent='❌';setTimeout(()=>{icon.textContent='🔔';btn.disabled=false;},3000);}
}

let paperStats=null;let openTrades=[];

async function refreshPaper(){
  try{
    const [statsRes,openRes]=await Promise.all([fetch(`${API}/api/paper/stats`).then(r=>r.json()),fetch(`${API}/api/paper/open`).then(r=>r.json())]);
    paperStats=statsRes;openTrades=openRes;renderPaper();
  }catch(e){console.error('Paper trading error:',e);}
}

async function openPaperTrade(direction){
  if(!mkt.price)return;
  const cs=mkt.combinedSignal;const entry=mkt.price;
  const capital=parseFloat(document.getElementById('c-cap').value)||1000;
  const leverage=parseFloat(document.getElementById('c-lev').value)||10;
  const useAI=aiSignal&&aiSignal.direction===direction&&aiSignal.entry&&aiSignal.tp1&&aiSignal.sl;
  const entryInput=useAI?parseFloat(aiSignal.entry):parseFloat(document.getElementById('c-ent').value)||entry;
  const tp1Input=useAI?parseFloat(aiSignal.tp1):parseFloat(document.getElementById('c-tp').value)||(direction==='LONG'?entry*1.025:entry*0.975);
  const slInput=useAI?parseFloat(aiSignal.sl):parseFloat(document.getElementById('c-sl').value)||(direction==='LONG'?entry*0.988:entry*1.012);
  if(useAI){document.getElementById('c-ent').value=entryInput.toFixed(1);document.getElementById('c-tp').value=tp1Input.toFixed(1);document.getElementById('c-sl').value=slInput.toFixed(1);calc();}
  const reward=Math.abs(tp1Input-entryInput);const risk=Math.abs(entryInput-slInput);
  const rr=risk>0?(reward/risk).toFixed(1):'0';
  const _rrNum = parseFloat(rr);
  if (!lockUnlocked && _rrNum < 1.5) {
    showToast(`⛔ R:R 1:${rr} insuficiente — mínimo 1:1.5 requerido`, '#ff4d6d');
    return;
  }
  try{
    const res=await fetch(`${API}/api/paper/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:pair,direction,entry:entryInput,tp1:tp1Input,tp2:useAI&&aiSignal.tp2?parseFloat(aiSignal.tp2):tp1Input,sl:slInput,rr:`1:${rr}`,confidence:cs?.probability||0,size_usd:capital,leverage,divergences:mkt.divergences?.slice(0,3),fibonacci:mkt.fibonacci?.tf15m,source:'manual',market_data:{
  confidence: aiSignal?.confidence || cs?.probability || 0,
  direction,
  price: mkt.price,
  rsi_15m: mkt.rsi15m,
  cvd_pct: mkt.cvd15m?.cvdPct,
  cvd_trend: mkt.cvd15m?.trend,
  funding_rate: mkt.fundingRate,
  oi_trend_15m: mkt.oiTrends?.tf15m?.trend,
  bias_4h: mkt.bias?.tf4h?.bias,
  bias_4h_score: mkt.bias?.tf4h?.score,
  bias_1d: mkt.bias?.tf1d?.bias,
  fib_level: mkt.fibonacci?.tf15m?.nearestRetrace?.label,
  fib_dist: mkt.fibonacci?.tf15m?.nearestRetrace?.dist,
  fib_signal: mkt.fibonacci?.tf15m?.retImpact?.signal,
  whale_count: mkt.whaleData?.whaleCount,
  whale_bias: mkt.whaleData?.whaleBias,
  deep_imbalance: mkt.deepOB?.deepImbalance,
  price_vs_poc: mkt.vrvp?.poc ? ((mkt.price - mkt.vrvp.poc) / mkt.vrvp.poc * 100).toFixed(3) : null,
  divergence_count: mkt.divergences?.length,
  top_divergence: mkt.divergences?.[0]?.type,
  top_divergence_prob: mkt.divergences?.[0]?.probability,
  ai_reasoning: aiSignal?.reasoning || null,
  timestamp: new Date().toISOString(),
  mode: 'manual'
}})});
    const d=await res.json();
    if(d.ok){await refreshPaper();const src=useAI?'(valores IA)':'(valores manuales)';showToast((direction==='LONG'?'▲ Paper LONG abierto ':' ▼ Paper SHORT abierto ')+src,direction==='LONG'?'#00d68f':'#ff4d6d');}
    else{showToast(d.error||'Error al abrir trade','#ff4d6d');}
  }catch(e){showToast('Error al abrir trade','#ff4d6d');}
}

async function closePaperTrade(id,reason,tradeSymbol){
  if(reason==='manual'){
    if(!confirm('¿Cancelar este trade?\nNo se contabilizará en estadísticas ni ML.')) return;
  }
  const symbolToFetch = tradeSymbol || pair;
  const priceRes=await fetch(`${API}/api/market/${symbolToFetch}`).then(r=>r.json()).catch(()=>({price:mkt.price}));
  const closePrice=priceRes.price||mkt.price;
  try{
    const res=await fetch(`${API}/api/paper/close/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({close_price:closePrice,close_reason:reason})});
    const d=await res.json();
    await refreshPaper();
    if(reason==='manual'){
      showToast('Trade cancelado — no contabilizado','#f59e0b');
    } else {
      const trade=d.trade;
      const pnl=parseFloat(trade?.pnl_usd||0);
      const won=trade?.status==='won';
      showToast(`${won?'✅ TP':'❌ SL'} — PnL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`, won?'#00d68f':'#ff4d6d');
    }
  }catch(e){}
}

function showToast(msg,col='#f59e0b'){
  let t=document.getElementById('toast');
  if(!t){t=document.createElement('div');t.id='toast';t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 24px;border-radius:8px;font-size:14px;font-weight:800;z-index:9999;transition:all .3s;text-align:center;min-width:200px;border:1px solid transparent';document.body.appendChild(t);}
  t.textContent=msg;t.style.background=col==='#00d68f'?'rgba(0,214,143,.15)':col==='#ff4d6d'?'rgba(255,77,109,.15)':'rgba(245,158,11,.15)';
  t.style.borderColor=col;t.style.color=col;t.style.opacity='1';t.style.transform='translateX(-50%) scale(1)';
  setTimeout(()=>{t.style.opacity='0';t.style.transform='translateX(-50%) scale(0.95)';},3000);
}

function renderPaper(){
  const el=document.getElementById('paper-panel');if(!el)return;
  const cs=mkt.combinedSignal;
  if(paperStats){
    const s=paperStats;const pnlCol=s.totalPnl>=0?'#00d68f':'#ff4d6d';
    document.getElementById('paper-stats-summary').innerHTML=`<span style="color:${s.winRate>=55?'#00d68f':s.winRate>=45?'#f59e0b':'#ff4d6d'}">${s.winRate}% WR</span><span style="color:#4b5563;margin:0 3px">·</span><span style="color:${pnlCol}">${s.totalPnl>=0?'+':''}$${s.totalPnl}</span><span style="color:#4b5563;margin:0 3px">·</span><span style="color:#4b5563">${s.total} trades</span>`;
  }
  let html='';
  if(openTrades.length>0){
    openTrades.forEach(t=>{
      const isLong=t.direction==='LONG';const col=isLong?'#00d68f':'#ff4d6d';
      const currentP=allPrices[t.symbol]||(t.symbol===pair?mkt.price:0)||parseFloat(t.entry);
      const entry=parseFloat(t.entry);const tp1=parseFloat(t.tp1);const sl=parseFloat(t.sl);
      const size=parseFloat(t.size_usd);const lev=parseFloat(t.leverage);
      const priceDiff=isLong?(currentP-entry)/entry:(entry-currentP)/entry;
      const floatingPnl=parseFloat((size*priceDiff).toFixed(2));
      const floatingPct=parseFloat((priceDiff*100).toFixed(2));
      const floatingCol=floatingPnl>=0?'#00d68f':'#ff4d6d';
      const towardTP=isLong?currentP>entry:currentP<entry;
      const progressCol=towardTP?'#00d68f':'#ff4d6d';
      html+=`<div style="background:#0d1017;border-top:2px solid ${col};border-bottom:1px solid #1e2330;padding:12px 14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="background:${col};color:${isLong?'#000':'#fff'};font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px">${isLong?'▲ LONG':'▼ SHORT'}</span>
            <span style="font-size:12px;font-weight:700;color:#e2e4ea">${t.symbol}</span>
            <span style="font-size:10px;color:#4b5563">${lev}x</span>
          </div>
          <div style="text-align:right">
            <div class="mono" style="font-size:15px;font-weight:800;color:${floatingCol}">${floatingPnl>=0?'+':''}$${floatingPnl}</div>
            <div style="font-size:10px;color:${floatingCol}">${floatingPct>=0?'+':''}${floatingPct}%</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
          <div style="background:#111520;border-radius:5px;padding:6px 8px"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">Entry</div><div class="mono" style="font-size:12px;font-weight:700;color:#e2e4ea">$${parseInt(entry).toLocaleString()}</div><div style="font-size:9px;color:#2a3040;margin-top:2px">${new Date(t.opened_at||t.created_at).toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit'})} ${new Date(t.opened_at||t.created_at).toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})}</div></div>
          <div style="background:#111520;border-radius:5px;padding:6px 8px"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">Precio actual</div><div class="mono" style="font-size:12px;font-weight:700;color:#f59e0b">$${parseInt(currentP).toLocaleString()}</div></div>
          <div style="background:#111520;border-radius:5px;padding:6px 8px"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">Tamaño</div><div class="mono" style="font-size:12px;font-weight:700;color:#e2e4ea">$${(size).toLocaleString()}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
          <div style="background:rgba(0,214,143,.06);border:1px solid rgba(0,214,143,.2);border-radius:5px;padding:6px 8px"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">TP</div><div class="mono" style="font-size:12px;font-weight:700;color:#00d68f">$${parseInt(tp1).toLocaleString()}</div></div>
          <div style="background:rgba(255,77,109,.06);border:1px solid rgba(255,77,109,.2);border-radius:5px;padding:6px 8px"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">SL</div><div class="mono" style="font-size:12px;font-weight:700;color:#ff4d6d">$${parseInt(sl).toLocaleString()}</div></div>
          <div style="background:#111520;border-radius:5px;padding:6px 8px"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">R:R</div><div class="mono" style="font-size:12px;font-weight:700;color:#e2e4ea">${(()=>{const r=Math.abs(parseFloat(t.tp1)-parseFloat(t.entry));const k=Math.abs(parseFloat(t.entry)-parseFloat(t.sl));return k>0?'1:'+(r/k).toFixed(1):'–';})()}</div></div>
        </div>
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;font-size:9px;color:#4b5563;margin-bottom:3px">
            <span>SL $${parseInt(sl).toLocaleString()}</span>
            <span style="color:${progressCol}">${towardTP?'▲ hacia TP':'▼ hacia SL'}</span>
            <span>TP $${parseInt(tp1).toLocaleString()}</span>
          </div>
          <div style="height:4px;background:#1e2330;border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${isLong?Math.min(100,Math.max(0,(currentP-sl)/(tp1-sl)*100)):Math.min(100,Math.max(0,(sl-currentP)/(sl-tp1)*100))}%;background:${progressCol};border-radius:2px;transition:width .5s"></div>
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button onclick="closePaperTrade('${t.id}','tp1','${t.symbol}')" style="flex:1;padding:7px;background:rgba(0,214,143,.15);color:#00d68f;border:1px solid rgba(0,214,143,.35);border-radius:5px;font-size:11px;font-weight:700;cursor:pointer">TP Alcanzado</button>
          <button onclick="closePaperTrade('${t.id}','sl','${t.symbol}')" style="flex:1;padding:7px;background:rgba(255,77,109,.15);color:#ff4d6d;border:1px solid rgba(255,77,109,.35);border-radius:5px;font-size:11px;font-weight:700;cursor:pointer">SL Alcanzado</button>
          <button onclick="closePaperTrade('${t.id}','manual','${t.symbol}')" title="Cancelar — no cuenta en estadísticas" style="padding:7px 10px;background:rgba(245,158,11,.08);color:#f59e0b;border:1px solid rgba(245,158,11,.25);border-radius:5px;font-size:11px;cursor:pointer;font-weight:600">✕ Cancelar</button>
        </div>
        <div style="font-size:9px;color:#2a3040;margin-top:6px;display:flex;gap:8px;align-items:center">
          <span>📅 ${new Date(t.opened_at||t.created_at).toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit'})} ${new Date(t.opened_at||t.created_at).toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})}</span>
          <span style="background:${t.source==='scalping'?'rgba(139,92,246,.15)':t.source==='auto'?'rgba(0,214,143,.1)':t.source==='sweep'?'rgba(56,189,248,.1)':t.source==='wall'?'rgba(249,115,22,.1)':t.source==='meanrev'?'rgba(16,185,129,.1)':'rgba(245,158,11,.1)'};color:${t.source==='scalping'?'#8b5cf6':t.source==='auto'?'#00d68f':t.source==='sweep'?'#38bdf8':t.source==='wall'?'#f97316':t.source==='meanrev'?'#10b981':'#f59e0b'};padding:1px 6px;border-radius:3px;font-weight:700;font-size:9px">${t.source==='scalping'?'⚡ Scalping':t.source==='auto'?'🤖 Auto':t.source==='sweep'?'🌊 Sweep':t.source==='wall'?'🧱 Wall':t.source==='meanrev'?'📈 MeanRev':'👤 Manual'}</span>
          <span>Conf: ${t.confidence||0}%</span>
        </div>
      </div>`;
    });
  } else {
    html+=`<div style="padding:14px;text-align:center;color:#2a3040;font-size:11px;border-bottom:1px solid #1e2330">Sin posiciones abiertas</div>`;
  }
  html+=`<div style="padding:8px 14px;border-bottom:1px solid #1e2330;font-size:10px;color:#2a3040;text-align:center">Para abrir trades usa los botones de ejecución en 🤖 Señal IA</div>`;
  if(paperStats&&paperStats.total>0){
    const s=paperStats;
    html+=`<div style="padding:10px 14px"><div style="font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Estadísticas</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin-bottom:10px">
        <div style="background:#111520;border-radius:5px;padding:6px;text-align:center"><div style="font-size:9px;color:#4b5563">Win Rate</div><div class="mono" style="font-size:13px;font-weight:700;color:${s.winRate>=55?'#00d68f':s.winRate>=45?'#f59e0b':'#ff4d6d'}">${s.winRate}%</div></div>
        <div style="background:#111520;border-radius:5px;padding:6px;text-align:center"><div style="font-size:9px;color:#4b5563">PnL</div><div class="mono" style="font-size:13px;font-weight:700;color:${s.totalPnl>=0?'#00d68f':'#ff4d6d'}">${s.totalPnl>=0?'+':''}$${s.totalPnl}</div></div>
        <div style="background:#111520;border-radius:5px;padding:6px;text-align:center"><div style="font-size:9px;color:#4b5563">P.Factor</div><div class="mono" style="font-size:13px;font-weight:700;color:#f59e0b">${s.profitFactor}</div></div>
        <div style="background:#111520;border-radius:5px;padding:6px;text-align:center"><div style="font-size:9px;color:#4b5563">Max DD</div><div class="mono" style="font-size:13px;font-weight:700;color:#ff4d6d">-$${s.maxDrawdown}</div></div>
      </div>
      <div style="font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Historial reciente</div>
      ${s.recentTrades.slice(0,8).map(t=>{
        if(t.status==='closed'&&(t.pnl_usd===0||t.pnl_usd===null))return'';
        const won=t.status==='won',lost=t.status==='lost',cancelled=t.status==='cancelled';
        const pnlCol=won?'#00d68f':lost?'#ff4d6d':cancelled?'#4b5563':'#f59e0b';
        const icon=won?'✓':lost?'✗':cancelled?'○':'—';
        const date=new Date(t.closed_at||t.created_at).toLocaleDateString('es-PE',{month:'2-digit',day:'2-digit'});
        const srcIcon=t.source==='scalping'?'⚡':t.source==='auto'?'🤖':t.source==='manual'?'👤':t.source==='sweep'?'🌊':t.source==='wall'?'🧱':t.source==='meanrev'?'📈':'📊';
        const srcCol=t.source==='scalping'?'#8b5cf6':t.source==='auto'?'#00d68f':t.source==='manual'?'#f59e0b':t.source==='sweep'?'#38bdf8':t.source==='wall'?'#f97316':t.source==='meanrev'?'#10b981':'#4b5563';
        const openTime = new Date(t.created_at).toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'});
        const closeTime = t.closed_at ? new Date(t.closed_at).toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'}) : '–';
        const closeDate = t.closed_at ? new Date(t.closed_at).toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit'}) : '';
        return`<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,.03)">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:13px;color:${pnlCol};font-weight:700;width:14px">${icon}</span>
            <span style="font-size:10px;color:${srcCol};width:16px">${srcIcon}</span>
            <span style="font-size:11px;color:${t.direction==='LONG'?'#00d68f':'#ff4d6d'};font-weight:700;width:42px">${t.direction}</span>
            <span style="font-size:10px;color:#4b5563;flex:1">${t.symbol}</span>
            <span class="mono" style="font-size:11px;font-weight:700;color:${pnlCol};min-width:58px;text-align:right">${(t.pnl_usd>=0?'+':'')+'$'+(t.pnl_usd||0).toFixed(0)}</span>
          </div>
          <div style="display:flex;gap:8px;margin-top:3px;padding-left:30px;font-size:9px;color:#2a3040">
            <span>📅 Apertura: ${date} ${openTime}</span>
            ${t.closed_at?`<span>🏁 Cierre: ${closeDate} ${closeTime}</span>`:''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  } else {
    html+=`<div style="padding:12px 14px;text-align:center;font-size:11px;color:#2a3040">Sin historial aún</div>`;
  }
  el.innerHTML=html;
}

let mlData=null;
async function runMLOptimize(){
  const btn=document.getElementById('ml-opt-btn');btn.textContent='⏳ Optimizando...';btn.disabled=true;
  try{const res=await fetch(`${API}/api/ml/optimize`,{method:'POST'}).then(r=>r.json());if(res.error){showToast('Error: '+res.error,'#ff4d6d');}else if(res.optimized===false){showToast(res.reason==='insufficient_data'?`Necesitas más trades (${res.trades}/50)`:'Sistema ya optimizado','#f59e0b');}else{showToast(`🧠 ${res.adjustments_count} ajustes aplicados`,'#8b5cf6');await refreshML();}}catch(e){showToast('Error de conexión','#ff4d6d');}
  finally{btn.textContent='🧠 Optimizar';btn.disabled=false;}
}
async function refreshML(){
  try{const res=await fetch(`${API}/api/ml/insights`);mlData=await res.json();renderML();}catch(e){console.error('ML error:',e);}
}
function renderML(){
  const el=document.getElementById('ml-panel');if(!el)return;
  if(!mlData){el.innerHTML=`<div style="padding:14px;text-align:center;font-size:11px;color:#2a3040">Cargando...</div>`;return;}
  if(mlData.message){el.innerHTML=`<div style="padding:14px;text-align:center;font-size:11px;color:#2a3040">${mlData.message} (${mlData.trades||0} trades)</div>`;return;}
  if(!mlData.total||mlData.total<10){el.innerHTML=`<div style="padding:14px;text-align:center;font-size:11px;color:#2a3040">Pocos trades (${mlData.total||0}) — espera más datos</div>`;return;}
  const d=mlData;const wr=parseFloat(d.winRate)||0;const pnl=parseFloat(d.totalPnl)||0;
  const wrCol=wr>=55?'#00d68f':wr>=45?'#f59e0b':'#ff4d6d';const pnlCol=pnl>=0?'#00d68f':'#ff4d6d';
  const topDivs=Object.entries(d.topDivergencesWon||{}).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const divLabels={'absorcion_compras':'Absorción Compras','absorcion_ventas':'Absorción Ventas','rsi_bajista':'RSI Bajista','rsi_alcista':'RSI Alcista','cvd_precio_bajista':'CVD/Precio Bajista','cvd_precio_alcista':'CVD/Precio Alcista','bull_trap':'Trampa Alcista','bear_trap':'Trampa Bajista','short_buildup':'Short Buildup','long_buildup':'Long Buildup','funding_extremo':'Funding Extremo','volumen_climax':'Volumen Clímax','long_squeeze':'Long Squeeze','short_squeeze':'Short Squeeze','sfp_bajista':'🪤 SFP Bajista','sfp_alcista':'🪤 SFP Alcista'};
  const maxDivCount=topDivs[0]?.[1]||1;const pf=d.profitFactor||'–';const dd=parseFloat(d.maxDrawdown)||0;
  el.innerHTML=`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;padding:10px 14px;border-bottom:1px solid #1e2330">
    <div style="background:#111520;border-radius:5px;padding:7px;text-align:center"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">Win Rate</div><div class="mono" style="font-size:15px;font-weight:800;color:${wrCol}">${wr.toFixed(1)}%</div><div style="font-size:9px;color:#2a3040">${d.won||0}W / ${d.lost||0}L</div></div>
    <div style="background:#111520;border-radius:5px;padding:7px;text-align:center"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">PnL Total</div><div class="mono" style="font-size:15px;font-weight:800;color:${pnlCol}">${pnl>=0?'+':''}$${pnl.toFixed(0)}</div><div style="font-size:9px;color:#2a3040">${d.total||0} trades</div></div>
    <div style="background:#111520;border-radius:5px;padding:7px;text-align:center"><div style="font-size:9px;color:#4b5563;margin-bottom:2px">Profit Factor</div><div class="mono" style="font-size:15px;font-weight:800;color:#f59e0b">${pf}</div><div style="font-size:9px;color:#2a3040">Max DD -$${dd.toFixed(0)}</div></div>
  </div>
  <div style="padding:10px 14px;border-bottom:1px solid #1e2330">
    <div style="font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Indicadores — ganadores vs perdedores</div>
    <div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:10px;color:#4b5563;margin-bottom:3px"><span>Confianza promedio</span><div style="display:flex;gap:8px"><span style="color:#00d68f">✓ ${d.avgConfidenceWon||'–'}</span><span style="color:#ff4d6d">✗ ${d.avgConfidenceLost||'–'}</span></div></div></div>
    <div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:10px;color:#4b5563;margin-bottom:3px"><span>RSI 15m promedio</span><div style="display:flex;gap:8px"><span style="color:#00d68f">✓ ${d.avgRsiWon||'–'}</span><span style="color:#ff4d6d">✗ ${d.avgRsiLost||'–'}</span></div></div></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span style="font-size:10px;color:#4b5563">Con Fibonacci activo</span><span class="mono" style="font-size:11px;font-weight:700;color:${parseFloat(d.winRateWithFib||0)>wr?'#00d68f':'#f59e0b'}">${parseFloat(d.winRateWithFib||0).toFixed(1)}% WR</span></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span style="font-size:10px;color:#4b5563">Con ballenas activas</span><span class="mono" style="font-size:11px;font-weight:700;color:${parseFloat(d.winRateWithWhales||0)>wr?'#00d68f':'#f59e0b'}">${parseFloat(d.winRateWithWhales||0).toFixed(1)}% WR</span></div>
    <div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:10px;color:#4b5563">4H alineado con señal</span><span class="mono" style="font-size:11px;font-weight:700;color:${parseFloat(d.winRateAligned4h||0)>wr?'#00d68f':'#f59e0b'}">${d.winRateAligned4h||'–'}% WR</span></div>
  </div>
  ${topDivs.length?`<div style="padding:10px 14px;border-bottom:1px solid #1e2330"><div style="font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Divergencias con más victorias</div>${topDivs.map(([type,count])=>{const barW=Math.round((count/maxDivCount)*100);return`<div style="margin-bottom:6px"><div style="display:flex;justify-content:space-between;font-size:10px;color:#e2e4ea;margin-bottom:2px"><span>${divLabels[type]||type}</span><span style="color:#00d68f;font-weight:700">${count} victorias</span></div><div style="height:3px;background:#1e2330;border-radius:2px;overflow:hidden"><div style="height:100%;width:${barW}%;background:#00d68f;border-radius:2px"></div></div></div>`;}).join('')}</div>`:''}
  ${(()=>{if(!d.bySource||Object.keys(d.bySource).length===0)return'';const rows=Object.entries(d.bySource).map(([src,s])=>{const srcLabel=src==='scalping'?'⚡ Scalping':src==='auto'?'🤖 Auto':src==='manual'?'👤 Manual':src==='sweep'?'🌊 Sweep':src==='wall'?'🧱 Wall':src==='meanrev'?'📈 MeanRev':'📊 Backtest';const srcCol=src==='scalping'?'#8b5cf6':src==='auto'?'#00d68f':src==='manual'?'#f59e0b':src==='sweep'?'#38bdf8':src==='wall'?'#f97316':src==='meanrev'?'#10b981':'#4b5563';const wrCol=s.winRate>=55?'#00d68f':s.winRate>=45?'#f59e0b':'#ff4d6d';const pnlCol=s.totalPnl>=0?'#00d68f':'#ff4d6d';const pnlStr=(s.totalPnl>=0?'+':'')+'$'+Math.abs(s.totalPnl).toFixed(0);return'<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.03)"><span style="font-size:11px;font-weight:700;color:'+srcCol+';min-width:90px">'+srcLabel+'</span><span style="font-size:10px;color:#4b5563;min-width:50px">'+s.total+' trades</span><span class="mono" style="font-size:11px;font-weight:700;color:'+wrCol+';min-width:45px">'+s.winRate+'%</span><span class="mono" style="font-size:11px;font-weight:700;color:'+pnlCol+';margin-left:auto">'+pnlStr+'</span></div>';}).join('');return'<div style="padding:10px 14px;border-bottom:1px solid #1e2330"><div style="font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Rendimiento por modo</div>'+rows+'</div>';})()}
  ${d.recommendations?.length?`<div style="padding:10px 14px"><div style="font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Recomendaciones del sistema</div>${d.recommendations.map(r=>`<div style="display:flex;gap:6px;padding:5px 8px;background:rgba(245,158,11,.06);border-radius:5px;border:1px solid rgba(245,158,11,.15);margin-bottom:5px"><span style="font-size:12px;flex-shrink:0">⬟</span><span style="font-size:10px;color:#f59e0b;line-height:1.5">${r}</span></div>`).join('')}</div>`:`<div style="padding:10px 14px;text-align:center;font-size:11px;color:#2a3040">Acumula más trades para ver recomendaciones</div>`}`;
}

let scalpingOn=false;
async function toggleScalping(){
  const btn=document.getElementById('scalp-btn');const icon=document.getElementById('scalp-icon');
  if(!scalpingOn){
    btn.disabled=true;icon.textContent='⏳';
    const res=await fetch(`${API}/api/scalping/start`,{method:'POST'}).then(r=>r.json()).catch(()=>null);
    btn.disabled=false;
    if(res?.ok){scalpingOn=true;btn.style.background='rgba(139,92,246,.35)';btn.style.borderColor='#8b5cf6';btn.style.boxShadow='0 0 10px rgba(139,92,246,.5)';icon.textContent='⚡';showToast('⚡ Scalping activado — análisis cada 3 min','#8b5cf6');}
    else{icon.textContent='⚡';showToast('Error al activar scalping','#ff4d6d');}
  } else {
    await fetch(`${API}/api/scalping/stop`,{method:'POST'}).catch(()=>null);
    scalpingOn=false;btn.style.background='rgba(139,92,246,.1)';btn.style.borderColor='rgba(139,92,246,.35)';btn.style.boxShadow='none';icon.textContent='⚡';showToast('Scalping desactivado','#f59e0b');
  }
}
async function checkScalpingStatus(){
  try{const res=await fetch(`${API}/api/scalping/status`).then(r=>r.json());if(res.active){scalpingOn=true;const btn=document.getElementById('scalp-btn');if(btn){btn.style.background='rgba(139,92,246,.35)';btn.style.borderColor='#8b5cf6';btn.style.boxShadow='0 0 10px rgba(139,92,246,.5)';}}}catch(_){}
}

async function fetchAllPrices(){
  try{const p=await fetch(`${API}/api/prices`).then(r=>r.json());if(p&&!p.error)allPrices=p;}catch(_){}
}

async function refreshNews(){
  const el=document.getElementById('news-panel');if(!el)return;
  el.innerHTML='<div style="padding:12px 14px;text-align:center;font-size:11px;color:#4b5563">Cargando noticias...</div>';
  function sentimentTag(title) {
    const t=title.toLowerCase();
    const bull=['surge','jump','rally','bullish','etf','approval','buy','rise','pump','adopt','partnership','launch','upgrade','all-time','ath','record','gains','soars'].some(w=>t.includes(w));
    const bear=['crash','drop','fall','bearish','ban','hack','sell','dump','fear','war','sanction','inflation','lawsuit','fraud','scam','plunge','tumble','slump','concerns'].some(w=>t.includes(w));
    return bull?{col:'#00d68f',emoji:'🟢',label:'ALCISTA'}:bear?{col:'#ff4d6d',emoji:'🔴',label:'BAJISTA'}:{col:'#f59e0b',emoji:'🟡',label:'NEUTRO'};
  }
  function renderNewsItems(items) {
    if(!items||!items.length){el.innerHTML='<div style="padding:12px 14px;text-align:center;font-size:11px;color:#4b5563">Sin noticias recientes</div>';return;}
    el.innerHTML=items.slice(0,6).map(n=>{
      const title=n.title||'';const src=n.source||'';
      const ago=n.published_on?Math.round((Date.now()/1000-n.published_on)/60)+'m':'';
      const s=sentimentTag(title);const url=n.url||'#';
      return`<div style="padding:10px 14px;border-bottom:1px solid #1a2035;cursor:pointer" onclick="window.open('${url}','_blank')">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span>${s.emoji}</span><span style="font-size:10px;color:${s.col};font-weight:700">${s.label}</span>
          <span style="font-size:9px;color:#2a3040;margin-left:auto">${src}${ago?' · '+ago:''}</span>
        </div>
        <div style="font-size:11px;color:#e2e4ea;line-height:1.4">${title}</div>
      </div>`;
    }).join('');
  }
  try {
    const data = await fetch(`${API}/api/news/latest`,{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
    if(data && Array.isArray(data) && data.length >= 1) { renderNewsItems(data); return; }
  } catch(_) {}
  try {
    const cc = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=10',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
    if(cc.Data?.length) { renderNewsItems(cc.Data.map(n=>({title:n.title,source:n.source_info?.name||n.source,published_on:n.published_on,url:n.url}))); return; }
  } catch(_) {}
  try {
    const rssUrl = encodeURIComponent('https://cointelegraph.com/rss');
    const proxy = await fetch(`https://api.allorigins.win/get?url=${rssUrl}`,{signal:AbortSignal.timeout(6000)}).then(r=>r.json());
    if(proxy.contents) {
      const items=[];const rx=/<item>([\s\S]*?)<\/item>/g;let m;
      while((m=rx.exec(proxy.contents))!==null&&items.length<8){
        const it=m[1];
        const title=(it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||it.match(/<title>(.*?)<\/title>/))?.[1]||'';
        const url=(it.match(/<link>(.*?)<\/link>/))?.[1]||'';
        const pub=(it.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]||'';
        if(title) items.push({title:title.trim(),source:'CoinTelegraph',published_on:pub?Math.floor(new Date(pub).getTime()/1000):Math.floor(Date.now()/1000),url});
      }
      if(items.length){renderNewsItems(items);return;}
    }
  } catch(_) {}
  el.innerHTML='<div style="padding:12px 14px;font-size:11px;color:#4b5563;text-align:center">⚠ Noticias no disponibles — <a href="https://cointelegraph.com" target="_blank" style="color:#f59e0b">ver CoinTelegraph</a></div>';
}

fetchAll();
fetchAllPrices();
// ── Semáforo de sesión ────────────────────────────────────────────────────
async function updateSesion() {
  try {
    const d = await fetch('/api/sesion').then(r => r.json());
    const dot = document.getElementById('sesion-dot');
    const label = document.getElementById('sesion-label');
    const badge = document.getElementById('sesion-badge');
    if (!badge) return;
    if (d.activa) {
      badge.style.background = 'rgba(0,214,143,.1)';
      badge.style.borderColor = 'rgba(0,214,143,.3)';
      badge.style.color = '#00d68f';
      dot.style.background = '#00d68f';
      label.textContent = `${d.emoji} ${d.nombre} · ${d.horaLima}h Lima`;
    } else {
      badge.style.background = 'rgba(255,77,109,.08)';
      badge.style.borderColor = 'rgba(255,77,109,.2)';
      badge.style.color = '#ff4d6d';
      dot.style.background = '#ff4d6d';
      label.textContent = `${d.emoji} ${d.nombre} · ${d.horaLima}h Lima`;
    }
  } catch(_) {}
}

// ── Dashboard macro — actualiza con datos del análisis ────────────────────
function updateMacroDashboard() {
  if (!mkt || !mkt.timeframes) return;
  const tf = mkt.timeframes;
  const sym = currentSymbol || 'BTC';

  const cvd1h = tf['1H']?.cvdPct;
  const cvd4h = tf['4H']?.cvdPct;
  const fr    = tf['15m']?.fundingRate;
  const oi    = tf['4H']?.oiDeltaPct;

  const fmt = (n, suffix='%') => `${n > 0 ? '+' : ''}${parseFloat(n).toFixed(n > 10 || n < -10 ? 1 : 2)}${suffix}`;
  const col = n => n > 20 ? '#00d68f' : n < -20 ? '#ff4d6d' : n > 5 ? '#38bdf8' : n < -5 ? '#f59e0b' : '#4b5563';

  const el1h = document.getElementById('macro-cvd1h');
  if (el1h && cvd1h !== undefined) el1h.innerHTML = `CVD 1H: <span style="color:${col(cvd1h)};font-weight:700">${fmt(cvd1h)}</span>`;

  const el4h = document.getElementById('macro-cvd4h');
  if (el4h && cvd4h !== undefined) el4h.innerHTML = `CVD 4H: <span style="color:${col(cvd4h)};font-weight:700">${fmt(cvd4h)}</span>`;

  if (fr !== undefined) {
    const elFr = document.getElementById('macro-funding');
    const n = parseFloat(fr) * 100;
    const c = Math.abs(n) < 0.005 ? '#4b5563' : n > 0 ? '#ff4d6d' : '#00d68f';
    if (elFr) elFr.innerHTML = `FR: <span style="color:${c};font-weight:700">${n > 0 ? '+' : ''}${n.toFixed(4)}%</span>`;
  }

  if (oi !== undefined) {
    const elOi = document.getElementById('macro-oi');
    const n = parseFloat(oi);
    const c = n > 0.3 ? '#00d68f' : n < -0.3 ? '#ff4d6d' : '#4b5563';
    if (elOi) elOi.innerHTML = `OI 4H: <span style="color:${c};font-weight:700">${fmt(n)}</span>`;
  }

  // Score de confluencia
  let score = 0;
  if (cvd1h !== undefined) score += cvd1h > 20 ? 2 : cvd1h < -20 ? -2 : 0;
  if (cvd4h !== undefined) score += cvd4h > 20 ? 2 : cvd4h < -20 ? -2 : 0;
  if (fr !== undefined) score += parseFloat(fr) < -0.005 ? 1 : parseFloat(fr) > 0.005 ? -1 : 0;
  if (oi !== undefined) score += parseFloat(oi) > 0.5 ? 1 : parseFloat(oi) < -0.5 ? -1 : 0;

  const elScore = document.getElementById('macro-score');
  if (elScore) {
    const lbl = score >= 3 ? '🟢 Alcista' : score <= -3 ? '🔴 Bajista' : score >= 1 ? '🔵 Leve alcista' : score <= -1 ? '🟠 Leve bajista' : '🟡 Neutral';
    const c = score >= 3 ? '#00d68f' : score <= -3 ? '#ff4d6d' : score >= 1 ? '#38bdf8' : score <= -1 ? '#f59e0b' : '#4b5563';
    const bg = score >= 3 ? 'rgba(0,214,143,.1)' : score <= -3 ? 'rgba(255,77,109,.1)' : 'rgba(75,85,99,.1)';
    elScore.style.color = c;
    elScore.style.background = bg;
    elScore.textContent = `Score ${score > 0 ? '+' : ''}${score} · ${lbl}`;
  }
}

setInterval(fetchAll,30000);
setInterval(fetchAllPrices,15000);
setInterval(updateSesion, 60000);
setInterval(updateMacroDashboard, 15000);
setTimeout(()=>{ updateMacroDashboard(); updateSesion(); }, 1500);
setTimeout(refreshWsWidget, 3000);
setInterval(refreshWsWidget, 5000);
setTimeout(refreshNews,5000);
setInterval(refreshNews,5*60*1000);
setTimeout(refreshML,3000);
setInterval(refreshPaper,60000);
setTimeout(refreshPaper,2000);
setTimeout(checkScalpingStatus,3000);

async function loadBinanceAccount() {
  const el = document.getElementById('binance-acct-body');
  const statusEl = document.getElementById('binance-acct-status');
  if (!el) return;
  try {
    const d = await fetch(`${API}/api/binance/account`).then(r=>r.json());
    if (!d.available || d.error) {
      el.innerHTML = `<div style="color:#4b5563;font-size:11px;text-align:center">⚠️ ${d.error||'No disponible'}</div>`;
      return;
    }
    if (statusEl) { statusEl.textContent='● live'; statusEl.style.color='#00d68f'; }
    const pnlCol = d.totalUnrealizedProfit >= 0 ? '#00d68f' : '#ff4d6d';
    const pnlSign = d.totalUnrealizedProfit >= 0 ? '+' : '';
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
        <div style="background:#111520;border-radius:6px;padding:8px">
          <div style="font-size:9px;color:#4b5563;margin-bottom:2px">BALANCE</div>
          <div class="mono" style="font-size:14px;font-weight:700">$${d.totalWalletBalance.toFixed(2)}</div>
        </div>
        <div style="background:#111520;border-radius:6px;padding:8px">
          <div style="font-size:9px;color:#4b5563;margin-bottom:2px">DISPONIBLE</div>
          <div class="mono" style="font-size:14px;font-weight:700">$${d.availableBalance.toFixed(2)}</div>
        </div>
        <div style="background:#111520;border-radius:6px;padding:8px">
          <div style="font-size:9px;color:#4b5563;margin-bottom:2px">PNL NO REALIZADO</div>
          <div class="mono" style="font-size:14px;font-weight:700;color:${pnlCol}">${pnlSign}$${d.totalUnrealizedProfit.toFixed(2)}</div>
        </div>
        <div style="background:#111520;border-radius:6px;padding:8px">
          <div style="font-size:9px;color:#4b5563;margin-bottom:2px">MARGEN USADO</div>
          <div class="mono" style="font-size:14px;font-weight:700">$${d.totalPositionInitialMargin.toFixed(2)}</div>
        </div>
      </div>
      ${d.positions.length ? `
        <div style="font-size:9px;color:#4b5563;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Posiciones abiertas</div>
        ${d.positions.map(p => {
          const side = p.positionAmt > 0 ? 'LONG' : 'SHORT';
          const sc = side==='LONG'?'#00d68f':'#ff4d6d';
          const pc = p.unrealizedProfit>=0?'#00d68f':'#ff4d6d';
          const ps = p.unrealizedProfit>=0?'+':'';
          return `<div style="background:#111520;border-radius:5px;padding:7px 8px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
            <div>
              <span style="color:${sc};font-weight:700;font-size:11px">${side}</span>
              <span style="color:#6b7280;font-size:10px;margin-left:6px">${p.symbol}</span>
              <span style="color:#4b5563;font-size:9px;margin-left:4px">${p.leverage}x</span>
            </div>
            <div style="text-align:right">
              <div class="mono" style="font-size:11px">$${parseInt(p.entryPrice).toLocaleString()}</div>
              <div class="mono" style="font-size:11px;color:${pc}">${ps}$${p.unrealizedProfit.toFixed(2)}</div>
            </div>
          </div>`;
        }).join('')}
      ` : '<div style="color:#2a3040;font-size:11px;text-align:center">Sin posiciones abiertas</div>'}
    `;
  } catch(e) {
    if (el) el.innerHTML = `<div style="color:#4b5563;font-size:11px;text-align:center">Error cargando cuenta</div>`;
  }
}
setTimeout(loadBinanceAccount, 4000);
setInterval(loadBinanceAccount, 30000);

async function runBacktest() {
  const btn = document.getElementById('bt-btn');
  const results = document.getElementById('bt-results');
  btn.disabled = true; btn.textContent = '⏳';
  results.innerHTML = '<div style="color:#8b5cf6;text-align:center;padding:20px">Descargando datos y simulando... puede tomar 10-15 segundos</div>';
  try {
    const body = {
      symbol: document.getElementById('bt-symbol').value,
      days: parseInt(document.getElementById('bt-days').value),
      module: document.getElementById('bt-mode').value,
      baseVolMult: 5,
      filteredVolMult: parseFloat(document.getElementById('bt-vol')?.value || 4),
      filteredBias1dScore: parseFloat(document.getElementById('bt-bias')?.value || 58),
      filteredBias1hScore: 40,
      filteredMinCVD: parseFloat(document.getElementById('bt-cvd')?.value || 25),
      filteredMinPriceMove: 0.1,
      scalpRsiMin: parseFloat(document.getElementById('bt-rsi-min').value),
      scalpRsiMax: parseFloat(document.getElementById('bt-rsi-max').value),
      scalpMinImbalance: parseFloat(document.getElementById('bt-imb').value),
      scalpMomentumPct: parseFloat(document.getElementById('bt-mom').value),
      sweepMinVolMult: parseFloat(document.getElementById('bt-vol').value),
      sweepMinCVD: parseFloat(document.getElementById('bt-cvd').value),
      sweepBias1dScore: parseFloat(document.getElementById('bt-bias').value),
    };
    const res = await fetch(`${API}/api/backtest`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    renderBacktestResults(d);
  } catch(e) {
    results.innerHTML = `<div style="color:#ff4d6d;text-align:center;padding:10px">Error: ${e.message}</div>`;
  }
  btn.disabled = false; btn.textContent = '▶ Correr';
}

function renderBacktestResults(d) {
  const el = document.getElementById('bt-results');
  function statsHtml(stats, color, label, icon) {
    const wrCol = stats.winRate >= 55 ? '#00d68f' : stats.winRate >= 45 ? '#f59e0b' : '#ff4d6d';
    const pnlCol = stats.totalPnl >= 0 ? '#00d68f' : '#ff4d6d';
    const pfCol = stats.profitFactor >= 1.5 ? '#00d68f' : stats.profitFactor >= 1 ? '#f59e0b' : '#ff4d6d';
    return `<div style="background:#111520;border-radius:6px;padding:10px;border:1px solid ${color}33">
      <div style="font-size:10px;color:${color};font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">${icon} ${label} — ${stats.total} trades</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px">
        <div style="text-align:center"><div style="font-size:9px;color:#4b5563">Win Rate</div><div class="mono" style="font-size:14px;font-weight:700;color:${wrCol}">${stats.winRate}%</div></div>
        <div style="text-align:center"><div style="font-size:9px;color:#4b5563">PnL</div><div class="mono" style="font-size:14px;font-weight:700;color:${pnlCol}">${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl}</div></div>
        <div style="text-align:center"><div style="font-size:9px;color:#4b5563">P.Factor</div><div class="mono" style="font-size:14px;font-weight:700;color:${pfCol}">${stats.profitFactor}</div></div>
        <div style="text-align:center"><div style="font-size:9px;color:#4b5563">Max DD</div><div class="mono" style="font-size:14px;font-weight:700;color:#ff4d6d">-$${stats.maxDrawdown}</div></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px;font-size:10px;color:#4b5563">
        <span>✓ Avg ganador: <span style="color:#00d68f">+$${stats.avgWin}</span></span>
        <span>✗ Avg perdedor: <span style="color:#ff4d6d">-$${stats.avgLoss}</span></span>
      </div>
    </div>`;
  }
  const mode = document.getElementById('bt-mode')?.value || 'both';
  let html = `<div style="font-size:10px;color:#4b5563;margin-bottom:8px;text-align:center">${d.symbol} · últimos ${d.days} días · $1,000 x5 por trade</div><div style="display:flex;flex-direction:column;gap:8px">`;
  if (mode === 'momentum' && d.momentum) {
    const s = d.momentum.stats;
    const zCol = s.zScore >= 5 ? '#00d68f' : s.zScore >= 1.96 ? '#f59e0b' : s.zScore <= -1.96 ? '#ff4d6d' : '#4b5563';
    const zLabel = s.zScore >= 5 ? '★★★ Muy significativo' : s.zScore >= 1.96 ? '★ Significativo' : s.zScore <= -5 ? '✗✗✗ Edge INVERSO muy fuerte' : s.zScore <= -1.96 ? '✗ Edge inverso' : '— No significativo';
    html += `${statsHtml(s, '#00d68f', 'Momentum (vol spike + tendencia)', '📈')}`;
    html += `<div style="background:#111520;border-radius:6px;padding:10px;border:1px solid rgba(0,214,143,.3)">
      <div style="font-size:10px;color:#00d68f;font-weight:700;margin-bottom:6px">📈 Validación estadística</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:11px;color:#4b5563">Z-Score</span>
        <span class="mono" style="font-size:13px;font-weight:700;color:${zCol}">${s.zScore || 'N/A'}</span>
      </div>
      <div style="font-size:10px;color:${zCol}">${zLabel}</div>
      <div style="font-size:9px;color:#2a3040;margin-top:4px">N=${s.n} trades · z>1.96 = edge momentum · z<-1.96 = edge mean reversion</div>
    </div>`;
  } else if (mode === 'filtered' && d.filtered) {
    const s = d.filtered.stats;
    const zCol = s.zScore >= 5 ? '#00d68f' : s.zScore >= 1.96 ? '#f59e0b' : s.zScore <= -1.96 ? '#ff4d6d' : '#4b5563';
    const zLabel = s.zScore >= 5 ? '★★★ Edge muy significativo' : s.zScore >= 1.96 ? '★ Edge significativo' : s.zScore <= -1.96 ? '✗ Edge inverso' : '— No significativo';
    html += `${statsHtml(s, '#8b5cf6', 'Filtered (todos los filtros del sistema)', '🔬')}`;
    html += `<div style="background:#111520;border-radius:6px;padding:10px;border:1px solid rgba(139,92,246,.3)">
      <div style="font-size:10px;color:#8b5cf6;font-weight:700;margin-bottom:6px">🔬 Validación estadística</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:11px;color:#4b5563">Z-Score</span>
        <span class="mono" style="font-size:13px;font-weight:700;color:${zCol}">${s.zScore || 'N/A'}</span>
      </div>
      <div style="font-size:10px;color:${zCol}">${zLabel}</div>
      <div style="font-size:9px;color:#2a3040;margin-top:4px">N=${s.n} trades · Incluye Fix A/B/C2 · Parámetros ajustables arriba</div>
    </div>`;
  } else if (mode === 'base' && d.base) {
    const s = d.base.stats;
    const zCol = Math.abs(s.zScore||0) >= 5 ? '#00d68f' : Math.abs(s.zScore||0) >= 1.96 ? '#f59e0b' : '#ff4d6d';
    const zLabel = Math.abs(s.zScore||0) >= 5 ? '★★★ Muy significativo' : Math.abs(s.zScore||0) >= 1.96 ? '★ Significativo' : '✗ No significativo';
    html += `${statsHtml(s, '#f59e0b', 'Base (vol spike + mean reversion)', '📊')}`;
    html += `<div style="background:#111520;border-radius:6px;padding:10px;border:1px solid rgba(245,158,11,.3)">
      <div style="font-size:10px;color:#f59e0b;font-weight:700;margin-bottom:6px">📈 Validación estadística</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:11px;color:#4b5563">Z-Score</span>
        <span class="mono" style="font-size:13px;font-weight:700;color:${zCol}">${s.zScore || 'N/A'}</span>
      </div>
      <div style="font-size:10px;color:${zCol}">${zLabel}</div>
      <div style="font-size:9px;color:#2a3040;margin-top:4px">N=${s.n} trades · z>1.96 = significativo · z>5 = muy significativo</div>
    </div>`;
  } else {
    if (d.scalping) html += statsHtml(d.scalping.stats, '#8b5cf6', 'Scalping', '⚡');
    if (d.sweep) html += statsHtml(d.sweep.stats, '#38bdf8', 'Sweep', '🌊');
  }
  html += `</div><div style="margin-top:8px;font-size:9px;color:#2a3040;text-align:center">⚠ Backtest no incluye slippage ni fees. Los resultados son orientativos.</div>`;
  el.innerHTML = html;
}

</script>
</body>
</html>
