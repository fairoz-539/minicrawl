// Storage + job queue on Postgres: "scale mode" (STORAGE=postgres, DATABASE_URL).
// Same async interface as the SQLite backend in src/db.js, so any number of API
// and worker processes can share one database:
//  - jobs are claimed with FOR UPDATE SKIP LOCKED (Firecrawl's NuQ pattern),
//    so two workers never get the same job
//  - lockURL serialises per crawl with an advisory lock, so a crawl's page
//    limit holds even when many workers discover links at once
//  - the reaper, crawl-finish detection and cleanup are single SQL statements,
//    safe to run from every worker at the same time
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const MIGRATIONS_DIR = new URL("../migrations/postgres/", import.meta.url);
const MIGRATION_LOCK = 7_250_118_042; // arbitrary constant for pg_advisory_lock

// BIGINT (timestamps, COUNT(*)) as numbers instead of strings. Values stay well
// below 2^53 (ms × 1000 ≈ 1.8e15), so this is exact.
const types = {
  getTypeParser(oid, format) {
    if (oid === pg.types.builtins.INT8) return v => (v === null ? null : Number(v));
    return pg.types.getTypeParser(oid, format);
  },
};

const parse = s => (s == null ? null : JSON.parse(s));
const rowToJob = row => (row ? { ...row, data: parse(row.data), result: parse(row.result) } : null);

/** `?` placeholders → `$1, $2, …` (used by exec(); our SQL has no literal `?`). */
const numbered = sql => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

async function migrate(pool) {
  const client = await pool.connect();
  try {
    // One process migrates at a time, however many start together.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [file, Date.now()]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

class PgQueue {
  constructor(pool) {
    this.pool = pool;
    this.seq = 0;
  }

  async add({ type, data, priority = 10, groupId = null, id = randomUUID() }) {
    const createdAt = Date.now() * 1000 + (this.seq++ % 1000);
    await this.pool.query(
      "INSERT INTO jobs (id, type, priority, data, group_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, type, priority, JSON.stringify(data), groupId, createdAt],
    );
    return id;
  }

  async claim() {
    const lock = randomUUID();
    const { rows } = await this.pool.query(
      `UPDATE jobs SET status = 'active', lock = $1, locked_at = $2
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued'
                   ORDER BY priority ASC, created_at ASC
                   FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
      [lock, Date.now()],
    );
    const job = rowToJob(rows[0]);
    return job ? { ...job, lock } : null;
  }

  async renew(job) {
    await this.pool.query("UPDATE jobs SET locked_at = $1 WHERE id = $2 AND lock = $3 AND status = 'active'", [
      Date.now(),
      job.id,
      job.lock,
    ]);
  }

  async finish(job, result) {
    await this.pool.query(
      "UPDATE jobs SET status = 'completed', result = $1, lock = NULL, finished_at = $2 WHERE id = $3 AND lock = $4 AND status = 'active'",
      [result == null ? null : JSON.stringify(result), Date.now(), job.id, job.lock],
    );
  }

  async fail(job, error) {
    await this.pool.query(
      "UPDATE jobs SET status = 'failed', error = $1, lock = NULL, finished_at = $2 WHERE id = $3 AND lock = $4 AND status = 'active'",
      [String(error), Date.now(), job.id, job.lock],
    );
  }

  /** Requeue jobs whose lock was not renewed within staleMs. */
  async reap(staleMs = 60_000, maxStalls = 3) {
    const now = Date.now();
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET
         status = CASE WHEN stalls + 1 >= $1 THEN 'failed' ELSE 'queued' END,
         error  = CASE WHEN stalls + 1 >= $1 THEN 'Job stalled too many times' ELSE error END,
         finished_at = CASE WHEN stalls + 1 >= $1 THEN $2::bigint ELSE NULL END,
         stalls = stalls + 1, lock = NULL, locked_at = NULL
       WHERE status = 'active' AND locked_at < $3`,
      [maxStalls, now, now - staleMs],
    );
    return rowCount;
  }

  async get(id) {
    const { rows } = await this.pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
    return rowToJob(rows[0]);
  }

  async groupCounts(groupId) {
    const counts = { queued: 0, active: 0, completed: 0, failed: 0, skipped: 0 };
    const { rows } = await this.pool.query(
      `SELECT CASE WHEN status = 'completed' AND result IS NULL THEN 'skipped' ELSE status END AS status,
              COUNT(*) AS n
       FROM jobs WHERE group_id = $1 AND type = 'scrape' GROUP BY 1`,
      [groupId],
    );
    for (const { status, n } of rows) counts[status] = n;
    return counts;
  }

  async groupDocuments(groupId, offset, limit) {
    const { rows } = await this.pool.query(
      `SELECT result FROM jobs
       WHERE group_id = $1 AND type = 'scrape' AND status = 'completed' AND result IS NOT NULL
       ORDER BY finished_at ASC, created_at ASC LIMIT $2 OFFSET $3`,
      [groupId, limit, offset],
    );
    return rows.map(r => parse(r.result));
  }

  async groupErrors(groupId) {
    const { rows } = await this.pool.query(
      "SELECT id, data, error FROM jobs WHERE group_id = $1 AND type = 'scrape' AND status = 'failed' ORDER BY created_at ASC",
      [groupId],
    );
    return rows.map(r => ({ id: r.id, url: parse(r.data).url, error: r.error }));
  }

  async dropQueued(groupId) {
    return (await this.pool.query("DELETE FROM jobs WHERE group_id = $1 AND status = 'queued'", [groupId])).rowCount;
  }
}

class PgCrawlStore {
  constructor(pool) {
    this.pool = pool;
  }

  async create(id, crawl) {
    await this.pool.query("INSERT INTO crawls (id, data, created_at) VALUES ($1, $2, $3)", [id, JSON.stringify(crawl), Date.now()]);
  }

  async get(id) {
    const { rows } = await this.pool.query("SELECT * FROM crawls WHERE id = $1", [id]);
    return rows[0] ? { ...rows[0], data: parse(rows[0].data) } : null;
  }

  async save(id, crawl) {
    await this.pool.query("UPDATE crawls SET data = $1 WHERE id = $2", [JSON.stringify(crawl), id]);
  }

  async setStatus(id, status) {
    const { rowCount } = await this.pool.query(
      "UPDATE crawls SET status = $1, finished_at = $2 WHERE id = $3 AND status = 'scraping'",
      [status, Date.now(), id],
    );
    return rowCount > 0;
  }

  /** Crawls with no queued/active jobs left. Each id is returned to exactly one caller. */
  async finishIdleCrawls() {
    const { rows } = await this.pool.query(
      `UPDATE crawls SET status = 'completed', finished_at = $1
       WHERE status = 'scraping' AND NOT EXISTS (
         SELECT 1 FROM jobs WHERE jobs.group_id = crawls.id AND jobs.status IN ('queued', 'active'))
       RETURNING id`,
      [Date.now()],
    );
    return rows.map(r => r.id);
  }

  async lockURL(crawlId, url, limit) {
    if (typeof limit !== "number") {
      const { rowCount } = await this.pool.query(
        "INSERT INTO visited (crawl_id, url) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [crawlId, url],
      );
      return rowCount === 1;
    }
    // Check-then-insert must be atomic across processes: serialise per crawl.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [crawlId]);
      const n = (await client.query("SELECT COUNT(*) AS n FROM visited WHERE crawl_id = $1", [crawlId])).rows[0].n;
      let locked = false;
      if (n < limit) {
        const { rowCount } = await client.query(
          "INSERT INTO visited (crawl_id, url) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [crawlId, url],
        );
        locked = rowCount === 1;
      }
      await client.query("COMMIT");
      return locked;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async isVisited(crawlId, url) {
    return (await this.pool.query("SELECT 1 FROM visited WHERE crawl_id = $1 AND url = $2", [crawlId, url])).rowCount > 0;
  }

  async recordRobotsBlocked(crawlId, urls) {
    if (!urls.length) return;
    await this.pool.query(
      "INSERT INTO robots_blocked (crawl_id, url) SELECT $1, u FROM unnest($2::text[]) AS u ON CONFLICT DO NOTHING",
      [crawlId, urls],
    );
  }

  async robotsBlocked(crawlId) {
    return (await this.pool.query("SELECT url FROM robots_blocked WHERE crawl_id = $1", [crawlId])).rows.map(r => r.url);
  }

  async recordSeen(url, title = null) {
    let host;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return;
    }
    await this.pool.query(
      `INSERT INTO seen_urls (host, url, title, last_seen) VALUES ($1, $2, $3, $4)
       ON CONFLICT (host, url) DO UPDATE SET last_seen = EXCLUDED.last_seen,
         title = COALESCE(EXCLUDED.title, seen_urls.title)`,
      [host, url, title, Date.now()],
    );
  }

  async pruneExpired({ dataTtlMs, seenTtlMs, batch = 200, now = Date.now() }) {
    const out = { crawls: 0, jobs: 0, seenUrls: 0 };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (dataTtlMs > 0) {
        const cutoff = now - dataTtlMs;
        // SKIP LOCKED: several workers can run cleanup at once without blocking each other.
        const ids = (
          await client.query(
            "SELECT id FROM crawls WHERE status != 'scraping' AND created_at < $1 LIMIT $2 FOR UPDATE SKIP LOCKED",
            [cutoff, batch],
          )
        ).rows.map(r => r.id);
        if (ids.length) {
          out.jobs += (await client.query("DELETE FROM jobs WHERE group_id = ANY($1)", [ids])).rowCount;
          await client.query("DELETE FROM visited WHERE crawl_id = ANY($1)", [ids]);
          await client.query("DELETE FROM robots_blocked WHERE crawl_id = ANY($1)", [ids]);
          out.crawls += (await client.query("DELETE FROM crawls WHERE id = ANY($1)", [ids])).rowCount;
        }
        out.jobs += (
          await client.query(
            `DELETE FROM jobs WHERE id IN (
               SELECT id FROM jobs WHERE group_id IS NULL AND status IN ('completed', 'failed') AND created_at < $1
               LIMIT $2 FOR UPDATE SKIP LOCKED)`,
            [cutoff * 1000, batch * 10],
          )
        ).rowCount;
      }
      if (seenTtlMs > 0) {
        out.seenUrls = (
          await client.query(
            `DELETE FROM seen_urls WHERE (host, url) IN (
               SELECT host, url FROM seen_urls WHERE last_seen < $1 LIMIT $2 FOR UPDATE SKIP LOCKED)`,
            [now - seenTtlMs, batch * 50],
          )
        ).rowCount;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return out;
  }

  async seenForHost(host, limit = 10_000) {
    const bare = host.replace(/^www\./, "");
    return (
      await this.pool.query("SELECT url, title FROM seen_urls WHERE host = $1 OR host LIKE $2 LIMIT $3", [bare, `%.${bare}`, limit])
    ).rows;
  }
}

/**
 * @param {{url: string, ephemeral?: boolean}} opts ephemeral: use a fresh schema
 *   (dropped on close), so tests can run in parallel on one database.
 */
export async function openPostgresStorage({ url, ephemeral = false }) {
  const schema = ephemeral ? `mc_test_${randomUUID().replace(/-/g, "").slice(0, 16)}` : process.env.PG_SCHEMA || "public";
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`Invalid PG_SCHEMA "${schema}"`);

  if (schema !== "public") {
    const setup = new pg.Client({ connectionString: url });
    await setup.connect();
    await setup.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await setup.end();
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    types,
    options: `-c search_path="${schema}"`,
  });
  pool.on("error", err => console.error("postgres pool error", err.message));
  await migrate(pool);

  return {
    kind: "postgres",
    queue: new PgQueue(pool),
    store: new PgCrawlStore(pool),
    async ping() {
      await pool.query("SELECT 1");
    },
    /** Run raw SQL with `?` placeholders (tests and maintenance only). */
    async exec(sql, ...params) {
      const res = await pool.query(numbered(sql), params);
      return res.command === "SELECT" ? res.rows : { changes: res.rowCount };
    },
    async close() {
      if (ephemeral) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.end();
    },
  };
}
