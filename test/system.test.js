// /health, /openapi.json, /docs, API keys and the startup key check.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

process.env.DISABLE_PLAYWRIGHT = "true";
const { createApp, createContext, start, StartupError } = await import("../src/server.js");

const servers = [];
async function serve(options) {
  const ctx = createContext({ dbPath: ":memory:" });
  const app = createApp(ctx, options);
  const server = await new Promise(r => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push({ server, ctx });
  return { app, base: `http://127.0.0.1:${server.address().port}` };
}

after(async () => {
  for (const { server, ctx } of servers) {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    ctx.db.close();
  }
});

/** Every "METHOD /path" the /v1 router really serves, in OpenAPI form. */
function registeredRoutes(app) {
  const out = [];
  for (const layer of app.router.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${layer.route.path}`);
    } else if (layer.handle?.stack) {
      for (const l of layer.handle.stack) {
        if (!l.route) continue;
        for (const m of Object.keys(l.route.methods)) {
          out.push(`${m.toUpperCase()} /v1${l.route.path.replace(/:(\w+)/g, "{$1}")}`);
        }
      }
    }
  }
  return out;
}

describe("system endpoints", () => {
  test("/health reports status and features without secrets", async () => {
    process.env.STEALTH_PROXY_URLS = "http://user:secret-pass@proxy.example:8080";
    const { base } = await serve({ apiKeys: ["k1"] });
    const r = await fetch(`${base}/health`);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.auth, true);
    assert.equal(body.db, true);
    assert.equal(body.features.browser, false); // disabled for this test
    assert.equal(typeof body.features.ocr, "boolean");
    assert.deepEqual(body.features.proxies, { basic: 0, stealth: 1 });
    assert.doesNotMatch(JSON.stringify(body), /secret-pass/);
    delete process.env.STEALTH_PROXY_URLS;
  });

  test("/openapi.json documents every /v1 route the server registers", async () => {
    const { app, base } = await serve({ apiKeys: [] });
    const spec = await fetch(`${base}/openapi.json`).then(r => r.json());
    assert.match(spec.openapi, /^3\./);
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map(m => `${m.toUpperCase()} ${p}`)),
    );
    const routes = registeredRoutes(app).filter(r => r.includes(" /v1/") || r.endsWith(" /health"));
    assert.ok(routes.length >= 10, `found routes: ${routes}`);
    for (const r of routes) assert.ok(documented.has(r), `${r} is missing from the OpenAPI spec`);
    // Request bodies come from the zod schemas.
    assert.ok(spec.components.schemas.ScrapeRequest.properties.actions);
    assert.ok(spec.components.schemas.CrawlRequest.properties.includePaths);
  });

  test("/docs serves the interactive explorer and its assets", async () => {
    const { base } = await serve({ apiKeys: [] });
    const page = await fetch(`${base}/docs`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /SwaggerUIBundle\(/);
    const asset = await fetch(`${base}/docs/assets/swagger-ui-bundle.js`);
    assert.equal(asset.status, 200);
    await asset.arrayBuffer();
    const slash = await fetch(`${base}/docs/`, { redirect: "manual" });
    assert.equal(slash.status, 301);
  });
});

describe("API keys", () => {
  test("any of several keys works; wrong or missing keys get 401", async () => {
    const { base } = await serve({ apiKeys: ["alice-key", "bob-key"] });
    const call = auth =>
      fetch(`${base}/v1/crawl/00000000-0000-0000-0000-000000000000`, auth ? { headers: { authorization: auth } } : {});
    assert.equal((await call("Bearer alice-key")).status, 404); // authorized, crawl doesn't exist
    assert.equal((await call("Bearer bob-key")).status, 404);
    const wrong = await call("Bearer mallory");
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, "UNAUTHORIZED");
    assert.equal((await call()).status, 401);
    // Public endpoints stay open.
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/openapi.json`)).status, 200);
  });

  test("REQUIRE_API_KEY refuses to start without a key unless ALLOW_NO_AUTH", async () => {
    const saved = { ...process.env };
    try {
      process.env.REQUIRE_API_KEY = "true";
      delete process.env.API_KEY;
      delete process.env.API_KEYS;
      await assert.rejects(start({ port: 0, host: "127.0.0.1", workers: 0, dbPath: ":memory:" }), StartupError);

      process.env.ALLOW_NO_AUTH = "true";
      const open = await start({ port: 0, host: "127.0.0.1", workers: 0, dbPath: ":memory:" });
      await open.close();

      delete process.env.ALLOW_NO_AUTH;
      // Placeholders from the docs and short keys are refused.
      for (const weak of ["YOUR_KEY", "changeme", "key-for-alice", "short", "aaaaaaaaaaaaaaaaaaaa", "3f9c2a…your-key…"]) {
        process.env.API_KEYS = weak;
        await assert.rejects(
          start({ port: 0, host: "127.0.0.1", workers: 0, dbPath: ":memory:" }),
          StartupError,
          `"${weak}" should be rejected`,
        );
      }
      process.env.API_KEYS = "3f9c2a8b7e6d5c4b3a2f1e0d9c8b7a6f, 8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a";
      const keyed = await start({ port: 0, host: "127.0.0.1", workers: 0, dbPath: ":memory:" });
      const health = await fetch(`http://127.0.0.1:${keyed.port}/health`).then(r => r.json());
      assert.equal(health.auth, true);
      await keyed.close();
    } finally {
      process.env = saved;
    }
  });
});
