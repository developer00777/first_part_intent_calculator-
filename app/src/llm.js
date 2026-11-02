// OpenRouter client + the three model tasks: weight calibration, activity classification, report narrative.
// The intent skill (skill/*.md) is the system prompt for every call.
// Privacy: contact emails are never sent. The model sees activity labels (page paths, form names,
// event types), the user's notes, and account-level aggregates keyed by company domain.
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
export const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-5.5";
const TIMEOUT = +(process.env.LLM_TIMEOUT_MS || 60000);
const CLASSIFY_LIMIT = +(process.env.LLM_CLASSIFY_LIMIT || 400);
const BATCH = 200;

export const llmEnabled = () => Boolean(process.env.OPENROUTER_API_KEY) && process.env.LLM_DISABLED !== "1";

// ---------- skill ----------
let skillCache = null;
export function loadSkill() {
  if (skillCache !== null) return skillCache;
  const dir = process.env.SKILL_DIR || path.resolve(process.cwd(), "skill");
  const files = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(md|txt|json)$/i.test(f.name)) files.push(p);
    }
  };
  walk(dir);
  files.sort((a, b) => (/SKILL\.md$/i.test(b) ? 1 : 0) - (/SKILL\.md$/i.test(a) ? 1 : 0) || a.localeCompare(b));
  let text = files.map((p) => `<file path="${path.relative(dir, p).replace(/\\/g, "/")}">\n${fs.readFileSync(p, "utf8")}\n</file>`).join("\n\n");
  if (text.length > 120000) text = text.slice(0, 120000) + "\n[skill truncated]";
  skillCache = text;
  return text;
}

function systemPrompt() {
  const skill = loadSkill();
  return [
    "You are the scoring analyst behind the First-Party Intent Calculator (by LakeB2B).",
    "It turns a company's own engagement exports (website, email, forms, webinars, CRM) into account-level intent scores from 0 to 100: Hot 70-100, Warm 40-69, Watch 0-39.",
    "A deterministic engine does the arithmetic. Your job is judgement: classify activity, calibrate emphasis, and explain results, always following the methodology in the skill below.",
    "Reply with a single JSON object only, no prose and no code fences.",
    skill ? `\n<intent_skill>\n${skill}\n</intent_skill>` : "",
  ].join("\n");
}

// ---------- transport ----------
function parseJSON(text) {
  const s = String(text || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a > -1 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("Model reply was not JSON");
}

async function chatJSON(user, maxTokens = 4000) {
  const body = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: systemPrompt() }, { role: "user", content: user }],
    response_format: { type: "json_object" },
  };
  const send = (b) =>
    fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "https://intent-calculator.local",
        "X-Title": "First-Party Intent Calculator",
      },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  let r = await send(body);
  if (r.status === 400) {
    // some models reject response_format; retry once without it
    const { response_format, ...rest } = body;
    r = await send(rest);
  }
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenRouter returned no content${j.error ? ": " + JSON.stringify(j.error).slice(0, 200) : ""}`);
  return parseJSON(content);
}

const signalList = (cfg) =>
  Object.entries(cfg.signals).map(([k, s]) => `- ${k}: ${s.label} (${s.points} pts)`).join("\n");

// ---------- task 1: calibrate weights from the user's notes ----------
export async function calibrate(cfg, meta) {
  if (!meta.notes) return {};
  const out = await chatJSON(
    `The customer described their sales process:\n"""${meta.notes.slice(0, 2000)}"""\n\n` +
      `Signals and default points:\n${signalList(cfg)}\n\n` +
      `If the notes (read with the skill's methodology) justify emphasising or de-emphasising signals, return multipliers between 0.5 and 2.0. ` +
      `Only include signals that should change. Return {"multipliers": {"signal_key": number}, "rationale": "one sentence"}.`,
    800
  );
  const m = {};
  for (const [k, v] of Object.entries(out.multipliers || {})) {
    if (cfg.signals[k] && Number.isFinite(+v)) m[k] = Math.min(2, Math.max(0.5, +v));
  }
  return { multipliers: m, rationale: String(out.rationale || "").slice(0, 300) };
}

// ---------- task 2: classify distinct activity labels ----------
export async function classify(cfg, items, meta) {
  const keys = new Set(Object.keys(cfg.signals));
  const list = items.slice(0, CLASSIFY_LIMIT);
  const batches = [];
  for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
  const results = await Promise.all(
    batches.map((b) =>
      chatJSON(
        `Classify each activity into exactly one signal key.\n\nSignals:\n${signalList(cfg)}\n\n` +
          `Source meanings: web = page visit (text is the URL path or page title), email = email event, form = form submission (text is the form name), webinar = webinar registration/attendance, crm = sales activity logged in the CRM.\n` +
          (meta.notes ? `Customer notes: "${meta.notes.slice(0, 500)}"\n` : "") +
          `\nActivities (id, source, text, row count):\n` +
          b.map((it) => `${it.id}\t${it.source}\t${it.text}\t${it.count}`).join("\n") +
          `\n\nReturn {"labels": {"<id>": "<signal_key>"}} covering every id.`,
        Math.min(8000, 40 * b.length + 500)
      ).catch((e) => ({ error: e.message }))
    )
  );
  const labels = {};
  const errors = [];
  for (const r of results) {
    if (r.error) { errors.push(r.error); continue; }
    for (const [id, k] of Object.entries(r.labels || {})) if (keys.has(k)) labels[id] = k;
  }
  return { labels, errors };
}

// ---------- task 3: narrative for the report ----------
export async function narrate(meta, result, cfg, n = 20) {
  const top = result.accounts.slice(0, n).map((a) => ({
    domain: a.domain, name: a.name, score: a.score, level: a.level, engaged_contacts: a.engaged,
    days_since_last_activity: a.daysSince, sources: a.sources, signals: a.signalCounts,
  }));
  const out = await chatJSON(
    `Write the narrative for ${meta.company || "the customer"}'s first-party intent report.\n` +
      `Export window: ${meta.window}. Scores as of ${result.asOf.toISOString().slice(0, 10)}.\n` +
      (meta.notes ? `Customer notes: "${meta.notes.slice(0, 500)}"\n` : "") +
      `Accounts scored: ${result.accounts.length}. Levels: ${JSON.stringify(result.stats.levels)}. Engaged contacts: ${result.stats.engagedContacts}.\n` +
      `Signal mix (events): ${JSON.stringify(result.stats.signalMix.map((s) => [s.label, s.count]))}\n` +
      `Signal points: ${JSON.stringify(Object.fromEntries(Object.entries(cfg.signals).map(([k, s]) => [k, s.points])))}\n` +
      `Top accounts: ${JSON.stringify(top)}\n\n` +
      `Plain business English for marketing and sales leaders, no jargon, no hype, do not invent facts beyond these numbers.\n` +
      `Return {"headline": "<= 14 words", "summary": "2-3 sentences", "insights": ["3 to 5 short, specific observations"], ` +
      `"accounts": {"<domain>": {"reason": "one sentence explaining the score from its signals", "action": "one concrete next step for sales or marketing"}}} with an entry for every top account.`,
    6000
  );
  const accounts = {};
  for (const [d, v] of Object.entries(out.accounts || {})) {
    if (v && typeof v === "object") accounts[d.toLowerCase()] = { reason: String(v.reason || "").slice(0, 400), action: String(v.action || "").slice(0, 200) };
  }
  return {
    headline: String(out.headline || "").slice(0, 160),
    summary: String(out.summary || "").slice(0, 900),
    insights: (Array.isArray(out.insights) ? out.insights : []).slice(0, 6).map((s) => String(s).slice(0, 300)),
    accounts,
  };
}
