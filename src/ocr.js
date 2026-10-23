// OCR for images and scanned PDFs with light-ocr (PP-OCRv6, runs offline;
// the model and PDFium ship inside the npm package). Firecrawl does this with
// its hosted FirePDF / RunPod OCR service.
import { createDocumentEngine } from "@arcships/light-ocr";

export const MAX_OCR_PAGES = Number(process.env.MAX_OCR_PAGES ?? 20);
const OCR_DPI = Number(process.env.OCR_DPI ?? 200);

// "auto" uses the GPU (WebGPU/Core ML) when there is one; "cpu" never does.
let provider = process.env.OCR_PROVIDER === "cpu" ? "cpu" : "auto";
let enginePromise = null;

function getEngine() {
  enginePromise ??= createDocumentEngine({
    // light-ocr 0.5 accepts `provider` but rejects `sessionFallback`, so the
    // GPU-to-CPU fallback is done in withEngine() below.
    engineOptions: { execution: { provider } },
  }).catch(err => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

/**
 * Run an OCR call. If it fails on the GPU (e.g. out of GPU memory on a busy
 * desktop), switch to a CPU engine for good and retry once.
 */
async function withEngine(fn) {
  try {
    return await fn(await getEngine());
  } catch (err) {
    // Bad input (e.g. a corrupt image) is not a reason to give up on the GPU.
    const gpuProblem = /gpu|webgpu|d3d|dawn|vulkan|metal|device|out of memory|provider|session/i.test(err.message);
    if (provider === "cpu" || !gpuProblem) throw err;
    console.warn(`OCR failed on the GPU (${err.message}); switching to CPU`);
    provider = "cpu";
    const old = enginePromise;
    enginePromise = null;
    old?.then(e => e.close()).catch(() => {});
    return fn(await getEngine());
  }
}

let available = null;
/** True once the OCR engine has actually loaded (native addon + model). Cached. */
export async function ocrAvailable() {
  if (process.env.DISABLE_OCR === "true") return false;
  available ??= await getEngine().then(
    () => true,
    err => {
      console.warn(`OCR unavailable: ${err.message}`);
      return false;
    },
  );
  return available;
}

export async function closeOcr() {
  if (!enginePromise) return;
  const engine = await enginePromise.catch(() => null);
  enginePromise = null;
  await engine?.close();
}

/**
 * Turn OCR lines (already in reading order) into text. A vertical gap larger
 * than ~1.5 line heights starts a new paragraph.
 */
function pageText(page) {
  const out = [];
  let prevBottom = null;
  for (const line of page.lines) {
    const text = line.text.trim();
    if (!text) continue;
    const ys = line.box.map(p => p.y);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    if (prevBottom !== null && top - prevBottom > 1.5 * (bottom - top)) out.push("");
    out.push(text);
    prevBottom = bottom;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** PNG and JPEG go straight in; other image types are converted to PNG. */
async function toSupportedImage(buffer) {
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  if (isPng || isJpeg) return buffer;
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  canvas.getContext("2d").drawImage(img, 0, 0);
  return canvas.toBuffer("image/png");
}

/** Text from an image (PNG, JPEG, WebP, BMP, TIFF). */
export async function ocrImage(buffer) {
  const image = new Uint8Array(await toSupportedImage(Buffer.from(buffer)));
  return withEngine(async engine => {
    const parts = [];
    for await (const page of engine.recognizeImages([image])) parts.push(pageText(page));
    return parts.join("\n\n").trim();
  });
}

/** OCR every page of a PDF (rendered by light-ocr's bundled PDFium). One string per page. */
export async function ocrPdf(body, { numPages } = {}) {
  const pages = await withEngine(async engine => {
    const out = [];
    for await (const page of engine.recognizePdf(new Uint8Array(body), {
      dpi: OCR_DPI,
      maxPages: MAX_OCR_PAGES,
      pageRange: { start: 1, end: Math.max(1, Math.min(numPages ?? MAX_OCR_PAGES, MAX_OCR_PAGES)) },
    })) {
      out.push(pageText(page));
    }
    return out;
  });
  return { pages, truncated: (numPages ?? 0) > MAX_OCR_PAGES };
}
