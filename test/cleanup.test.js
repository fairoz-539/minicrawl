// Data expiry: old crawl/extract data is deleted, nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, Queue, CrawlStore } from "../src/db.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function setup() {
  const db = openDb(":memory:");
  const queue = new Queue(db);
  const store = new CrawlStore(db);
  const now = Date.now();
  const age = (table, id, ms) => db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(ms, id);

  // A finished crawl from two days ago, with jobs, visited URLs and a robots log.
  store.create("old-done", { url: "https://a.example" });
  store.setStatus("old-done", "completed");
  age("crawls", "old-done", now - 2 * DAY);
  const j = queue.add({ type: "scrape", groupId: "old-done", data: { url: "https://a.example/1" } });
  store.lockURL("old-done", "https://a.example/1");
  store.recordRobotsBlocked("old-done", ["https://a.example/private"]);

  // A crawl started two days ago that is still running: must be kept.
  store.create("old-running", { url: "https://b.example" });
  age("crawls", "old-running", now - 2 * DAY);
  queue.add({ type: "scrape", groupId: "old-running", data: { url: "https://b.example/1" } });

  // A recent finished crawl: must be kept.
  store.create("recent", { url: "https://c.example" });
  store.setStatus("recent", "completed");

  // Standalone extract jobs: old+finished (delete), old+queued (keep), recent+finished (keep).
  const oldDone = queue.add({ type: "extract", data: {} });
  const oldQueued = queue.add({ type: "extract", data: {} });
  const recentDone = queue.add({ type: "extract", data: {} });
  db.prepare("UPDATE jobs SET status = 'completed' WHERE id IN (?, ?)").run(oldDone, recentDone);
  age("jobs", oldDone, (now - 2 * DAY) * 1000);
  age("jobs", oldQueued, (now - 2 * DAY) * 1000);

  // URL index: one stale (40 days), one fresh.
  store.recordSeen("https://a.example/stale");
  db.prepare("UPDATE seen_urls SET last_seen = ? WHERE url = ?").run(now - 40 * DAY, "https://a.example/stale");
  store.recordSeen("https://a.example/fresh");

  return { db, queue, store, ids: { j, oldDone, oldQueued, recentDone } };
}

test("deletes expired, finished data and keeps everything else", () => {
  const { db, queue, store, ids } = setup();
  const removed = store.pruneExpired({ dataTtlMs: DAY, seenTtlMs: 30 * DAY });

  assert.deepEqual(removed, { crawls: 1, jobs: 2, seenUrls: 1 });
  assert.equal(store.get("old-done"), null);
  assert.equal(queue.get(ids.j), null, "the crawl's jobs are deleted with it");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM visited WHERE crawl_id = 'old-done'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM robots_blocked WHERE crawl_id = 'old-done'").get().n, 0);

  assert.ok(store.get("old-running"), "running crawls are never deleted");
  assert.equal(queue.groupCounts("old-running").queued, 1);
  assert.ok(store.get("recent"));

  assert.equal(queue.get(ids.oldDone), null);
  assert.ok(queue.get(ids.oldQueued), "unfinished jobs are kept");
  assert.ok(queue.get(ids.recentDone));

  assert.deepEqual(store.seenForHost("a.example").map(r => r.url), ["https://a.example/fresh"]);
});

test("a TTL of 0 keeps data forever", () => {
  const { store } = setup();
  assert.deepEqual(store.pruneExpired({ dataTtlMs: 0, seenTtlMs: 0 }), { crawls: 0, jobs: 0, seenUrls: 0 });
  assert.ok(store.get("old-done"));
});

test("works in bounded batches", () => {
  const { db, store } = setup();
  for (let i = 0; i < 5; i++) {
    store.create(`bulk-${i}`, {});
    store.setStatus(`bulk-${i}`, "completed");
    db.prepare("UPDATE crawls SET created_at = ? WHERE id = ?").run(Date.now() - 3 * DAY, `bulk-${i}`);
  }
  assert.equal(store.pruneExpired({ dataTtlMs: DAY, seenTtlMs: 0, batch: 2 }).crawls, 2);
  assert.equal(store.pruneExpired({ dataTtlMs: DAY, seenTtlMs: 0, batch: 2 }).crawls, 2);
  assert.equal(store.pruneExpired({ dataTtlMs: DAY, seenTtlMs: 0, batch: 10 }).crawls, 2); // bulk-4 + old-done
});
