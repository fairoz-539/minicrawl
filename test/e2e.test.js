import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startFixtureSite } from "./fixture-site.js";

process.env.ALLOW_PRIVATE_URLS = "true";
const { start } = await import("../src/server.js");

let site, api, base;

before(async () => {
  site = await startFixtureSite();
  api = await start({ port: 0, host: "127.0.0.1", workers: 4, dbPath: ":memory:" });
  base = `http://127.0.0.1:${api.port}`;
});

after(async () => {
  await api.close();
  await site.close();
});

const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));
const get = path => fetch(base + path).then(async r => ({ status: r.status, body: await r.json() }));

async function waitForCrawl(id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get(`/v1/crawl/${id}`);
    if (body.status !== "scraping") return body;
    if (Date.now() > deadline) throw new Error("crawl did not finish: " + JSON.stringify(body));
    await new Promise(r => setTimeout(r, 200));
  }
}

const paths = docs => docs.map(d => new URL(d.metadata.url).pathname).sort();

describe("scrape", () => {
  test("returns main-content markdown, metadata and links", async () => {
    const { status, body } = await post("/v1/scrape", { url: site.url + "/", formats: ["markdown", "links", "html"] });
    assert.equal(status, 200);
    const { markdown, links, html, metadata } = body.data;
    assert.match(markdown, /# Welcome home/);
    assert.match(markdown, /\*\*bold\*\*/);
    assert.match(markdown, /\| Col \|/); // GFM table
    assert.doesNotMatch(markdown, /Footer text/); // footer removed
    assert.doesNotMatch(html, /should be stripped/); // script removed
    assert.equal(metadata.title, "Home");
    assert.equal(metadata.description, "Home description");
    assert.equal(metadata.ogTitle, "OG Home");
    assert.equal(metadata.language, "en");
    assert.equal(metadata.statusCode, 200);
    assert.ok(links.includes(site.url + "/docs/b"), "relative link resolved, hash stripped");
    assert.ok(!links.some(l => l.startsWith("mailto:")));
  });

  test("onlyMainContent=false keeps header and footer", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/about", onlyMainContent: false });
    assert.match(body.data.markdown, /Footer text/);
  });

  test("code blocks keep their language", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/docs/a" });
    assert.match(body.data.markdown, /```js\nconst a = 1;\n```/);
  });

  test("follows redirects and reports the landing URL", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/redirect-to-about" });
    assert.equal(body.data.metadata.url, site.url + "/about");
    assert.equal(body.data.metadata.sourceURL, site.url + "/redirect-to-about");
  });

  test("honors <base href> for links", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/base-test/page", formats: ["links"] });
    assert.deepEqual(body.data.links, [site.url + "/docs/a"]);
  });

  test("a 404 page still returns content with its status code", async () => {
    const { status, body } = await post("/v1/scrape", { url: site.url + "/nope" });
    assert.equal(status, 200);
    assert.equal(body.data.metadata.statusCode, 404);
    assert.match(body.data.markdown, /404 Not Found/);
  });

  test("rejects bad input", async () => {
    assert.equal((await post("/v1/scrape", { url: "ftp://example.com" })).status, 400);
    assert.equal((await post("/v1/scrape", {})).status, 400);
    const unknown = await post("/v1/scrape", { url: site.url, bogus: 1 });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "Unrecognized key in body");
  });

  test("unsupported file types fail fast", async () => {
    const { status, body } = await post("/v1/scrape", { url: site.url + "/photo.jpg" });
    assert.equal(status, 422);
    assert.equal(body.code, "UNSUPPORTED_FILE");
  });

  test("extracts text from PDFs", async () => {
    const { status, body } = await post("/v1/scrape", { url: site.url + "/file.pdf" });
    assert.equal(status, 200);
    assert.match(body.data.markdown, /Hello from a PDF/);
    assert.equal(body.data.metadata.numPages, 1);
    assert.equal(body.data.metadata.title, "Fixture PDF");
  });

  test("JavaScript-rendered pages fall through to the browser", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/spa" });
    assert.equal(body.data.metadata.engine, "browser");
    assert.match(body.data.markdown, /# Rendered by JavaScript/);
  });

  test("fetch-only on a JavaScript page warns instead of failing", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/spa", engine: "fetch" });
    assert.equal(body.data.metadata.engine, "fetch");
    assert.match(body.data.warning, /JavaScript-rendered/);
  });

  test("bot-challenge pages are reported, not returned as content", async () => {
    const { status, body } = await post("/v1/scrape", { url: site.url + "/challenge" });
    assert.equal(status, 403);
    assert.equal(body.code, "BLOCKED_BY_SITE");
  });

  test("screenshots", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/about", formats: ["markdown", "screenshot"] });
    assert.match(body.data.screenshot, /^data:image\/png;base64,iVBOR/);
    assert.equal(body.data.metadata.engine, "browser");
  });

  test("decodes non-UTF-8 pages", async () => {
    const { body } = await post("/v1/scrape", { url: site.url + "/latin1" });
    assert.match(body.data.markdown, /Café crème €/);
  });

  test("times out", async () => {
    const { status, body } = await post("/v1/scrape", { url: site.url + "/slow", timeout: 1000 });
    assert.equal(status, 408);
    assert.equal(body.code, "SCRAPE_TIMEOUT");
  });
});

describe("crawl", () => {
  test("crawls the site: sitemap seeding, robots, dedupe, redirects", async () => {
    const { body: started } = await post("/v1/crawl", { url: site.url + "/", crawlEntireDomain: true });
    assert.ok(started.success && started.id);
    const result = await waitForCrawl(started.id);
    assert.equal(result.status, "completed");

    assert.deepEqual(paths(result.data), [
      "/",
      "/about", // /about/ and /redirect-to-about collapse into this one
      "/docs/",
      "/docs/a",
      "/docs/b",
      "/docs/c", // only reachable through the sitemap index
      "/docs/deep/1/2/3",
    ]);
    assert.equal(result.completed, result.data.length);

    const { body: errors } = await get(`/v1/crawl/${started.id}/errors`);
    assert.deepEqual(errors.robotsBlocked, [site.url + "/private/secret"]);
  });

  test("limit, maxDepth and excludePaths", async () => {
    const { body: a } = await post("/v1/crawl", { url: site.url + "/", limit: 3, crawlEntireDomain: true });
    const limited = await waitForCrawl(a.id);
    assert.equal(limited.data.length, 3);

    const { body: b } = await post("/v1/crawl", {
      url: site.url + "/", maxDepth: 1, excludePaths: ["about"], ignoreSitemap: true, crawlEntireDomain: true,
    });
    const shallow = await waitForCrawl(b.id);
    assert.deepEqual(paths(shallow.data), ["/", "/docs/"]);
  });

  test("stays under the start path unless crawlEntireDomain", async () => {
    const { body } = await post("/v1/crawl", { url: site.url + "/docs/", ignoreSitemap: true });
    const result = await waitForCrawl(body.id);
    assert.deepEqual(paths(result.data), ["/docs/", "/docs/a", "/docs/deep/1/2/3"]);
  });

  test("can be cancelled and 404s for unknown ids", async () => {
    const { body } = await post("/v1/crawl", { url: site.url + "/" });
    const del = await fetch(`${base}/v1/crawl/${body.id}`, { method: "DELETE" }).then(r => r.json());
    assert.equal(del.status, "cancelled");
    const status = await waitForCrawl(body.id);
    assert.equal(status.status, "cancelled");
    assert.equal((await get("/v1/crawl/00000000-0000-0000-0000-000000000000")).status, 404);
  });

  test("rejects invalid regexes", async () => {
    const { status } = await post("/v1/crawl", { url: site.url, includePaths: ["("] });
    assert.equal(status, 400);
  });
});

describe("map", () => {
  test("merges sitemap and page links, filters other domains", async () => {
    const { body } = await post("/v1/map", { url: site.url + "/" });
    assert.ok(body.success);
    assert.ok(body.links.includes(site.url + "/docs/c"), "from sitemap");
    assert.ok(body.links.includes(site.url + "/about"), "from page");
    assert.ok(!body.links.some(l => l.includes("external.example.org")));
    assert.equal(new Set(body.links).size, body.links.length);
  });

  test("search ranks matching URLs first, limit applies", async () => {
    const { body } = await post("/v1/map", { url: site.url + "/", search: "docs", limit: 3 });
    assert.equal(body.links.length, 3);
    assert.ok(body.links.every(l => l.includes("/docs")), JSON.stringify(body.links));
  });

  test("sitemapOnly", async () => {
    const { body } = await post("/v1/map", { url: site.url + "/", sitemapOnly: true });
    assert.deepEqual(body.links.sort(), [site.url + "/", site.url + "/docs/a", site.url + "/docs/c"].sort());
  });
});

describe("auth + SSRF guard", () => {
  test("blocks private addresses when not allowed", async () => {
    process.env.ALLOW_PRIVATE_URLS = "false";
    try {
      const { status, body } = await post("/v1/scrape", { url: site.url });
      assert.equal(status, 403);
      assert.equal(body.code, "BLOCKED_URL");
    } finally {
      process.env.ALLOW_PRIVATE_URLS = "true";
    }
  });
});
