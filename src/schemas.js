// Request schemas for every endpoint. The server validates with these and
// src/openapi.js turns them into the OpenAPI spec, so docs and validation
// cannot drift apart. `.describe()` text shows up on the /docs page.
import { z } from "zod";

const withScheme = s => (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);

export const httpUrl = z
  .string()
  .trim()
  .transform(withScheme)
  .pipe(z.string().url())
  .refine(s => /^https?:/i.test(s), "URL uses unsupported protocol")
  .describe("http(s) URL. A missing scheme defaults to https://");

// Sent by the official Firecrawl SDKs on every request. Accepted and ignored,
// as the real Firecrawl API does, so the SDKs work against minicrawl.
const clientMeta = {
  origin: z.string().max(200).optional().describe("Client identifier sent by SDKs (ignored)"),
  integration: z.string().max(200).optional().describe("Integration name sent by SDKs (ignored)"),
};

// Firecrawl's page actions.
export const action = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("wait"),
        milliseconds: z.number().int().min(1).max(60_000).optional().describe("Fixed wait"),
        selector: z.string().min(1).optional().describe("Wait until this CSS selector is visible"),
      })
      .strict()
      .describe("Wait for a time or for an element (one of milliseconds / selector)"),
    z
      .object({
        type: z.literal("click"),
        selector: z.string().min(1),
        all: z.boolean().default(false).describe("Click every match, not just the first"),
      })
      .strict()
      .describe("Click an element"),
    z
      .object({
        type: z.literal("write"),
        text: z.string(),
        selector: z.string().min(1).optional().describe("Input to fill; without it, types into the focused element"),
      })
      .strict()
      .describe("Type text"),
    z.object({ type: z.literal("press"), key: z.string().min(1).describe("e.g. Enter, Tab, ArrowDown") }).strict().describe("Press a key"),
    z
      .object({
        type: z.literal("scroll"),
        direction: z.enum(["up", "down"]).default("down"),
        selector: z.string().min(1).optional().describe("Scroll inside this element instead of the page"),
        amount: z.number().int().min(1).max(50).optional().describe("Screens to scroll (default 1)"),
      })
      .strict()
      .describe("Scroll the page or an element"),
    z.object({ type: z.literal("screenshot"), fullPage: z.boolean().default(false) }).strict().describe("Take a screenshot"),
    z.object({ type: z.literal("scrape") }).strict().describe("Capture the page's current URL and HTML"),
    z
      .object({ type: z.literal("executeJavascript"), script: z.string().min(1).describe("JS expression; its value is returned") })
      .strict()
      .describe("Run JavaScript in the page"),
  ])
  .describe("A browser action, run in order before the page is captured");

export const jsonOptions = z
  .object({
    schema: z.record(z.any()).optional().describe("JSON Schema for the result"),
    prompt: z.string().min(1).optional().describe("What to extract, in plain language"),
    systemPrompt: z.string().optional().describe("Extra instructions for the model"),
  })
  .strict()
  .describe("AI extraction settings for the json format (schema and/or prompt)");

export const scrapeOptions = z
  .object({
    formats: z
      .array(
        z.enum(["markdown", "html", "rawHtml", "links", "images", "screenshot", "screenshot@fullPage", "json", "summary", "attributes"]),
      )
      .default(["markdown"])
      .describe("What to return. json and summary need ANTHROPIC_API_KEY; json needs jsonOptions, attributes needs attributes"),
    jsonOptions: jsonOptions.optional(),
    attributes: z
      .array(z.object({ selector: z.string().min(1), attribute: z.string().min(1) }).strict())
      .max(50)
      .optional()
      .describe("For the attributes format: CSS selector and attribute name pairs"),
    actions: z.array(action).max(50).optional().describe("Browser actions (forces the browser engine)"),
    proxy: z
      .enum(["auto", "basic", "stealth"])
      .default("auto")
      .describe("auto: basic pool, retried through STEALTH_PROXY_URLS when blocked"),
    skipTlsVerification: z.boolean().default(false),
    onlyMainContent: z.boolean().default(true).describe("Drop headers, footers, navigation, ads and cookie banners"),
    includeTags: z.array(z.string()).default([]).describe("Keep only these CSS selectors"),
    excludeTags: z.array(z.string()).default([]).describe("Remove these CSS selectors"),
    headers: z.record(z.string()).default({}).describe("Extra request headers"),
    waitFor: z.number().int().min(0).max(60_000).default(0).describe("Milliseconds to wait after load (uses the browser)"),
    timeout: z.number().int().min(1000).max(300_000).default(30_000).describe("Milliseconds before giving up"),
    engine: z.enum(["auto", "fetch", "browser"]).default("auto").describe("Force an engine; auto picks per page"),
  })
  .strict();

export function checkScrapeOptions(o, ctx, path = []) {
  if (o.formats?.includes("attributes") && !o.attributes?.length) {
    ctx.addIssue({ code: "custom", path: [...path, "attributes"], message: "The attributes format needs attributes: [{selector, attribute}]" });
  }
  if (o.formats?.includes("json") && !o.jsonOptions?.schema && !o.jsonOptions?.prompt) {
    ctx.addIssue({ code: "custom", path: [...path, "jsonOptions"], message: "The json format needs jsonOptions.schema or jsonOptions.prompt" });
  }
  o.actions?.forEach((a, i) => {
    if (a.type === "wait" && !a.milliseconds && !a.selector) {
      ctx.addIssue({ code: "custom", path: [...path, "actions", i], message: "wait needs milliseconds or selector" });
    }
  });
}

export const scrapeBody = scrapeOptions
  .extend({ url: httpUrl, ...clientMeta })
  .strict()
  .superRefine((o, ctx) => checkScrapeOptions(o, ctx));

export const webhook = z
  .union([
    httpUrl,
    z.object({
      url: httpUrl,
      headers: z.record(z.string()).optional(),
      metadata: z.record(z.any()).optional().describe("Echoed back in every webhook payload"),
      events: z.array(z.enum(["started", "page", "completed", "failed"])).optional().describe("Default: all"),
    }),
  ])
  .describe("URL (or settings) to POST crawl events to");

export const crawlBody = z
  .object({
    url: httpUrl,
    limit: z.number().int().min(1).max(100_000).default(10_000).describe("Max pages"),
    maxDepth: z.number().int().min(0).default(10).describe("Max URL path depth below the start URL"),
    maxDiscoveryDepth: z.number().int().min(0).optional().describe("Max link hops from the start page"),
    includePaths: z.array(z.string()).default([]).describe("Regexes; only matching paths are crawled"),
    excludePaths: z.array(z.string()).default([]).describe("Regexes; matching paths are skipped"),
    regexOnFullURL: z.boolean().default(false).describe("Match include/exclude against the full URL, not the path"),
    allowExternalLinks: z.boolean().default(false),
    allowSubdomains: z.boolean().default(false),
    allowBackwardLinks: z.boolean().default(false).describe("Allow pages outside the start URL's path"),
    crawlEntireDomain: z.boolean().default(false).describe("Same as allowBackwardLinks"),
    ignoreRobotsTxt: z.boolean().default(false),
    ignoreSitemap: z.boolean().default(false),
    ignoreQueryParameters: z.boolean().default(false).describe("Treat ?a=1 and ?a=2 as the same page"),
    deduplicateSimilarURLs: z.boolean().default(true).describe("Treat www/http(s)/index.html/trailing-slash variants as one page"),
    delay: z.number().min(0).max(60).optional().describe("Seconds to wait before each page (politeness)"),
    scrapeOptions: scrapeOptions.default({}),
    webhook: webhook.optional(),
    ...clientMeta,
  })
  .strict()
  .superRefine((b, ctx) => {
    checkScrapeOptions(b.scrapeOptions, ctx, ["scrapeOptions"]);
    for (const key of ["includePaths", "excludePaths"]) {
      for (const p of b[key]) {
        try {
          new RegExp(p);
        } catch {
          ctx.addIssue({ code: "custom", path: [key], message: `Invalid regex in ${key}: ${p}` });
        }
      }
    }
  });

export const batchBody = scrapeOptions
  .extend({
    urls: z.array(z.string()).min(1).max(10_000).describe("Pages to scrape"),
    webhook: webhook.optional(),
    ignoreInvalidURLs: z.boolean().default(false).describe("Skip invalid or blocked URLs (listed in invalidURLs) instead of failing"),
    appendToId: z.string().uuid().optional().describe("Add these URLs to an existing batch"),
    maxConcurrency: z.number().int().positive().optional().describe("Accepted for compatibility; the team's concurrency limit applies"),
    zeroDataRetention: z.boolean().optional().describe("Zero data retention for this batch"),
    ...clientMeta,
  })
  .strict()
  .superRefine((o, ctx) => checkScrapeOptions(o, ctx));

export const mapBody = z
  .object({
    url: httpUrl,
    search: z.string().optional().describe("Rank URLs by relevance to this text"),
    limit: z.number().int().min(1).max(100_000).default(5000),
    includeSubdomains: z.boolean().default(true),
    sitemapOnly: z.boolean().default(false).describe("Only return sitemap URLs"),
    ignoreSitemap: z.boolean().default(false),
    timeout: z.number().int().min(1000).max(120_000).optional(),
    ...clientMeta,
  })
  .strict();

export const searchBody = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(50).default(5),
    lang: z.string().default("en"),
    country: z.string().default("us"),
    tbs: z.string().optional().describe("Time filter: qdr:d (day), qdr:w, qdr:m, qdr:y"),
    timeout: z.number().int().min(1000).max(120_000).default(60_000),
    scrapeOptions: scrapeOptions.optional().describe("If given, every result is scraped with these options"),
    ...clientMeta,
  })
  .strict()
  .superRefine((b, ctx) => b.scrapeOptions && checkScrapeOptions(b.scrapeOptions, ctx, ["scrapeOptions"]));

export const extractBody = z
  .object({
    urls: z
      .array(z.string().trim().transform(withScheme))
      .max(10)
      .default([])
      .refine(
        list =>
          list.every(u => {
            try {
              return /^https?:$/.test(new URL(u.replace(/\/\*$/, "")).protocol);
            } catch {
              return false;
            }
          }),
        "Every URL must be http(s), optionally ending in /*",
      )
      .describe("Pages to read. https://site.com/* expands to the site's most relevant pages. Without URLs, the prompt is searched on the web"),
    prompt: z.string().min(1).optional().describe("What to extract"),
    schema: z.record(z.any()).optional().describe("JSON Schema for the result"),
    systemPrompt: z.string().optional(),
    enableWebSearch: z.boolean().default(false).describe("Also read the top 3 web search results for the prompt"),
    showSources: z.boolean().default(false).describe("Include the URLs that were read"),
    scrapeOptions: scrapeOptions.omit({ formats: true, jsonOptions: true, actions: true }).partial().optional(),
    ...clientMeta,
  })
  .strict()
  .refine(b => b.prompt || b.schema, "Provide a prompt, a schema, or both")
  .refine(b => b.urls.length || b.prompt, "Provide urls, or a prompt to search the web with")
  // No URLs: find the pages with a web search for the prompt.
  .transform(b => (b.urls.length ? b : { ...b, enableWebSearch: true }));
