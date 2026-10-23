// Queue workers: `kickoff` seeds a crawl from robots.txt + sitemaps,
// `scrape` scrapes one URL and enqueues the links it discovers.
// Mirrors processKickoffJob / processJob in Firecrawl's scrape-worker.ts.
import { Crawler, fetchRobotsTxt, fetchSitemapUrls, lockKey, normalizeURL } from "./crawler.js";
import { scrapeURL } from "./scrape.js";
import { extractLinks } from "./html.js";
import { sendWebhook } from "./webhook.js";
import { getMapResults } from "./map.js";
import { webSearch } from "./search.js";
import { extractJson } from "./llm.js";
import { mapLimit } from "./util.js";

const CRAWL_PRIORITY = 20; // single scrapes would be 10; crawls yield to them

/** Lock a URL for the crawl and enqueue it if this caller won the lock. */
function enqueueIfNew(ctx, crawlId, sc, url, depth) {
  const co = sc.crawlerOptions;
  if (!ctx.store.lockURL(crawlId, lockKey(url, co), co.limit)) return false;
  ctx.queue.add({ type: "scrape", groupId: crawlId, priority: CRAWL_PRIORITY, data: { crawlId, url, depth } });
  return true;
}

async function processKickoff(ctx, job) {
  const { crawlId } = job.data;
  const crawl = ctx.store.get(crawlId);
  if (!crawl || crawl.status !== "scraping") return null;
  const sc = crawl.data;
  const co = sc.crawlerOptions;

  sc.robotsTxt = co.ignoreRobotsTxt ? "" : await fetchRobotsTxt(sc.url);
  ctx.store.save(crawlId, sc);
  const crawler = new Crawler(sc.url, co, sc.robotsTxt);

  const startUrl = normalizeURL(sc.url, co);
  if (crawler.denialReason(startUrl) === "ROBOTS_TXT") {
    ctx.store.recordRobotsBlocked(crawlId, [startUrl]);
  } else {
    enqueueIfNew(ctx, crawlId, sc, startUrl, 0);
  }

  let fromSitemap = 0;
  if (!co.ignoreSitemap) {
    const urls = await fetchSitemapUrls(sc.url, sc.robotsTxt);
    const { links, robotsBlocked } = crawler.filterLinks(urls);
    ctx.store.recordRobotsBlocked(crawlId, robotsBlocked);
    for (const link of links) if (enqueueIfNew(ctx, crawlId, sc, link, 1)) fromSitemap++;
  }
  return { fromSitemap };
}

async function processScrape(ctx, job) {
  const { crawlId, url, depth } = job.data;
  const crawl = ctx.store.get(crawlId);
  if (!crawl || crawl.status === "cancelled") return null;
  const sc = crawl.data;
  const co = sc.crawlerOptions;

  const { doc, rawHtml, finalUrl } = await scrapeURL(url, sc.scrapeOptions, ctx.scrapeConfig);

  // Redirected? Lock the landing URL too, so two URLs that redirect to the
  // same page only produce one document (Firecrawl's RacedRedirectError).
  if (lockKey(finalUrl, co) !== lockKey(url, co) && !ctx.store.lockURL(crawlId, lockKey(finalUrl, co))) {
    return null;
  }
  ctx.store.recordSeen(finalUrl, doc.metadata.title ?? null);

  if (depth < (co.maxDiscoveryDepth ?? Infinity) && ctx.store.get(crawlId).status === "scraping") {
    const crawler = new Crawler(sc.url, co, sc.robotsTxt);
    const discovered = extractLinks(rawHtml, finalUrl);
    const { links, robotsBlocked } = crawler.filterLinks(discovered);
    ctx.store.recordRobotsBlocked(crawlId, robotsBlocked);
    for (const link of links) {
      ctx.store.recordSeen(link);
      enqueueIfNew(ctx, crawlId, sc, link, depth + 1);
    }
  }

  sendWebhook(sc.webhook, "crawl.page", crawlId, [doc]);
  return doc;
}

const EXTRACT_MAX_PAGES = Number(process.env.EXTRACT_MAX_PAGES ?? 10);

/**
 * /v1/extract: expand `site/*` URLs via map (ranked by the prompt), optionally
 * add web-search results, scrape every page, then extract one JSON result
 * across all of them. Firecrawl's fire-0 extract does the same steps.
 */
async function processExtract(ctx, job) {
  const { urls, prompt, schema, systemPrompt, enableWebSearch, scrapeOptions } = job.data;
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

  const list = [...targets].slice(0, EXTRACT_MAX_PAGES);
  const failed = [];
  const docs = (
    await mapLimit(list, 4, async url => {
      try {
        const { doc } = await scrapeURL(url, { ...scrapeOptions, formats: ["markdown"] }, ctx.scrapeConfig);
        ctx.store.recordSeen(doc.metadata.url, doc.metadata.title ?? null);
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
  return { data, sources: docs.map(d => d.url), failed, warnings, usage };
}

const handlers = { kickoff: processKickoff, scrape: processScrape, extract: processExtract };

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function startWorkers(ctx, { concurrency = 4, pollMs = 100, staleLockMs = 60_000 } = {}) {
  let stopping = false;

  const loop = async () => {
    while (!stopping) {
      const job = ctx.queue.claim();
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      const heartbeat = setInterval(() => ctx.queue.renew(job), Math.max(1000, staleLockMs / 4));
      try {
        ctx.queue.finish(job, await handlers[job.type](ctx, job));
      } catch (err) {
        ctx.queue.fail(job, err?.message ?? String(err));
      } finally {
        clearInterval(heartbeat);
      }
    }
  };

  // The pg_cron jobs from nuq.sql: lock reaper + "crawl group finished".
  const maintenance = setInterval(() => {
    try {
      ctx.queue.reap(staleLockMs);
      for (const id of ctx.store.finishIdleCrawls()) {
        const crawl = ctx.store.get(id);
        sendWebhook(crawl?.data.webhook, "crawl.completed", id, []);
      }
    } catch (err) {
      console.error("maintenance tick failed", err);
    }
  }, 500);

  const loops = Array.from({ length: concurrency }, loop);
  return {
    async stop() {
      stopping = true;
      clearInterval(maintenance);
      await Promise.all(loops);
    },
  };
}
