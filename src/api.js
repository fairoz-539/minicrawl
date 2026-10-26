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
import { crawlBody, extractBody, mapBody, scrapeBody, searchBody } from "./schemas.js";
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

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.code = "NOT_FOUND";
  }
}

/** Remember scraped URLs for /v1/map, unless the team has zero data retention. */
async function recordSeen(ctx, tenant, doc) {
  if (!tenant.settings.zdr) await ctx.store.recordSeen(doc.metadata.url, doc.metadata.title ?? null);
}

export async function scrape(ctx, body, tenant = SYSTEM_TENANT) {
  authorize(tenant, "scrape");
  const { url, origin: _o, integration: _i, ...opts } = scrapeBody.parse(body);
  checkUrl(tenant, url);
  const policy = scrapePolicy(tenant, opts);
  await checkPageQuota(ctx, tenant.limits, tenant.teamId);
  const { doc, usage } = await scrapeURL(url, opts, { ...ctx.scrapeConfig, ...policy });
  await meter(ctx, tenant.teamId, usage);
  await recordSeen(ctx, tenant, doc);
  return { success: true, data: doc };
}

/** @param {string} baseUrl e.g. "http://localhost:3002", used for the status URL */
export async function startCrawl(ctx, body, baseUrl, tenant = SYSTEM_TENANT) {
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
  const expires = expiryFor(tenant.settings);
  const sc = {
    url,
    crawlerOptions,
    scrapeOptions,
    webhook: hook,
    policy,
    domainPolicy: domainPolicy(tenant),
    zdr: !!tenant.settings.zdr,
  };
  await ctx.store.create(id, sc, { teamId: tenant.teamId, expiresAt: expires });
  await ctx.queue.add({ type: "kickoff", groupId: id, priority: 5, data: { crawlId: id }, teamId: tenant.teamId, expiresAt: expires });
  sendWebhook(hook, "crawl.started", id, []);
  return { success: true, id, url: `${baseUrl}/v1/crawl/${id}` };
}

async function ownCrawl(ctx, id, tenant) {
  const crawl = await ctx.store.get(id);
  if (!crawl || crawl.team_id !== tenant.teamId) throw new NotFoundError("Crawl not found");
  return crawl;
}

export async function crawlStatus(ctx, id, { skip = 0, baseUrl, pageSize = PAGE_SIZE } = {}, tenant = SYSTEM_TENANT) {
  authorize(tenant, "crawl", { write: false });
  const crawl = await ownCrawl(ctx, id, tenant);
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
    ...(more && baseUrl ? { next: `${baseUrl}/v1/crawl/${crawl.id}?skip=${skip + pageSize}` } : {}),
    data,
  };
}

export async function crawlErrors(ctx, id, tenant = SYSTEM_TENANT) {
  authorize(tenant, "crawl", { write: false });
  const crawl = await ownCrawl(ctx, id, tenant);
  return { errors: await ctx.queue.groupErrors(crawl.id), robotsBlocked: await ctx.store.robotsBlocked(crawl.id) };
}

export async function cancelCrawl(ctx, id, tenant = SYSTEM_TENANT) {
  authorize(tenant, "crawl");
  const crawl = await ownCrawl(ctx, id, tenant);
  if (await ctx.store.setStatus(crawl.id, "cancelled")) await ctx.queue.dropQueued(crawl.id);
  return { success: true, status: "cancelled" };
}

export async function map(ctx, body, tenant = SYSTEM_TENANT) {
  authorize(tenant, "map");
  const { url, origin: _o, integration: _i, ...opts } = mapBody.parse(body);
  checkUrl(tenant, url);
  const policy = domainPolicy(tenant);
  const links = await getMapResults(ctx.store, url, opts);
  return { success: true, links: policy ? links.filter(l => domainAllowed(policy, l)) : links };
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
      const { doc, usage } = await scrapeURL(r.url, so, { ...ctx.scrapeConfig, ...policy });
      await meter(ctx, tenant.teamId, usage);
      await recordSeen(ctx, tenant, doc);
      return { ...r, ...doc };
    } catch (err) {
      return { ...r, metadata: { sourceURL: r.url, error: err.message } };
    }
  });
  return { success: true, data };
}

export async function startExtract(ctx, body, tenant = SYSTEM_TENANT) {
  authorize(tenant, "extract");
  requireFeature(tenant, "ai");
  const { origin: _o, integration: _i, ...data } = extractBody.parse(body);
  for (const u of data.urls) checkUrl(tenant, u.replace(/\/\*$/, ""));
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
