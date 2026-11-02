# First-Party Intent Calculator

Upload website, email, form, webinar and CRM exports. Get a 0 to 100 intent score for every account
(Hot / Warm / Watch), a visual HTML report, and CRM-ready account and contact CSV files.

One Docker image serves the frontend and the scoring API. An OpenRouter model, guided by the intent
skill in `skill/`, classifies activities and writes the explanations. A deterministic engine does the math.

```
browser ── POST /api/score (multipart: meta + files) ──► Node API (Hono)
                                                          ├─ parse CSV/TSV/XLSX/XLS
                                                          ├─ detect columns, normalise email/domain/date
                                                          ├─ classify activity → signal   (rules + OpenRouter)
                                                          ├─ score: decay, caps, buying group → 0-100
                                                          ├─ narrative + per-account reasons (OpenRouter)
                                                          └─ JSON: summary + report.html + 2 CSVs
```

Nothing is stored. Files are processed in memory and the results go straight back to the browser,
so any container instance can serve any request.

## Project layout

| Path | What it is |
|---|---|
| `app/public/index.html` | The frontend (your artifact page, wired to `/api/score`) |
| `app/src/` | API server, parser, column detection, scoring, OpenRouter client, report and CSV builders |
| `app/config/scoring.json` | Signal points, recency half-life, level thresholds, buying-group boost |
| `skill/` | **The intent skill.** Every `.md`/`.txt`/`.json` here becomes the model's system prompt |
| `Dockerfile`, `docker-compose.yml` | Container build and local or VM run, with an optional Cloudflare Tunnel |
| `wrangler.jsonc`, `worker/index.ts` | Cloudflare Containers deployment (a Worker in front of the image) |
| `samples/` | Test exports covering all five sources |

## 1. Add the real skill (important)

`skill/SKILL.md` is a placeholder. Export the skill from claude.ai and replace the folder's contents
(SKILL.md plus any reference files). If the skill defines exact point values or thresholds, mirror them
in `app/config/scoring.json`. Rebuild the image after any change.

## 2. Run locally

```bash
cp .env.example .env          # add OPENROUTER_API_KEY
docker compose up --build     # http://localhost:8080
```

Without a key, the app still works using the built-in classification rules and a templated narrative.

## 3. Deploy to Cloudflare

### Option A: Cloudflare Containers (recommended, fully on Cloudflare)

Requires a Workers Paid plan and Docker running locally (wrangler builds and pushes the image).

```bash
npm install
npx wrangler login
npx wrangler secret put OPENROUTER_API_KEY
# edit wrangler.jsonc → vars.APP_URL (and OPENROUTER_MODEL if you want another model)
npx wrangler deploy
```

The first deploy takes a few minutes to provision before requests succeed. To use a custom domain, add
it under Workers & Pages → intent-calculator → Settings → Domains & Routes.

- **Sizing:** `instance_type: standard-1` (½ vCPU, 4 GiB) handles 25 MB Excel files comfortably.
- **Scaling:** set `vars.CONTAINER_INSTANCES` above 1 to load-balance across instances (keep it at or below `max_instances`).
- **Idle cost:** the container sleeps after 15 idle minutes (`sleepAfter` in `worker/index.ts`), so the first request after that takes a few extra seconds to wake it.
- **Logs:** `npx wrangler tail`

### Option B: any server with Docker + Cloudflare Tunnel

1. Create a tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels) and copy its token.
2. Add a public hostname to the tunnel with service `http://app:8080`.
3. Put `CLOUDFLARE_TUNNEL_TOKEN=...` in `.env`, then run:

```bash
docker compose --profile tunnel up -d --build
```

Cloudflare's proxy times out a response after 100 seconds. A run is normally well under that; if very large
uploads hit the limit, lower `LLM_CLASSIFY_LIMIT` or use Option A.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | (none) | Enables the model. Unset means rules-only mode |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-5.5` | Any OpenRouter model ID, e.g. `anthropic/claude-haiku-5.5` (cheaper) or `google/gemini-3.8-flash` |
| `APP_URL` | (none) | Sent to OpenRouter as `HTTP-Referer` |
| `LLM_TIMEOUT_MS` | `60000` | Per model call |
| `LLM_CLASSIFY_LIMIT` | `400` | Most frequent distinct activity labels sent for classification; the rest use rules |
| `LLM_DISABLED` | (none) | Set to `1` to force rules-only mode |
| `MAX_FILE_MB` / `MAX_TOTAL_MB` / `MAX_FILES` | `25` / `95` / `12` | Upload limits (Cloudflare caps request bodies at 100 MB on Free and Pro plans) |
| `RATE_LIMIT_PER_10MIN` | `20` | Scoring requests per IP |

## How scoring works

1. **Columns.** For each file the API finds the date, email, domain, company and activity columns.
   Day/month order is detected per file, and Excel serial dates and epoch times are handled.
   Free-mail addresses (gmail and similar) count as contacts but never as accounts.
2. **Signals.** Each distinct activity label (page path, form name, email event, CRM type) maps to one
   signal in `scoring.json`. The model classifies the most frequent labels following the skill, and
   built-in rules cover the rest and act as the fallback. Webinar rows with an Attended column are
   decided by that column.
3. **Weights.** If the user fills in "Anything special about your sales process?", the model may adjust
   signal weights by 0.5× to 2×. The report states the adjustment.
4. **Score.** Points halve every 30 days of age, and repeat events are capped per contact. Accounts get a
   buying-group boost of +15% per extra engaged contact, up to 1.6×. The total is mapped onto 0 to 100 with
   `100 × (1 − e^(−points / 60))`. Hot is 70+, Warm 40 to 69, Watch below 40.

**Privacy:** the model sees activity labels, the user's notes and account-level aggregates keyed by
company domain. It never sees contact emails.

## API

- `POST /api/score`: multipart with `meta` (JSON: `company`, `email`, `window`, `asOf`, `notes`, `files[{name, source}]`) and one or more `files`.
  Returns `{ ok, summary, top, headline, warnings, notes, files: { report, accounts, contacts } }`, where each file is `{ name, content }`.
- `GET /api/config`: whether the model is enabled, which model is used, and whether a skill is loaded.
- `GET /healthz`: liveness check.

## Develop without Docker

```bash
cd app && npm install && npm run dev     # reads ../.env, serves on :8080
```
