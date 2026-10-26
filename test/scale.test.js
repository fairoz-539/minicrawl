// Scale mode: separate API and worker processes sharing one Postgres.
// Runs only with STORAGE=postgres and DATABASE_URL (skipped otherwise).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ON = process.env.STORAGE === "postgres" && !!process.env.DATABASE_URL;
const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));
const KEY = "scale-test-key-0123456789abcdef";
const schema = `mc_scale_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const procs = [];
let site;

/** A 300-page site: page N links to the next five pages. /slow/N waits 1.5 s. */
function startSite() {
  const page = (prefix, n) =>
    `<html><head><title>Page ${n}</title></head><body><main><h1>Page ${n}</h1>` +
    `<p>${"Some readable paragraph text for the crawler. ".repeat(12)}</p>` +
    Array.from({ length: 5 }, (_, i) => n + i + 1)
      .filter(m => m <= 300)
      .map(m => `<a href="/${prefix}/${m}">next ${m}</a>`)
      .join(" ") +
    `</main></body></html>`;
  const server = http.createServer((req, res) => {
    const m = /^\/(p|slow)\/(\d+)$/.exec(req.url);
    if (!m) {
      res.writeHead(404);
      return res.end();
    }
    const send = () => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(m[1], Number(m[2])));
    };
    if (m[1] === "slow") setTimeout(send, 1500);
    else send();
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, server })));
}

/** Start `node src/server.js` with MODE=api|worker; resolves with its port once it's up. */
function launch(mode, extraEnv = {}) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", SERVER], {
    env: {
      ...process.env,
      MODE: mode,
      PORT: "0",
      HOST: "127.0.0.1",
      PG_SCHEMA: schema,
      API_KEY: KEY,
      ALLOW_PRIVATE_URLS: "true",
      DISABLE_PLAYWRIGHT: "true",
      DISABLE_OCR: "true",
      JOB_LOCK_TIMEOUT_MS: "3000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    const onData = d => {
      out += d;
      const m = /:(\d+)/.exec(out.split("\n").find(l => l.includes("minicrawl")) ?? "");
      if (m) resolve({ child, port: Number(m[1]) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", d => (out += d));
    child.on("exit", code => reject(new Error(`${mode} process exited (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`${mode} process did not start: ${out}`)), 30_000);
  });
}

const call = (port, method, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  }).then(r => r.json());

async function waitCrawl(port, id, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let s = await call(port, "GET", `/v1/crawl/${id}`);
    if (s.status !== "scraping") {
      // Collect every page (status pages hold 100 at a time).
      const data = [...s.data];
      while (s.next) {
        s = await fetch(s.next, { headers: { authorization: `Bearer ${KEY}` } }).then(r => r.json());
        data.push(...s.data);
      }
      return { ...s, data };
    }
    if (Date.now() > deadline) throw new Error(`crawl ${id} still running`);
    await new Promise(r => setTimeout(r, 500));
  }
}

let api;
const workers = [];

before(async () => {
  if (!ON) return;
  site = await startSite();
  api = await launch("api");
  for (let i = 0; i < 3; i++) workers.push(await launch("worker", { WORKERS: "4" }));
});

after(async () => {
  for (const p of procs) p.kill();
  site?.server.close();
  if (ON) {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});

test("API and worker processes report their role", { skip: !ON && "needs STORAGE=postgres" }, async () => {
  const health = await fetch(`http://127.0.0.1:${api.port}/health`).then(r => r.json());
  assert.equal(health.mode, "api");
  assert.equal(health.storage, "postgres");
  const w = await fetch(`http://127.0.0.1:${workers[0].port}/health`).then(r => r.json());
  assert.equal(w.mode, "worker");
  // Workers serve no API.
  assert.equal((await fetch(`http://127.0.0.1:${workers[0].port}/v1/crawl/x`)).status, 404);
});

test("3 worker processes crawl 150 of 300 pages: no duplicates, limit exact", { skip: !ON && "needs STORAGE=postgres" }, async () => {
  const { id } = await call(api.port, "POST", "/v1/crawl", { url: `${site.url}/p/1`, limit: 150, crawlEntireDomain: true, ignoreSitemap: true });
  const result = await waitCrawl(api.port, id);
  assert.equal(result.status, "completed");
  const urls = result.data.map(d => d.metadata.url);
  assert.equal(urls.length, 150, "exactly the page limit");
  assert.equal(new Set(urls).size, 150, "no page scraped twice");
  assert.equal(result.total, 150);
});

test("a killed worker's jobs are picked up by the others", { skip: !ON && "needs STORAGE=postgres" }, async () => {
  const { id } = await call(api.port, "POST", "/v1/crawl", { url: `${site.url}/slow/1`, limit: 24, crawlEntireDomain: true, ignoreSitemap: true });
  await new Promise(r => setTimeout(r, 2500)); // let workers claim (slow) jobs
  workers[0].child.kill("SIGKILL"); // dies mid-job, without cleaning up
  const result = await waitCrawl(api.port, id);
  assert.equal(result.status, "completed");
  const urls = result.data.map(d => d.metadata.url);
  assert.equal(new Set(urls).size, urls.length, "no duplicates");
  assert.equal(urls.length, 24, "every page done despite the dead worker");
});
