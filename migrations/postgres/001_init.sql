-- minicrawl storage, Postgres flavour (scale mode). Same model as src/db.js.
-- JSON payloads are TEXT, not JSONB: JSONB rejects \u0000, which scraped pages contain.
-- Timestamps are BIGINT milliseconds (jobs.created_at: ms * 1000 + sequence, for FIFO order).

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  priority    INTEGER NOT NULL DEFAULT 10,
  data        TEXT NOT NULL,
  group_id    TEXT,
  lock        TEXT,
  locked_at   BIGINT,
  stalls      INTEGER NOT NULL DEFAULT 0,
  result      TEXT,
  error       TEXT,
  created_at  BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS jobs_queued_idx ON jobs (priority, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (locked_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_group_idx ON jobs (group_id, status);
CREATE INDEX IF NOT EXISTS jobs_standalone_done_idx ON jobs (created_at)
  WHERE group_id IS NULL AND status IN ('completed', 'failed');

CREATE TABLE IF NOT EXISTS crawls (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'scraping',
  data        TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS crawls_status_created_idx ON crawls (status, created_at);

CREATE TABLE IF NOT EXISTS visited (
  crawl_id TEXT NOT NULL,
  url      TEXT NOT NULL,
  PRIMARY KEY (crawl_id, url)
);

CREATE TABLE IF NOT EXISTS robots_blocked (
  crawl_id TEXT NOT NULL,
  url      TEXT NOT NULL,
  PRIMARY KEY (crawl_id, url)
);

CREATE TABLE IF NOT EXISTS seen_urls (
  host      TEXT NOT NULL,
  url       TEXT NOT NULL,
  title     TEXT,
  last_seen BIGINT NOT NULL,
  PRIMARY KEY (host, url)
);
CREATE INDEX IF NOT EXISTS seen_urls_last_seen_idx ON seen_urls (last_seen);
