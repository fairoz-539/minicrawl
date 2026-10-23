// Headless Chromium engine (Playwright). Plays the role of Firecrawl's
// fire-engine "chrome-cdp": runs the page's JavaScript, waits for the network
// to settle, scrolls to trigger lazy-loaded content, blocks ads/trackers and
// heavy media, captures file downloads (PDF/DOCX) and can take screenshots.
import { readFile } from "node:fs/promises";
import { assertPublicUrl } from "./url-guard.js";

const MAX_PAGES = Number(process.env.BROWSER_CONCURRENCY ?? 4);
const NETWORK_IDLE_MS = 8000;
const INTERSTITIAL_WAIT_MS = Number(process.env.INTERSTITIAL_WAIT_MS ?? 15_000);
const MAX_SCROLLS = 12;
const INTERSTITIAL_TITLE = /just a moment|checking your browser|please wait|one moment/i;

// Same idea as playwright-service-ts's AD_SERVING_DOMAINS.
const BLOCKED_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
  "google-analytics.com", "googletagmanager.com", "facebook.net", "connect.facebook.net",
  "amazon-adsystem.com", "adnxs.com", "taboola.com", "outbrain.com", "criteo.com",
  "scorecardresearch.com", "hotjar.com", "segment.io", "mixpanel.com", "quantserve.com",
];

// Consent / cookie overlays removed before the HTML is captured.
const OVERLAY_SELECTORS = [
  "#onetrust-banner-sdk", "#onetrust-consent-sdk", "#CybotCookiebotDialog", "#usercentrics-root",
  ".cc-window", ".cookie-banner", "#cookie-banner", "[id*='cookie-consent']", "[class*='cookie-consent']",
  "#truste-consent-track", ".qc-cmp2-container", "#didomi-host",
];

let browserPromise = null;
let active = 0;
const waiters = [];

async function acquire() {
  if (active < MAX_PAGES) {
    active++;
    return;
  }
  await new Promise(resolve => waiters.push(resolve));
  active++;
}

function release() {
  active--;
  waiters.shift()?.();
}

export async function hasBrowser() {
  if (process.env.DISABLE_PLAYWRIGHT === "true") return false;
  try {
    const { chromium } = await import("playwright");
    const { existsSync } = await import("node:fs");
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
      });
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      // A normal Chrome UA rather than "HeadlessChrome/…", matching the real version.
      const userAgent =
        process.env.USER_AGENT ??
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
      return { browser, userAgent };
    })().catch(err => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.browser.close().catch(() => {});
}

const remaining = deadline => Math.max(0, deadline - Date.now());

async function autoScroll(page, deadline) {
  for (let i = 0; i < MAX_SCROLLS && Date.now() < deadline; i++) {
    const atBottom = await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
      return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    });
    await page.waitForTimeout(250);
    if (atBottom) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

export class ActionError extends Error {
  constructor(index, action, cause) {
    super(`Action ${index + 1} (${action.type}) failed: ${cause.message.split("\n")[0]}`);
    this.name = "ActionError";
    this.code = "ACTION_FAILED";
  }
}

const shot = async (page, fullPage) =>
  `data:image/png;base64,${(await page.screenshot({ fullPage: !!fullPage, type: "png" })).toString("base64")}`;

/**
 * Run Firecrawl-style page actions in order. Returns what the
 * screenshot / scrape / executeJavascript actions produced.
 */
async function runActions(page, actions, deadline) {
  const out = { screenshots: [], scrapes: [], javascriptReturns: [] };
  const timeout = () => Math.max(1000, remaining(deadline));
  for (const [i, a] of actions.entries()) {
    try {
      switch (a.type) {
        case "wait":
          if (a.selector) await page.waitForSelector(a.selector, { state: "visible", timeout: timeout() });
          else await page.waitForTimeout(Math.min(a.milliseconds, remaining(deadline)));
          break;
        case "click": {
          const loc = page.locator(a.selector);
          if (a.all) {
            for (const el of await loc.all()) await el.click({ timeout: timeout() });
          } else {
            await loc.first().click({ timeout: timeout() });
          }
          await page.waitForLoadState("domcontentloaded", { timeout: timeout() }).catch(() => {});
          break;
        }
        case "write":
          if (a.selector) await page.locator(a.selector).first().fill(a.text, { timeout: timeout() });
          else await page.keyboard.type(a.text, { delay: 20 });
          break;
        case "press":
          await page.keyboard.press(a.key);
          await page.waitForLoadState("domcontentloaded", { timeout: timeout() }).catch(() => {});
          break;
        case "scroll": {
          const dy = (a.direction === "up" ? -1 : 1) * (a.amount ?? 1);
          if (a.selector) {
            await page.locator(a.selector).first().evaluate((el, n) => el.scrollBy(0, n * el.clientHeight), dy);
          } else {
            await page.evaluate(n => window.scrollBy(0, n * window.innerHeight), dy);
          }
          await page.waitForTimeout(300);
          break;
        }
        case "screenshot":
          out.screenshots.push(await shot(page, a.fullPage));
          break;
        case "scrape":
          out.scrapes.push({ url: page.url(), html: await page.content() });
          break;
        case "executeJavascript": {
          const value = await page.evaluate(a.script);
          out.javascriptReturns.push({ type: value === null ? "null" : typeof value, value: value ?? null });
          break;
        }
      }
    } catch (err) {
      throw new ActionError(i, a, err);
    }
  }
  // Let whatever the last action triggered finish loading.
  await page.waitForLoadState("networkidle", { timeout: Math.min(3000, remaining(deadline)) }).catch(() => {});
  return out;
}

async function readDownload(download, url) {
  const path = await download.path();
  const name = download.suggestedFilename().toLowerCase();
  const contentType = name.endsWith(".pdf")
    ? "application/pdf"
    : name.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/octet-stream";
  return { url: download.url() || url, statusCode: 200, contentType, body: await readFile(path) };
}

export const browserEngine = {
  name: "browser",
  async run(url, opts, signal) {
    await assertPublicUrl(url);
    const deadline = Date.now() + (opts.timeout ?? 30_000) - 1000;
    await acquire();
    let context;
    const onAbort = () => context?.close().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const { browser, userAgent } = await getBrowser();
      context = await browser.newContext({
        userAgent,
        locale: "en-US",
        viewport: { width: 1366, height: 900 },
        acceptDownloads: true,
        proxy: opts.proxy?.playwright,
        extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9", ...opts.headers },
        ignoreHTTPSErrors: !!opts.skipTlsVerification,
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });

      const wantsScreenshot = !!opts.screenshot || !!opts.actions?.some(a => a.type === "screenshot");
      await context.route("**/*", route => {
        const req = route.request();
        let host = "";
        try {
          host = new URL(req.url()).hostname;
        } catch {}
        if (BLOCKED_HOSTS.some(h => host === h || host.endsWith("." + h))) return route.abort();
        const type = req.resourceType();
        if (type === "media" || (!wantsScreenshot && (type === "image" || type === "font"))) return route.abort();
        return route.continue();
      });

      const page = await context.newPage();
      // Files (PDF, DOCX) make Chromium start a download instead of a page.
      const download = new Promise(resolve => page.once("download", resolve));
      // The latest main-frame navigation response, so the status code stays
      // right when the page navigates on its own (redirects, interstitials).
      let mainResponse = null;
      page.on("response", r => {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) mainResponse = r;
      });

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(1000, remaining(deadline)) });
      } catch (err) {
        if (!/download is starting/i.test(err.message)) throw err;
        return await readDownload(await download, url);
      }

      const typeOf = async r => (await r?.headerValue("content-type").catch(() => null)) ?? "text/html";
      if (mainResponse && !/html|xml|text\/plain/i.test(await typeOf(mainResponse))) {
        // A non-HTML file shown inline: hand back the bytes.
        return { url: page.url(), statusCode: mainResponse.status(), contentType: await typeOf(mainResponse), body: await mainResponse.body() };
      }

      await page.waitForLoadState("networkidle", { timeout: Math.min(NETWORK_IDLE_MS, remaining(deadline)) }).catch(() => {});

      // A "checking your browser" interstitial usually moves on by itself in a
      // real browser after a few seconds. Wait for that, or for it to turn into
      // a file download. Interactive CAPTCHAs are not attempted.
      if (INTERSTITIAL_TITLE.test(await page.title().catch(() => ""))) {
        const outcome = await Promise.race([
          download.then(d => ({ download: d })),
          page
            .waitForFunction(src => !new RegExp(src, "i").test(document.title), INTERSTITIAL_TITLE.source, {
              timeout: Math.min(INTERSTITIAL_WAIT_MS, remaining(deadline)),
              polling: 250,
            })
            .then(() => ({}), () => ({})),
        ]);
        if (outcome.download) return await readDownload(outcome.download, url);
        await page.waitForLoadState("networkidle", { timeout: Math.min(5000, remaining(deadline)) }).catch(() => {});
        if (mainResponse && !/html|xml|text\/plain/i.test(await typeOf(mainResponse))) {
          return { url: page.url(), statusCode: mainResponse.status(), contentType: await typeOf(mainResponse), body: await mainResponse.body() };
        }
      }

      if (opts.waitFor) await page.waitForTimeout(Math.min(opts.waitFor, remaining(deadline)));
      // Actions drive the page themselves; auto-scrolling could undo their state.
      const actions = opts.actions?.length ? await runActions(page, opts.actions, deadline) : undefined;
      if (!actions) await autoScroll(page, deadline).catch(() => {});
      await page
        .evaluate(sels => sels.forEach(s => document.querySelectorAll(s).forEach(el => el.remove())), OVERLAY_SELECTORS)
        .catch(() => {});

      const screenshot = wantsScreenshot ? await shot(page, opts.screenshot === "fullPage") : undefined;

      return {
        url: page.url(),
        statusCode: mainResponse?.status() ?? 200,
        contentType: await typeOf(mainResponse),
        html: await page.content(),
        screenshot,
        actions,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      await context?.close().catch(() => {});
      release();
    }
  },
};
