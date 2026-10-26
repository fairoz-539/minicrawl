// scrapeURL: engine waterfall (with proxy escalation), then the transformer
// pipeline that turns the raw page into a Firecrawl-shaped Document.
import { FatalScrapeError, SiteBlockedError, scrapeWithWaterfall } from "./engines.js";
import { cleanHtml, extractAttributes, extractImages, extractLinks, extractMetadata } from "./html.js";
import { htmlToMarkdown } from "./markdown.js";
import { hasStealthPool, pickProxy } from "./proxy.js";
import { extractJson } from "./llm.js";
import { DEFAULT_MAX_AGE_MS, PAGE_CACHE_ENABLED, cacheKey, decodePage } from "./page-cache.js";

export const DEFAULT_SCRAPE_OPTIONS = {
  formats: ["markdown"],
  onlyMainContent: true,
  includeTags: [],
  excludeTags: [],
  headers: {},
  waitFor: 0,
  timeout: 30_000,
  proxy: "auto",
};

/** Sum the per-call token usage extractJson reports. */
export const llmTokens = (usage = []) => ({
  aiInputTokens: usage.reduce((n, u) => n + (u?.inputTokens ?? 0), 0),
  aiOutputTokens: usage.reduce((n, u) => n + (u?.outputTokens ?? 0), 0),
});

/** The `summary` format: a short AI summary of the page. */
const SUMMARY_REQUEST = {
  schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
  prompt: "Summarize this page in 2 to 4 sentences: what it is and its key information.",
};

const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 503]);

/**
 * proxy "basic": basic pool (or direct). "stealth": stealth pool only.
 * "auto": basic first; if the site blocks it, retry once through the stealth
 * pool (when STEALTH_PROXY_URLS is configured). Same contract as Firecrawl.
 * noStealth (the team has the stealth proxy disabled) keeps "auto" on basic.
 */
async function fetchWithProxyStrategy(url, opts, timing, noStealth = false) {
  const attempt = tier => {
    const proxy = pickProxy(tier);
    return scrapeWithWaterfall(url, { ...opts, proxy }, timing).then(page => ({ ...page, proxyUsed: tier }));
  };

  if (opts.proxy === "stealth") {
    if (!hasStealthPool()) {
      throw new FatalScrapeError("proxy \"stealth\" needs STEALTH_PROXY_URLS to be configured", "NO_STEALTH_PROXY");
    }
    return attempt("stealth");
  }
  if (opts.proxy === "basic" || noStealth || !hasStealthPool()) return attempt("basic");

  const started = Date.now();
  try {
    const page = await attempt("basic");
    if (!BLOCKED_STATUSES.has(page.statusCode)) return page;
    return await attempt("stealth").catch(() => page);
  } catch (err) {
    if (!(err instanceof SiteBlockedError)) throw err;
    const left = opts.timeout - (Date.now() - started);
    if (left < 5000) throw err;
    return attempt("stealth");
  }
}

/**
 * @param {{staggerMs?: number, noBrowser?: boolean, noStealth?: boolean, cache?: object, zdr?: boolean}} config
 *   noBrowser / noStealth: the team's policy (src/tenancy.js scrapePolicy)
 *   cache: the page cache (src/page-cache.js); zdr: never read or write it
 * @returns {Promise<{doc: object, rawHtml: string, finalUrl: string, usage: object}>}
 *   rawHtml/finalUrl are returned separately so the crawler can discover
 *   links even when the caller didn't ask for those formats. usage is what
 *   the page cost, for metering: {pages, browserPages, ocrPages, aiInputTokens, aiOutputTokens}.
 */
export async function scrapeURL(url, options = {}, { staggerMs, noBrowser = false, noStealth = false, cache = null, zdr = false } = {}) {
  const opts = { ...DEFAULT_SCRAPE_OPTIONS, ...options };
  const formats = new Set(opts.formats);
  const screenshot = formats.has("screenshot@fullPage") ? "fullPage" : formats.has("screenshot") ? "viewport" : null;

  const started = Date.now();
  // Page cache: reuse a fetched page younger than maxAge; store fresh ones.
  const cacheable = !!cache && PAGE_CACHE_ENABLED && !zdr && !opts.actions?.length;
  const maxAge = opts.maxAge ?? DEFAULT_MAX_AGE_MS;
  const key = cacheable ? cacheKey(url, opts, screenshot) : null;
  let page = null;
  let cachedAt = null;
  if (cacheable && maxAge > 0) {
    const hit = await cache.get(key).catch(() => null);
    if (hit && started - hit.createdAt <= maxAge) {
      page = decodePage(hit.payload);
      cachedAt = hit.createdAt;
    }
  }
  if (!page) {
    page = await fetchWithProxyStrategy(url, { ...opts, screenshot, noBrowser }, { timeoutMs: opts.timeout, staggerMs }, noStealth);
    if (cacheable && opts.storeInCache !== false && page.statusCode < 400) {
      await cache.put(key, url, page).catch(err => console.warn(`page cache write failed: ${err.message}`));
    }
  }

  const doc = {};
  const isHtml = page.kind === "html" || page.kind === "docx";

  // Transformer stack, in Firecrawl's order: html -> markdown -> links -> metadata -> LLM.
  const cleaned = isHtml ? cleanHtml(page.html, page.url, opts) : null;
  const markdown = isHtml ? htmlToMarkdown(cleaned) : page.markdown;
  if (formats.has("markdown")) doc.markdown = markdown;
  if (formats.has("html")) doc.html = cleaned ?? undefined;
  if (formats.has("rawHtml")) doc.rawHtml = page.html ?? undefined;
  if (formats.has("links")) doc.links = page.kind === "html" ? extractLinks(page.html, page.url) : [];
  if (formats.has("images")) doc.images = page.kind === "html" ? extractImages(page.html, page.url) : [];
  if (formats.has("attributes")) doc.attributes = page.kind === "html" ? extractAttributes(page.html, opts.attributes ?? []) : [];
  if (screenshot) doc.screenshot = page.screenshot;
  if (page.actions) doc.actions = page.actions;

  doc.metadata = {
    ...(page.kind === "html" ? extractMetadata(page.html) : {}),
    ...Object.fromEntries(Object.entries(page.docMetadata ?? {}).filter(([, v]) => v !== undefined)),
    sourceURL: url,
    url: page.url,
    statusCode: page.statusCode,
    contentType: page.contentType,
    engine: page.engine,
    proxyUsed: page.proxyUsed,
    elapsedMs: Date.now() - started,
    ...(cacheable && maxAge > 0 ? { cacheState: cachedAt ? "hit" : "miss" } : {}),
    ...(cachedAt ? { cachedAt: new Date(cachedAt).toISOString() } : {}),
  };
  if (page.statusCode >= 400) doc.metadata.error = `HTTP ${page.statusCode}`;

  const warnings = [];
  if (page.reason === "javascript-shell") {
    warnings.push("Page looks JavaScript-rendered; content may be incomplete (no browser engine available).");
  }

  const usage = {
    pages: 1,
    browserPages: page.engine === "browser" && !cachedAt ? 1 : 0,
    ocrPages: doc.metadata.ocr && !cachedAt ? doc.metadata.ocrPagesProcessed ?? doc.metadata.numPages ?? 1 : 0,
  };
  const addTokens = llm => {
    const t = llmTokens(llm);
    usage.aiInputTokens = (usage.aiInputTokens ?? 0) + t.aiInputTokens;
    usage.aiOutputTokens = (usage.aiOutputTokens ?? 0) + t.aiOutputTokens;
  };
  const pageForLlm = [{ url: page.url, title: doc.metadata.title, markdown }];
  if (formats.has("json")) {
    const { data, warnings: w, usage: llm } = await extractJson(pageForLlm, opts.jsonOptions ?? {});
    doc.json = data;
    warnings.push(...w);
    addTokens(llm);
  }
  if (formats.has("summary")) {
    const { data, usage: llm } = await extractJson(pageForLlm, SUMMARY_REQUEST);
    doc.summary = data?.summary ?? "";
    addTokens(llm);
  }
  if (warnings.length) doc.warning = warnings.join(" ");

  return { doc, rawHtml: page.kind === "html" ? page.html : "", finalUrl: page.url, usage };
}
