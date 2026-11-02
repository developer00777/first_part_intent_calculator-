# First-Party Intent Calculator

Upload website, email, form, webinar and CRM exports. Get a 0 to 100 intent score for every account
(Hot / Warm / Watch), the visual HTML intent report, and CRM-ready account and contact CSV files.

This is a web app around the **first-party-intent-calculator skill** (`skills/first-party-intent-calculator/`).
The skill's own Python scripts do all the scoring, unmodified. An OpenRouter model (default
`anthropic/claude-haiku-5.5`) performs the judgement steps the skill's `SKILL.md` assigns to the operator.

```
browser ─ POST /api/score (meta + files) ─► Node API (Hono)
  Step 2  inspect files, review column mapping ............ runner.py (skill helpers) + model
          normalize to the standard events file ........... normalize_inputs.py logic
          signal column for unclassified activities ....... model (keys limited to the skill's config)
  Step 3  scoring settings from the user's notes .......... model, using the skill's tuning guide
  Step 4  score ........................................... score_intent.py (unmodified)
          sanity check on level counts .................... model (may rescore once with new saturation)
  Step 5  report .......................................... build_report.py (unmodified)
  Step 6  summary, added to the report as one card ........ model
  ◄─ JSON: summary + intent_report.html + intent_scores_accounts.csv + intent_scores_contacts.csv
```

Nothing is stored. Each request works in a temporary folder that is deleted afterwards, so any
container instance can serve any request. Contact emails are never sent to the model: it sees column
names, masked sample rows (`***@domain`), activity labels, the user's notes and account-level results.

Without an API key, or if a model call fails, every step falls back to the skill's defaults and the run still completes.

## Project layout

| Path | What it is |
|---|---|
| `skills/first-party-intent-calculator/` | **The skill** (SKILL.md, references, default config, scripts). Edit it here; the app picks up changes on rebuild |
| `.claude-plugin/plugin.json` | Plugin manifest for the skill |
| `app/public/index.html` | The frontend (the artifact page, wired to `/api/score`) |
| `app/src/server.js` | HTTP server, upload limits, rate limit |
| `app/src/pipeline.js` | Runs the skill workflow for one upload |
| `app/src/llm.js` | OpenRouter client and the model's workflow steps (strict JSON schemas) |
| `app/py/runner.py` | Calls the skill's scripts; adds only the fixes SKILL.md sanctions (column choice, day-first dates, `signal` column) |
| `Dockerfile`, `docker-compose.yml` | Python + Node image; local or VM run with an optional Cloudflare Tunnel |
| `wrangler.jsonc`, `worker/index.ts` | Cloudflare Containers deployment (a Worker in front of the image) |
| `samples/` | Test exports covering all five sources |

## Run locally

```bash
cp .env.example .env          # add OPENROUTER_API_KEY
docker compose up --build     # http://localhost:8080
```

## Deploy to Cloudflare

### Option A: Cloudflare Containers (fully on Cloudflare)

Requires a Workers Paid plan and Docker running locally (wrangler builds and pushes the image).

```bash
npm install
npx wrangler login
npx wrangler secret put OPENROUTER_API_KEY
# edit wrangler.jsonc → vars.APP_URL (and OPENROUTER_MODEL to use another model)
npx wrangler deploy
```

The first deploy takes a few minutes to provision before requests succeed. To use a custom domain, add it
under Workers & Pages → intent-calculator → Settings → Domains & Routes.

- **Sizing:** `instance_type: standard-1` (½ vCPU, 4 GiB) handles 25 MB Excel files with pandas comfortably.
- **Scaling:** set `vars.CONTAINER_INSTANCES` above 1 to load-balance across instances (keep it at or below `max_instances`).
- **Idle cost:** the container sleeps after 15 idle minutes, so the next request takes a few extra seconds to wake it.
- **Logs:** `npx wrangler tail`

### Option B: any server with Docker + Cloudflare Tunnel

1. Create a tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels) and copy its token.
2. Add a public hostname to the tunnel with service `http://app:8080`.
3. Put `CLOUDFLARE_TUNNEL_TOKEN=...` in `.env`, then run `docker compose --profile tunnel up -d --build`.

## Model and cost

Default model: `anthropic/claude-haiku-5.5` ($0.10 per million input tokens, $0.50 per million output tokens).
On the bundled samples a run makes 3 to 5 calls, costs about **$0.003 to $0.007**, and takes 15 to 25 seconds.
Every call uses OpenRouter structured outputs (strict JSON schema). If you switch to a model without
structured outputs, the app falls back to JSON mode automatically.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | (none) | Enables the model. Unset means the skill's defaults only |
| `OPENROUTER_MODEL` | `anthropic/claude-haiku-5.5` | Any OpenRouter model ID |
| `APP_URL` | (none) | Sent to OpenRouter as `HTTP-Referer` |
| `LLM_TIMEOUT_MS` | `60000` | Per model call |
| `LLM_CLASSIFY_LIMIT` | `300` | Max distinct unclassified activities sent for review per run |
| `LLM_DISABLED` | (none) | Set to `1` to force skill defaults only |
| `LLM_DEBUG` | (none) | Set to `1` to log details of unparseable model replies |
| `MAX_FILE_MB` / `MAX_TOTAL_MB` / `MAX_FILES` | `25` / `95` / `12` | Upload limits (Cloudflare caps request bodies at 100 MB on Free and Pro plans) |
| `RATE_LIMIT_PER_10MIN` | `20` | Scoring requests per IP |

Scoring settings (signal points, recency, buying group boost, saturation, levels) live in the skill's
`assets/default_config.json`. See `references/scoring-model.md` for how they work.

## API

- `POST /api/score`: multipart with `meta` (JSON: `company`, `email`, `window`, `asOf` = `data` or `today`, `notes`, `files[{name, source}]`) and one or more `files`.
  Returns `{ ok, summary, headline, summaryText, topHot, nextStep, top, warnings, notes, usage, files: { report, accounts, contacts } }`.
- `GET /api/config`: whether the model is enabled, which model, and whether the skill was found.
- `GET /healthz`: liveness check.

## Develop without Docker

Needs Node 20+ and Python 3.10+ with `pip install -r app/py/requirements.txt`.

```bash
cd app && npm install && npm run dev     # reads ../.env, serves on :8080
```
