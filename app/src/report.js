// Self-contained HTML intent report (opens offline, prints cleanly).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isoDay } from "./score.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let LOGO = "";
try {
  LOGO = "data:image/png;base64," + fs.readFileSync(path.join(here, "..", "public", "assets", "logo.png")).toString("base64");
} catch {}

// Hot is a deeper red than the site's #E8033A so Hot and Warm stay distinguishable (validated, CVD-safe).
const LEVEL_COLOR = { Hot: "#C0022F", Warm: "#FF6903", Watch: "#7A76DA" };
const SERIES = "#6D08BE";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString("en-US");
const fmtDate = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function levelSplit(levels, total) {
  if (!total) return "";
  const segs = ["Hot", "Warm", "Watch"].filter((k) => levels[k] > 0);
  return `<div class="split" role="img" aria-label="Hot ${levels.Hot}, Warm ${levels.Warm}, Watch ${levels.Watch}">
    ${segs.map((k) => `<div class="seg" style="flex:${levels[k]};background:${LEVEL_COLOR[k]}" data-tip="${k}: ${fmt(levels[k])} accounts (${Math.round((100 * levels[k]) / total)}%)"></div>`).join("")}
  </div>
  <div class="legend">${["Hot", "Warm", "Watch"].map((k) => `<span><i style="background:${LEVEL_COLOR[k]}"></i>${k} <b>${fmt(levels[k])}</b> <em>${Math.round((100 * levels[k]) / total)}%</em></span>`).join("")}</div>`;
}

function signalBars(mix) {
  if (!mix.length) return `<p class="muted">No scoring signals in the window.</p>`;
  const max = Math.max(...mix.map((s) => s.count));
  return `<div class="hbars">${mix.slice(0, 10).map((s) => `
    <div class="hrow" data-tip="${esc(s.label)}: ${fmt(s.count)} events">
      <span class="hl">${esc(s.label)}</span>
      <span class="htrack"><span class="hfill" style="width:${Math.max(1.5, (100 * s.count) / max)}%;background:${SERIES}"></span></span>
      <span class="hv">${fmt(s.count)}</span>
    </div>`).join("")}</div>`;
}

function weeklyChart(weeks) {
  if (!weeks.length) return "";
  const W = 1000, H = 260, L = 44, R = 8, T = 12, B = 32;
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = (W - L - R) / weeks.length;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const grid = [];
  for (let v = 0; v <= top; v += step) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${fmt(v)}</text>`);
  const every = Math.ceil(weeks.length / 8);
  const bars = weeks.map((w, i) => {
    const x = L + i * bw + 1, h = (H - T - B) - (y(w.count) - T), width = Math.max(2, bw - 2);
    const r = Math.min(4, width / 2, h);
    const label = `Week of ${fmtDate(w.week)}: ${fmt(w.count)} signals`;
    return `<g data-tip="${esc(label)}"><rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent"/>` +
      (w.count ? `<path d="${roundTop(x, y(w.count), width, h, r)}" fill="${SERIES}"/>` : "") +
      (i % every === 0 ? `<text x="${x + width / 2}" y="${H - 10}" text-anchor="middle" class="ax">${esc(new Date(w.week).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }))}</text>` : "") + `</g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Weekly signal count">${grid.join("")}${bars.join("")}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="base"/></svg>`;
}

function roundTop(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceStep(max) {
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) || p * 10;
}

function topTable(accounts) {
  if (!accounts.length) return `<p class="muted">No accounts could be scored. Check that your files include company email addresses or domains.</p>`;
  return `<div class="tbl"><table>
    <thead><tr><th>#</th><th>Account</th><th class="num">Score</th><th>Level</th><th class="num">Contacts</th><th>Top signals</th><th>Last activity</th><th>Suggested action</th></tr></thead>
    <tbody>${accounts.slice(0, 25).map((a, i) => `
      <tr>
        <td class="muted">${i + 1}</td>
        <td><b>${esc(a.name)}</b><small>${esc(a.domain)}</small></td>
        <td class="num"><div class="sc"><span class="scbar"><i style="width:${a.score}%;background:${LEVEL_COLOR[a.level]}"></i></span><b>${a.score}</b></div></td>
        <td><span class="lvl"><i style="background:${LEVEL_COLOR[a.level]}"></i>${a.level}</span></td>
        <td class="num">${a.engaged}</td>
        <td>${esc(a.topSignals.map((s) => `${s.label} (${s.count})`).join(", "))}</td>
        <td class="nowrap">${fmtDate(a.last)}</td>
        <td>${esc(a.action)}<small>${esc(a.reason)}</small></td>
      </tr>`).join("")}</tbody></table></div>`;
}

export function renderReport(result, narrative, info) {
  const s = result.stats;
  const total = result.accounts.length;
  const title = `${info.company ? info.company + " " : ""}first-party intent report`;
  const sig = Object.entries(info.cfg.signals).filter(([, v]) => v.points !== 0).sort((a, b) => b[1].points - a[1].points);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title.charAt(0).toUpperCase() + title.slice(1))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..650&family=Montserrat:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light;--paper:#FDFCF8;--card:#fff;--ink:#1A1230;--ink2:#463F5C;--muted:#6E6782;--line:#E4DEEE;--accent:#6D08BE;
--grad:linear-gradient(100deg,#6D08BE 0%,#A10FA8 45%,#E8033A 78%,#FF6903 100%);--serif:"Fraunces",Georgia,serif;--sans:"Montserrat",Arial,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans)}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
header{background:#0B031D;color:#fff;padding:28px 0 36px;position:relative}
header:after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;background:var(--grad)}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.top img{height:44px;width:auto}
.eyebrow{font:500 12px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:#C9A2F5}
h1{font:600 clamp(28px,4.6vw,46px)/1.1 var(--serif);margin:22px 0 10px;letter-spacing:-.01em}
.meta{color:#CFC6E2;font-size:14px}
.lead{font:400 clamp(18px,2.2vw,22px)/1.45 var(--serif);margin:0 0 6px;color:var(--ink)}
main{padding:32px 0 48px}
section{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px;margin-top:20px}
h2{font:600 22px/1.2 var(--serif);margin:0 0 4px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:20px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.kpi b{display:block;font:600 34px/1.1 var(--serif)}.kpi span{color:var(--muted);font-size:13px;display:flex;align-items:center;gap:8px}
.kpi i,.legend i,.lvl i{display:inline-block;width:10px;height:10px;border-radius:3px}
.split{display:flex;gap:2px;height:28px;border-radius:8px;overflow:hidden}.seg{min-width:4px}
.legend{display:flex;flex-wrap:wrap;gap:18px;margin-top:12px;font-size:14px;color:var(--ink2)}
.legend span{display:flex;align-items:center;gap:8px}.legend em{color:var(--muted);font-style:normal}
.hbars{display:grid;gap:10px}.hrow{display:grid;grid-template-columns:minmax(110px,220px) minmax(0,1fr) 48px;gap:12px;align-items:center;font-size:14px}
.hl{color:var(--ink2)}.htrack{height:14px;display:block}.hfill{display:block;height:100%;border-radius:0 4px 4px 0}.hv{text-align:right;font-family:var(--mono);color:var(--ink2)}
.chart{width:100%;height:auto;display:block}.chart .grid{stroke:var(--line);stroke-width:1}.chart .base{stroke:#B9B1CB;stroke-width:1}.chart .ax{fill:var(--muted);font:12px var(--mono)}
.tbl{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px;min-width:880px}
th{text-align:left;font:500 11px/1.2 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:10px 10px;border-bottom:1px solid var(--line)}
td{padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td small{display:block;color:var(--muted);font-size:12.5px;margin-top:3px}
.num{text-align:right}.nowrap{white-space:nowrap}.muted{color:var(--muted)}
.sc{display:flex;align-items:center;gap:8px;justify-content:flex-end}.scbar{width:64px;height:8px;background:#F1EDF6;border-radius:4px;overflow:hidden;display:block}.scbar i{display:block;height:100%;border-radius:0 4px 4px 0}
.lvl{display:inline-flex;align-items:center;gap:6px;font-weight:600}
@media(max-width:700px){
  section{padding:18px 16px}
  table{min-width:0}thead{display:none}
  tr{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:6px 10px;padding:14px 0;border-bottom:1px solid var(--line)}
  td{border:0;padding:0}td:nth-child(n+4){grid-column:2/4}td:nth-child(5),td:nth-child(7){display:none}
  .num{text-align:left}
}
ul.ins{margin:0;padding-left:20px}ul.ins li{margin:6px 0}
.method{font-size:13.5px;color:var(--ink2)}.method code{font-family:var(--mono);font-size:12.5px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12.5px}
footer{color:var(--muted);font-size:13px;padding:0 0 40px}
#tip{position:fixed;pointer-events:none;background:#1A1230;color:#fff;font-size:13px;padding:6px 10px;border-radius:8px;opacity:0;transition:opacity .12s;z-index:9;max-width:280px}
@media print{body{background:#fff}header{-webkit-print-color-adjust:exact;print-color-adjust:exact}section{break-inside:avoid}#tip{display:none}}
</style></head>
<body>
<header><div class="wrap">
  <div class="top">${LOGO ? `<img src="${LOGO}" alt="LakeB2B">` : `<b>LakeB2B</b>`}<span class="eyebrow">First-Party Intent Report</span></div>
  <h1>${esc(narrative.headline || title)}</h1>
  <div class="meta">${esc(info.company || "Your company")} · Scores as of ${fmtDate(result.asOf)} · ${esc(info.window || "")} · ${info.files.length} file${info.files.length === 1 ? "" : "s"}${info.email ? ` · Prepared for ${esc(info.email)}` : ""}</div>
</div></header>
<main><div class="wrap">
  <p class="lead">${esc(narrative.summary)}</p>
  <div class="kpis">
    <div class="kpi"><b>${fmt(total)}</b><span>Accounts scored</span></div>
    ${["Hot", "Warm", "Watch"].map((k) => `<div class="kpi"><b>${fmt(s.levels[k])}</b><span><i style="background:${LEVEL_COLOR[k]}"></i>${k} accounts</span></div>`).join("")}
    <div class="kpi"><b>${fmt(s.engagedContacts)}</b><span>Engaged contacts</span></div>
  </div>

  <section><h2>Intent level split</h2><p class="sub">Hot 70 to 100 · Warm 40 to 69 · Watch 0 to 39</p>${levelSplit(s.levels, total)}</section>

  <section><h2>Top accounts</h2><p class="sub">Highest intent first. The full list is in the account scores CSV.</p>${topTable(result.accounts)}</section>

  <section><h2>Signal mix</h2><p class="sub">Scoring events by signal type, ${fmt(s.eventsInWindow)} events in the window</p>${signalBars(s.signalMix)}</section>
  <section><h2>Weekly activity</h2><p class="sub">Scoring signals per week, ${fmtDate(result.from)} to ${fmtDate(result.asOf)}</p>${weeklyChart(s.weekly)}</section>

  ${narrative.insights?.length ? `<section><h2>What stands out</h2><ul class="ins">${narrative.insights.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}

  <section class="method"><h2>How these scores were built</h2>
    <p>Each activity is classified into a signal and earns points. Points halve every ${info.cfg.halfLifeDays} days of age, repeat events are capped per contact, and accounts with more engaged contacts get up to a ${info.cfg.buyingGroup.max}x buying-group boost. The total is scaled to 0 to 100.</p>
    <div class="chips">${sig.map(([, v]) => `<span class="chip">${esc(v.label)} ${v.points > 0 ? "+" : ""}${v.points}</span>`).join("")}</div>
    <p style="margin-top:14px">Sources: ${info.files.map((f) => `${esc(f.name)} (${esc(f.source)}, ${fmt(f.used)} of ${fmt(f.rows)} rows used)`).join("; ")}.</p>
    ${info.model ? `<p>Activity classification and narrative by <code>${esc(info.model)}</code> via OpenRouter (${fmt(info.classifiedByModel)} of ${fmt(info.totalEvents)} events classified by the model, the rest by built-in rules).</p>` : `<p>Activity classified by built-in rules (no AI model configured).</p>`}
    ${[...info.llmNotes, ...info.warnings].map((w) => `<p class="muted">${esc(w)}</p>`).join("")}
  </section>
</div></main>
<footer><div class="wrap">Generated ${fmtDate(new Date())} by the First-Party Intent Calculator, powered by LakeB2B.</div></footer>
<div id="tip" role="tooltip"></div>
<script>
(function(){var t=document.getElementById("tip");document.addEventListener("mousemove",function(e){var el=e.target.closest&&e.target.closest("[data-tip]");if(!el){t.style.opacity=0;return}t.textContent=el.getAttribute("data-tip");t.style.opacity=1;var x=e.clientX+14,y=e.clientY+14;if(x+t.offsetWidth>innerWidth-8)x=e.clientX-t.offsetWidth-14;t.style.left=x+"px";t.style.top=y+"px"});})();
</script>
</body></html>`;
}

export { isoDay };
