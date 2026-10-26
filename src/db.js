// Storage + job queue on SQLite (node:sqlite): the default, zero-setup backend.
// src/db-postgres.js implements the same async interface for scale mode.
//
// Mirrors Firecrawl's NuQ design (apps/nuq-postgres/nuq.sql) at small scale:
//  - jobs table with status/priority/lock/stalls, claimed atomically
//  - a lock reaper that requeues jobs whose worker stopped heartbeating
//  - crawl completion decided in SQL: "no queued/active jobs left in the group"
//  - a per-crawl visited set used as the URL lock (Redis SADD in Firecrawl)
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { TenancyStore } from "./tenancy-store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,             -- 'kickoff' | 'scrape'
  status      TEXT NOT NULL DEFAULT 'queued', -- queued | active | completed | failed
  priority    INTEGER NOT NULL DEFAULT 10,    -- lower runs first
  data        TEXT NOT NULL,
  group_id    TEXT,                      -- crawl id
  lock        TEXT,
  locked_at   INTEGER,
  stalls      INTEGER NOT NULL DEFAULT 0,
  result      TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  team_id     TEXT NOT NULL DEFAULT 'default',
  expires_at  INTEGER                    -- ms; NULL = DATA_TTL_HOURS after created_at
);
CREATE INDEX IF NOT EXISTS jobs_queued_idx ON jobs (priority, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (locked_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS jobs_group_idx  ON jobs (group_id, status);

CREATE TABLE IF NOT EXISTS crawls (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'scraping', -- scraping | completed | cancelled | failed
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  team_id     TEXT NOT NULL DEFAULT 'default',
  expires_at  INTEGER
);

CREATE TABLE IF NOT EXISTS visited (
  crawl_id TEXT NOT NULL,
  url      TEXT NOT NULL,
  PRIMARY KEY (crawl_id, url)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS robots_blocked (
  crawl_id TEXT NOT NULL,
  url      TEXT NOT NULL,
  PRIMARY KEY (crawl_id, url)
) WITHOUT ROWID;

-- Every URL we have scraped or discovered, per host: the "index" map reads from.
CREATE TABLE IF NOT EXISTS seen_urls (
  host      TEXT NOT NULL,
  url       TEXT NOT NULL,
  title     TEXT,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (host, url)
) WITHOUT ROWID;
`;

// Same tables as migrations/postgres/002_tenancy.sql.
const TENANCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs (id), name TEXT NOT NULL,
  limits TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}',
  max_concurrency INTEGER, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_org_name_idx ON teams (org_id, name);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams (id), name TEXT NOT NULL,
  prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, scopes TEXT,
  created_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_team_idx ON api_keys (team_id);
CREATE TABLE IF NOT EXISTS usage_daily (
  team_id TEXT NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, day, metric)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rate_counters (
  bucket TEXT NOT NULL, window_start INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, org_id TEXT, team_id TEXT, key_id TEXT, actor TEXT,
  action TEXT NOT NULL, target TEXT, ip TEXT, status INTEGER, details TEXT
);
CREATE INDEX IF NOT EXISTS audit_org_at_idx ON audit_log (org_id, at);
CREATE INDEX IF NOT EXISTS audit_team_at_idx ON audit_log (team_id, at);
`;

/** Databases created before 1.3 lack the team and expiry columns. */
function upgradeColumns(db) {
  for (const table of ["jobs", "crawls"]) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    if (!cols.has("team_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN team_id TEXT NOT NULL DEFAULT 'default'`);
    if (!cols.has("expires_at")) db.exec(`ALTER TABLE ${table} ADD COLUMN expires_at INTEGER`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS jobs_team_active_idx ON jobs (team_id) WHERE status = 'active'");
}

export function openDb(path = process.env.DB_PATH ?? "minicrawl.db") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  upgradeColumns(db);
  db.exec(TENANCY_SCHEMA);
  return db;
}

const parse = s => (s == null ? null : JSON.parse(s));

/** Excludes teams whose running jobs already reach limits.concurrency. Shared with src/db-postgres.js. */
export const CLAIM_SKIP_FULL_TEAMS = `team_id NOT IN (
  SELECT a.team_id FROM jobs a JOIN teams t ON t.id = a.team_id
  WHERE a.status = 'active' AND t.max_concurrency IS NOT NULL
  GROUP BY a.team_id, t.max_concurrency HAVING COUNT(*) >= t.max_concurrency)`;

function rowToJob(row) {
  if (!row) return null;
  return { ...row, data: parse(row.data), result: parse(row.result) };
}

export class Queue {
  constructor(db) {
    this.db = db;
    this.seq = 0;
    this.stmts = {
      add: db.prepare(
        "INSERT INTO jobs (id, type, priority, data, group_id, created_at, team_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      // SQLite has a single writer, so this UPDATE ... RETURNING is the
      // equivalent of Postgres' FOR UPDATE SKIP LOCKED claim. Teams already
      // running their concurrency limit are skipped.
      claim: db.prepare(`
        UPDATE jobs SET status = 'active', lock = ?, locked_at = ?
        WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND ${CLAIM_SKIP_FULL_TEAMS}
                    ORDER BY priority ASC, created_at ASC LIMIT 1)
        RETURNING *`),
      renew: db.prepare("UPDATE jobs SET locked_at = ? WHERE id = ? AND lock = ? AND status = 'active'"),
      finish: db.prepare(`
        UPDATE jobs SET status = 'completed', result = ?, lock = NULL, finished_at = ?
        WHERE id = ? AND lock = ? AND status = 'active'`),
      fail: db.prepare(`
        UPDATE jobs SET status = 'failed', error = ?, lock = NULL, finished_at = ?
        WHERE id = ? AND lock = ? AND status = 'active'`),
      reap: db.prepare(`
        UPDATE jobs SET
          status = CASE WHEN stalls + 1 >= ? THEN 'failed' ELSE 'queued' END,
          error  = CASE WHEN stalls + 1 >= ? THEN 'Job stalled too many times' ELSE error END,
          finished_at = CASE WHEN stalls + 1 >= ? THEN ? ELSE NULL END,
          stalls = stalls + 1, lock = NULL, locked_at = NULL
        WHERE status = 'active' AND locked_at < ?`),
      get: db.prepare("SELECT * FROM jobs WHERE id = ?"),
      // Completed jobs without a document (redirect duplicates, cancelled) count as 'skipped'.
      groupCounts: db.prepare(`
        SELECT CASE WHEN status = 'completed' AND result IS NULL THEN 'skipped' ELSE status END AS status,
               COUNT(*) AS n
        FROM jobs WHERE group_id = ? AND type = 'scrape' GROUP BY 1`),
      groupCompleted: db.prepare(`
        SELECT id, result FROM jobs
        WHERE group_id = ? AND type = 'scrape' AND status = 'completed' AND result IS NOT NULL
        ORDER BY finished_at ASC, created_at ASC LIMIT ? OFFSET ?`),
      groupFailed: db.prepare(`
        SELECT id, data, error FROM jobs
        WHERE group_id = ? AND type = 'scrape' AND status = 'failed' ORDER BY created_at ASC`),
      dropQueued: db.prepare("DELETE FROM jobs WHERE group_id = ? AND status = 'queued'"),
    };
  }

  async add({ type, data, priority = 10, groupId = null, id = randomUUID(), teamId = "default", expiresAt = null }) {
    // created_at gets a sub-millisecond tiebreaker so FIFO order is stable.
    const createdAt = Date.now() * 1000 + (this.seq++ % 1000);
    this.stmts.add.run(id, type, priority, JSON.stringify(data), groupId, createdAt, teamId, expiresAt);
    return id;
  }

  async claim() {
    const lock = randomUUID();
    const job = rowToJob(this.stmts.claim.get(lock, Date.now()));
    return job ? { ...job, lock } : null;
  }

  async renew(job) {
    this.stmts.renew.run(Date.now(), job.id, job.lock);
  }

  async finish(job, result) {
    // A null result (duplicate/cancelled page) is stored as SQL NULL.
    this.stmts.finish.run(result == null ? null : JSON.stringify(result), Date.now(), job.id, job.lock);
  }

  async fail(job, error) {
    this.stmts.fail.run(String(error), Date.now(), job.id, job.lock);
  }

  /** Requeue jobs whose lock was not renewed within staleMs. */
  async reap(staleMs = 60_000, maxStalls = 3) {
    const now = Date.now();
    return this.stmts.reap.run(maxStalls, maxStalls, maxStalls, now, now - staleMs).changes;
  }

  async get(id) {
    return rowToJob(this.stmts.get.get(id));
  }

  async groupCounts(groupId) {
    const counts = { queued: 0, active: 0, completed: 0, failed: 0, skipped: 0 };
    for (const { status, n } of this.stmts.groupCounts.all(groupId)) counts[status] = n;
    return counts;
  }

  async groupDocuments(groupId, offset, limit) {
    return this.stmts.groupCompleted.all(groupId, limit, offset).map(r => parse(r.result));
  }

  async groupErrors(groupId) {
    return this.stmts.groupFailed.all(groupId).map(r => ({
      id: r.id,
      url: parse(r.data).url,
      error: r.error,
    }));
  }

  async dropQueued(groupId) {
    return this.stmts.dropQueued.run(groupId).changes;
  }
}

export class CrawlStore {
  constructor(db) {
    this.db = db;
    this.stmts = {
      create: db.prepare("INSERT INTO crawls (id, data, created_at, team_id, expires_at) VALUES (?, ?, ?, ?, ?)"),
      get: db.prepare("SELECT * FROM crawls WHERE id = ?"),
      save: db.prepare("UPDATE crawls SET data = ? WHERE id = ?"),
      setStatus: db.prepare(
        "UPDATE crawls SET status = ?, finished_at = ? WHERE id = ? AND status = 'scraping'",
      ),
      // Firecrawl's nuq_group_crawl_finished cron, as one statement.
      finishIdle: db.prepare(`
        UPDATE crawls SET status = 'completed', finished_at = ?
        WHERE status = 'scraping' AND NOT EXISTS (
          SELECT 1 FROM jobs WHERE jobs.group_id = crawls.id AND jobs.status IN ('queued', 'active'))
        RETURNING id`),
      lock: db.prepare("INSERT OR IGNORE INTO visited (crawl_id, url) VALUES (?, ?)"),
      isVisited: db.prepare("SELECT 1 FROM visited WHERE crawl_id = ? AND url = ?"),
      visitedCount: db.prepare("SELECT COUNT(*) AS n FROM visited WHERE crawl_id = ?"),
      robotsBlocked: db.prepare("INSERT OR IGNORE INTO robots_blocked (crawl_id, url) VALUES (?, ?)"),
      listRobotsBlocked: db.prepare("SELECT url FROM robots_blocked WHERE crawl_id = ?"),
      seen: db.prepare(`
        INSERT INTO seen_urls (host, url, title, last_seen) VALUES (?, ?, ?, ?)
        ON CONFLICT (host, url) DO UPDATE SET last_seen = excluded.last_seen,
          title = COALESCE(excluded.title, seen_urls.title)`),
      seenForHost: db.prepare("SELECT url, title FROM seen_urls WHERE host = ? OR host LIKE ? LIMIT ?"),
    };
  }

  async create(id, crawl, { teamId = "default", expiresAt = null } = {}) {
    this.stmts.create.run(id, JSON.stringify(crawl), Date.now(), teamId, expiresAt);
  }

  async get(id) {
    const row = this.stmts.get.get(id);
    return row ? { ...row, data: parse(row.data) } : null;
  }

  async save(id, crawl) {
    this.stmts.save.run(JSON.stringify(crawl), id);
  }

  async setStatus(id, status) {
    return this.stmts.setStatus.run(status, Date.now(), id).changes > 0;
  }

  async finishIdleCrawls() {
    return this.stmts.finishIdle.all(Date.now()).map(r => r.id);
  }

  /**
   * Claim a URL for a crawl. Returns true only for the first caller.
   * `limit` caps how many URLs a crawl may ever claim.
   */
  async lockURL(crawlId, url, limit) {
    if (typeof limit === "number" && this.stmts.visitedCount.get(crawlId).n >= limit) return false;
    return this.stmts.lock.run(crawlId, url).changes === 1;
  }

  async isVisited(crawlId, url) {
    return !!this.stmts.isVisited.get(crawlId, url);
  }

  async recordRobotsBlocked(crawlId, urls) {
    for (const url of urls) this.stmts.robotsBlocked.run(crawlId, url);
  }

  async robotsBlocked(crawlId) {
    return this.stmts.listRobotsBlocked.all(crawlId).map(r => r.url);
  }

  async recordSeen(url, title = null) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      this.stmts.seen.run(host, url, title, Date.now());
    } catch {}
  }

  /**
   * Delete data past its expiry, in bounded batches so the queue isn't
   * locked for long. Running crawls are never touched.
   *  - crawls (and their jobs, visited set, robots log) past their expires_at,
   *    or older than dataTtlMs when they have none
   *  - finished standalone jobs (extracts), the same way
   *  - URL-index entries (used by /map) not seen for seenTtlMs
   * A TTL of 0 keeps that data forever.
   * @returns {{crawls: number, jobs: number, seenUrls: number}}
   */
  async pruneExpired({ dataTtlMs, seenTtlMs, batch = 200, now = Date.now() }) {
    const out = { crawls: 0, jobs: 0, seenUrls: 0 };
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      {
        // dataTtlMs 0: rows without their own expiry are kept forever.
        const cutoff = dataTtlMs > 0 ? now - dataTtlMs : -1;
        const ids = db
          .prepare(`SELECT id FROM crawls WHERE status != 'scraping'
                    AND (expires_at < ? OR (expires_at IS NULL AND created_at < ?)) LIMIT ?`)
          .all(now, cutoff, batch)
          .map(r => r.id);
        for (const id of ids) {
          out.jobs += db.prepare("DELETE FROM jobs WHERE group_id = ?").run(id).changes;
          db.prepare("DELETE FROM visited WHERE crawl_id = ?").run(id);
          db.prepare("DELETE FROM robots_blocked WHERE crawl_id = ?").run(id);
          out.crawls += db.prepare("DELETE FROM crawls WHERE id = ?").run(id).changes;
        }
        // jobs.created_at is stored in ms × 1000 (see Queue.add).
        out.jobs += db
          .prepare(`DELETE FROM jobs WHERE rowid IN (
            SELECT rowid FROM jobs WHERE group_id IS NULL AND status IN ('completed', 'failed')
            AND (expires_at < ? OR (expires_at IS NULL AND created_at < ?)) LIMIT ?)`)
          .run(now, cutoff * 1000, batch * 10).changes;
      }
      if (seenTtlMs > 0) {
        out.seenUrls = db
          // WITHOUT ROWID table: select by its primary key.
          .prepare("DELETE FROM seen_urls WHERE (host, url) IN (SELECT host, url FROM seen_urls WHERE last_seen < ? LIMIT ?)")
          .run(now - seenTtlMs, batch * 50).changes;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return out;
  }

  async seenForHost(host, limit = 10_000) {
    const bare = host.replace(/^www\./, "");
    return this.stmts.seenForHost.all(bare, `%.${bare}`, limit);
  }
}

/** The storage interface every backend provides (see src/storage.js). */
export function openSqliteStorage(path) {
  const db = openDb(path);
  return {
    kind: "sqlite",
    queue: new Queue(db),
    store: new CrawlStore(db),
    tenancy: new TenancyStore({
      async all(sql, params) {
        return db.prepare(sql).all(...params);
      },
      async run(sql, params) {
        return Number(db.prepare(sql).run(...params).changes);
      },
    }),
    async ping() {
      db.prepare("SELECT 1").get();
    },
    /** Run raw SQL with `?` placeholders (tests and maintenance only). */
    async exec(sql, ...params) {
      const stmt = db.prepare(sql);
      return /^\s*(select|with)\b/i.test(sql) ? stmt.all(...params) : stmt.run(...params);
    },
    async close() {
      db.close();
    },
  };
}
