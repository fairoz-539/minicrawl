// Page cache: fetched pages, reused when a request allows it (`maxAge`).
//
// What is cached is the fetched page (HTML, final URL, status, screenshot,
// document text), not the formatted result, so every request still gets its
// own formats, main-content cleaning and AI extraction. The cache key is the
// URL plus the options that change what is fetched (headers, waitFor,
// screenshot, proxy, engine, TLS), so requests with different headers (e.g.
// cookies) never share an entry.
//
// It lives in minicrawl's own database (SQLite or Postgres), gzip-compressed:
// no external storage. Never cached: pages with browser actions, error pages,
// and anything for zero-data-retention teams or requests.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const PAGE_CACHE_ENABLED = process.env.PAGE_CACHE !== "false";
/** How long entries are kept at all (the longest useful maxAge). 0 = until PAGE_CACHE is turned off. */
export const PAGE_CACHE_TTL_MS = Number(process.env.PAGE_CACHE_TTL_HOURS ?? 48) * 60 * 60 * 1000;
/** maxAge for requests that don't send one. 0 = only use the cache when asked. */
export const DEFAULT_MAX_AGE_MS = Number(process.env.PAGE_CACHE_DEFAULT_MAX_AGE_MS ?? 0);
/** Compressed pages larger than this aren't cached. */
const MAX_BYTES = Number(process.env.PAGE_CACHE_MAX_BYTES ?? 5_000_000);

const lowerKeys = obj =>
  Object.fromEntries(
    Object.entries(obj ?? {})
      .map(([k, v]) => [k.toLowerCase(), v])
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/** Cache key: the URL (without #fragment) and every option that changes the fetched page. */
export function cacheKey(url, opts, screenshot) {
  let u = url;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    u = parsed.href;
  } catch {}
  const material = {
    u,
    h: lowerKeys(opts.headers),
    w: opts.waitFor ?? 0,
    s: screenshot ?? null,
    p: opts.proxy ?? "auto",
    e: opts.engine ?? "auto",
    t: !!opts.skipTlsVerification,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export const encodePage = page => gzipSync(Buffer.from(JSON.stringify(page))).toString("base64");
export const decodePage = payload => JSON.parse(gunzipSync(Buffer.from(payload, "base64")).toString());

/**
 * The page-cache table, shared by both storage backends. `db` is the same
 * adapter as TenancyStore's: all(sql, params) -> rows, run(sql, params) -> changes.
 */
export class PageCacheStore {
  constructor(db) {
    this.db = db;
  }

  async get(key) {
    const [r] = await this.db.all("SELECT payload, created_at FROM page_cache WHERE key = ?", [key]);
    return r ? { payload: r.payload, createdAt: Number(r.created_at) } : null;
  }

  /** Store a page; returns false when it's too large to cache. */
  async put(key, url, page, now = Date.now()) {
    const payload = encodePage(page);
    if (payload.length > MAX_BYTES) return false;
    await this.db.run(
      `INSERT INTO page_cache (key, url, payload, size, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET url = excluded.url, payload = excluded.payload, size = excluded.size, created_at = excluded.created_at`,
      [key, url, payload, payload.length, now],
    );
    return true;
  }

  /** Delete entries older than ttlMs, in bounded batches. */
  async prune({ ttlMs = PAGE_CACHE_TTL_MS, now = Date.now(), batch = 1000 } = {}) {
    if (!(ttlMs > 0) && PAGE_CACHE_ENABLED) return 0;
    // With the cache turned off, everything goes.
    const cutoff = PAGE_CACHE_ENABLED ? now - ttlMs : now + 1;
    return this.db.run("DELETE FROM page_cache WHERE key IN (SELECT key FROM page_cache WHERE created_at < ? LIMIT ?)", [cutoff, batch]);
  }

  async stats() {
    const [r] = await this.db.all("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM page_cache", []);
    return { entries: Number(r.n), bytes: Number(r.bytes) };
  }
}
