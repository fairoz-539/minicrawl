// /v2 and batch scrape over HTTP: what the SDK contract tests (test/sdk.test.js)
// don't reach. Batch edge cases, appendToId, webhooks, tenancy on v2, team
// usage, search filters, prompt-only extract.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startFixtureSite } from "./fixture-site.js";
import { startMockAnthropic } from "./mock-services.js";

process.env.ALLOW_PRIVATE_URLS = "true";
process.env.DISABLE_PLAYWRIGHT = "true";
const ROOT = "v2-root-key-0123456789abcdef";
process.env.API_KEY = ROOT;

let site, llm, api, base;

before(async () => {
  site = await startFixtureSite();
  llm = await startMockAnthropic();
  process.env.ANTHROPIC_BASE_URL = llm.url;
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.SEARXNG_ENDPOINT = `${site.url}/searx`;
  const { start } = await import("../src/server.js");
  api = await start({ port: 0, host: "127.0.0.1", workers: 4, dbPath: ":memory:" });
  base = `http://127.0.0.1:${api.port}`;
});

after(async () => {
  await api.close();
  await Promise.all([site.close(), llm.close()]);
});

async function call(method, path, body, key = ROOT) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

async function waitFor(path, key = ROOT, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call("GET", path, undefined, key);
    if (!["scraping", "processing"].includes(body.status)) return body;
    if (Date.now() > deadline) throw new Error(`${path} did not finish: ${JSON.stringify(body)}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

const paths = docs => docs.map(d => new URL(d.metadata.sourceURL).pathname).sort();

describe("batch scrape", () => {
  test("v1: invalid URLs fail the request unless ignoreInvalidURLs", async () => {
    const bad = await call("POST", "/v1/batch/scrape", { urls: [`${site.url}/`, "not a url"] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not a url/);
    const ok = await call("POST", "/v1/batch/scrape", { urls: [`${site.url}/`, "not a url"], ignoreInvalidURLs: true, formats: ["markdown"] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.invalidURLs, ["not a url"]);
    assert.match(ok.body.url, /\/v1\/batch\/scrape\//);
    const done = await waitFor(`/v1/batch/scrape/${ok.body.id}`);
    assert.equal(done.status, "completed");
    assert.deepEqual(paths(done.data), ["/"]);
  });

  test("one document per URL, redirects included; no link discovery", async () => {
    const { body } = await call("POST", "/v2/batch/scrape", { urls: [`${site.url}/about`, `${site.url}/redirect-to-about`] });
    const done = await waitFor(`/v2/batch/scrape/${body.id}`);
    assert.equal(done.completed, 2);
    assert.deepEqual(paths(done.data), ["/about", "/redirect-to-about"]);
  });

  test("appendToId adds URLs to a batch, even after it finished", async () => {
    const { body } = await call("POST", "/v2/batch/scrape", { urls: [`${site.url}/`] });
    await waitFor(`/v2/batch/scrape/${body.id}`);
    const more = await call("POST", "/v2/batch/scrape", { urls: [`${site.url}/about`, `${site.url}/docs/a`], appendToId: body.id });
    assert.equal(more.body.id, body.id);
    const done = await waitFor(`/v2/batch/scrape/${body.id}`);
    assert.equal(done.status, "completed");
    assert.deepEqual(paths(done.data), ["/", "/about", "/docs/a"]);
  });

  test("batches and crawls don't answer for each other", async () => {
    const { body } = await call("POST", "/v1/batch/scrape", { urls: [`${site.url}/`] });
    assert.equal((await call("GET", `/v1/crawl/${body.id}`)).status, 404);
    assert.equal((await call("GET", `/v2/crawl/${body.id}`)).status, 404);
    const crawl = await call("POST", "/v2/crawl", { url: `${site.url}/about`, limit: 1 });
    assert.equal((await call("GET", `/v2/batch/scrape/${crawl.body.id}`)).status, 404);
  });

  test("webhooks: batch_scrape.started, .page, .completed", async () => {
    const events = [];
    const receiver = http.createServer((req, res) => {
      let data = "";
      req.on("data", c => (data += c));
      req.on("end", () => {
        events.push(JSON.parse(data).type);
        res.end("ok");
      });
    });
    await new Promise(r => receiver.listen(0, "127.0.0.1", r));
    try {
      const { body } = await call("POST", "/v2/batch/scrape", {
        urls: [`${site.url}/`, `${site.url}/about`],
        webhook: { url: `http://127.0.0.1:${receiver.address().port}/hook` },
      });
      await waitFor(`/v2/batch/scrape/${body.id}`);
      for (let i = 0; i < 40 && !events.includes("batch_scrape.completed"); i++) await new Promise(r => setTimeout(r, 100));
      assert.equal(events.filter(e => e === "batch_scrape.page").length, 2);
      assert.ok(events.includes("batch_scrape.started"));
      assert.ok(events.includes("batch_scrape.completed"));
    } finally {
      receiver.close();
    }
  });
});

describe("v2 requests", () => {
  test("crawl: prompt-generated options are refused with a clear error", async () => {
    const r = await call("POST", "/v2/crawl", { url: `${site.url}/`, prompt: "only the docs" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not supported/);
  });

  test("crawl: v2 options are translated (sitemap skip, maxDiscoveryDepth, scrapeOptions)", async () => {
    const { body } = await call("POST", "/v2/crawl", {
      url: `${site.url}/`,
      sitemap: "skip",
      maxDiscoveryDepth: 0,
      scrapeOptions: { formats: [{ type: "screenshot", fullPage: true }, "links"] },
    });
    // Screenshots need a browser, which this test run doesn't have: the page fails, cleanly.
    const done = await waitFor(`/v2/crawl/${body.id}`);
    assert.equal(done.total, 1); // depth 0, no sitemap: just the start page
    const errors = await call("GET", `/v2/crawl/${body.id}/errors`);
    assert.match(errors.body.errors[0].error, /browser/);
  });

  test("unknown options are rejected, compatibility-only options accepted", async () => {
    const unknown = await call("POST", "/v2/scrape", { url: `${site.url}/`, notAnOption: true });
    assert.equal(unknown.status, 400);
    const compat = await call("POST", "/v2/scrape", {
      url: `${site.url}/`,
      mobile: true,
      blockAds: true,
      maxAge: 0,
      parsers: ["pdf"],
      location: { country: "DE", languages: ["de-DE"] },
      proxy: "basic",
    });
    assert.equal(compat.status, 200);
  });

  test("search: domain filters and categories", async () => {
    const only = await call("POST", "/v2/search", { query: "x", includeDomains: ["example.com"] });
    assert.deepEqual(only.body.data.web, []); // fixture results are on 127.0.0.1
    const gh = await call("POST", "/v2/search", { query: "repos", categories: ["github"] });
    assert.match(gh.body.data.web[0].description, /site:github\.com/); // the fixture echoes the query
    const bad = await call("POST", "/v2/search", { query: "x", sources: ["alexandria"] });
    assert.equal(bad.status, 400);
  });

  test("extract without URLs searches the web for the prompt", async () => {
    llm.state.reply = { title: "Doc A" };
    const { body } = await call("POST", "/v2/extract", { prompt: "the title of doc a", showSources: true });
    const done = await waitFor(`/v2/extract/${body.id}`);
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.deepEqual(done.data, { title: "Doc A" });
    assert.ok(done.sources.length >= 1);
  });
});

describe("teams on v2", () => {
  async function team(name, extra = {}) {
    const t = await call("POST", "/admin/v1/teams", { name, ...extra });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const k = await call("POST", "/admin/v1/keys", { name: `${name}-key`, teamId: t.body.data.id, role: "member" });
    return k.body.key;
  }

  test("isolation, quotas and credit usage", async () => {
    const key = await team("v2-quota", { limits: { pagesPerMonth: 3 } });
    const other = await team("v2-other");
    const { body } = await call("POST", "/v2/batch/scrape", { urls: [`${site.url}/`, `${site.url}/about`] }, key);
    await waitFor(`/v2/batch/scrape/${body.id}`, key);
    assert.equal((await call("GET", `/v2/batch/scrape/${body.id}`, undefined, other)).status, 404);

    const credits = await call("GET", "/v2/team/credit-usage", undefined, key);
    assert.equal(credits.body.data.planCredits, 3);
    assert.equal(credits.body.data.remainingCredits, 1);
    assert.equal((await call("POST", "/v2/scrape", { url: `${site.url}/docs/a` }, key)).status, 200);
    const over = await call("POST", "/v2/scrape", { url: `${site.url}/` }, key);
    assert.equal(over.status, 402);
    assert.equal(over.body.code, "QUOTA_EXCEEDED");
    assert.equal((await call("GET", "/v2/team/credit-usage", undefined, key)).body.data.remainingCredits, 0);
  });

  test("viewers can read status but not start work", async () => {
    const t = await call("POST", "/admin/v1/teams", { name: "v2-viewers" });
    const viewer = (await call("POST", "/admin/v1/keys", { name: "v", teamId: t.body.data.id, role: "viewer" })).body.key;
    assert.equal((await call("POST", "/v2/scrape", { url: `${site.url}/` }, viewer)).status, 403);
    assert.equal((await call("POST", "/v2/batch/scrape", { urls: [`${site.url}/`] }, viewer)).status, 403);
    assert.equal((await call("GET", "/v2/team/queue-status", undefined, viewer)).status, 200);
  });
});
