// Crawl rules: URL normalization/permutations, robots.txt, sitemaps and
// link filtering. Ports Firecrawl's lib/crawl-redis.ts and
// scraper/WebScraper/crawler.ts (+ native/src/crawler.rs).
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { assertPublicUrl } from "./url-guard.js";

const ROBOTS_UA = "minicrawl";
const SKIPPED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "avif",
  "css", "js", "mjs", "map", "json", "xml", "rss", "atom",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "m4a", "wav", "ogg", "webm", "mov", "avi", "mkv",
  "zip", "gz", "tgz", "rar", "7z", "tar", "exe", "dmg", "msi", "apk", "iso", "bin",
  "doc", "xls", "ppt", // legacy binary Office formats (xlsx/pptx/docx are supported)
]);

export const DENIAL_REASONS = {
  DEPTH_LIMIT: "URL path is deeper than maxDepth",
  EXCLUDE_PATTERN: "URL path matches excludePaths",
  INCLUDE_PATTERN: "URL path does not match includePaths",
  ROBOTS_TXT: "Blocked by robots.txt",
  FILE_TYPE: "URL points to a non-HTML file",
  BACKWARD_CRAWLING: "URL is outside the start URL's path and crawlEntireDomain is off",
  EXTERNAL_LINK: "URL is on another domain and allowExternalLinks is off",
  INVALID_URL: "Invalid URL",
};

export function normalizeURL(url, { ignoreQueryParameters = false } = {}) {
  const u = new URL(url);
  u.hash = "";
  if (ignoreQueryParameters) u.search = "";
  return u.href;
}

/** www/non-www x http/https x {/, bare, /index.html, /index.php}: up to 16 forms. */
export function generateURLPermutations(url) {
  const base = new URL(url);
  const hosts = base.hostname.startsWith("www.")
    ? [base.hostname, base.hostname.slice(4)]
    : ["www." + base.hostname, base.hostname];

  const paths = (() => {
    const p = base.pathname;
    let stem;
    if (p.endsWith("/index.html")) stem = p.slice(0, -"index.html".length);
    else if (p.endsWith("/index.php")) stem = p.slice(0, -"index.php".length);
    else if (p.endsWith("/")) stem = p;
    else stem = p + "/";
    const bare = stem.length > 1 ? stem.slice(0, -1) : stem;
    return [stem + "index.html", stem + "index.php", stem, bare];
  })();

  const out = new Set();
  for (const host of hosts) {
    for (const protocol of ["http:", "https:"]) {
      for (const pathname of paths) {
        const u = new URL(base);
        u.protocol = protocol;
        u.hostname = host;
        u.pathname = pathname;
        out.add(u.href);
      }
    }
  }
  return [...out];
}

/** The key a URL is locked under in the crawl's visited set. */
export function lockKey(url, crawlerOptions) {
  const normalized = normalizeURL(url, crawlerOptions);
  return crawlerOptions.deduplicateSimilarURLs === false
    ? normalized
    : generateURLPermutations(normalized).sort()[0];
}

export function getURLDepth(url) {
  return new URL(url).pathname
    .split("/")
    .filter(x => x !== "" && x !== "index.php" && x !== "index.html").length;
}

const bareHost = h => h.replace(/^www\./, "");

async function fetchText(url, signal) {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    signal: signal ?? AbortSignal.timeout(10_000),
    headers: { "user-agent": `Mozilla/5.0 (compatible; ${ROBOTS_UA}/0.1)` },
  });
  if (!res.ok) return null;
  return await res.text();
}

export async function fetchRobotsTxt(startUrl) {
  try {
    return (await fetchText(new URL("/robots.txt", startUrl).href)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Collect page URLs from sitemaps (robots.txt `Sitemap:` lines, or
 * /sitemap.xml), following sitemap indexes up to a bounded depth.
 */
export async function fetchSitemapUrls(startUrl, robotsTxt = "", { maxSitemaps = 50, maxUrls = 50_000 } = {}) {
  const fromRobots = [...robotsTxt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]);
  const queue = fromRobots.length ? fromRobots : [new URL("/sitemap.xml", startUrl).href];
  const seen = new Set();
  const urls = new Set();

  while (queue.length && seen.size < maxSitemaps && urls.size < maxUrls) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml;
    try {
      xml = await fetchText(sm);
    } catch {
      continue;
    }
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    const $ = cheerio.load(xml, { xmlMode: true });
    $("sitemap > loc").each((_, el) => queue.push($(el).text().trim()));
    $("url > loc").each((_, el) => {
      if (urls.size < maxUrls) urls.add($(el).text().trim());
    });
  }
  return [...urls];
}

export class Crawler {
  /**
   * @param {string} startUrl
   * @param {object} o crawlerOptions
   * @param {string} robotsTxt
   */
  constructor(startUrl, o, robotsTxt = "") {
    this.start = new URL(startUrl);
    this.o = o;
    this.robots = robotsParser(new URL("/robots.txt", startUrl).href, robotsTxt);
    this.maxPathDepth = (o.maxDepth ?? Infinity) + getURLDepth(startUrl);
    this.include = (o.includePaths ?? []).map(p => new RegExp(p));
    this.exclude = (o.excludePaths ?? []).map(p => new RegExp(p));
    // Path prefix new links must sit under (segment-aware), unless crawlEntireDomain.
    const p = this.start.pathname;
    if (p.endsWith("/")) this.basePath = p;
    else if (/\.[a-z0-9]+$/i.test(p)) this.basePath = p.slice(0, p.lastIndexOf("/") + 1);
    else this.basePath = p + "/";
  }

  robotsDelay() {
    return this.robots.getCrawlDelay(ROBOTS_UA) ?? null;
  }

  /** Returns null when allowed, otherwise a DENIAL_REASONS key. */
  denialReason(link) {
    let u;
    try {
      u = new URL(link);
    } catch {
      return "INVALID_URL";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "INVALID_URL";

    const sameHost = bareHost(u.hostname) === bareHost(this.start.hostname);
    const isSubdomain = u.hostname.endsWith("." + bareHost(this.start.hostname));
    if (!sameHost && !(this.o.allowSubdomains && isSubdomain) && !this.o.allowExternalLinks) {
      return "EXTERNAL_LINK";
    }

    const ext = u.pathname.split(".").pop().toLowerCase();
    if (u.pathname.includes(".") && SKIPPED_EXTENSIONS.has(ext)) return "FILE_TYPE";

    if (getURLDepth(u.href) > this.maxPathDepth) return "DEPTH_LIMIT";

    if (sameHost && !this.o.crawlEntireDomain && !this.o.allowBackwardLinks) {
      const path = u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
      if (!path.startsWith(this.basePath) && u.pathname !== this.start.pathname) return "BACKWARD_CRAWLING";
    }

    const target = this.o.regexOnFullURL ? u.href : u.pathname;
    if (this.exclude.some(r => r.test(target))) return "EXCLUDE_PATTERN";
    if (this.include.length && !this.include.some(r => r.test(target))) return "INCLUDE_PATTERN";

    if (!this.o.ignoreRobotsTxt && this.robots.isAllowed(u.href, ROBOTS_UA) === false) return "ROBOTS_TXT";
    return null;
  }

  filterLinks(links) {
    const allowed = new Set();
    const robotsBlocked = [];
    const denied = {};
    for (const link of links) {
      const reason = this.denialReason(link);
      if (!reason) allowed.add(normalizeURL(link, this.o));
      else {
        denied[link] = DENIAL_REASONS[reason];
        if (reason === "ROBOTS_TXT") robotsBlocked.push(link);
      }
    }
    return { links: [...allowed], robotsBlocked, denied };
  }
}
