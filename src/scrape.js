// scrapeURL: engine waterfall (with proxy escalation), then the transformer
// pipeline that turns the raw page into a Firecrawl-shaped Document.
import { FatalScrapeError, SiteBlockedError, scrapeWithWaterfall } from "./engines.js";
import { cleanHtml, extractLinks, extractMetadata } from "./html.js";
import { htmlToMarkdown } from "./markdown.js";
import { hasStealthPool, pickProxy } from "./proxy.js";
import { extractJson } from "./llm.js";

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

const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 503]);

/**
 * proxy "basic": basic pool (or direct). "stealth": stealth pool only.
 * "auto": basic first; if the site blocks it, retry once through the stealth
 * pool (when STEALTH_PROXY_URLS is configured). Same contract as Firecrawl.
 */
async function fetchWithProxyStrategy(url, opts, timing) {
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
  if (opts.proxy === "basic" || !hasStealthPool()) return attempt("basic");

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
 * @returns {Promise<{doc: object, rawHtml: string, finalUrl: string}>}
 *   rawHtml/finalUrl are returned separately so the crawler can discover
 *   links even when the caller didn't ask for those formats.
 */
export async function scrapeURL(url, options = {}, { staggerMs } = {}) {
  const opts = { ...DEFAULT_SCRAPE_OPTIONS, ...options };
  const formats = new Set(opts.formats);
  const screenshot = formats.has("screenshot@fullPage") ? "fullPage" : formats.has("screenshot") ? "viewport" : null;

  const started = Date.now();
  const page = await fetchWithProxyStrategy(url, { ...opts, screenshot }, { timeoutMs: opts.timeout, staggerMs });

  const doc = {};
  const isHtml = page.kind === "html" || page.kind === "docx";

  // Transformer stack, in Firecrawl's order: html -> markdown -> links -> metadata -> LLM.
  const cleaned = isHtml ? cleanHtml(page.html, page.url, opts) : null;
  const markdown = isHtml ? htmlToMarkdown(cleaned) : page.markdown;
  if (formats.has("markdown")) doc.markdown = markdown;
  if (formats.has("html")) doc.html = cleaned ?? undefined;
  if (formats.has("rawHtml")) doc.rawHtml = page.html ?? undefined;
  if (formats.has("links")) doc.links = page.kind === "html" ? extractLinks(page.html, page.url) : [];
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
  };
  if (page.statusCode >= 400) doc.metadata.error = `HTTP ${page.statusCode}`;

  const warnings = [];
  if (page.reason === "javascript-shell") {
    warnings.push("Page looks JavaScript-rendered; content may be incomplete (no browser engine available).");
  }

  if (formats.has("json")) {
    const { data, warnings: w } = await extractJson(
      [{ url: page.url, title: doc.metadata.title, markdown }],
      opts.jsonOptions ?? {},
    );
    doc.json = data;
    warnings.push(...w);
  }
  if (warnings.length) doc.warning = warnings.join(" ");

  return { doc, rawHtml: page.kind === "html" ? page.html : "", finalUrl: page.url };
}
