// The /mcp endpoint, driven by the official MCP client (as Claude Code / Cursor would).
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { startFixtureSite } from "./fixture-site.js";
import { startMockAnthropic } from "./mock-services.js";

process.env.ALLOW_PRIVATE_URLS = "true";
const KEY = "mcp-test-key-0123456789abcdef";

let site, llm, api, base, client;

async function connect(key = KEY) {
  const c = new Client({ name: "minicrawl-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} },
  });
  await c.connect(transport);
  return c;
}

const textOf = result => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");

before(async () => {
  site = await startFixtureSite();
  llm = await startMockAnthropic();
  process.env.ANTHROPIC_BASE_URL = llm.url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SEARXNG_ENDPOINT = site.url + "/searx";
  process.env.API_KEY = KEY;
  const { start } = await import("../src/server.js");
  api = await start({ port: 0, host: "127.0.0.1", workers: 2, dbPath: ":memory:" });
  base = `http://127.0.0.1:${api.port}`;
  client = await connect();
});

after(async () => {
  await client?.close();
  await api.close();
  await Promise.all([site.close(), llm.close()]);
});

describe("MCP endpoint", () => {
  test("requires the API key", async () => {
    await assert.rejects(connect(null));
    await assert.rejects(connect("wrong-key-0123456789abcdef"));
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${KEY}` } });
    assert.equal(get.status, 405);
  });

  test("lists the minicrawl tools with input schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      "minicrawl_crawl",
      "minicrawl_crawl_status",
      "minicrawl_extract",
      "minicrawl_extract_status",
      "minicrawl_map",
      "minicrawl_scrape",
      "minicrawl_search",
    ]);
    const scrape = tools.find(t => t.name === "minicrawl_scrape");
    assert.ok(scrape.description.length > 50);
    assert.deepEqual(scrape.inputSchema.required, ["url"]);
    assert.equal(scrape.annotations.readOnlyHint, true);
  });

  test("scrape returns markdown, and screenshots as images", async () => {
    const r = await client.callTool({ name: "minicrawl_scrape", arguments: { url: site.url + "/docs/a" } });
    assert.equal(r.isError, undefined);
    const t = textOf(r);
    assert.match(t, /Title: Doc A/);
    assert.match(t, /```js\nconst a = 1;\n```/);

    const shot = await client.callTool({
      name: "minicrawl_scrape",
      arguments: { url: site.url + "/about", formats: ["markdown", "screenshot"] },
    });
    const image = shot.content.find(c => c.type === "image");
    assert.equal(image.mimeType, "image/png");
    assert.ok(Buffer.from(image.data, "base64").subarray(1, 4).toString() === "PNG");
  });

  test("scrape truncates to maxChars and reports errors as tool errors", async () => {
    const r = await client.callTool({ name: "minicrawl_scrape", arguments: { url: site.url + "/", maxChars: 1000 } });
    assert.ok(textOf(r).length < 1600);

    const bad = await client.callTool({ name: "minicrawl_scrape", arguments: { url: "ftp://example.com" } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /Invalid arguments: url/);

    const blocked = await client.callTool({ name: "minicrawl_scrape", arguments: { url: site.url + "/photo.jpg" } });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /UNSUPPORTED_FILE/);
  });

  test("map and search", async () => {
    const m = await client.callTool({ name: "minicrawl_map", arguments: { url: site.url + "/", search: "docs", limit: 3 } });
    assert.match(textOf(m), /3 URLs:\n.*\/docs/);

    const s = await client.callTool({ name: "minicrawl_search", arguments: { query: "minicrawl", scrape: true, limit: 1 } });
    const t = textOf(s);
    assert.match(t, /1\. Doc A/);
    assert.match(t, /# Doc A/);
  });

  test("crawl, then crawl_status returns the pages", async () => {
    const started = await client.callTool({ name: "minicrawl_crawl", arguments: { url: site.url + "/docs/", limit: 3 } });
    const id = /id: ([0-9a-f-]{36})/.exec(textOf(started))[1];
    let status;
    for (let i = 0; i < 60; i++) {
      status = textOf(await client.callTool({ name: "minicrawl_crawl_status", arguments: { id } }));
      if (/^Status: completed/.test(status)) break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.match(status, /^Status: completed \(3 of 3 pages done\)/);
    assert.match(status, /# Doc A/);

    const missing = await client.callTool({ name: "minicrawl_crawl_status", arguments: { id: "00000000-0000-0000-0000-000000000000" } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /NOT_FOUND/);
  });

  test("minicrawl-mcp stdio bridge forwards to the server (as Claude Desktop runs it)", async () => {
    const bridge = new URL("../integrations/mcp/index.js", import.meta.url);
    const launch = env =>
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(bridge)],
        env: { ...getDefaultEnvironment(), ...env },
        stderr: "pipe",
      });

    const desktop = new Client({ name: "desktop-sim", version: "1.0.0" });
    await desktop.connect(launch({ MINICRAWL_API_URL: base, MINICRAWL_API_KEY: KEY }));
    try {
      const { tools } = await desktop.listTools();
      assert.equal(tools.length, 7);
      const r = await desktop.callTool({ name: "minicrawl_scrape", arguments: { url: site.url + "/about" } });
      assert.match(textOf(r), /# About us/);
    } finally {
      await desktop.close();
    }

    const wrongKey = new Client({ name: "desktop-sim", version: "1.0.0" });
    await wrongKey.connect(launch({ MINICRAWL_API_URL: base, MINICRAWL_API_KEY: "nope-nope-nope-nope-nope" }));
    try {
      await assert.rejects(wrongKey.listTools(), /API key was rejected/);
    } finally {
      await wrongKey.close();
    }
  });

  test("extract waits for the AI result", async () => {
    llm.state.mode = "ok";
    llm.state.reply = { title: "Doc A" };
    const r = await client.callTool({
      name: "minicrawl_extract",
      arguments: { urls: [site.url + "/docs/a"], schema: { type: "object", properties: { title: { type: "string" } } } },
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /"title": "Doc A"/);
    assert.match(textOf(r), /Sources: http:\/\/127\.0\.0\.1:\d+\/docs\/a/);
  });
});
