// Tenancy tables (orgs, teams, API keys, usage, rate counters, audit log),
// shared by both storage backends. The SQL is portable between SQLite and
// Postgres; each backend passes a tiny adapter:
//   all(sql, params) -> rows      run(sql, params) -> number of changed rows
// with `?` placeholders.
import { createHash, randomBytes, randomUUID } from "node:crypto";

const parse = (s, fallback) => (s == null ? fallback : JSON.parse(s));
const placeholders = n => Array.from({ length: n }, () => "?").join(", ");

export const DEFAULT_ORG = "default";
export const DEFAULT_TEAM = "default";

/** sha256 of a key. Keys are 192 random bits, so a fast hash is the right tool. */
export const hashKey = key => createHash("sha256").update(key).digest("hex");

/** A new API key: "mc_" + 32 base64url characters. */
export const generateKey = () => `mc_${randomBytes(24).toString("base64url")}`;
const KEY_PREFIX_LENGTH = 11; // "mc_" + 8 characters: enough to recognise, useless to guess

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

function rowToTeam(r) {
  if (!r) return null;
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    limits: parse(r.limits, {}),
    settings: parse(r.settings, {}),
    disabled: !!r.disabled,
    createdAt: r.created_at,
  };
}

function rowToOrg(r) {
  return r ? { id: r.id, name: r.name, settings: parse(r.settings, {}), createdAt: r.created_at } : null;
}

function rowToKey(r) {
  if (!r) return null;
  return {
    id: r.id,
    teamId: r.team_id,
    name: r.name,
    prefix: r.prefix,
    role: r.role,
    scopes: parse(r.scopes, null),
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}

function rowToAudit(r) {
  return {
    id: r.id,
    at: r.at,
    orgId: r.org_id,
    teamId: r.team_id,
    keyId: r.key_id,
    actor: r.actor,
    action: r.action,
    target: r.target,
    ip: r.ip,
    status: r.status,
    details: parse(r.details, null),
  };
}

export class TenancyStore {
  /** @param {{all: Function, run: Function}} db */
  constructor(db) {
    this.db = db;
  }

  /** The org and team that .env keys and pre-1.3 data belong to. */
  async ensureDefaults(now = Date.now()) {
    await this.db.run("INSERT INTO orgs (id, name, settings, created_at) VALUES (?, ?, '{}', ?) ON CONFLICT DO NOTHING", [
      DEFAULT_ORG,
      "Default organization",
      now,
    ]);
    await this.db.run(
      "INSERT INTO teams (id, org_id, name, limits, settings, created_at) VALUES (?, ?, ?, '{}', '{}', ?) ON CONFLICT DO NOTHING",
      [DEFAULT_TEAM, DEFAULT_ORG, "default", now],
    );
  }

  // --- Orgs and teams -----------------------------------------------------

  async getOrg(id) {
    return rowToOrg((await this.db.all("SELECT * FROM orgs WHERE id = ?", [id]))[0]);
  }

  async updateOrg(id, { name, settings }) {
    const org = await this.getOrg(id);
    if (!org) return null;
    await this.db.run("UPDATE orgs SET name = ?, settings = ? WHERE id = ?", [
      name ?? org.name,
      JSON.stringify(settings ?? org.settings),
      id,
    ]);
    return this.getOrg(id);
  }

  async getTeam(id) {
    return rowToTeam((await this.db.all("SELECT * FROM teams WHERE id = ?", [id]))[0]);
  }

  async listTeams(orgId) {
    return (await this.db.all("SELECT * FROM teams WHERE org_id = ? ORDER BY created_at, id", [orgId])).map(rowToTeam);
  }

  async createTeam({ orgId, name, limits = {}, settings = {}, now = Date.now() }) {
    const id = randomUUID();
    await this.db.run(
      "INSERT INTO teams (id, org_id, name, limits, settings, max_concurrency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, orgId, name, JSON.stringify(limits), JSON.stringify(settings), limits.concurrency ?? null, now],
    );
    return this.getTeam(id);
  }

  async updateTeam(id, { name, limits, settings, disabled }) {
    const team = await this.getTeam(id);
    if (!team) return null;
    const l = limits ?? team.limits;
    await this.db.run(
      "UPDATE teams SET name = ?, limits = ?, settings = ?, max_concurrency = ?, disabled = ? WHERE id = ?",
      [
        name ?? team.name,
        JSON.stringify(l),
        JSON.stringify(settings ?? team.settings),
        l.concurrency ?? null,
        (disabled ?? team.disabled) ? 1 : 0,
        id,
      ],
    );
    return this.getTeam(id);
  }

  // --- API keys -----------------------------------------------------------

  /** Returns the plaintext key once; only its hash is stored. */
  async createKey({ teamId, name, role, scopes = null, expiresAt = null, createdBy = null, now = Date.now() }) {
    const key = generateKey();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO api_keys (id, team_id, name, prefix, hash, role, scopes, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, teamId, name, key.slice(0, KEY_PREFIX_LENGTH), hashKey(key), role, scopes ? JSON.stringify(scopes) : null, createdBy, now, expiresAt],
    );
    return { key, record: await this.getKey(id) };
  }

  async getKey(id) {
    return rowToKey((await this.db.all("SELECT * FROM api_keys WHERE id = ?", [id]))[0]);
  }

  /** The key (any state), its team and org, or null. */
  async findKeyByHash(hash) {
    const r = (await this.db.all("SELECT * FROM api_keys WHERE hash = ?", [hash]))[0];
    if (!r) return null;
    const team = await this.getTeam(r.team_id);
    return { key: rowToKey(r), team, org: team ? await this.getOrg(team.orgId) : null };
  }

  async listKeys(teamIds) {
    if (!teamIds.length) return [];
    return (
      await this.db.all(`SELECT * FROM api_keys WHERE team_id IN (${placeholders(teamIds.length)}) ORDER BY created_at, id`, teamIds)
    ).map(rowToKey);
  }

  async revokeKey(id, now = Date.now()) {
    return (await this.db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id])) > 0;
  }

  async touchKey(id, now = Date.now()) {
    await this.db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, id]);
  }

  /** Keys that can still be used. */
  async countActiveKeys(now = Date.now()) {
    const [r] = await this.db.all(
      "SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      [now],
    );
    return Number(r.n);
  }

  // --- Usage metering -----------------------------------------------------

  /** Add to today's counters, e.g. {pages: 1, browserPages: 1}. Zero values are skipped. */
  async addUsage(teamId, metrics, now = Date.now()) {
    const day = utcDay(now);
    for (const [metric, amount] of Object.entries(metrics)) {
      if (!amount) continue;
      await this.db.run(
        `INSERT INTO usage_daily (team_id, day, metric, amount) VALUES (?, ?, ?, ?)
         ON CONFLICT (team_id, day, metric) DO UPDATE SET amount = usage_daily.amount + excluded.amount`,
        [teamId, day, metric, amount],
      );
    }
  }

  /** Total of one metric from fromDay (YYYY-MM-DD, inclusive) to today. */
  async usageSince(teamId, metric, fromDay) {
    const [r] = await this.db.all(
      "SELECT COALESCE(SUM(amount), 0) AS n FROM usage_daily WHERE team_id = ? AND metric = ? AND day >= ?",
      [teamId, metric, fromDay],
    );
    return Number(r.n);
  }

  /** Daily rows for the given teams and day range (inclusive). */
  async usageReport(teamIds, from, to) {
    if (!teamIds.length) return [];
    return (
      await this.db.all(
        `SELECT team_id, day, metric, amount FROM usage_daily
         WHERE team_id IN (${placeholders(teamIds.length)}) AND day >= ? AND day <= ?
         ORDER BY day, team_id, metric`,
        [...teamIds, from, to],
      )
    ).map(r => ({ teamId: r.team_id, day: r.day, metric: r.metric, amount: Number(r.amount) }));
  }

  // --- Rate limiting --------------------------------------------------------

  /** Count one hit in a fixed window; returns the count so far. Works across processes. */
  async hit(bucket, windowStart) {
    const [r] = await this.db.all(
      `INSERT INTO rate_counters (bucket, window_start, n) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET n = rate_counters.n + 1
       RETURNING n`,
      [bucket, windowStart],
    );
    return Number(r.n);
  }

  // --- Audit log ------------------------------------------------------------

  async audit(e) {
    await this.db.run(
      `INSERT INTO audit_log (at, org_id, team_id, key_id, actor, action, target, ip, status, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.at ?? Date.now(),
        e.orgId ?? null,
        e.teamId ?? null,
        e.keyId ?? null,
        e.actor ?? null,
        e.action,
        e.target ?? null,
        e.ip ?? null,
        e.status ?? null,
        e.details == null ? null : JSON.stringify(e.details),
      ],
    );
  }

  /** Newest first. Filter by org (and optionally team); page with beforeId. */
  async listAudit({ orgId, teamId, since = 0, beforeId = null, limit = 100 }) {
    const where = ["org_id = ?", "at >= ?"];
    const params = [orgId, since];
    if (teamId) {
      where.push("team_id = ?");
      params.push(teamId);
    }
    if (beforeId != null) {
      where.push("id < ?");
      params.push(beforeId);
    }
    return (
      await this.db.all(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, [...params, limit])
    ).map(rowToAudit);
  }

  /** Drop finished rate windows and audit entries past their retention (0 = keep forever). */
  async prune({ now = Date.now(), auditTtlMs = 0 }) {
    const rate = await this.db.run("DELETE FROM rate_counters WHERE window_start < ?", [now - 10 * 60_000]);
    const audit = auditTtlMs > 0 ? await this.db.run("DELETE FROM audit_log WHERE at < ?", [now - auditTtlMs]) : 0;
    return { rate, audit };
  }
}
