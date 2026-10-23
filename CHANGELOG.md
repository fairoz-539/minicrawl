# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/fairoz-539/minicrawl/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/fairoz-539/minicrawl/releases/tag/v1.0.0
