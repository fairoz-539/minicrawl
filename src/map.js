// /map: sitemap ∪ start-page links ∪ previously seen URLs, filtered to the
// site and optionally ranked against a search string.
// Firecrawl also mixes in a `site:` web search; that needs a search provider,
// so here the third source is the local "index" of URLs we have seen.
import { fetchRobotsTxt, fetchSitemapUrls, lockKey, normalizeURL } from "./crawler.js";
import { scrapeURL } from "./scrape.js";
import { extractLinks } from "./html.js";

const bareHost = h => h.replace(/^www\./, "");

function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, "")
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);
}

function vector(tokens) {
  const v = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of a) {
    na += x * x;
    if (b.has(k)) dot += x * b.get(k);
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Rank links against a query: substring matches first, then token cosine. */
export function rankLinks(links, search, titles = new Map()) {
  const q = search.toLowerCase();
  const qv = vector(tokenize(search));
  return links
    .map((url, i) => {
      const text = `${url} ${titles.get(url) ?? ""}`;
      const substring = text.toLowerCase().includes(q) ? 1 : 0;
      return { url, i, score: substring + cosine(qv, vector(tokenize(text))) };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.url);
}

/** @param {{details?: boolean}} opts details: return [{url, title}] instead of URLs (titles of pages seen before) */
export async function getMapResults(store, url, opts = {}) {
  const { search, limit = 5000, includeSubdomains = true, sitemapOnly = false, ignoreSitemap = false, details = false } = opts;
  const start = new URL(url);
  const host = bareHost(start.hostname);
  const titles = new Map();
  const found = [];

  const sources = [];
  if (!ignoreSitemap) {
    sources.push(fetchRobotsTxt(url).then(robots => fetchSitemapUrls(url, robots)));
  }
  if (!sitemapOnly) {
    sources.push(
      scrapeURL(url, { formats: [], timeout: opts.timeout ?? 20_000 }, { staggerMs: 3000 })
        .then(({ rawHtml, finalUrl }) => [finalUrl, ...extractLinks(rawHtml, finalUrl)])
        .catch(() => []),
    );
    sources.push(
      store.seenForHost(host).then(rows =>
        rows.map(r => {
          if (r.title) titles.set(r.url, r.title);
          return r.url;
        }),
      ),
    );
  }
  for (const list of await Promise.all(sources.map(p => p.catch(() => [])))) found.push(...list);

  const seen = new Set();
  let links = [];
  for (const raw of [url, ...found]) {
    let u;
    try {
      u = new URL(normalizeURL(raw));
    } catch {
      continue;
    }
    const h = bareHost(u.hostname);
    const onSite = h === host || (includeSubdomains && h.endsWith("." + host));
    // Collapse www/http(s)/index.html/trailing-slash variants of one page.
    const key = lockKey(u.href, {});
    if (!onSite || seen.has(key)) continue;
    seen.add(key);
    links.push(u.href);
  }

  if (search) links = rankLinks(links, search, titles);
  links = links.slice(0, limit);
  return details ? links.map(u => ({ url: u, ...(titles.has(u) ? { title: titles.get(u) } : {}) })) : links;
}
