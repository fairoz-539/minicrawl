# minicrawl API reference

Base URL: `http://<host>:3002` (port `MINICRAWL_PORT`). All bodies are JSON.

**Interactive version:** open **`/docs`** in a browser (for example http://localhost:3002/docs). Click **Authorize**, paste your API key, and every endpoint can be tried from the page. The machine-readable spec is at **`/openapi.json`** (OpenAPI 3.0), which you can import into Postman, Insomnia or Bruno.

## Contents

- [Authentication](#authentication)
- [Endpoint overview](#endpoint-overview)
- [Health and discovery](#health-and-discovery): `GET /health`, `GET /`, `GET /docs`, `GET /openapi.json`
- [POST /v1/scrape](#post-v1scrape)
  - [Formats](#formats)
  - [Page actions](#page-actions)
  - [AI extraction (json format)](#ai-extraction-json-format)
  - [Files: PDF, Word, Excel, PowerPoint, images](#files)
  - [Proxies](#proxies)
- [Crawl](#crawl): `POST /v1/crawl`, `GET /v1/crawl/{id}`, `GET /v1/crawl/{id}/errors`, `DELETE /v1/crawl/{id}`, webhooks
- [POST /v1/map](#post-v1map)
- [POST /v1/search](#post-v1search)
- [Extract](#extract): `POST /v1/extract`, `GET /v1/extract/{id}`
- [Batch scrape](#batch-scrape): `POST /v1/batch/scrape` and status, errors, cancel
- [Firecrawl v2 API](#firecrawl-v2-api): `/v2/*`, what's supported and how options map
- [Errors](#errors)
- [Calling it from code](#calling-it-from-code): curl, PowerShell, Python, JavaScript, Firecrawl SDKs

---

## Authentication

When the server has an API key (always, in Docker, unless `ALLOW_NO_AUTH=true`), every `/v1/*` request needs:

```
Authorization: Bearer <your API key>
```

Keys come from `API_KEY` and/or `API_KEYS=key1,key2` in `.env`, or are created per team with the admin API (`mc_…` keys). A missing, wrong, revoked or expired key returns `401 UNAUTHORIZED`. `/health`, `/`, `/docs` and `/openapi.json` are public; they contain no secrets.

Each key belongs to a team. The team's role checks, quotas, rate limit and feature switches apply to every call, and you only see your own team's crawls and extract jobs. See **[Teams, API keys, quotas and audit](ADMIN.md)** for the `/admin/v1` endpoints.

## Endpoint overview

| Method | Path | What it does | Sync? |
|---|---|---|---|
| GET | `/health` | Server status and which features are active | yes |
| GET | `/` | Name, version, endpoint list | yes |
| GET | `/docs` | Interactive API explorer | yes |
| GET | `/openapi.json` | OpenAPI spec | yes |
| POST | `/v1/scrape` | Scrape one URL (page, PDF, Office file, image) | yes |
| POST | `/v1/crawl` | Start crawling a site | async: returns an id |
| GET | `/v1/crawl/{id}` | Crawl status and pages | yes |
| GET | `/v1/crawl/{id}/errors` | Failed pages, robots.txt-blocked URLs | yes |
| DELETE | `/v1/crawl/{id}` | Cancel a crawl | yes |
| POST | `/v1/map` | List a site's URLs | yes |
| POST | `/v1/search` | Web search (optionally scrape the results) | yes |
| POST | `/v1/extract` | AI extraction across URLs | async: returns an id |
| GET | `/v1/extract/{id}` | Extraction status and result | yes |
| POST | `/v1/batch/scrape` | Scrape a list of URLs | async: returns an id |
| GET | `/v1/batch/scrape/{id}` | Batch status and pages | yes |
| GET | `/v1/batch/scrape/{id}/errors` | Failed pages | yes |
| DELETE | `/v1/batch/scrape/{id}` | Cancel a batch | yes |
| | `/v2/*` | The same operations in Firecrawl's v2 shapes, plus team usage. See [Firecrawl v2 API](#firecrawl-v2-api) | |
| POST | `/mcp` | MCP server for AI agents (see [INTEGRATIONS.md](INTEGRATIONS.md#ai-agents-via-mcp)) | yes |

Unknown fields in a body are rejected with `400 "Unrecognized key in body"`, so typos don't fail silently. The SDK fields `origin` and `integration` are accepted and ignored.

---

## Health and discovery

### `GET /health`

```json
{
  "status": "ok",
  "version": "1.0.0",
  "auth": true,
  "db": true,
  "features": {
    "browser": true,
    "ocr": true,
    "ai": false,
    "search": "searxng",
    "proxies": { "basic": 0, "stealth": 0 }
  }
}
```

| Field | Meaning |
|---|---|
| `auth` | An API key is required |
| `features.browser` | Headless Chromium is available: JS pages, screenshots, actions |
| `features.ocr` | Image and scanned-PDF text extraction is available |
| `features.ai` | An AI provider is configured (a local model via `LLM_BASE_URL`, or `ANTHROPIC_API_KEY`): `json`/`summary` formats and `/v1/extract` work |
| `features.llm` | `{provider, model}`: `openai` (OpenAI-compatible, e.g. Ollama) or `anthropic` |
| `features.search` | `searxng` (bundled in Docker) or `duckduckgo` (fallback, often blocked) |
| `features.proxies` | Number of proxies in each pool |

It returns `503` with `"status": "error"` if the database is unavailable. Docker's health check uses this endpoint.

---

## POST /v1/scrape

Scrapes one URL and returns it in the formats you ask for.

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | **required** | `http(s)` URL. `example.com` becomes `https://example.com` |
| `formats` | string[] | `["markdown"]` | Any of `markdown`, `html`, `rawHtml`, `links`, `screenshot`, `screenshot@fullPage`, `json` |
| `onlyMainContent` | bool | `true` | Drop headers, footers, navigation, sidebars, ads and cookie banners |
| `includeTags` | string[] | `[]` | Keep only elements matching these CSS selectors |
| `excludeTags` | string[] | `[]` | Remove elements matching these CSS selectors |
| `waitFor` | int (ms) | `0` | Extra wait after load (uses the browser) |
| `timeout` | int (ms) | `30000` | Give up after this long (1000–300000) |
| `headers` | object | `{}` | Extra request headers (e.g. cookies) |
| `engine` | `auto`/`fetch`/`browser` | `auto` | Force an engine. `auto` uses fast HTTP and switches to the browser when needed |
| `actions` | Action[] | – | Browser actions, run before capture ([details](#page-actions)) |
| `jsonOptions` | object | – | For the `json` format ([details](#ai-extraction-json-format)) |
| `proxy` | `auto`/`basic`/`stealth` | `auto` | Proxy tier ([details](#proxies)) |
| `skipTlsVerification` | bool | `false` | Accept invalid HTTPS certificates |
| `maxAge` | int (ms) | `0` | Use a cached copy of the page if it's younger than this ([page cache](#page-cache)) |
| `storeInCache` | bool | `true` | Save the fetched page in the cache |

**Response:**

```json
{
  "success": true,
  "data": {
    "markdown": "# Example Domain\n\nThis domain is for use in …",
    "links": ["https://iana.org/domains/example"],
    "metadata": {
      "title": "Example Domain",
      "language": "en",
      "sourceURL": "https://example.com",
      "url": "https://example.com/",
      "statusCode": 200,
      "contentType": "text/html",
      "engine": "fetch",
      "proxyUsed": "basic",
      "elapsedMs": 412
    }
  }
}
```

`metadata` also carries every `<meta>` tag on the page (`description`, `og:title`/`ogTitle`, `keywords`, `canonical`, `favicon`, …). Files add `numPages`, `numSheets`, `numSlides`, `ocr`, `author`. A page that returns an HTTP error (e.g. 404) still comes back with `success: true`, its content, `metadata.statusCode: 404` and `metadata.error`.

`data.warning` is set when something is worth knowing. Examples: the page looks JavaScript-rendered but no browser is available, or a page was truncated for AI extraction.

### Formats

| Format | Returns |
|---|---|
| `markdown` | Clean markdown: headings, lists, GFM tables, code blocks with language, links, images |
| `html` | Cleaned HTML (same cleaning as markdown) |
| `rawHtml` | The page's HTML exactly as received or rendered |
| `links` | Every `http(s)` link on the page, absolute, without `#fragments` |
| `images` | Every image URL on the page (`img` src/srcset, `og:image`), absolute |
| `screenshot` | `data:image/png;base64,…` of the viewport (1366×900) |
| `screenshot@fullPage` | Same, the whole page |
| `json` | AI-extracted data; needs `jsonOptions` and an AI provider |
| `summary` | A 2–4 sentence AI summary of the page; needs an AI provider |
| `attributes` | Attribute values of matching elements. Needs `attributes: [{"selector": "a.product", "attribute": "data-id"}]`. Returns `[{selector, attribute, values: [...]}]` |

### Page actions

Actions run in order in a real browser after the page loads, before content is captured. They need the browser engine (included in Docker). At most 50 per request.

| Action | Fields | Does |
|---|---|---|
| `wait` | `milliseconds` **or** `selector` | Wait a fixed time, or until the element is visible |
| `click` | `selector`, `all` (bool) | Click the first match (or all matches) |
| `write` | `text`, `selector` (optional) | Fill the input, or type into the focused element |
| `press` | `key` | Press a key: `Enter`, `Tab`, `ArrowDown`, `Escape`, … |
| `scroll` | `direction` (`up`/`down`), `selector`, `amount` | Scroll the page (or an element) by N screens |
| `screenshot` | `fullPage` (bool) | Add a screenshot to `data.actions.screenshots` |
| `scrape` | – | Add `{url, html}` of this moment to `data.actions.scrapes` |
| `executeJavascript` | `script` | Run JS in the page; its value goes to `data.actions.javascriptReturns` |

```json
{
  "url": "https://en.wikipedia.org/wiki/Main_Page",
  "actions": [
    { "type": "write", "selector": "input[name=search]", "text": "Web scraping" },
    { "type": "press", "key": "Enter" },
    { "type": "wait", "selector": "#firstHeading" },
    { "type": "screenshot" },
    { "type": "executeJavascript", "script": "document.querySelector('#firstHeading').textContent" }
  ]
}
```

The response adds:

```json
"actions": {
  "screenshots": ["data:image/png;base64,…"],
  "scrapes": [],
  "javascriptReturns": [{ "type": "string", "value": "Web scraping" }]
}
```

A failing action stops the request with `422 ACTION_FAILED` and a message such as `Action 2 (click) failed: …`.

### AI extraction (json format)

Turns a page into structured data with an AI model, either one you run yourself or Claude:

- **A local model** (`LLM_BASE_URL` + `LLM_MODEL`): any OpenAI-compatible server, such as Ollama, vLLM, LM Studio or llama.cpp. Nothing leaves your machine and there's no per-request cost. See [Local AI](SELF_HOSTING.md#local-ai-ollama-and-other-openai-compatible-servers).
- **Claude** (`ANTHROPIC_API_KEY`): the most accurate on long and messy pages; each request is a paid Anthropic API call.

| `jsonOptions` field | Description |
|---|---|
| `schema` | JSON Schema of the result you want |
| `prompt` | What to extract, in plain language. Can be used alone (free-form JSON back) or with a schema |
| `systemPrompt` | Extra instructions |

```json
{
  "url": "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html",
  "formats": ["json"],
  "jsonOptions": {
    "schema": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "price": { "type": "string" },
        "in_stock": { "type": "boolean" }
      },
      "required": ["title", "price"]
    }
  }
}
```

The response is `data.json = {"title": "A Light in the Attic", "price": "£51.77", "in_stock": true}`.

**Schema rules:**
- Fields not in `required` may come back `null` when the page doesn't have them; the model is told not to invent values.
- Constraints Claude's structured output can't enforce (`minLength`, `minimum`, `pattern`, `maxItems`, …) are removed automatically.
- Every object is closed (no extra keys).

The default model is `claude-opus-5-5` (change with `LLM_MODEL`).

### Files

`/v1/scrape` detects the file type from the response and converts it:

| Type | Result |
|---|---|
| PDF with text | Text per page, pages separated by `---`. `metadata.numPages`, `title`, `author` |
| Scanned PDF | OCR with light-ocr (first `MAX_OCR_PAGES` pages, default 20). `metadata.ocr: true` |
| Image (PNG, JPEG, WebP, BMP) | OCR text |
| Word `.docx` | Markdown with headings, lists and tables |
| Excel `.xlsx` | One `## Sheet` section and markdown table per sheet, formula results included (first 2000 rows per sheet) |
| PowerPoint `.pptx` | `## Slide N: Title`, slide text, and speaker notes |
| Other (zip, video, `.doc`/`.xls`/`.ppt`, GIF, SVG) | `422 UNSUPPORTED_FILE` |

Files reached through a browser download (or behind a "checking your browser" page) are handled too.

### Page cache

minicrawl keeps the pages it fetches in its database, for `PAGE_CACHE_TTL_HOURS` (default 48). Send `maxAge` (ms) to reuse a cached copy that's younger than that, instead of fetching the page again:

```json
{ "url": "https://example.com", "maxAge": 3600000 }
```

- **Fresh formats every time.** What's cached is the fetched page (HTML, final URL, status, screenshot), so formats, `onlyMainContent` and AI extraction are computed for each request.
- **The cache key** is the URL plus everything that changes the fetched page: `headers`, `waitFor`, screenshot mode, `proxy`, `engine`. Requests with different headers (cookies, auth) never share an entry.
- **Response:** `metadata.cacheState` is `hit` or `miss` (present when `maxAge` > 0), and a hit also has `metadata.cachedAt`.
- **Never cached:** pages with `actions`, error pages (status 400 and up), and anything for [zero-data-retention](ADMIN.md#team-settings) teams or requests.
- **Crawls and batches** take `maxAge` in their scrape options. Crawling a site again within the hour costs no requests to it for pages that were already fetched.
- `storeInCache: false` skips saving. `PAGE_CACHE=false` turns the cache off and empties it at the next cleanup.
- **Where it's kept:** in minicrawl's own database, gzip-compressed. No external storage. Size it with `PAGE_CACHE_TTL_HOURS` and `PAGE_CACHE_MAX_BYTES` (largest page kept, compressed; default 5 MB).

### Proxies

| `proxy` | Behaviour |
|---|---|
| `auto` (default) | Basic pool (or direct). If the site blocks (bot page, 401/403/429/503), retry once through the stealth pool, if one is configured |
| `basic` | Basic pool only (`PROXY_URLS`), or direct if empty |
| `stealth` | Stealth pool only (`STEALTH_PROXY_URLS`). `422 NO_STEALTH_PROXY` if empty |

`metadata.proxyUsed` says which pool served the page. You supply the proxies, e.g. residential proxies for the stealth pool.

---

## Crawl

### `POST /v1/crawl`

Starts crawling from `url` and returns immediately with an id.

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | **required** | Start page |
| `limit` | int | `10000` | Max pages |
| `maxDepth` | int | `10` | Max URL path depth below the start URL |
| `maxDiscoveryDepth` | int | – | Max link hops from the start page |
| `includePaths` | regex[] | `[]` | Only crawl paths matching one of these (e.g. `"^/blog/"`) |
| `excludePaths` | regex[] | `[]` | Skip paths matching any of these |
| `regexOnFullURL` | bool | `false` | Match the regexes against the full URL instead of the path |
| `crawlEntireDomain` / `allowBackwardLinks` | bool | `false` | Also crawl pages outside the start URL's folder |
| `allowSubdomains` | bool | `false` | Follow links to `*.example.com` |
| `allowExternalLinks` | bool | `false` | Follow links to other sites |
| `ignoreRobotsTxt` | bool | `false` | Don't apply robots.txt rules |
| `ignoreSitemap` | bool | `false` | Don't seed from sitemap.xml |
| `ignoreQueryParameters` | bool | `false` | Treat `?page=1` and `?page=2` as the same page |
| `deduplicateSimilarURLs` | bool | `true` | Treat www/non-www, http/https, `/index.html` and trailing-slash variants as one page |
| `scrapeOptions` | object | `{}` | Any `/v1/scrape` option (formats, onlyMainContent, json, …) for every page |
| `webhook` | string or object | – | See below |

```json
{ "success": true, "id": "4c9f8e0e-…", "url": "http://localhost:3002/v1/crawl/4c9f8e0e-…" }
```

**How it crawls:**
1. Read robots.txt and seed from the sitemap(s).
2. Scrape each page, extract its links, apply the rules above, and queue new URLs.
3. If two URLs redirect to the same page, only one result is kept.
4. The crawl is `completed` when nothing is left in the queue.

### `GET /v1/crawl/{id}`

```json
{
  "success": true,
  "status": "completed",
  "total": 20,
  "completed": 20,
  "creditsUsed": 20,
  "expiresAt": "2026-10-24T10:00:00.000Z",
  "data": [ { "markdown": "…", "metadata": { "url": "…", "statusCode": 200 } } ]
}
```

- `status` is one of `scraping`, `completed`, `cancelled`, `failed`.
- `data` holds up to 100 pages per response. When there are more, the response includes `next`: `GET` that URL (it adds `?skip=100`) for the next 100. `next` is absent on the last page.

### `GET /v1/crawl/{id}/errors`

```json
{
  "errors": [{ "id": "…", "url": "https://site/broken", "error": "Scrape timed out after 30000ms" }],
  "robotsBlocked": ["https://site/private/page"]
}
```

### `DELETE /v1/crawl/{id}`

Stops the crawl: queued pages are dropped, and pages already scraped stay available. Returns `{"success": true, "status": "cancelled"}`.

### Webhooks

`webhook` can be a URL string or an object:

```json
"webhook": {
  "url": "https://your-app.example/hooks/crawl",
  "headers": { "X-Secret": "…" },
  "metadata": { "job": "nightly" },
  "events": ["page", "completed"]
}
```

minicrawl POSTs `{"success": true, "type": "crawl.page", "id": "<crawl id>", "data": [<document>], "metadata": {…}}`. The types are `crawl.started`, `crawl.page` and `crawl.completed`. Delivery is best-effort with a 10s timeout.

---

## POST /v1/map

Lists a site's URLs quickly, without scraping them all. It combines the sitemap(s), the links on the start page, and URLs minicrawl has seen before on that site.

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | **required** | Site |
| `search` | string | – | Rank URLs by relevance to this text (matches first) |
| `limit` | int | `5000` | Max URLs |
| `includeSubdomains` | bool | `true` | Include `*.site` URLs |
| `sitemapOnly` | bool | `false` | Only URLs from the sitemap |
| `ignoreSitemap` | bool | `false` | Skip the sitemap |

```json
{ "success": true, "links": ["https://books.toscrape.com/catalogue/category/books/travel_2/index.html", "…"] }
```

---

## POST /v1/search

Searches the web through SearXNG (bundled in Docker), and optionally scrapes each result.

| Field | Type | Default | Description |
|---|---|---|---|
| `query` | string | **required** | Search terms |
| `limit` | int | `5` | Results (max 50) |
| `lang` | string | `en` | Language |
| `country` | string | `us` | Country |
| `tbs` | string | – | Time filter: `qdr:d` day, `qdr:w` week, `qdr:m` month, `qdr:y` year |
| `timeout` | int (ms) | `60000` | |
| `scrapeOptions` | object | – | If set, each result is scraped and the document merged into it |

```json
{
  "success": true,
  "data": [
    { "url": "https://www.firecrawl.dev/", "title": "Firecrawl", "description": "…" }
  ]
}
```

With `scrapeOptions`, each item also has `markdown`, `metadata`, and so on. A result that fails to scrape keeps its title/url and gets `metadata.error`.

---

## Extract

AI extraction across several pages. It needs an AI provider (a local model or `ANTHROPIC_API_KEY`).

### `POST /v1/extract`

| Field | Type | Default | Description |
|---|---|---|---|
| `urls` | string[] | **required** (1–10) | Pages to read. `https://site.com/*` expands to the site's most relevant pages (up to `EXTRACT_MAX_PAGES`, default 10) |
| `prompt` | string | – | What to extract |
| `schema` | object | – | JSON Schema of the result (prompt and/or schema required) |
| `systemPrompt` | string | – | Extra instructions |
| `enableWebSearch` | bool | `false` | Also read the top 3 web results for the prompt |
| `showSources` | bool | `false` | Return the URLs that were read |
| `scrapeOptions` | object | – | Scrape options for the pages (e.g. `onlyMainContent`, `timeout`, `proxy`) |

Returns `{"success": true, "id": "…"}`.

### `GET /v1/extract/{id}`

```json
{
  "success": true,
  "status": "completed",
  "data": { "books": [{ "title": "A Light in the Attic", "price": "£51.77" }] },
  "sources": ["https://books.toscrape.com/", "…"],
  "expiresAt": "…"
}
```

- `status` is `processing`, `completed` or `failed`.
- `failedUrls` lists pages that couldn't be read.
- `warning` notes truncation.
- On failure, `error` explains why.

---

## Batch scrape

Scrape a list of URLs in the background: the same queue, status, errors and cancel as a crawl, without following links. Scrape options (`formats`, `onlyMainContent`, `actions`, …) go at the top level, as in `/v1/scrape`.

```json
POST /v1/batch/scrape
{
  "urls": ["https://example.com/a", "https://example.com/b"],
  "formats": ["markdown"],
  "ignoreInvalidURLs": true,
  "webhook": "https://your-app.example/hooks/minicrawl"
}
```

```json
{ "success": true, "id": "…", "url": "http://localhost:3002/v1/batch/scrape/…", "invalidURLs": [] }
```

- **One document per URL.** A URL that redirects still gives its own document.
- **Invalid URLs:** `ignoreInvalidURLs: true` skips invalid URLs, and URLs your organization's domain policy blocks, listing them in `invalidURLs`. Without it, the request fails with `400` (or `403 DOMAIN_NOT_ALLOWED`).
- **`appendToId`** adds URLs to an existing batch of your team, even one that already finished.
- **Status:** `GET /v1/batch/scrape/{id}` has the same shape as crawl status, paged with `next`. `GET …/errors` lists failed pages, and `DELETE` cancels.
- **Webhooks** send `batch_scrape.started`, `batch_scrape.page` and `batch_scrape.completed`.
- **Limits:** up to 10,000 URLs per request, and your team's `maxCrawlPages` caps a batch too. `maxConcurrency` is accepted but your team's concurrency limit is what applies.

---

## Firecrawl v2 API

Everything above is also available under `/v2`, in the request and response shapes of Firecrawl's v2 API. That's what the official SDKs' **default clients** use (`Firecrawl` in `@mendable/firecrawl-js` and `firecrawl-py`). Both SDKs are tested against minicrawl in CI.

| v2 endpoint | Notes |
|---|---|
| `POST /v2/scrape` | |
| `POST /v2/batch/scrape`, `GET`/`DELETE /v2/batch/scrape/{id}`, `GET …/errors` | `ignoreInvalidURLs` defaults to `true`, as in Firecrawl v2 |
| `POST /v2/crawl`, `GET`/`DELETE /v2/crawl/{id}`, `GET …/errors` | Cancelling a finished crawl answers `409` |
| `GET /v2/crawl/active` (alias `/ongoing`) | Your team's running crawls |
| `POST /v2/map` | `links` are `{url, title}` objects. Titles come from pages minicrawl has scraped before |
| `POST /v2/search` | Results grouped by source: `data.web`, `data.news`, `data.images` |
| `POST /v2/extract`, `GET /v2/extract/{id}` | Without `urls`, the prompt is searched on the web |
| `GET /v2/team/credit-usage`, `/token-usage`, both `/historical` | 1 credit = 1 page. The plan is your team's `pagesPerMonth`; without one, `remainingCredits` is a very large number |
| `GET /v2/team/queue-status`, `GET /v2/concurrency-check` | Your team's queued and running jobs, and its concurrency limit |

**Formats** are strings or objects:
- `"markdown"`, `"html"`, `"rawHtml"`, `"links"`, `"images"`, `"summary"`
- `{"type": "json", "schema": {…}, "prompt": "…"}`
- `{"type": "screenshot", "fullPage": true}`
- `{"type": "attributes", "selectors": [{"selector": "…", "attribute": "…"}]}`

Firecrawl formats minicrawl can't produce yet are **refused with a 400**, so you notice instead of getting a document without them: `changeTracking`, `branding`, `product`, `menu`, `question`, `highlights`, `query`, `audio`, `video`, `rawBase64`, `deterministicJson`.

**How v2 options map:**

| v2 option | In minicrawl |
|---|---|
| `crawl.sitemap`: `include` / `skip` / `only` | Use the sitemap / ignore it / only sitemap URLs (no link discovery) |
| `crawl.delay` | Seconds to wait before each page |
| `crawl.prompt` (options generated by an LLM) | Not supported: `400`. Set `includePaths`, `limit`, … directly |
| `proxy: "enhanced"` | Same as `stealth` |
| `location.languages` | Sent as `Accept-Language`. `country` has no effect (no geo proxies) |
| `zeroDataRetention: true` | Zero data retention for this request, as with the team setting (see [ADMIN.md](ADMIN.md#team-settings)) |
| `search.sources` | `web`, `news`, `images` (news and images need SearXNG) |
| `search.categories` | `github`, `research`, `pdf`, applied as search operators |
| `search.includeDomains` / `excludeDomains` | Filter results by domain |
| `maxAge`, `storeInCache` | The [page cache](#page-cache) |
| `mobile`, `parsers`, `blockAds`, `fastMode`, `removeBase64Images`, `minAge`, `maxConcurrency`, `robotsUserAgent` | Accepted, no effect yet |

Firecrawl-only endpoints are not available: agent, deep research, browser sessions, monitors, parse, and `crawl/params-preview`. Some of these are on the [roadmap](../README.md#%EF%B8%8F-roadmap).

---

## Errors

Every error has the same shape:

```json
{ "success": false, "code": "BLOCKED_BY_SITE", "error": "The site served a bot-protection challenge instead of the page" }
```

| HTTP | `code` | Meaning / what to do |
|---|---|---|
| 400 | `BAD_REQUEST` | Invalid body. `details` lists the problems, including unrecognized keys |
| 401 | `UNAUTHORIZED` | Missing, wrong, revoked or expired API key |
| 402 | `QUOTA_EXCEEDED` | Your team used its daily/monthly pages. `Retry-After` says when it resets |
| 403 | `FORBIDDEN` | Your key's role or scopes don't allow this (e.g. a viewer key starting a crawl) |
| 403 | `FEATURE_DISABLED` | AI, browser, stealth proxy or search is switched off for your team |
| 403 | `DOMAIN_NOT_ALLOWED` | Your organization's domain policy blocks this site |
| 403 | `IP_NOT_ALLOWED` / `TEAM_DISABLED` | Your address isn't on the team's allowlist / the team is disabled |
| 403 | `BLOCKED_URL` | URL resolves to a private/local address (SSRF protection). Set `ALLOW_PRIVATE_URLS=true` only if you trust all callers |
| 403 | `BLOCKED_BY_SITE` | The site served a bot challenge. Try `proxy: "stealth"` with `STEALTH_PROXY_URLS` |
| 404 | `NOT_FOUND` | Unknown crawl/extract id |
| 408 | `SCRAPE_TIMEOUT` | Raise `timeout` |
| 422 | `UNSUPPORTED_FILE` | File type that can't be converted, or an unreadable file |
| 422 | `ACTION_FAILED` | An action failed. The message says which one and why |
| 422 | `NO_BROWSER` | Screenshots/actions requested but no browser is available |
| 422 | `NO_STEALTH_PROXY` | `proxy: "stealth"` without `STEALTH_PROXY_URLS` |
| 422 | `BODY_TOO_LARGE` / `TOO_MANY_REDIRECTS` | Response over 50 MB / more than 10 redirects |
| 422 | `LLM_REFUSAL` / `LLM_OUTPUT_TOO_LARGE` | The model declined, or the result was too big |
| 429 | `RATE_LIMITED` | Your team's requests per minute. Wait `Retry-After` seconds |
| 429 | `LLM_RATE_LIMITED` | Anthropic rate limit; retry later |
| 503 | `LLM_NOT_CONFIGURED` | No AI provider: set `LLM_BASE_URL` + `LLM_MODEL` or `ANTHROPIC_API_KEY`. Also: the local model server is unreachable, or the model isn't downloaded (`ollama pull <model>`) |
| 504 | `LLM_TIMEOUT` | The local model took longer than `LLM_TIMEOUT_MS` |
| 503 | `SEARCH_BLOCKED` | No SearXNG and DuckDuckGo refused |
| 500 | `SCRAPE_FAILED` | Every engine failed (network error etc.). The message lists why |

---

## Calling it from code

The examples assume `http://localhost:3002` and the key `YOUR_KEY`.

### curl (macOS, Linux, Git Bash)

```bash
curl -X POST http://localhost:3002/v1/scrape \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

### PowerShell (Windows)

```powershell
$h = @{ Authorization = "Bearer YOUR_KEY" }
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3002/v1/scrape -Headers $h -ContentType "application/json" -Body '{"url":"https://example.com"}'
$r.data.markdown
```

Crawl and wait:

```powershell
$c = Invoke-RestMethod -Method Post -Uri http://localhost:3002/v1/crawl -Headers $h -ContentType "application/json" -Body '{"url":"https://books.toscrape.com","limit":5,"crawlEntireDomain":true}'
do { Start-Sleep 2; $s = Invoke-RestMethod -Uri "http://localhost:3002/v1/crawl/$($c.id)" -Headers $h } while ($s.status -eq "scraping")
$s.data.metadata.url
```

### Python (requests)

```python
import time, requests

BASE = "http://localhost:3002"
H = {"Authorization": "Bearer YOUR_KEY"}

page = requests.post(f"{BASE}/v1/scrape", headers=H, json={"url": "https://example.com"}).json()
print(page["data"]["markdown"])

job = requests.post(f"{BASE}/v1/crawl", headers=H, json={"url": "https://books.toscrape.com", "limit": 5, "crawlEntireDomain": True}).json()
while (status := requests.get(f"{BASE}/v1/crawl/{job['id']}", headers=H).json())["status"] == "scraping":
    time.sleep(2)
for doc in status["data"]:
    print(doc["metadata"]["url"], len(doc["markdown"]))
```

### JavaScript (Node 18+ / browser fetch)

```js
const BASE = "http://localhost:3002";
const headers = { Authorization: "Bearer YOUR_KEY", "Content-Type": "application/json" };

const page = await fetch(`${BASE}/v1/scrape`, {
  method: "POST", headers, body: JSON.stringify({ url: "https://example.com" }),
}).then(r => r.json());
console.log(page.data.markdown);

const { links } = await fetch(`${BASE}/v1/map`, {
  method: "POST", headers, body: JSON.stringify({ url: "https://books.toscrape.com", search: "travel" }),
}).then(r => r.json());
```

### Official Firecrawl SDKs

Point the official SDKs at your server. Their default (v2) clients and the older v1 client both work:

```js
import Firecrawl from "@mendable/firecrawl-js";

const fc = new Firecrawl({ apiKey: "YOUR_KEY", apiUrl: "http://localhost:3002" });
const doc = await fc.scrape("https://example.com", { formats: ["markdown", "links"] });
const job = await fc.crawl("https://docs.example.com", { limit: 50 });
const batch = await fc.batchScrape(["https://a.example", "https://b.example"], { options: { formats: ["markdown"] } });
```

```python
from firecrawl import Firecrawl

fc = Firecrawl(api_key="YOUR_KEY", api_url="http://localhost:3002")
doc = fc.scrape("https://example.com", formats=["markdown"])
results = fc.search("self-hosted scraping", sources=["web", "news"], limit=5)
```

What's covered is listed in [SDK compatibility](SELF_HOSTING.md#sdk-compatibility).
