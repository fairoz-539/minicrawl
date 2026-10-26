// Admin API (/admin/v1): teams, API keys, usage and the audit log.
// Uses the same API keys as /v1, with role checks:
//   owner   everything in the organization: teams, limits, org settings, all keys
//   admin   their own team: keys (up to admin), settings, usage, audit log
//   member  their own team's usage (and the /v1 API)
//   viewer  their own team's usage (and read-only /v1 calls)
// Every change is written to the audit log.
import { z } from "zod";
import { ROLES, SCOPES, FEATURES, METRICS, TenancyError, atLeast, audit, invalidateTenancyCache, parseIpRule } from "./tenancy.js";

const nullableInt = min => z.number().int().min(min).nullable().optional();

export const teamLimitsSchema = z
  .object({
    concurrency: nullableInt(1).describe("Crawl pages and extract jobs running at once"),
    requestsPerMinute: nullableInt(1),
    pagesPerDay: nullableInt(0),
    pagesPerMonth: nullableInt(0),
    maxCrawlPages: nullableInt(1).describe("Caps every crawl's limit"),
    features: z
      .object(Object.fromEntries(FEATURES.map(f => [f, z.boolean().optional()])))
      .strict()
      .optional()
      .describe("false turns a feature off for the team"),
  })
  .strict();

const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9.-]+$/i, "Expected a domain like example.com");

export const teamSettingsSchema = z
  .object({
    zdr: z.boolean().nullable().optional().describe("Zero data retention"),
    retentionHours: z.number().min(0).nullable().optional().describe("How long crawl/extract results are kept (0 = forever)"),
    ipAllowlist: z
      .array(z.string().refine(r => parseIpRule(r), "Expected an IP address or CIDR range"))
      .max(200)
      .nullable()
      .optional(),
  })
  .strict();

export const orgSettingsSchema = z
  .object({
    allowDomains: z.array(domain).max(1000).nullable().optional(),
    denyDomains: z.array(domain).max(1000).nullable().optional(),
  })
  .strict();

export const teamCreateBody = z
  .object({ name: z.string().min(1).max(100), limits: teamLimitsSchema.optional(), settings: teamSettingsSchema.optional() })
  .strict();
export const teamUpdateBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    limits: teamLimitsSchema.optional(),
    settings: teamSettingsSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
export const orgUpdateBody = z.object({ name: z.string().min(1).max(100).optional(), settings: orgSettingsSchema.optional() }).strict();
export const keyCreateBody = z
  .object({
    name: z.string().min(1).max(100),
    teamId: z.string().optional().describe("Default: your own team"),
    role: z.enum(ROLES).default("member"),
    scopes: z.array(z.enum(SCOPES)).min(1).optional().describe("Default: every operation the role allows"),
    expiresInDays: z.number().positive().max(3650).optional(),
  })
  .strict();

const notFound = what => new TenancyError(404, "NOT_FOUND", `${what} not found`);
const forbidden = msg => new TenancyError(403, "FORBIDDEN", msg);

/** Merge a PATCH into stored JSON: given keys replace, null removes. */
function merge(current, patch) {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete out[k];
    else if (k === "features") out.features = { ...current.features, ...v };
    else out[k] = v;
  }
  return out;
}

const today = () => new Date().toISOString().slice(0, 10);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export function mountAdmin(app, ctx, { auth }) {
  const t = ctx.storage.tenancy;

  const route = (method, path, fn) =>
    app[method](path, auth, async (req, res, next) => {
      try {
        // A server without keys (open mode) has no identity to manage things with.
        if (req.tenant.open) {
          throw forbidden("The admin API needs an API key: set API_KEY in .env or create one with node src/admin-cli.js");
        }
        const out = await fn(req, res);
        if (out !== undefined) res.json(out);
      } catch (err) {
        next(err);
      }
    });

  /** The team, if the caller may see it (owner: any in the org; others: their own). */
  async function readableTeam(tenant, id) {
    const team = await t.getTeam(id);
    if (!team || team.orgId !== tenant.orgId) throw notFound("Team");
    if (tenant.role !== "owner" && team.id !== tenant.teamId) throw notFound("Team");
    return team;
  }

  /** The team, if the caller may manage its keys and settings (owner, or admin of that team). */
  async function manageableTeam(tenant, id) {
    const team = await readableTeam(tenant, id);
    if (!atLeast(tenant.role, "admin")) throw forbidden("Managing a team needs the admin or owner role");
    return team;
  }

  const teamOut = team => ({ id: team.id, name: team.name, limits: team.limits, settings: team.settings, disabled: team.disabled, createdAt: team.createdAt });

  // --- Who am I -------------------------------------------------------------

  route("get", "/admin/v1/me", async req => {
    const x = req.tenant;
    return {
      success: true,
      data: { orgId: x.orgId, teamId: x.teamId, teamName: x.teamName, role: x.role, scopes: x.scopes, keyId: x.keyId, limits: x.limits, settings: x.settings },
    };
  });

  // --- Organization ---------------------------------------------------------

  route("get", "/admin/v1/org", async req => {
    if (!atLeast(req.tenant.role, "admin")) throw forbidden("Needs the admin or owner role");
    const org = await t.getOrg(req.tenant.orgId);
    return { success: true, data: { id: org.id, name: org.name, settings: org.settings } };
  });

  route("patch", "/admin/v1/org", async req => {
    if (req.tenant.role !== "owner") throw forbidden("Changing the organization needs the owner role");
    const body = orgUpdateBody.parse(req.body);
    const org = await t.getOrg(req.tenant.orgId);
    const updated = await t.updateOrg(org.id, { name: body.name, settings: merge(org.settings, body.settings) });
    invalidateTenancyCache(ctx);
    await audit(ctx, req.tenant, { action: "org.update", target: org.id, ip: req.ip, details: body });
    return { success: true, data: { id: updated.id, name: updated.name, settings: updated.settings } };
  });

  // --- Teams ----------------------------------------------------------------

  route("get", "/admin/v1/teams", async req => {
    const teams = req.tenant.role === "owner" ? await t.listTeams(req.tenant.orgId) : [await t.getTeam(req.tenant.teamId)];
    return { success: true, data: teams.map(teamOut) };
  });

  route("post", "/admin/v1/teams", async (req, res) => {
    if (req.tenant.role !== "owner") throw forbidden("Creating teams needs the owner role");
    const body = teamCreateBody.parse(req.body);
    if ((await t.listTeams(req.tenant.orgId)).some(x => x.name === body.name)) {
      throw new TenancyError(409, "CONFLICT", `A team named "${body.name}" already exists`);
    }
    const team = await t.createTeam({ orgId: req.tenant.orgId, name: body.name, limits: merge({}, body.limits), settings: merge({}, body.settings) });
    await audit(ctx, req.tenant, { action: "team.create", target: team.id, teamId: team.id, ip: req.ip, details: body });
    res.status(201);
    return { success: true, data: teamOut(team) };
  });

  route("get", "/admin/v1/teams/:id", async req => ({ success: true, data: teamOut(await readableTeam(req.tenant, req.params.id)) }));

  route("patch", "/admin/v1/teams/:id", async req => {
    const team = await manageableTeam(req.tenant, req.params.id);
    const body = teamUpdateBody.parse(req.body);
    if ((body.limits || body.disabled !== undefined) && req.tenant.role !== "owner") {
      throw forbidden("Changing a team's limits or disabling it needs the owner role");
    }
    if (body.disabled && team.id === req.tenant.teamId) {
      throw new TenancyError(409, "CONFLICT", "You can't disable the team your own key belongs to");
    }
    if (body.name && body.name !== team.name && (await t.listTeams(team.orgId)).some(x => x.name === body.name)) {
      throw new TenancyError(409, "CONFLICT", `A team named "${body.name}" already exists`);
    }
    const updated = await t.updateTeam(team.id, {
      name: body.name,
      limits: body.limits ? merge(team.limits, body.limits) : undefined,
      settings: body.settings ? merge(team.settings, body.settings) : undefined,
      disabled: body.disabled,
    });
    invalidateTenancyCache(ctx);
    await audit(ctx, req.tenant, { action: "team.update", target: team.id, teamId: team.id, ip: req.ip, details: body });
    return { success: true, data: teamOut(updated) };
  });

  // --- API keys -------------------------------------------------------------

  route("get", "/admin/v1/keys", async req => {
    let teamIds;
    if (req.query.teamId) teamIds = [(await manageableTeam(req.tenant, String(req.query.teamId))).id];
    else if (req.tenant.role === "owner") teamIds = (await t.listTeams(req.tenant.orgId)).map(x => x.id);
    else teamIds = [(await manageableTeam(req.tenant, req.tenant.teamId)).id];
    return { success: true, data: await t.listKeys(teamIds) };
  });

  route("post", "/admin/v1/keys", async (req, res) => {
    const body = keyCreateBody.parse(req.body);
    const team = await manageableTeam(req.tenant, body.teamId ?? req.tenant.teamId);
    if (!atLeast(req.tenant.role, body.role)) throw forbidden(`Your role (${req.tenant.role}) can't create ${body.role} keys`);
    const { key, record } = await t.createKey({
      teamId: team.id,
      name: body.name,
      role: body.role,
      scopes: body.scopes ?? null,
      expiresAt: body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null,
      createdBy: req.tenant.keyId ?? req.tenant.actor,
    });
    invalidateTenancyCache(ctx);
    await audit(ctx, req.tenant, {
      action: "key.create",
      target: record.id,
      teamId: team.id,
      ip: req.ip,
      details: { name: record.name, prefix: record.prefix, role: record.role, scopes: record.scopes, expiresAt: record.expiresAt },
    });
    res.status(201);
    // The only time the key is shown.
    return { success: true, key, data: record };
  });

  route("delete", "/admin/v1/keys/:id", async req => {
    const key = await t.getKey(req.params.id);
    if (!key) throw notFound("API key");
    await manageableTeam(req.tenant, key.teamId).catch(err => {
      throw err.status === 403 ? err : notFound("API key");
    });
    if (!atLeast(req.tenant.role, key.role)) throw forbidden(`Your role (${req.tenant.role}) can't revoke ${key.role} keys`);
    const revoked = await t.revokeKey(key.id);
    invalidateTenancyCache(ctx);
    if (revoked) {
      await audit(ctx, req.tenant, { action: "key.revoke", target: key.id, teamId: key.teamId, ip: req.ip, details: { name: key.name, prefix: key.prefix } });
    }
    return { success: true, data: await t.getKey(key.id) };
  });

  // --- Usage ----------------------------------------------------------------

  route("get", "/admin/v1/usage", async req => {
    const from = day.parse(req.query.from ?? `${today().slice(0, 7)}-01`);
    const to = day.parse(req.query.to ?? today());
    let teams;
    if (req.query.teamId) teams = [await readableTeam(req.tenant, String(req.query.teamId))];
    else if (req.tenant.role === "owner") teams = await t.listTeams(req.tenant.orgId);
    else teams = [await t.getTeam(req.tenant.teamId)];
    const rows = await t.usageReport(teams.map(x => x.id), from, to);
    return {
      success: true,
      data: {
        from,
        to,
        teams: teams.map(team => {
          const mine = rows.filter(r => r.teamId === team.id);
          const totals = Object.fromEntries(METRICS.map(m => [m, 0]));
          const daily = new Map();
          for (const r of mine) {
            totals[r.metric] = (totals[r.metric] ?? 0) + r.amount;
            if (!daily.has(r.day)) daily.set(r.day, { day: r.day });
            daily.get(r.day)[r.metric] = r.amount;
          }
          return { id: team.id, name: team.name, limits: team.limits, totals, daily: [...daily.values()] };
        }),
      },
    };
  });

  // --- Audit log ------------------------------------------------------------

  route("get", "/admin/v1/audit", async (req, res) => {
    if (!atLeast(req.tenant.role, "admin")) throw forbidden("The audit log needs the admin or owner role");
    const q = z
      .object({
        teamId: z.string().optional(),
        since: z.coerce.number().int().min(0).optional(),
        beforeId: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(10_000).default(100),
        format: z.enum(["json", "jsonl"]).default("json"),
      })
      .parse(req.query);
    // Admins only see their own team's events.
    const teamId = req.tenant.role === "owner" ? q.teamId : req.tenant.teamId;
    const events = await t.listAudit({ orgId: req.tenant.orgId, teamId, since: q.since ?? 0, beforeId: q.beforeId ?? null, limit: q.limit });
    if (q.format === "jsonl") {
      res.type("application/x-ndjson").send(events.map(e => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
      return undefined;
    }
    return { success: true, data: events, ...(events.length === q.limit ? { nextBeforeId: events.at(-1).id } : {}) };
  });
}
