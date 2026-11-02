#!/usr/bin/env python3
"""
Normalize mixed first-party exports into one standard events file.

Usage:
  python normalize_inputs.py --out events.csv FILE[:SOURCE] [FILE[:SOURCE] ...]

SOURCE is optional and one of: web, email, form, webinar, crm.
If omitted, the source is guessed from the file name and columns.

Output columns (one row per activity):
  email, company, domain, date, source, activity, detail

The script prints a mapping summary for each file so the column choices can be
checked. Rows without both a usable identity (email or domain) and a date are
dropped and counted.
"""
import argparse, os, re, sys
import pandas as pd

ALIASES = {
    "email":   ["email", "email address", "e-mail", "contact email", "work email", "recipient", "recipient email", "attendee email", "user email", "lead email"],
    "company": ["company", "company name", "account", "account name", "organization", "organisation", "org", "employer"],
    "domain":  ["domain", "company domain", "website", "company website", "account domain", "visitor domain", "web domain"],
    "date":    ["date", "timestamp", "time", "event date", "activity date", "created", "created at", "created date", "submitted at",
                "submission date", "visit date", "open date", "click date", "opened at", "clicked at", "sent at", "join time",
                "registration time", "attended date", "last activity date", "activity time", "date time", "datetime"],
    "activity":["activity", "event", "event type", "action", "activity type", "type", "interaction", "status", "engagement type", "task type"],
    "detail":  ["page", "url", "page url", "page path", "path", "landing page", "form", "form name", "asset", "asset name", "content",
                "content name", "campaign", "campaign name", "subject", "email name", "webinar", "webinar name", "webinar title",
                "subject line", "link", "link url", "clicked url", "description", "notes", "title", "page title"],
    "attended":["attended", "attendance", "attended?", "joined", "was attended", "attendee status"],
}
SOURCES = {"web", "email", "form", "webinar", "crm"}


def norm(s):
    return re.sub(r"[\s_\-]+", " ", str(s).strip().lower())


def find_col(cols, key):
    ncols = {norm(c): c for c in cols}
    for a in ALIASES[key]:
        if a in ncols:
            return ncols[a]
    for a in ALIASES[key]:  # loose contains match
        for n, c in ncols.items():
            if a in n and len(a) > 3:
                return c
    return None


def guess_source(path, cols):
    n = os.path.basename(path).lower()
    joined = " ".join(norm(c) for c in cols)
    for key, words in [("webinar", ["webinar", "zoom", "gotowebinar", "on24", "attendee"]),
                       ("form", ["form", "submission", "submissions"]),
                       ("email", ["email report", "campaign", "mailchimp", "opens", "clicks", "open", "click", "recipient"]),
                       ("web", ["analytics", "ga4", "web", "page", "visit", "session", "traffic"]),
                       ("crm", ["crm", "hubspot", "salesforce", "zoho", "activity", "task", "deal", "meeting"])]:
        if any(w in n for w in words):
            return key
    for key, words in [("webinar", ["webinar", "attended", "join time"]),
                       ("form", ["form name", "submitted"]),
                       ("email", ["recipient", "subject", "opened", "clicked"]),
                       ("web", ["page", "url", "session"]),
                       ("crm", ["task", "deal", "meeting", "activity type"])]:
        if any(w in joined for w in words):
            return key
    return "crm"


def read_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm", ".xls"):
        return pd.read_excel(path, dtype=str)
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(path, dtype=str, encoding=enc, sep=None, engine="python")
        except UnicodeDecodeError:
            continue
    return pd.read_csv(path, dtype=str, encoding="latin-1")


def domain_from(email, domain):
    d = (domain or "").strip().lower()
    if d:
        d = re.sub(r"^https?://", "", d)
        d = re.sub(r"^www\.", "", d).split("/")[0]
        return d
    e = (email or "").strip().lower()
    return e.split("@", 1)[1] if "@" in e else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out", default="events.csv")
    args = ap.parse_args()

    frames = []
    for spec in args.inputs:
        path, src = spec, ""
        if ":" in spec and spec.rsplit(":", 1)[-1] in SOURCES:
            path, src = spec.rsplit(":", 1)
        df = read_any(path)
        df.columns = [str(c) for c in df.columns]
        src = src or guess_source(path, df.columns)
        m = {"domain": find_col(df.columns, "domain"), "email": find_col(df.columns, "email")}
        rest = [c for c in df.columns if c not in (m["domain"], m["email"])]
        for k in ALIASES:
            if k not in m:
                m[k] = find_col(rest, k)

        out = pd.DataFrame({
            "email":   df[m["email"]] if m["email"] else "",
            "company": df[m["company"]] if m["company"] else "",
            "domain":  df[m["domain"]] if m["domain"] else "",
            "date":    df[m["date"]] if m["date"] else "",
            "source":  src,
            "activity": df[m["activity"]] if m["activity"] else "",
            "detail":  df[m["detail"]] if m["detail"] else "",
        }).fillna("")
        if src == "webinar" and m["attended"]:
            att = df[m["attended"]].fillna("").astype(str).str.strip().str.lower()
            out["activity"] = att.map(lambda v: "attended" if v in ("yes", "y", "true", "1", "attended") else "registered")
        out["domain"] = [domain_from(e, d) for e, d in zip(out["email"], out["domain"])]
        out["email"] = out["email"].astype(str).str.strip().str.lower()
        out["date"] = pd.to_datetime(out["date"], errors="coerce", format="mixed", dayfirst=False)
        before = len(out)
        out = out[(out["domain"] != "") & out["date"].notna()]
        dropped = before - len(out)
        out["date"] = out["date"].dt.strftime("%Y-%m-%d")
        frames.append(out)

        print(f"\n[{os.path.basename(path)}] source={src} rows={before} kept={len(out)} dropped={dropped}")
        for k, v in m.items():
            print(f"  {k:<9} <- {v if v else '(not found)'}")

    if not frames:
        sys.exit("No input files read.")
    allev = pd.concat(frames, ignore_index=True)
    allev.to_csv(args.out, index=False)
    print(f"\nWrote {len(allev)} events to {args.out}")


if __name__ == "__main__":
    main()
