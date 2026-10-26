// Page cache: maxAge, storeInCache, what the key covers, what is never cached.
// Backend-neutral: runs on SQLite by default and on Postgres with STORAGE=postgres.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startFixtureSite } from "./fixture-site.js";

process.env.ALLOW_PRIVATE_URLS = "true";
process.env.DISABLE_PLAYWRIGHT = "true";
const ROOT = "cache-root-key-0123456789abcdef";
process.env.API_KEY = ROOT;

let site, api, base;

before(async () => {
  site = await startFixtureSite();
  const { start } = await import("../src/server.js");
  api = await start({ port: 0, host: "127.0.0.1", workers: 2, dbPath: ":memory:" });
  base = `http://127.0.0.1:${api.port}`;
});

after(async () => {
  await api.close();
  await site.close();
});

async function post(path, body, key = ROOT) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

/** Which fetch of /counter the document came from ("Fetch 3" -> 3). */
const fetchNo = doc => Number(doc.markdown.match(/Fetch (\d+)/)[1]);
const counter = q => `${site.url}/counter?${q}`;

describe("page cache", () => {
  test("maxAge reuses a fresh copy; maxAge 0 always fetches", async () => {
    const url = counter("basic");
    const first = (await post("/v1/scrape", { url, maxAge: 60_000 })).body.data;
    assert.equal(fetchNo(first), 1);
    assert.equal(first.metadata.cacheState, "miss");

    const second = (await post("/v1/scrape", { url, maxAge: 60_000 })).body.data;
    assert.equal(fetchNo(second), 1); // the site was not asked again
    assert.equal(second.metadata.cacheState, "hit");
    assert.ok(Date.parse(second.metadata.cachedAt) <= Date.now());

    const fresh = (await post("/v1/scrape", { url })).body.data; // no maxAge
    assert.equal(fetchNo(fresh), 2);
    assert.equal(fresh.metadata.cacheState, undefined);
    // ...and the fresh fetch replaced the cached copy.
    assert.equal(fetchNo((await post("/v1/scrape", { url, maxAge: 60_000 })).body.data), 2);
  });

  test("an entry older than maxAge is not used", async () => {
    const url = counter("aging");
    await post("/v1/scrape", { url });
    await new Promise(r => setTimeout(r, 50));
    const doc = (await post("/v1/scrape", { url, maxAge: 10 })).body.data;
    assert.equal(fetchNo(doc), 2);
    assert.equal(doc.metadata.cacheState, "miss");
  });

  test("formats are rebuilt from the cached page", async () => {
    const url = counter("formats");
    await post("/v1/scrape", { url, formats: ["markdown"] });
    const r = await post("/v1/scrape", { url, maxAge: 60_000, formats: ["html", "links", "markdown"], onlyMainContent: false });
    assert.equal(r.body.data.metadata.cacheState, "hit");
    assert.match(r.body.data.html, /Fetch 1/);
    assert.ok(Array.isArray(r.body.data.links));
  });

  test("different headers never share an entry", async () => {
    const url = counter("headers");
    await post("/v1/scrape", { url, headers: { "X-Variant": "a" } });
    const other = (await post("/v1/scrape", { url, maxAge: 60_000, headers: { "X-Variant": "b" } })).body.data;
    assert.equal(other.metadata.cacheState, "miss");
    assert.match(other.markdown, /header: b/);
    const same = (await post("/v1/scrape", { url, maxAge: 60_000, headers: { "x-variant": "a" } })).body.data;
    assert.equal(same.metadata.cacheState, "hit");
    assert.match(same.markdown, /header: a/);
  });

  test("storeInCache: false doesn't store", async () => {
    const url = counter("nostore");
    await post("/v1/scrape", { url, storeInCache: false });
    const doc = (await post("/v1/scrape", { url, maxAge: 60_000 })).body.data;
    assert.equal(doc.metadata.cacheState, "miss");
  });

  test("zero data retention teams never write to or read from the cache", async () => {
    const team = await post("/admin/v1/teams", { name: "cache-zdr", settings: { zdr: true } });
    const key = (await post("/admin/v1/keys", { name: "z", teamId: team.body.data.id, role: "member" })).body.key;
    const url = counter("zdr");
    await post("/v1/scrape", { url }, key);
    const rows = await api.ctx.storage.exec("SELECT key FROM page_cache WHERE url = ?", url);
    assert.equal(rows.length, 0);
    await post("/v1/scrape", { url }); // another team caches it
    const doc = (await post("/v1/scrape", { url, maxAge: 60_000 }, key)).body.data;
    assert.equal(fetchNo(doc), 3); // ...but the ZDR team still fetches
    // A v2 request can ask for zero data retention too.
    const url2 = counter("zdr-request");
    await post("/v2/scrape", { url: url2, zeroDataRetention: true });
    assert.equal((await api.ctx.storage.exec("SELECT key FROM page_cache WHERE url = ?", url2)).length, 0);
  });

  test("v2 maxAge and crawls use the cache", async () => {
    const url = counter("v2");
    await post("/v2/scrape", { url });
    const v2 = (await post("/v2/scrape", { url, maxAge: 60_000 })).body.data;
    assert.equal(v2.metadata.cacheState, "hit");

    await post("/v1/scrape", { url: `${site.url}/about` });
    const crawl = await post("/v2/crawl", { url: `${site.url}/about`, limit: 1, scrapeOptions: { maxAge: 60_000 } });
    let status;
    for (let i = 0; i < 50; i++) {
      status = await fetch(`${base}/v2/crawl/${crawl.body.id}`, { headers: { authorization: `Bearer ${ROOT}` } }).then(r => r.json());
      if (status.status === "completed") break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(status.data[0].metadata.cacheState, "hit");
  });

  test("old entries are pruned, payloads are compressed", async () => {
    const stats = await api.ctx.storage.cache.stats();
    assert.ok(stats.entries > 0);
    const [row] = await api.ctx.storage.exec("SELECT size, payload FROM page_cache LIMIT 1");
    assert.equal(Number(row.size), row.payload.length);
    const removed = await api.ctx.storage.cache.prune({ ttlMs: 1, now: Date.now() + 1000 });
    assert.equal(removed, stats.entries);
    assert.equal((await api.ctx.storage.cache.stats()).entries, 0);
  });
});
