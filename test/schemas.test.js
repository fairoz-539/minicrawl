// Request schema behaviour that zod upgrades can silently change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlBody, extractBody, scrapeBody } from "../src/schemas.js";

test("a crawl without scrapeOptions gets the scrape defaults", () => {
  const { scrapeOptions } = crawlBody.parse({ url: "example.com" });
  assert.deepEqual(scrapeOptions.formats, ["markdown"]);
  assert.equal(scrapeOptions.onlyMainContent, true);
  assert.equal(scrapeOptions.timeout, 30_000);
});

test("extract scrapeOptions keep only the keys that were sent", () => {
  const { scrapeOptions } = extractBody.parse({ urls: ["example.com"], prompt: "x", scrapeOptions: { timeout: 5000 } });
  assert.deepEqual(scrapeOptions, { timeout: 5000 });
  assert.throws(() => extractBody.parse({ urls: ["example.com"], prompt: "x", scrapeOptions: { bogus: 1 } }));
});

test("unknown keys are rejected as unrecognized_keys", () => {
  const r = scrapeBody.safeParse({ url: "example.com", bogus: 1 });
  assert.equal(r.success, false);
  assert.equal(r.error.issues[0].code, "unrecognized_keys");
});
