// Best-effort crawl webhooks (crawl.started / crawl.page / crawl.completed /
// crawl.failed), same payload shape as Firecrawl v1.
import { assertPublicUrl } from "./url-guard.js";

export function sendWebhook(webhook, type, id, data) {
  if (!webhook) return;
  const cfg = typeof webhook === "string" ? { url: webhook } : webhook;
  if (cfg.events && !cfg.events.includes(type.replace(/^crawl\./, ""))) return;

  (async () => {
    await assertPublicUrl(cfg.url);
    await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...cfg.headers },
      body: JSON.stringify({ success: true, type, id, data, metadata: cfg.metadata }),
      signal: AbortSignal.timeout(10_000),
    });
  })().catch(err => console.warn(`webhook ${type} for ${id} failed: ${err.message}`));
}
