// OpenAPI spec (/openapi.json) and the interactive explorer (/docs).
// Request bodies are generated from src/schemas.js; responses are written
// out here. Swagger UI is served from the swagger-ui-dist package, so the
// docs page works offline (no CDN).
import express from "express";
import { readFileSync } from "node:fs";
import swaggerUi from "swagger-ui-dist";
import { z } from "zod";
import { batchBody, crawlBody, extractBody, mapBody, scrapeBody, searchBody } from "./schemas.js";
import { batchBodyV2, crawlBodyV2, extractBodyV2, mapBodyV2, scrapeBodyV2, searchBodyV2 } from "./v2.js";
import { keyCreateBody, orgUpdateBody, teamCreateBody, teamUpdateBody } from "./admin.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const fromZod = schema => {
  const json = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io: "input",
    unrepresentable: "any",
    // z.number().int() implies the safe-integer range; it's noise in the docs.
    override: ({ jsonSchema: s }) => {
      if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
      if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
    },
  });
  delete json.$schema;
  return json;
};

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ "application/json": { schema, ...(example ? { example } : {}) } });
const body = (name, example) => ({ required: true, content: json(ref(name), example) });
const ok = (description, schema, example) => ({ description, content: json(schema, example) });

const TEAM_403 =
  "`FORBIDDEN` (role or key scopes), `FEATURE_DISABLED`, `DOMAIN_NOT_ALLOWED` (organization domain policy), " +
  "`IP_NOT_ALLOWED` (team IP allowlist), `TEAM_DISABLED`";
const ERRORS = {
  400: { description: "Invalid request body (`BAD_REQUEST`)", content: json(ref("Error")) },
  401: { description: "Missing, wrong, revoked or expired API key (`UNAUTHORIZED`)", content: json(ref("Error")) },
  402: { description: "`QUOTA_EXCEEDED`: the team's daily or monthly pages are used up (see Retry-After)", content: json(ref("Error")) },
  403: { description: TEAM_403, content: json(ref("Error")) },
  429: { description: "`RATE_LIMITED`: the team's requests per minute (see Retry-After)", content: json(ref("Error")) },
};
const ADMIN_ERRORS = {
  400: ERRORS[400],
  401: ERRORS[401],
  403: { description: "`FORBIDDEN`: your role can't do this (see the role table in docs/ADMIN.md)", content: json(ref("Error")) },
  404: { description: "No such team or key in your organization", content: json(ref("Error")) },
};
const scrapeErrors = {
  ...ERRORS,
  403: {
    description: `\`BLOCKED_URL\` (private address), \`BLOCKED_BY_SITE\` (bot protection), ${TEAM_403}`,
    content: json(ref("Error")),
  },
  408: { description: "`SCRAPE_TIMEOUT`", content: json(ref("Error")) },
  422: {
    description: "`UNSUPPORTED_FILE`, `ACTION_FAILED`, `NO_BROWSER`, `NO_STEALTH_PROXY`, `LLM_REFUSAL`",
    content: json(ref("Error")),
  },
  503: { description: "`LLM_NOT_CONFIGURED` (json format without ANTHROPIC_API_KEY)", content: json(ref("Error")) },
};
const notFound = { 404: { description: "Unknown id", content: json(ref("Error")) } };
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const skipParam = { name: "skip", in: "query", schema: { type: "integer", minimum: 0 }, description: "Pages to skip (paging; see next)" };
const teamIdParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Team id (\"default\" for the default team)" };

const documentSchema = {
  type: "object",
  description: "A scraped page. Only the requested formats are present.",
  properties: {
    markdown: { type: "string" },
    html: { type: "string", description: "Cleaned HTML" },
    rawHtml: { type: "string" },
    links: { type: "array", items: { type: "string" } },
    screenshot: { type: "string", description: "data:image/png;base64,…" },
    json: { description: "AI-extracted data (json format)" },
    actions: {
      type: "object",
      properties: {
        screenshots: { type: "array", items: { type: "string" } },
        scrapes: { type: "array", items: { type: "object", properties: { url: { type: "string" }, html: { type: "string" } } } },
        javascriptReturns: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: {} } } },
      },
    },
    warning: { type: "string" },
    metadata: {
      type: "object",
      additionalProperties: true,
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        language: { type: "string" },
        sourceURL: { type: "string", description: "URL you asked for" },
        url: { type: "string", description: "URL after redirects" },
        statusCode: { type: "integer" },
        contentType: { type: "string" },
        engine: { type: "string", enum: ["fetch", "browser"] },
        proxyUsed: { type: "string", enum: ["basic", "stealth"] },
        elapsedMs: { type: "integer" },
        ocr: { type: "boolean" },
        numPages: { type: "integer" },
        error: { type: "string" },
      },
    },
  },
};

const exampleDoc = {
  markdown: "# Example Domain\n\nThis domain is for use in documentation examples…",
  metadata: {
    title: "Example Domain",
    sourceURL: "https://example.com",
    url: "https://example.com/",
    statusCode: 200,
    contentType: "text/html",
    engine: "fetch",
    proxyUsed: "basic",
    elapsedMs: 412,
  },
};

export function buildSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "minicrawl API",
      version,
      description: [
        "Self-hosted, Firecrawl-compatible (v1) web scraping API.",
        "",
        "Every `/v1` endpoint needs `Authorization: Bearer <API_KEY>` when the server has a key configured.",
        "Click **Authorize** and paste your key to try requests from this page.",
      ].join("\n"),
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "API_KEY from .env, or a key from POST /admin/v1/keys" } },
      schemas: {
        ScrapeRequest: fromZod(scrapeBody),
        CrawlRequest: fromZod(crawlBody),
        MapRequest: fromZod(mapBody),
        SearchRequest: fromZod(searchBody),
        ExtractRequest: fromZod(extractBody),
        BatchScrapeRequest: fromZod(batchBody),
        ScrapeRequestV2: fromZod(scrapeBodyV2),
        BatchScrapeRequestV2: fromZod(batchBodyV2),
        CrawlRequestV2: fromZod(crawlBodyV2),
        MapRequestV2: fromZod(mapBodyV2),
        SearchRequestV2: fromZod(searchBodyV2),
        ExtractRequestV2: fromZod(extractBodyV2),
        TeamCreate: fromZod(teamCreateBody),
        TeamUpdate: fromZod(teamUpdateBody),
        OrgUpdate: fromZod(orgUpdateBody),
        KeyCreate: fromZod(keyCreateBody),
        Document: documentSchema,
        Error: {
          type: "object",
          properties: {
            success: { type: "boolean", enum: [false] },
            code: { type: "string", example: "BAD_REQUEST" },
            error: { type: "string" },
            details: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Scrape", description: "Single pages, files and screenshots" },
      { name: "Crawl", description: "Whole sites, asynchronously" },
      { name: "Map", description: "List a site's URLs" },
      { name: "Search", description: "Web search via SearXNG" },
      { name: "Extract", description: "AI extraction with Claude (needs ANTHROPIC_API_KEY)" },
      { name: "Batch", description: "Many URLs at once, asynchronously" },
      { name: "v2", description: "Firecrawl v2 API: the shapes of the current Firecrawl SDKs (Firecrawl / firecrawl-py v2 clients)" },
      { name: "System" },
      { name: "Admin", description: "Teams, API keys, limits, usage and the audit log (see docs/ADMIN.md)" },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["System"],
          summary: "Health and enabled features",
          security: [],
          responses: {
            200: ok("Server is up", { type: "object" }, {
              status: "ok",
              version,
              auth: true,
              db: true,
              features: { browser: true, ocr: true, ai: false, search: "searxng", proxies: { basic: 0, stealth: 0 } },
            }),
          },
        },
      },
      "/mcp": {
        post: {
          tags: ["System"],
          summary: "MCP endpoint for AI agents",
          description:
            "Model Context Protocol server (Streamable HTTP, stateless) exposing minicrawl_scrape, minicrawl_map, " +
            "minicrawl_search, minicrawl_crawl, minicrawl_crawl_status, minicrawl_extract and minicrawl_extract_status. " +
            "Connect an MCP client (Claude Code, Cursor, VS Code) instead of calling it by hand. See docs/INTEGRATIONS.md.",
          requestBody: { required: true, content: json({ type: "object", description: "JSON-RPC 2.0 message" }) },
          responses: { 200: { description: "JSON-RPC response" }, ...ERRORS },
        },
      },
      "/v1/scrape": {
        post: {
          tags: ["Scrape"],
          summary: "Scrape one URL",
          description:
            "Returns the page as markdown and/or other formats. Handles JavaScript pages (browser), PDFs, " +
            "DOCX/XLSX/PPTX, images (OCR), screenshots, browser actions and AI extraction (json format).",
          requestBody: body("ScrapeRequest", { url: "https://example.com", formats: ["markdown", "links"] }),
          responses: {
            200: ok("Scraped document", { type: "object", properties: { success: { type: "boolean" }, data: ref("Document") } }, {
              success: true,
              data: exampleDoc,
            }),
            ...scrapeErrors,
          },
        },
      },
      "/v1/crawl": {
        post: {
          tags: ["Crawl"],
          summary: "Start a crawl",
          requestBody: body("CrawlRequest", { url: "https://books.toscrape.com", limit: 20, crawlEntireDomain: true }),
          responses: {
            200: ok("Crawl started", { type: "object" }, {
              success: true,
              id: "4c9f8e0e-2b8a-4a51-9c3e-1d2f3a4b5c6d",
              url: "http://localhost:3002/v1/crawl/4c9f8e0e-2b8a-4a51-9c3e-1d2f3a4b5c6d",
            }),
            ...ERRORS,
          },
        },
      },
      "/v1/crawl/{id}": {
        get: {
          tags: ["Crawl"],
          summary: "Crawl status and results",
          description: "Documents are returned 100 at a time; follow `next` for more.",
          parameters: [idParam, { name: "skip", in: "query", schema: { type: "integer", minimum: 0 } }],
          responses: {
            200: ok(
              "Status",
              {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  status: { type: "string", enum: ["scraping", "completed", "cancelled", "failed"] },
                  total: { type: "integer" },
                  completed: { type: "integer" },
                  creditsUsed: { type: "integer" },
                  expiresAt: { type: "string", format: "date-time" },
                  next: { type: "string", description: "Present only when more pages remain" },
                  data: { type: "array", items: ref("Document") },
                },
              },
              { success: true, status: "completed", total: 1, completed: 1, creditsUsed: 1, data: [exampleDoc] },
            ),
            ...ERRORS,
            ...notFound,
          },
        },
        delete: {
          tags: ["Crawl"],
          summary: "Cancel a crawl",
          parameters: [idParam],
          responses: { 200: ok("Cancelled", { type: "object" }, { success: true, status: "cancelled" }), ...ERRORS, ...notFound },
        },
      },
      "/v1/crawl/{id}/errors": {
        get: {
          tags: ["Crawl"],
          summary: "Failed pages and robots.txt-blocked URLs",
          parameters: [idParam],
          responses: {
            200: ok("Errors", { type: "object" }, {
              errors: [{ id: "…", url: "https://example.com/broken", error: "Scrape timed out after 30000ms" }],
              robotsBlocked: ["https://example.com/private/page"],
            }),
            ...ERRORS,
            ...notFound,
          },
        },
        delete: {
          tags: ["Crawl"],
          summary: "Same as GET (compatibility alias)",
          description: "The Firecrawl JS SDK's v1 `checkCrawlErrors()` uses DELETE. Read-only: nothing is deleted.",
          deprecated: true,
          parameters: [idParam],
          responses: { 200: { description: "Same as GET" }, ...ERRORS, ...notFound },
        },
      },
      "/v1/map": {
        post: {
          tags: ["Map"],
          summary: "List a site's URLs",
          description: "Combines the sitemap, links on the start page and URLs seen before. `search` ranks by relevance.",
          requestBody: body("MapRequest", { url: "https://books.toscrape.com", search: "travel", limit: 10 }),
          responses: {
            200: ok("URLs", { type: "object", properties: { success: { type: "boolean" }, links: { type: "array", items: { type: "string" } } } }, {
              success: true,
              links: ["https://books.toscrape.com/catalogue/category/books/travel_2/index.html"],
            }),
            ...ERRORS,
          },
        },
      },
      "/v1/search": {
        post: {
          tags: ["Search"],
          summary: "Web search",
          description: "Uses SEARXNG_ENDPOINT (bundled in docker compose). With `scrapeOptions`, each result is also scraped.",
          requestBody: body("SearchRequest", { query: "firecrawl", limit: 5 }),
          responses: {
            200: ok("Results", { type: "object" }, {
              success: true,
              data: [{ url: "https://www.firecrawl.dev/", title: "Firecrawl", description: "…" }],
            }),
            ...ERRORS,
            503: { description: "`SEARCH_BLOCKED` (no SearXNG and DuckDuckGo refused)", content: json(ref("Error")) },
          },
        },
      },
      "/v1/extract": {
        post: {
          tags: ["Extract"],
          summary: "Start an AI extraction across URLs",
          requestBody: body("ExtractRequest", {
            urls: ["https://books.toscrape.com/*"],
            prompt: "List book titles and prices",
            showSources: true,
          }),
          responses: { 200: ok("Started", { type: "object" }, { success: true, id: "…", urlTrace: [] }), ...ERRORS },
        },
      },
      "/v1/extract/{id}": {
        get: {
          tags: ["Extract"],
          summary: "Extraction status and result",
          parameters: [idParam],
          responses: {
            200: ok(
              "Status",
              {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  status: { type: "string", enum: ["processing", "completed", "failed"] },
                  data: {},
                  sources: { type: "array", items: { type: "string" } },
                  warning: { type: "string" },
                  failedUrls: { type: "array", items: { type: "object" } },
                  error: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
              { success: true, status: "completed", data: { books: [{ title: "A Light in the Attic", price: "£51.77" }] } },
            ),
            ...ERRORS,
            ...notFound,
          },
        },
      },
      "/v1/batch/scrape": {
        post: {
          tags: ["Batch"],
          summary: "Scrape a list of URLs (async)",
          description: "Scrape options are top-level, as in /v1/scrape. Returns an id; check it with GET /v1/batch/scrape/{id}.",
          requestBody: body("BatchScrapeRequest", { urls: ["https://example.com", "https://example.org"], formats: ["markdown"] }),
          responses: { 200: ok("Started", { type: "object" }, { success: true, id: "…", url: "http://localhost:3002/v1/batch/scrape/…" }), ...ERRORS },
        },
      },
      "/v1/batch/scrape/{id}": {
        get: { tags: ["Batch"], summary: "Batch status and pages (same shape as crawl status)", parameters: [idParam, skipParam], responses: { 200: ok("Status", { type: "object" }), ...ERRORS, ...notFound } },
        delete: { tags: ["Batch"], summary: "Cancel a batch", parameters: [idParam], responses: { 200: ok("Cancelled", { type: "object" }), ...ERRORS, ...notFound } },
      },
      "/v1/batch/scrape/{id}/errors": {
        get: { tags: ["Batch"], summary: "Failed pages", parameters: [idParam], responses: { 200: ok("Errors", { type: "object" }), ...ERRORS, ...notFound } },
      },
      "/v2/scrape": {
        post: {
          tags: ["v2"],
          summary: "Scrape a URL (v2)",
          description: "Formats are strings or objects: markdown, html, rawHtml, links, images, summary, {type: json, schema, prompt}, {type: screenshot, fullPage}, {type: attributes, selectors}.",
          requestBody: body("ScrapeRequestV2", { url: "https://example.com", formats: ["markdown", { type: "json", prompt: "the page title" }] }),
          responses: { 200: ok("Document", { type: "object", properties: { success: { type: "boolean" }, data: ref("Document") } }), ...scrapeErrors },
        },
      },
      "/v2/batch/scrape": {
        post: {
          tags: ["v2"],
          summary: "Batch scrape (v2)",
          requestBody: body("BatchScrapeRequestV2", { urls: ["https://example.com", "https://example.org"], formats: ["markdown"] }),
          responses: { 200: ok("Started", { type: "object" }, { success: true, id: "…", url: "…", invalidURLs: [] }), ...ERRORS },
        },
      },
      "/v2/batch/scrape/{id}": {
        get: { tags: ["v2"], summary: "Batch status and pages", parameters: [idParam, skipParam], responses: { 200: ok("Status", { type: "object" }), ...ERRORS, ...notFound } },
        delete: { tags: ["v2"], summary: "Cancel a batch", parameters: [idParam], responses: { 200: ok("Cancelled", { type: "object" }), ...ERRORS, ...notFound } },
      },
      "/v2/batch/scrape/{id}/errors": {
        get: { tags: ["v2"], summary: "Failed pages of a batch", parameters: [idParam], responses: { 200: ok("Errors", { type: "object" }), ...ERRORS, ...notFound } },
      },
      "/v2/crawl": {
        post: {
          tags: ["v2"],
          summary: "Crawl a site (v2)",
          description: "sitemap: include (default), skip, or only. maxDiscoveryDepth bounds link hops; delay waits between pages.",
          requestBody: body("CrawlRequestV2", { url: "https://example.com", limit: 50, sitemap: "include", scrapeOptions: { formats: ["markdown"] } }),
          responses: { 200: ok("Started", { type: "object" }, { success: true, id: "…", url: "…" }), ...ERRORS },
        },
      },
      "/v2/crawl/active": {
        get: { tags: ["v2"], summary: "Your team's running crawls", responses: { 200: ok("Crawls", { type: "object" }), ...ERRORS } },
      },
      "/v2/crawl/ongoing": {
        get: { tags: ["v2"], summary: "Same as /v2/crawl/active", responses: { 200: ok("Crawls", { type: "object" }), ...ERRORS } },
      },
      "/v2/crawl/{id}": {
        get: { tags: ["v2"], summary: "Crawl status and pages", parameters: [idParam, skipParam], responses: { 200: ok("Status", { type: "object" }), ...ERRORS, ...notFound } },
        delete: {
          tags: ["v2"],
          summary: "Cancel a crawl",
          parameters: [idParam],
          responses: { 200: ok("Cancelled", { type: "object" }), 409: { description: "The crawl already finished", content: json(ref("Error")) }, ...ERRORS, ...notFound },
        },
      },
      "/v2/crawl/{id}/errors": {
        get: { tags: ["v2"], summary: "Failed pages and robots.txt-blocked URLs", parameters: [idParam], responses: { 200: ok("Errors", { type: "object" }), ...ERRORS, ...notFound } },
      },
      "/v2/map": {
        post: {
          tags: ["v2"],
          summary: "List a site's URLs (v2: links are {url, title} objects)",
          requestBody: body("MapRequestV2", { url: "https://example.com", sitemap: "include", limit: 100 }),
          responses: { 200: ok("Links", { type: "object" }, { success: true, links: [{ url: "https://example.com/about", title: "About" }] }), ...ERRORS },
        },
      },
      "/v2/search": {
        post: {
          tags: ["v2"],
          summary: "Search web, news and images (v2)",
          description: "sources: web, news, images (news and images need SearXNG). categories: github, research, pdf. Results are grouped by source.",
          requestBody: body("SearchRequestV2", { query: "firecrawl alternatives", sources: ["web", "news"], limit: 5 }),
          responses: { 200: ok("Results", { type: "object" }, { success: true, data: { web: [{ url: "…", title: "…", description: "…", position: 1 }] } }), ...ERRORS },
        },
      },
      "/v2/extract": {
        post: {
          tags: ["v2"],
          summary: "AI extraction (v2). Without urls, the prompt is searched on the web",
          requestBody: body("ExtractRequestV2", { urls: ["https://example.com/*"], prompt: "Company name and pricing plans" }),
          responses: { 200: ok("Started", { type: "object" }, { success: true, id: "…" }), ...ERRORS },
        },
      },
      "/v2/extract/{id}": {
        get: { tags: ["v2"], summary: "Extraction status and result", parameters: [idParam], responses: { 200: ok("Status", { type: "object" }), ...ERRORS, ...notFound } },
      },
      "/v2/team/credit-usage": {
        get: {
          tags: ["v2"],
          summary: "Credits this month (1 credit = 1 page; the plan is the team's pagesPerMonth)",
          responses: { 200: ok("Usage", { type: "object" }, { success: true, data: { remainingCredits: 4200, planCredits: 5000, billingPeriodStart: "2026-10-01T00:00:00.000Z", billingPeriodEnd: "2026-10-31T23:59:59.999Z" } }), ...ERRORS },
        },
      },
      "/v2/team/credit-usage/historical": { get: { tags: ["v2"], summary: "Credits per month, last 12 months", responses: { 200: ok("Periods", { type: "object" }), ...ERRORS } } },
      "/v2/team/token-usage": { get: { tags: ["v2"], summary: "AI tokens this month (no token plan: remaining is unlimited)", responses: { 200: ok("Usage", { type: "object" }), ...ERRORS } } },
      "/v2/team/token-usage/historical": { get: { tags: ["v2"], summary: "AI tokens per month, last 12 months", responses: { 200: ok("Periods", { type: "object" }), ...ERRORS } } },
      "/v2/team/queue-status": { get: { tags: ["v2"], summary: "Your team's queued and running jobs", responses: { 200: ok("Queue", { type: "object" }), ...ERRORS } } },
      "/v2/concurrency-check": { get: { tags: ["v2"], summary: "Your team's running jobs and concurrency limit", responses: { 200: ok("Concurrency", { type: "object" }), ...ERRORS } } },
      "/admin/v1/me": {
        get: {
          tags: ["Admin"],
          summary: "The calling key: team, role, scopes, limits",
          responses: { 200: ok("Your identity", { type: "object" }, { success: true, data: { orgId: "default", teamId: "default", teamName: "default", role: "owner", scopes: null, keyId: null, limits: {}, settings: {} } }), ...ADMIN_ERRORS },
        },
      },
      "/admin/v1/org": {
        get: { tags: ["Admin"], summary: "Organization and its domain policy (admin, owner)", responses: { 200: ok("Organization", { type: "object" }), ...ADMIN_ERRORS } },
        patch: {
          tags: ["Admin"],
          summary: "Change the organization's name or domain allow/deny lists (owner)",
          requestBody: body("OrgUpdate", { settings: { denyDomains: ["internal.example.com"] } }),
          responses: { 200: ok("Updated", { type: "object" }), ...ADMIN_ERRORS },
        },
      },
      "/admin/v1/teams": {
        get: { tags: ["Admin"], summary: "Teams (owner: all; others: their own)", responses: { 200: ok("Teams", { type: "object" }), ...ADMIN_ERRORS } },
        post: {
          tags: ["Admin"],
          summary: "Create a team with limits and settings (owner)",
          requestBody: body("TeamCreate", {
            name: "research",
            limits: { concurrency: 4, requestsPerMinute: 120, pagesPerDay: 5000, pagesPerMonth: 100000, maxCrawlPages: 1000, features: { stealthProxy: false } },
            settings: { zdr: false, retentionHours: 72, ipAllowlist: ["10.0.0.0/8"] },
          }),
          responses: { 201: ok("Created", { type: "object" }), 409: { description: "A team with this name exists (`CONFLICT`)", content: json(ref("Error")) }, ...ADMIN_ERRORS },
        },
      },
      "/admin/v1/teams/{id}": {
        get: { tags: ["Admin"], summary: "One team", parameters: [teamIdParam], responses: { 200: ok("Team", { type: "object" }), ...ADMIN_ERRORS } },
        patch: {
          tags: ["Admin"],
          summary: "Change a team: name and settings (admin of the team, owner); limits and disabled (owner)",
          description: "Fields you send replace the stored ones; null removes a limit or setting.",
          parameters: [teamIdParam],
          requestBody: body("TeamUpdate", { limits: { pagesPerDay: 10000, requestsPerMinute: null } }),
          responses: { 200: ok("Updated", { type: "object" }), ...ADMIN_ERRORS },
        },
      },
      "/admin/v1/keys": {
        get: {
          tags: ["Admin"],
          summary: "API keys (admin: their team; owner: every team). Keys themselves are never returned.",
          parameters: [{ name: "teamId", in: "query", schema: { type: "string" } }],
          responses: { 200: ok("Keys", { type: "object" }), ...ADMIN_ERRORS },
        },
        post: {
          tags: ["Admin"],
          summary: "Create an API key (shown once in the response)",
          requestBody: body("KeyCreate", { name: "ci-pipeline", role: "member", scopes: ["scrape", "crawl"], expiresInDays: 90 }),
          responses: { 201: ok("Created", { type: "object" }, { success: true, key: "mc_…", data: { id: "…", prefix: "mc_AbCdEfGh", role: "member" } }), ...ADMIN_ERRORS },
        },
      },
      "/admin/v1/keys/{id}": {
        delete: {
          tags: ["Admin"],
          summary: "Revoke an API key",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: ok("Revoked", { type: "object" }), ...ADMIN_ERRORS },
        },
      },
      "/admin/v1/usage": {
        get: {
          tags: ["Admin"],
          summary: "Usage per team and day: requests, pages, browserPages, ocrPages, aiInputTokens, aiOutputTokens, searches",
          parameters: [
            { name: "teamId", in: "query", schema: { type: "string" } },
            { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "Default: first day of this month (UTC)" },
            { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "Default: today (UTC)" },
          ],
          responses: { 200: ok("Usage", { type: "object" }), ...ADMIN_ERRORS },
        },
      },
      "/admin/v1/audit": {
        get: {
          tags: ["Admin"],
          summary: "Audit log, newest first (admin: their team; owner: the organization)",
          parameters: [
            { name: "teamId", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "integer" }, description: "Epoch milliseconds" },
            { name: "beforeId", in: "query", schema: { type: "integer" }, description: "Paging: nextBeforeId from the previous page" },
            { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 10000 } },
            { name: "format", in: "query", schema: { type: "string", enum: ["json", "jsonl"] }, description: "jsonl: one event per line, for SIEM import" },
          ],
          responses: { 200: ok("Events", { type: "object" }), ...ADMIN_ERRORS },
        },
      },
    },
  };
}

const DOCS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>minicrawl API</title>
<link rel="stylesheet" href="docs/assets/swagger-ui.css">
<style>body{margin:0;background:#fff} .topbar{display:none}</style>
</head><body><div id="ui"></div>
<script src="docs/assets/swagger-ui-bundle.js"></script>
<script src="docs/assets/swagger-ui-standalone-preset.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    url: "openapi.json", dom_id: "#ui", deepLinking: true, persistAuthorization: true,
    tryItOutEnabled: true, displayRequestDuration: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], layout: "BaseLayout",
  });
</script></body></html>`;

/** Register GET /openapi.json, GET /docs and the Swagger UI assets. */
export function mountDocs(app) {
  const spec = buildSpec();
  app.get("/openapi.json", (_req, res) => res.json(spec));
  app.use("/docs/assets", express.static(swaggerUi.getAbsoluteFSPath(), { index: false, maxAge: "1d" }));
  app.get(["/docs", "/docs/"], (req, res) => {
    // Relative asset URLs resolve against /docs, so redirect /docs/ to /docs.
    if (req.path.endsWith("/")) return res.redirect(301, "/docs");
    res.type("html").send(DOCS_HTML);
  });
}
