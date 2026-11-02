#!/usr/bin/env python3
"""
Build the visual HTML intent report from intent_summary.json.

Usage:
  python build_report.py OUT/intent_summary.json --out OUT/intent_report.html [--client "Acme Corp"] [--top 25]

The page is a single self-contained file: inline CSS, inline SVG charts,
no external images or scripts. Minimum font size is 19px throughout.
Charts work offline and inside a published Claude artifact.
"""
import argparse, html, json, math

LEVEL_COLORS = {"Hot": "#F0453A", "Warm": "#F5A524", "Watch": "#2E8BEA"}
SOURCE_COLORS = {"web": "#7C5CFC", "email": "#14B8A6", "form": "#F0453A", "webinar": "#F5A524", "crm": "#2E8BEA"}
SOURCE_LABELS = {"web": "Website", "email": "Email", "form": "Forms", "webinar": "Webinars", "crm": "CRM"}
SIGNAL_PALETTE = ["#7C5CFC", "#F0453A", "#F5A524", "#14B8A6", "#2E8BEA", "#EC4899", "#22C55E", "#F97316", "#6366F1", "#0EA5E9", "#A855F7", "#84CC16", "#64748B"]

e = lambda s: html.escape(str(s))


def ago(d):
    d = int(d)
    return "Today" if d == 0 else ("Yesterday" if d == 1 else f"{d} days ago")


def level_range(levels, lv):
    higher = sorted([l["min_score"] for l in levels if l["min_score"] > lv["min_score"]])
    return f'Score {lv["min_score"]} to {higher[0]-1}' if higher else f'Score {lv["min_score"]} to 100'


def donut(counts, levels):
    total = sum(counts.values()) or 1
    r, cx, cy, sw = 110, 150, 150, 46
    circ = 2 * math.pi * r
    off, segs = 0.0, []
    for lv in levels:
        n = counts.get(lv["name"], 0)
        if not n:
            continue
        frac = n / total
        segs.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{LEVEL_COLORS.get(lv["name"], "#888")}" '
                    f'stroke-width="{sw}" stroke-dasharray="{frac*circ:.2f} {circ:.2f}" stroke-dashoffset="{-off*circ:.2f}" '
                    f'transform="rotate(-90 {cx} {cy})"><title>{e(lv["name"])}: {n}</title></circle>')
        off += frac
    svg = (f'<svg viewBox="0 0 300 300" class="donut" role="img" aria-label="Accounts by intent level">'
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="var(--track)" stroke-width="{sw}"/>{"".join(segs)}'
            f'</svg>')
    return (f'<div class="donut-box">{svg}<div class="donut-center"><div class="donut-num">{sum(counts.values())}</div>'
            f'<div class="donut-lbl">accounts</div></div></div>')


def hbars(items, max_val=None, unit=""):
    """items: list of (label, value, color, sublabel)"""
    if not items:
        return '<p class="muted">No data yet.</p>'
    mv = max_val or max(v for _, v, _, _ in items) or 1
    rows = []
    for label, v, color, sub in items:
        pct = max(2, v / mv * 100)
        rows.append(f'<div class="hbar"><div class="hbar-label">{e(label)}{f"<span>{e(sub)}</span>" if sub else ""}</div>'
                    f'<div class="hbar-track"><div class="hbar-fill" style="width:{pct:.1f}%;background:{color}"></div></div>'
                    f'<div class="hbar-val">{v:g}{unit}</div></div>')
    return "".join(rows)


def stacked_weeks(weeks, sources):
    """HTML/CSS stacked columns so every label stays at real 19px+ on any screen."""
    if not weeks:
        return '<p class="muted">No recent activity.</p>'
    mx = max(sum(w[s] for s in sources) for w in weeks) or 1
    cols = []
    for i, w in enumerate(weeks):
        tot = sum(w[s] for s in sources)
        segs = "".join(f'<i style="height:{w[s]/mx*100:.1f}%;background:{SOURCE_COLORS[s]}" title="{SOURCE_LABELS[s]}: {w[s]}"></i>'
                       for s in reversed(sources) if w[s])
        lbl = e(w["label"]) if i % 3 == 2 or i == len(weeks) - 1 else "&nbsp;"
        cols.append(f'<div class="wcol"><div class="wtot">{tot if tot else ""}</div><div class="wbar">{segs}</div><div class="wlbl">{lbl}</div></div>')
    legend = "".join(f'<span class="leg"><i style="background:{SOURCE_COLORS[s]}"></i>{SOURCE_LABELS[s]}</span>' for s in sources)
    return f'<div class="weeks">{"".join(cols)}</div><div class="legend">{legend}</div>'


CSS = """
:root{--bg:#F6F5FB;--card:#FFFFFF;--ink:#1B1A2E;--muted:#5D5B75;--line:#E6E3F2;--track:#EEECF6;
--hot:#F0453A;--warm:#F5A524;--watch:#2E8BEA;--accent:#7C5CFC;--accent2:#14B8A6;}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121120;--card:#1C1B2E;--ink:#F2F1FA;--muted:#B4B1CC;--line:#2E2C47;--track:#2A2840;}}
:root[data-theme="dark"]{--bg:#121120;--card:#1C1B2E;--ink:#F2F1FA;--muted:#B4B1CC;--line:#2E2C47;--track:#2A2840;}
:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
*{box-sizing:inherit}
html{font-size:19px}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Inter","Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:19px;line-height:1.55}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px 48px}
.hero{background:linear-gradient(120deg,#7C5CFC 0%,#C04BD8 45%,#F0453A 80%,#F5A524 100%);color:#fff;padding:56px 24px 96px}
.hero .wrap{padding-bottom:0}
.eyebrow{font-size:19px;letter-spacing:.12em;text-transform:uppercase;opacity:.9;font-weight:700}
h1{font-size:46px;line-height:1.15;margin:10px 0 12px;font-weight:800}
.hero p{font-size:22px;margin:0;opacity:.95;max-width:820px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px;margin-top:-64px}
.kpi{background:var(--card);border-radius:20px;padding:22px 24px;box-shadow:0 10px 30px rgba(40,20,90,.10);border-top:6px solid var(--accent)}
.kpi .n{font-size:44px;font-weight:800;line-height:1.1}
.kpi .l{font-size:19px;color:var(--muted);font-weight:600}
.kpi.hot{border-color:var(--hot)}.kpi.hot .n{color:var(--hot)}
.kpi.warm{border-color:var(--warm)}.kpi.warm .n{color:var(--warm)}
.kpi.watch{border-color:var(--watch)}.kpi.watch .n{color:var(--watch)}
section{margin-top:36px}
h2{font-size:30px;margin:0 0 6px;font-weight:800}
.sub{color:var(--muted);margin:0 0 20px;font-size:19px}
.card{background:var(--card);border-radius:20px;padding:28px;box-shadow:0 6px 22px rgba(40,20,90,.07)}
.grid2{display:grid;grid-template-columns:1fr 1.4fr;gap:24px}
@media(max-width:860px){.grid2{grid-template-columns:1fr}h1{font-size:36px}}
.donut{width:100%;max-width:300px;display:block;margin:0 auto}
.donut-box{position:relative;max-width:300px;margin:0 auto}
.donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.donut-num{font-size:52px;font-weight:800;line-height:1}
.donut-lbl{font-size:20px;color:var(--muted)}
.weeks{display:flex;gap:6px;align-items:flex-end;height:320px}
.wcol{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;min-width:0}
.wtot{font-size:19px;font-weight:700;color:var(--muted);height:30px}
.wbar{flex:1;width:72%;display:flex;flex-direction:column;justify-content:flex-end;gap:2px}
.wbar i{display:block;border-radius:4px;min-height:3px}
.wlbl{font-size:19px;color:var(--muted);white-space:nowrap;height:32px;padding-top:6px}
.lvl-list{display:flex;flex-direction:column;gap:14px;margin-top:18px}
.lvl{display:flex;gap:14px;align-items:center;padding:14px 16px;border-radius:14px;background:var(--track)}
.lvl b{font-size:22px}.lvl .dot{width:18px;height:18px;border-radius:50%;flex:none}
.lvl .cnt{margin-left:auto;font-weight:800;font-size:24px}
.hbar{display:grid;grid-template-columns:minmax(160px,34%) 1fr 64px;gap:14px;align-items:center;margin:12px 0}
.hbar-label{font-weight:600;font-size:19px;overflow:hidden;text-overflow:ellipsis}
.hbar-label span{display:block;font-weight:400;color:var(--muted);font-size:19px}
.hbar-track{background:var(--track);border-radius:999px;height:22px;overflow:hidden}
.hbar-fill{height:100%;border-radius:999px}
.hbar-val{font-weight:800;text-align:right;font-size:19px}
.chart{width:100%;height:auto;display:block}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .axis{font-size:19px;fill:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:18px;margin-top:12px}
.leg{display:inline-flex;align-items:center;gap:8px;font-size:19px;color:var(--muted)}
.leg i{width:16px;height:16px;border-radius:4px;display:inline-block}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:19px;min-width:900px}
th{text-align:left;font-size:19px;color:var(--muted);font-weight:700;padding:12px 14px;border-bottom:2px solid var(--line)}
td{padding:14px;border-bottom:1px solid var(--line);vertical-align:top}
.pill{display:inline-block;padding:4px 14px;border-radius:999px;font-weight:700;color:#fff;font-size:19px;white-space:nowrap}
.score{font-weight:800;font-size:24px}
.mini{height:10px;border-radius:999px;background:var(--track);margin-top:6px;overflow:hidden;width:110px}
.mini i{display:block;height:100%}
.acct{font-weight:700}.dom{color:var(--muted);font-size:19px}
.method{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.method h3{font-size:23px;margin:0 0 10px}
.ptable td,.ptable th{padding:9px 12px}
.ptable{min-width:0}
.cta{background:linear-gradient(120deg,#1B1A2E,#3B2A7A);color:#fff;border-radius:24px;padding:36px}
.cta h2{color:#fff}.cta p{font-size:20px;opacity:.95}
.cta .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin-top:18px}
.cta .tile{background:rgba(255,255,255,.10);border-radius:16px;padding:18px}
.cta .tile b{display:block;font-size:21px;margin-bottom:4px}
.notes li{margin:6px 0}
.muted{color:var(--muted)}
footer{margin-top:44px;padding:26px 24px;text-align:center;font-size:19px;color:var(--muted);border-top:1px solid var(--line)}
footer .pb{font-weight:700;background:linear-gradient(90deg,#6D08BE,#E8033A,#FFB703);-webkit-background-clip:text;background-clip:text;color:transparent}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("summary")
    ap.add_argument("--out", default="intent_report.html")
    ap.add_argument("--client", default="")
    ap.add_argument("--top", type=int, default=25)
    a = ap.parse_args()
    S = json.load(open(a.summary))

    levels, lc = S["levels"], S["level_counts"]
    accts = S["accounts"]
    hot = lc.get("Hot", 0); warm = lc.get("Warm", 0); watch = lc.get("Watch", 0)
    title = f"{a.client} First-Party Intent Report" if a.client else "First-Party Intent Report"

    top_hot = [x for x in accts if x["Intent Level"] == "Hot"][:3]
    if top_hot:
        lead = "Contact these accounts first: " + ", ".join(x["Account Name"] for x in top_hot) + "."
    elif accts:
        lead = "No accounts have reached Hot yet. The Warm list below is the best place to focus nurture efforts."
    else:
        lead = "No scored accounts yet. Add more engagement data to build a picture."

    lvl_rows = "".join(
        f'<div class="lvl"><span class="dot" style="background:{LEVEL_COLORS[lv["name"]]}"></span>'
        f'<div><b>{lv["emoji"]} {e(lv["name"])}</b><div class="muted">{level_range(levels, lv)} · {e(lv["action"])}</div></div>'
        f'<span class="cnt">{lc.get(lv["name"],0)}</span></div>' for lv in levels)

    top10 = [(x["Account Name"], x["Intent Score"], LEVEL_COLORS.get(x["Intent Level"], "#888"),
              f'{x["Engaged Contacts"]} contact{"" if x["Engaged Contacts"]==1 else "s"} · {x["Intent Level"]}') for x in accts[:10]]

    mix = S["signal_mix"]
    mix_items = [(m["label"], round(m["points"]), SIGNAL_PALETTE[i % len(SIGNAL_PALETTE)], f'{m["count"]} actions') for i, m in enumerate(mix[:8])]

    srcs = [s for s in ["web", "email", "form", "webinar", "crm"] if any(w[s] for w in S["weekly_activity"])] or ["web"]

    trs = []
    for x in accts[: a.top]:
        c = LEVEL_COLORS.get(x["Intent Level"], "#888")
        trs.append(
            f'<tr><td><div class="acct">{e(x["Account Name"])}</div><div class="dom">{e(x["Domain"])}</div></td>'
            f'<td><div class="score" style="color:{c}">{x["Intent Score"]}</div><div class="mini"><i style="width:{x["Intent Score"]}%;background:{c}"></i></div></td>'
            f'<td><span class="pill" style="background:{c}">{e(x["Intent Level"])}</span></td>'
            f'<td>{x["Engaged Contacts"]}</td><td>{e(x["Top Signals"]).replace("; ", "<br>")}</td>'
            f'<td>{ago(x["Days Since Last Activity"])}</td><td>{e(x["Suggested Action"])}</td></tr>')
    table = ('<div class="tbl-wrap"><table><thead><tr><th>Account</th><th>Score</th><th>Level</th><th>Contacts</th>'
             '<th>Top signals</th><th>Last activity</th><th>Next step</th></tr></thead><tbody>' + "".join(trs) + "</tbody></table></div>")

    pts = "".join(f'<tr><td>{e(r["label"])}</td><td><b>{r["points"]}</b></td></tr>' for r in S["config_signals"])
    rec = "".join(f'<tr><td>Within {r["max_days"]} days</td><td><b>{int(r["multiplier"]*100)}%</b></td></tr>' for r in sorted(S["recency"], key=lambda r: r["max_days"]))
    rec += f'<tr><td>Older than {max(r["max_days"] for r in S["recency"])} days</td><td><b>0%</b></td></tr>'
    bst = "".join(f'<tr><td>{r["min_contacts"]}+ engaged contacts</td><td><b>+{int(round((r["multiplier"]-1)*100))}%</b></td></tr>' for r in sorted(S["buying_group_boost"], key=lambda r: r["min_contacts"]))

    notes = [f'Scores reflect activity up to <b>{e(S["as_of"])}</b>.',
             f'<b>{S["events_used"]}</b> engagement actions were counted from: {", ".join(SOURCE_LABELS.get(s, s) for s in S["sources_present"])}.']
    if S["events_skipped_non_intent"]:
        notes.append(f'{S["events_skipped_non_intent"]} rows were set aside because they show your team\'s activity (such as emails sent or calls logged) rather than buyer interest.')
    if S["events_unclassified"]:
        notes.append(f'{S["events_unclassified"]} rows could not be matched to a signal type and were not scored.')
    if S["personal_email_contacts"]:
        notes.append(f'{S["personal_email_contacts"]} contacts used personal email addresses and could not be linked to a company.')

    page = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(title)}</title><style>{CSS}</style></head><body>
<header class="hero"><div class="wrap">
<div class="eyebrow">First-party intent · as of {e(S["as_of"])}</div>
<h1>{e(title)}</h1>
<p>{e(lead)}</p></div></header>
<main class="wrap">
<div class="kpis">
<div class="kpi"><div class="n">{S["accounts_scored"]}</div><div class="l">Accounts scored</div></div>
<div class="kpi hot"><div class="n">{hot}</div><div class="l">🔥 Hot accounts</div></div>
<div class="kpi warm"><div class="n">{warm}</div><div class="l">🌤️ Warm accounts</div></div>
<div class="kpi watch"><div class="n">{watch}</div><div class="l">👀 Watch accounts</div></div>
<div class="kpi"><div class="n">{S["contacts_scored"]}</div><div class="l">Engaged contacts</div></div>
</div>

<section class="grid2">
<div class="card"><h2>Intent levels</h2><p class="sub">How your accounts are spread today.</p>{donut(lc, levels)}<div class="lvl-list">{lvl_rows}</div></div>
<div class="card"><h2>Top 10 accounts</h2><p class="sub">Highest intent scores, out of 100.</p>{hbars(top10, 100)}</div>
</section>

<section class="card"><h2>Ranked accounts</h2><p class="sub">Your top {min(a.top, len(accts))} accounts with the signals behind each score.</p>{table}</section>

<section class="grid2">
<div class="card"><h2>What's driving intent</h2><p class="sub">Score points contributed by each signal type.</p>{hbars(mix_items)}</div>
<div class="card"><h2>Weekly activity</h2><p class="sub">Engagement actions by source over the last 12 weeks.</p>{stacked_weeks(S["weekly_activity"], srcs)}</div>
</section>

<section class="card"><h2>How scores are calculated</h2><p class="sub">Simple, transparent rules you can adjust to match your sales process.</p>
<div class="method">
<div><h3>1. Signal points</h3><table class="ptable"><tbody>{pts}</tbody></table></div>
<div><h3>2. Recency</h3><p class="muted">Recent actions count more.</p><table class="ptable"><tbody>{rec}</tbody></table>
<h3 style="margin-top:22px">3. Buying group boost</h3><p class="muted">More people engaging means stronger intent.</p><table class="ptable"><tbody>{bst}</tbody></table></div>
<div><h3>4. Final score</h3><p>Points from every contact at an account are added up, adjusted for recency, and boosted for buying group size. The total is then scaled to a 0 to 100 score that rises quickly at first and levels off near the top, so a handful of strong actions reaches Hot while a long tail of light activity stays lower.</p>
<table class="ptable"><tbody><tr><td>{round(S["saturation_points"]*0.5)} weighted points</td><td><b>~40 · Warm</b></td></tr><tr><td>{round(S["saturation_points"]*1.2)} weighted points</td><td><b>~70 · Hot</b></td></tr><tr><td>{round(S["saturation_points"]*2.3)} weighted points</td><td><b>~90</b></td></tr></tbody></table>
<p class="muted">Repeat actions count up to five times per person, so one very active visitor can't fill the score alone.</p></div>
</div></section>

<section class="cta"><h2>See the full picture with third-party intent</h2>
<p>This report shows interest on <b>your</b> channels. Your {hot + warm} Hot and Warm accounts are likely researching across the wider web too. LakeB2B intent data adds that layer.</p>
<div class="tiles">
<div class="tile"><b>Off-site research topics</b>What these accounts are reading about beyond your website.</div>
<div class="tile"><b>Accounts not yet on your radar</b>Companies showing interest that haven't visited you yet.</div>
<div class="tile"><b>The full buying group</b>Verified contacts for decision makers you haven't reached.</div>
</div></section>

<section class="card"><h2>Data notes</h2><ul class="notes">{"".join(f"<li>{n}</li>" for n in notes)}</ul></section>
</main>
<footer>Powered by <span class="pb">LakeB2B</span> · Enabling Growth</footer>
</body></html>"""
    open(a.out, "w", encoding="utf-8").write(page)
    print(f"Wrote {a.out}")


if __name__ == "__main__":
    main()
