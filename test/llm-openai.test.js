// AI extraction through an OpenAI-compatible server (what Ollama, vLLM,
// LM Studio and llama.cpp serve), using a local mock of /v1/chat/completions.
// test/ollama.test.js runs the same against a real Ollama when OLLAMA_TEST_URL is set.
import { test, before, after, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFixtureSite } from "./fixture-site.js";
import { startMockOpenAI } from "./mock-services.js";

process.env.ALLOW_PRIVATE_URLS = "true";
process.env.DISABLE_PLAYWRIGHT = "true";
const ROOT = "openai-root-key-0123456789abcdef";
process.env.API_KEY = ROOT;
delete process.env.ANTHROPIC_API_KEY;

let site, llm, api, base, resetFormatProbe;

before(async () => {
  site = await startFixtureSite();
  llm = await startMockOpenAI();
  process.env.LLM_BASE_URL = `${llm.url}/v1`;
  process.env.LLM_MODEL = "qwen3:8b";
  process.env.LLM_API_KEY = "local-secret";
  process.env.SEARXNG_ENDPOINT = `${site.url}/searx`;
  ({ resetFormatProbe } = await import("../src/llm.js"));
  const { start } = await import("../src/server.js");
  api = await start({ port: 0, host: "127.0.0.1", workers: 2, dbPath: ":memory:" });
  base = `http://127.0.0.1:${api.port}`;
});

after(async () => {
  await api.close();
  await site.close();
  await llm.close().catch(() => {});
});

beforeEach(() => {
  resetFormatProbe();
  Object.assign(llm.state, { requests: [], reply: { title: "Home" }, rejectSchema: false, think: false, firstReply: null, status: 200 });
});

async function call(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${ROOT}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
const scrapeJson = () => call("POST", "/v1/scrape", { url: `${site.url}/`, formats: ["json"], jsonOptions: { schema, prompt: "the page title" } });

describe("OpenAI-compatible provider", () => {
  test("/health reports the provider and model", async () => {
    const h = await fetch(`${base}/health`).then(r => r.json());
    assert.equal(h.features.ai, true);
    assert.deepEqual(h.features.llm, { provider: "openai", model: "qwen3:8b" });
  });

  test("json format: structured output request, page content, API key, metering", async () => {
    const r = await scrapeJson();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.json, { title: "Home" });
    const req = llm.state.requests[0];
    assert.equal(req.headers.authorization, "Bearer local-secret");
    assert.equal(req.body.model, "qwen3:8b");
    assert.equal(req.body.temperature, 0);
    assert.equal(req.body.response_format.type, "json_schema");
    assert.equal(req.body.response_format.json_schema.schema.additionalProperties, false);
    assert.match(req.body.messages[1].content, /Welcome home/);
    const usage = await call("GET", "/admin/v1/usage");
    const totals = usage.body.data.teams.find(t => t.id === "default").totals;
    assert.ok(totals.aiInputTokens >= 50 && totals.aiOutputTokens >= 7);
  });

  test("servers without structured outputs: falls back to json_object", async () => {
    llm.state.rejectSchema = true;
    const r = await scrapeJson();
    assert.deepEqual(r.body.data.json, { title: "Home" });
    assert.deepEqual(llm.state.requests.map(q => q.body.response_format?.type), ["json_schema", "json_object"]);
    // The working format is remembered.
    await scrapeJson();
    assert.equal(llm.state.requests.at(-1).body.response_format.type, "json_object");
    assert.equal(llm.state.requests.length, 3);
  });

  test("reasoning models: <think> blocks are removed", async () => {
    llm.state.think = true;
    const r = await scrapeJson();
    assert.deepEqual(r.body.data.json, { title: "Home" });
  });

  test("an incomplete answer gets one corrective retry", async () => {
    llm.state.firstReply = { other: 1 };
    const r = await scrapeJson();
    assert.deepEqual(r.body.data.json, { title: "Home" });
    assert.equal(llm.state.requests.length, 2);
    const retry = llm.state.requests[1].body.messages;
    assert.equal(retry.at(-2).role, "assistant");
    assert.match(retry.at(-1).content, /missing these fields: title/);
  });

  test("summary format and /v1/extract use the same provider", async () => {
    llm.state.reply = body => (JSON.stringify(body).includes("Summarize") ? { summary: "A home page." } : { title: "Doc A" });
    const s = await call("POST", "/v1/scrape", { url: `${site.url}/`, formats: ["summary"] });
    assert.equal(s.body.data.summary, "A home page.");
    const started = await call("POST", "/v1/extract", { urls: [`${site.url}/docs/a`], prompt: "the title" });
    let st;
    for (let i = 0; i < 50; i++) {
      st = await call("GET", `/v1/extract/${started.body.id}`);
      if (st.body.status !== "processing") break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(st.body.status, "completed", JSON.stringify(st.body));
    assert.deepEqual(st.body.data, { title: "Doc A" });
  });

  test("unknown model: 503 with a hint", async () => {
    llm.state.status = 404;
    const r = await scrapeJson();
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "LLM_NOT_CONFIGURED");
    assert.match(r.body.error, /ollama pull qwen3:8b/);
  });

  test("server down: 503 LLM_NOT_CONFIGURED naming the URL", async () => {
    await llm.close();
    const r = await scrapeJson();
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "LLM_NOT_CONFIGURED");
    assert.match(r.body.error, /Can't reach the LLM server at http:\/\/127\.0\.0\.1/);
  });
});
