// OpenRouter client + the judgement steps the skill's SKILL.md assigns to the operator.
// The skill (SKILL.md, references/*.md, assets/default_config.json) is the system prompt for every call.
// Every call uses a strict JSON schema (structured outputs), so replies are always well-formed and
// signal keys can only be ones the skill's config defines.
// Privacy: contact emails are never sent (sample rows are masked to ***@domain). The model sees column
// names, activity labels (event types, page paths, form names), the user's notes, and account-level results.
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
export const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-5.5";
const TIMEOUT = +(process.env.LLM_TIMEOUT_MS || 60000);
const CLASSIFY_LIMIT = +(process.env.LLM_CLASSIFY_LIMIT || 300);

export const SKILL_DIR = process.env.SKILL_DIR || path.resolve(process.cwd(), "..", "skills", "first-party-intent-calculator");
const apiKey = () => String(process.env.OPENROUTER_API_KEY || "").trim().replace(/^["']|["']$/g, "");
export const llmEnabled = () => Boolean(apiKey()) && process.env.LLM_DISABLED !== "1";

// ---------- skill ----------
let skillCache = null;
export function loadSkill() {
  if (skillCache !== null) return skillCache;
  const parts = [];
  const add = (rel) => {
    const p = path.join(SKILL_DIR, rel);
    if (fs.existsSync(p)) parts.push(`<file path="${rel}">\n${fs.readFileSync(p, "utf8")}\n</file>`);
  };
  add("SKILL.md");
  const refs = path.join(SKILL_DIR, "references");
  if (fs.existsSync(refs)) for (const f of fs.readdirSync(refs).sort()) if (f.endsWith(".md")) add(`references/${f}`);
  add("assets/default_config.json");
  skillCache = parts.join("\n\n");
  return skillCache;
}

export function defaultConfig() {
  return JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "assets", "default_config.json"), "utf8"));
}

function systemPrompt() {
  return [
    "You are operating the first-party-intent-calculator skill inside a web app.",
    "The app runs the skill's scripts (normalize_inputs.py, score_intent.py, build_report.py) for you, exactly as written.",
    "You are asked for one workflow step at a time and must follow the skill's instructions and writing style below for that step.",
    "Reply only with JSON matching the requested schema.",
    `\n<skill>\n${loadSkill()}\n</skill>`,
  ].join("\n");
}

// ---------- transport ----------
function parseJSON(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a > -1 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error("model reply was not JSON");
}

export const usage = { calls: 0, prompt: 0, completion: 0, cost: 0 };

async function post(body) {
  return fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "https://intent-calculator.local",
      "X-Title": "First-Party Intent Calculator",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/** Strict-schema call; falls back to json_object, then plain, for models without structured outputs. */
async function chatJSON(user, maxTokens, name, schema) {
  const base = {
    model: MODEL,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: systemPrompt() }, { role: "user", content: user }],
    usage: { include: true },
  };
  const formats = [
    { type: "json_schema", json_schema: { name, strict: true, schema } },
    { type: "json_object" },
    null,
  ];
  let lastErr;
  for (const rf of formats) {
    const r = await post(rf ? { ...base, response_format: rf } : base);
    if (r.status === 400) { lastErr = new Error(`OpenRouter 400: ${(await r.text()).slice(0, 200)}`); continue; }
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    usage.calls++;
    usage.prompt += j.usage?.prompt_tokens || 0;
    usage.completion += j.usage?.completion_tokens || 0;
    usage.cost += j.usage?.cost || 0;
    const content = j.choices?.[0]?.message?.content;
    if (!content) { lastErr = new Error(`OpenRouter returned no content${j.error ? ": " + JSON.stringify(j.error).slice(0, 200) : ""}`); continue; }
    try {
      return parseJSON(content);
    } catch (e) {
      if (process.env.LLM_DEBUG === "1") console.error(`LLM unparseable reply: finish=${j.choices?.[0]?.finish_reason} len=${content.length} usage=${JSON.stringify(j.usage)} tail=${JSON.stringify(content.slice(-300))}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error("no usable reply");
}

// Schema helpers (strict mode: every property required, no extras)
const obj = (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const str = { type: "string" };
const arr = (items) => ({ type: "array", items });
const nullable = (s) => ({ anyOf: [s, { type: "null" }] });

// Skill writing style: never use em dashes.
export const clean = (s, n = 600) => String(s ?? "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+,/g, ",").trim().slice(0, n);

// ---------- Step 2a: review the column mapping ----------
const FIELDS = ["email", "company", "domain", "date", "activity", "detail", "attended"];
export async function reviewMapping(files) {
  const view = files.map((f) => ({ file: f.name, source: f.source, rows: f.rows, columns: f.columns, mapping: f.mapping, sample: f.sample }));
  const out = await chatJSON(
    `Workflow Step 2: review the column mapping normalize_inputs.py chose for each file (sample emails are masked).\n` +
      `Fields: email, company, domain, date, activity, detail, attended (webinar yes/no column).\n` +
      `Report a fix only when a field is null but a column clearly holds it, or the wrong column was picked ` +
      `(for example a "Company Domain" column chosen as company name). Report a source fix only if the file's source type is clearly wrong.\n\n` +
      `${JSON.stringify(view)}\n\nReturn an empty "fixes" list when everything is right.`,
    2000,
    "mapping_review",
    obj({
      fixes: arr(obj({
        file: str,
        field: { type: "string", enum: [...FIELDS, "source"] },
        value: nullable(str),
      })),
    })
  );
  const res = {};
  for (const f of out.fixes || []) {
    res[f.file] ||= { mapping: {} };
    if (f.field === "source") res[f.file].source = f.value;
    else res[f.file].mapping[f.field] = f.value;
  }
  return res;
}

// ---------- Step 2/4: signal column for activities the skill's rules leave unclassified ----------
export async function reviewSignals(acts, cfg) {
  const list = acts.filter((a) => !a.rule).slice(0, CLASSIFY_LIMIT);
  if (!list.length) return {};
  const keys = Object.keys(cfg.signals);
  const lines = list.map((a, i) => `${i + 1}\t${a.source}\t${a.activity}\t${a.detail}\t${a.count}`);
  const out = await chatJSON(
    `Workflow Step 4: these distinct activities are in unclassified_activities.csv because score_intent.py's rules could not place them.\n` +
      `Choose a signal for each. Use "skip" for rows that show the seller's own activity (emails sent, outbound or logged calls, notes, tasks, ` +
      `rep-created records) or list hygiene (bounces, unsubscribes), as references/scoring-model.md says.\n\n` +
      `id\tsource\tactivity\tdetail\trows\n${lines.join("\n")}`,
    Math.min(8000, 40 * list.length + 600),
    "signal_review",
    obj({ signals: arr(obj({ id: { type: "integer" }, signal: { type: "string", enum: [...keys, "skip"] } })) })
  );
  const res = {};
  for (const { id, signal } of out.signals || []) {
    const a = list[id - 1];
    if (a && (signal === "skip" || keys.includes(signal))) res[a.key] = signal;
  }
  return res;
}

// ---------- Step 3: scoring settings from the person's notes ----------
export async function tuneConfig(cfg, meta) {
  if (!meta.notes) return null;
  const keys = Object.keys(cfg.signals);
  const out = await chatJSON(
    `Workflow Step 3: the person described their sales process: """${meta.notes.slice(0, 1500)}"""\n` +
      `Their export window: ${meta.window}.\n` +
      `Using the tuning guide in references/scoring-model.md, decide whether default_config.json needs changes. Change only what the notes clearly call for. ` +
      `Leave a list empty or a value null for "no change". "explanation" is one plain sentence for the person.`,
    1500,
    "config_tuning",
    obj({
      signal_points: arr(obj({ signal: { type: "string", enum: keys }, points: { type: "number" } })),
      recency: arr(obj({ max_days: { type: "integer" }, multiplier: { type: "number" } })),
      saturation_points: nullable({ type: "number" }),
      buying_group_boost: nullable(arr(obj({ min_contacts: { type: "integer" }, multiplier: { type: "number" } }))),
      explanation: str,
    })
  );
  return applyConfigChanges(cfg, out, clean(out.explanation, 300));
}

function applyConfigChanges(cfg, ch, explanation) {
  const c = structuredClone(cfg);
  const done = [];
  for (const { signal: k, points: v } of ch.signal_points || []) {
    if (c.signals[k] && Number.isFinite(v) && v >= 0 && v <= 60 && v !== c.signals[k].points) {
      done.push(`${c.signals[k].label} ${c.signals[k].points} to ${v} points`);
      c.signals[k].points = v;
    }
  }
  const rec = ch.recency || [];
  if (rec.length && rec.every((r) => r.max_days > 0 && r.max_days <= 730 && r.multiplier >= 0 && r.multiplier <= 1)) {
    c.recency = rec.map((r) => ({ max_days: r.max_days, multiplier: r.multiplier }));
    done.push(`recency windows ${c.recency.map((r) => r.max_days).join(" / ")} days`);
  }
  const sat = ch.saturation_points;
  if (Number.isFinite(sat) && sat >= 20 && sat <= 150 && sat !== c.saturation_points) {
    c.saturation_points = sat;
    done.push(`saturation points ${sat}`);
  }
  const bg = ch.buying_group_boost;
  if (Array.isArray(bg) && bg.every((r) => r.min_contacts >= 2 && r.multiplier >= 1 && r.multiplier <= 1.6)) {
    c.buying_group_boost = bg;
    done.push(bg.length ? "buying group boost adjusted" : "buying group boost removed");
  }
  return done.length ? { config: c, changes: done, explanation } : null;
}

// ---------- Step 4 sanity check + Step 6 summary ----------
function digest(summary) {
  return {
    as_of: summary.as_of, accounts_scored: summary.accounts_scored, contacts_scored: summary.contacts_scored,
    level_counts: summary.level_counts, events_used: summary.events_used, events_skipped_non_intent: summary.events_skipped_non_intent,
    events_unclassified: summary.events_unclassified, personal_email_contacts: summary.personal_email_contacts,
    sources_present: summary.sources_present, saturation_points: summary.saturation_points,
    signal_mix: summary.signal_mix.slice(0, 8).map((s) => [s.label, s.count, s.points]),
    top_accounts: summary.accounts.slice(0, 10).map((a) => ({
      name: a["Account Name"], domain: a["Domain"], score: a["Intent Score"], level: a["Intent Level"], contacts: a["Engaged Contacts"],
      top_signals: a["Top Signals"], days_since: a["Days Since Last Activity"], raw_points: a["Raw Points"],
    })),
  };
}

export async function sanityCheck(summary, meta, allowAdjust) {
  const out = await chatJSON(
    `Workflow Step 4 sanity check, then the Step 6 summary for ${meta.company || "the client"}.\n` +
      (meta.notes ? `Their notes: """${meta.notes.slice(0, 800)}"""\n` : "") +
      `Results: ${JSON.stringify(digest(summary))}\n\n` +
      (allowAdjust
        ? `Sanity check: only if nearly every account is Hot because the data is dense, give a higher saturation_points; ` +
          `only if almost nothing reaches Hot despite recent strong signals, give a lower one. Otherwise null.\n`
        : `Settings are final: saturation_points must be null.\n`) +
      `Summary, written for the client in the skill's style (no em dashes, positive tone, no hype words). ` +
      `Talk about their accounts, not about this review or the settings. ` +
      `headline: up to 12 words. summary: 2 to 3 sentences with accounts scored and the Hot/Warm/Watch split. ` +
      `top_hot: up to 3 Hot accounts with a one-line reason each (empty if none). ` +
      `next_step: one helpful next step.`,
    2500,
    "intent_summary",
    obj({
      saturation_points: nullable({ type: "number" }),
      adjust_reason: str,
      headline: str,
      summary: str,
      top_hot: arr(obj({ name: str, reason: str })),
      next_step: str,
    })
  );
  const sat = Number(out.saturation_points);
  return {
    saturation: allowAdjust && out.saturation_points !== null && Number.isFinite(sat) && sat >= 20 && sat <= 150 && sat !== summary.saturation_points ? sat : null,
    adjustReason: clean(out.adjust_reason, 300),
    headline: clean(out.headline, 140),
    summary: clean(out.summary, 700),
    topHot: (out.top_hot || []).slice(0, 3).map((t) => ({ name: clean(t.name, 120), reason: clean(t.reason, 300) })),
    dataNotes: [],
    nextStep: clean(out.next_step, 300),
  };
}
