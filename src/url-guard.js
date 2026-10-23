// SSRF guard: refuse to fetch private, loopback and link-local addresses
// unless ALLOW_PRIVATE_URLS=true (needed for local testing).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

function isPrivateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIp(ip) {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

export function allowPrivate() {
  return process.env.ALLOW_PRIVATE_URLS === "true";
}

export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedUrlError(`Unsupported protocol: ${u.protocol}`);
  }
  if (allowPrivate()) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.some(a => isPrivateIp(a.address))) {
    throw new BlockedUrlError(`Refusing to fetch private address for host ${u.hostname}`);
  }
}
