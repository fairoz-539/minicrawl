// Multi-tenancy: who is calling, and what they may do.
//
//   organization ─┬─ team ─┬─ API key (hashed, with a role and optional scopes)
//                 │        └─ jobs, crawls, usage, limits, settings
//                 └─ settings (domain allow/deny lists)
//
// Keys in .env (API_KEY / API_KEYS) keep working: they act as an owner of the
// default organization and team, so installs from before 1.3 behave as before.
// Every other key lives in the database (created with the admin API or
// src/admin-cli.js) and only its sha256 is stored.
//
// The checks here are called by src/api.js, so the REST routes and the MCP
// tools enforce exactly the same rules.
import { createHmac, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { DEFAULT_ORG, DEFAULT_TEAM, hashKey } from "./tenancy-store.js";

export const ROLES = ["viewer", "member", "admin", "owner"];
export const SCOPES = ["scrape", "crawl", "map", "search", "extract"];
export const FEATURES = ["ai", "browser", "stealthProxy", "search"];
export const METRICS = ["requests", "pages", "browserPages", "ocrPages", "aiInputTokens", "aiOutputTokens", "searches"];

const CACHE_MS = Number(process.env.TENANCY_CACHE_MS ?? 5000);
const TOUCH_EVERY_MS = 60_000;
const ZDR_RETENTION_MS = Number(process.env.ZDR_RETENTION_MINUTES ?? 60) * 60_000;
// How long crawl and extract results are kept by default (the `expiresAt` in
// responses); the cleanup in src/worker.js deletes them afterwards. 0 = forever.
export const DATA_TTL_MS = Number(process.env.DATA_TTL_HOURS ?? 24) * 60 * 60 * 1000;

export class TenancyError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = "TenancyError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const atLeast = (role, min) => ROLES.indexOf(role) >= ROLES.indexOf(min);

function buildTenant({ team, org, role, key = null, actor }) {
  return {
    orgId: org.id,
    teamId: team.id,
    teamName: team.name,
    keyId: key?.id ?? null,
    role,
    scopes: key?.scopes ?? null,
    limits: team.limits ?? {},
    settings: team.settings ?? {},
    orgSettings: org.settings ?? {},
    actor,
  };
}

/** Full access to the default team, no limits: direct callers and tests. */
export const SYSTEM_TENANT = Object.freeze(
  buildTenant({ team: { id: DEFAULT_TEAM, name: "default" }, org: { id: DEFAULT_ORG }, role: "owner", actor: "system" }),
);

// --- Caches (per process; TENANCY_CACHE_MS bounds how stale they get) ---------

function cache(ctx) {
  ctx.tenancyCache ??= { keys: new Map(), teams: new Map(), activeKeys: null };
  return ctx.tenancyCache;
}

function cached(map, id, load) {
  const hit = map.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load();
  if (map.size > 10_000) map.clear();
  map.set(id, { value, at: Date.now() });
  // A failed load must not stay cached.
  value.catch(() => map.delete(id));
  return value;
}

/** The team and its org, cached briefly. */
export function loadTeam(ctx, teamId) {
  return cached(cache(ctx).teams, teamId, async () => {
    const team = await ctx.storage.tenancy.getTeam(teamId);
    return team ? { team, org: await ctx.storage.tenancy.getOrg(team.orgId) } : null;
  });
}

/** Number of usable keys in the database, cached briefly. */
export function activeKeyCount(ctx) {
  const c = cache(ctx);
  if (c.activeKeys && Date.now() - c.activeKeys.at < CACHE_MS) return c.activeKeys.value;
  const value = ctx.storage.tenancy.countActiveKeys();
  c.activeKeys = { value, at: Date.now() };
  value.catch(() => (c.activeKeys = null));
  return value;
}

/** Forget cached teams and keys right away (after admin changes in this process). */
export function invalidateTenancyCache(ctx) {
  ctx.tenancyCache = null;
}

// --- Authentication -----------------------------------------------------------

const bearer = req => {
  const h = req.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

function matchesEnvKey(token, envKeys) {
  const got = Buffer.from(token);
  // Compare against every key so the timing doesn't reveal which one matched.
  let ok = false;
  for (const k of envKeys) {
    const e = Buffer.from(k);
    ok = (e.length === got.length && timingSafeEqual(e, got)) || ok;
  }
  return ok;
}

async function defaultTenant(ctx, actor) {
  const loaded = await loadTeam(ctx, DEFAULT_TEAM);
  return loaded ? buildTenant({ ...loaded, role: "owner", actor }) : SYSTEM_TENANT;
}

/**
 * Resolve the request's API key to a tenant, or throw 401/403.
 * With no keys configured anywhere (open mode), callers get the default team.
 */
export async function authenticate(ctx, req, envKeys) {
  const token = bearer(req);
  if (token && envKeys.length && matchesEnvKey(token, envKeys)) {
    return { ...(await defaultTenant(ctx, "env-key")), bootstrap: true };
  }
  if (token) {
    const hash = hashKey(token);
    const found = await cached(cache(ctx).keys, hash, () => ctx.storage.tenancy.findKeyByHash(hash));
    if (found?.team && found.org) {
      const { key, team, org } = found;
      if (key.revokedAt) throw new TenancyError(401, "UNAUTHORIZED", "Unauthorized: this API key was revoked");
      if (key.expiresAt && key.expiresAt <= Date.now()) {
        throw new TenancyError(401, "UNAUTHORIZED", "Unauthorized: this API key has expired");
      }
      if (team.disabled) throw new TenancyError(403, "TEAM_DISABLED", `Team "${team.name}" is disabled`);
      if (!key.lastUsedAt || Date.now() - key.lastUsedAt > TOUCH_EVERY_MS) {
        key.lastUsedAt = Date.now(); // in the cached copy too, so we touch at most once a minute
        ctx.storage.tenancy.touchKey(key.id).catch(() => {});
      }
      return buildTenant({ team, org, role: key.role, key, actor: `key:${key.prefix}` });
    }
  }
  if (envKeys.length === 0 && (await activeKeyCount(ctx)) === 0) return { ...(await defaultTenant(ctx, "anonymous")), open: true };
  throw new TenancyError(401, "UNAUTHORIZED", "Unauthorized: invalid or missing API key");
}

// --- Admission: IP allowlist and rate limit -------------------------------------

const allowlists = new WeakMap(); // settings object -> BlockList

/** "10.0.0.0/8", "2001:db8::/32" or a single address. */
export function parseIpRule(rule) {
  const [addr, bits] = String(rule).trim().split("/");
  const family = isIP(addr);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { addr, prefix, type: family === 4 ? "ipv4" : "ipv6" };
}

function ipAllowed(settings, ip) {
  const rules = settings.ipAllowlist;
  if (!rules?.length) return true;
  let list = allowlists.get(settings);
  if (!list) {
    list = new BlockList();
    for (const r of rules.map(parseIpRule).filter(Boolean)) list.addSubnet(r.addr, r.prefix, r.type);
    allowlists.set(settings, list);
  }
  const addr = String(ip ?? "").replace(/^::ffff:(?=\d+\.)/, "");
  const type = isIP(addr) === 6 ? "ipv6" : "ipv4";
  return isIP(addr) ? list.check(addr, type) : false;
}

/** IP allowlist and requests-per-minute limit for the tenant's team. */
export async function admit(ctx, tenant, ip, now = Date.now()) {
  if (!ipAllowed(tenant.settings, ip)) {
    throw new TenancyError(403, "IP_NOT_ALLOWED", "This team only accepts requests from its allowed IP addresses");
  }
  const rpm = tenant.limits.requestsPerMinute;
  if (rpm) {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const n = await ctx.storage.tenancy.hit(`team:${tenant.teamId}`, windowStart);
    if (n > rpm) {
      const retry = Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000));
      throw new TenancyError(429, "RATE_LIMITED", `Rate limit of ${rpm} requests per minute reached`, { "Retry-After": String(retry) });
    }
  }
}

// --- Authorization ------------------------------------------------------------

/** Role and scope check for an API operation. `write`: it starts or changes work. */
export function authorize(tenant, scope, { write = true } = {}) {
  if (write && !atLeast(tenant.role, "member")) {
    throw new TenancyError(403, "FORBIDDEN", "This API key is read-only (role viewer)");
  }
  if (tenant.scopes && !tenant.scopes.includes(scope)) {
    throw new TenancyError(403, "FORBIDDEN", `This API key is not allowed to use ${scope}`);
  }
}

export function requireFeature(tenant, feature) {
  if (tenant.limits.features?.[feature] === false) {
    const names = { ai: "AI extraction", browser: "The browser engine", stealthProxy: "The stealth proxy", search: "Search" };
    throw new TenancyError(403, "FEATURE_DISABLED", `${names[feature]} is disabled for team "${tenant.teamName}"`);
  }
}

/**
 * Check scrape options against the team's features and return the scrape
 * policy for scrapeURL (src/scrape.js): {noBrowser, noStealth}.
 */
export function scrapePolicy(tenant, opts = {}) {
  const f = tenant.limits.features ?? {};
  const formats = opts.formats ?? [];
  if (formats.includes("json") || formats.includes("summary") || opts.jsonOptions) requireFeature(tenant, "ai");
  if (formats.some(x => x.startsWith("screenshot")) || opts.actions?.length) requireFeature(tenant, "browser");
  if (opts.proxy === "stealth") requireFeature(tenant, "stealthProxy");
  return { noBrowser: f.browser === false, noStealth: f.stealthProxy === false };
}

const hostOf = url => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
};
const hostMatches = (host, domain) => {
  const d = domain.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  return host === d || host.endsWith(`.${d}`);
};

/** The org's domain policy: denyDomains always win; with allowDomains set, only those are allowed. */
export function domainAllowed(policy, url) {
  if (!policy) return true;
  const host = hostOf(url);
  if (!host) return true; // invalid URLs are rejected elsewhere
  if (policy.denyDomains?.some(d => hostMatches(host, d))) return false;
  if (policy.allowDomains?.length) return policy.allowDomains.some(d => hostMatches(host, d));
  return true;
}

export const domainPolicy = tenant => {
  const { allowDomains, denyDomains } = tenant.orgSettings;
  return allowDomains?.length || denyDomains?.length ? { allowDomains, denyDomains } : null;
};

export function checkUrl(tenant, url) {
  if (!domainAllowed(domainPolicy(tenant), url)) {
    throw new TenancyError(403, "DOMAIN_NOT_ALLOWED", `${hostOf(url)} is not allowed by your organization's domain policy`);
  }
}

// --- Quotas and metering ------------------------------------------------------

const today = now => new Date(now).toISOString().slice(0, 10);
const monthStart = now => `${today(now).slice(0, 7)}-01`;

/** Throws 402 QUOTA_EXCEEDED when the team has used its daily or monthly pages. */
export async function checkPageQuota(ctx, limits, teamId, now = Date.now()) {
  const { pagesPerDay, pagesPerMonth } = limits;
  if (pagesPerDay == null && pagesPerMonth == null) return;
  const t = ctx.storage.tenancy;
  const d = new Date(now);
  if (pagesPerDay != null && (await t.usageSince(teamId, "pages", today(now))) >= pagesPerDay) {
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    throw new TenancyError(402, "QUOTA_EXCEEDED", `Daily page quota of ${pagesPerDay} reached`, {
      "Retry-After": String(Math.ceil((next - now) / 1000)),
    });
  }
  if (pagesPerMonth != null && (await t.usageSince(teamId, "pages", monthStart(now))) >= pagesPerMonth) {
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    throw new TenancyError(402, "QUOTA_EXCEEDED", `Monthly page quota of ${pagesPerMonth} reached`, {
      "Retry-After": String(Math.ceil((next - now) / 1000)),
    });
  }
}

/** Record usage; never fails the request it belongs to. */
export async function meter(ctx, teamId, usage) {
  try {
    await ctx.storage.tenancy.addUsage(teamId, usage);
  } catch (err) {
    console.error("usage metering failed", err.message);
  }
}

/**
 * When the team's crawl/extract results expire (ms), or null to keep them:
 * settings.retentionHours (0 = forever), else DATA_TTL_HOURS. Zero data
 * retention teams keep them at most ZDR_RETENTION_MINUTES.
 */
export function expiryFor(settings, now = Date.now()) {
  let ttl = settings.retentionHours != null ? settings.retentionHours * 3_600_000 : DATA_TTL_MS;
  if (settings.zdr) ttl = ttl > 0 ? Math.min(ttl, ZDR_RETENTION_MS) : ZDR_RETENTION_MS;
  return ttl > 0 ? now + ttl : null;
}

// --- Audit log ----------------------------------------------------------------

/**
 * Append an audit event. Also printed as a JSON line (AUDIT_LOG_STDOUT=true)
 * and/or POSTed to AUDIT_WEBHOOK_URL (signed with AUDIT_WEBHOOK_SECRET) for
 * SIEM pipelines. Never throws.
 */
export async function audit(ctx, tenant, event) {
  const e = {
    at: Date.now(),
    orgId: tenant?.orgId ?? null,
    teamId: event.teamId ?? tenant?.teamId ?? null,
    keyId: tenant?.keyId ?? null,
    actor: tenant?.actor ?? null,
    ...event,
  };
  try {
    await ctx.storage.tenancy.audit(e);
  } catch (err) {
    console.error("audit log write failed", err.message);
  }
  if (process.env.AUDIT_LOG_STDOUT === "true") console.log(JSON.stringify({ type: "audit", ...e }));
  const url = process.env.AUDIT_WEBHOOK_URL;
  if (url) {
    const body = JSON.stringify(e);
    const headers = { "content-type": "application/json" };
    if (process.env.AUDIT_WEBHOOK_SECRET) {
      headers["x-minicrawl-signature"] = `sha256=${createHmac("sha256", process.env.AUDIT_WEBHOOK_SECRET).update(body).digest("hex")}`;
    }
    fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) }).catch(err =>
      console.error("audit webhook failed", err.message),
    );
  }
}

// --- Express middleware ---------------------------------------------------------

function sendError(res, err) {
  for (const [k, v] of Object.entries(err.headers ?? {})) res.set(k, v);
  res.status(err.status).json({ success: false, code: err.code, error: err.message });
}

/**
 * Authenticate, apply the team's IP allowlist and rate limit, count the
 * request, and (AUDIT_ALL_REQUESTS=true) audit it. Sets req.tenant.
 */
export function tenantAuth(ctx, { envKeys = [], meterRequests = true } = {}) {
  const auditAll = process.env.AUDIT_ALL_REQUESTS === "true";
  return async (req, res, next) => {
    let tenant;
    try {
      tenant = await authenticate(ctx, req, envKeys);
      await admit(ctx, tenant, req.ip);
    } catch (err) {
      if (!(err instanceof TenancyError)) return next(err);
      if (auditAll) {
        audit(ctx, tenant ?? null, { action: "api.denied", target: `${req.method} ${req.path}`, ip: req.ip, status: err.status, details: { code: err.code } });
      }
      return sendError(res, err);
    }
    req.tenant = tenant;
    if (meterRequests) meter(ctx, tenant.teamId, { requests: 1 });
    if (auditAll) {
      res.on("finish", () =>
        audit(ctx, tenant, { action: "api.request", target: `${req.method} ${req.baseUrl}${req.path}`, ip: req.ip, status: res.statusCode }),
      );
    }
    next();
  };
}
