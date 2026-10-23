// OpenAPI spec (/openapi.json) and the interactive explorer (/docs).
// Request bodies are generated from src/schemas.js; responses are written
// out here. Swagger UI is served from the swagger-ui-dist package, so the
// docs page works offline (no CDN).
import express from "express";
import { readFileSync } from "node:fs";
import swaggerUi from "swagger-ui-dist";
import { zodToJsonSchema } from "zod-to-json-schema";
import { crawlBody, extractBody, mapBody, scrapeBody, searchBody } from "./schemas.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const fromZod = schema => {
  const json = zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
    effectStrategy: "input",
    pipeStrategy: "input",
  });
  delete json.$schema;
  return json;
};

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ "application/json": { schema, ...(example ? { example } : {}) } });
const body = (name, example) => ({ required: true, content: json(ref(name), example) });
const ok = (description, schema, example) => ({ description, content: json(schema, example) });

const ERRORS = {
  400: { description: "Invalid request body (`BAD_REQUEST`)", content: json(ref("Error")) },
  401: { description: "Missing or wrong API key (`UNAUTHORIZED`)", content: json(ref("Error")) },
};
const scrapeErrors = {
  ...ERRORS,
  403: { description: "`BLOCKED_URL` (private address) or `BLOCKED_BY_SITE` (bot protection)", content: json(ref("Error")) },
  408: { description: "`SCRAPE_TIMEOUT`", content: json(ref("Error")) },
  422: {
    description: "`UNSUPPORTED_FILE`, `ACTION_FAILED`, `NO_BROWSER`, `NO_STEALTH_PROXY`, `LLM_REFUSAL`",
    content: json(ref("Error")),
  },
  503: { description: "`LLM_NOT_CONFIGURED` (json format without ANTHROPIC_API_KEY)", content: json(ref("Error")) },
};
const notFound = { 404: { description: "Unknown id", content: json(ref("Error")) } };
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };

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
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Your API_KEY" } },
      schemas: {
        ScrapeRequest: fromZod(scrapeBody),
        CrawlRequest: fromZod(crawlBody),
        MapRequest: fromZod(mapBody),
        SearchRequest: fromZod(searchBody),
        ExtractRequest: fromZod(extractBody),
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
      { name: "System" },
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
