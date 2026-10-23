// Outbound proxy pools, rotated round-robin. Mirrors Firecrawl's `proxy`
// option ("basic" | "stealth" | "auto"); here you bring the proxies:
//   PROXY_URLS          basic pool, comma-separated (PROXY_URL also accepted)
//   STEALTH_PROXY_URLS  e.g. residential/mobile proxies for sites that block
//                       datacenter traffic; used for proxy:"stealth", and by
//                       proxy:"auto" after a basic attempt is blocked
import { ProxyAgent } from "undici";

const list = v =>
  (v ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

const pools = () => ({
  basic: list(process.env.PROXY_URLS ?? process.env.PROXY_URL),
  stealth: list(process.env.STEALTH_PROXY_URLS),
});

const cursor = { basic: 0, stealth: 0 };
const agents = new Map();

function describe(url) {
  const u = new URL(url);
  if (!agents.has(url)) agents.set(url, new ProxyAgent(url));
  return {
    url,
    // For logs/metadata: never include credentials.
    label: `${u.protocol}//${u.host}`,
    dispatcher: agents.get(url),
    playwright: {
      server: `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    },
  };
}

/** Next proxy of the tier, or null to connect directly (basic tier only). */
export function pickProxy(tier) {
  const pool = pools()[tier] ?? [];
  if (pool.length === 0) return null;
  const url = pool[cursor[tier]++ % pool.length];
  return describe(url);
}

export function hasStealthPool() {
  return pools().stealth.length > 0;
}

/** Pool sizes, for /health (never the URLs: they can carry credentials). */
export function proxyPoolSizes() {
  const p = pools();
  return { basic: p.basic.length, stealth: p.stealth.length };
}
