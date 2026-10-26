// The operations behind every /v1 endpoint, shared by the REST routes
// (src/server.js) and the MCP tools (src/mcp.js). Each takes the raw request
// body, validates it with the schemas in src/schemas.js, and returns the
// response object. Errors are thrown and mapped to HTTP / MCP errors by the caller.
import { randomUUID } from "node:crypto";
import { scrapeURL, DEFAULT_SCRAPE_OPTIONS } from "./scrape.js";
import { getMapResults } from "./map.js";
import { sendWebhook } from "./webhook.js";
import { webSearch } from "./search.js";
import { mapLimit } from "./util.js";
import { crawlBody, extractBody, mapBody, scrapeBody, searchBody } from "./schemas.js";

// How long crawl and extract results are kept: the `expiresAt` in responses.
// The cleanup in src/worker.js deletes them afterwards. 0 = keep forever.
export const DATA_TTL_MS = Number(process.env.DATA_TTL_HOURS ?? 24) * 60 * 60 * 1000;
const expiresAt = createdMs => (DATA_TTL_MS > 0 ? new Date(createdMs + DATA_TTL_MS).toISOString() : null);
export const PAGE_SIZE = 100;

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.code = "NOT_FOUND";
  }
}

export async function scrape(ctx, body) {
  const { url, origin: _o, integration: _i, ...opts } = scrapeBody.parse(body);
  const { doc } = await scrapeURL(url, opts, ctx.scrapeConfig);
  await ctx.store.recordSeen(doc.metadata.url, doc.metadata.title ?? null);
  return { success: true, data: doc };
}

/** @param {string} baseUrl e.g. "http://localhost:3002", used for the status URL */
export async function startCrawl(ctx, body, baseUrl) {
  const { url, scrapeOptions: so, webhook: hook, origin: _o, integration: _i, ...crawlerOptions } = crawlBody.parse(body);
  const id = randomUUID();
  const sc = { url, crawlerOptions, scrapeOptions: { ...DEFAULT_SCRAPE_OPTIONS, ...so }, webhook: hook };
  await ctx.store.create(id, sc);
  await ctx.queue.add({ type: "kickoff", groupId: id, priority: 5, data: { crawlId: id } });
  sendWebhook(hook, "crawl.started", id, []);
  return { success: true, id, url: `${baseUrl}/v1/crawl/${id}` };
}

export async function crawlStatus(ctx, id, { skip = 0, baseUrl, pageSize = PAGE_SIZE } = {}) {
  const crawl = await ctx.store.get(id);
  if (!crawl) throw new NotFoundError("Crawl not found");
  const counts = await ctx.queue.groupCounts(crawl.id);
  const data = await ctx.queue.groupDocuments(crawl.id, skip, pageSize);
  const more = data.length === pageSize;
  return {
    success: true,
    status: crawl.status,
    total: counts.queued + counts.active + counts.completed + counts.failed,
    completed: counts.completed,
    creditsUsed: counts.completed,
    expiresAt: expiresAt(crawl.created_at),
    // Omitted (not null) on the last page: the Firecrawl SDKs keep paging
    // while the key exists.
    ...(more && baseUrl ? { next: `${baseUrl}/v1/crawl/${crawl.id}?skip=${skip + pageSize}` } : {}),
    data,
  };
}

export async function crawlErrors(ctx, id) {
  const crawl = await ctx.store.get(id);
  if (!crawl) throw new NotFoundError("Crawl not found");
  return { errors: await ctx.queue.groupErrors(crawl.id), robotsBlocked: await ctx.store.robotsBlocked(crawl.id) };
}

export async function cancelCrawl(ctx, id) {
  const crawl = await ctx.store.get(id);
  if (!crawl) throw new NotFoundError("Crawl not found");
  if (await ctx.store.setStatus(crawl.id, "cancelled")) await ctx.queue.dropQueued(crawl.id);
  return { success: true, status: "cancelled" };
}

export async function map(ctx, body) {
  const { url, origin: _o, integration: _i, ...opts } = mapBody.parse(body);
  return { success: true, links: await getMapResults(ctx.store, url, opts) };
}

export async function search(ctx, body) {
  const { query, scrapeOptions: so, origin: _o, integration: _i, ...opts } = searchBody.parse(body);
  const results = await webSearch(query, opts);
  if (!so) return { success: true, data: results };
  // Scrape every result, as Firecrawl does when scrapeOptions is given.
  const data = await mapLimit(results, 4, async r => {
    try {
      const { doc } = await scrapeURL(r.url, so, ctx.scrapeConfig);
      await ctx.store.recordSeen(doc.metadata.url, doc.metadata.title ?? null);
      return { ...r, ...doc };
    } catch (err) {
      return { ...r, metadata: { sourceURL: r.url, error: err.message } };
    }
  });
  return { success: true, data };
}

export async function startExtract(ctx, body) {
  const { origin: _o, integration: _i, ...data } = extractBody.parse(body);
  const id = await ctx.queue.add({ type: "extract", priority: 10, data });
  return { success: true, id, urlTrace: [] };
}

export async function extractStatus(ctx, id) {
  const job = await ctx.queue.get(id);
  if (!job || job.type !== "extract") throw new NotFoundError("Extract job not found");
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
    expiresAt: expiresAt(Math.floor(job.created_at / 1000)),
  };
}
