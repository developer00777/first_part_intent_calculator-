// End-to-end: files -> events -> signals (rules + model) -> scores -> narrative -> CSVs + report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTable } from "./parse.js";
import { extractEvents, guessSource, SOURCE_KEYS } from "./extract.js";
import { classifyByRules } from "./signals.js";
import { scoreAll, WINDOW_DAYS } from "./score.js";
import { llmEnabled, calibrate, classify, narrate, MODEL } from "./llm.js";
import { accountsCsv, contactsCsv } from "./csv.js";
import { renderReport } from "./report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_CFG = JSON.parse(fs.readFileSync(path.join(here, "..", "config", "scoring.json"), "utf8"));

const log = (...a) => console.log(new Date().toISOString(), ...a);

export async function runPipeline(meta, uploads) {
  const t0 = Date.now();
  const warnings = [];
  const cfg = structuredClone(BASE_CFG);
  const useLLM = llmEnabled();
  const llmNotes = [];

  // 1. parse + extract
  const events = [];
  const fileReports = [];
  for (const u of uploads) {
    let table;
    try {
      table = parseTable(u.name, u.buffer);
    } catch (e) {
      warnings.push(`${u.name}: could not be read (${e.message}).`);
      continue;
    }
    const declared = (meta.files || []).find((f) => f.name === u.name)?.source;
    const source = SOURCE_KEYS.includes(declared) ? declared : guessSource(u.name, table.headers) || "crm";
    const ex = extractEvents(table, source);
    ex.warnings.forEach((w) => warnings.push(`${u.name}: ${w}`));
    events.push(...ex.events);
    fileReports.push({ name: u.name, source, rows: table.rows.length, used: ex.events.length });
  }
  if (!events.length) {
    const err = new Error("None of the files had rows with a readable date and an email or domain.");
    err.status = 422;
    err.warnings = warnings;
    throw err;
  }

  // 2. distinct activity labels -> signals
  const distinct = new Map();
  for (const e of events) {
    const k = `${e.source}::${e.text}`;
    e.ruleSignal = classifyByRules(e.source, e.text, e.attended);
    // a webinar row with a known attendance flag is decided by the flag, not the title
    if (e.source === "webinar" && e.attended !== null) continue;
    if (!e.text) continue;
    const d = distinct.get(k);
    if (d) d.count++;
    else distinct.set(k, { key: k, source: e.source, text: e.text, count: 1 });
  }
  const items = [...distinct.values()].sort((a, b) => b.count - a.count).map((it, i) => ({ ...it, id: String(i + 1) }));

  let modelLabels = {};
  if (useLLM) {
    const [cal, cls] = await Promise.all([
      calibrate(cfg, meta).catch((e) => ({ error: e.message })),
      items.length ? classify(cfg, items, meta) : Promise.resolve({ labels: {}, errors: [] }),
    ]);
    if (cal.error) llmNotes.push(`Weight calibration skipped: ${cal.error}`);
    else if (cal.multipliers && Object.keys(cal.multipliers).length) {
      for (const [k, m] of Object.entries(cal.multipliers)) cfg.signals[k].points = Math.round(cfg.signals[k].points * m * 10) / 10;
      llmNotes.push(`Weights adjusted for your notes: ${cal.rationale || Object.entries(cal.multipliers).map(([k, m]) => `${k} x${m}`).join(", ")}`);
    }
    cls.errors.forEach((e) => llmNotes.push(`Some activity labels used built-in rules: ${e}`));
    for (const it of items) if (cls.labels[it.id]) modelLabels[it.key] = cls.labels[it.id];
  }
  let byModel = 0;
  for (const e of events) {
    const m = modelLabels[`${e.source}::${e.text}`];
    if (m && !(e.source === "webinar" && e.attended !== null)) { e.signal = m; byModel++; }
    else e.signal = e.ruleSignal;
  }

  // 3. score
  const windowDays = WINDOW_DAYS[meta.window] || 90;
  const result = scoreAll(events, cfg, { windowDays, asOf: meta.asOf === "today" ? "today" : "data" });
  if (result.stats.eventsOutside) warnings.push(`${result.stats.eventsOutside.toLocaleString("en-US")} row(s) fell outside the ${meta.window || "selected"} window and were not scored.`);

  // 4. narrative
  let narrative = null;
  if (useLLM && result.accounts.length) {
    try {
      narrative = await narrate(meta, result, cfg);
      for (const a of result.accounts) {
        const n = narrative.accounts[a.domain];
        if (n?.reason) a.reason = n.reason;
        if (n?.action) a.action = n.action;
      }
    } catch (e) {
      llmNotes.push(`Report narrative used the built-in template: ${e.message}`);
    }
  }
  if (!narrative) narrative = templateNarrative(meta, result);

  // 5. outputs
  const info = {
    company: meta.company, email: meta.email, window: meta.window, asOfMode: meta.asOf, notes: meta.notes,
    files: fileReports, model: useLLM ? MODEL : null, llmNotes, warnings, cfg,
    classifiedByModel: byModel, totalEvents: events.length,
  };
  const report = renderReport(result, narrative, info);
  log(`scored files=${fileReports.length} events=${events.length} accounts=${result.accounts.length} llm=${useLLM} ms=${Date.now() - t0}`);

  return {
    ok: true,
    company: meta.company || "",
    asOf: result.asOf.toISOString().slice(0, 10),
    model: useLLM ? MODEL : null,
    summary: {
      accounts: result.accounts.length,
      contacts: result.contacts.length,
      engagedContacts: result.stats.engagedContacts,
      levels: result.stats.levels,
      events: result.stats.eventsInWindow,
    },
    headline: narrative.headline,
    top: result.accounts.slice(0, 5).map((a) => ({ name: a.name, domain: a.domain, score: a.score, level: a.level })),
    warnings,
    notes: llmNotes,
    files: {
      report: { name: fileName(meta.company, "intent-report", "html"), content: report },
      accounts: { name: fileName(meta.company, "account-scores", "csv"), content: accountsCsv(result.accounts) },
      contacts: { name: fileName(meta.company, "contact-scores", "csv"), content: contactsCsv(result.contacts) },
    },
  };
}

function fileName(company, kind, ext) {
  const slug = String(company || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${slug ? slug + "-" : ""}${kind}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function templateNarrative(meta, result) {
  const { Hot, Warm, Watch } = result.stats.levels;
  const top = result.accounts[0];
  const mix = result.stats.signalMix.slice(0, 3).map((s) => s.label.toLowerCase());
  return {
    headline: Hot ? `${Hot} account${Hot > 1 ? "s are" : " is"} ready for sales outreach this week` : `No Hot accounts yet; ${Warm} worth nurturing`,
    summary:
      `${result.accounts.length} accounts showed activity in the ${(meta.window || "selected window").toLowerCase()}: ${Hot} Hot, ${Warm} Warm and ${Watch} Watch. ` +
      (top ? `${top.name} leads with a score of ${top.score}. ` : "") +
      (mix.length ? `Most activity came from ${mix.join(", ")}.` : ""),
    insights: [],
    accounts: {},
  };
}
