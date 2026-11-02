// CRM-ready CSV files. UTF-8 BOM so Excel opens them correctly; formula-like text is neutralised.
import { isoDay } from "./score.js";

function cell(v) {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? isoDay(v) : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // CSV injection guard
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const toCsv = (header, rows) => "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

export function accountsCsv(accounts) {
  return toCsv(
    ["Account Name", "Domain", "Intent Score", "Intent Level", "Engaged Contacts", "Top Signals", "Last Activity", "Suggested Action", "Score Reason"],
    accounts.map((a) => [
      a.name, a.domain, a.score, a.level, a.engaged,
      a.topSignals.map((s) => `${s.label} (${s.count})`).join("; "),
      a.last, a.action, a.reason,
    ])
  );
}

export function contactsCsv(contacts) {
  return toCsv(
    ["Email", "Account Name", "Domain", "Contact Points", "Top Signal", "Last Activity", "Account Score", "Account Level"],
    contacts.map((c) => [c.email, c.name, c.domain, c.points, c.topSignal, c.last, c.score, c.level])
  );
}
