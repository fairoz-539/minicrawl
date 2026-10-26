-- Page cache (v1.5): fetched pages reused with maxAge. Same table as PAGE_CACHE_SCHEMA in src/db.js.
-- payload is gzip-compressed JSON, base64-encoded (TEXT, so it's the same on both backends).

CREATE TABLE IF NOT EXISTS page_cache (
  key        TEXT PRIMARY KEY,   -- sha256 of URL + fetch options (src/page-cache.js)
  url        TEXT NOT NULL,
  payload    TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_cache_created_idx ON page_cache (created_at);
