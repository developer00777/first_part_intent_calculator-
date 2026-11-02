---
name: "first-party-intent-calculator"
description: Calculates account-level buying intent from a company's own first-party engagement data (website analytics, email platform reports, form submissions, webinar lists, CRM activity) and delivers a colorful visual HTML intent report plus CRM-ready CSV files. Use this skill whenever someone wants to score leads or accounts, find which accounts are showing interest, rank accounts by engagement, build an intent score or intent report from their own data, combine marketing exports into one view, prioritize accounts for sales, or asks "who is most interested", "which accounts should sales call", "score my leads", "lead scoring", "account scoring", "engagement scoring", or "intent level", even if they don't use the word "intent". Also use when someone uploads exports from GA4, HubSpot, Salesforce, Marketo, Zoho, Mailchimp, Zoom, ON24, or similar tools and wants to know what the activity means.
---

# First-Party Intent Calculator

Turns the engagement data a company already owns into a clear, account-level intent score (0 to 100), an intent level (Hot, Warm, Watch), and a plain-language reason for every score. Outputs a visual HTML report for leaders and CSV files for CRM import.

The scoring is deterministic and lives in scripts, so results are consistent and explainable. Your job is to get the data in cleanly, run the scripts, check the results make sense, and explain them in friendly, practical language.

## Writing style for everything you produce

These preferences matter to the people who use this skill, so follow them in chat replies and in any text you add to the report:

- Never use em dashes. Use commas, periods, colons, or parentheses instead.
- Avoid overused marketing words such as "unlock", "unleash", "supercharge", "game-changer", and "leverage".
- Keep the tone positive and constructive. Avoid words like "poor", "bad", "weak", "failing", or "low quality". Describe a lighter account as "early stage" or "on the Watch list", and missing data as "not included yet".
- Any HTML you generate or edit must keep every font size at 19px or larger.

## Workflow

### Step 1: Understand the request and collect files

Find out three things, using what's already in the conversation before asking:

1. **The client's company name** (used in the report title). If unknown, leave it out.
2. **The files.** Check `/mnt/user-data/uploads` for exports. Any mix of CSV or Excel files from website analytics, email, forms, webinars, and CRM works. One file is enough to start.
3. **Anything unusual about their sales process**, only if they mention it (for example, "webinars are our main buying signal"). This feeds Step 3.

If the person has no files yet, read `references/export-guide.md` and tell them which exports to pull and which columns matter. Don't invent sample data and present it as theirs.

### Step 2: Normalize the inputs

Take a quick look at each file first (`head`, column names, row count) so you know what you're working with. Then run:

```bash
python scripts/normalize_inputs.py --out /home/claude/intent/events.csv \
  FILE1.csv FILE2.xlsx:email FILE3.csv:webinar
```

Add `:web`, `:email`, `:form`, `:webinar`, or `:crm` after a file path when the source type isn't obvious from the name. The script prints which column it used for each field. **Read that summary.** Fix it if:

- A key field shows `(not found)` but the file clearly has it under an unusual name.
- The wrong column was picked (for example, a "Company Domain" column chosen as company name).
- Many rows were dropped (usually a date format or missing email/domain).

To fix, write a short pandas step that renames columns or builds the standard events file directly. The standard columns are: `email, company, domain, date, source, activity, detail`. You can also add a `signal` column with one of the signal keys from `assets/default_config.json` to set the signal type yourself, which overrides automatic classification for that row.

Website data without emails (for example, reverse-IP visitor tools that only give a company domain) is fine. It still counts toward the account, but not toward the buying group size.

### Step 3: Choose the scoring settings

Use `assets/default_config.json` unless the person asks for changes or described something in Step 1 that clearly calls for one. To customize, copy it to `/home/claude/intent/config.json`, edit, and pass `--config`. See `references/scoring-model.md` for what each setting does and sensible ranges. Mention any change you made in your final reply.

### Step 4: Score

```bash
python scripts/score_intent.py /home/claude/intent/events.csv \
  --outdir /home/claude/intent/out [--config config.json] [--as-of today]
```

By default, recency is measured from the latest date in the data, which keeps older exports meaningful. Use `--as-of today` when the person wants a live view and the exports are current.

**Sanity check before moving on:**

- Open `unclassified_activities.csv`. If it holds more than about 10% of rows, look at the activity and detail values, then either add a `signal` column in Step 2 or explain to the person which rows weren't scored and why.
- Look at the level counts. If nearly every account is Hot, the data may be dense (very active accounts or a long export window). That can be accurate, but check that recency looks right and consider whether `saturation_points` should be raised. If nearly everything is Watch, check whether the export window is old relative to the as-of date.
- Glance at the top five accounts and their reasons. They should make intuitive sense.

### Step 5: Build the report

```bash
python scripts/build_report.py /home/claude/intent/out/intent_summary.json \
  --out /home/claude/intent/out/intent_report.html --client "Client Name"
```

The report includes KPI cards, an intent level donut, a top 10 bar chart, a ranked account table, a signal mix chart, weekly activity by source, a transparent scoring method section, a short section on what third-party intent data would add, data notes, and a "Powered by LakeB2B" footer. It is a single self-contained HTML file with no external dependencies, and it adapts to light and dark mode.

Don't rewrite the report from scratch. If the person wants changes (colors to match their brand, extra sections, a different number of rows with `--top`), edit `build_report.py` output or the generated HTML, keeping fonts at 19px or larger.

### Step 6: Deliver

Copy these to `/mnt/user-data/outputs/` and share them with the person:

1. `intent_report.html` (the visual report)
2. `intent_scores_accounts.csv` (one row per account, for CRM import)
3. `intent_scores_contacts.csv` (one row per contact with their account's score, for contact-level CRM fields)

Then write a short chat summary in prose:

- How many accounts were scored and the Hot / Warm / Watch split.
- The top three Hot accounts with a one-line reason each.
- Anything worth knowing about the data (rows set aside, personal emails, settings you changed).
- One helpful next step, for example importing the CSV into their CRM, or turning Hot accounts into sales alerts.

Keep it brief. The report carries the detail.

## CSV columns (for CRM import)

**Accounts:** Account Name, Domain, Intent Score, Intent Level, Engaged Contacts, Top Signals, Last Activity Date, Days Since Last Activity, Buying Group Boost, Raw Points, Suggested Action, Score Reason, Scored On.

**Contacts:** Email, Account Name, Domain, Contact Points, Contact Top Signal, Last Activity Date, Account Intent Score, Account Intent Level.

If the person names a CRM, see the import tips in `references/export-guide.md`. Domain is the most reliable matching key for accounts, and Email for contacts.

## Privacy

The input files contain personal contact data. Use it only to produce the outputs in this session. Don't save contact details, emails, or account lists to memory, and don't include more personal data in the chat reply than the summary needs.

## Files in this skill

- `scripts/normalize_inputs.py`: maps mixed exports to the standard events file
- `scripts/score_intent.py`: the scoring engine, writes CSVs and the summary JSON
- `scripts/build_report.py`: builds the HTML report
- `assets/default_config.json`: signal points, recency, buying group boost, levels
- `references/scoring-model.md`: how the score works and how to tune it (read when customizing or when someone asks how scores are calculated)
- `references/export-guide.md`: which exports to pull from common tools and CRM import tips (read when the person has no files yet or asks about importing)
