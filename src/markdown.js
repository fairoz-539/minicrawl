// HTML -> Markdown. Firecrawl uses a Go html-to-markdown with the GFM and
// robust-code-block plugins; Turndown + turndown-plugin-gfm is the JS analogue.
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  linkStyle: "inlined",
});
turndown.use(gfm);

// Keep the language hint on <pre><code class="language-x">.
turndown.addRule("fencedCodeWithLanguage", {
  filter: node => node.nodeName === "PRE" && node.firstChild?.nodeName === "CODE",
  replacement: (_content, node) => {
    const code = node.firstChild;
    const lang = (code.getAttribute("class") ?? "").match(/(?:language|lang)-([\w+-]+)/)?.[1] ?? "";
    const text = code.textContent.replace(/\n$/, "");
    const fence = text.includes("```") ? "````" : "```";
    return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
  },
});

const TABLE_PARTS = "tr, td, th, tbody, thead, tfoot, caption, colgroup, col";

/**
 * Make every table something GFM can express:
 *  - layout tables (nested tables, role=presentation, single cell) become divs
 *  - data tables without a header row get their first row promoted to <th>
 *  - tables with no rows are dropped (they crash turndown-plugin-gfm)
 * Without this, the GFM plugin leaves header-less tables as raw HTML.
 */
function normalizeTables(html) {
  if (!/<table/i.test(html)) return html;
  const $ = cheerio.load(html, null, false);
  const ownRows = t => $(t).find("tr").filter((_, tr) => $(tr).closest("table")[0] === t);

  // Decide every table's fate before changing anything.
  const plan = $("table")
    .toArray()
    .map(t => {
      const rows = ownRows(t);
      const cells = rows.children("td, th").length;
      const layout =
        $(t).find("table").length > 0 ||
        $(t).parents("table").length > 0 ||
        $(t).attr("role") === "presentation" ||
        cells <= 1;
      return { t, rows, layout };
    });

  for (const { t, rows, layout } of plan) {
    if (rows.length === 0 && !$(t).text().trim()) {
      $(t).remove();
    } else if (layout) {
      $(t)
        .find(TABLE_PARTS)
        .filter((_, el) => $(el).closest("table")[0] === t)
        .each((_, el) => {
          el.name = "div";
        });
      t.name = "div";
    } else if (rows.first().children("th").length === 0) {
      rows.first().children("td").each((_, el) => {
        el.name = "th";
      });
    }
  }
  return $.html();
}

function tidy(md) {
  return md
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToMarkdown(html) {
  if (!html || !html.trim()) return "";
  try {
    return tidy(turndown.turndown(normalizeTables(html)));
  } catch {
    // Last resort on pathological markup: readable text beats an error.
    const $ = cheerio.load(html);
    $("br").replaceWith("\n");
    $("p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article").each((_, el) => {
      $(el).append("\n");
    });
    return tidy($.root().text());
  }
}
