import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { ALLOWED_EXT, extOf } from "./parse.js";
import { runPipeline } from "./pipeline.js";
import { llmEnabled, loadSkill, MODEL } from "./llm.js";

const PORT = +(process.env.PORT || 8080);
const MAX_FILE_MB = +(process.env.MAX_FILE_MB || 25);
const MAX_TOTAL_MB = +(process.env.MAX_TOTAL_MB || 95);
const MAX_FILES = +(process.env.MAX_FILES || 12);
const RATE_LIMIT = +(process.env.RATE_LIMIT_PER_10MIN || 20);

const app = new Hono();

app.use("*", secureHeaders({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));

// ---------- simple per-IP rate limit for the scoring endpoint ----------
const hits = new Map();
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();
const clientIp = (c) =>
  c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0].trim() || "local";

app.get("/healthz", (c) => c.json({ ok: true }));

app.get("/api/config", (c) =>
  c.json({ llm: llmEnabled(), model: llmEnabled() ? MODEL : null, skillLoaded: loadSkill().length > 0, maxFileMb: MAX_FILE_MB, maxFiles: MAX_FILES })
);

app.post(
  "/api/score",
  bodyLimit({
    maxSize: MAX_TOTAL_MB * 1024 * 1024,
    onError: (c) => c.json({ ok: false, error: `Upload is larger than ${MAX_TOTAL_MB} MB in total. Try a shorter date range or fewer files.` }, 413),
  }),
  async (c) => {
    const ip = clientIp(c);
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    if (n > RATE_LIMIT) return c.json({ ok: false, error: "Too many requests. Please wait a few minutes and try again." }, 429);

    let form;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ ok: false, error: "The upload could not be read. Please try again." }, 400);
    }
    let meta = {};
    try {
      meta = JSON.parse(String(form.meta || "{}"));
    } catch {}
    meta = {
      company: String(meta.company || "").slice(0, 120),
      email: String(meta.email || "").slice(0, 160),
      window: String(meta.window || "Last 90 days"),
      asOf: meta.asOf === "today" ? "today" : "data",
      notes: String(meta.notes || "").slice(0, 2000),
      files: Array.isArray(meta.files) ? meta.files.slice(0, 50) : [],
    };

    const list = [].concat(form.files || []).filter((f) => f && typeof f === "object" && "arrayBuffer" in f);
    if (!list.length) return c.json({ ok: false, error: "No files were received." }, 400);
    if (list.length > MAX_FILES) return c.json({ ok: false, error: `Please upload at most ${MAX_FILES} files at a time.` }, 400);

    const uploads = [];
    for (const f of list) {
      if (!ALLOWED_EXT.includes(extOf(f.name))) return c.json({ ok: false, error: `${f.name}: only CSV, TSV, TXT, XLSX and XLS files are supported.` }, 400);
      if (f.size > MAX_FILE_MB * 1024 * 1024) return c.json({ ok: false, error: `${f.name} is over ${MAX_FILE_MB} MB.` }, 413);
      uploads.push({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) });
    }

    try {
      return c.json(await runPipeline(meta, uploads));
    } catch (e) {
      if (e.status) return c.json({ ok: false, error: e.message, warnings: e.warnings || [] }, e.status);
      console.error(new Date().toISOString(), "score failed:", e);
      return c.json({ ok: false, error: "Something went wrong while scoring. Please try again." }, 500);
    }
  }
);

app.use("/assets/*", serveStatic({ root: "./public", onFound: (_p, c) => c.header("Cache-Control", "public, max-age=86400") }));
app.use("/*", serveStatic({ root: "./public", onFound: (_p, c) => c.header("Cache-Control", "no-cache") }));
app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (i) => {
  const skill = loadSkill();
  console.log(
    `Intent calculator listening on :${i.port} | model: ${llmEnabled() ? MODEL : "disabled (rules only)"} | skill: ${skill ? `${skill.length} chars` : "not found"}`
  );
});

const shutdown = () => process.exit(0);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
