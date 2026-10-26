#!/usr/bin/env node
// minicrawl admin CLI: manage teams, API keys and usage straight in the
// database (the same one the server uses: DB_PATH, or STORAGE=postgres +
// DATABASE_URL). Handy for the first owner key and for scripts.
//
//   node src/admin-cli.js keys create --name admin --role owner
//   docker compose exec minicrawl node src/admin-cli.js teams list
//
// Run `node src/admin-cli.js help` for every command.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { openStorage } from "./storage.js";
import { DEFAULT_ORG, DEFAULT_TEAM } from "./tenancy-store.js";
import { ROLES, SCOPES, audit } from "./tenancy.js";
import { teamLimitsSchema, teamSettingsSchema, orgSettingsSchema } from "./admin.js";

const HELP = `minicrawl admin CLI

  teams list
  teams create <name> [--limits JSON] [--settings JSON]
  teams update <team> [--name N] [--limits JSON] [--settings JSON] [--disable | --enable]
  keys list [--team T]
  keys create --name N [--team T] [--role ${ROLES.join("|")}] [--scopes ${SCOPES.join(",")}] [--expires-days D]
  keys revoke <key-id>
  org show
  org update [--name N] [--settings JSON]
  usage [--team T] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  audit [--team T] [--limit N]

<team> / --team take a team id or name (default: the "default" team).
JSON examples:
  --limits '{"concurrency":4,"requestsPerMinute":120,"pagesPerDay":5000,"features":{"ai":false}}'
  --settings '{"zdr":true,"ipAllowlist":["10.0.0.0/8"]}'
  org --settings '{"denyDomains":["internal.example.com"]}'
`;

class UsageError extends Error {}

const json = (s, schema, what) => {
  if (s === undefined) return undefined;
  let v;
  try {
    v = JSON.parse(s);
  } catch {
    throw new UsageError(`--${what} must be JSON`);
  }
  return schema.parse(v);
};

async function findTeam(t, ref = DEFAULT_TEAM) {
  const team = (await t.getTeam(ref)) ?? (await t.listTeams(DEFAULT_ORG)).find(x => x.name === ref);
  if (!team) throw new UsageError(`No team "${ref}"`);
  return team;
}

const CLI = { orgId: DEFAULT_ORG, teamId: null, keyId: null, actor: "cli" };

export async function run(argv, { storage, print = console.log } = {}) {
  const { values: o, positionals: [group, cmd, arg] } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      team: { type: "string" },
      role: { type: "string" },
      scopes: { type: "string" },
      "expires-days": { type: "string" },
      limits: { type: "string" },
      settings: { type: "string" },
      disable: { type: "boolean" },
      enable: { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" },
      limit: { type: "string" },
    },
  });
  const t = storage.tenancy;
  const ctx = { storage };
  const out = v => print(JSON.stringify(v, null, 2));

  switch (`${group ?? "help"} ${cmd ?? ""}`.trim()) {
    case "teams list":
      return out(await t.listTeams(DEFAULT_ORG));
    case "teams create": {
      if (!arg) throw new UsageError("teams create needs a name");
      if ((await t.listTeams(DEFAULT_ORG)).some(x => x.name === arg)) throw new UsageError(`A team named "${arg}" already exists`);
      const team = await t.createTeam({
        orgId: DEFAULT_ORG,
        name: arg,
        limits: json(o.limits, teamLimitsSchema, "limits") ?? {},
        settings: json(o.settings, teamSettingsSchema, "settings") ?? {},
      });
      await audit(ctx, CLI, { action: "team.create", target: team.id, teamId: team.id, details: { name: arg } });
      return out(team);
    }
    case "teams update": {
      const team = await findTeam(t, arg);
      const limits = json(o.limits, teamLimitsSchema, "limits");
      const settings = json(o.settings, teamSettingsSchema, "settings");
      const updated = await t.updateTeam(team.id, {
        name: o.name,
        limits: limits && { ...team.limits, ...limits },
        settings: settings && { ...team.settings, ...settings },
        disabled: o.disable ? true : o.enable ? false : undefined,
      });
      await audit(ctx, CLI, { action: "team.update", target: team.id, teamId: team.id, details: { name: o.name, limits, settings, disabled: updated.disabled } });
      return out(updated);
    }
    case "keys list":
      return out(await t.listKeys(o.team ? [(await findTeam(t, o.team)).id] : (await t.listTeams(DEFAULT_ORG)).map(x => x.id)));
    case "keys create": {
      if (!o.name) throw new UsageError("keys create needs --name");
      const role = o.role ?? "member";
      if (!ROLES.includes(role)) throw new UsageError(`--role must be one of ${ROLES.join(", ")}`);
      const scopes = o.scopes ? o.scopes.split(",").map(s => s.trim()) : null;
      if (scopes?.some(s => !SCOPES.includes(s))) throw new UsageError(`--scopes must be from ${SCOPES.join(", ")}`);
      const days = o["expires-days"] ? Number(o["expires-days"]) : null;
      if (days !== null && !(days > 0)) throw new UsageError("--expires-days must be a positive number");
      const team = await findTeam(t, o.team);
      const { key, record } = await t.createKey({
        teamId: team.id,
        name: o.name,
        role,
        scopes,
        expiresAt: days ? Date.now() + days * 86_400_000 : null,
        createdBy: "cli",
      });
      await audit(ctx, CLI, { action: "key.create", target: record.id, teamId: team.id, details: { name: record.name, prefix: record.prefix, role } });
      print(`API key (shown once, store it now):\n\n  ${key}\n`);
      return out(record);
    }
    case "keys revoke": {
      const key = arg && (await t.getKey(arg));
      if (!key) throw new UsageError(`No API key with id "${arg ?? ""}" (see: keys list)`);
      await t.revokeKey(key.id);
      await audit(ctx, CLI, { action: "key.revoke", target: key.id, teamId: key.teamId, details: { name: key.name, prefix: key.prefix } });
      return out(await t.getKey(key.id));
    }
    case "org show":
      return out(await t.getOrg(DEFAULT_ORG));
    case "org update": {
      const org = await t.getOrg(DEFAULT_ORG);
      const settings = json(o.settings, orgSettingsSchema, "settings");
      const updated = await t.updateOrg(org.id, { name: o.name, settings: settings && { ...org.settings, ...settings } });
      await audit(ctx, CLI, { action: "org.update", target: org.id, details: { name: o.name, settings } });
      return out(updated);
    }
    case "usage": {
      const today = new Date().toISOString().slice(0, 10);
      const teams = o.team ? [await findTeam(t, o.team)] : await t.listTeams(DEFAULT_ORG);
      const rows = await t.usageReport(teams.map(x => x.id), o.from ?? `${today.slice(0, 7)}-01`, o.to ?? today);
      const totals = {};
      for (const r of rows) {
        const name = teams.find(x => x.id === r.teamId)?.name ?? r.teamId;
        totals[name] ??= {};
        totals[name][r.metric] = (totals[name][r.metric] ?? 0) + r.amount;
      }
      return out(totals);
    }
    case "audit":
      return out(
        await t.listAudit({
          orgId: DEFAULT_ORG,
          teamId: o.team ? (await findTeam(t, o.team)).id : undefined,
          limit: Number(o.limit ?? 50),
        }),
      );
    case "help":
      return print(HELP);
    default:
      throw new UsageError(`Unknown command "${[group, cmd].filter(Boolean).join(" ")}"\n\n${HELP}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let storage;
  try {
    storage = await openStorage();
    await storage.tenancy.ensureDefaults();
    await run(process.argv.slice(2), { storage });
  } catch (err) {
    const msg = err.name === "ZodError" ? err.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") : err.message;
    console.error(`minicrawl-admin: ${msg}`);
    process.exitCode = 1;
  } finally {
    await storage?.close();
  }
}
