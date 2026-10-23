// Actions, OCR, Office files, proxy escalation, search and AI extraction.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startFixtureSite } from "./fixture-site.js";
import { startMockAnthropic, startForwardProxy } from "./mock-services.js";

process.env.ALLOW_PRIVATE_URLS = "true";
process.env.INTERSTITIAL_WAIT_MS = "1000";

let site, api, base, llm, proxy;

before(async () => {
  site = await startFixtureSite();
  llm = await startMockAnthropic();
  proxy = await startForwardProxy();
  process.env.ANTHROPIC_BASE_URL = llm.url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SEARXNG_ENDPOINT = site.url + "/searx";
  process.env.STEALTH_PROXY_URLS = proxy.url;
  const { start } = await import("../src/server.js");
  api = await start({ port: 0, host: "127.0.0.1", workers: 2, dbPath: ":memory:" });
  base = `http://127.0.0.1:${api.port}`;
});

after(async () => {
  await api.close();
  await Promise.all([site.close(), llm.close(), proxy.close()]);
});

const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));
const get = path => fetch(base + path).then(async r => ({ status: r.status, body: await r.json() }));

describe("actions", () => {
  test("type, click, wait, screenshot, run JS, scrape", async () => {
    const { status, body } = await post("/v1/scrape", {
      url: site.url + "/form",
      formats: ["markdown"],
      actions: [
        { type: "write", selector: "#name", text: "Ada" },
        { type: "click", selector: "#go" },
        { type: "wait", selector: "#result" },
        { type: "screenshot" },
        { type: "executeJavascript", script: "document.title" },
        { type: "scrape" },
      ],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(body.data.markdown, /Hello, Ada!/);
    assert.equal(body.data.metadata.engine, "browser");
    assert.equal(body.data.actions.screenshots.length, 1);
    assert.match(body.data.actions.screenshots[0], /^data:image\/png;base64,/);
    assert.deepEqual(body.data.actions.javascriptReturns, [{ type: "string", value: "Form" }]);
    assert.match(body.data.actions.scrapes[0].html, /Hello, Ada!/);
  });

  test("a failing action is reported with its position", async () => {
    const { status, body } = await post("/v1/scrape", {
      url: site.url + "/form",
      timeout: 5000,
      actions: [{ type: "click", selector: "#does-not-exist" }],
    });
    assert.equal(status, 422);
    assert.equal(body.code, "ACTION_FAILED");
    assert.match(body.error, /Action 1 \(click\)/);
  });

  test("validates actions", async () => {
    assert.equal((await post("/v1/scrape", { url: site.url, actions: [{ type: "wait" }] })).status, 400);
    assert.equal((await post("/v1/scrape", { url: site.url, actions: [{ type: "dance" }] })).status, 400);
  });
});

describe("files", () => {
  test("OCR on images", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/scan.png" });
    assert.match(body.data.markdown, /Invoice 4521/);
    assert.match(body.data.markdown, /99\.50/);
    assert.equal(body.data.metadata.ocr, true);
  });

  test("OCR on scanned PDFs", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/scanned.pdf" });
    assert.match(body.data.markdown, /Scanned contract/);
    assert.equal(body.data.metadata.ocr, true);
  });

  test("Excel to markdown tables", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/data.xlsx" });
    assert.match(body.data.markdown, /## Prices/);
    assert.match(body.data.markdown, /\| Product \| Price \| In stock \|/);
    assert.match(body.data.markdown, /\| Gadget \\\| Pro \| 24\.5 \| no \|/);
    assert.match(body.data.markdown, /\| Total \| 34\.49 \|/); // formula result
  });

  test("PowerPoint slides and notes", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/deck.pptx" });
    const md = body.data.markdown;
    assert.match(md, /## Slide 1: Quarterly Review\n\nRevenue grew 12%/);
    assert.match(md, /Notes:\*\* Mention the budget/);
    assert.ok(md.indexOf("Slide 2") < md.indexOf("Slide 10"), "slides in numeric order");
  });
});

describe("proxy", () => {
  test("auto escalates to the stealth pool when blocked", async () => {
    const before = proxy.state.hits;
    const { status, body } = await post("/v1/scrape", { url: site.url + "/proxy-gated" });
    assert.equal(status, 200, JSON.stringify(body));
    assert.match(body.data.markdown, /Welcome through the proxy/);
    assert.equal(body.data.metadata.proxyUsed, "stealth");
    assert.ok(proxy.state.hits > before);
  });

  test("basic does not escalate", async () => {
    const before = proxy.state.hits;
    const { status, body } = await post("/v1/scrape", { url: site.url + "/proxy-gated", proxy: "basic" });
    assert.equal(status, 403);
    assert.equal(body.code, "BLOCKED_BY_SITE");
    assert.equal(proxy.state.hits, before, "stealth pool not used");
  });

  test("stealth goes straight through the stealth pool", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/proxy-gated", proxy: "stealth", engine: "fetch" });
    assert.equal(body.data.metadata.statusCode, 200);
    assert.equal(body.data.metadata.proxyUsed, "stealth");
  });
});

describe("search", () => {
  test("returns results from the configured provider", async () => {
    const { status, body } = await post("/v1/search", { query: "minicrawl", limit: 5 });
    assert.equal(status, 200);
    assert.deepEqual(body.data.map(r => r.title), ["Doc A", "About"]);
    assert.equal(body.data[0].description, "About minicrawl");
  });

  test("scrapes results when scrapeOptions is given", async () => {
    const { body } = await post("/v1/search", { query: "x", limit: 1, scrapeOptions: { formats: ["markdown"] } });
    assert.equal(body.data.length, 1);
    assert.match(body.data[0].markdown, /# Doc A/);
    assert.equal(body.data[0].metadata.statusCode, 200);
  });
});

describe("AI extraction", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      price: { type: "number", minimum: 0 },
      tags: { type: "array", items: { type: "string" }, maxItems: 5 },
    },
    required: ["title"],
  };

  test("json format sends the page and a structured-output schema to Claude", async () => {
    llm.state.mode = "ok";
    llm.state.reply = { title: "Doc A", price: null, tags: ["docs"] };
    const { status, body } = await post("/v1/scrape", {
      url: site.url + "/docs/a",
      formats: ["markdown", "json"],
      jsonOptions: { schema, prompt: "Get the title" },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.json, { title: "Doc A", price: null, tags: ["docs"] });

    const req = llm.state.requests.at(-1);
    assert.equal(req.body.model, "claude-opus-5-5");
    assert.equal(req.body.stream, true);
    assert.equal(req.body.output_config.effort, "medium");
    assert.equal(req.body.fallbacks, "default");
    assert.match(req.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    const sent = req.body.output_config.format.schema;
    assert.equal(sent.additionalProperties, false);
    assert.deepEqual(sent.required, ["title", "price", "tags"]);
    assert.equal(sent.properties.title.minLength, undefined);
    assert.deepEqual(sent.properties.price, { anyOf: [{ type: "number" }, { type: "null" }] });
    const pageText = req.body.messages[0].content[0].text;
    assert.match(pageText, /<page url="http:\/\/127\.0\.0\.1:\d+\/docs\/a" title="Doc A">/);
    assert.match(pageText, /const a = 1;/);
  });

  test("prompt-only extraction parses free-form JSON", async () => {
    llm.state.reply = { heading: "About us" };
    const { body } = await post("/v1/scrape", {
      url: site.url + "/about",
      formats: ["json"],
      jsonOptions: { prompt: "What is the main heading?" },
    });
    assert.deepEqual(body.data.json, { heading: "About us" });
    assert.equal(llm.state.requests.at(-1).body.output_config.format, undefined);
  });

  test("/v1/extract runs across several pages", async () => {
    llm.state.reply = { title: "Docs", price: 1, tags: ["a", "b"] };
    const started = await post("/v1/extract", {
      urls: [site.url + "/docs/a", site.url + "/docs/b", site.url + "/nope-404"],
      schema,
      prompt: "Summarize",
      showSources: true,
    });
    assert.equal(started.status, 200);
    let result;
    for (let i = 0; i < 100; i++) {
      result = (await get(`/v1/extract/${started.body.id}`)).body;
      if (result.status !== "processing") break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(result.data, { title: "Docs", price: 1, tags: ["a", "b"] });
    assert.equal(result.sources.length, 3); // the 404 page still has content
    const blocks = llm.state.requests.at(-1).body.messages[0].content;
    assert.equal(blocks.filter(b => b.text.startsWith("<page ")).length, 3);
  });

  test("model refusals and missing credentials map to clear errors", async () => {
    llm.state.mode = "refusal";
    const refused = await post("/v1/scrape", { url: site.url + "/about", formats: ["json"], jsonOptions: { prompt: "x" } });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.code, "LLM_REFUSAL");

    llm.state.mode = "unauthorized";
    const unauth = await post("/v1/scrape", { url: site.url + "/about", formats: ["json"], jsonOptions: { prompt: "x" } });
    assert.equal(unauth.status, 503);
    assert.equal(unauth.body.code, "LLM_NOT_CONFIGURED");
    llm.state.mode = "ok";
  });

  test("json format requires a schema or prompt", async () => {
    const { status } = await post("/v1/scrape", { url: site.url, formats: ["json"] });
    assert.equal(status, 400);
  });
});
