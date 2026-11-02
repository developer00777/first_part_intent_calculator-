// Account and contact scoring: recency-decayed signal points, capped per contact,
// multiplied for buying-group size, and squashed to 0-100.

const DAY = 86400000;

export const WINDOW_DAYS = { "Last 30 days": 30, "Last 90 days": 90, "Last 6 months": 182, "Last 12 months": 365 };

export function levelFor(score, cfg) {
  return score >= cfg.levels.hot ? "Hot" : score >= cfg.levels.warm ? "Warm" : "Watch";
}

const isoDay = (d) => d.toISOString().slice(0, 10);

function titleFromDomain(domain) {
  const base = domain.split(".")[0];
  return base.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function mostCommon(counter) {
  let best = "", n = 0;
  for (const [k, v] of counter) if (v > n) { best = k; n = v; }
  return best;
}

function weekStart(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  return isoDay(new Date(x - dow * DAY));
}

/**
 * @param events   normalized events, each with a `signal` key already assigned
 * @param cfg      scoring config (config/scoring.json), weights possibly adjusted
 * @param opts     { windowDays, asOf: "data" | "today" }
 */
export function scoreAll(events, cfg, opts) {
  const S = cfg.signals;
  const dated = events.filter((e) => e.date);
  const latest = dated.reduce((m, e) => (e.date > m ? e.date : m), new Date(0));
  const asOf = opts.asOf === "today" || !dated.length ? new Date() : latest;
  const from = new Date(asOf - opts.windowDays * DAY);
  const inWindow = dated.filter((e) => e.date >= from && e.date <= new Date(+asOf + DAY));
  const halfLife = cfg.halfLifeDays;

  // contact key: email, or an anonymous per-domain bucket for domain-only rows (visitor ID tools)
  const contacts = new Map();
  for (const e of inWindow) {
    if (!e.signal || !S[e.signal] || S[e.signal].points === 0) continue;
    const key = e.email || `anon@${e.domain}`;
    if (!e.email && !e.domain) continue;
    let c = contacts.get(key);
    if (!c) {
      c = { email: e.email, domain: e.domain, companies: new Map(), bySignal: new Map(), last: e.date, sources: new Set() };
      contacts.set(key, c);
    }
    if (!c.domain && e.domain) c.domain = e.domain;
    if (e.company) c.companies.set(e.company, (c.companies.get(e.company) || 0) + 1);
    if (e.date > c.last) c.last = e.date;
    c.sources.add(e.source);
    const age = Math.max(0, (asOf - e.date) / DAY);
    const value = S[e.signal].points * Math.pow(0.5, age / halfLife);
    if (!c.bySignal.has(e.signal)) c.bySignal.set(e.signal, []);
    c.bySignal.get(e.signal).push(value);
  }

  // per contact: keep only the strongest N events of each signal
  for (const c of contacts.values()) {
    c.points = 0;
    c.signalCounts = new Map();
    c.signalPoints = new Map();
    for (const [sig, vals] of c.bySignal) {
      const cap = S[sig].maxPerContact ?? 5;
      const kept = vals.sort((a, b) => Math.abs(b) - Math.abs(a)).slice(0, cap);
      const pts = kept.reduce((a, v) => a + v, 0);
      c.signalCounts.set(sig, vals.length);
      c.signalPoints.set(sig, pts);
      c.points += pts;
    }
    let top = "", best = -Infinity;
    for (const [sig, p] of c.signalPoints) if (p > best) { best = p; top = sig; }
    c.topSignal = top;
  }

  // accounts
  const accounts = new Map();
  for (const c of contacts.values()) {
    if (!c.domain) continue; // personal-email contacts stay in the contact file only
    let a = accounts.get(c.domain);
    if (!a) {
      a = { domain: c.domain, companies: new Map(), contacts: [], raw: 0, signalCounts: new Map(), signalPoints: new Map(), last: c.last, sources: new Set() };
      accounts.set(c.domain, a);
    }
    a.contacts.push(c);
    a.raw += c.points;
    if (c.last > a.last) a.last = c.last;
    for (const s of c.sources) a.sources.add(s);
    for (const [k, v] of c.companies) a.companies.set(k, (a.companies.get(k) || 0) + v);
    for (const [k, v] of c.signalCounts) a.signalCounts.set(k, (a.signalCounts.get(k) || 0) + v);
    for (const [k, v] of c.signalPoints) a.signalPoints.set(k, (a.signalPoints.get(k) || 0) + v);
  }

  const bg = cfg.buyingGroup;
  const out = [];
  for (const a of accounts.values()) {
    const engaged = a.contacts.filter((c) => c.email && c.points > 0).length;
    const mult = Math.min(bg.max, 1 + bg.perExtraContact * Math.max(0, engaged - 1));
    const score = Math.round(100 * (1 - Math.exp(-Math.max(0, a.raw) * mult / cfg.saturation)));
    const level = levelFor(score, cfg);
    const name = mostCommon(a.companies) || titleFromDomain(a.domain);
    const topSignals = [...a.signalPoints.entries()]
      .filter(([, p]) => p > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([k]) => ({ key: k, label: S[k].label, count: a.signalCounts.get(k) }));
    const daysSince = Math.max(0, Math.round((asOf - a.last) / DAY));
    out.push({
      name, domain: a.domain, score, level, engaged, contacts: a.contacts.length,
      multiplier: mult, raw: a.raw, topSignals, last: a.last, daysSince, sources: [...a.sources],
      signalCounts: Object.fromEntries(a.signalCounts),
      reason: templateReason(score, topSignals, engaged, daysSince),
      action: cfg.actions[level.toLowerCase()],
    });
  }
  out.sort((x, y) => y.score - x.score || y.raw - x.raw || x.domain.localeCompare(y.domain));

  const byDomain = new Map(out.map((a) => [a.domain, a]));
  const contactRows = [...contacts.values()]
    .filter((c) => c.email)
    .map((c) => {
      const a = byDomain.get(c.domain);
      return {
        email: c.email, name: a ? a.name : mostCommon(c.companies) || "(personal email)", domain: c.domain,
        points: Math.round(c.points * 10) / 10, topSignal: c.topSignal ? S[c.topSignal].label : "",
        last: c.last, score: a ? a.score : "", level: a ? a.level : "",
      };
    })
    .sort((x, y) => (y.score || 0) - (x.score || 0) || y.points - x.points);

  // report aggregates
  const signalMix = new Map();
  const weekly = new Map();
  for (const e of inWindow) {
    if (!e.signal || !S[e.signal] || S[e.signal].points <= 0) continue;
    signalMix.set(e.signal, (signalMix.get(e.signal) || 0) + 1);
    const w = weekStart(e.date);
    weekly.set(w, (weekly.get(w) || 0) + 1);
  }
  const weeks = [];
  for (let d = new Date(weekStart(from)); d <= asOf; d = new Date(+d + 7 * DAY)) {
    const k = isoDay(d);
    weeks.push({ week: k, count: weekly.get(k) || 0 });
  }

  return {
    asOf, from, accounts: out, contacts: contactRows,
    stats: {
      eventsInWindow: inWindow.length,
      eventsOutside: dated.length - inWindow.length,
      levels: { Hot: out.filter((a) => a.level === "Hot").length, Warm: out.filter((a) => a.level === "Warm").length, Watch: out.filter((a) => a.level === "Watch").length },
      engagedContacts: contactRows.filter((c) => c.points > 0).length,
      signalMix: [...signalMix.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, label: S[k].label, count: n })),
      weekly: weeks,
    },
  };
}

export function templateReason(score, topSignals, engaged, daysSince) {
  const sig = topSignals.map((s) => `${s.count} ${s.label.toLowerCase()}${s.count > 1 ? " events" : ""}`).join(", ");
  const who = engaged > 1 ? ` across ${engaged} contacts` : engaged === 1 ? " from 1 contact" : " from anonymous visits";
  const when = daysSince === 0 ? "active on the as-of date" : `last active ${daysSince} day${daysSince === 1 ? "" : "s"} before the as-of date`;
  return `${sig || "Light activity"}${who}; ${when}.`;
}

export { isoDay };
