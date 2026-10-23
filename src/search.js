// /search providers, chosen like Firecrawl's self-hosted search/v2/index.ts:
// SearXNG when SEARXNG_ENDPOINT is set, otherwise DuckDuckGo's HTML endpoint.
import * as cheerio from "cheerio";
import { fetch as undiciFetch } from "undici";
import { pickProxy } from "./proxy.js";

export class SearchBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchBlockedError";
    this.code = "SEARCH_BLOCKED";
  }
}

const UA =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Google-style tbs values Firecrawl accepts -> provider time ranges.
const TBS = { "qdr:h": "d", "qdr:d": "d", "qdr:w": "w", "qdr:m": "m", "qdr:y": "y" };
const SEARX_RANGE = { d: "day", w: "week", m: "month", y: "year" };

async function searxng(query, { limit, lang, tbs, timeout }) {
  const results = [];
  for (let page = 1; results.length < limit && page <= 5; page++) {
    // Keep any sub-path the instance is mounted under (https://host/searx).
    const url = new URL(process.env.SEARXNG_ENDPOINT.replace(/\/+$/, "") + "/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", String(page));
    if (lang) url.searchParams.set("language", lang);
    if (TBS[tbs]) url.searchParams.set("time_range", SEARX_RANGE[TBS[tbs]]);
    if (process.env.SEARXNG_ENGINES) url.searchParams.set("engines", process.env.SEARXNG_ENGINES);
    const res = await undiciFetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
    const body = await res.json();
    if (!body.results?.length) break;
    for (const r of body.results) results.push({ url: r.url, title: r.title ?? "", description: r.content ?? "" });
  }
  return results;
}

function ddgResultUrl(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname === "/l/") return u.searchParams.get("uddg");
    return u.href;
  } catch {
    return null;
  }
}

/** Parse a DuckDuckGo HTML results page. `next` is the paging form, if any. */
function parseDdg(html, seen) {
  const $ = cheerio.load(html);
  const items = $(".result").not(".result--ad");
  const results = [];
  items.each((_, el) => {
    const a = $(el).find(".result__a").first();
    const url = ddgResultUrl(a.attr("href") ?? "");
    if (!url || seen.has(url) || !/^https?:/.test(url)) return;
    seen.add(url);
    results.push({ url, title: a.text().trim(), description: $(el).find(".result__snippet").text().trim() });
  });
  // The "Next" button is a form carrying the paging state.
  const nextForm = $("form").filter((_, f) => $(f).find('input[type="submit"][value*="Next"]').length > 0).first();
  const next = nextForm.length
    ? Object.fromEntries(nextForm.find("input[name]").toArray().map(i => [$(i).attr("name"), $(i).attr("value") ?? ""]))
    : null;
  return { found: items.length > 0, results, next };
}

const ddgBlocked = () =>
  new SearchBlockedError(
    "DuckDuckGo refused the request (rate limit or bot check). Set SEARXNG_ENDPOINT to use your own SearXNG instance.",
  );

async function duckduckgoHttp(query, { limit, region, df, timeout }) {
  const results = [];
  const seen = new Set();
  let form = { q: query, kl: region, ...(df ? { df } : {}) };
  for (let page = 0; results.length < limit && form && page < 5; page++) {
    const proxy = pickProxy("basic");
    const res = await undiciFetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      signal: AbortSignal.timeout(timeout),
      dispatcher: proxy?.dispatcher,
      headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded", "accept-language": "en-US,en;q=0.9" },
      body: new URLSearchParams(form).toString(),
    });
    const html = await res.text();
    const parsed = parseDdg(html, seen);
    if (!parsed.found) {
      if (res.status !== 200 || /anomaly|captcha|challenge|error getting results/i.test(html)) throw ddgBlocked();
      break;
    }
    results.push(...parsed.results);
    form = parsed.next;
  }
  return results;
}

// DuckDuckGo often refuses automated clients outright (it did in testing,
// for Node's HTTP client and headless Chromium alike). SearXNG is the
// dependable option; DuckDuckGo is a zero-setup fallback that may work.
async function duckduckgo(query, { limit, lang, country, tbs, timeout }) {
  return duckduckgoHttp(query, {
    limit,
    timeout,
    region: country && lang ? `${country.toLowerCase()}-${lang.toLowerCase()}` : "us-en",
    df: TBS[tbs],
  });
}

export async function webSearch(query, { limit = 5, lang = "en", country = "us", tbs, timeout = 15_000 } = {}) {
  const provider = process.env.SEARXNG_ENDPOINT ? searxng : duckduckgo;
  const results = await provider(query, { limit, lang, country, tbs, timeout });
  return results.slice(0, limit);
}
