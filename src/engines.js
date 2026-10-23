// Scrape engines + the racing waterfall from Firecrawl's scrapeURL loop.
//
//   fetch    plain HTTP (undici), retries transient failures, optional proxy
//   browser  headless Chromium via Playwright (src/browser.js), or Firecrawl's
//            playwright-service when PLAYWRIGHT_MICROSERVICE_URL is set
//
// Engine N starts; if it is slow (staggerMs) or its result is not acceptable,
// engine N+1 starts. The first acceptable result wins. "Acceptable" extends
// Firecrawl's rule (2xx + non-empty content) with two checks that send a page
// on to the browser: JavaScript app shells and bot-challenge pages.
import { fetch as undiciFetch } from "undici";
import { assertPublicUrl, BlockedUrlError } from "./url-guard.js";
import { cleanHtml } from "./html.js";
import { htmlToMarkdown } from "./markdown.js";
import { ActionError, browserEngine, hasBrowser, closeBrowser } from "./browser.js";
import {
  UnsupportedFileError, decodeText, detectKind, docxToHtml, imageToMarkdown, pdfToMarkdown, pptxToMarkdown,
  xlsxToMarkdown,
} from "./documents.js";

export { ActionError, closeBrowser };

const FETCH_USER_AGENT =
  process.env.USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const RETRY_STATUSES = new Set([429, 502, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
]);

/** Errors that should stop the waterfall instead of trying the next engine. */
export class FatalScrapeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FatalScrapeError";
    this.code = code;
  }
}

export class ScrapeTimeoutError extends Error {
  constructor(ms) {
    super(`Scrape timed out after ${ms}ms`);
    this.name = "ScrapeTimeoutError";
    this.code = "SCRAPE_TIMEOUT";
  }
}

export class SiteBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SiteBlockedError";
    this.code = "BLOCKED_BY_SITE";
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new FatalScrapeError("Response body too large (50MB max)", "BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchOnce(url, opts, signal) {
  // Follow redirects by hand so every hop passes the SSRF guard.
  let current = url;
  for (let hop = 0; hop <= 10; hop++) {
    await assertPublicUrl(current);
    const res = await undiciFetch(current, {
      redirect: "manual",
      signal,
      dispatcher: opts.proxy?.dispatcher,
      headers: {
        "user-agent": FETCH_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
        "accept-language": "en-US,en;q=0.9",
        "upgrade-insecure-requests": "1",
        ...opts.headers,
      },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      await res.body?.cancel();
      continue;
    }
    return {
      url: current,
      statusCode: res.status,
      contentType: res.headers.get("content-type") ?? "",
      retryAfter: res.headers.get("retry-after"),
      body: await readCapped(res),
    };
  }
  throw new FatalScrapeError("Too many redirects", "TOO_MANY_REDIRECTS");
}

const fetchEngine = {
  name: "fetch",
  async run(url, opts, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchOnce(url, opts, signal);
        if (attempt < 2 && RETRY_STATUSES.has(res.statusCode)) {
          const wait = Math.min(5000, (Number(res.retryAfter) || 0) * 1000 || 500 * 2 ** attempt);
          await sleep(wait, signal);
          continue;
        }
        return res;
      } catch (err) {
        const code = err.cause?.code ?? err.code;
        if (attempt < 2 && TRANSIENT_CODES.has(code) && !signal.aborted) {
          await sleep(500 * 2 ** attempt, signal);
          continue;
        }
        throw err;
      }
    }
  },
};

// Same contract as firecrawl/apps/playwright-service-ts (POST /scrape).
const remoteBrowserEngine = {
  name: "browser",
  async run(url, opts, signal) {
    await assertPublicUrl(url);
    const res = await undiciFetch(process.env.PLAYWRIGHT_MICROSERVICE_URL, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, wait_after_load: opts.waitFor, timeout: opts.timeout, headers: opts.headers }),
    });
    if (!res.ok) throw new Error(`playwright-service returned ${res.status}`);
    const body = await res.json();
    if (body.pageError && !body.content) throw new Error(body.pageError);
    return {
      url: body.url?.startsWith("http") ? body.url : url,
      statusCode: body.pageStatusCode,
      contentType: body.contentType ?? "text/html",
      html: body.content,
    };
  },
};

let localBrowserAvailable;
async function getBrowserEngine() {
  if (process.env.PLAYWRIGHT_MICROSERVICE_URL) return remoteBrowserEngine;
  localBrowserAvailable ??= await hasBrowser();
  return localBrowserAvailable ? browserEngine : null;
}

/** Engines usable in this process, in waterfall order for the given options. */
export async function selectEngines(opts) {
  const browser = await getBrowserEngine();
  if (opts.engine === "fetch") return [fetchEngine];
  if (opts.screenshot || opts.actions?.length) {
    if (!browser) {
      throw new FatalScrapeError("Screenshots and actions need the browser engine (install Playwright)", "NO_BROWSER");
    }
    if (opts.actions?.length && browser === remoteBrowserEngine) {
      throw new FatalScrapeError("Actions need the local browser engine, not PLAYWRIGHT_MICROSERVICE_URL", "NO_BROWSER");
    }
    return [browser];
  }
  const needsBrowser = opts.waitFor > 0 || opts.engine === "browser";
  if (needsBrowser && browser) return [browser, fetchEngine];
  return browser ? [fetchEngine, browser] : [fetchEngine];
}

// --- Result evaluation ----------------------------------------------------

const CHALLENGE_SIGNATURES = [
  /<title>\s*just a moment/i, /cf-browser-verification|challenge-platform|cf_chl_/i,
  /attention required! \| cloudflare/i, /px-captcha|perimeterx/i, /datadome/i,
  /incapsula incident|request unsuccessful\. incapsula/i, /<title>\s*access denied/i,
  /please (enable|turn on) (javascript|js) and (disable|turn off) any ad ?blocker/i,
  /verify(ing)? (that )?you are (a )?human/i, /<title>\s*(robot check|are you a robot)/i,
];

const APP_SHELL = /id=["'](root|app|__next|__nuxt|svelte|main-app)["'][^>]*>\s*<\/div>|ng-version=|<app-root[\s>]/i;
const NEEDS_JS = /<noscript[^>]*>[^<]*(enable|turn on|requires?)[^<]*javascript/i;

const visibleLength = md => md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\]\([^)]*\)/g, "]").replace(/\s+/g, " ").trim().length;

function isChallengePage(html, md) {
  return visibleLength(md) < 1500 && CHALLENGE_SIGNATURES.some(re => re.test(html));
}

function isAppShell(html, md) {
  const len = visibleLength(md);
  if (len < 400 && (APP_SHELL.test(html) || NEEDS_JS.test(html))) return true;
  // Almost no text but a pile of scripts: probably rendered client-side.
  // A short page with a script or two (a tiny "About" page) is left alone.
  return len < 80 && (html.match(/<script\b/gi)?.length ?? 0) >= 3;
}

/**
 * Convert an engine result to content and judge it.
 * @returns {{content: object, ok: boolean, reason?: string, score: number}}
 */
async function evaluate(result) {
  const goodStatus = (result.statusCode >= 200 && result.statusCode < 300) || result.statusCode === 304;
  const kind = result.html !== undefined ? "html" : detectKind(result.contentType, result.url, result.body);

  if (kind === "unsupported") {
    throw new UnsupportedFileError(`Unsupported content type: ${result.contentType || "unknown"}`);
  }
  const fileConverters = { pdf: pdfToMarkdown, xlsx: xlsxToMarkdown, pptx: pptxToMarkdown, image: imageToMarkdown };
  if (fileConverters[kind]) {
    const { markdown, metadata } = await fileConverters[kind](result.body);
    return { content: { kind, markdown, docMetadata: metadata }, ok: goodStatus, score: markdown.length };
  }

  let html;
  if (kind === "docx") html = await docxToHtml(result.body);
  else if (kind === "text") {
    const text = decodeText(result.body, result.contentType);
    return { content: { kind, markdown: text }, ok: goodStatus && text.trim().length > 0, score: text.length };
  } else html = result.html ?? decodeText(result.body, result.contentType);

  const md =
    htmlToMarkdown(cleanHtml(html, result.url, { onlyMainContent: true })) ||
    htmlToMarkdown(cleanHtml(html, result.url, { onlyMainContent: false }));
  const content = { kind, html };

  if (isChallengePage(html, md)) return { content, ok: false, reason: "bot-challenge", score: 0 };
  if (!goodStatus) return { content, ok: false, reason: `status ${result.statusCode}`, score: md.length };
  if (result.engine === "fetch" && kind === "html" && isAppShell(html, md)) {
    return { content, ok: false, reason: "javascript-shell", score: md.length + 1 };
  }
  if (md.length === 0) return { content, ok: false, reason: "empty", score: 0 };
  // Very little text from a page that runs scripts: usable, but let the
  // browser have a go and keep whichever version has more content.
  if (result.engine === "fetch" && kind === "html" && visibleLength(md) < 300 && /<script\b/i.test(html)) {
    return { content, ok: false, reason: "thin", score: md.length };
  }
  return { content, ok: true, score: md.length };
}

export async function scrapeWithWaterfall(url, opts, { staggerMs = 4000, timeoutMs = 30_000 } = {}) {
  const engines = await selectEngines(opts);
  const abort = new AbortController();

  return new Promise((resolve, reject) => {
    let next = 0;
    let running = 0;
    let settled = false;
    let staggerTimer = null;
    let best = null; // best non-acceptable result, returned if nothing better arrives
    const errors = [];

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(staggerTimer);
      clearTimeout(timeoutTimer);
      abort.abort();
      fn(value);
    };

    const checkExhausted = () => {
      if (settled || running > 0 || next < engines.length) return;
      if (best && best.reason !== "bot-challenge") return settle(resolve, best);
      if (best) {
        return settle(
          reject,
          new SiteBlockedError("The site served a bot-protection challenge instead of the page"),
        );
      }
      settle(reject, new Error(`All scraping engines failed: ${errors.join("; ")}`));
    };

    const startNext = () => {
      if (settled || next >= engines.length) return;
      const engine = engines[next++];
      running++;
      clearTimeout(staggerTimer);
      if (next < engines.length) staggerTimer = setTimeout(startNext, staggerMs);

      engine
        .run(url, { ...opts, timeout: timeoutMs }, abort.signal)
        .then(async raw => {
          const result = { ...raw, engine: engine.name };
          const verdict = await evaluate(result);
          return { result: { ...result, ...verdict.content, body: undefined }, verdict };
        })
        .then(({ result, verdict }) => {
          running--;
          if (settled) return;
          if (verdict.ok) {
            // The browser's render of a "thin" page can come back shorter; keep the richer one.
            return settle(resolve, best?.reason === "thin" && best.score > verdict.score ? best : result);
          }
          const candidate = { ...result, reason: verdict.reason, score: verdict.score };
          const rank = r => (r.reason === "bot-challenge" ? -1 : r.reason?.startsWith("status") ? 0 : 1);
          if (!best || rank(candidate) > rank(best) || (rank(candidate) === rank(best) && candidate.score > best.score)) {
            best = candidate;
          }
          errors.push(`${engine.name}: ${verdict.reason}`);
          startNext();
          checkExhausted();
        })
        .catch(err => {
          running--;
          if (settled) return;
          if (
            err instanceof FatalScrapeError ||
            err instanceof BlockedUrlError ||
            err instanceof UnsupportedFileError ||
            err instanceof ActionError
          ) {
            return settle(reject, err);
          }
          errors.push(`${engine.name}: ${err.cause?.code ?? err.message}`);
          startNext();
          checkExhausted();
        });
    };

    const timeoutTimer = setTimeout(() => {
      // Out of time: a usable-but-imperfect result beats an error.
      if (best && best.reason !== "bot-challenge") settle(resolve, best);
      else settle(reject, new ScrapeTimeoutError(timeoutMs));
    }, timeoutMs);
    startNext();
  });
}
