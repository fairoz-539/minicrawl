// Model Context Protocol endpoint (POST /mcp, Streamable HTTP, stateless).
// Lets AI agents (Claude Code, Cursor, VS Code, Claude Desktop via the
// minicrawl-mcp bridge) use minicrawl as tools. Every tool calls the same
// operations as the REST API (src/api.js) and is protected by the same API key,
// running as that key's team with the same roles, limits and metering.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as api from "./api.js";
import { SYSTEM_TENANT } from "./tenancy.js";

const DEFAULT_MAX_CHARS = Number(process.env.MCP_MAX_CHARS ?? 50_000);
const EXTRACT_WAIT_MS = Number(process.env.MCP_EXTRACT_WAIT_MS ?? 120_000);

const text = t => ({ type: "text", text: t });
const ok = (...content) => ({ content });
const fail = message => ({ isError: true, content: [text(message)] });

function clip(s, max) {
  if (!s || s.length <= max) return s ?? "";
  return `${s.slice(0, max)}\n\n[… truncated ${s.length - max} characters. Ask again with a larger maxChars to see more.]`;
}

/** Run a tool body; turn thrown errors into MCP tool errors the model can read. */
const tool = fn => async args => {
  try {
    return await fn(args);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(`Invalid arguments: ${err.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    }
    return fail(`${err.code ? `${err.code}: ` : ""}${err.message}`);
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function docText(doc, maxChars) {
  const m = doc.metadata ?? {};
  const header = [
    `URL: ${m.url ?? m.sourceURL}`,
    m.title ? `Title: ${m.title}` : null,
    `Status: ${m.statusCode}${m.error ? ` (${m.error})` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
  const parts = [header];
  if (doc.warning) parts.push(`Warning: ${doc.warning}`);
  if (doc.json !== undefined) parts.push(`Extracted JSON:\n${JSON.stringify(doc.json, null, 2)}`);
  if (doc.markdown !== undefined) parts.push(clip(doc.markdown, maxChars));
  if (doc.links) parts.push(`Links (${doc.links.length}):\n${doc.links.slice(0, 200).join("\n")}`);
  if (doc.actions?.javascriptReturns?.length) {
    parts.push(`JavaScript results:\n${JSON.stringify(doc.actions.javascriptReturns)}`);
  }
  return parts.join("\n\n");
}

const pngContent = dataUrl => ({ type: "image", data: dataUrl.replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" });

export function buildMcpServer(ctx, { version, baseUrl, tenant = SYSTEM_TENANT }) {
  const server = new McpServer({ name: "minicrawl", version });

  server.registerTool(
    "minicrawl_scrape",
    {
      title: "Scrape a web page or file",
      description:
        "Fetch one URL and return its main content as clean markdown. Handles JavaScript-rendered pages, PDFs " +
        "(including scanned, via OCR), Word, Excel, PowerPoint and images. Optional: screenshot, browser actions " +
        "(click/type/scroll before capture), and AI extraction to JSON (jsonOptions; needs an AI provider on the server: ANTHROPIC_API_KEY or LLM_BASE_URL).",
      inputSchema: {
        url: z.string().describe("The page or file URL"),
        formats: z
          .array(z.enum(["markdown", "html", "rawHtml", "links", "screenshot", "screenshot@fullPage", "json"]))
          .optional()
          .describe('Default ["markdown"]'),
        onlyMainContent: z.boolean().optional().describe("Drop navigation, footers, ads (default true)"),
        waitFor: z.number().int().min(0).max(60_000).optional().describe("Extra milliseconds to wait after load"),
        timeout: z.number().int().min(1000).max(300_000).optional(),
        actions: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe('Browser actions, e.g. [{"type":"click","selector":"#more"},{"type":"wait","milliseconds":1000}]'),
        jsonOptions: z
          .object({ schema: z.record(z.string(), z.any()).optional(), prompt: z.string().optional() })
          .optional()
          .describe("For the json format: a JSON Schema and/or a prompt"),
        maxChars: z.number().int().min(1000).optional().describe(`Truncate markdown to this many characters (default ${DEFAULT_MAX_CHARS})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ maxChars = DEFAULT_MAX_CHARS, ...body }) => {
      const { data } = await api.scrape(ctx, body, tenant);
      const content = [text(docText(data, maxChars))];
      if (data.screenshot) content.push(pngContent(data.screenshot));
      for (const s of data.actions?.screenshots ?? []) content.push(pngContent(s));
      return ok(...content);
    }),
  );

  server.registerTool(
    "minicrawl_map",
    {
      title: "List a website's URLs",
      description: "Quickly list the URLs on a site (sitemap + links + previously seen pages), optionally ranked by relevance to a search term. Use it to find the right pages before scraping.",
      inputSchema: {
        url: z.string(),
        search: z.string().optional().describe("Rank URLs by relevance to this text"),
        limit: z.number().int().min(1).max(5000).optional().describe("Default 100"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ limit = 100, ...body }) => {
      const { links } = await api.map(ctx, { ...body, limit }, tenant);
      return ok(text(links.length ? `${links.length} URLs:\n${links.join("\n")}` : "No URLs found."));
    }),
  );

  server.registerTool(
    "minicrawl_search",
    {
      title: "Search the web",
      description: "Web search. With scrape=true, each result's page content is fetched as markdown too.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(20).optional().describe("Default 5"),
        tbs: z.string().optional().describe("Time filter: qdr:d, qdr:w, qdr:m, qdr:y"),
        scrape: z.boolean().optional().describe("Also return each result's content (slower)"),
        maxChars: z.number().int().min(1000).optional().describe("Per-result markdown limit when scrape=true (default 10000)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ scrape = false, maxChars = 10_000, limit = 5, ...body }) => {
      const { data } = await api.search(ctx, { ...body, limit, ...(scrape ? { scrapeOptions: { formats: ["markdown"] } } : {}) }, tenant);
      if (!data.length) return ok(text("No results."));
      const blocks = data.map((r, i) =>
        [`${i + 1}. ${r.title}`, r.url, r.description, scrape && r.markdown !== undefined ? clip(r.markdown, maxChars) : null]
          .filter(Boolean)
          .join("\n"),
      );
      return ok(text(blocks.join("\n\n---\n\n")));
    }),
  );

  server.registerTool(
    "minicrawl_crawl",
    {
      title: "Start crawling a website",
      description:
        "Start crawling a site in the background (follows links, respects robots.txt). Returns a crawl id; " +
        "call minicrawl_crawl_status with it to get progress and the pages. Keep limit small for agents.",
      inputSchema: {
        url: z.string(),
        limit: z.number().int().min(1).max(500).optional().describe("Max pages (default 10)"),
        maxDepth: z.number().int().min(0).optional(),
        includePaths: z.array(z.string()).optional().describe("Regexes; only matching paths"),
        excludePaths: z.array(z.string()).optional().describe("Regexes; skip matching paths"),
        crawlEntireDomain: z.boolean().optional().describe("Also crawl outside the start URL's folder"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ limit = 10, ...body }) => {
      const { id } = await api.startCrawl(ctx, { ...body, limit }, baseUrl, tenant);
      return ok(text(`Crawl started. id: ${id}\nCall minicrawl_crawl_status with this id to get progress and pages.`));
    }),
  );

  server.registerTool(
    "minicrawl_crawl_status",
    {
      title: "Crawl progress and pages",
      description: "Status of a crawl started with minicrawl_crawl, and the markdown of the pages scraped so far.",
      inputSchema: {
        id: z.string(),
        skip: z.number().int().min(0).optional().describe("Skip this many pages (paging)"),
        maxChars: z.number().int().min(1000).optional().describe(`Total markdown budget across pages (default ${DEFAULT_MAX_CHARS})`),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ id, skip = 0, maxChars = DEFAULT_MAX_CHARS }) => {
      const s = await api.crawlStatus(ctx, id, { skip, pageSize: 50 }, tenant);
      const per = Math.max(1000, Math.floor(maxChars / Math.max(1, s.data.length)));
      const pages = s.data.map(d => docText({ metadata: d.metadata, markdown: d.markdown }, per));
      const more = s.data.length === 50 ? `\n\nMore pages available: call again with skip=${skip + 50}.` : "";
      return ok(text(`Status: ${s.status} (${s.completed} of ${s.total} pages done)\n\n${pages.join("\n\n=====\n\n")}${more}`));
    }),
  );

  server.registerTool(
    "minicrawl_extract",
    {
      title: "Extract structured data with AI",
      description:
        "Read one or more pages (https://site.com/* expands to the site's most relevant pages) and return " +
        "structured JSON matching a schema and/or prompt. Needs an AI provider on the server (ANTHROPIC_API_KEY, or LLM_BASE_URL for a local model).",
      inputSchema: {
        urls: z.array(z.string()).min(1).max(10),
        prompt: z.string().optional(),
        schema: z.record(z.string(), z.any()).optional().describe("JSON Schema of the result"),
        enableWebSearch: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async body => {
      const { id } = await api.startExtract(ctx, { ...body, showSources: true }, tenant);
      const deadline = Date.now() + EXTRACT_WAIT_MS;
      while (Date.now() < deadline) {
        const s = await api.extractStatus(ctx, id, tenant);
        if (s.status === "failed") return fail(`Extraction failed: ${s.error}`);
        if (s.status === "completed") {
          return ok(text(`${JSON.stringify(s.data, null, 2)}\n\nSources: ${(s.sources ?? []).join(", ")}${s.warning ? `\nWarning: ${s.warning}` : ""}`));
        }
        await sleep(1000);
      }
      return ok(text(`Still working. Call minicrawl_extract_status with id ${id} in a little while.`));
    }),
  );

  server.registerTool(
    "minicrawl_extract_status",
    {
      title: "AI extraction result",
      description: "Result of a minicrawl_extract call that was still running.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ id }) => {
      const s = await api.extractStatus(ctx, id, tenant);
      if (s.status === "failed") return fail(`Extraction failed: ${s.error}`);
      if (s.status !== "completed") return ok(text("Still processing. Try again shortly."));
      return ok(text(JSON.stringify(s.data, null, 2)));
    }),
  );

  return server;
}

/** Mount POST /mcp (stateless Streamable HTTP) behind the given auth middleware. */
export function mountMcp(app, ctx, { auth, version }) {
  app.post("/mcp", auth, async (req, res) => {
    const server = buildMcpServer(ctx, { version, baseUrl: `${req.protocol}://${req.get("host")}`, tenant: req.tenant });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
      }
    }
  });
  // Stateless server: no SSE stream to open, no session to delete.
  app.all("/mcp", auth, (_req, res) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }),
  );
}
