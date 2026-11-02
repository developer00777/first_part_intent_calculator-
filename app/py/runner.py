#!/usr/bin/env python3
"""
Thin, non-invasive wrapper around the first-party-intent-calculator skill scripts.

The skill's scripts are run unmodified. This runner only performs the steps the
skill's SKILL.md tells the operator to do by hand:

  inspect   : Step 2 "take a quick look at each file" (columns, guessed source,
              the mapping normalize_inputs.py would choose, masked sample rows)
  normalize : Step 2 normalisation, using normalize_inputs.py's own helpers, with
              reviewed column choices and day-first date handling applied (the
              skill's sanctioned "fix" path). Returns distinct activities with the
              skill's own rule classification so they can be reviewed.
  score     : Step 2 optional `signal` column, Step 3 config, Step 4 score_intent.py,
              Step 5 build_report.py.

Usage: python runner.py <command> <workdir> <request.json>   (prints JSON to stdout)
"""
import json, os, re, subprocess, sys

SKILL_DIR = os.environ.get("SKILL_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "skills", "first-party-intent-calculator"))
SCRIPTS = os.path.join(SKILL_DIR, "scripts")
sys.path.insert(0, SCRIPTS)

import pandas as pd  # noqa: E402
import normalize_inputs as N  # noqa: E402  (skill script, imported for its helpers)
import score_intent as S  # noqa: E402      (skill script, imported for classify())

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+'-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
FIELDS = ["email", "company", "domain", "date", "activity", "detail", "attended"]


def mask(v):
    s = "" if v is None else str(v)
    s = EMAIL_RE.sub(lambda m: "***@" + m.group(1), s)
    return s[:80]


def skill_mapping(cols):
    """Exactly the column choice normalize_inputs.main() makes."""
    m = {"domain": N.find_col(cols, "domain"), "email": N.find_col(cols, "email")}
    rest = [c for c in cols if c not in (m["domain"], m["email"])]
    for k in N.ALIASES:
        if k not in m:
            m[k] = N.find_col(rest, k)
    return m


def detect_dayfirst(values):
    """True when slash/dot/dash dates are clearly day-first (any first part > 12)."""
    dmy = mdy = 0
    for v in values:
        mt = re.match(r"^\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})", str(v))
        if not mt:
            continue
        a, b = int(mt.group(1)), int(mt.group(2))
        if a > 12 >= b:
            dmy += 1
        elif b > 12 >= a:
            mdy += 1
    return dmy > mdy


def cmd_inspect(work, req):
    out = []
    for f in req["files"]:
        path = os.path.join(work, f["path"])
        try:
            df = N.read_any(path)
        except Exception as e:  # unreadable file
            out.append({"name": f["name"], "error": str(e)[:300]})
            continue
        df.columns = [str(c) for c in df.columns]
        src = f.get("source") if f.get("source") in N.SOURCES else N.guess_source(f["name"], df.columns)
        m = skill_mapping(df.columns)
        dates = df[m["date"]].dropna().astype(str).head(300).tolist() if m["date"] else []
        out.append({
            "name": f["name"], "path": f["path"], "source": src, "rows": int(len(df)),
            "columns": list(df.columns), "mapping": m, "dayfirst": detect_dayfirst(dates),
            "sample": [{c: mask(v) for c, v in r.items()} for r in df.head(3).fillna("").to_dict(orient="records")],
        })
    return {"files": out}


def cmd_normalize(work, req):
    """Mirror of normalize_inputs.main() with reviewed mapping + day-first dates."""
    frames, report = [], []
    for f in req["files"]:
        path = os.path.join(work, f["path"])
        df = N.read_any(path)
        df.columns = [str(c) for c in df.columns]
        src = f["source"]
        m = {k: (f["mapping"].get(k) if f["mapping"].get(k) in df.columns else None) for k in FIELDS}
        out = pd.DataFrame({
            "email": df[m["email"]] if m["email"] else "",
            "company": df[m["company"]] if m["company"] else "",
            "domain": df[m["domain"]] if m["domain"] else "",
            "date": df[m["date"]] if m["date"] else "",
            "source": src,
            "activity": df[m["activity"]] if m["activity"] else "",
            "detail": df[m["detail"]] if m["detail"] else "",
        }, index=df.index).fillna("")
        if src == "webinar" and m["attended"]:
            att = df[m["attended"]].fillna("").astype(str).str.strip().str.lower()
            out["activity"] = att.map(lambda v: "attended" if v in ("yes", "y", "true", "1", "attended") else "registered")
        out["domain"] = [N.domain_from(e, d) for e, d in zip(out["email"], out["domain"])]
        out["email"] = out["email"].astype(str).str.strip().str.lower()
        out["date"] = pd.to_datetime(out["date"], errors="coerce", format="mixed", dayfirst=bool(f.get("dayfirst")))
        before = len(out)
        out = out[(out["domain"] != "") & out["date"].notna()]
        out["date"] = out["date"].dt.strftime("%Y-%m-%d")
        frames.append(out)
        report.append({"name": f["name"], "source": src, "rows": before, "kept": int(len(out)), "dropped": int(before - len(out)),
                       "mapping": m, "dayfirst": bool(f.get("dayfirst"))})

    ev = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=["email", "company", "domain", "date", "source", "activity", "detail"])
    ev.to_csv(os.path.join(work, "events.csv"), index=False)
    # re-read exactly as score_intent.py will, so activity keys match byte for byte
    ev = pd.read_csv(os.path.join(work, "events.csv"), dtype=str).fillna("")

    # distinct activities with the skill's own rule result, most frequent first
    g = ev.groupby(["source", "activity", "detail"], dropna=False).size().reset_index(name="count").sort_values("count", ascending=False)
    acts = []
    for src, a, d, n in g.itertuples(index=False):
        acts.append({"source": src, "activity": str(a)[:120], "detail": str(d)[:160], "count": int(n), "rule": S.classify(src, a, d) or None,
                     "_a": str(a), "_d": str(d)})
    return {"events": int(len(ev)), "files": report, "activities": acts}


def cmd_score(work, req):
    ev = pd.read_csv(os.path.join(work, "events.csv"), dtype=str).fillna("")
    labels = req.get("labels") or {}
    set_aside = 0
    if labels:
        keys = [f"{s}\x1f{a}\x1f{d}" for s, a, d in zip(ev["source"], ev["activity"], ev["detail"])]
        sig = [labels.get(k, "") for k in keys]
        # "skip" cannot be expressed through the skill's signal column, so those rows are set aside here
        keep = [s != "skip" for s in sig]
        set_aside = len(keep) - sum(keep)
        ev["signal"] = sig
        ev = ev[keep]
    ev.to_csv(os.path.join(work, "events_scored.csv"), index=False)

    cfg_path = os.path.join(work, "config.json")
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump(req["config"], fh, indent=2)
    outdir = os.path.join(work, "out")
    cmd = [sys.executable, os.path.join(SCRIPTS, "score_intent.py"), os.path.join(work, "events_scored.csv"), "--outdir", outdir, "--config", cfg_path]
    if req.get("as_of") == "today":
        cmd += ["--as-of", "today"]
    p1 = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    if p1.returncode != 0:
        raise RuntimeError("score_intent.py failed: " + p1.stderr[-800:])
    rcmd = [sys.executable, os.path.join(SCRIPTS, "build_report.py"), os.path.join(outdir, "intent_summary.json"),
            "--out", os.path.join(outdir, "intent_report.html"), "--top", str(req.get("top", 25))]
    if req.get("client"):
        rcmd += ["--client", req["client"]]
    p2 = subprocess.run(rcmd, capture_output=True, text=True, timeout=120)
    if p2.returncode != 0:
        raise RuntimeError("build_report.py failed: " + p2.stderr[-800:])
    with open(os.path.join(outdir, "intent_summary.json"), encoding="utf-8") as fh:
        summary = json.load(fh)
    return {"summary": summary, "set_aside_by_review": set_aside, "log": (p1.stdout + p2.stdout)[-2000:]}


def main():
    cmd, work, req_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(req_path, encoding="utf-8") as fh:
        req = json.load(fh)
    fn = {"inspect": cmd_inspect, "normalize": cmd_normalize, "score": cmd_score}[cmd]
    try:
        res = fn(work, req)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"[:1500]}))
        sys.exit(1)
    sys.stdout.write(json.dumps(res, default=str))


if __name__ == "__main__":
    main()
