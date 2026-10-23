// HTML cleaning, metadata and link extraction.
// Port of the rules in Firecrawl's apps/api/native/src/html.rs.
import * as cheerio from "cheerio";

// Removed when onlyMainContent is on (same 42 selectors as Firecrawl).
const EXCLUDE_NON_MAIN_TAGS = [
  "header", "footer", "nav", "aside", ".header", ".top", ".navbar", "#header",
  ".footer", ".bottom", "#footer", ".sidebar", ".side", ".aside", "#sidebar",
  ".modal", ".popup", "#modal", ".overlay", ".ad", ".ads", ".advert", "#ad",
  ".lang-selector", ".language", "#language-selector", ".social", ".social-media",
  ".social-links", "#social", ".menu", ".navigation", "#nav", ".breadcrumbs",
  "#breadcrumbs", ".share", "#share", ".widget", "#widget", ".cookie", "#cookie",
  ".fc-decoration",
];

// An excluded element survives if it wraps one of these.
const FORCE_INCLUDE_MAIN_TAGS = ["#main"];

const ALWAYS_REMOVE = "script, style, noscript, template, link, meta, head, iframe, object, embed";

/** The URL relative links resolve against, honoring <base href>. */
export function resolveBaseUrl($, pageUrl) {
  const href = $("base[href]").first().attr("href");
  if (!href) return pageUrl;
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return pageUrl;
  }
}

function absolutize($, baseUrl) {
  const fix = (el, attr) => {
    const v = $(el).attr(attr);
    if (!v || v.startsWith("data:") || v.startsWith("#") || v.startsWith("javascript:")) return;
    try {
      $(el).attr(attr, new URL(v, baseUrl).href);
    } catch {}
  };
  $("a[href]").each((_, el) => fix(el, "href"));
  $("img[src], video[src], audio[src], source[src]").each((_, el) => fix(el, "src"));
  // Prefer the largest srcset candidate as src, like Firecrawl does.
  $("img[srcset]").each((_, el) => {
    const best = $(el)
      .attr("srcset")
      .split(",")
      .map(s => s.trim().split(/\s+/))
      .filter(([u]) => u)
      .map(([u, d = "1x"]) => ({ u, w: parseFloat(d) || 1 }))
      .sort((a, b) => b.w - a.w)[0];
    if (best) {
      try {
        $(el).attr("src", new URL(best.u, baseUrl).href);
      } catch {}
    }
    $(el).removeAttr("srcset");
  });
}

export function cleanHtml(html, pageUrl, { onlyMainContent = true, includeTags = [], excludeTags = [] } = {}) {
  let $ = cheerio.load(html);
  const baseUrl = resolveBaseUrl($, pageUrl);

  $(ALWAYS_REMOVE).remove();

  const include = includeTags.map(t => t.trim()).filter(Boolean);
  if (include.length > 0) {
    const kept = include.flatMap(sel => $(sel).toArray().map(el => $.html(el)));
    $ = cheerio.load(`<div>${kept.join("")}</div>`);
  }

  for (const sel of excludeTags.map(t => t.trim()).filter(Boolean)) $(sel).remove();

  if (onlyMainContent) {
    for (const sel of EXCLUDE_NON_MAIN_TAGS) {
      $(sel).each((_, el) => {
        const wrapsMain = FORCE_INCLUDE_MAIN_TAGS.some(f => $(el).find(f).length > 0);
        if (!wrapsMain) $(el).remove();
      });
    }
  }

  absolutize($, baseUrl);
  const body = $("body");
  return (body.length ? body.html() : $.root().html()) ?? "";
}

export function extractMetadata(html) {
  const $ = cheerio.load(html);
  const meta = {};
  const title = $("title").first().text().trim();
  if (title) meta.title = title;
  const lang = $("html").attr("lang");
  if (lang) meta.language = lang;

  // Every <meta name|property|itemprop>, multi-valued keys become arrays.
  $("meta").each((_, el) => {
    const key = $(el).attr("name") ?? $(el).attr("property") ?? $(el).attr("itemprop");
    const content = $(el).attr("content");
    if (!key || content == null) return;
    if (meta[key] === undefined) meta[key] = content;
    else if (Array.isArray(meta[key])) meta[key].push(content);
    else if (meta[key] !== content) meta[key] = [meta[key], content];
  });

  // Friendly aliases matching Firecrawl's metadata keys.
  const alias = { ogTitle: "og:title", ogDescription: "og:description", ogUrl: "og:url",
    ogImage: "og:image", ogSiteName: "og:site_name", ogLocale: "og:locale" };
  for (const [k, src] of Object.entries(alias)) if (meta[src] !== undefined) meta[k] = meta[src];

  const favicon = $('link[rel~="icon"]').first().attr("href");
  if (favicon) meta.favicon = favicon;
  const canonical = $('link[rel="canonical"]').first().attr("href");
  if (canonical) meta.canonical = canonical;
  return meta;
}

/** All http(s) links on the page, absolute, without fragments, deduplicated. */
export function extractLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const baseUrl = resolveBaseUrl($, pageUrl);
  const out = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) return;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      u.hash = "";
      out.add(u.href);
    } catch {}
  });
  return [...out];
}
