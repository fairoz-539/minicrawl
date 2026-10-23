// HTTP API, Firecrawl v1-compatible shapes:
//   POST   /v1/scrape
//   POST   /v1/crawl          GET /v1/crawl/:id   DELETE /v1/crawl/:id   GET /v1/crawl/:id/errors
//   POST   /v1/map
//   POST   /v1/search
//   POST   /v1/extract        GET /v1/extract/:id
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { openDb, Queue, CrawlStore } from "./db.js";
import { scrapeURL, DEFAULT_SCRAPE_OPTIONS } from "./scrape.js";
import { getMapResults } from "./map.js";
import { startWorkers } from "./worker.js";
import { sendWebhook } from "./webhook.js";
import { ActionError, closeBrowser, FatalScrapeError, ScrapeTimeoutError, SiteBlockedError } from "./engines.js";
import { LLMError } from "./llm.js";
import { SearchBlockedError, webSearch } from "./search.js";
import { mapLimit } from "./util.js";
import { UnsupportedFileError } from "./documents.js";
import { closeOcr, ocrAvailable } from "./ocr.js";
import { BlockedUrlError } from "./url-guard.js";
import { crawlBody, extractBody, mapBody, scrapeBody, searchBody } from "./schemas.js";
import { hasBrowser } from "./browser.js";
import { proxyPoolSizes } from "./proxy.js";
import { mountDocs } from "./openapi.js";
import { readFileSync } from "node:fs";

const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const CRAWL_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

function errorStatus(err) {
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
        "POST /v1/map", "POST /v1/search", "POST /v1/extract", "GET /v1/extract/{id}",
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

  const v1 = express.Router();
  v1.use(authMiddleware(apiKeys));

  v1.post("/scrape", async (req, res, next) => {
    try {
      const { url, origin: _o, integration: _i, ...opts } = scrapeBody.parse(req.body);
      const { doc } = await scrapeURL(url, opts, ctx.scrapeConfig);
      ctx.store.recordSeen(doc.metadata.url, doc.metadata.title ?? null);
      res.json({ success: true, data: doc });
    } catch (err) {
      next(err);
    }
  });

  v1.post("/crawl", (req, res, next) => {
    try {
      const { url, scrapeOptions: so, webhook: hook, origin: _o, integration: _i, ...crawlerOptions } = crawlBody.parse(req.body);
      const id = randomUUID();
      const sc = { url, crawlerOptions, scrapeOptions: { ...DEFAULT_SCRAPE_OPTIONS, ...so }, webhook: hook };
      ctx.store.create(id, sc);
      ctx.queue.add({ type: "kickoff", groupId: id, priority: 5, data: { crawlId: id } });
      sendWebhook(hook, "crawl.started", id, []);
      res.json({ success: true, id, url: `${req.protocol}://${req.get("host")}/v1/crawl/${id}` });
    } catch (err) {
      next(err);
    }
  });

  v1.get("/crawl/:id", (req, res) => {
    const crawl = ctx.store.get(req.params.id);
    if (!crawl) return res.status(404).json({ success: false, error: "Crawl not found" });
    const skip = Math.max(0, parseInt(req.query.skip ?? "0", 10) || 0);
    const counts = ctx.queue.groupCounts(crawl.id);
    const data = ctx.queue.groupDocuments(crawl.id, skip, PAGE_SIZE);
    const total = counts.queued + counts.active + counts.completed + counts.failed;
    const more = data.length === PAGE_SIZE;
    res.json({
      success: true,
      status: crawl.status,
      total,
      completed: counts.completed,
      creditsUsed: counts.completed,
      expiresAt: new Date(crawl.created_at + CRAWL_TTL_MS).toISOString(),
      // Omitted (not null) on the last page: the Firecrawl SDKs keep paging
      // while the key exists.
      ...(more ? { next: `${req.protocol}://${req.get("host")}/v1/crawl/${crawl.id}?skip=${skip + PAGE_SIZE}` } : {}),
      data,
    });
  });

  const crawlErrors = (req, res) => {
    const crawl = ctx.store.get(req.params.id);
    if (!crawl) return res.status(404).json({ success: false, error: "Crawl not found" });
    res.json({ errors: ctx.queue.groupErrors(crawl.id), robotsBlocked: ctx.store.robotsBlocked(crawl.id) });
  };
  v1.get("/crawl/:id/errors", crawlErrors);
  // The Firecrawl JS SDK's v1 checkCrawlErrors() sends DELETE; it only reads.
  v1.delete("/crawl/:id/errors", crawlErrors);

  v1.delete("/crawl/:id", (req, res) => {
    const crawl = ctx.store.get(req.params.id);
    if (!crawl) return res.status(404).json({ success: false, error: "Crawl not found" });
    if (ctx.store.setStatus(crawl.id, "cancelled")) ctx.queue.dropQueued(crawl.id);
    res.json({ success: true, status: "cancelled" });
  });

  v1.post("/map", async (req, res, next) => {
    try {
      const { url, origin: _o, integration: _i, ...opts } = mapBody.parse(req.body);
      const links = await getMapResults(ctx.store, url, opts);
      res.json({ success: true, links });
    } catch (err) {
      next(err);
    }
  });

  v1.post("/search", async (req, res, next) => {
    try {
      const { query, scrapeOptions: so, origin: _o, integration: _i, ...opts } = searchBody.parse(req.body);
      const results = await webSearch(query, opts);
      if (!so) return res.json({ success: true, data: results });
      // Scrape every result, as Firecrawl does when scrapeOptions is given.
      const data = await mapLimit(results, 4, async r => {
        try {
          const { doc } = await scrapeURL(r.url, so, ctx.scrapeConfig);
          ctx.store.recordSeen(doc.metadata.url, doc.metadata.title ?? null);
          return { ...r, ...doc };
        } catch (err) {
          return { ...r, metadata: { sourceURL: r.url, error: err.message } };
        }
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  });

  v1.post("/extract", (req, res, next) => {
    try {
      const { origin: _o, integration: _i, ...body } = extractBody.parse(req.body);
      const id = ctx.queue.add({ type: "extract", priority: 10, data: body });
      res.json({ success: true, id, urlTrace: [] });
    } catch (err) {
      next(err);
    }
  });

  v1.get("/extract/:id", (req, res) => {
    const job = ctx.queue.get(req.params.id);
    if (!job || job.type !== "extract") return res.status(404).json({ success: false, error: "Extract job not found" });
    const status = { queued: "processing", active: "processing", completed: "completed", failed: "failed" }[job.status];
    const r = job.result ?? {};
    res.json({
      success: job.status !== "failed",
      status,
      data: r.data ?? null,
      ...(job.data.showSources ? { sources: r.sources ?? [] } : {}),
      ...(r.warnings?.length ? { warning: r.warnings.join(" ") } : {}),
      ...(r.failed?.length ? { failedUrls: r.failed } : {}),
      ...(job.error ? { error: job.error } : {}),
      expiresAt: new Date(Math.floor(job.created_at / 1000) + CRAWL_TTL_MS).toISOString(),
    });
  });

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
