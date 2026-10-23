// Turns an engine's raw response into content: HTML/text (with charset
// detection), PDF (text layer, OCR for scans), DOCX, XLSX, PPTX and images
// (OCR via light-ocr). Firecrawl's pdf/document/image engines do the same in Rust plus a
// hosted OCR service.
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import * as cheerio from "cheerio";
import { ocrImage, ocrPdf } from "./ocr.js";

export class UnsupportedFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedFileError";
    this.code = "UNSUPPORTED_FILE";
  }
}

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const MAX_SHEET_ROWS = 2000;
const OCR_ENABLED = process.env.DISABLE_OCR !== "true";

function sniffImage(head) {
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true; // JPEG
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return true;
  if (head[0] === 0x42 && head[1] === 0x4d) return true; // BMP
  return false;
}

export function detectKind(contentType, url, body) {
  const ct = (contentType ?? "").toLowerCase();
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {}
  const head = body ? body.subarray(0, 12) : Buffer.alloc(0);
  const isZip = head.subarray(0, 2).toString("latin1") === "PK";
  const ext = path.split(".").pop();

  if (head.subarray(0, 5).toString("latin1") === "%PDF-" || ct.includes("application/pdf")) return "pdf";
  for (const kind of ["docx", "xlsx", "pptx"]) {
    if (ct.includes(MIME[kind]) || (isZip && ext === kind)) return kind;
  }
  if (/^image\/(png|jpe?g|webp|bmp|tiff)/.test(ct) || (body && sniffImage(head))) return "image";
  if (ct.startsWith("image/")) return "unsupported"; // gif, svg, icons
  if (/html|xml/.test(ct) || !ct) return "html";
  if (/^text\/|json|javascript|csv/.test(ct)) return "text";
  if (ct.includes("octet-stream") && ext === "pdf") return "pdf";
  return "unsupported";
}

// windows-1252 bytes 0x80-0x9F. Node's TextDecoder decodes this charset as
// plain latin1 (nodejs/node#56542), which turns € ’ “ … into control chars.
const CP1252_HIGH =
  "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const CP1252_LABELS = new Set(["windows-1252", "cp1252", "iso-8859-1", "latin1", "us-ascii", "ascii", "x-cp1252"]);

function decodeCp1252(body) {
  let out = "";
  for (const b of body) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  return out;
}

/** Decode bytes using the HTTP charset, then <meta charset>, then UTF-8. */
export function decodeText(body, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  const sniff = body.subarray(0, 2048).toString("latin1");
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? /encoding=["']([\w-]+)["']/i.exec(sniff)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    // Per the WHATWG encoding spec, latin1/ascii labels also mean windows-1252.
    if (CP1252_LABELS.has(label.toLowerCase())) return decodeCp1252(body);
    try {
      return new TextDecoder(label).decode(body);
    } catch {}
  }
  return body.toString("utf8");
}

// --- PDF ------------------------------------------------------------------

export async function pdfToMarkdown(body) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(body));
  } catch (err) {
    throw new UnsupportedFileError(`Could not parse PDF: ${err.message}`);
  }
  const { text } = await extractText(pdf, { mergePages: false });
  const { info } = await getMeta(pdf).catch(() => ({ info: {} }));
  const metadata = { title: info?.Title || undefined, author: info?.Author || undefined, numPages: pdf.numPages };
  let pages = text.map(t => t.replace(/[ \t]+\n/g, "\n").trim());

  // Scanned PDF: (almost) no text layer. Render the pages and OCR them.
  const textChars = pages.join("").replace(/\s/g, "").length;
  if (textChars < 20 * pdf.numPages) {
    if (!OCR_ENABLED) throw new UnsupportedFileError("PDF has no text layer and OCR is disabled");
    const ocr = await ocrPdf(body, { numPages: pdf.numPages });
    pages = ocr.pages;
    metadata.ocr = true;
    if (ocr.truncated) metadata.ocrPagesProcessed = ocr.pages.length;
  }

  pages = pages.filter(Boolean);
  if (pages.length === 0) throw new UnsupportedFileError("No text could be extracted from this PDF");
  return { markdown: pages.join("\n\n---\n\n"), metadata };
}

// --- Office formats ----------------------------------------------------------

export async function docxToHtml(body) {
  const { value } = await mammoth.convertToHtml({ buffer: body });
  return value;
}

function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.richText) return v.richText.map(t => t.text).join("");
    if ("result" in v) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    if (v.error) return v.error;
    return "";
  }
  return String(v);
}

const mdCell = s => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();

export async function xlsxToMarkdown(body) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(body);
  } catch (err) {
    throw new UnsupportedFileError(`Could not parse spreadsheet: ${err.message}`);
  }
  const sections = [];
  wb.eachSheet(sheet => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, row => {
      const values = row.values.slice(1).map(cellText); // row.values is 1-based
      if (values.some(v => v.trim())) rows.push(values);
    });
    if (rows.length === 0) return;
    const width = Math.max(...rows.map(r => r.length));
    const pad = r => [...r, ...Array(width - r.length).fill("")].map(mdCell);
    const shown = rows.slice(0, MAX_SHEET_ROWS + 1);
    const lines = [
      `| ${pad(shown[0]).join(" | ")} |`,
      `| ${Array(width).fill("---").join(" | ")} |`,
      ...shown.slice(1).map(r => `| ${pad(r).join(" | ")} |`),
    ];
    if (rows.length > shown.length) lines.push("", `*${rows.length - shown.length} more rows not shown*`);
    sections.push(`## ${sheet.name}\n\n${lines.join("\n")}`);
  });
  if (sections.length === 0) throw new UnsupportedFileError("Spreadsheet has no data");
  return { markdown: sections.join("\n\n"), metadata: { numSheets: sections.length } };
}

function slideParagraphs(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("a\\:p")
    .toArray()
    .map(p => $(p).find("a\\:t").toArray().map(t => $(t).text()).join("").trim())
    .filter(Boolean);
}

export async function pptxToMarkdown(body) {
  let zip;
  try {
    zip = await JSZip.loadAsync(body);
  } catch (err) {
    throw new UnsupportedFileError(`Could not parse presentation: ${err.message}`);
  }
  const num = name => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  const slides = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => num(a) - num(b));
  const parts = [];
  for (const name of slides) {
    const n = num(name);
    const paras = slideParagraphs(await zip.file(name).async("string"));
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    // Notes slides repeat the slide number as a lone paragraph; drop it.
    const notes = notesFile
      ? slideParagraphs(await notesFile.async("string")).filter(p => p !== String(n))
      : [];
    if (paras.length === 0 && notes.length === 0) continue;
    const [title, ...rest] = paras;
    let md = `## Slide ${n}${title ? `: ${title}` : ""}`;
    if (rest.length) md += `\n\n${rest.join("\n\n")}`;
    if (notes.length) md += `\n\n> **Notes:** ${notes.join(" ")}`;
    parts.push(md);
  }
  if (parts.length === 0) throw new UnsupportedFileError("Presentation has no text");
  return { markdown: parts.join("\n\n"), metadata: { numSlides: slides.length } };
}

// --- Images -------------------------------------------------------------------

export async function imageToMarkdown(body) {
  if (!OCR_ENABLED) throw new UnsupportedFileError("Image text extraction (OCR) is disabled");
  let text;
  try {
    text = await ocrImage(body);
  } catch (err) {
    throw new UnsupportedFileError(`Could not read image: ${err.message}`);
  }
  if (!text) throw new UnsupportedFileError("No text found in image");
  return { markdown: text, metadata: { ocr: true } };
}
