// Queue workers: `kickoff` seeds a crawl from robots.txt + sitemaps,
// `scrape` scrapes one URL and enqueues the links it discovers.
// Mirrors processKickoffJob / processJob in Firecrawl's scrape-worker.ts.
import { Crawler, fetchRobotsTxt, fetchSitemapUrls, lockKey, normalizeURL } from "./crawler.js";
import { llmTokens, scrapeURL } from "./scrape.js";
import { extractLinks } from "./html.js";
import { sendWebhook } from "./webhook.js";
import { getMapResults } from "./map.js";
import { webSearch } from "./search.js";
import { extractJson } from "./llm.js";
import { mapLimit } from "./util.js";
import { DATA_TTL_MS, TenancyError, checkPageQuota, domainAllowed, loadTeam, meter } from "./tenancy.js";
import { PAGE_CACHE_TTL_MS } from "./page-cache.js";

const CRAWL_PRIORITY = 20; // single scrapes would be 10; crawls yield to them

/** Lock a URL for the crawl and enqueue it if this caller won the lock. */
async function enqueueIfNew(ctx, crawl, url, depth) {
  const co = crawl.data.crawlerOptions;
  if (!await ctx.store.lockURL(crawl.id, lockKey(url, co), co.limit)) return false;
  await ctx.queue.add({
    type: "scrape",
    groupId: crawl.id,
    priority: CRAWL_PRIORITY,
    data: { crawlId: crawl.id, url, depth },
    teamId: crawl.team_id,
    expiresAt: crawl.expires_at,
  });
  return true;
}

/** The org's domain policy (stored with the crawl) applied to discovered links. */
const allowedLinks = (sc, links) => (sc.domainPolicy ? links.filter(l => domainAllowed(sc.domainPolicy, l)) : links);

/** The team's current limits (a team deleted from under a job has none). */
async function teamLimits(ctx, teamId) {
  return (await loadTeam(ctx, teamId))?.team.limits ?? {};
}

async function processKickoff(ctx, job) {
  const { crawlId } = job.data;
  const crawl = await ctx.store.get(crawlId);
  if (!crawl || crawl.status !== "scraping") return null;
  const sc = crawl.data;
  const co = sc.crawlerOptions;

  sc.robotsTxt = co.ignoreRobotsTxt ? "" : await fetchRobotsTxt(sc.url);
  await ctx.store.save(crawlId, sc);
  const crawler = new Crawler(sc.url, co, sc.robotsTxt);

  const startUrl = normalizeURL(sc.url, co);
  if (crawler.denialReason(startUrl) === "ROBOTS_TXT") {
    await ctx.store.recordRobotsBlocked(crawlId, [startUrl]);
  } else {
    await enqueueIfNew(ctx, crawl, startUrl, 0);
  }

  let fromSitemap = 0;
  if (!co.ignoreSitemap) {
    const urls = await fetchSitemapUrls(sc.url, sc.robotsTxt);
    const { links, robotsBlocked } = crawler.filterLinks(urls);
    await ctx.store.recordRobotsBlocked(crawlId, robotsBlocked);
    for (const link of allowedLinks(sc, links)) if (await enqueueIfNew(ctx, crawl, link, 1)) fromSitemap++;
  }
  return { fromSitemap };
}

/** Webhook event prefix: crawl.* or batch_scrape.* */
const eventPrefix = sc => (sc?.kind === "batch" ? "batch_scrape" : "crawl");

async function processScrape(ctx, job) {
  const { crawlId, url, depth } = job.data;
  const crawl = await ctx.store.get(crawlId);
  if (!crawl || crawl.status === "cancelled") return null;
  const sc = crawl.data;
  const co = sc.crawlerOptions;
  const batch = sc.kind === "batch";

  // Out of pages for today/this month: stop the whole crawl, not page by page.
  try {
    await checkPageQuota(ctx, await teamLimits(ctx, crawl.team_id), crawl.team_id);
  } catch (err) {
    if (!(err instanceof TenancyError)) throw err;
    if (await ctx.store.setStatus(crawlId, "failed")) await ctx.queue.dropQueued(crawlId);
    throw new Error(`${err.code}: ${err.message}`);
  }

  // crawl option `delay`: seconds to wait before each page.
  if (co.delay) await sleep(co.delay * 1000);

  const { doc, rawHtml, finalUrl, usage } = await scrapeURL(url, sc.scrapeOptions, { ...ctx.scrapeConfig, ...sc.policy, zdr: !!sc.zdr });
  await meter(ctx, crawl.team_id, usage);

  // Redirected? Lock the landing URL too, so two URLs that redirect to the
  // same page only produce one document (Firecrawl's RacedRedirectError).
  // A batch returns one document per requested URL, redirects or not.
  if (!batch && lockKey(finalUrl, co) !== lockKey(url, co) && !await ctx.store.lockURL(crawlId, lockKey(finalUrl, co))) {
    return null;
  }
  if (!sc.zdr) await ctx.store.recordSeen(finalUrl, doc.metadata.title ?? null);

  if (!batch && depth < (co.maxDiscoveryDepth ?? Infinity) && (await ctx.store.get(crawlId))?.status === "scraping") {
    const crawler = new Crawler(sc.url, co, sc.robotsTxt);
    const discovered = extractLinks(rawHtml, finalUrl);
    const { links, robotsBlocked } = crawler.filterLinks(discovered);
    await ctx.store.recordRobotsBlocked(crawlId, robotsBlocked);
    for (const link of allowedLinks(sc, links)) {
      if (!sc.zdr) await ctx.store.recordSeen(link);
      await enqueueIfNew(ctx, crawl, link, depth + 1);
    }
  }

  sendWebhook(sc.webhook, `${eventPrefix(sc)}.page`, crawlId, [doc]);
  return doc;
}

const EXTRACT_MAX_PAGES = Number(process.env.EXTRACT_MAX_PAGES ?? 10);

/**
 * /v1/extract: expand `site/*` URLs via map (ranked by the prompt), optionally
 * add web-search results, scrape every page, then extract one JSON result
 * across all of them. Firecrawl's fire-0 extract does the same steps.
 */
async function processExtract(ctx, job) {
  const { urls, prompt, schema, systemPrompt, enableWebSearch, scrapeOptions, policy, domainPolicy, zdr } = job.data;
  const teamId = job.team_id;
  await checkPageQuota(ctx, await teamLimits(ctx, teamId), teamId);
  const targets = new Set();
  for (const u of urls) {
    if (u.endsWith("/*")) {
      const links = await getMapResults(ctx.store, u.slice(0, -2), { search: prompt, limit: EXTRACT_MAX_PAGES });
      for (const l of links) targets.add(l);
    } else {
      targets.add(u);
    }
  }
  if (enableWebSearch && prompt) {
    for (const r of await webSearch(prompt, { limit: 3 }).catch(() => [])) targets.add(r.url);
  }

  const list = [...targets].filter(u => domainAllowed(domainPolicy, u)).slice(0, EXTRACT_MAX_PAGES);
  const failed = [];
  const docs = (
    await mapLimit(list, 4, async url => {
      try {
        const { doc, usage } = await scrapeURL(url, { ...scrapeOptions, formats: ["markdown"] }, { ...ctx.scrapeConfig, ...policy, zdr: !!zdr });
        await meter(ctx, teamId, usage);
        if (!zdr) await ctx.store.recordSeen(doc.metadata.url, doc.metadata.title ?? null);
        return { url: doc.metadata.url, title: doc.metadata.title, markdown: doc.markdown };
      } catch (err) {
        failed.push({ url, error: err.message });
        return null;
      }
    })
  ).filter(d => d?.markdown);
  if (docs.length === 0) {
    throw new Error(`None of the pages could be scraped: ${failed.map(f => `${f.url} (${f.error})`).join("; ")}`);
  }

  const { data, warnings, usage } = await extractJson(docs, { schema, prompt, systemPrompt });
  await meter(ctx, teamId, llmTokens(usage));
  return { data, sources: docs.map(d => d.url), failed, warnings, usage };
}

const handlers = { kickoff: processKickoff, scrape: processScrape, extract: processExtract };

// How long a URL stays in the index /map draws on after it was last seen. 0 = forever.
const SEEN_URLS_TTL_MS = Number(process.env.SEEN_URLS_TTL_DAYS ?? 30) * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
// Audit log retention. 0 = keep forever.
const AUDIT_TTL_MS = Number(process.env.AUDIT_RETENTION_DAYS ?? 365) * 24 * 60 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function startWorkers(ctx, { concurrency = 4, pollMs = 100, staleLockMs = 60_000 } = {}) {
  let stopping = false;

  const loop = async () => {
    while (!stopping) {
      const job = await ctx.queue.claim();
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      const heartbeat = setInterval(() => ctx.queue.renew(job).catch(() => {}), Math.max(1000, staleLockMs / 4));
      try {
        await ctx.queue.finish(job, await handlers[job.type](ctx, job));
      } catch (err) {
        await ctx.queue.fail(job, err?.message ?? String(err));
      } finally {
        clearInterval(heartbeat);
      }
    }
  };

  // The pg_cron jobs from nuq.sql: lock reaper + "crawl group finished".
  // Ticks never overlap: with an async (Postgres) backend a slow tick could
  // otherwise still be running when the next one fires.
  let maintaining = false;
  const maintenance = setInterval(async () => {
    if (maintaining) return;
    maintaining = true;
    try {
      await ctx.queue.reap(staleLockMs);
      for (const id of await ctx.store.finishIdleCrawls()) {
        const crawl = await ctx.store.get(id);
        sendWebhook(crawl?.data.webhook, `${eventPrefix(crawl?.data)}.completed`, id, []);
      }
    } catch (err) {
      console.error("maintenance tick failed", err);
    } finally {
      maintaining = false;
    }
  }, 500);

  // Expire old data (the crawl/extract `expiresAt` the API reports), so the
  // database doesn't grow forever on a long-running server.
  const prune = async () => {
    try {
      const removed = await ctx.store.pruneExpired({ dataTtlMs: DATA_TTL_MS, seenTtlMs: SEEN_URLS_TTL_MS });
      await ctx.storage.tenancy?.prune({ auditTtlMs: AUDIT_TTL_MS });
      const cached = await ctx.storage.cache?.prune({ ttlMs: PAGE_CACHE_TTL_MS });
      if (cached) console.log(`cleanup: removed ${cached} cached pages`);
      if (removed.crawls || removed.jobs || removed.seenUrls) {
        console.log(`cleanup: removed ${removed.crawls} crawls, ${removed.jobs} jobs, ${removed.seenUrls} index URLs`);
      }
    } catch (err) {
      console.error("cleanup failed", err);
    }
  };
  prune();
  const cleanup = setInterval(prune, CLEANUP_INTERVAL_MS);

  const loops = Array.from({ length: concurrency }, loop);
  return {
    async stop() {
      stopping = true;
      clearInterval(maintenance);
      clearInterval(cleanup);
      await Promise.all(loops);
    },
  };
}
