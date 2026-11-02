#!/usr/bin/env python3
"""
Score first-party intent at the account level.

Usage:
  python score_intent.py events.csv --outdir OUT [--config config.json] [--as-of YYYY-MM-DD|today]

Input: the standard events file from normalize_inputs.py
       (email, company, domain, date, source, activity, detail).
       An optional "signal" column overrides automatic classification.

Outputs in OUT/:
  intent_scores_accounts.csv  one row per account, ready for CRM import
  intent_scores_contacts.csv  one row per known contact, with account score
  intent_summary.json         data for build_report.py
  unclassified_activities.csv rows the rules could not place (review these)
"""
import argparse, json, math, os, re
from collections import Counter, defaultdict
from datetime import datetime, timedelta
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "..", "assets", "default_config.json")


def has(text, *words):
    return any(w in text for w in words)


def classify(source, activity, detail):
    """Return a signal key, 'skip' for non-intent rows, or None if unknown."""
    a = str(activity).lower()
    d = str(detail).lower()
    t = f"{a} {d}"
    s = str(source).lower()

    if s == "email":
        if has(a, "bounce", "unsub", "spam", "sent", "deliver", "dropped"):
            return "skip"
        if has(a, "repl"):
            return "email_reply"
        if has(a, "click"):
            return "email_click"
        if has(a, "open"):
            return "email_open"
        return "email_open" if not a else None

    if s == "webinar":
        if has(a, "attend", "joined"):
            return "webinar_attended"
        return "webinar_registered"

    if s == "form":
        if has(t, "demo", "contact", "quote", "trial", "talk to sales", "consult", "request a call", "pricing request", "get started"):
            return "demo_request"
        if has(t, "case stud", "case-stud", "success stor", "customer stor"):
            return "case_study_download"
        if has(t, "webinar", "event registration"):
            return "webinar_registered"
        if has(t, "newsletter", "subscribe", "blog"):
            return "blog_visit"
        return "whitepaper_download"

    if s == "web":
        if has(d, "pricing", "/plans", "price"):
            return "pricing_visit"
        if has(a, "download") and has(t, "case stud", "case-stud"):
            return "case_study_download"
        if has(a, "download"):
            return "whitepaper_download"
        if has(d, "/blog", "blog/", "/news", "/article", "/insights", "/resources/blog"):
            return "blog_visit"
        if has(d, "product", "solution", "platform", "feature", "service", "case-stud", "case stud", "demo", "contact", "integration"):
            return "product_visit"
        return "other_web_visit"

    # CRM and anything else: rep-initiated activity is not buyer intent
    if has(a, "outbound", "sent", "logged call", "outgoing", "note", "task created", "left voicemail"):
        return "skip"
    if has(t, "meeting", "demo"):
        return "meeting_booked"
    if has(t, "repl", "inbound", "incoming"):
        return "email_reply"
    if has(t, "pricing"):
        return "pricing_visit"
    if has(t, "case stud"):
        return "case_study_download"
    if has(t, "webinar"):
        return "webinar_attended" if has(t, "attend") else "webinar_registered"
    if has(t, "whitepaper", "ebook", "e-book", "download", "guide"):
        return "whitepaper_download"
    if has(t, "click"):
        return "email_click"
    if has(t, "open"):
        return "email_open"
    if has(t, "form", "contact us", "request"):
        return "demo_request"
    return None


def recency_mult(days, rules):
    for r in sorted(rules, key=lambda r: r["max_days"]):
        if days <= r["max_days"]:
            return r["multiplier"]
    return 0.0


def boost_mult(n, rules):
    for r in sorted(rules, key=lambda r: -r["min_contacts"]):
        if n >= r["min_contacts"]:
            return r["multiplier"]
    return 1.0


def level_for(score, levels):
    for lv in sorted(levels, key=lambda l: -l["min_score"]):
        if score >= lv["min_score"]:
            return lv
    return levels[-1]


def name_from_domain(domain):
    base = domain.split(".")[0]
    return " ".join(p.capitalize() for p in re.split(r"[-_]", base) if p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("events")
    ap.add_argument("--outdir", default="intent_output")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--as-of", default=None, help="YYYY-MM-DD or 'today'. Default: latest date in the data.")
    args = ap.parse_args()

    cfg = json.load(open(args.config))
    sig = cfg["signals"]
    os.makedirs(args.outdir, exist_ok=True)

    ev = pd.read_csv(args.events, dtype=str).fillna("")
    ev["date"] = pd.to_datetime(ev["date"], errors="coerce")
    ev = ev[ev["date"].notna()].copy()
    if args.as_of in (None, ""):
        as_of = ev["date"].max().normalize()
    elif args.as_of == "today":
        as_of = pd.Timestamp(datetime.now().date())
    else:
        as_of = pd.Timestamp(args.as_of)

    if "signal" in ev.columns:
        ev["signal_key"] = [s if s in sig else classify(src, a, d)
                            for s, src, a, d in zip(ev["signal"], ev["source"], ev["activity"], ev["detail"])]
    else:
        ev["signal_key"] = [classify(src, a, d) for src, a, d in zip(ev["source"], ev["activity"], ev["detail"])]

    unclassified = ev[ev["signal_key"].isna()]
    unclassified.to_csv(os.path.join(args.outdir, "unclassified_activities.csv"), index=False)
    skipped = int((ev["signal_key"] == "skip").sum())
    ev = ev[ev["signal_key"].notna() & (ev["signal_key"] != "skip") & ev["signal_key"].isin(sig.keys())].copy()

    free = set(cfg.get("free_email_domains", []))
    personal = ev[ev["domain"].str.lower().isin(free)]
    personal_contacts = personal["email"].replace("", pd.NA).dropna().nunique()
    ev = ev[~ev["domain"].str.lower().isin(free)].copy()

    ev["days_ago"] = (as_of - ev["date"].dt.normalize()).dt.days.clip(lower=0)
    ev = ev[ev["date"] <= as_of + timedelta(days=1)]
    ev["base_points"] = ev["signal_key"].map(lambda k: sig[k]["points"])
    ev["mult"] = ev["days_ago"].map(lambda d: recency_mult(d, cfg["recency"]))
    ev["weighted"] = ev["base_points"] * ev["mult"]
    ev["contact"] = ev["email"].where(ev["email"].str.contains("@"), "")

    # cap repeats per contact per signal, keeping the most valuable (most recent) rows
    cap = cfg.get("max_repeats_per_signal_per_contact", 5)
    ev = ev.sort_values("weighted", ascending=False)
    ev["rank"] = ev.groupby(["domain", "contact", "signal_key"]).cumcount()
    ev["counted"] = ev["rank"] < cap
    ev.loc[~ev["counted"], "weighted"] = 0.0

    levels = cfg["levels"]
    acct_rows, contact_rows = [], []
    signal_points, signal_counts = Counter(), Counter()

    for domain, g in ev.groupby("domain"):
        names = [c for c in g["company"] if c.strip()]
        name = Counter(names).most_common(1)[0][0] if names else name_from_domain(domain)
        contacts = g[g["contact"] != ""].groupby("contact")["weighted"].sum()
        engaged = int((contacts > 0).sum())
        raw = float(g["weighted"].sum())
        boost = boost_mult(engaged, cfg["buying_group_boost"])
        k = cfg.get("saturation_points", 50)
        score = int(round(min(cfg["score_cap"], 100 * (1 - math.exp(-raw * boost / k)))))
        lv = level_for(score, levels)
        last = g["date"].max()
        days_since = int((as_of - last.normalize()).days)

        by_sig = g[g["weighted"] > 0].groupby("signal_key").agg(n=("weighted", "size"), pts=("weighted", "sum")).sort_values("pts", ascending=False)
        for k, r in by_sig.iterrows():
            signal_points[k] += r["pts"]
            signal_counts[k] += int(r["n"])
        top = [f"{sig[k]['label']} ({int(r['n'])})" for k, r in by_sig.head(3).iterrows()]

        people = "1 engaged contact" if engaged == 1 else (f"{engaged} engaged contacts" if engaged else "anonymous visits only")
        when = "today" if days_since == 0 else ("yesterday" if days_since == 1 else f"{days_since} days ago")
        reason = f"Score {score}, {lv['name']}. {people.capitalize()}. Top signals: {', '.join(top) if top else 'older activity only'}. Last activity {when}."

        acct_rows.append({
            "Account Name": name, "Domain": domain, "Intent Score": score, "Intent Level": lv["name"],
            "Engaged Contacts": engaged, "Top Signals": "; ".join(top),
            "Last Activity Date": last.strftime("%Y-%m-%d"), "Days Since Last Activity": days_since,
            "Buying Group Boost": f"{int(round((boost - 1) * 100))}%", "Raw Points": round(raw, 1),
            "Suggested Action": lv["action"], "Score Reason": reason, "Scored On": as_of.strftime("%Y-%m-%d"),
        })
        for email, pts in contacts.items():
            cg = g[g["contact"] == email]
            csig = cg[cg["weighted"] > 0].groupby("signal_key")["weighted"].sum().sort_values(ascending=False)
            contact_rows.append({
                "Email": email, "Account Name": name, "Domain": domain,
                "Contact Points": round(float(pts), 1),
                "Contact Top Signal": sig[csig.index[0]]["label"] if len(csig) else "",
                "Last Activity Date": cg["date"].max().strftime("%Y-%m-%d"),
                "Account Intent Score": score, "Account Intent Level": lv["name"],
            })

    acct = pd.DataFrame(acct_rows).sort_values(["Intent Score", "Engaged Contacts"], ascending=False) if acct_rows else pd.DataFrame()
    cont = pd.DataFrame(contact_rows).sort_values(["Account Intent Score", "Contact Points"], ascending=False) if contact_rows else pd.DataFrame()
    acct.to_csv(os.path.join(args.outdir, "intent_scores_accounts.csv"), index=False)
    cont.to_csv(os.path.join(args.outdir, "intent_scores_contacts.csv"), index=False)

    # weekly activity by source, last 12 weeks
    start = as_of - timedelta(weeks=12)
    recent = ev[ev["date"] > start].copy()
    recent["week"] = ((as_of - recent["date"]).dt.days // 7).clip(upper=11)
    weeks = []
    for w in range(11, -1, -1):
        wk = recent[recent["week"] == w]
        label = (as_of - timedelta(weeks=w)).strftime("%b %d")
        weeks.append({"label": label, **{s: int((wk["source"] == s).sum()) for s in ["web", "email", "form", "webinar", "crm"]}})

    level_counts = {lv["name"]: int((acct["Intent Level"] == lv["name"]).sum()) if len(acct) else 0 for lv in levels}
    summary = {
        "as_of": as_of.strftime("%Y-%m-%d"),
        "accounts_scored": len(acct),
        "contacts_scored": len(cont),
        "events_used": int(ev["counted"].sum()),
        "events_skipped_non_intent": skipped,
        "events_unclassified": int(len(unclassified)),
        "personal_email_contacts": int(personal_contacts),
        "level_counts": level_counts,
        "levels": levels,
        "sources_present": sorted(ev["source"].unique().tolist()),
        "signal_mix": [{"key": k, "label": sig[k]["label"], "points": round(float(signal_points[k]), 1), "count": int(signal_counts[k])}
                       for k in sorted(signal_points, key=lambda k: -signal_points[k])],
        "weekly_activity": weeks,
        "accounts": acct.head(50).to_dict(orient="records") if len(acct) else [],
        "config_signals": [{"label": v["label"], "points": v["points"]} for v in sorted(sig.values(), key=lambda v: v["points"])],
        "recency": cfg["recency"], "buying_group_boost": cfg["buying_group_boost"],
        "saturation_points": cfg.get("saturation_points", 50),
    }
    json.dump(summary, open(os.path.join(args.outdir, "intent_summary.json"), "w"), indent=2, default=str)

    print(f"Scored {len(acct)} accounts and {len(cont)} contacts as of {summary['as_of']}.")
    print("Levels:", level_counts)
    print(f"Skipped non-intent rows: {skipped}. Unclassified rows: {len(unclassified)} (see unclassified_activities.csv).")
    print(f"Personal email contacts set aside: {personal_contacts}.")


if __name__ == "__main__":
    main()
