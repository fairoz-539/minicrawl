// Data expiry: old crawl/extract data is deleted, nothing else.
// Backend-neutral: runs on SQLite by default and on Postgres with STORAGE=postgres.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openStorage } from "../src/storage.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const opened = [];

after(async () => {
  for (const s of opened) await s.close();
});

async function setup() {
  const storage = await openStorage({ dbPath: ":memory:" });
  opened.push(storage);
  const { queue, store } = storage;
  const now = Date.now();
  const age = (table, id, ms) => storage.exec(`UPDATE ${table} SET created_at = ? WHERE id = ?`, ms, id);

  // A finished crawl from two days ago, with jobs, visited URLs and a robots log.
  await store.create("old-done", { url: "https://a.example" });
  await store.setStatus("old-done", "completed");
  await age("crawls", "old-done", now - 2 * DAY);
  const j = await queue.add({ type: "scrape", groupId: "old-done", data: { url: "https://a.example/1" } });
  await store.lockURL("old-done", "https://a.example/1");
  await store.recordRobotsBlocked("old-done", ["https://a.example/private"]);

  // A crawl started two days ago that is still running: must be kept.
  await store.create("old-running", { url: "https://b.example" });
  await age("crawls", "old-running", now - 2 * DAY);
  await queue.add({ type: "scrape", groupId: "old-running", data: { url: "https://b.example/1" } });

  // A recent finished crawl: must be kept.
  await store.create("recent", { url: "https://c.example" });
  await store.setStatus("recent", "completed");

  // Standalone extract jobs: old+finished (delete), old+queued (keep), recent+finished (keep).
  const oldDone = await queue.add({ type: "extract", data: {} });
  const oldQueued = await queue.add({ type: "extract", data: {} });
  const recentDone = await queue.add({ type: "extract", data: {} });
  await storage.exec("UPDATE jobs SET status = 'completed' WHERE id IN (?, ?)", oldDone, recentDone);
  await age("jobs", oldDone, (now - 2 * DAY) * 1000);
  await age("jobs", oldQueued, (now - 2 * DAY) * 1000);

  // URL index: one stale (40 days), one fresh.
  await store.recordSeen("https://a.example/stale");
  await storage.exec("UPDATE seen_urls SET last_seen = ? WHERE url = ?", now - 40 * DAY, "https://a.example/stale");
  await store.recordSeen("https://a.example/fresh");

  return { storage, queue, store, ids: { j, oldDone, oldQueued, recentDone } };
}

const count = async (storage, sql, ...params) => Number((await storage.exec(sql, ...params))[0].n);

test("deletes expired, finished data and keeps everything else", async () => {
  const { storage, queue, store, ids } = await setup();
  const removed = await store.pruneExpired({ dataTtlMs: DAY, seenTtlMs: 30 * DAY });

  assert.deepEqual(removed, { crawls: 1, jobs: 2, seenUrls: 1 });
  assert.equal(await store.get("old-done"), null);
  assert.equal(await queue.get(ids.j), null, "the crawl's jobs are deleted with it");
  assert.equal(await count(storage, "SELECT COUNT(*) AS n FROM visited WHERE crawl_id = 'old-done'"), 0);
  assert.equal(await count(storage, "SELECT COUNT(*) AS n FROM robots_blocked WHERE crawl_id = 'old-done'"), 0);

  assert.ok(await store.get("old-running"), "running crawls are never deleted");
  assert.equal((await queue.groupCounts("old-running")).queued, 1);
  assert.ok(await store.get("recent"));

  assert.equal(await queue.get(ids.oldDone), null);
  assert.ok(await queue.get(ids.oldQueued), "unfinished jobs are kept");
  assert.ok(await queue.get(ids.recentDone));

  assert.deepEqual((await store.seenForHost("a.example")).map(r => r.url), ["https://a.example/fresh"]);
});

test("a TTL of 0 keeps data forever", async () => {
  const { store } = await setup();
  assert.deepEqual(await store.pruneExpired({ dataTtlMs: 0, seenTtlMs: 0 }), { crawls: 0, jobs: 0, seenUrls: 0 });
  assert.ok(await store.get("old-done"));
});

test("works in bounded batches", async () => {
  const { storage, store } = await setup();
  for (let i = 0; i < 5; i++) {
    await store.create(`bulk-${i}`, {});
    await store.setStatus(`bulk-${i}`, "completed");
    await storage.exec("UPDATE crawls SET created_at = ? WHERE id = ?", Date.now() - 3 * DAY, `bulk-${i}`);
  }
  assert.equal((await store.pruneExpired({ dataTtlMs: DAY, seenTtlMs: 0, batch: 2 })).crawls, 2);
  assert.equal((await store.pruneExpired({ dataTtlMs: DAY, seenTtlMs: 0, batch: 2 })).crawls, 2);
  assert.equal((await store.pruneExpired({ dataTtlMs: DAY, seenTtlMs: 0, batch: 10 })).crawls, 2); // bulk-4 + old-done
});

test("lockURL is first-caller-wins and respects the limit", async () => {
  const { storage, store } = await setup();
  await store.create("lim", {});
  assert.equal(await store.lockURL("lim", "https://x.example/1", 2), true);
  assert.equal(await store.lockURL("lim", "https://x.example/1", 2), false, "same URL twice");
  assert.equal(await store.lockURL("lim", "https://x.example/2", 2), true);
  assert.equal(await store.lockURL("lim", "https://x.example/3", 2), false, "over the limit");
  assert.equal(await count(storage, "SELECT COUNT(*) AS n FROM visited WHERE crawl_id = 'lim'"), 2);
});
