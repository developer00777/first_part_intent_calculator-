// Turns a parsed table into normalized events: { source, date, email, domain, company, text, attended }.
// Column detection mirrors the browser checks in public/index.html, then picks the single best column per role.

export const SOURCE_KEYS = ["web", "email", "form", "webinar", "crm"];

const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const FREE_MAIL = new Set(
  ("gmail.com googlemail.com yahoo.com yahoo.co.in yahoo.co.uk ymail.com hotmail.com hotmail.co.uk outlook.com live.com msn.com " +
    "icloud.com me.com mac.com aol.com protonmail.com proton.me gmx.com gmx.de mail.com yandex.com yandex.ru zohomail.com " +
    "rediffmail.com qq.com 163.com 126.com web.de free.fr orange.fr btinternet.com comcast.net verizon.net att.net sbcglobal.net")
    .split(" ")
);

// ---------- source guess (same rules as the browser) ----------
export function guessSource(name, headers) {
  const n = String(name).toLowerCase(), h = headers.map(norm).join(" ");
  if (/webinar|zoom|on24|goto|livestorm|attendee|registrant/.test(n) || /attended|webinar|jointime/.test(h)) return "webinar";
  if (/form|typeform|gravity|submission|webflow/.test(n) || /formname|submitted/.test(h)) return "form";
  if (/mail|klaviyo|brevo|campaign|newsletter/.test(n) || /recipient|opened|clicked/.test(h)) return "email";
  if (/crm|salesforce|sfdc|hubspot|zoho|dynamics|activit|meeting|engagement/.test(n)) return "crm";
  if (/ga4|analytics|web|visit|page|traffic|site/.test(n) || /pagepath|pageurl|pagetitle/.test(h)) return "web";
  return "";
}

// ---------- column picking ----------
// Each rule list is in priority order; the first header matching an earlier rule wins.
function pickCol(nh, rules, exclude) {
  for (const re of rules) {
    const i = nh.findIndex((h) => re.test(h) && !(exclude && exclude.test(h)));
    if (i > -1) return i;
  }
  return -1;
}

const ACTIVITY_RULES = {
  web: [/^(pageurl|pagepath|url|path|landingpage|pagelocation|fullurl)$/, /pageurl|pagepath|url|path|page/, /pagetitle|title/, /event|action/],
  email: [/^(event|eventtype|action|activity|type|activitytype)$/, /event|action|activity|status|opened|clicked|replied/, /link|url/, /campaign|subject/],
  form: [/^(formname|form|formtitle|conversion|conversionname)$/, /formname|form|conversion/, /page|url|source|campaign/],
  webinar: [/^(webinartitle|webinar|title|topic|eventname|sessionname)$/, /webinar|title|topic|event|session/],
  crm: [/^(activitytype|type|tasktype|eventtype|activity)$/, /activitytype|type|activity/, /subject|description|status/],
};
const EXCLUDE_ACTIVITY = /date|time|email|domain|website|id$|owner|phone|name$/;

export function detectColumns(headers, source) {
  const nh = headers.map(norm);
  const date = pickCol(
    nh,
    [/^(date|timestamp|eventdate|activitydate|eventtime|time|datetime|occurredat)$/, /eventdate|activitydate|submitted|submissiondate|registered|registrationdate|jointime|createdat|createddate|sentat|clickedat|openedat|date|timestamp|time/],
    /update|modified|birth|duration|timezone|lastlogin|timeinsession|leavetime/
  );
  const email = pickCol(nh, [/^(email|emailaddress|recipient|recipientemail|contactemail|workemail|businessemail)$/, /email|recipient/], /domain|optin|optout|status|bounce|opened|clicked|campaign|subject|type/);
  const domain = pickCol(nh, [/^(domain|companydomain|website|companywebsite|emaildomain)$/, /domain|website/]);
  const company = pickCol(nh, [/^(company|companyname|account|accountname|organization|organisation|organizationname)$/, /company|account|organi/], /domain|website|id$|owner|type|size|industry|revenue|employees/);
  const src = source || "crm";
  const activity = [];
  for (const re of ACTIVITY_RULES[src] || ACTIVITY_RULES.crm) {
    const i = nh.findIndex((h, idx) => re.test(h) && !EXCLUDE_ACTIVITY.test(h) && idx !== date && !activity.includes(idx));
    if (i > -1 && activity.length < 2) activity.push(i);
  }
  const attended = src === "webinar" ? pickCol(nh, [/^(attended|attendance|attendee|didattend|attendedyesno)$/, /attended|attendance|attendee/, /timeinsession|duration|jointime/]) : -1;
  return { date, email, domain, company, activity, attended };
}

// ---------- values ----------
export function normEmail(v) {
  const s = String(v ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  const m = s.match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : "";
}

export function normDomain(v) {
  let s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) s = s.split("@").pop();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\d?\./, "").split(/[/?#:\s]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : "";
}

export const isFreeMail = (d) => FREE_MAIL.has(d);

// Detect day/month order for a date column: any first part > 12 means D/M/Y.
function slashOrder(values) {
  let dmy = 0, mdy = 0;
  for (const v of values) {
    const m = typeof v === "string" && v.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (!m) continue;
    if (+m[1] > 12) dmy++;
    else if (+m[2] > 12) mdy++;
    if (dmy + mdy > 50) break;
  }
  return dmy > mdy ? "dmy" : "mdy";
}

export function makeDateParser(values) {
  const order = slashOrder(values);
  return (v) => {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === "number") {
      if (v > 1e11) return new Date(v); // epoch ms
      if (v > 1e9) return new Date(v * 1000); // epoch s
      if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)); // Excel serial
      return null;
    }
    const s = String(v ?? "").trim();
    if (!s) return null;
    if (/^\d{10,13}$/.test(s)) return new Date(s.length === 13 ? +s : +s * 1000);
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?/i);
    if (m) {
      let [, a, b, y, hh = "0", mm = "0", ss = "0", ap] = m;
      let day = order === "dmy" ? +a : +b, mon = order === "dmy" ? +b : +a;
      let year = +y < 100 ? 2000 + +y : +y;
      let hour = +hh;
      if (ap) hour = (hour % 12) + (/p/i.test(ap) ? 12 : 0);
      const d = new Date(Date.UTC(year, mon - 1, day, hour, +mm, +ss));
      return isNaN(d) || mon > 12 || day > 31 ? null : d;
    }
    const d = new Date(s.replace(/ UTC$/, "Z"));
    return isNaN(d) || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100 ? null : d;
  };
}

// Web paths: drop host, query string and trailing slash so /pricing?utm=x and https://site.com/pricing/ match.
function cleanText(v, source) {
  let s = v instanceof Date ? "" : String(v ?? "").trim();
  if (!s) return "";
  if (source === "web" || /^https?:\/\//i.test(s)) {
    s = s.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  }
  return s.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

const TRUTHY = /^(yes|y|true|1|attended|present|joined|x)$/i;

export function extractEvents(table, source) {
  const cols = detectColumns(table.headers, source);
  const warnings = [];
  if (cols.date < 0) return { events: [], cols, warnings: ["No date column found."], skipped: table.rows.length };
  if (cols.email < 0 && cols.domain < 0) return { events: [], cols, warnings: ["No email or domain column found."], skipped: table.rows.length };

  const parseDate = makeDateParser(table.rows.slice(0, 500).map((r) => r[cols.date]));
  const events = [];
  let skipped = 0;
  for (const r of table.rows) {
    const date = parseDate(r[cols.date]);
    const email = cols.email > -1 ? normEmail(r[cols.email]) : "";
    let domain = cols.domain > -1 ? normDomain(r[cols.domain]) : "";
    if (!domain && email) domain = normDomain(email);
    if (!date || (!email && !domain)) { skipped++; continue; }
    const text = cols.activity.map((i) => cleanText(r[i], source)).filter(Boolean).join(" | ");
    let attended = null;
    if (cols.attended > -1) {
      const a = r[cols.attended];
      attended = typeof a === "number" ? a > 0 : TRUTHY.test(String(a ?? "").trim()) || /^\d+(\.\d+)?$/.test(String(a).trim()) && +a > 0;
    }
    const company = cols.company > -1 ? String(r[cols.company] ?? "").trim().slice(0, 120) : "";
    events.push({ source, date, email, domain: isFreeMail(domain) ? "" : domain, company, text, attended });
  }
  if (skipped) warnings.push(`${skipped.toLocaleString("en-US")} row(s) skipped: missing or unreadable date, email or domain.`);
  return { events, cols, warnings, skipped };
}
