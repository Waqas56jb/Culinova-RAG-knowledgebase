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

/**
 * Extract embedded raster images from a PDF and return the "best" product image
 * as a PNG buffer (largest area, above a minimum size, from the earliest pages).
 * Returns { buffer, width, height } or null.
 */
async function extractMainImage(pdfBuffer, { maxPages = 3, minDim = 120 } = {}) {
  const pdfjs = getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), disableFontFace: true, isEvalSupported: false }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  let best = null;

  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    const OPS = pdfjs.OPS;
    const names = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageXObjectRepeat) {
        const arg = ops.argsArray[i][0];
        if (typeof arg === "string") names.push(arg);
      }
    }
    for (const name of names) {
      const img = await new Promise((resolve) => {
        try { page.objs.get(name, resolve); } catch { resolve(null); }
      }).catch(() => null);
      if (!img || !img.width || !img.height || !img.data) continue;
      if (img.width < minDim || img.height < minDim) continue; // skip logos/icons
      const area = img.width * img.height;
      // prefer larger, and earlier pages (slight bias)
      const score = area / p;
      if (!best || score > best.score) {
        const buffer = toPngBuffer(img);
        if (buffer) best = { buffer, width: img.width, height: img.height, score };
      }
    }
    page.cleanup();
    if (best && p >= 1) break; // first page with a good image usually holds the product photo
  }
  await doc.cleanup();
  return best ? { buffer: best.buffer, width: best.width, height: best.height } : null;
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
async function renderPages(pdfBuffer, { maxPages = 4, scale = 2.0, maxDim = 2200 } = {}) {
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

module.exports = { extractMainImage, renderPages };
