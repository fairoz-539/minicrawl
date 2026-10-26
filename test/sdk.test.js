// Contract tests: the official Firecrawl JS SDK (@mendable/firecrawl-js), its
// default v2 client `Firecrawl` and the v1 client, against a real minicrawl
// server. If an SDK update changes what it sends or expects, this fails.
// The Python SDK (firecrawl-py) is covered by test/contract-py.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startFixtureSite } from "./fixture-site.js";
import { startMockAnthropic } from "./mock-services.js";

process.env.ALLOW_PRIVATE_URLS = "true";
process.env.DISABLE_PLAYWRIGHT = "true";
const KEY = "sdk-contract-key-0123456789";
process.env.API_KEY = KEY;

const { default: Firecrawl, FirecrawlAppV1, SdkError } = await import("@mendable/firecrawl-js");

let site, llm, api, fc, v1;

before(async () => {
  site = await startFixtureSite();
  llm = await startMockAnthropic();
  process.env.ANTHROPIC_BASE_URL = llm.url;
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.SEARXNG_ENDPOINT = `${site.url}/searx`;
  const { start } = await import("../src/server.js");
  api = await start({ port: 0, host: "127.0.0.1", workers: 4, dbPath: ":memory:" });
  const apiUrl = `http://127.0.0.1:${api.port}`;
  fc = new Firecrawl({ apiKey: KEY, apiUrl });
  v1 = new FirecrawlAppV1({ apiKey: KEY, apiUrl });
});

after(async () => {
  await api.close();
  await Promise.all([site.close(), llm.close()]);
});

const path = url => new URL(url).pathname;

describe("Firecrawl (v2 client)", () => {
  test("scrape: string and object formats", async () => {
    const doc = await fc.scrape(`${site.url}/`, {
      formats: ["markdown", "html", "links", "images", { type: "attributes", selectors: [{ selector: "a", attribute: "href" }] }],
      onlyMainContent: true,
    });
    assert.match(doc.markdown, /# Welcome home/);
    assert.match(doc.html, /Welcome home/);
    assert.ok(doc.links.some(l => l.endsWith("/about")));
    assert.ok(Array.isArray(doc.images));
    assert.ok(doc.attributes[0].values.includes("/about"));
    assert.equal(doc.metadata.statusCode, 200);
    assert.equal(doc.metadata.title, "Home");
  });

  test("scrape: json and summary formats (AI)", async () => {
    llm.state.reply = body => (JSON.stringify(body).includes("Summarize") ? { summary: "A home page." } : { title: "Home" });
    const doc = await fc.scrape(`${site.url}/`, {
      formats: [{ type: "json", prompt: "the title", schema: { type: "object", properties: { title: { type: "string" } } } }, "summary"],
    });
    assert.deepEqual(doc.json, { title: "Home" });
    assert.equal(doc.summary, "A home page.");
  });

  test("scrape: unsupported formats are refused, not ignored", async () => {
    await assert.rejects(fc.scrape(`${site.url}/`, { formats: ["branding"] }), err => {
      assert.ok(err instanceof SdkError);
      assert.equal(err.status, 400);
      assert.match(err.message, /branding format is not supported/);
      return true;
    });
  });

  test("crawl: waits for completion, with pages, errors and status", async () => {
    const job = await fc.crawl(`${site.url}/`, { limit: 5, scrapeOptions: { formats: ["markdown"] }, pollInterval: 1 });
    assert.equal(job.status, "completed");
    assert.ok(job.data.length >= 3 && job.data.length <= 5, `got ${job.data.length}`);
    assert.ok(job.data.every(d => d.markdown && d.metadata.sourceURL));
    assert.ok(job.expiresAt);
    const errors = await fc.getCrawlErrors(job.id);
    assert.ok(Array.isArray(errors.errors));
    assert.ok(errors.robotsBlocked.some(u => path(u).startsWith("/private")));
  });

  test("crawl: start, active list, cancel", async () => {
    const started = await fc.startCrawl(`${site.url}/`, { limit: 50, sitemap: "skip", delay: 1 });
    assert.ok(started.id);
    assert.match(started.url, /\/v2\/crawl\//);
    const active = await fc.getActiveCrawls();
    assert.ok(active.crawls.some(c => c.id === started.id));
    assert.equal(await fc.cancelCrawl(started.id), true);
    const status = await fc.getCrawlStatus(started.id);
    assert.equal(status.status, "cancelled");
  });

  test("cancelling a finished crawl answers false (409)", async () => {
    const job = await fc.crawl(`${site.url}/about`, { limit: 1, pollInterval: 1 });
    assert.equal(job.status, "completed");
    assert.equal(await fc.cancelCrawl(job.id), false);
  });

  test("batch scrape: waits for completion; invalid URLs are reported", async () => {
    const urls = [`${site.url}/`, `${site.url}/about`, `${site.url}/docs/a`];
    const job = await fc.batchScrape(urls, { options: { formats: ["markdown"] }, pollInterval: 1 });
    assert.equal(job.status, "completed");
    assert.deepEqual(job.data.map(d => path(d.metadata.sourceURL)).sort(), ["/", "/about", "/docs/a"]);

    const started = await fc.startBatchScrape([`${site.url}/about`, "not a url"], { options: { formats: ["markdown"] } });
    assert.deepEqual(started.invalidURLs, ["not a url"]);
    const status = await fc.getBatchScrapeStatus(started.id);
    assert.ok(["scraping", "completed"].includes(status.status));
    const errors = await fc.getBatchScrapeErrors(started.id);
    assert.deepEqual(errors.errors, []);
  });

  test("batch scrape: cancel", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `${site.url}/slow?i=${i}`);
    const started = await fc.startBatchScrape(urls, { options: { formats: ["markdown"] } });
    assert.equal(await fc.cancelBatchScrape(started.id), true);
    assert.equal((await fc.getBatchScrapeStatus(started.id)).status, "cancelled");
  });

  test("map: links with titles", async () => {
    await fc.scrape(`${site.url}/about`); // so the index knows its title
    const res = await fc.map(`${site.url}/`, { limit: 50, sitemap: "include" });
    assert.ok(res.links.length >= 3);
    assert.ok(res.links.every(l => typeof l.url === "string"));
    assert.equal(res.links.find(l => path(l.url) === "/about")?.title, "About");
    const searched = await fc.map(`${site.url}/`, { search: "about" });
    assert.equal(path(searched.links[0].url), "/about");
  });

  test("search: web, news and images, optionally scraped", async () => {
    const res = await fc.search("minicrawl", { sources: ["web", "news", "images"], limit: 5 });
    assert.equal(res.web[0].title, "Doc A");
    assert.equal(res.web[0].position, 1);
    assert.equal(res.news[0].title, "News A");
    assert.ok(res.news[0].date);
    assert.equal(res.images[0].imageWidth, 640);
    const scraped = await fc.search("minicrawl", { limit: 2, scrapeOptions: { formats: ["markdown"] } });
    assert.ok(scraped.web.every(r => r.markdown && r.url));
  });

  test("extract: with URLs", async () => {
    llm.state.reply = { title: "Doc A" };
    const res = await fc.extract({
      urls: [`${site.url}/docs/a`],
      prompt: "the title",
      schema: { type: "object", properties: { title: { type: "string" } } },
      pollInterval: 1,
    });
    assert.equal(res.status, "completed");
    assert.deepEqual(res.data, { title: "Doc A" });
  });

  test("team: concurrency, credits, tokens, queue", async () => {
    const c = await fc.getConcurrency();
    assert.equal(typeof c.concurrency, "number");
    assert.equal(typeof c.maxConcurrency, "number");
    const credits = await fc.getCreditUsage();
    assert.ok(credits.remainingCredits > 0);
    assert.ok(credits.billingPeriodStart && credits.billingPeriodEnd);
    const tokens = await fc.getTokenUsage();
    assert.ok(tokens.remainingTokens > 0);
    const q = await fc.getQueueStatus();
    assert.equal(q.success, true);
    assert.equal(typeof q.jobsInQueue, "number");
    assert.ok(q.mostRecentSuccess); // jobs completed above
    const hist = await fc.getCreditUsageHistorical();
    assert.ok(hist.periods.at(-1).creditsUsed > 0);
    const tokHist = await fc.getTokenUsageHistorical();
    assert.ok(tokHist.periods.at(-1).tokensUsed > 0);
  });

  test("errors surface as SdkError with status", async () => {
    await assert.rejects(fc.getCrawlStatus("00000000-0000-0000-0000-000000000000"), err => err instanceof SdkError && err.status === 404);
    const bad = new Firecrawl({ apiKey: "wrong-key-0123456789abcdef", apiUrl: `http://127.0.0.1:${api.port}` });
    await assert.rejects(bad.scrape(`${site.url}/`), err => err instanceof SdkError && err.status === 401);
  });
});

describe("FirecrawlAppV1 (v1 client)", () => {
  test("batch scrape and its status", async () => {
    const res = await v1.batchScrapeUrls([`${site.url}/`, `${site.url}/about`], { formats: ["markdown"] }, 1);
    assert.equal(res.success, true, JSON.stringify(res));
    assert.equal(res.status, "completed");
    assert.equal(res.data.length, 2);
    const started = await v1.asyncBatchScrapeUrls([`${site.url}/docs/a`], { formats: ["markdown"] });
    assert.equal(started.success, true);
    let status;
    for (let i = 0; i < 40; i++) {
      status = await v1.checkBatchScrapeStatus(started.id);
      if (status.status === "completed") break;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.equal(status.status, "completed");
    assert.equal(status.data.length, 1);
  });
});
