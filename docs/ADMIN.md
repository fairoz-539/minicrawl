# Teams, API keys, quotas and audit

minicrawl can serve many teams from one installation. Each team gets its own API keys, limits, usage numbers and data, and an audit log records every change.

- [How it fits together](#how-it-fits-together)
- [Getting started](#getting-started)
- [Roles and scopes](#roles-and-scopes)
- [Team limits](#team-limits)
- [Team settings: data retention, ZDR, IP allowlist](#team-settings)
- [Organization domain policy](#organization-domain-policy)
- [Usage](#usage)
- [Audit log and SIEM](#audit-log-and-siem)
- [Admin API reference](#admin-api-reference)
- [Admin CLI](#admin-cli)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Good to know](#good-to-know)

## How it fits together

```
organization ── domain allow/deny lists
  └─ team ── limits, settings, usage
       └─ API key ── role (owner, admin, member, viewer) and optional scopes
            └─ crawls and extract jobs (visible only to this team)
```

- **Keys in `.env`** (`API_KEY`, `API_KEYS`) keep working exactly as before. They act as an **owner** of the `default` team. Data from before 1.3 belongs to that team.
- **Keys you create** with the admin API or CLI look like `mc_…`. minicrawl stores only their SHA-256 hash, plus a short prefix (`mc_AbCdEfGh`) so you can recognise them. The full key is shown once, when it is created.
- **Every team sees only its own work.** A crawl or extract id from another team answers `404`, the same as an id that doesn't exist.
- **One API for everything.** REST and MCP tools go through the same checks, so a key behaves the same in Claude Code as it does in curl.

## Getting started

You need one owner key. Either use the `API_KEY` from `.env`, or create a key with the CLI (the server can keep running):

```bash
docker compose exec minicrawl node src/admin-cli.js keys create --name admin --role owner
```

(Without Docker: `npm run admin -- keys create --name admin --role owner`.)

Then create a team with limits, and give it an admin key:

```bash
curl -X POST http://localhost:3002/admin/v1/teams \
  -H "Authorization: Bearer $OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"research","limits":{"concurrency":4,"requestsPerMinute":120,"pagesPerDay":5000}}'

curl -X POST http://localhost:3002/admin/v1/keys \
  -H "Authorization: Bearer $OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"name":"research-lead","teamId":"<team id>","role":"admin"}'
```

That team admin can now create keys for their own people and apps. You can do all of this from `/docs` too: click **Authorize** and paste your owner key.

## Roles and scopes

| | viewer | member | admin | owner |
|---|:---:|:---:|:---:|:---:|
| Read crawl/extract status and results | ✅ | ✅ | ✅ | ✅ |
| Scrape, crawl, map, search, extract | – | ✅ | ✅ | ✅ |
| See own team's usage (`/admin/v1/usage`, `/me`) | ✅ | ✅ | ✅ | ✅ |
| Create/revoke keys in own team (up to admin) | – | – | ✅ | ✅ |
| Change own team's settings (retention, ZDR, IP allowlist) | – | – | ✅ | ✅ |
| Read own team's audit log | – | – | ✅ | ✅ |
| Create teams, set limits, disable teams | – | – | – | ✅ |
| Owner keys, organization domain policy, every team's keys/usage/audit | – | – | – | ✅ |

**Scopes** narrow a key further. `"scopes": ["scrape", "map"]` lets a key scrape and map but not crawl, search or extract. Available scopes: `scrape`, `crawl`, `map`, `search`, `extract`. Without scopes, a key can do everything its role allows.

Keys can expire: `"expiresInDays": 90`. Revoked and expired keys get `401`.

## Team limits

Set these when creating a team, or change them later with `PATCH /admin/v1/teams/{id}` (owner only). A limit you leave out, or set to `null`, means unlimited.

| Limit | What happens when it's reached |
|---|---|
| `concurrency` | At most this many crawl pages and extract jobs of the team run at once. The rest wait in the queue while other teams' jobs go ahead |
| `requestsPerMinute` | `429 RATE_LIMITED` with `Retry-After` |
| `pagesPerDay` | `402 QUOTA_EXCEEDED` with `Retry-After` (seconds until midnight UTC). A running crawl stops with status `failed` |
| `pagesPerMonth` | The same, until the 1st of next month (UTC) |
| `maxCrawlPages` | Every crawl's `limit` is lowered to this |
| `features` | `{"ai": false, "browser": false, "stealthProxy": false, "search": false}` turns features off. Using one gives `403 FEATURE_DISABLED` |

What counts as a page: each scraped URL, including crawl pages, search results scraped with `scrapeOptions`, and pages read by `/v1/extract`.

With `features.browser` off, pages are fetched over HTTP only. Requests that need a browser (screenshots, actions) are refused. With `features.stealthProxy` off, `proxy: "auto"` never escalates to the stealth pool.

## Team settings

Team admins and owners can change these:

| Setting | Meaning |
|---|---|
| `retentionHours` | How long this team's crawl and extract results are kept (`expiresAt` in responses). `0` = forever. Default: `DATA_TTL_HOURS` |
| `zdr` | **Zero data retention.** Pages the team scrapes are not added to the URL index `/v1/map` uses. Crawl and extract results are deleted at most `ZDR_RETENTION_MINUTES` (default 60) after creation, so collect them promptly. The audit log never contains page content or URLs |
| `ipAllowlist` | Addresses or CIDR ranges allowed to use the team's keys, e.g. `["10.0.0.0/8", "203.0.113.7"]`. Others get `403 IP_NOT_ALLOWED`. Behind a reverse proxy, set [`TRUST_PROXY`](#behind-a-reverse-proxy) |

```bash
curl -X PATCH http://localhost:3002/admin/v1/teams/<team id> \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"settings":{"zdr":true,"ipAllowlist":["10.0.0.0/8"]}}'
```

## Organization domain policy

Owners can restrict which sites every team may scrape:

```bash
curl -X PATCH http://localhost:3002/admin/v1/org \
  -H "Authorization: Bearer $OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"settings":{"denyDomains":["internal.example.com"],"allowDomains":null}}'
```

- `denyDomains` always win. A domain covers its subdomains: `example.com` also matches `docs.example.com`.
- With `allowDomains` set, only those domains (and their subdomains) can be scraped.
- A blocked URL gives `403 DOMAIN_NOT_ALLOWED`. Crawls and extracts silently skip links to blocked domains, and search results from them are dropped.

## Usage

`GET /admin/v1/usage?from=2026-10-01&to=2026-10-31` returns totals and daily numbers per team: `requests`, `pages`, `browserPages`, `ocrPages`, `aiInputTokens`, `aiOutputTokens` and `searches`. Owners see every team (or one, with `teamId`). Everyone else sees their own team. Days are UTC.

These numbers drive the page quotas, and are the basis for chargeback or billing.

## Audit log and SIEM

minicrawl records these events with time, actor (key prefix, `env-key` or `cli`), team, target, IP and details:

- `team.create`, `team.update`
- `org.update`
- `key.create`, `key.revoke`

With `AUDIT_ALL_REQUESTS=true` it also records every API call (`api.request`, with method, path and status) and every refused one (`api.denied`).

- **Read it:** `GET /admin/v1/audit` (owner: the whole organization; admin: their team). Use `?format=jsonl` for one JSON event per line, and `beforeId` / `nextBeforeId` to page.
- **Stream it to your SIEM:**
  - `AUDIT_LOG_STDOUT=true` prints each event as a JSON line (`{"type":"audit",…}`) to the container log, for Fluent Bit, Vector, Datadog or Splunk agents.
  - `AUDIT_WEBHOOK_URL` POSTs each event as JSON. With `AUDIT_WEBHOOK_SECRET` set, each POST carries `X-Minicrawl-Signature: sha256=<HMAC of the body>`.
- **Retention:** `AUDIT_RETENTION_DAYS` (default 365, `0` = forever).

## Admin API reference

All endpoints use `Authorization: Bearer <key>` and are listed in `/docs` under **Admin**.

| Endpoint | Who | What |
|---|---|---|
| `GET /admin/v1/me` | everyone | Your team, role, scopes, limits and settings |
| `GET /admin/v1/org` · `PATCH` | admin+ · owner | Organization name and domain policy |
| `GET /admin/v1/teams` · `POST` | everyone · owner | List (owners: all) / create teams |
| `GET /admin/v1/teams/{id}` · `PATCH` | team · admin+ | Read / change. `limits` and `disabled` need owner |
| `GET /admin/v1/keys` · `POST` | admin+ | List keys (never the keys themselves) / create one |
| `DELETE /admin/v1/keys/{id}` | admin+ | Revoke a key |
| `GET /admin/v1/usage` | everyone | Usage per team and day |
| `GET /admin/v1/audit` | admin+ | Audit log |

`PATCH` merges: fields you send replace the stored ones, and `null` removes one. On a server with no keys at all (`ALLOW_NO_AUTH`), the admin API is closed. Create the first key with the CLI.

## Admin CLI

The CLI works directly on the database (`DB_PATH`, or `STORAGE=postgres` with `DATABASE_URL`), so it works before any key exists:

```bash
docker compose exec minicrawl node src/admin-cli.js help
```

```text
teams list
teams create <name> [--limits JSON] [--settings JSON]
teams update <team> [--name N] [--limits JSON] [--settings JSON] [--disable | --enable]
keys list [--team T]
keys create --name N [--team T] [--role owner|admin|member|viewer] [--scopes scrape,crawl] [--expires-days D]
keys revoke <key-id>
org show
org update [--name N] [--settings JSON]
usage [--team T] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
audit [--team T] [--limit N]
```

In scale mode, run it in any API or worker container. On Kubernetes:

```bash
kubectl exec deploy/minicrawl-api -- node src/admin-cli.js teams list
```

## Behind a reverse proxy

IP allowlists and the audit log use the client's address. Behind Caddy, nginx, Traefik or a cloud load balancer, set `TRUST_PROXY` so minicrawl reads it from `X-Forwarded-For`:

- `TRUST_PROXY=1`: one proxy in front (the usual case)
- `TRUST_PROXY=loopback` or a CIDR such as `10.0.0.0/8`: trust proxies on those addresses only

Don't set it when clients reach minicrawl directly: they could fake their address.

## Good to know

- **Changes take effect within seconds.** Each process caches keys and team settings for `TENANCY_CACHE_MS` (default 5000 ms). A revoked key, or new limits, apply everywhere within that time, and immediately on the process that made the change.
- **The concurrency limit is soft.** In scale mode, two workers claiming at the same instant can briefly start one job more than the limit.
- **Quotas are checked before each page.** Pages already being scraped when a quota runs out still finish, so a team can go a few pages over (at most one per worker).
- **What 1.3 does not include yet:**
  - Single sign-on (OIDC) and user accounts arrive with the dashboard (milestone 2.7). Until then, people and apps use API keys.
  - Several organizations per installation are planned for the hosted (SaaS) phase.
