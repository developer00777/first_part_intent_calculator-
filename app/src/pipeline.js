// Runs the first-party-intent-calculator skill end to end for one upload:
//   Step 2 inspect + mapping review -> normalize -> signal review   (runner.py + model)
//   Step 3 config from the person's notes                          (model)
//   Step 4 score_intent.py, sanity check                           (skill script + model)
//   Step 5 build_report.py                                         (skill script)
//   Step 6 summary                                                 (model, added to the report and the page)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { llmEnabled, MODEL, SKILL_DIR, defaultConfig, reviewMapping, reviewSignals, tuneConfig, sanityCheck, usage, clean } from "./llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, "..", "py", "runner.py");
const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const SOURCES = ["web", "email", "form", "webinar", "crm"];
const FIELDS = ["email", "company", "domain", "date", "activity", "detail", "attended"];
const log = (...a) => console.log(new Date().toISOString(), ...a);

function py(cmd, work, req) {
  const reqPath = path.join(work, `${cmd}-req.json`);
  fs.writeFileSync(reqPath, JSON.stringify(req));
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [RUNNER, cmd, work, reqPath], { env: { ...process.env, SKILL_DIR }, maxBuffer: 256 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(stdout); } catch {}
      if (out && !out.error && !err) return resolve(out);
      reject(new Error(out?.error || stderr?.slice(-800) || err?.message || "runner failed"));
    });
  });
}

const step = async (notes, label, fn, fallback) => {
  try { return await fn(); } catch (e) { notes.push(`${label} used the skill's defaults (${String(e.message).slice(0, 160)}).`); return fallback; }
};

export async function runPipeline(meta, uploads) {
  const t0 = Date.now();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "intent-"));
  const useLLM = llmEnabled();
  const warnings = [], notes = [];
  const u0 = { ...usage };
  try {
    // ---- save uploads (names are never used as paths) ----
    const files = uploads.map((u, i) => {
      const ext = path.extname(u.name).toLowerCase().replace(/[^.a-z]/g, "") || ".csv";
      const p = `upload_${i}${ext}`;
      fs.writeFileSync(path.join(work, p), u.buffer);
      const declared = (meta.files || []).find((f) => f.name === u.name)?.source;
      return { name: u.name, path: p, source: SOURCES.includes(declared) ? declared : undefined };
    });

    // ---- Step 2: inspect, review mapping ----
    const ins = await py("inspect", work, { files });
    const readable = [];
    for (const f of ins.files) {
      if (f.error) warnings.push(`${f.name} could not be read, so it was not included. Saving it again as CSV usually helps.`);
      else readable.push(f);
    }
    if (useLLM && readable.length) {
      const fixes = await step(notes, "Column review", () => reviewMapping(readable), {});
      for (const f of readable) {
        const fx = fixes[f.name];
        if (!fx) continue;
        if (SOURCES.includes(fx.source) && fx.source !== f.source) { notes.push(`${f.name}: treated as ${fx.source} data.`); f.source = fx.source; }
        for (const [k, v] of Object.entries(fx.mapping || {})) {
          if (!FIELDS.includes(k)) continue;
          if (v === null || f.columns.includes(v)) {
            if (f.mapping[k] !== v) notes.push(`${f.name}: ${k} read from ${v ? `"${v}"` : "no column"}${f.mapping[k] ? ` instead of "${f.mapping[k]}"` : ""}.`);
            f.mapping[k] = v;
          }
        }
      }
    }
    for (const f of readable) {
      if (!f.mapping.date) warnings.push(`${f.name}: no date column was found, so its rows could not be scored.`);
      if (!f.mapping.email && !f.mapping.domain) warnings.push(`${f.name}: no email or company domain column was found, so its rows could not be scored.`);
    }

    // ---- normalize ----
    const norm = await py("normalize", work, { files: readable.map((f) => ({ name: f.name, path: f.path, source: f.source, mapping: f.mapping, dayfirst: f.dayfirst })) });
    for (const r of norm.files) {
      if (r.dayfirst) notes.push(`${r.name}: dates read as day/month/year.`);
      if (r.dropped) warnings.push(`${r.name}: ${r.dropped.toLocaleString("en-US")} of ${r.rows.toLocaleString("en-US")} rows were set aside because they had no readable date or no email or domain.`);
    }
    if (!norm.events) {
      const e = new Error("None of the files had rows with a readable date and an email or company domain.");
      e.status = 422; e.warnings = warnings; throw e;
    }

    // ---- Step 2 signal review + Step 3 config (in parallel) ----
    let cfg = defaultConfig();
    const acts = norm.activities.map((a) => ({ ...a, key: `${a.source}\x1f${a._a}\x1f${a._d}` }));
    const ordered = [...acts.filter((a) => !a.rule), ...acts.filter((a) => a.rule)];
    let labels = {};
    if (useLLM) {
      const [lab, tuned] = await Promise.all([
        step(notes, "Activity review", () => reviewSignals(ordered, cfg), {}),
        step(notes, "Settings review", () => tuneConfig(cfg, meta), null),
      ]);
      labels = lab;
      const changed = acts.filter((a) => labels[a.key]);
      if (changed.length) {
        const sig = cfg.signals;
        const desc = changed.slice(0, 8).map((a) => {
          const what = [a.activity, a.detail].filter(Boolean).join(" / ").slice(0, 60) || "(blank)";
          const to = labels[a.key] === "skip" ? "set aside" : sig[labels[a.key]].label;
          return `${a.source} "${what}" (${a.count} row${a.count === 1 ? "" : "s"}): ${to}`;
        });
        notes.push(`Reviewed ${changed.length} activity type${changed.length === 1 ? "" : "s"} the built-in rules could not place: ${desc.join("; ")}${changed.length > 8 ? "; and more" : ""}.`);
      }
      if (tuned) { cfg = tuned.config; notes.push(`Settings adjusted for your notes: ${tuned.changes.join("; ")}.${tuned.explanation ? " " + tuned.explanation : ""}`); }
    }

    // ---- Step 4 + 5: score and build report (skill scripts) ----
    const scoreReq = { labels, config: cfg, as_of: meta.asOf === "today" ? "today" : "", client: meta.company, top: 25 };
    let scored = await py("score", work, scoreReq);
    let summaryText = null;
    if (useLLM && scored.summary.accounts_scored) {
      summaryText = await step(notes, "Summary", () => sanityCheck(scored.summary, meta, true), null);
      if (summaryText?.saturation) {
        cfg = { ...cfg, saturation_points: summaryText.saturation };
        notes.push(`Saturation points set to ${summaryText.saturation} after the level check${summaryText.adjustReason ? `: ${summaryText.adjustReason}` : "."}`);
        scored = await py("score", work, { ...scoreReq, config: cfg });
        summaryText = await step(notes, "Summary", () => sanityCheck(scored.summary, meta, false), summaryText);
      }
    }
    if (!summaryText) summaryText = templateSummary(scored.summary);
    if (scored.set_aside_by_review) notes.push(`${scored.set_aside_by_review} rows were set aside because they show your team's own activity or list hygiene rather than buyer interest.`);

    // ---- outputs ----
    const out = path.join(work, "out");
    const S = scored.summary;
    let report = fs.readFileSync(path.join(out, "intent_report.html"), "utf8");
    report = injectSummary(report, summaryText, notes);
    const dt = S.as_of;
    const slug = String(meta.company || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const fname = (b, ext) => `${slug ? slug + "_" : ""}${b}_${dt}.${ext}`;
    const spent = { calls: usage.calls - u0.calls, prompt: usage.prompt - u0.prompt, completion: usage.completion - u0.completion, cost: +(usage.cost - u0.cost).toFixed(5) };
    log(`scored files=${readable.length} events=${norm.events} accounts=${S.accounts_scored} llm=${useLLM} calls=${spent.calls} cost=$${spent.cost} ms=${Date.now() - t0}`);

    return {
      ok: true,
      company: meta.company || "",
      asOf: S.as_of,
      model: useLLM ? MODEL : null,
      usage: useLLM ? spent : null,
      summary: {
        accounts: S.accounts_scored, contacts: S.contacts_scored, levels: S.level_counts,
        events: S.events_used, unclassified: S.events_unclassified, personal: S.personal_email_contacts,
      },
      headline: summaryText.headline,
      summaryText: summaryText.summary,
      topHot: summaryText.topHot,
      nextStep: summaryText.nextStep,
      top: S.accounts.slice(0, 5).map((a) => ({ name: a["Account Name"], domain: a["Domain"], score: a["Intent Score"], level: a["Intent Level"] })),
      warnings,
      notes: [...notes, ...summaryText.dataNotes],
      files: {
        report: { name: fname("intent_report", "html"), content: report },
        accounts: { name: fname("intent_scores_accounts", "csv"), content: "﻿" + fs.readFileSync(path.join(out, "intent_scores_accounts.csv"), "utf8") },
        contacts: { name: fname("intent_scores_contacts", "csv"), content: "﻿" + fs.readFileSync(path.join(out, "intent_scores_contacts.csv"), "utf8") },
      },
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function templateSummary(S) {
  const lc = S.level_counts || {};
  const hot = S.accounts.filter((a) => a["Intent Level"] === "Hot").slice(0, 3);
  if (!S.accounts_scored) {
    return {
      headline: "No company accounts could be scored yet",
      summary: "The rows in these files could not be linked to a company, for example because they use personal email addresses or the activity is older than 90 days.",
      topHot: [], dataNotes: [],
      nextStep: "Add an export that includes work email addresses or company domains, ideally covering the last 90 days.",
    };
  }
  return {
    headline: hot.length ? `${lc.Hot} account${lc.Hot === 1 ? " is" : "s are"} ready for sales outreach this week` : "Your accounts are on the Warm and Watch lists for now",
    summary: `${S.accounts_scored} accounts were scored: ${lc.Hot || 0} Hot, ${lc.Warm || 0} Warm and ${lc.Watch || 0} Watch.`,
    topHot: hot.map((a) => ({ name: a["Account Name"], reason: a["Top Signals"] ? `Top signals: ${a["Top Signals"]}.` : "" })),
    dataNotes: [],
    nextStep: "Import the account CSV into your CRM matching on Domain, then build a view filtered to Intent Level = Hot for the sales team.",
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Adds the Step 6 summary to the skill's report as one card, using the report's own classes (all text 19px+).
function injectSummary(html, t, notes) {
  const items = [...notes, ...t.dataNotes].map((n) => `<li>${esc(clean(n, 400))}</li>`).join("");
  const hot = t.topHot.length ? `<ul class="notes">${t.topHot.map((h) => `<li><b>${esc(h.name)}</b>: ${esc(h.reason)}</li>`).join("")}</ul>` : "";
  const card = `<section class="card"><h2>${esc(t.headline || "Summary")}</h2><p>${esc(t.summary)}</p>${hot}` +
    (t.nextStep ? `<p><b>Next step:</b> ${esc(t.nextStep)}</p>` : "") +
    (items ? `<p class="sub" style="margin-top:18px">About this run</p><ul class="notes">${items}</ul>` : "") + `</section>\n\n`;
  const at = html.indexOf('<section class="grid2">');
  return at > -1 ? html.slice(0, at) + card + html.slice(at) : html;
}
