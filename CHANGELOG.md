# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **zod 3 → 4** (`^4.6.7`), fixing [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (high): memory exhaustion when validating oversized constrained collections. `npm audit --omit=dev` is clean.
- **uuid ≥ 11.1.1 for exceljs** (npm `overrides`), fixing [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) (moderate). exceljs only calls `uuid.v4()`, which is unchanged in uuid 11.

### Changed

- **400 error text:** the `error` and `details` of `BAD_REQUEST` responses now use zod 4's wording and issue format. For example, `"Required"` becomes `"Invalid input: expected string, received undefined"`, and a bad action type is an `invalid_union` issue. The response shape is unchanged (`success`, `code`, `error`, `details`), and unknown keys are still rejected with `"Unrecognized key in body"`.
- **OpenAPI:** request schemas are generated with zod 4's built-in `z.toJSONSchema`. The `zod-to-json-schema` dependency is gone. Every route is still documented; action unions are now `oneOf`, and `appendToId` has a UUID pattern.

## [1.4.0] - 2026-10-27

### Added

- **Firecrawl v2 API** (`/v2/*`): scrape, batch scrape, crawl (status, errors, cancel, active), map, search, extract, and team usage (`credit-usage`, `token-usage`, `…/historical`, `queue-status`, `concurrency-check`).
  - **What works:** the official SDKs' **default clients**, `Firecrawl` in `@mendable/firecrawl-js` and in `firecrawl-py`.
  - **Rules:** the same tenancy rules, quotas and metering as `/v1`.
  - **Refused, not ignored:** formats minicrawl can't produce (changeTracking, branding, …) and `crawl.prompt` answer `400`.
- **Batch scrape** (`/v1/batch/scrape` and `/v2/batch/scrape`): many URLs on the crawl queue.
  - Status, errors and cancel work as for crawls.
  - `ignoreInvalidURLs` and `invalidURLs`.
  - `appendToId` adds URLs to an existing batch.
  - `batch_scrape.*` webhooks.
- **New formats:** `images`, `summary` (AI) and `attributes` (CSS selector + attribute values), in v1 and v2.
- **Search sources and filters:** `news` and `images` sources (with SearXNG), `includeDomains` / `excludeDomains`, and `github` / `research` / `pdf` categories.
- **Map titles:** `/v2/map` returns `{url, title}` links.
- **Crawl `delay`:** seconds to wait before each page, in v1 and v2.
- **Extract without URLs:** the prompt is searched on the web.
- **Per-request zero data retention:** `zeroDataRetention: true` on v2 requests.
- **Contract tests in CI** with the official `@mendable/firecrawl-js` (v2 and v1 clients) and `firecrawl-py` SDKs.

### Fixed

- A crawl could be reported `completed` with no pages if the finish check ran in the instant between creating it and queuing its first job. New crawls now get a one-second grace period.

## [1.3.0] - 2026-10-27

### Added

- **Teams and API keys:** one installation serves many teams (organization → teams → keys). Created keys (`mc_…`) are stored only as a SHA-256 hash, shown once, and can have an expiry. Keys are revocable.
- **Roles and scopes:** owner, admin, member and viewer, plus optional per-key scopes (`scrape`, `crawl`, `map`, `search`, `extract`). REST and MCP enforce the same rules.
- **Team isolation:** crawls and extract jobs belong to a team. Other teams get `404`.
- **Team limits:**
  - `concurrency` (enforced in the job queue, so other teams keep running)
  - `requestsPerMinute` (`429 RATE_LIMITED`)
  - `pagesPerDay` / `pagesPerMonth` (`402 QUOTA_EXCEEDED`; running crawls stop)
  - `maxCrawlPages`
  - feature switches for AI, browser, stealth proxy and search (`403 FEATURE_DISABLED`)
- **Usage metering** per team and day: requests, pages, browser pages, OCR pages, AI input/output tokens, searches.
- **Team settings:**
  - result retention (`retentionHours`)
  - **zero data retention** (nothing added to the map index; results deleted within `ZDR_RETENTION_MINUTES`)
  - **IP allowlists** (`403 IP_NOT_ALLOWED`)
- **Organization domain policy:** allow/deny lists (`403 DOMAIN_NOT_ALLOWED`); crawls and extracts skip blocked links.
- **Audit log** of team, key and org changes, optionally of every API call (`AUDIT_ALL_REQUESTS`). Read it as JSON or JSON lines, print it to stdout (`AUDIT_LOG_STDOUT`) or stream it to a signed webhook (`AUDIT_WEBHOOK_URL`) for SIEM tools.
- **Admin API** `/admin/v1`: me, org, teams, keys, usage, audit. All endpoints are documented in `/docs`.
- **Admin CLI** (`node src/admin-cli.js`, `npm run admin`): teams, keys, usage and audit straight in the database. Use it for the first key.
- `TRUST_PROXY` for correct client IPs behind a reverse proxy.
- `docs/ADMIN.md`.

### Changed

- `API_KEY` / `API_KEYS` from `.env` act as owners of the `default` team. Existing data belongs to that team; nothing changes for existing installs.
- `REQUIRE_API_KEY` is also satisfied by a key created with the admin CLI.
- Databases are upgraded automatically (SQLite in place; Postgres migration `002_tenancy.sql`).

## [1.2.0] - 2026-10-26

### Added

- **Scale mode:** `STORAGE=postgres` with `DATABASE_URL` stores jobs and crawls in Postgres, so many API and worker processes can share the work.
  - Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so none runs twice.
  - Crawl page limits stay exact across workers.
  - A dead worker's jobs are retried elsewhere after `JOB_LOCK_TIMEOUT_MS`.
  - Tables are created and migrated automatically.
- **Process roles:** `MODE=api|worker|all` (default `all`). Worker processes need no API key and serve only `/health`.
- **`docker-compose.scale.yml`:** API, scalable workers (`--scale worker=N`), Postgres 17 and SearXNG.
- **Helm chart** (`deploy/helm/minicrawl`): API and worker Deployments, optional worker autoscaling, SearXNG, Ingress, health probes.
- `/health` reports `mode` and `storage`.
- CI runs the whole test suite on Postgres too. It adds multi-process tests (3 workers, exact limits, recovery from a killed worker) and lints the Helm chart.

### Changed

- SQLite stays the default; nothing changes for existing installs.
- The setup scripts also generate `POSTGRES_PASSWORD`.

## [1.1.0] - 2026-10-24

### Added

- **Prebuilt Docker image** on GitHub Container Registry, for amd64 and arm64: `ghcr.io/fairoz-539/minicrawl` (`:latest`, `:1.1.0`, `:edge` for main). `docker compose pull && docker compose up -d` starts in about a minute.
- **Data cleanup:** crawl and extract results are deleted once they expire (`DATA_TTL_HOURS`, default 24, matching `expiresAt`), and `/v1/map`'s URL index is trimmed after `SEEN_URLS_TTL_DAYS` (default 30). Running crawls are never touched.
- **Release automation:** tags `v*` create a GitHub Release from this changelog; `mcp-v*` / `py-v*` publish to npm / PyPI with trusted publishing (no stored tokens).
- **Animated terminal demo** in the README (`scripts/make-demo-svg.mjs`).
- **MCP server** built in at `POST /mcp` (Streamable HTTP, stateless, API-key protected), with tools `minicrawl_scrape`, `minicrawl_map`, `minicrawl_search`, `minicrawl_crawl`, `minicrawl_crawl_status`, `minicrawl_extract` and `minicrawl_extract_status`. Works with Claude Code, Cursor and VS Code.
- **`minicrawl-mcp`** (`integrations/mcp`): a stdio bridge to `/mcp` for Claude Desktop and other local-only MCP clients.
- **Python package `minicrawl-py`** (`integrations/python`, imports as `minicrawl`): client plus a LangChain `MinicrawlLoader` and a LlamaIndex `MinicrawlReader`.
- **`minicrawl-mcp` on npm** (1.0.0); 1.0.1 adds the license file to the package.
- `docs/INTEGRATIONS.md`: MCP clients, LangChain, LlamaIndex, Firecrawl SDKs, n8n/HTTP tools.

### Changed

- Dependabot proposes minor and patch updates only (major versions and non-LTS Node are upgraded by hand).
- `expiresAt` follows `DATA_TTL_HOURS` (and is `null` when data is kept forever).
- REST routes and MCP tools share one implementation (`src/api.js`). Unknown crawl/extract ids now return `code: "NOT_FOUND"`.

## [1.0.0] - 2026-10-24

First public release.

### Added

- **Firecrawl v1-compatible REST API:** `/v1/scrape`, `/v1/crawl` (+ status, errors, cancel), `/v1/map`, `/v1/search`, `/v1/extract`.
- **Engine waterfall:** fast HTTP fetch, with automatic escalation to headless Chromium (Playwright) for JavaScript apps, thin pages and bot checks that clear on their own.
- **Output formats:** markdown, cleaned HTML, raw HTML, links, screenshots (viewport/full page), AI-extracted JSON.
- **Browser actions:** `wait`, `click`, `write`, `press`, `scroll`, `screenshot`, `scrape`, `executeJavascript`.
- **Files:** PDF (text layer, plus OCR for scans), DOCX, XLSX, PPTX and images. Offline OCR via light-ocr, using the GPU when available with CPU fallback.
- **Crawling:** robots.txt, sitemap seeding, include/exclude regexes, depth/page limits, URL-variant and redirect deduplication, webhooks, SQLite job queue with crash recovery.
- **Search:** SearXNG (bundled in Docker), DuckDuckGo fallback, time filters, optional scraping of results.
- **AI extraction** with Claude structured outputs: JSON Schema and/or prompt, single page or multi-page (`site/*` expansion, optional web search).
- **Proxies:** basic and stealth pools with automatic escalation when blocked.
- **Security:** API keys (several supported), refusal to start in Docker without a strong key, SSRF guard, non-root container.
- **Docs:** interactive `/docs` and `/openapi.json` generated from the request schemas, API reference, self-hosting guide.
- **Deployment:** Dockerfile, Docker Compose with private SearXNG, health checks, `scripts/setup.sh` / `setup.ps1` to generate per-install keys.
- **Compatibility** with the official Firecrawl JS SDK's v1 client (`FirecrawlAppV1`).

[Unreleased]: https://github.com/fairoz-539/minicrawl/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/fairoz-539/minicrawl/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/fairoz-539/minicrawl/releases/tag/v1.0.0
