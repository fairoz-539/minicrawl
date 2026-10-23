// A tiny website for end-to-end tests.
import http from "node:http";
import { makePng, makePptx, makeScannedPdf, makeXlsx } from "./fixture-files.js";
import { PROXY_EGRESS_ADDRESS } from "./mock-services.js";

const layout = (title, body) => `<!doctype html>
<html lang="en"><head><title>${title}</title>
<meta name="description" content="${title} description">
<meta property="og:title" content="OG ${title}">
<script>console.log("should be stripped")</script>
<style>body{color:red}</style></head>
<body>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/docs/">Docs</a></nav></header>
<main>${body}</main>
<footer class="footer">Footer text <a href="https://external.example.org/x">External</a></footer>
</body></html>`;

const pages = {
  "/": layout(
    "Home",
    `<h1>Welcome home</h1>
     <p>Intro paragraph with <strong>bold</strong> text.</p>
     <a href="/about/">About (trailing slash)</a>
     <a href="/docs/a">Doc A</a>
     <a href="docs/b#section">Doc B relative with hash</a>
     <a href="/private/secret">Private</a>
     <a href="/redirect-to-about">Redirects to about</a>
     <a href="/image.png">An image</a>
     <a href="mailto:hi@example.com">Mail</a>
     <table><tr><th>Col</th></tr><tr><td>Cell</td></tr></table>`,
  ),
  "/about": layout("About", `<h1>About us</h1><p>We make tests.</p>`),
  "/docs/": layout("Docs index", `<h1>Docs</h1><a href="/docs/a">A</a><a href="/docs/deep/1/2/3">Deep</a>`),
  "/docs/a": layout("Doc A", `<h1>Doc A</h1><pre><code class="language-js">const a = 1;</code></pre>`),
  "/docs/b": layout("Doc B", `<h1>Doc B</h1><p>Second doc.</p>`),
  "/docs/c": layout("Doc C", `<h1>Doc C</h1><p>Only in the sitemap.</p>`),
  "/docs/deep/1/2/3": layout("Deep", `<h1>Deep page</h1>`),
  "/private/secret": layout("Secret", `<h1>Secret</h1>`),
  "/base-test/page": `<html><head><base href="/docs/"></head><body><a href="a">relative to base</a><p>x</p></body></html>`,
};

/** A real one-page PDF with a text layer, built by hand. */
function makePdf(text) {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Title (Fixture PDF) >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((obj, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// Content only exists after JavaScript runs, like a React/Vue app.
const SPA = `<!doctype html><html><head><title>SPA</title></head><body>
<div id="root"></div>
<script>
  setTimeout(() => {
    document.getElementById("root").innerHTML =
      "<h1>Rendered by JavaScript</h1><p>" + "This text only exists after scripts run. ".repeat(5) + "</p>";
  }, 300);
</script></body></html>`;

const CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><div id="challenge-platform">Checking your browser before accessing the site.</div></body></html>`;

// A page that needs clicks and typing before the content appears.
const FORM = `<!doctype html><html><head><title>Form</title></head><body>
<main><h1>Greeter</h1>
<input id="name" placeholder="Your name">
<button id="go" onclick="setTimeout(() => {
  const p = document.createElement('p'); p.id = 'result';
  p.textContent = 'Hello, ' + document.getElementById('name').value + '!';
  document.querySelector('main').appendChild(p);
}, 200)">Greet</button></main></body></html>`;

export async function startFixtureSite() {
  const files = {
    "/scan.png": ["image/png", makePng(["Invoice 4521", "Total 99.50 USD"])],
    "/scanned.pdf": ["application/pdf", makeScannedPdf(["Scanned contract", "Signed 2026"])],
    "/data.xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await makeXlsx()],
    "/deck.pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", await makePptx()],
  };

  const server = http.createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, "http://x");
    const origin = `http://${req.headers.host}`;
    if (files[pathname]) {
      const [type, body] = files[pathname];
      res.writeHead(200, { "content-type": type });
      return res.end(body);
    }
    if (pathname === "/form") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(FORM);
    }
    // Blocks direct traffic, serves traffic that came through the test proxy.
    if (pathname === "/proxy-gated") {
      const viaProxy = req.socket.remoteAddress?.endsWith(PROXY_EGRESS_ADDRESS);
      res.writeHead(viaProxy ? 200 : 403, { "content-type": "text/html" });
      return res.end(
        viaProxy
          ? "<html><head><title>Members</title></head><body><h1>Welcome through the proxy</h1><p>Exclusive content.</p></body></html>"
          : "<html><head><title>Access Denied</title></head><body>Access denied. Reference #18.abc</body></html>",
      );
    }
    // A SearXNG-compatible JSON search endpoint.
    if (pathname === "/searx/search") {
      res.writeHead(200, { "content-type": "application/json" });
      const page = Number(searchParams.get("pageno"));
      return res.end(
        JSON.stringify({
          results:
            page === 1
              ? [
                  { url: `${origin}/docs/a`, title: "Doc A", content: `About ${searchParams.get("q")}` },
                  { url: `${origin}/about`, title: "About", content: "About us" },
                ]
              : [],
        }),
      );
    }
    if (pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`);
    }
    if (pathname === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${origin}/sitemap-docs.xml</loc></sitemap></sitemapindex>`);
    }
    if (pathname === "/sitemap-docs.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>${origin}/docs/c</loc></url><url><loc>${origin}/docs/a</loc></url></urlset>`);
    }
    if (pathname === "/redirect-to-about") {
      res.writeHead(301, { location: "/about" });
      return res.end();
    }
    if (pathname === "/file.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(makePdf("Hello from a PDF"));
    }
    if (pathname === "/photo.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    }
    if (pathname === "/spa") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(SPA);
    }
    if (pathname === "/challenge") {
      res.writeHead(403, { "content-type": "text/html" });
      return res.end(CHALLENGE);
    }
    if (pathname === "/latin1") {
      res.writeHead(200, { "content-type": "text/html; charset=windows-1252" });
      return res.end(Buffer.from("<html><body><h1>Caf\xe9 cr\xe8me \x80</h1></body></html>", "latin1"));
    }
    if (pathname === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<p>slow</p>");
      }, 5000);
      return;
    }
    const html = pages[pathname];
    if (!html) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end(layout("Not found", "<h1>404 Not Found</h1>"));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise(resolve =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) }),
    ),
  );
}
