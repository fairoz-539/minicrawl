# Self-hosting minicrawl

This guide gets minicrawl running on your own computer or server. The recommended way is **Docker Compose**: one command starts minicrawl (with its headless browser and OCR) plus a private SearXNG for web search.

- [Requirements](#requirements)
- [Quick start (Docker Compose)](#quick-start-docker-compose)
- [Step by step](#step-by-step) on Windows, macOS and Linux
- [Configuration](#configuration)
- [Using it](#using-it): from this machine, your network, or the internet
- [Exposing it on the internet (HTTPS)](#exposing-it-on-the-internet-https)
- [Running without Compose](#running-without-compose-docker-run)
- [Running without Docker](#running-without-docker-nodejs)
- [Updating, backups, logs](#operations)
- [Sizing and tuning](#sizing-and-tuning)
- [SDK compatibility](#sdk-compatibility)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

---

## Requirements

| | Minimum | Recommended |
|---|---|---|
| Docker | Docker Engine 24+ with Compose v2.24+ (Docker Desktop on Windows/macOS) | latest |
| CPU | 2 cores, x86-64 or ARM64 (Apple Silicon, Raspberry Pi 5, Graviton) | 4 cores |
| RAM | 2 GB free for the containers | 4 GB+ (each open browser page uses ~100–300 MB) |
| Disk | ~3 GB (image with Chromium and OCR model) | + space for crawl results |

Optional:
- An **Anthropic API key** for AI extraction (`json` format and `/v1/extract`).
- Your own **proxies** for sites that block datacenter IPs.

## Quick start (Docker Compose)

```bash
git clone https://github.com/fairoz-539/minicrawl.git minicrawl
cd minicrawl
bash scripts/setup.sh          # Windows: powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
docker compose up -d --build
```

The setup script writes `.env` with **your own** randomly generated API key and SearXNG secret, and optionally your own Anthropic key. It prints the API key once; it's also in `.env`.

> **Your keys are yours.** The project ships with no keys. Every installation creates its own, kept only in that machine's `.env`: git ignores it and the Docker build excludes it. Never share your `.env`. If you fork this repository, `.env` stays out of it automatically.

Open **http://localhost:3002/docs**, click **Authorize**, paste your `API_KEY`, and try any endpoint.

The first build takes 3–10 minutes: it downloads Node, Chromium and its libraries, and the OCR model. Later starts take seconds.

---

## Step by step

### 1. Install Docker

- **Windows / macOS:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it. Wait until it says "Engine running".
- **Linux:** install Docker Engine and the Compose plugin ([docs](https://docs.docker.com/engine/install/)). Then let your user run it: `sudo usermod -aG docker $USER`, and log out and back in.

Check:

```bash
docker --version
docker compose version
```

### 2. Get the code

```bash
git clone https://github.com/fairoz-539/minicrawl.git minicrawl
cd minicrawl
```

(Or download the ZIP from the repository page and unpack it.)

### 3. Create your settings file with your own keys

**Easiest: run the setup script.** It creates `.env` with a freshly generated API key, and asks for your Anthropic key (press Enter to skip):

| System | Command (from the `minicrawl` folder) |
|---|---|
| macOS / Linux / Git Bash | `bash scripts/setup.sh` |
| Windows PowerShell | `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` |

It never overwrites an existing `.env`. Non-interactive use on Windows: add `-SkipAnthropic` or `-AnthropicKey sk-ant-…`.

**Or by hand:** `cp .env.example .env` (PowerShell: `Copy-Item .env.example .env`), open `.env` in any text editor, and continue with step 4.

### 4. Your API key

The Docker image **will not start without one**, or with a placeholder or short one (`YOUR_KEY`, `changeme`, anything under 16 characters). That way a server that ends up reachable from the internet isn't an open scraping proxy. If you used the setup script, this is done. Otherwise, generate a long random key:

| System | Command |
|---|---|
| macOS / Linux | `openssl rand -hex 32` |
| Windows PowerShell | `-join ((48..57)+(97..102) \| Get-Random -Count 32 \| % {[char]$_})` |

Put it in `.env`:

```
API_KEY=3f9c2a…your-key…
```

To give different people or apps their own key, use `API_KEYS=key-for-alice,key-for-bob`. Revoke one by removing it and restarting.

To run with no key (only on a trusted machine), set `ALLOW_NO_AUTH=true` instead.

### 5. Start it

```bash
docker compose up -d --build
```

This starts two containers:
- **minicrawl**: the API, on port 3002
- **searxng**: private web search, not reachable from outside

### 6. Check it

```bash
docker compose ps                         # minicrawl should become "healthy" within ~30 s
curl http://localhost:3002/health
```

`/health` shows which features are active:

```json
{"status":"ok","auth":true,"features":{"browser":true,"ocr":true,"ai":false,"search":"searxng",…}}
```

`"ai": false` just means you haven't added `ANTHROPIC_API_KEY` yet.

### 7. Make your first request

```bash
curl -X POST http://localhost:3002/v1/scrape \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3002/v1/scrape -Headers @{Authorization="Bearer YOUR_KEY"} -ContentType "application/json" -Body '{"url":"https://example.com"}'
```

The full endpoint reference with examples is in [API.md](API.md), and is interactive at `/docs`.

---

## Configuration

All settings live in `.env`. After changing it, run `docker compose up -d` to apply. `.env.example` lists everything with comments.

| Variable | Default | Description |
|---|---|---|
| **Access** | | |
| `API_KEY` | – | Key clients send as `Authorization: Bearer <key>`. **Required in Docker** |
| `API_KEYS` | – | Several keys, comma-separated |
| `ALLOW_NO_AUTH` | `false` | `true` = run without keys (trusted networks only) |
| **Network** | | |
| `MINICRAWL_PORT` | `3002` | Port on the host |
| `MINICRAWL_BIND` | `0.0.0.0` | `127.0.0.1` = reachable only from this machine; `0.0.0.0` = also from your network |
| `SEARXNG_SECRET` | built-in | Random string for the bundled SearXNG |
| **AI extraction** | | |
| `ANTHROPIC_API_KEY` | – | Enables the `json` format and `/v1/extract` ([get a key](https://console.anthropic.com)) |
| `LLM_MODEL` | `claude-opus-5-5` | Claude model |
| `LLM_EFFORT` | `medium` | `low` … `max`: depth vs. cost |
| `LLM_FALLBACKS` | `true` | Server-side fallback when the model declines |
| `EXTRACT_MAX_PAGES` | `10` | Pages read per `/v1/extract` job |
| **Proxies** | | |
| `PROXY_URLS` | – | Basic pool: `http://user:pass@host:port,…` (rotated) |
| `STEALTH_PROXY_URLS` | – | Stealth pool (e.g. residential), used after a block or with `proxy:"stealth"` |
| **Performance** | | |
| `WORKERS` | `4` | Crawl/extract jobs in parallel |
| `BROWSER_CONCURRENCY` | `4` | Browser pages open at once |
| `MAX_OCR_PAGES` / `OCR_DPI` | `20` / `200` | Scanned-PDF OCR limits |
| `OCR_PROVIDER` | `auto` | `auto` uses the GPU when there is one (falls back to CPU on GPU errors); `cpu` never uses the GPU |
| `INTERSTITIAL_WAIT_MS` | `15000` | Wait for "checking your browser" pages |
| **Safety** | | |
| `ALLOW_PRIVATE_URLS` | `false` | Allow scraping `localhost`/LAN addresses. Keep `false` on shared servers: otherwise anyone with a key can reach your internal network |

---

## Using it

| From | URL |
|---|---|
| The same machine | `http://localhost:3002` |
| Another device on your network | `http://<this machine's IP>:3002` |

To find this machine's IP: Windows `ipconfig`, macOS `ipconfig getifaddr en0`, Linux `hostname -I`. The device must be allowed through the firewall. On Windows, allow port 3002 when prompted, or run:

```powershell
New-NetFirewallRule -DisplayName "minicrawl" -Direction Inbound -Protocol TCP -LocalPort 3002 -Action Allow
```

If you only ever call it from the same machine, set `MINICRAWL_BIND=127.0.0.1` in `.env`.

## Exposing it on the internet (HTTPS)

Don't expose port 3002 directly; put a reverse proxy with HTTPS in front of it. You need a domain name pointing at the server, and ports 80 and 443 open.

**Caddy** (gets certificates automatically). Add this service to `docker-compose.yml`:

```yaml
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    restart: unless-stopped
```

Add `caddy-data:` under `volumes:`, and create a `Caddyfile`:

```
scrape.example.com {
    reverse_proxy minicrawl:3002
}
```

Then set `MINICRAWL_BIND=127.0.0.1` so port 3002 is no longer reachable directly, and run `docker compose up -d`.

**nginx** (if you already run it):

```nginx
server {
    listen 443 ssl;
    server_name scrape.example.com;
    # ssl_certificate / ssl_certificate_key from certbot
    client_max_body_size 2m;
    proxy_read_timeout 330s;   # scrapes can take up to the request timeout
    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Checklist for public servers:**
- Use a long random `API_KEY`, one per client (`API_KEYS`).
- Keep `ALLOW_PRIVATE_URLS=false`.
- Only 80/443 open.
- Keep it updated.

---

## Running without Compose (`docker run`)

```bash
docker build -t minicrawl .
docker volume create minicrawl-data
docker run -d --name minicrawl -p 3002:3002 --shm-size=1g --init \
  -e API_KEY=YOUR_KEY \
  -e SEARXNG_ENDPOINT=http://your-searxng:8080 \
  -v minicrawl-data:/data \
  --restart unless-stopped minicrawl
```

Without `SEARXNG_ENDPOINT`, `/v1/search` falls back to DuckDuckGo, which usually blocks automated requests. To run your own SearXNG, use `deploy/searxng/settings.yml` (it must allow the `json` format).

## Running without Docker (Node.js)

This needs **Node.js 22.13+** (24 recommended).

```bash
npm install
npx playwright install chromium     # once; on Linux add --with-deps
cp .env.example .env                # API_KEY optional when running locally
npm start
```

- `npm start` reads `.env`.
- Without Docker there's no bundled SearXNG: set `SEARXNG_ENDPOINT` to one you run.
- The database is `minicrawl.db` in the project folder (`DB_PATH` changes it).
- `npm test` runs the test suite.

Supported platforms: Windows x64/arm64, macOS (Intel/Apple Silicon), Linux x64/arm64 (glibc and musl).

---

## Operations

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f minicrawl` (or `npm run docker:logs`) |
| Restart | `docker compose restart minicrawl` |
| Stop (keep data) | `docker compose down` |
| Update to the latest code | `git pull && docker compose up -d --build` |
| Apply `.env` changes | `docker compose up -d` |

**Data:** crawl results, crawl state and the URL index live in the `minicrawl-data` volume (SQLite at `/data/minicrawl.db`). They survive restarts and updates. Crawl results are kept like Firecrawl's, but nothing deletes old data automatically. To start fresh, remove the volume (see [Uninstalling](#uninstalling)).

**Backup:**

```bash
docker run --rm -v minicrawl_minicrawl-data:/data -v "$PWD":/backup busybox tar czf /backup/minicrawl-data.tgz -C /data .
```

(The volume name is `<folder>_minicrawl-data`; `docker volume ls` shows it.)

## Sizing and tuning

- Each **browser page** (JS sites, screenshots, actions) uses about 100–300 MB of RAM. `BROWSER_CONCURRENCY` caps how many are open.
- `WORKERS` sets how many crawl pages and extract jobs run at once. Lower it on small machines (e.g. `WORKERS=2`, `BROWSER_CONCURRENCY=2` for 2 GB).
- Plain HTML pages use the fast HTTP path and are cheap. Hundreds per minute is normal.
- OCR runs on the CPU. A scanned page takes roughly 0.3–2 s.
- To be polite to sites you don't own, keep `WORKERS` low and use `limit`. minicrawl has no per-site delay.

## SDK compatibility

minicrawl implements Firecrawl's **v1** REST API. Tested with the official JavaScript SDK (`@mendable/firecrawl-js` 4.51, the `FirecrawlAppV1` client, `apiUrl` pointed at minicrawl):

| SDK method | Works |
|---|---|
| `scrapeUrl` (formats, actions, screenshots) | ✅ |
| `mapUrl` | ✅ |
| `crawlUrl` (waits and collects all pages) | ✅ |
| `asyncCrawlUrl`, `checkCrawlStatus`, `cancelCrawl` | ✅ |
| `checkCrawlErrors` | ✅ |
| `search` (with and without `scrapeOptions`) | ✅ |
| `asyncExtract`, `getExtractStatus` | ✅ (results need `ANTHROPIC_API_KEY`) |

```js
import { FirecrawlAppV1 } from "@mendable/firecrawl-js";
const app = new FirecrawlAppV1({ apiKey: "YOUR_KEY", apiUrl: "http://localhost:3002" });
```

Not supported:
- The SDKs' default v2 clients
- Firecrawl-only endpoints: batch scrape, deep research, llms.txt, credit/queue usage

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Container exits: `No API key configured` | Run the setup script, or set `API_KEY` in `.env` (or `ALLOW_NO_AUTH=true`), then `docker compose up -d` |
| Container exits: `API key(s) look like a placeholder or are too short` | Use a generated key of 16+ characters: run the setup script (after deleting `.env`), or `openssl rand -hex 32` |
| `port is already allocated` | Something else uses 3002: set `MINICRAWL_PORT=3003` in `.env` |
| `401 UNAUTHORIZED` | Send `Authorization: Bearer <key>` exactly; check there are no spaces or quotes in `.env` |
| `/health` shows `"browser": false` | The image build failed to install Chromium. Rebuild: `docker compose build --no-cache` |
| Browser pages crash / `Target closed` | Not enough shared memory or RAM: keep `shm_size: 1gb`, lower `BROWSER_CONCURRENCY` |
| `503 SEARCH_BLOCKED` or no search results | Check `docker compose ps` shows `searxng` running; `docker compose logs searxng`. Some upstream engines rate-limit; results recover after a while |
| `403 BLOCKED_URL` when scraping `localhost` or a LAN address | Expected (SSRF protection). From inside Docker, your PC is `host.docker.internal`; allowing it needs `ALLOW_PRIVATE_URLS=true` |
| `403 BLOCKED_BY_SITE` | The site requires a CAPTCHA or blocks your IP. Add `STEALTH_PROXY_URLS` and use `proxy: "auto"` |
| `503 LLM_NOT_CONFIGURED` | Add `ANTHROPIC_API_KEY` to `.env`, then `docker compose up -d` |
| Build fails with `rpc error … EOF` or is killed | Docker ran out of memory: close other apps, or raise Docker Desktop's memory limit (Settings → Resources) and build again |
| Slow first request after start | The browser and OCR engine start on first use (a few seconds) |

## Uninstalling

```bash
docker compose down -v      # stops containers and DELETES the data volumes
docker image rm minicrawl:local searxng/searxng
```

Then delete the folder.
