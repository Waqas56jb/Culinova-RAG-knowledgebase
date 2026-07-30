const { PNG } = require("pngjs");

// pdfjs legacy build works in Node (no DOM/worker needed)
let pdfjsLib;
function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
    try { pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.js"); } catch {}
  }
  return pdfjsLib;
}

function toPngBuffer(img) {
  const { width, height, kind, data } = img;
  const png = new PNG({ width, height });
  const out = png.data; // RGBA
  if (kind === 3 /* RGBA_32BPP */) {
    out.set(data.subarray(0, out.length));
  } else if (kind === 2 /* RGB_24BPP */) {
    for (let i = 0, j = 0; i < width * height; i++) {
      out[j++] = data[i * 3]; out[j++] = data[i * 3 + 1]; out[j++] = data[i * 3 + 2]; out[j++] = 255;
    }
  } else if (kind === 1 /* GRAYSCALE_1BPP */) {
    // 1 bit per pixel, packed
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const j = (y * width + x) * 4;
        out[j] = out[j + 1] = out[j + 2] = v; out[j + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return PNG.sync.write(png);
}

// PHOTO-LIKENESS (0..1). A product PHOTO is a continuous-tone image with many distinct tones/colours; a
// dimension DRAWING, a logo or scanned text is 1-bit or near-monochrome with only a handful. Sampling the
// already-decoded pixels lets a real photo beat a LARGER line-art diagram on the same page — the exact
// failure where a big dimension drawing was chosen instead of the product shot.
function photoScore(img) {
  const { kind, data, width, height } = img;
  if (kind === 1) return 0.1;                          // 1-bit = line art / scanned text — not a photo
  const bpp = kind === 3 ? 4 : 3;                      // RGBA / RGB
  const step = Math.max(1, Math.floor((width * height) / 4000)) * bpp; // ~4000 samples, cheap
  const hist = new Array(32).fill(0);                  // luminance histogram (works for colour AND grayscale)
  let chroma = 0, n = 0;
  for (let o = 0; o + 2 < data.length; o += step) {
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = (r * 299 + g * 587 + b * 114) / 1000;  // 0..255
    hist[Math.min(31, lum >> 3)]++;                    // 32 tone buckets
    chroma += Math.abs(r - g) + Math.abs(g - b) + Math.abs(r - b);
    n++;
  }
  if (!n) return 0.3;
  // A PHOTO fills many tone buckets with real population (smooth gradients); a line DIAGRAM is just
  // white + black (2 dominant buckets). Count buckets holding >0.5% of the pixels — robust for grayscale
  // product shots (which a naive colour-count wrongly scored as flat).
  const populated = hist.filter((c) => c > n * 0.005).length;
  const tones = Math.min(1, populated / 12);           // photo: 12+ tones; a line diagram: 2-3
  const colourfulness = Math.min(1, (chroma / (n * 3 * 255)) * 4);
  return Math.max(tones, colourfulness);
}

/**
 * Extract embedded raster images from a PDF and return the "best" product image
 * as a PNG buffer (largest area, above a minimum size, from the earliest pages).
 * Returns { buffer, width, height } or null.
 */
// maxPages defaults to 2: the product photo sits on page 1–2 of a datasheet. Later pages are skipped —
// decoding their many technical diagrams added 15 s+ per page for no benefit. The score divides by the
// page number, so a page-1 photo is strongly preferred, but a genuine photo on page 2 can still beat a
// page-1 logo/diagram. Photo-likeness (below) is what stops a big line-art drawing from being chosen.
async function extractMainImage(pdfBuffer, { maxPages = 2, minDim = 110 } = {}) {
  const pdfjs = getPdfjs();
  const OPS = pdfjs.OPS;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), disableFontFace: true, isEvalSupported: false }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  let best = null; // { img, w, h, score } — the RAW image; PNG-encoded only ONCE, at the very end

  // Weigh a candidate raster: the largest, roughly-square, PHOTO-like image on the earliest page.
  // Extreme aspect ratios (banners/rules) and tiny images (logos/icons) are skipped outright.
  const consider = (img, p) => {
    if (!img || !img.width || !img.height || !img.data) return;
    const w = img.width, h = img.height;
    if (w < minDim || h < minDim) return;            // logos / icons
    if (w > 6000 || h > 6000) return;                // huge scans → the page-render fallback covers these
    const ar = w / h;
    if (ar > 3.5 || ar < 1 / 3.5) return;            // banner / rule, not a product shot
    const shape = 1 - Math.min(0.6, Math.abs(Math.log(ar)) * 0.35); // prefer square-ish over stretched
    const photo = photoScore(img);                    // real photo beats a line-art diagram of similar size
    const score = (w * h * shape * (0.3 + 0.7 * photo)) / p;
    // Only TRACK the winner here — encoding every transient "best" to PNG re-serialised megapixel bitmaps
    // over and over and made image extraction take 40 s+ on image-heavy datasheets.
    if (!best || score > best.score) best = { img, w, h, score };
  };

  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    const names = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageXObjectRepeat) {
        const arg = ops.argsArray[i][0];
        if (typeof arg === "string") names.push(arg);
      } else if (fn === OPS.paintInlineImageXObject) {
        // an INLINE image carries its bitmap right in the op args (no objs.get) — many datasheets draw
        // the product photo this way, so missing it forced the ugly page-render fallback.
        consider(ops.argsArray[i][0], p);
      }
    }
    for (const name of names) {
      // page.objs.get fires its callback when the object resolves; if it never resolves the promise
      // would hang forever (and never reject) — race it against a timeout so we skip and move on.
      const img = await Promise.race([
        new Promise((resolve) => { try { page.objs.get(name, resolve); } catch { resolve(null); } }),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]).catch(() => null);
      consider(img, p);
    }
    page.cleanup();
    // Do NOT stop at the first page: a page-1 header logo must not mask the real product photo that
    // lives on a later page — evaluate every candidate page and keep the best-scoring one.
  }
  await doc.cleanup();
  if (!best) return null;
  const buffer = toPngBuffer(best.img); // encode the winner exactly once
  return buffer ? { buffer, width: best.w, height: best.h } : null;
}

/**
 * Render whole PDF pages to PNG images.
 *
 * This is what lets EOS read a datasheet the way a person does. Many manufacturer datasheets are
 * technical drawings or scanned sheets: the model number and specs are drawn as vector graphics or
 * outlined fonts, so NO text layer exists to parse (the CULINOVA "Pelapatate PL30" sheet extracts
 * zero text yet clearly prints the model in its header). Rasterising the page and handing the image
 * to a vision model recovers exactly what the eye sees.
 *
 * @returns {Promise<Buffer[]>} one PNG buffer per rendered page
 */
async function renderPages(pdfBuffer, { maxPages = 12, scale = 2.5, maxDim = 3000 } = {}) {
  const pdfjs = getPdfjs();
  // @napi-rs/canvas is a prebuilt native canvas — no build step, works headless in Node.
  const { createCanvas } = require("@napi-rs/canvas");

  // pdfjs creates intermediate canvases internally (image masks, patterns). By default in Node it
  // `require('canvas')` (node-canvas, which needs a native build). Supplying our own factory backed
  // by @napi-rs/canvas removes that dependency entirely.
  class NapiCanvasFactory {
    create(width, height) {
      const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
      return { canvas, context: canvas.getContext("2d") };
    }
    reset(cc, width, height) {
      cc.canvas.width = Math.max(1, width);
      cc.canvas.height = Math.max(1, height);
    }
    destroy(cc) {
      if (cc.canvas) { cc.canvas.width = 0; cc.canvas.height = 0; }
      cc.canvas = null;
      cc.context = null;
    }
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableFontFace: true,
    isEvalSupported: false,
    canvasFactory: new NapiCanvasFactory(),
  }).promise;
  const count = Math.min(doc.numPages, maxPages);
  const out = [];

  for (let p = 1; p <= count; p++) {
    const page = await doc.getPage(p);
    let vp = page.getViewport({ scale });
    // keep the largest side within maxDim so the payload stays reasonable for the vision model
    const longest = Math.max(vp.width, vp.height);
    if (longest > maxDim) vp = page.getViewport({ scale: (scale * maxDim) / longest });

    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(canvas.toBuffer("image/png"));
    page.cleanup();
  }
  await doc.cleanup();
  return out;
}

module.exports = { extractMainImage, renderPages, photoScore };
