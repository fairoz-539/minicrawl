// AI extraction with a real local model through Ollama. Skipped unless
// OLLAMA_TEST_URL is set (e.g. http://localhost:11434), so the normal suite
// needs no model. CI runs it in the "Local AI (Ollama)" job with a small model.
//   OLLAMA_TEST_URL=http://localhost:11434 OLLAMA_TEST_MODEL=qwen2.5:1.5b node --test test/ollama.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFixtureSite } from "./fixture-site.js";

const OLLAMA = process.env.OLLAMA_TEST_URL;
const MODEL = process.env.OLLAMA_TEST_MODEL ?? "qwen2.5:1.5b";
const skip = !OLLAMA && "set OLLAMA_TEST_URL to run against a real Ollama";

process.env.ALLOW_PRIVATE_URLS = "true";
process.env.DISABLE_PLAYWRIGHT = "true";
process.env.API_KEY = "ollama-test-key-0123456789";

let site, api, base;

before(async () => {
  if (skip) return;
  site = await startFixtureSite();
  process.env.LLM_BASE_URL = `${OLLAMA.replace(/\/+$/, "")}/v1`;
  process.env.LLM_MODEL = MODEL;
  const { start } = await import("../src/server.js");
  api = await start({ port: 0, host: "127.0.0.1", workers: 1, dbPath: ":memory:" });
  base = `http://127.0.0.1:${api.port}`;
});

after(async () => {
  await api?.close();
  await site?.close();
});

test(`extracts structured data with ${MODEL}`, { skip, timeout: 600_000 }, async () => {
  const r = await fetch(`${base}/v1/scrape`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      url: `${site.url}/docs/a`,
      formats: ["json"],
      jsonOptions: {
        prompt: "The page heading, and the code shown on the page",
        schema: {
          type: "object",
          properties: { heading: { type: "string" }, code: { type: "string" } },
          required: ["heading", "code"],
        },
      },
    }),
  });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.match(body.data.json.heading, /doc a/i);
  assert.match(body.data.json.code, /const a\s*=\s*1/);
});
