# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
