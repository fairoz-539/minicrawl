// Generates docs/assets/demo.svg: an animated terminal session for the README.
// Pure SVG + CSS (no GIF), so it stays sharp and tiny, and GitHub plays it inline.
// The output shown is copied from real runs; update SCRIPT when the output changes.
//   node scripts/make-demo-svg.mjs
import { writeFileSync } from "node:fs";

const W = 900;
const LINE = 21;
const PAD_X = 22;
const TOP = 52;
const CYCLE = 22; // seconds per loop
const CHARS_PER_SEC = 38;

// kind: cmd (typed, with prompt) | cont (typed continuation) | out (appears) | gap
const SCRIPT = [
  ["cmd", "bash scripts/setup.sh", 0.4],
  ["out", "Created .env with a new API key. Use it as:  Authorization: Bearer <key>", 0.5, "muted"],
  ["cmd", "docker compose up -d", 0.6],
  ["out", " ✔ Container minicrawl-searxng-1    Started", 0.9, "ok"],
  ["out", " ✔ Container minicrawl-minicrawl-1  Started", 0.3, "ok"],
  ["gap"],
  ["cmd", "curl -s localhost:3002/v1/scrape -H \"Authorization: Bearer $KEY\" \\", 0.7],
  ["cont", "  -H 'Content-Type: application/json' -d '{\"url\": \"https://quotes.toscrape.com/js/\"}' \\", 0],
  ["cont", "  | jq -r '.data.metadata.engine, .data.markdown'", 0],
  ["out", "browser", 2.2, "accent"],
  ["out", "# [Quotes to Scrape](https://quotes.toscrape.com/)", 0.25, "heading"],
  ["out", "“The world as we have created it is a process of our thinking. It cannot…", 0.2],
  ["out", "Tags: change deep-thoughts thinking world", 0.15, "muted"],
  ["out", "“It is our choices, Harry, that show what we truly are, far more than our…", 0.15],
  ["out", "Tags: abilities choices", 0.15, "muted"],
  ["gap"],
  ["out", "# Next: open http://localhost:3002/docs to try every endpoint in your browser", 0.9, "muted"],
];

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let t = 0;
let y = TOP;
const lines = [];
for (const [kind, text, delay = 0, tone = ""] of SCRIPT) {
  if (kind === "gap") {
    y += LINE * 0.6;
    continue;
  }
  t += delay;
  const typing = kind === "cmd" || kind === "cont" ? text.length / CHARS_PER_SEC : 0.05;
  lines.push({ kind, text, tone, y: Math.round(y * 10) / 10, start: t, end: t + typing });
  t += typing;
  y += LINE;
}
if (t > CYCLE - 4) throw new Error(`Script runs ${t.toFixed(1)}s; raise CYCLE`);
const H = Math.round(y + 18);

const pct = s => ((s / CYCLE) * 100).toFixed(2);
const css = [];
const body = [];
lines.forEach((l, i) => {
  const name = `l${i}`;
  // hidden -> revealed (left to right while typing) -> held -> hidden for the next loop
  css.push(
    `@keyframes ${name}{0%,${pct(l.start)}%{clip-path:inset(0 100% 0 0)}` +
      `${pct(l.end)}%,96%{clip-path:inset(0 0 0 0)}100%{clip-path:inset(0 100% 0 0)}}` +
      `.${name}{animation:${name} ${CYCLE}s linear infinite}`,
  );
  const prompt = l.kind === "cmd" ? `<tspan class="prompt">$ </tspan>` : l.kind === "cont" ? "  " : "";
  const cls = [name, l.kind === "out" ? "out" : "cmd", l.tone].filter(Boolean).join(" ");
  body.push(`<text x="${PAD_X}" y="${l.y}" class="${cls}" xml:space="preserve">${prompt}${esc(l.text)}</text>`);
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="minicrawl demo: setup, docker compose up, then scraping a JavaScript-rendered page to markdown">
<title>minicrawl demo</title>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:14px;fill:#c9d1d9;clip-path:inset(0 100% 0 0)}
.prompt{fill:#3fb950;font-weight:700}.cmd{fill:#e6edf3}.muted{fill:#8b949e}.ok{fill:#3fb950}.accent{fill:#f97316;font-weight:700}.heading{fill:#79c0ff;font-weight:700}
${css.join("\n")}
@media (prefers-reduced-motion:reduce){text{animation:none!important;clip-path:none}}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<rect width="${W}" height="34" rx="10" fill="#161b22"/><rect y="24" width="${W}" height="10" fill="#161b22"/>
<circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
<text x="${W / 2}" y="22" text-anchor="middle" style="fill:#8b949e;font-size:12px;clip-path:none;animation:none">minicrawl</text>
${body.join("\n")}
</svg>
`;

writeFileSync(new URL("../docs/assets/demo.svg", import.meta.url), svg);
console.log(`docs/assets/demo.svg: ${lines.length} lines, ${t.toFixed(1)}s of ${CYCLE}s loop, ${svg.length} bytes`);
