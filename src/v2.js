// Firecrawl v2 API (/v2/*): a translation layer over src/api.js.
//
// v2 request bodies are validated here, translated to the internal (v1-shaped)
// options, run through the same operations as /v1 and MCP (so roles, quotas,
// metering and team isolation all apply), and answered in v2's shapes. The
// target is wire compatibility with the official SDKs' default v2 clients
// (@mendable/firecrawl-js `Firecrawl`, firecrawl-py `Firecrawl`); see
// test/sdk.test.js and test/contract-py.
//
// Supported formats: markdown, html, rawHtml, links, images, summary, json,
// screenshot, attributes. Others (changeTracking, branding, question, …) are
// refused with a clear 400 rather than silently ignored.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as api from "./api.js";
import { action, webhook } from "./schemas.js";
import { SYSTEM_TENANT } from "./tenancy.js";

const clientMeta = {
  origin: z.string().max(200).optional(),
  integration: z.string().max(200).nullable().optional(),
};

// --- Formats ----------------------------------------------------------------

const SIMPLE_FORMATS = ["markdown", "html", "rawHtml", "links", "images", "summary"];
const UNSUPPORTED_FORMATS = [
  "changeTracking",
  "branding",
  "product",
  "menu",
  "question",
  "highlights",
  "query",
  "audio",
  "video",
  "rawBase64",
  "deterministicJson",
];

const formatSchemas = {
  json: z
    .object({
      type: z.literal("json"),
      schema: z.record(z.string(), z.any()).optional(),
      prompt: z.string().max(10_000).optional(),
      model: z.string().optional().describe("Ignored: the server's LLM_MODEL is used"),
    })
    .strict(),
  screenshot: z
    .object({
      type: z.literal("screenshot"),
      fullPage: z.boolean().optional(),
      quality: z.number().optional().describe("Ignored"),
      viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ignored"),
    })
    .strict(),
  attributes: z
    .object({
      type: z.literal("attributes"),
      selectors: z.array(z.object({ selector: z.string().min(1), attribute: z.string().min(1) }).strict()).min(1).max(50),
    })
    .strict(),
};

/** "markdown" or {type: "markdown"}, with per-type validation. */
export const formatsV2 = z
  .preprocess(
    v => (Array.isArray(v) ? v.map(f => (typeof f === "string" ? { type: f } : f)) : v),
    z.array(z.object({ type: z.string() }).passthrough()),
  )
  .superRefine((formats, ctx) => {
    formats.forEach((f, i) => {
      if (UNSUPPORTED_FORMATS.includes(f.type)) {
        ctx.addIssue({ code: "custom", path: [i], message: `The ${f.type} format is not supported by minicrawl` });
      } else if (SIMPLE_FORMATS.includes(f.type)) {
        if (Object.keys(f).length > 1) ctx.addIssue({ code: "custom", path: [i], message: `The ${f.type} format takes no options` });
      } else if (formatSchemas[f.type]) {
        const r = formatSchemas[f.type].safeParse(f);
        if (!r.success) for (const issue of r.error.issues) ctx.addIssue({ ...issue, path: [i, ...issue.path] });
      } else {
        ctx.addIssue({ code: "custom", path: [i], message: `Unknown format "${f.type}"` });
      }
    });
    if (formats.filter(f => f.type === "screenshot").length > 1) {
      ctx.addIssue({ code: "custom", message: "You may only specify one screenshot format" });
    }
  })
  .describe('Strings ("markdown") or objects ({"type": "json", "schema": …}): markdown, html, rawHtml, links, images, summary, json, screenshot, attributes');

// --- Scrape options -----------------------------------------------------------

export const scrapeOptionsV2 = z
  .object({
    formats: formatsV2.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    includeTags: z.array(z.string()).optional(),
    excludeTags: z.array(z.string()).optional(),
    onlyMainContent: z.boolean().optional(),
    timeout: z.number().int().min(1000).optional(),
    waitFor: z.number().int().min(0).max(60_000).optional(),
    actions: z.array(action).max(50).optional(),
    proxy: z.enum(["basic", "stealth", "enhanced", "auto"]).optional().describe("enhanced is treated as stealth"),
    skipTlsVerification: z.boolean().optional(),
    location: z
      .object({ country: z.string().optional(), languages: z.array(z.string()).optional() })
      .strict()
      .optional()
      .describe("languages sets Accept-Language; country is ignored (no geo proxies)"),
    // Accepted for compatibility, no effect:
    onlyCleanContent: z.boolean().optional(),
    mobile: z.boolean().optional(),
    parsers: z.array(z.any()).optional(),
    removeBase64Images: z.boolean().optional(),
    fastMode: z.boolean().optional(),
    blockAds: z.boolean().optional(),
    minAge: z.number().int().min(0).optional(),
    // Page cache:
    maxAge: z.number().int().min(0).optional().describe("Use a cached copy younger than this (ms)"),
    storeInCache: z.boolean().optional(),
  })
  .strict();

/** v2 scrape options -> internal (v1-shaped) scrape options. */
export function toScrapeOptions(o = {}) {
  const formats = o.formats ?? [{ type: "markdown" }];
  const out = { formats: [] };
  for (const f of formats) {
    if (f.type === "screenshot") out.formats.push(f.fullPage ? "screenshot@fullPage" : "screenshot");
    else if (f.type === "json") {
      out.formats.push("json");
      out.jsonOptions = { ...(f.schema ? { schema: f.schema } : {}), ...(f.prompt ? { prompt: f.prompt } : {}) };
    } else if (f.type === "attributes") {
      out.formats.push("attributes");
      out.attributes = f.selectors;
    } else out.formats.push(f.type);
  }
  const headers = { ...o.headers };
  if (o.location?.languages?.length && !Object.keys(headers).some(h => h.toLowerCase() === "accept-language")) {
    headers["Accept-Language"] = o.location.languages.join(",");
  }
  if (Object.keys(headers).length) out.headers = headers;
  for (const k of ["includeTags", "excludeTags", "onlyMainContent", "waitFor", "actions", "skipTlsVerification", "maxAge", "storeInCache"]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  if (o.timeout !== undefined) out.timeout = Math.min(o.timeout, 300_000);
  if (o.proxy) out.proxy = o.proxy === "enhanced" ? "stealth" : o.proxy;
  return out;
}

// --- Request bodies -------------------------------------------------------------

export const scrapeBodyV2 = scrapeOptionsV2.extend({ url: z.string(), zeroDataRetention: z.boolean().optional(), ...clientMeta }).strict();

export const batchBodyV2 = scrapeOptionsV2
  .extend({
    urls: z.array(z.string()).min(1).max(10_000),
    webhook: webhook.optional(),
    appendToId: z.uuid().optional(),
    ignoreInvalidURLs: z.boolean().default(true),
    maxConcurrency: z.number().int().positive().optional().describe("Ignored: the team's concurrency limit applies"),
    zeroDataRetention: z.boolean().optional(),
    ...clientMeta,
  })
  .strict();

export const crawlBodyV2 = z
  .object({
    url: z.string(),
    limit: z.number().int().min(1).default(10_000),
    includePaths: z.array(z.string()).optional(),
    excludePaths: z.array(z.string()).optional(),
    maxDiscoveryDepth: z.number().int().min(0).optional(),
    crawlEntireDomain: z.boolean().optional(),
    allowExternalLinks: z.boolean().optional(),
    allowSubdomains: z.boolean().optional(),
    ignoreRobotsTxt: z.boolean().optional(),
    sitemap: z.enum(["skip", "include", "only"]).default("include"),
    deduplicateSimilarURLs: z.boolean().optional(),
    ignoreQueryParameters: z.boolean().optional(),
    regexOnFullURL: z.boolean().optional(),
    delay: z.number().positive().max(60).optional().describe("Seconds between pages"),
    scrapeOptions: scrapeOptionsV2.optional(),
    webhook: webhook.optional(),
    zeroDataRetention: z.boolean().optional(),
    prompt: z.string().optional().describe("Not supported: set the crawl options directly"),
    robotsUserAgent: z.string().optional().describe("Ignored"),
    maxConcurrency: z.number().int().positive().optional().describe("Ignored: the team's concurrency limit applies"),
    ...clientMeta,
  })
  .strict()
  .refine(b => !b.prompt, { message: "Prompt-generated crawl options are not supported by minicrawl; set includePaths, limit, etc. directly", path: ["prompt"] });

export const mapBodyV2 = z
  .object({
    url: z.string(),
    search: z.string().optional(),
    sitemap: z.enum(["skip", "include", "only"]).default("include"),
    includeSubdomains: z.boolean().optional(),
    limit: z.number().int().min(1).max(100_000).optional(),
    timeout: z.number().positive().optional(),
    // Accepted for compatibility, no effect:
    ignoreQueryParameters: z.boolean().optional(),
    filterByPath: z.boolean().optional(),
    useIndex: z.boolean().optional(),
    ignoreCache: z.boolean().optional(),
    location: z.any().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    ...clientMeta,
  })
  .strict();

const SOURCES = ["web", "news", "images"];
// Category filters, applied as search operators.
const CATEGORY_QUERY = { github: "site:github.com", research: "(site:arxiv.org OR site:researchgate.net OR site:semanticscholar.org)", pdf: "filetype:pdf" };
const typeOf = v => (typeof v === "string" ? v : v?.type);
const domainList = z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+$/, "Domain must be a hostname without protocol or path"));

export const searchBodyV2 = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(100).default(10),
    sources: z
      .array(z.union([z.string(), z.object({ type: z.string() }).passthrough()]))
      .default(["web"])
      .refine(list => list.every(s => SOURCES.includes(typeOf(s))), "Supported sources: web, news, images"),
    categories: z
      .array(z.union([z.string(), z.object({ type: z.string() }).strict()]))
      .optional()
      .refine(list => !list || list.every(c => CATEGORY_QUERY[typeOf(c)]), "Supported categories: github, research, pdf"),
    includeDomains: domainList.optional(),
    excludeDomains: domainList.optional(),
    tbs: z.string().optional(),
    lang: z.string().default("en"),
    country: z.string().default("us"),
    timeout: z.number().int().positive().default(60_000),
    scrapeOptions: scrapeOptionsV2.optional(),
    // Accepted for compatibility, no effect:
    filter: z.string().optional(),
    location: z.string().optional(),
    ignoreInvalidURLs: z.boolean().optional(),
    asyncScraping: z.boolean().optional(),
    safe: z.boolean().optional(),
    highlights: z.boolean().optional(),
    toolDetail: z.string().optional(),
    domainTools: z.boolean().optional(),
    zeroDataRetention: z.boolean().optional(),
    ...clientMeta,
  })
  .strict()
  .refine(b => !(b.includeDomains?.length && b.excludeDomains?.length), "includeDomains and excludeDomains cannot both be specified");

export const extractBodyV2 = z
  .object({
    urls: z.array(z.string()).max(10).optional(),
    prompt: z.string().max(10_000).optional(),
    systemPrompt: z.string().max(10_000).optional(),
    schema: z.record(z.string(), z.any()).optional(),
    enableWebSearch: z.boolean().optional(),
    showSources: z.boolean().optional(),
    scrapeOptions: scrapeOptionsV2.optional(),
    // Accepted for compatibility, no effect:
    limit: z.number().optional(),
    ignoreSitemap: z.boolean().optional(),
    includeSubdomains: z.boolean().optional(),
    allowExternalLinks: z.boolean().optional(),
    urlTrace: z.boolean().optional(),
    timeout: z.number().optional(),
    ignoreInvalidURLs: z.boolean().optional(),
    ...clientMeta,
  })
  .strict();

// --- Team endpoints -------------------------------------------------------------

// What "unlimited" looks like to SDKs that expect a number of remaining credits.
const UNLIMITED = Number.MAX_SAFE_INTEGER;

function monthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { start, end, startDay: start.toISOString().slice(0, 10) };
}

/** Monthly totals of some metrics over the last 12 months, oldest first. */
async function monthlyTotals(ctx, teamId, metrics) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
  const rows = await ctx.storage.tenancy.usageReport([teamId], from, now.toISOString().slice(0, 10));
  const months = new Map();
  for (const r of rows) {
    if (!metrics.includes(r.metric)) continue;
    const key = r.day.slice(0, 7);
    months.set(key, (months.get(key) ?? 0) + r.amount);
  }
  return [...months.entries()].map(([month, total]) => {
    const [y, m] = month.split("-").map(Number);
    return {
      startDate: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
      endDate: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)).toISOString(),
      total,
    };
  });
}

// --- Routes -----------------------------------------------------------------------

export function mountV2(app, ctx, { auth }) {
  const base = req => `${req.protocol}://${req.get("host")}`;
  const tenantOf = req => req.tenant ?? SYSTEM_TENANT;
  const route = (method, path, fn) =>
    app[method](path, auth, async (req, res, next) => {
      try {
        const out = await fn(req, res);
        if (out !== undefined) res.json(out);
      } catch (err) {
        next(err);
      }
    });
  const skipOf = req => Math.max(0, parseInt(req.query.skip ?? "0", 10) || 0);

  // Scrape
  route("post", "/v2/scrape", async req => {
    const { url, zeroDataRetention, origin: _o, integration: _i, ...opts } = scrapeBodyV2.parse(req.body);
    return api.scrape(ctx, { url, ...toScrapeOptions(opts) }, tenantOf(req), { zdr: !!zeroDataRetention });
  });

  // Batch scrape
  route("post", "/v2/batch/scrape", async req => {
    const { urls, webhook: hook, appendToId, ignoreInvalidURLs, zeroDataRetention, maxConcurrency: _m, origin: _o, integration: _i, ...opts } =
      batchBodyV2.parse(req.body);
    return api.startBatch(
      ctx,
      { urls, ...toScrapeOptions(opts), webhook: hook, appendToId, ignoreInvalidURLs, zeroDataRetention },
      base(req),
      tenantOf(req),
      { path: "/v2/batch/scrape" },
    );
  });
  route("get", "/v2/batch/scrape/:id", req =>
    api.crawlStatus(ctx, req.params.id, { skip: skipOf(req), baseUrl: base(req), kind: "batch", path: "/v2/batch/scrape" }, tenantOf(req)),
  );
  route("get", "/v2/batch/scrape/:id/errors", req => api.crawlErrors(ctx, req.params.id, tenantOf(req), { kind: "batch" }));
  route("delete", "/v2/batch/scrape/:id", async req => {
    const { wasRunning: _w, ...out } = await api.cancelCrawl(ctx, req.params.id, tenantOf(req), { kind: "batch" });
    return out;
  });

  // Crawl
  route("post", "/v2/crawl", async req => {
    const b = crawlBodyV2.parse(req.body);
    const body = {
      url: b.url,
      limit: Math.min(b.limit, 100_000),
      maxDepth: 100, // v2 has no path-depth limit; maxDiscoveryDepth bounds link hops
      ...(b.maxDiscoveryDepth !== undefined ? { maxDiscoveryDepth: b.maxDiscoveryDepth } : b.sitemap === "only" ? { maxDiscoveryDepth: 0 } : {}),
      ignoreSitemap: b.sitemap === "skip",
      scrapeOptions: toScrapeOptions(b.scrapeOptions),
      ...(b.webhook ? { webhook: b.webhook } : {}),
    };
    for (const k of [
      "includePaths",
      "excludePaths",
      "crawlEntireDomain",
      "allowExternalLinks",
      "allowSubdomains",
      "ignoreRobotsTxt",
      "deduplicateSimilarURLs",
      "ignoreQueryParameters",
      "regexOnFullURL",
      "delay",
    ]) {
      if (b[k] !== undefined) body[k] = b[k];
    }
    return api.startCrawl(ctx, body, base(req), tenantOf(req), { zdr: !!b.zeroDataRetention, path: "/v2/crawl" });
  });
  const active = async req => ({
    success: true,
    crawls: (await api.activeCrawls(ctx, tenantOf(req))).map(c => ({
      id: c.id,
      teamId: c.team_id,
      url: c.data.url,
      created_at: new Date(c.created_at).toISOString(),
      options: { ...c.data.crawlerOptions, scrapeOptions: c.data.scrapeOptions },
    })),
  });
  // Before /v2/crawl/:id, so "active" isn't taken for an id.
  route("get", "/v2/crawl/active", active);
  route("get", "/v2/crawl/ongoing", active);
  route("get", "/v2/crawl/:id", req =>
    api.crawlStatus(ctx, req.params.id, { skip: skipOf(req), baseUrl: base(req), path: "/v2/crawl" }, tenantOf(req)),
  );
  route("get", "/v2/crawl/:id/errors", req => api.crawlErrors(ctx, req.params.id, tenantOf(req)));
  route("delete", "/v2/crawl/:id", async (req, res) => {
    const { wasRunning, ...out } = await api.cancelCrawl(ctx, req.params.id, tenantOf(req));
    if (!wasRunning) {
      const crawl = await ctx.store.get(req.params.id);
      if (crawl?.status === "completed" || crawl?.status === "failed") {
        res.status(409).json({ success: false, error: "Crawl is already completed" });
        return undefined;
      }
    }
    return out;
  });

  // Map
  route("post", "/v2/map", async req => {
    const b = mapBodyV2.parse(req.body);
    const body = {
      url: b.url,
      ...(b.search ? { search: b.search } : {}),
      ...(b.limit ? { limit: b.limit } : {}),
      ...(b.includeSubdomains !== undefined ? { includeSubdomains: b.includeSubdomains } : {}),
      ...(b.timeout ? { timeout: Math.min(Math.max(Math.round(b.timeout), 1000), 120_000) } : {}),
      sitemapOnly: b.sitemap === "only",
      ignoreSitemap: b.sitemap === "skip",
    };
    const { links } = await api.map(ctx, body, tenantOf(req), { details: true });
    return { success: true, links };
  });

  // Search
  route("post", "/v2/search", async req => {
    const b = searchBodyV2.parse(req.body);
    const categories = (b.categories ?? []).map(typeOf);
    const query = [b.query, ...categories.map(c => CATEGORY_QUERY[c])].join(" ");
    const formats = b.scrapeOptions?.formats ?? [];
    const scrapeOptions = formats.length ? toScrapeOptions(b.scrapeOptions) : null;
    const data = await api.searchSources(
      ctx,
      {
        query,
        sources: [...new Set(b.sources.map(typeOf))],
        limit: b.limit,
        lang: b.lang,
        country: b.country,
        tbs: b.tbs,
        timeout: Math.min(b.timeout, 120_000),
        includeDomains: b.includeDomains,
        excludeDomains: b.excludeDomains,
        scrapeOptions,
        zdr: !!b.zeroDataRetention,
      },
      tenantOf(req),
    );
    const scraped = scrapeOptions ? (data.web ?? []).filter(r => r.metadata && !r.metadata.error).length : 0;
    return { success: true, data, creditsUsed: Object.keys(data).length + scraped, id: randomUUID() };
  });

  // Extract
  route("post", "/v2/extract", async req => {
    const b = extractBodyV2.parse(req.body);
    const { formats: _f, jsonOptions: _j, actions: _a, attributes: _at, ...scrapeOptions } = b.scrapeOptions ? toScrapeOptions(b.scrapeOptions) : {};
    return api.startExtract(
      ctx,
      {
        urls: b.urls ?? [],
        ...(b.prompt ? { prompt: b.prompt } : {}),
        ...(b.schema ? { schema: b.schema } : {}),
        ...(b.systemPrompt ? { systemPrompt: b.systemPrompt } : {}),
        ...(b.enableWebSearch !== undefined ? { enableWebSearch: b.enableWebSearch } : {}),
        ...(b.showSources !== undefined ? { showSources: b.showSources } : {}),
        ...(Object.keys(scrapeOptions).length ? { scrapeOptions } : {}),
      },
      tenantOf(req),
    );
  });
  route("get", "/v2/extract/:id", req => api.extractStatus(ctx, req.params.id, tenantOf(req)));

  // Team: credits are pages (1 per scraped page), the unit of the team's page quotas.
  route("get", "/v2/team/credit-usage", async req => {
    const t = tenantOf(req);
    const { start, end, startDay } = monthBounds();
    const used = await ctx.storage.tenancy.usageSince(t.teamId, "pages", startDay);
    const plan = t.limits.pagesPerMonth ?? null;
    return {
      success: true,
      data: {
        remainingCredits: plan == null ? UNLIMITED : Math.max(0, plan - used),
        planCredits: plan,
        billingPeriodStart: start.toISOString(),
        billingPeriodEnd: end.toISOString(),
      },
    };
  });
  route("get", "/v2/team/token-usage", async () => {
    const { start, end } = monthBounds();
    return {
      success: true,
      data: { remainingTokens: UNLIMITED, planTokens: null, billingPeriodStart: start.toISOString(), billingPeriodEnd: end.toISOString() },
    };
  });
  route("get", "/v2/team/credit-usage/historical", async req => ({
    success: true,
    periods: (await monthlyTotals(ctx, tenantOf(req).teamId, ["pages"])).map(({ total, ...p }) => ({ ...p, creditsUsed: total })),
  }));
  route("get", "/v2/team/token-usage/historical", async req => ({
    success: true,
    periods: (await monthlyTotals(ctx, tenantOf(req).teamId, ["aiInputTokens", "aiOutputTokens"])).map(({ total, ...p }) => ({
      ...p,
      tokensUsed: total,
    })),
  }));
  const maxConcurrency = t => t.limits.concurrency ?? Number(process.env.WORKERS ?? 4);
  route("get", "/v2/team/queue-status", async req => {
    const t = tenantOf(req);
    const s = await ctx.queue.teamStats(t.teamId);
    return {
      success: true,
      jobsInQueue: s.queued + s.active,
      activeJobsInQueue: s.active,
      waitingJobsInQueue: s.queued,
      maxConcurrency: maxConcurrency(t),
      mostRecentSuccess: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
    };
  });
  route("get", "/v2/concurrency-check", async req => {
    const t = tenantOf(req);
    const s = await ctx.queue.teamStats(t.teamId);
    return { success: true, concurrency: s.active, maxConcurrency: maxConcurrency(t) };
  });
}
