// Generates real binary fixtures: an image with text, a scanned (image-only)
// PDF, an XLSX workbook and a PPTX deck.
import { createCanvas } from "@napi-rs/canvas";
import ExcelJS from "exceljs";
import JSZip from "jszip";

function drawText(lines, { width = 900, height = 300 } = {}) {
  const canvas = createCanvas(width, height);
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#000000";
  g.font = "bold 48px sans-serif";
  lines.forEach((line, i) => g.fillText(line, 40, 90 + i * 80));
  return canvas;
}

export function makePng(lines) {
  return drawText(lines).toBuffer("image/png");
}

/** A PDF whose only page content is a JPEG: no text layer, needs OCR. */
export function makeScannedPdf(lines) {
  const canvas = drawText(lines, { width: 1200, height: 400 });
  const jpeg = canvas.toBuffer("image/jpeg", 95);
  const content = "q 600 0 0 200 6 500 cm /Im1 Do Q";
  const chunks = [];
  const offsets = [];
  let size = 0;
  const push = part => {
    const buf = typeof part === "string" ? Buffer.from(part, "latin1") : part;
    chunks.push(buf);
    size += buf.length;
  };
  const obj = (n, body) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    for (const piece of [].concat(body)) push(piece);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>");
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  obj(5, [
    `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    "\nendstream",
  ]);
  const xref = size;
  push(`xref\n0 6\n0000000000 65535 f \n`);
  for (let n = 1; n <= 5; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

export async function makeXlsx() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Prices");
  sheet.addRow(["Product", "Price", "In stock"]);
  sheet.addRow(["Widget", 9.99, "yes"]);
  sheet.addRow(["Gadget | Pro", 24.5, "no"]);
  sheet.addRow(["Total", { formula: "B2+B3", result: 34.49 }, ""]);
  wb.addWorksheet("Empty");
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const slideXml = paras =>
  `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${paras
    .map(p => `<p:sp><p:txBody><a:p>${p.map(t => `<a:r><a:t>${t}</a:t></a:r>`).join("")}</a:p></p:txBody></p:sp>`)
    .join("")}</p:spTree></p:cSld></p:sld>`;

export async function makePptx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("ppt/slides/slide1.xml", slideXml([["Quarterly ", "Review"], ["Revenue grew 12%"]]));
  zip.file("ppt/slides/slide2.xml", slideXml([["Next steps"], ["Hire two engineers"]]));
  zip.file("ppt/slides/slide10.xml", slideXml([["Appendix"]]));
  zip.file("ppt/notesSlides/notesSlide2.xml", slideXml([["Mention the budget"], ["2"]]));
  return zip.generateAsync({ type: "nodebuffer" });
}
