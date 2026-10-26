// The operations behind every /v1 endpoint, shared by the REST routes
// (src/server.js) and the MCP tools (src/mcp.js). Each takes the raw request
// body, validates it with the schemas in src/schemas.js, and returns the
// response object. Errors are thrown and mapped to HTTP / MCP errors by the caller.
//
// Every operation runs as a tenant (src/tenancy.js): its role, scopes, team
// features, domain policy and page quota are checked here, its usage is
// metered, and the crawls and jobs it creates belong to its team. Another
// team's ids answer 404, exactly like ids that don't exist.
import { randomUUID } from "node:crypto";
import { scrapeURL, DEFAULT_SCRAPE_OPTIONS } from "./scrape.js";
import { getMapResults } from "./map.js";
import { sendWebhook } from "./webhook.js";
import { webSearch } from "./search.js";
import { mapLimit } from "./util.js";
import { batchBody, crawlBody, extractBody, httpUrl, mapBody, scrapeBody, searchBody } from "./schemas.js";
import {
  DATA_TTL_MS,
  SYSTEM_TENANT,
  authorize,
  checkPageQuota,
  checkUrl,
  domainAllowed,
  domainPolicy,
  expiryFor,
  meter,
  requireFeature,
  scrapePolicy,
} from "./tenancy.js";

export { DATA_TTL_MS };

// Rows without their own expiry (from before 1.3) expire DATA_TTL_MS after creation.
const expiresAt = (stored, createdMs) =>
  stored != null
    ? new Date(stored).toISOString()
    : DATA_TTL_MS > 0
      ? new Date(createdMs + DATA_TTL_MS).toISOString()
      : null;
export const PAGE_SIZE = 100;

export class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequestError";
    this.code = "BAD_REQUEST";
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.code = "NOT_FOUND";
  }
}

/** Remember scraped URLs for /v1/map, unless the team (or this request) has zero data retention. */
async function recordSeen(ctx, tenant, doc, zdr = false) {
  if (!tenant.settings.zdr && !zdr) await ctx.store.recordSeen(doc.metadata.url, doc.metadata.title ?? null);
}

// Batch pages queue like crawl pages: single scrapes (synchronous) go first.
const BATCH_PRIORITY = 20;

/**
 * @param {{zdr?: boolean}} [options] zdr: zero data retention for this request
 *   (the v2 `zeroDataRetention` flag), on top of the team setting
 */
export async function scrape(ctx, body, tenant = SYSTEM_TENANT, { zdr = false } = {}) {
  authorize(tenant, "scrape");
  const { url, origin: _o, integration: _i, ...opts } = scrapeBody.parse(body);
  checkUrl(tenant, url);
  const policy = scrapePolicy(tenant, opts);
  await checkPageQuota(ctx, tenant.limits, tenant.teamId);
  const { doc, usage } = await scrapeURL(url, opts, { ...ctx.scrapeConfig, ...policy, zdr: zdr || !!tenant.settings.zdr });
  await meter(ctx, tenant.teamId, usage);
  await recordSeen(ctx, tenant, doc, zdr);
  return { success: true, data: doc };
}

/** The team's settings, with zero data retention forced on for this request when asked. */
const settingsFor = (tenant, zdr) => (zdr ? { ...tenant.settings, zdr: true } : tenant.settings);

/**
 * @param {string} baseUrl e.g. "http://localhost:3002", used for the status URL
 * @param {{zdr?: boolean, path?: string}} [options] path: status URL prefix ("/v1/crawl" or "/v2/crawl")
 */
export async function startCrawl(ctx, body, baseUrl, tenant = SYSTEM_TENANT, { zdr = false, path = "/v1/crawl" } = {}) {
  authorize(tenant, "crawl");
  const { url, scrapeOptions: so, webhook: hook, origin: _o, integration: _i, ...crawlerOptions } = crawlBody.parse(body);
  checkUrl(tenant, url);
  const scrapeOptions = { ...DEFAULT_SCRAPE_OPTIONS, ...so };
  const policy = scrapePolicy(tenant, scrapeOptions);
  await checkPageQuota(ctx, tenant.limits, tenant.teamId);
  // The team's crawl size cap lowers the requested (or default) limit.
  const max = tenant.limits.maxCrawlPages;
  if (max != null) crawlerOptions.limit = Math.min(crawlerOptions.limit, max);

  const id = randomUUID();
  const settings = settingsFor(tenant, zdr);
  const expires = expiryFor(settings);
  const sc = {
    url,
    crawlerOptions,
    scrapeOptions,
    webhook: hook,
    policy,
    domainPolicy: domainPolicy(tenant),
    zdr: !!settings.zdr,
  };
  await ctx.store.create(id, sc, { teamId: tenant.teamId, expiresAt: expires });
  await ctx.queue.add({ type: "kickoff", groupId: id, priority: 5, data: { crawlId: id }, teamId: tenant.teamId, expiresAt: expires });
  sendWebhook(hook, "crawl.started", id, []);
  return { success: true, id, url: `${baseUrl}${path}/${id}` };
}

/**
 * Batch scrape: a fixed list of URLs scraped like crawl pages (same queue,
 * status, errors and cancel), without link discovery.
 * @param {{zdr?: boolean, path?: string}} [options] path: status URL prefix
 */
export async function startBatch(ctx, body, baseUrl, tenant = SYSTEM_TENANT, { zdr = false, path = "/v1/batch/scrape" } = {}) {
  authorize(tenant, "scrape");
  const {
    urls,
    webhook: hook,
    ignoreInvalidURLs,
    appendToId,
    maxConcurrency: _m,
    zeroDataRetention,
    origin: _o,
    integration: _i,
    ...opts
  } = batchBody.parse(body);
  const policy = domainPolicy(tenant);
  const valid = [];
  const invalidURLs = [];
  for (const raw of urls) {
    const parsed = httpUrl.safeParse(raw);
    if (parsed.success && domainAllowed(policy, parsed.data)) {
      valid.push(parsed.data);
      continue;
    }
    if (!ignoreInvalidURLs) {
      if (parsed.success) checkUrl(tenant, parsed.data); // throws DOMAIN_NOT_ALLOWED
      throw new BadRequestError(`Invalid URL: ${raw}. Pass ignoreInvalidURLs: true to skip invalid URLs.`);
    }
    invalidURLs.push(raw);
  }
  if (valid.length === 0) throw new BadRequestError("None of the URLs are valid");
  const max = tenant.limits.maxCrawlPages;
  if (max != null && valid.length > max) {
    throw new BadRequestError(`The batch has ${valid.length} URLs; your team's limit per crawl or batch is ${max}`);
  }
  const scrapeOptions = { ...DEFAULT_SCRAPE_OPTIONS, ...opts };
  const scrapePol = scrapePolicy(tenant, scrapeOptions);
  await checkPageQuota(ctx, tenant.limits, tenant.teamId);

  let id;
  let expires;
  if (appendToId) {
    const batch = await ownCrawl(ctx, appendToId, tenant, "batch");
    if (batch.status === "cancelled" || batch.status === "failed") {
      throw new BadRequestError(`Batch ${appendToId} is ${batch.status} and can't take new URLs`);
    }
    id = batch.id;
    expires = batch.expires_at;
  } else {
    id = randomUUID();
    const settings = settingsFor(tenant, zdr || zeroDataRetention);
    expires = expiryFor(settings);
    const sc = {
      kind: "batch",
      url: valid[0],
      crawlerOptions: {},
      scrapeOptions,
      webhook: hook,
      policy: scrapePol,
      domainPolicy: policy,
      zdr: !!settings.zdr,
    };
    await ctx.store.create(id, sc, { teamId: tenant.teamId, expiresAt: expires });
  }
  for (const url of valid) {
    await ctx.queue.add({ type: "scrape", groupId: id, priority: BATCH_PRIORITY, data: { crawlId: id, url, depth: 0 }, teamId: tenant.teamId, expiresAt: expires });
  }
  if (appendToId) await ctx.store.reopen(id);
  else sendWebhook(hook, "batch_scrape.started", id, []);
  return { success: true, id, url: `${baseUrl}${path}/${id}`, ...(ignoreInvalidURLs ? { invalidURLs } : {}) };
}

/** A crawl or batch of the tenant's team; anything else is "not found". */
async function ownCrawl(ctx, id, tenant, kind = "crawl") {
  const crawl = await ctx.store.get(id);
  if (!crawl || crawl.team_id !== tenant.teamId || (crawl.data.kind ?? "crawl") !== kind) {
    throw new NotFoundError(kind === "batch" ? "Batch scrape not found" : "Crawl not found");
  }
  return crawl;
}

/** @param {{kind?: "crawl" | "batch", path?: string}} options path: prefix for the `next` URL */
export async function crawlStatus(
  ctx,
  id,
  { skip = 0, baseUrl, pageSize = PAGE_SIZE, kind = "crawl", path = kind === "batch" ? "/v1/batch/scrape" : "/v1/crawl" } = {},
  tenant = SYSTEM_TENANT,
) {
  authorize(tenant, kind === "batch" ? "scrape" : "crawl", { write: false });
  const crawl = await ownCrawl(ctx, id, tenant, kind);
  const counts = await ctx.queue.groupCounts(crawl.id);
  const data = await ctx.queue.groupDocuments(crawl.id, skip, pageSize);
  const more = data.length === pageSize;
  return {
    success: true,
    status: crawl.status,
    total: counts.queued + counts.active + counts.completed + counts.failed,
    completed: counts.completed,
    creditsUsed: counts.completed,
    expiresAt: expiresAt(crawl.expires_at, crawl.created_at),
    // Omitted (not null) on the last page: the Firecrawl SDKs keep paging
    // while the key exists.
    ...(more && baseUrl ? { next: `${baseUrl}${path}/${crawl.id}?skip=${skip + pageSize}` } : {}),
    data,
  };
}

export async function crawlErrors(ctx, id, tenant = SYSTEM_TENANT, { kind = "crawl" } = {}) {
  authorize(tenant, kind === "batch" ? "scrape" : "crawl", { write: false });
  const crawl = await ownCrawl(ctx, id, tenant, kind);
  return { errors: await ctx.queue.groupErrors(crawl.id), robotsBlocked: await ctx.store.robotsBlocked(crawl.id) };
}

/** @returns {Promise<{success: true, status: "cancelled", wasRunning: boolean}>} wasRunning: false when it had already finished */
export async function cancelCrawl(ctx, id, tenant = SYSTEM_TENANT, { kind = "crawl" } = {}) {
  authorize(tenant, kind === "batch" ? "scrape" : "crawl");
  const crawl = await ownCrawl(ctx, id, tenant, kind);
  const wasRunning = await ctx.store.setStatus(crawl.id, "cancelled");
  if (wasRunning) await ctx.queue.dropQueued(crawl.id);
  return { success: true, status: "cancelled", wasRunning };
}

/** The team's running crawls (not batches), for /v2/crawl/active. */
export async function activeCrawls(ctx, tenant = SYSTEM_TENANT) {
  authorize(tenant, "crawl", { write: false });
  return (await ctx.store.listActive(tenant.teamId)).filter(c => (c.data.kind ?? "crawl") === "crawl");
}

/** @param {{details?: boolean}} [options] details: links as {url, title} (titles from pages seen before) */
export async function map(ctx, body, tenant = SYSTEM_TENANT, { details = false } = {}) {
  authorize(tenant, "map");
  const { url, origin: _o, integration: _i, ...opts } = mapBody.parse(body);
  checkUrl(tenant, url);
  const policy = domainPolicy(tenant);
  const links = await getMapResults(ctx.store, url, { ...opts, details });
  return { success: true, links: policy ? links.filter(l => domainAllowed(policy, details ? l.url : l)) : links };
}

export async function search(ctx, body, tenant = SYSTEM_TENANT) {
  authorize(tenant, "search");
  requireFeature(tenant, "search");
  const { query, scrapeOptions: so, origin: _o, integration: _i, ...opts } = searchBody.parse(body);
  const policy = so ? scrapePolicy(tenant, so) : null;
  if (so) await checkPageQuota(ctx, tenant.limits, tenant.teamId);
  const domains = domainPolicy(tenant);
  const results = (await webSearch(query, opts)).filter(r => domainAllowed(domains, r.url));
  await meter(ctx, tenant.teamId, { searches: 1 });
  if (!so) return { success: true, data: results };
  // Scrape every result, as Firecrawl does when scrapeOptions is given.
  const data = await mapLimit(results, 4, async r => {
    try {
      const { doc, usage } = await scrapeURL(r.url, so, { ...ctx.scrapeConfig, ...policy, zdr: !!tenant.settings.zdr });
      await meter(ctx, tenant.teamId, usage);
      await recordSeen(ctx, tenant, doc);
      return { ...r, ...doc };
    } catch (err) {
      return { ...r, metadata: { sourceURL: r.url, error: err.message } };
    }
  });
  return { success: true, data };
}

/**
 * Search several sources (web, news, images) for /v2/search. Arguments are
 * already validated by the v2 schema (src/v2.js).
 * @returns {Promise<{web?: object[], news?: object[], images?: object[]}>}
 */
export async function searchSources(ctx, req, tenant = SYSTEM_TENANT) {
  authorize(tenant, "search");
  requireFeature(tenant, "search");
  const { query, sources, limit, lang, country, tbs, timeout, includeDomains, excludeDomains, scrapeOptions: so, zdr = false } = req;
  const policy = so ? scrapePolicy(tenant, so) : null;
  if (so) await checkPageQuota(ctx, tenant.limits, tenant.teamId);
  const domains = domainPolicy(tenant);
  const hostOk = url => {
    if (!domainAllowed(domains, url)) return false;
    if (includeDomains?.length) return domainAllowed({ allowDomains: includeDomains }, url);
    if (excludeDomains?.length) return domainAllowed({ denyDomains: excludeDomains }, url);
    return true;
  };
  const out = {};
  for (const source of sources) {
    const results = await webSearch(query, { limit, lang, country, tbs, timeout, source });
    out[source] = results.filter(r => hostOk(r.url)).map((r, i) => ({ ...r, position: i + 1 }));
  }
  await meter(ctx, tenant.teamId, { searches: sources.length });
  if (so && out.web?.length) {
    out.web = await mapLimit(out.web, 4, async r => {
      try {
        const { doc, usage } = await scrapeURL(r.url, so, { ...ctx.scrapeConfig, ...policy, zdr: zdr || !!tenant.settings.zdr });
        await meter(ctx, tenant.teamId, usage);
        await recordSeen(ctx, tenant, doc, zdr);
        return { ...r, ...doc };
      } catch (err) {
        return { ...r, metadata: { sourceURL: r.url, error: err.message } };
      }
    });
  }
  return out;
}

export async function startExtract(ctx, body, tenant = SYSTEM_TENANT) {
  authorize(tenant, "extract");
  requireFeature(tenant, "ai");
  const { origin: _o, integration: _i, ...data } = extractBody.parse(body);
  for (const u of data.urls) checkUrl(tenant, u.replace(/\/\*$/, ""));
  // No URLs: the extractor reads web search results for the prompt.
  if (data.enableWebSearch) requireFeature(tenant, "search");
  const policy = scrapePolicy(tenant, data.scrapeOptions);
  await checkPageQuota(ctx, tenant.limits, tenant.teamId);
  const id = await ctx.queue.add({
    type: "extract",
    priority: 10,
    data: { ...data, policy, domainPolicy: domainPolicy(tenant), zdr: !!tenant.settings.zdr },
    teamId: tenant.teamId,
    expiresAt: expiryFor(tenant.settings),
  });
  return { success: true, id, urlTrace: [] };
}

export async function extractStatus(ctx, id, tenant = SYSTEM_TENANT) {
  authorize(tenant, "extract", { write: false });
  const job = await ctx.queue.get(id);
  if (!job || job.type !== "extract" || job.team_id !== tenant.teamId) throw new NotFoundError("Extract job not found");
  const status = { queued: "processing", active: "processing", completed: "completed", failed: "failed" }[job.status];
  const r = job.result ?? {};
  return {
    success: job.status !== "failed",
    status,
    data: r.data ?? null,
    ...(job.data.showSources ? { sources: r.sources ?? [] } : {}),
    ...(r.warnings?.length ? { warning: r.warnings.join(" ") } : {}),
    ...(r.failed?.length ? { failedUrls: r.failed } : {}),
    ...(job.error ? { error: job.error } : {}),
    expiresAt: expiresAt(job.expires_at, Math.floor(job.created_at / 1000)),
  };
}
