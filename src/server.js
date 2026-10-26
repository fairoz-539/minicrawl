// HTTP API, Firecrawl v1-compatible shapes:
//   POST   /v1/scrape
//   POST   /v1/crawl          GET /v1/crawl/:id   DELETE /v1/crawl/:id   GET /v1/crawl/:id/errors
//   POST   /v1/map
//   POST   /v1/search
//   POST   /v1/extract        GET /v1/extract/:id
//   POST   /v1/batch/scrape   GET /v1/batch/scrape/:id   DELETE /v1/batch/scrape/:id   GET /v1/batch/scrape/:id/errors
//   /v2/*        Firecrawl v2 API (src/v2.js)
//   /admin/v1/*  teams, API keys, usage, audit log (src/admin.js)
import express from "express";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { openStorage } from "./storage.js";
import { startWorkers } from "./worker.js";
import { ActionError, closeBrowser, FatalScrapeError, ScrapeTimeoutError, SiteBlockedError } from "./engines.js";
import { LLMError } from "./llm.js";
import { SearchBlockedError } from "./search.js";
import { UnsupportedFileError } from "./documents.js";
import { closeOcr, ocrAvailable } from "./ocr.js";
import { BlockedUrlError } from "./url-guard.js";
import { hasBrowser } from "./browser.js";
import { proxyPoolSizes } from "./proxy.js";
import { mountDocs } from "./openapi.js";
import { mountMcp } from "./mcp.js";
import { mountAdmin } from "./admin.js";
import { mountV2 } from "./v2.js";
import { TenancyError, activeKeyCount, tenantAuth } from "./tenancy.js";
import * as api from "./api.js";
import { readFileSync } from "node:fs";

const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function errorStatus(err) {
  if (err instanceof TenancyError) return [err.status, err.code];
  if (err instanceof api.NotFoundError) return [404, err.code];
  if (err instanceof api.BadRequestError) return [400, err.code];
  if (err instanceof LLMError) return [err.status, err.code];
  if (err instanceof ActionError) return [422, err.code];
  if (err instanceof SearchBlockedError) return [503, err.code];
  if (err instanceof BlockedUrlError) return [403, "BLOCKED_URL"];
  if (err instanceof SiteBlockedError) return [403, "BLOCKED_BY_SITE"];
  if (err instanceof ScrapeTimeoutError) return [408, "SCRAPE_TIMEOUT"];
  if (err instanceof FatalScrapeError || err instanceof UnsupportedFileError) return [422, err.code];
  return [500, "SCRAPE_FAILED"];
}

/** API keys from API_KEYS (comma-separated) and API_KEY. */
export function configuredApiKeys(env = process.env) {
  return [...new Set([...(env.API_KEYS ?? "").split(","), env.API_KEY ?? ""].map(k => k.trim()).filter(Boolean))];
}

// Values from the docs/examples, and other keys nobody should deploy with.
const PLACEHOLDER_KEY = /^(your[-_]?(api[-_]?)?key|changeme|change[-_]me|secret|password|apikey|api[-_]key|test|example|key\d*|key-for-\w+)$/i;

/** Too short, a placeholder, or one repeated character. */
export function isWeakApiKey(key) {
  return (
    key.length < 16 ||
    PLACEHOLDER_KEY.test(key) ||
    /^(.)\1+$/.test(key) ||
    // Example values pasted from the docs, e.g. "3f9c2a…your-key…".
    /your[-_]?(api[-_]?)?key|…|\.\.\./i.test(key)
  );
}

let featureCache = null;
async function detectFeatures() {
  featureCache ??= {
    browser: process.env.PLAYWRIGHT_MICROSERVICE_URL ? "remote" : await hasBrowser(),
    ocr: await ocrAvailable(),
  };
  return {
    ...featureCache,
    ai: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    search: process.env.SEARXNG_ENDPOINT ? "searxng" : "duckduckgo",
    proxies: proxyPoolSizes(),
  };
}

export function createApp(ctx, { apiKeys = configuredApiKeys(), mode = "all" } = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy, set TRUST_PROXY (e.g. "1" or "loopback") so
  // req.ip is the client's address: IP allowlists and the audit log use it.
  if (process.env.TRUST_PROXY) {
    const t = process.env.TRUST_PROXY;
    app.set("trust proxy", /^\d+$/.test(t) ? Number(t) : t === "true" ? true : t);
  }
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (req, res) =>
    res.json({
      name: "minicrawl",
      version: VERSION,
      docs: `${req.protocol}://${req.get("host")}/docs`,
      endpoints: [
        "GET /health", "GET /docs", "GET /openapi.json",
        "POST /v1/scrape", "POST /v1/crawl", "GET /v1/crawl/{id}", "GET /v1/crawl/{id}/errors", "DELETE /v1/crawl/{id}",
        "POST /v1/map", "POST /v1/search", "POST /v1/extract", "GET /v1/extract/{id}", "POST /mcp",
        "POST /v1/batch/scrape", "GET /v1/batch/scrape/{id}", "GET /v1/batch/scrape/{id}/errors", "DELETE /v1/batch/scrape/{id}",
        "/v2/{scrape,batch/scrape,crawl,map,search,extract,team/*,concurrency-check}",
        "/admin/v1/{me,org,teams,keys,usage,audit}",
      ],
    }),
  );

  app.get("/health", healthHandler(ctx, { envKeys: apiKeys, mode }));

  mountDocs(app);

  const auth = tenantAuth(ctx, { envKeys: apiKeys });
  mountMcp(app, ctx, { auth, version: VERSION });
  mountAdmin(app, ctx, { auth: tenantAuth(ctx, { envKeys: apiKeys, meterRequests: false }) });
  mountV2(app, ctx, { auth });

  const v1 = express.Router();
  v1.use(auth);

  // Thin wrappers over src/api.js (shared with the MCP tools in src/mcp.js).
  const base = req => `${req.protocol}://${req.get("host")}`;
  const handle = fn => async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      next(err);
    }
  };

  v1.post("/scrape", handle(req => api.scrape(ctx, req.body, req.tenant)));
  v1.post("/crawl", handle(req => api.startCrawl(ctx, req.body, base(req), req.tenant)));
  v1.get(
    "/crawl/:id",
    handle(req =>
      api.crawlStatus(
        ctx,
        req.params.id,
        { skip: Math.max(0, parseInt(req.query.skip ?? "0", 10) || 0), baseUrl: base(req) },
        req.tenant,
      ),
    ),
  );
  v1.get("/crawl/:id/errors", handle(req => api.crawlErrors(ctx, req.params.id, req.tenant)));
  // The Firecrawl JS SDK's v1 checkCrawlErrors() sends DELETE; it only reads.
  v1.delete("/crawl/:id/errors", handle(req => api.crawlErrors(ctx, req.params.id, req.tenant)));
  v1.delete(
    "/crawl/:id",
    handle(async req => {
      const { wasRunning: _w, ...out } = await api.cancelCrawl(ctx, req.params.id, req.tenant);
      return out;
    }),
  );
  v1.post("/batch/scrape", handle(req => api.startBatch(ctx, req.body, base(req), req.tenant)));
  v1.get(
    "/batch/scrape/:id",
    handle(req =>
      api.crawlStatus(
        ctx,
        req.params.id,
        { skip: Math.max(0, parseInt(req.query.skip ?? "0", 10) || 0), baseUrl: base(req), kind: "batch" },
        req.tenant,
      ),
    ),
  );
  v1.get("/batch/scrape/:id/errors", handle(req => api.crawlErrors(ctx, req.params.id, req.tenant, { kind: "batch" })));
  v1.delete(
    "/batch/scrape/:id",
    handle(async req => {
      const { wasRunning: _w, ...out } = await api.cancelCrawl(ctx, req.params.id, req.tenant, { kind: "batch" });
      return out;
    }),
  );
  v1.post("/map", handle(req => api.map(ctx, req.body, req.tenant)));
  v1.post("/search", handle(req => api.search(ctx, req.body, req.tenant)));
  v1.post("/extract", handle(req => api.startExtract(ctx, req.body, req.tenant)));
  v1.get("/extract/:id", handle(req => api.extractStatus(ctx, req.params.id, req.tenant)));

  app.use("/v1", v1);
  app.use((_req, res) => res.status(404).json({ success: false, error: "Not found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      const unknownKey = err.issues.some(i => i.code === "unrecognized_keys");
      return res.status(400).json({
        success: false,
        code: "BAD_REQUEST",
        error: unknownKey ? "Unrecognized key in body" : err.issues[0]?.message ?? "Bad Request",
        details: err.issues,
      });
    }
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ success: false, code: "BAD_REQUEST", error: "Invalid JSON body" });
    }
    const [status, code] = errorStatus(err);
    for (const [k, v] of Object.entries(err?.headers ?? {})) res.set(k, v);
    res.status(status).json({ success: false, code, error: err?.message ?? "Internal error" });
  });

  return app;
}

/** Liveness and capabilities. Public: it never includes secrets. */
function healthHandler(ctx, { envKeys = [], mode = "all" }) {
  return async (_req, res) => {
    let db = true;
    let auth = envKeys.length > 0;
    try {
      await ctx.storage.ping();
      auth ||= mode !== "worker" && (await activeKeyCount(ctx)) > 0;
    } catch {
      db = false;
    }
    res.status(db ? 200 : 503).json({
      status: db ? "ok" : "error",
      version: VERSION,
      mode,
      storage: ctx.storage.kind,
      auth,
      db,
      features: await detectFeatures(),
    });
  };
}

export async function createContext({ dbPath } = {}) {
  const storage = await openStorage({ dbPath });
  await storage.tenancy.ensureDefaults();
  return { storage, queue: storage.queue, store: storage.store, scrapeConfig: {} };
}

const MODES = ["all", "api", "worker"];

export async function start({
  port = Number(process.env.PORT ?? 3002),
  host = process.env.HOST ?? "0.0.0.0",
  workers = Number(process.env.WORKERS ?? 4),
  // all: API + workers in one process (default). In scale mode run them
  // separately: api processes serve HTTP, worker processes run the jobs.
  mode = (process.env.MODE ?? "all").toLowerCase(),
  dbPath,
} = {}) {
  if (!MODES.includes(mode)) throw new StartupError(`Unknown MODE "${mode}": use all, api or worker`);
  const keys = configuredApiKeys();
  const weak = keys.filter(isWeakApiKey);
  if (mode !== "worker" && process.env.REQUIRE_API_KEY === "true" && process.env.ALLOW_NO_AUTH !== "true" && weak.length > 0) {
    throw new StartupError(
      `${weak.length} API key(s) look like a placeholder or are too short (need 16+ characters). ` +
        "Generate your own: run scripts/setup, or `openssl rand -hex 32`.",
    );
  }
  const ctx = await createContext({ dbPath });
  // The Docker image sets REQUIRE_API_KEY=true so a public deployment can't
  // accidentally run open: it needs a key in .env or one created with the
  // admin CLI. ALLOW_NO_AUTH=true is the explicit opt-out.
  if (
    mode !== "worker" &&
    process.env.REQUIRE_API_KEY === "true" &&
    process.env.ALLOW_NO_AUTH !== "true" &&
    keys.length === 0 &&
    (await ctx.storage.tenancy.countActiveKeys()) === 0
  ) {
    await ctx.storage.close();
    throw new StartupError(
      "No API key configured. Run scripts/setup (or set API_KEY / API_KEYS=key1,key2 in .env), " +
        "create one with the admin CLI (node src/admin-cli.js keys create --name admin --role owner), " +
        "or set ALLOW_NO_AUTH=true to run without authentication.",
    );
  }
  const pool =
    mode !== "api" && workers > 0
      ? startWorkers(ctx, {
          concurrency: workers,
          // A job whose worker stops heartbeating this long is handed to another worker.
          staleLockMs: Number(process.env.JOB_LOCK_TIMEOUT_MS ?? 60_000),
        })
      : null;
  // A worker-only process still answers /health, for container orchestrators.
  let app;
  if (mode === "worker") {
    app = express();
    app.disable("x-powered-by");
    app.get("/health", healthHandler(ctx, { mode }));
  } else {
    app = createApp(ctx, { mode });
  }
  const server = await new Promise(resolve => {
    const s = app.listen(port, host, () => resolve(s));
  });
  return {
    ctx,
    mode,
    server,
    port: server.address().port,
    async close() {
      await new Promise(r => server.close(r));
      await pool?.stop();
      await closeBrowser();
      await closeOcr();
      await ctx.storage.close();
    },
  };
}

export class StartupError extends Error {}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let instance;
  try {
    instance = await start();
  } catch (err) {
    if (!(err instanceof StartupError)) throw err;
    console.error(`minicrawl: ${err.message}`);
    process.exit(1);
  }
  const keys = configuredApiKeys().length + (await instance.ctx.storage.tenancy.countActiveKeys());
  console.log(
    instance.mode === "worker"
      ? `minicrawl ${VERSION} worker (${process.env.WORKERS ?? 4} workers, ${instance.ctx.storage.kind}) - health on :${instance.port}/health`
      : `minicrawl ${VERSION} ${instance.mode === "api" ? "API" : "listening"} on :${instance.port} ` +
          `(${instance.mode === "api" ? "no workers" : `${process.env.WORKERS ?? 4} workers`}, ${instance.ctx.storage.kind}, ` +
          `${keys ? `${keys} API key${keys > 1 ? "s" : ""}` : "no auth"}) - docs at /docs`,
  );
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
