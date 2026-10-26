// Multi-tenancy: hashed keys, roles, scopes, team isolation, quotas, rate
// limits, features, domain policy, ZDR, IP allowlists, audit log, admin CLI.
// Backend-neutral: runs on SQLite by default and on Postgres with STORAGE=postgres.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureSite } from "./fixture-site.js";

process.env.ALLOW_PRIVATE_URLS = "true";
process.env.DISABLE_PLAYWRIGHT = "true";
const ROOT = "root-key-0123456789abcdef";
process.env.API_KEY = ROOT;
const { start, createApp, createContext } = await import("../src/server.js");
const { openStorage } = await import("../src/storage.js");
const { run: runCli } = await import("../src/admin-cli.js");
const { invalidateTenancyCache } = await import("../src/tenancy.js");

let site, api, base;

before(async () => {
  site = await startFixtureSite();
  api = await start({ port: 0, host: "127.0.0.1", workers: 4, dbPath: ":memory:" });
  base = `http://127.0.0.1:${api.port}`;
});

after(async () => {
  await api.close();
  await site.close();
});

async function call(method, path, key, body) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json, headers: r.headers };
}

async function newTeam(name, extra = {}) {
  const r = await call("POST", "/admin/v1/teams", ROOT, { name, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

async function newKey(teamId, role = "member", extra = {}, as = ROOT) {
  const r = await call("POST", "/admin/v1/keys", as, { name: `${role}-${Math.random()}`, teamId, role, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function waitForCrawl(id, key, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call("GET", `/v1/crawl/${id}`, key);
    if (body.status !== "scraping") return body;
    if (Date.now() > deadline) throw new Error("crawl did not finish: " + JSON.stringify(body));
    await new Promise(r => setTimeout(r, 200));
  }
}

describe("keys and roles", () => {
  test(".env keys are owners of the default team", async () => {
    const { status, body } = await call("GET", "/admin/v1/me", ROOT);
    assert.equal(status, 200);
    assert.equal(body.data.role, "owner");
    assert.equal(body.data.teamId, "default");
    assert.equal((await call("GET", "/admin/v1/me", "wrong-key-0123456789")).status, 401);
    assert.equal((await call("GET", "/admin/v1/me")).status, 401);
  });

  test("keys are shown once and stored only as a hash", async () => {
    const team = await newTeam("hashing");
    const { key, data } = await newKey(team.id, "admin");
    assert.match(key, /^mc_[A-Za-z0-9_-]{32}$/);
    assert.equal(data.prefix, key.slice(0, 11));
    assert.equal(data.hash, undefined);
    const rows = await api.ctx.storage.exec("SELECT * FROM api_keys WHERE id = ?", data.id);
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(key.slice(11)));
    assert.match(rows[0].hash, /^[0-9a-f]{64}$/);
    // Listing never returns the key either.
    assert.doesNotMatch(JSON.stringify((await call("GET", `/admin/v1/keys?teamId=${team.id}`, ROOT)).body), new RegExp(key.slice(11)));
    const me = await call("GET", "/admin/v1/me", key);
    assert.equal(me.body.data.teamName, "hashing");
    assert.equal(me.body.data.role, "admin");
  });

  test("roles: viewers read, members work, admins manage their team, owners everything", async () => {
    const team = await newTeam("roles");
    const { key: admin } = await newKey(team.id, "admin");
    // Admins can't mint owners, change limits, or touch other teams.
    assert.equal((await call("POST", "/admin/v1/keys", admin, { name: "x", role: "owner" })).status, 403);
    assert.equal((await call("PATCH", `/admin/v1/teams/${team.id}`, admin, { limits: { pagesPerDay: 1e9 } })).status, 403);
    assert.equal((await call("GET", "/admin/v1/keys?teamId=default", admin)).status, 404);
    assert.equal((await call("POST", "/admin/v1/teams", admin, { name: "nope" })).status, 403);
    // ...but can manage their own team's keys and settings.
    const { key: member } = await newKey(undefined, "member", {}, admin);
    const { key: viewer } = await newKey(undefined, "viewer", {}, admin);
    assert.equal((await call("PATCH", `/admin/v1/teams/${team.id}`, admin, { settings: { retentionHours: 48 } })).status, 200);

    const scrape = k => call("POST", "/v1/scrape", k, { url: `${site.url}/about` });
    assert.equal((await scrape(member)).status, 200);
    const v = await scrape(viewer);
    assert.equal(v.status, 403);
    assert.equal(v.body.code, "FORBIDDEN");
    assert.equal((await call("GET", "/admin/v1/usage", viewer)).status, 200);
    assert.equal((await call("GET", "/admin/v1/keys", member)).status, 403);
    assert.equal((await call("GET", "/admin/v1/audit", member)).status, 403);
  });

  test("scopes limit a key to some operations", async () => {
    const team = await newTeam("scopes");
    const { key } = await newKey(team.id, "member", { scopes: ["map"] });
    assert.equal((await call("POST", "/v1/scrape", key, { url: `${site.url}/` })).status, 403);
    assert.equal((await call("POST", "/v1/map", key, { url: `${site.url}/` })).status, 200);
  });

  test("revoked and expired keys are rejected", async () => {
    const team = await newTeam("revoke");
    const { key, data } = await newKey(team.id);
    assert.equal((await call("GET", "/admin/v1/me", key)).status, 200);
    assert.equal((await call("DELETE", `/admin/v1/keys/${data.id}`, ROOT)).status, 200);
    const r = await call("GET", "/admin/v1/me", key);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /revoked/);

    const { key: old } = await api.ctx.storage.tenancy.createKey({ teamId: team.id, name: "old", role: "member", expiresAt: Date.now() - 1000 });
    const e = await call("GET", "/admin/v1/me", old);
    assert.equal(e.status, 401);
    assert.match(e.body.error, /expired/);
  });

  test("a disabled team's keys stop working", async () => {
    const team = await newTeam("disabled");
    const { key } = await newKey(team.id);
    await call("PATCH", `/admin/v1/teams/${team.id}`, ROOT, { disabled: true });
    const r = await call("POST", "/v1/scrape", key, { url: `${site.url}/` });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "TEAM_DISABLED");
  });
});

describe("isolation", () => {
  test("crawls belong to their team: other teams get 404", async () => {
    const team = await newTeam("iso");
    const { key } = await newKey(team.id);
    const { key: other } = await newKey((await newTeam("iso-other")).id);
    const { body } = await call("POST", "/v1/crawl", key, { url: `${site.url}/`, limit: 3 });
    assert.ok(body.id);
    const done = await waitForCrawl(body.id, key);
    assert.equal(done.status, "completed");
    for (const k of [other, ROOT]) {
      assert.equal((await call("GET", `/v1/crawl/${body.id}`, k)).status, 404);
      assert.equal((await call("GET", `/v1/crawl/${body.id}/errors`, k)).status, 404);
      assert.equal((await call("DELETE", `/v1/crawl/${body.id}`, k)).status, 404);
    }
  });
});

describe("limits", () => {
  test("requests per minute: 429 with Retry-After", async () => {
    const team = await newTeam("rpm", { limits: { requestsPerMinute: 3 } });
    const { key } = await newKey(team.id);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call("GET", "/admin/v1/me", key)).status);
    // Usually [200,200,200,429,429]; a minute boundary in between can reset the window.
    assert.ok(codes.includes(429), String(codes));
    const r = await call("GET", "/admin/v1/me", key);
    if (r.status === 429) {
      assert.equal(r.body.code, "RATE_LIMITED");
      assert.ok(Number(r.headers.get("retry-after")) >= 1);
    }
  });

  test("daily page quota: 402 QUOTA_EXCEEDED, and usage is metered", async () => {
    const team = await newTeam("quota", { limits: { pagesPerDay: 2 } });
    const { key } = await newKey(team.id);
    assert.equal((await call("POST", "/v1/scrape", key, { url: `${site.url}/` })).status, 200);
    assert.equal((await call("POST", "/v1/scrape", key, { url: `${site.url}/about` })).status, 200);
    const r = await call("POST", "/v1/scrape", key, { url: `${site.url}/` });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, "QUOTA_EXCEEDED");
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal((await call("POST", "/v1/crawl", key, { url: `${site.url}/` })).status, 402);

    let mine;
    // Requests are counted in the background, so the count can lag a moment.
    for (let i = 0; i < 20; i++) {
      mine = (await call("GET", "/admin/v1/usage", key)).body.data.teams[0];
      if (mine.totals.requests >= 4) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(mine.totals.pages, 2);
    assert.ok(mine.totals.requests >= 4, JSON.stringify(mine.totals));
  });

  test("a crawl stops when the team runs out of pages", async () => {
    const team = await newTeam("crawl-quota", { limits: { pagesPerDay: 3 } });
    const { key } = await newKey(team.id);
    const { body } = await call("POST", "/v1/crawl", key, { url: `${site.url}/`, limit: 50 });
    const done = await waitForCrawl(body.id, key);
    assert.equal(done.status, "failed");
    // Metered pages (redirect duplicates count but return no document). Workers
    // already scraping when the quota ran out may finish their page.
    const pages = (await call("GET", "/admin/v1/usage", key)).body.data.teams[0].totals.pages;
    assert.ok(pages >= 3 && pages <= 3 + 4, `pages ${pages}`);
    assert.ok(done.completed <= pages);
    // The crawl is marked failed just before the page's error is written.
    let errors;
    for (let i = 0; i < 20; i++) {
      errors = (await call("GET", `/v1/crawl/${body.id}/errors`, key)).body.errors;
      if (errors.some(e => /QUOTA_EXCEEDED/.test(e.error))) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(errors.some(e => /QUOTA_EXCEEDED/.test(e.error)), JSON.stringify(errors));
  });

  test("maxCrawlPages caps the crawl limit", async () => {
    const team = await newTeam("max-crawl", { limits: { maxCrawlPages: 2 } });
    const { key } = await newKey(team.id);
    const { body } = await call("POST", "/v1/crawl", key, { url: `${site.url}/`, limit: 50 });
    const done = await waitForCrawl(body.id, key);
    assert.equal(done.status, "completed");
    assert.ok(done.completed <= 2, `completed ${done.completed}`);
  });

  test("features can be switched off per team", async () => {
    const team = await newTeam("features", { limits: { features: { ai: false, browser: false, search: false } } });
    const { key } = await newKey(team.id);
    const expect403 = async (path, body) => {
      const r = await call("POST", path, key, body);
      assert.equal(r.status, 403, `${path}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "FEATURE_DISABLED");
    };
    await expect403("/v1/scrape", { url: `${site.url}/`, formats: ["screenshot"] });
    await expect403("/v1/scrape", { url: `${site.url}/`, formats: ["json"], jsonOptions: { prompt: "x" } });
    await expect403("/v1/extract", { urls: [`${site.url}/`], prompt: "x" });
    await expect403("/v1/search", { query: "x" });
    assert.equal((await call("POST", "/v1/scrape", key, { url: `${site.url}/` })).status, 200);
  });

  test("the organization's domain policy blocks URLs", async () => {
    try {
      assert.equal((await call("PATCH", "/admin/v1/org", ROOT, { settings: { denyDomains: ["127.0.0.1"] } })).status, 200);
      const r = await call("POST", "/v1/scrape", ROOT, { url: `${site.url}/` });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, "DOMAIN_NOT_ALLOWED");
      await call("PATCH", "/admin/v1/org", ROOT, { settings: { denyDomains: null, allowDomains: ["example.com"] } });
      assert.equal((await call("POST", "/v1/scrape", ROOT, { url: `${site.url}/` })).status, 403);
    } finally {
      await call("PATCH", "/admin/v1/org", ROOT, { settings: { denyDomains: null, allowDomains: null } });
    }
    assert.equal((await call("POST", "/v1/scrape", ROOT, { url: `${site.url}/` })).status, 200);
  });

  test("IP allowlist", async () => {
    const team = await newTeam("ip");
    const { key } = await newKey(team.id);
    await call("PATCH", `/admin/v1/teams/${team.id}`, ROOT, { settings: { ipAllowlist: ["10.1.2.0/24"] } });
    const r = await call("GET", "/admin/v1/me", key);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "IP_NOT_ALLOWED");
    await call("PATCH", `/admin/v1/teams/${team.id}`, ROOT, { settings: { ipAllowlist: ["10.1.2.0/24", "127.0.0.1"] } });
    assert.equal((await call("GET", "/admin/v1/me", key)).status, 200);
    assert.equal((await call("PATCH", `/admin/v1/teams/${team.id}`, ROOT, { settings: { ipAllowlist: ["nope"] } })).status, 400);
  });

  test("zero data retention: nothing kept for /map, results expire within the hour", async () => {
    const team = await newTeam("zdr", { settings: { zdr: true } });
    const { key } = await newKey(team.id);
    const url = `${site.url}/about?zdr-check=1`;
    assert.equal((await call("POST", "/v1/scrape", key, { url })).status, 200);
    assert.deepEqual(await api.ctx.storage.exec("SELECT url FROM seen_urls WHERE url LIKE ?", "%zdr-check%"), []);
    const { body } = await call("POST", "/v1/crawl", key, { url: `${site.url}/`, limit: 2 });
    const done = await waitForCrawl(body.id, key);
    const ttl = Date.parse(done.expiresAt) - Date.now();
    assert.ok(ttl > 0 && ttl <= 60 * 60 * 1000, `expiresAt ${done.expiresAt}`);
  });
});

describe("audit log", () => {
  test("records admin changes; admins see only their team", async () => {
    const team = await newTeam("audited");
    const { key: admin } = await newKey(team.id, "admin");
    const { data } = await newKey(undefined, "member", {}, admin);
    await call("DELETE", `/admin/v1/keys/${data.id}`, admin);

    const all = await call("GET", "/admin/v1/audit?limit=1000", ROOT);
    assert.equal(all.status, 200);
    const actions = all.body.data.map(e => e.action);
    for (const a of ["team.create", "key.create", "key.revoke", "team.update", "org.update"]) assert.ok(actions.includes(a), a);
    const revoke = all.body.data.find(e => e.action === "key.revoke" && e.target === data.id);
    assert.equal(revoke.teamId, team.id);
    assert.match(revoke.actor, /^key:mc_/);

    const mine = await call("GET", "/admin/v1/audit?limit=1000", admin);
    assert.ok(mine.body.data.length >= 2);
    assert.ok(mine.body.data.every(e => e.teamId === team.id));

    const jsonl = await call("GET", "/admin/v1/audit?format=jsonl&limit=5", ROOT);
    assert.match(jsonl.headers.get("content-type"), /ndjson/);
    const lines = jsonl.body.trim().split("\n").map(l => JSON.parse(l));
    assert.equal(lines.length, 5);
  });
});

describe("admin CLI", () => {
  test("creates a working owner key", async () => {
    const printed = [];
    await runCli(["keys", "create", "--name", "from-cli", "--role", "owner"], { storage: api.ctx.storage, print: s => printed.push(s) });
    const key = printed.join("\n").match(/mc_[A-Za-z0-9_-]{32}/)[0];
    invalidateTenancyCache(api.ctx);
    const me = await call("GET", "/admin/v1/me", key);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.role, "owner");
    await runCli(["teams", "create", "cli-team", "--limits", '{"pagesPerDay":10}'], { storage: api.ctx.storage, print: () => {} });
    const teams = await call("GET", "/admin/v1/teams", key);
    assert.equal(teams.body.data.find(t => t.name === "cli-team").limits.pagesPerDay, 10);
    await assert.rejects(runCli(["keys", "create", "--name", "x", "--role", "god"], { storage: api.ctx.storage, print: () => {} }), /--role/);
  });
});

describe("open mode", () => {
  test("no keys anywhere: open; the first database key closes it", async () => {
    const ctx = await createContext({ dbPath: ":memory:" });
    const app = createApp(ctx, { apiKeys: [] });
    const server = await new Promise(r => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${url}/v1/crawl/00000000-0000-0000-0000-000000000000`)).status, 404); // reached the API
      assert.equal((await fetch(`${url}/admin/v1/me`)).status, 403); // admin API needs a key
      const { key } = await ctx.storage.tenancy.createKey({ teamId: "default", name: "first", role: "owner" });
      invalidateTenancyCache(ctx);
      assert.equal((await fetch(`${url}/v1/crawl/00000000-0000-0000-0000-000000000000`)).status, 401);
      assert.equal((await fetch(`${url}/admin/v1/me`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
      assert.equal((await fetch(`${url}/health`).then(r => r.json())).auth, true);
    } finally {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
      await ctx.storage.close();
    }
  });
});

describe("storage", () => {
  test("job claims respect each team's concurrency limit", async () => {
    const storage = await openStorage({ dbPath: ":memory:" });
    try {
      await storage.tenancy.ensureDefaults();
      const team = await storage.tenancy.createTeam({ orgId: "default", name: "one-at-a-time", limits: { concurrency: 1 } });
      for (let i = 0; i < 3; i++) await storage.queue.add({ type: "scrape", data: { i }, teamId: team.id });
      await storage.queue.add({ type: "scrape", data: { other: true } });
      const a = await storage.queue.claim();
      const b = await storage.queue.claim();
      assert.equal(a.team_id, team.id);
      assert.equal(b.team_id, "default"); // the limited team's next job waits
      assert.equal(await storage.queue.claim(), null);
      await storage.queue.finish(a, {});
      assert.equal((await storage.queue.claim()).team_id, team.id);
    } finally {
      await storage.close();
    }
  });

  test("SQLite databases from before 1.3 are upgraded in place", { skip: process.env.STORAGE === "postgres" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "minicrawl-upgrade-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
                priority INTEGER NOT NULL DEFAULT 10, data TEXT NOT NULL, group_id TEXT, lock TEXT, locked_at INTEGER,
                stalls INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
              CREATE TABLE crawls (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'scraping', data TEXT NOT NULL,
                created_at INTEGER NOT NULL, finished_at INTEGER);
              INSERT INTO crawls (id, data, created_at) VALUES ('c1', '{"url":"https://x.example"}', 1);`);
    old.close();
    const { openSqliteStorage } = await import("../src/db.js");
    const storage = openSqliteStorage(path);
    try {
      const crawl = await storage.store.get("c1");
      assert.equal(crawl.team_id, "default");
      assert.equal(crawl.expires_at, null);
      await storage.queue.add({ type: "scrape", data: {}, teamId: "default" });
    } finally {
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
