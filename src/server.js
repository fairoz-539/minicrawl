// HTTP API, Firecrawl v1-compatible shapes:
//   POST   /v1/scrape
//   POST   /v1/crawl          GET /v1/crawl/:id   DELETE /v1/crawl/:id   GET /v1/crawl/:id/errors
//   POST   /v1/map
//   POST   /v1/search
//   POST   /v1/extract        GET /v1/extract/:id
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { openDb, Queue, CrawlStore } from "./db.js";
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
import * as api from "./api.js";
import { readFileSync } from "node:fs";

const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function errorStatus(err) {
  if (err instanceof api.NotFoundError) return [404, err.code];
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

function authMiddleware(apiKeys) {
  if (apiKeys.length === 0) return (_req, _res, next) => next();
  const expected = apiKeys.map(k => Buffer.from(`Bearer ${k}`));
  return (req, res, next) => {
    const got = Buffer.from(req.get("authorization") ?? "");
    // Check every key so the response time doesn't reveal which one matched.
    let ok = false;
    for (const e of expected) ok = (e.length === got.length && timingSafeEqual(e, got)) || ok;
    if (ok) return next();
    res.status(401).json({ success: false, code: "UNAUTHORIZED", error: "Unauthorized: invalid or missing API key" });
  };
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

export function createApp(ctx, { apiKeys = configuredApiKeys() } = {}) {
  const app = express();
  app.disable("x-powered-by");
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
      ],
    }),
  );

  // Liveness and capabilities. Public: it never includes secrets.
  app.get("/health", async (_req, res) => {
    let db = true;
    try {
      ctx.db.prepare("SELECT 1").get();
    } catch {
      db = false;
    }
    res.status(db ? 200 : 503).json({
      status: db ? "ok" : "error",
      version: VERSION,
      auth: apiKeys.length > 0,
      db,
      features: await detectFeatures(),
    });
  });

  mountDocs(app);

  const auth = authMiddleware(apiKeys);
  mountMcp(app, ctx, { auth, version: VERSION });

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

  v1.post("/scrape", handle(req => api.scrape(ctx, req.body)));
  v1.post("/crawl", handle(req => api.startCrawl(ctx, req.body, base(req))));
  v1.get(
    "/crawl/:id",
    handle(req =>
      api.crawlStatus(ctx, req.params.id, { skip: Math.max(0, parseInt(req.query.skip ?? "0", 10) || 0), baseUrl: base(req) }),
    ),
  );
  v1.get("/crawl/:id/errors", handle(req => api.crawlErrors(ctx, req.params.id)));
  // The Firecrawl JS SDK's v1 checkCrawlErrors() sends DELETE; it only reads.
  v1.delete("/crawl/:id/errors", handle(req => api.crawlErrors(ctx, req.params.id)));
  v1.delete("/crawl/:id", handle(req => api.cancelCrawl(ctx, req.params.id)));
  v1.post("/map", handle(req => api.map(ctx, req.body)));
  v1.post("/search", handle(req => api.search(ctx, req.body)));
  v1.post("/extract", handle(req => api.startExtract(ctx, req.body)));
  v1.get("/extract/:id", handle(req => api.extractStatus(ctx, req.params.id)));

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
    res.status(status).json({ success: false, code, error: err?.message ?? "Internal error" });
  });

  return app;
}

export function createContext({ dbPath } = {}) {
  const db = openDb(dbPath);
  return { db, queue: new Queue(db), store: new CrawlStore(db), scrapeConfig: {} };
}

export async function start({
  port = Number(process.env.PORT ?? 3002),
  host = process.env.HOST ?? "0.0.0.0",
  workers = Number(process.env.WORKERS ?? 4),
  dbPath,
} = {}) {
  // The Docker image sets REQUIRE_API_KEY=true so a public deployment can't
  // accidentally run open. ALLOW_NO_AUTH=true is the explicit opt-out.
  if (process.env.REQUIRE_API_KEY === "true" && process.env.ALLOW_NO_AUTH !== "true") {
    const keys = configuredApiKeys();
    if (keys.length === 0) {
      throw new StartupError(
        "No API key configured. Run scripts/setup (or set API_KEY / API_KEYS=key1,key2 in .env), " +
          "or set ALLOW_NO_AUTH=true to run without authentication.",
      );
    }
    const weak = keys.filter(isWeakApiKey);
    if (weak.length > 0) {
      throw new StartupError(
        `${weak.length} API key(s) look like a placeholder or are too short (need 16+ characters). ` +
          "Generate your own: run scripts/setup, or `openssl rand -hex 32`.",
      );
    }
  }
  const ctx = createContext({ dbPath });
  const pool = workers > 0 ? startWorkers(ctx, { concurrency: workers }) : null;
  const app = createApp(ctx);
  const server = await new Promise(resolve => {
    const s = app.listen(port, host, () => resolve(s));
  });
  return {
    ctx,
    server,
    port: server.address().port,
    async close() {
      await new Promise(r => server.close(r));
      await pool?.stop();
      await closeBrowser();
      await closeOcr();
      ctx.db.close();
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
  const keys = configuredApiKeys().length;
  console.log(
    `minicrawl ${VERSION} listening on :${instance.port} (${process.env.WORKERS ?? 4} workers, ` +
      `${keys ? `${keys} API key${keys > 1 ? "s" : ""}` : "no auth"}) - docs at /docs`,
  );
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
