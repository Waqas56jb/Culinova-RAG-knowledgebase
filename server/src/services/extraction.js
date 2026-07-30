const { env } = require("../config/env");
const { getOpenAI } = require("../config/openai");
const { buildTaggedText } = require("./pdf");

const EXTRACTION_SCHEMA = {
  name: "engineering_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      model: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: ["string", "null"], description: "e.g. Cooking Equipment, Refrigeration, HVAC" },
          equipment_type: { type: ["string", "null"], description: "e.g. Convection Oven, Chiller" },
          brand: { type: ["string", "null"], description: "Manufacturer, e.g. UNOX, Carrier" },
          series: { type: ["string", "null"], description: "Product series / line, e.g. BAKERLUX SHOP.Pro GO" },
          model_number: { type: ["string", "null"], description: "Manufacturer model number, e.g. XEFR-10EU-EGRN" },
          power_type: {
            type: ["string", "null"],
            enum: ["Electric", "Gas", "Neutral", null],
            description: "Power type of the equipment: Electric, Gas, or Neutral (non-powered).",
          },
          display_name: { type: ["string", "null"], description: "Friendly product name" },
          description: { type: ["string", "null"], description: "Short one-line description of the product" },
        },
        required: ["category", "equipment_type", "brand", "series", "model_number", "power_type", "display_name", "description"],
      },
      attributes: {
        type: "array",
        description: "Every structured engineering value found.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            attr_group: {
              type: "string",
              enum: [
                "technical_specification",
                "electrical",
                "water_drain",
                "gas",
                "ventilation",
                "dimensions_clearance",
                "connection_point",
                "installation",
                "other",
              ],
            },
            name: { type: "string" },
            value: { type: ["string", "null"] },
            unit: { type: ["string", "null"] },
            source_page: { type: ["integer", "null"], description: "Page number where found" },
            confidence: { type: ["number", "null"], description: "0.0 - 1.0" },
          },
          required: ["attr_group", "name", "value", "unit", "source_page", "confidence"],
        },
      },
      notes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            note_type: { type: ["string", "null"] },
            content: { type: "string" },
            source_page: { type: ["integer", "null"] },
            confidence: { type: ["number", "null"] },
          },
          required: ["note_type", "content", "source_page", "confidence"],
        },
      },
    },
    required: ["model", "attributes", "notes"],
  },
};

const SYSTEM_PROMPT =
  "You are an engineering knowledge extraction assistant for CULINOVA EOS, an engineering decision-support system. " +
  "You read manufacturer datasheets and technical documents and extract STRUCTURED engineering data for MEP engineers.\n" +
  "Rules:\n" +
  "- Only extract information actually present in the text. Do not invent values.\n" +
  "- For every attribute, set source_page to the page number where you found it, and confidence 0-1.\n" +
  "- Use clean, human-readable field names in Title Case. Put the numeric value in `value` and unit in `unit`.\n" +
  "- Identify the equipment IDENTITY: brand, category, equipment_type, series/line, model_number, power_type " +
  "(Electric, Gas, or Neutral).\n" +
  "- BRAND is the MANUFACTURER / maker of the equipment (e.g. FAGOR, MBM, UNOX, NOVA COOL, BARTSCHER, " +
  "RATIONAL, HOSHIZAKI). It is one of the MOST IMPORTANT fields. It usually appears as a company LOGO or " +
  "name in the page header, footer, title block or watermark, in the document metadata, on the web/contact " +
  "line (e.g. www.fagor.com → FAGOR), or as a prefix inside the model number. Work it out and report it. " +
  "Report the manufacturer, NOT the product line or series (the line goes in `series`, e.g. brand MBM / " +
  "series Magistra). Only set brand to null if NO manufacturer name, logo, website or code is present " +
  "ANYWHERE on the sheet — never leave it null when the maker is identifiable.\n" +
  "\nAssign each attribute to the correct engineering SECTION (attr_group). Extract EVERY relevant value present, " +
  "including connection TYPE, DIAMETER/SIZE, and HEIGHT FROM FINISHED FLOOR wherever the datasheet gives them:\n" +
  "- technical_specification: capacity, output, performance, materials, operating temperature, general specs.\n" +
  "- electrical: Voltage, Phase, Frequency, Connected Load / Total Power, Full Load Current, Recommended Breaker, " +
  "Recommended Cable Size, Plug / Socket Type, Socket Rating, Isolator Switch Type, Isolator Rating, " +
  "Installation Height from Finished Floor, RCD Requirement, Cable Entry Location (Bottom/Rear/Top), " +
  "Electrical Connection Position.\n" +
  "- water_drain: Cold Water Connection Type, Cold Water Diameter, Cold Water Height from Finished Floor, " +
  "Hot Water Connection Type, Hot Water Diameter, Hot Water Height from Finished Floor, Drain Connection Type, " +
  "Drain Diameter, Drain Height from Finished Floor, Drain Method (Gravity or Pumped), Water Pressure, Flow Rate, " +
  "Water Quality.\n" +
  "- gas: Gas Type (Natural Gas / LPG), Gas Connection Diameter, Gas Connection Height from Finished Floor, " +
  "Required Gas Pressure, Gas Consumption, Regulator, Shut-off Valve.\n" +
  "- ventilation: Hood Required, Exhaust Airflow (CFM or m3/h), Fresh Air Requirement, Heat Rejection, Steam Extraction.\n" +
  "- dimensions_clearance: Overall Dimensions (Width/Depth/Height), Weight, Front Service Clearance, Rear Clearance, " +
  "Left Clearance, Right Clearance, Top Clearance, Floor Fixing Requirements, Service Access Area.\n" +
  "- connection_point: for EACH utility connection (electrical, cold water, hot water, drain, gas, exhaust) give its " +
  "position/location on the unit, with Height from Finished Floor, Size/Diameter, and Connection Type when stated.\n" +
  "- installation: Indoor/Outdoor use, Floor Requirements, Mounting Requirements, Floor Fixing, installation constraints.\n" +
  "- other: anything that does not fit above.\n" +
  "\nIn `notes`, capture engineering NOTES: design recommendations, operational recommendations, and limitations.\n" +
  "If a field is unknown, use null (do not guess). Prefer concise, clean names and values.";

/**
 * Extract structured engineering knowledge from PDF pages.
 * @param {string[]} pages  per-page text
 * @param {string} docLabel friendly document label e.g. "Datasheet"
 * @returns {Promise<{model, attributes, notes}>}
 */
async function extractFromPages(pages, docLabel, sourceFileName = "") {
  const tagged = buildTaggedText(pages);
  if (!String(tagged || "").replace(/=== PAGE \d+ ===/g, "").trim()) {
    throw Object.assign(
      new Error("This PDF has no extractable text (it may be a scanned image). OCR is not enabled — use a text datasheet, Excel import, or manual entry."),
      { status: 422 },
    );
  }
  // The file name is a strong, legitimate signal — manufacturers routinely name a datasheet after the
  // model (e.g. "PL30.pdf"). We give it to the model as a HINT, not an instruction: it may only be
  // used when the document text supports it, and must never override a model number the text states.
  const fileHint = sourceFileName
    ? `Source file name: "${sourceFileName}". Manufacturers often name the file after the model number, ` +
      `so this is a useful hint for model_number — but use it only if the document text is consistent ` +
      `with it, and never in place of a model number actually printed in the document.\n\n`
    : "";
  const userContent =
    `Document type: ${docLabel}\n` +
    fileHint +
    `Extract all engineering knowledge from the following page-tagged text.\n\n` +
    tagged;

  const resp = await callOpenAI([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ]);
  return parseExtraction(resp);
}

/**
 * VISION extraction — read the datasheet as a PERSON would, from the rendered page images.
 *
 * Text extraction fails on drawings and scanned sheets (the model number is drawn, not typed). When
 * that happens we rasterise the pages and hand the images to the same vision-capable model with the
 * same schema. This is the "use your eyes" path that recovers a model like "PL30" printed only in a
 * graphic header.
 *
 * @param {Buffer[]} pageImages  PNG buffers, one per page
 */
async function extractFromImages(pageImages, docLabel, sourceFileName = "") {
  if (!pageImages || !pageImages.length) {
    throw Object.assign(new Error("No page images to read."), { status: 422 });
  }
  // Read EVERY page. High-detail images are large, so a long scanned sheet is read in page batches and
  // the results merged — no page is ever left unseen (a single call used to silently ignore later pages).
  const BATCH = 4;
  if (pageImages.length <= BATCH) return extractImageBatch(pageImages, 0, docLabel, sourceFileName);
  let acc = { model: {}, attributes: [], notes: [] };
  for (let i = 0; i < pageImages.length; i += BATCH) {
    const part = await extractImageBatch(pageImages.slice(i, i + BATCH), i, docLabel, sourceFileName);
    acc = mergeExtractions(acc, part, { preferVisionIdentity: !String(acc.model.model_number || "").trim() });
  }
  return acc;
}

async function extractImageBatch(pageImages, pageOffset, docLabel, sourceFileName) {
  const fileHint = sourceFileName
    ? `The source file is named "${sourceFileName}". Manufacturers often name a file after the model, ` +
      `but rely on what you can READ in the image; never contradict the printed text.\n`
    : "";
  const content = [
    {
      type: "text",
      text:
        `Document type: ${docLabel}. This document has little or no machine-readable text — it is a ` +
        `technical drawing or scanned datasheet. READ THE IMAGES like an engineer: the brand, model ` +
        `number and specifications are printed in headers, title blocks and callouts. Extract every ` +
        `value you can actually see, following the schema. Set source_page to the page number labelled ` +
        `before each image. ${fileHint}` +
        `The model_number is usually the most prominent code near the product name or in the header. ` +
        `The BRAND / manufacturer is usually a company LOGO or name at the very TOP or BOTTOM of the page ` +
        `(and often a website like www.fagor.com). READ THE LOGO and report the manufacturer as brand — ` +
        `never leave brand null if any manufacturer logo, name or website is visible.`,
    },
  ];
  // Label each image with its real page number so source_page is authoritative (vision cannot otherwise
  // know page numbers, so click-to-source used to land on the wrong page).
  pageImages.forEach((buf, idx) => {
    content.push({ type: "text", text: `Page ${pageOffset + idx + 1}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${buf.toString("base64")}`, detail: "high" } });
  });

  const resp = await callOpenAI([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content },
  ]);
  return parseExtraction(resp);
}

/**
 * Read a PDF end to end, choosing the right tool automatically.
 *
 * Text first (fast, cheap). When the page text is too thin to be a real datasheet, OR the text pass
 * could not find a model number, escalate to VISION on the rendered pages — so a drawing-only sheet
 * is read by its images instead of silently producing a blank identity. Never fabricates: if nothing
 * can be read, it returns whatever was found (possibly an empty model) for the reviewer to complete.
 *
 * @param {Buffer} pdfBuffer  the raw PDF
 */
// A file-name stem, normalized for comparison ("PL30_datasheet.pdf" -> "pl30datasheet").
const fileStem = (name) => String(name || "").split(/[\\/]/).pop().replace(/\.[^.]+$/, "").trim();
const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Is `s` plausibly a real model number, not a certification code / barcode / URL / the word
 * "Datasheet"? A wrong-but-non-empty model must NEVER be accepted as the identity — when this returns
 * false we escalate to vision instead of trusting the text pass.
 */
function looksLikeModel(s) {
  const v = String(s || "").trim();
  if (!v || v.length < 2) return false;
  if (/^\d{8,14}$/.test(v)) return false;                                  // EAN / barcode / long pure number
  if (/https?:\/\/|www\.|@/.test(v)) return false;                          // URL / email
  if (/^\+?[\d\s()\-]{7,}$/.test(v)) return false;                          // phone number
  if (/^(datasheet|specification|spec\s*sheet|technical\s*data|manual|catalogue|catalog|product|model)$/i.test(v)) return false;
  if (/^(iec|en|ce|ul|nsf|iso|din|ip)\s?\d/i.test(v)) return false;         // bare certification / rating code
  return true;
}

async function extractFromPdf(pdfBuffer, docLabel, sourceFileName = "") {
  const { extractPages } = require("./pdf");
  const { renderPages } = require("./pdfImage");

  let pages = [];
  try { ({ pages } = await extractPages(pdfBuffer)); } catch { pages = []; }
  const perPage = (pages || []).map((p) => String(p || "").replace(/\s+/g, "").length);
  const textLen = perPage.reduce((s, n) => s + n, 0);
  const pageCount = perPage.length || 1;

  // Enough real text to trust the fast path? (dimension-only sheets fall well below this.)
  const THIN_TEXT = 400;
  // A HYBRID sheet mixes rich text pages with near-empty image/scan pages — those image pages carry
  // specs the text pass can never see, so it must ALSO be read with vision (client cannot lose specs).
  const looksHybrid = pageCount > 1 && perPage.some((n) => n >= 200) && perPage.some((n) => n < 60);

  if (textLen >= THIN_TEXT) {
    const fromText = await extractFromPages(pages, docLabel, sourceFileName);
    const modelNo = String(fromText?.model?.model_number || "").trim();
    const modelPlausible = looksLikeModel(modelNo);                                   // not an EAN/URL/cert/"Datasheet"
    const modelFromFilename = !!modelNo && normKey(modelNo) === normKey(fileStem(sourceFileName));
    // Gray zone: barely over the text threshold with implausibly few attributes for the page count.
    const thinExtraction = textLen < 1500 && (fromText?.attributes?.length || 0) < Math.max(4, pageCount * 3);

    // The BRAND is very often only a LOGO in the header/footer — an image the text pass literally cannot
    // read — so the fast path returns a perfectly good datasheet with brand "Unknown". Treat a missing
    // brand exactly like a missing model: send the sheet to VISION so the logo is read. (Vision only
    // FILLS the brand gap here — the plausible text model_number is kept, see distrustTextIdentity.)
    const brandText = String(fromText?.model?.brand || "").trim();
    const brandFound = brandText && !/^(unknown|n\/?a|manufacturer|brand|not\s+specified|none|tbd|-+)$/i.test(brandText);

    // Trust the fast path only for a RICH sheet with a plausible printed model AND a real brand. A thin
    // sheet, an implausible model, a missing brand, or a hybrid (image spec-pages) all get vision.
    if (modelPlausible && brandFound && !looksHybrid && !thinExtraction) return fromText;
    try {
      const images = await renderPages(pdfBuffer);
      const fromVision = await extractFromImages(images, docLabel, sourceFileName);
      // Let vision OWN the identity only when the text identity is untrustworthy — implausible, or it
      // merely echoes the file name on a thin sheet (so it likely came from the file name, not the page).
      // For a plausible text model on a hybrid sheet, keep it and just gain vision's extra attributes.
      const distrustTextIdentity = !modelPlausible || (modelFromFilename && thinExtraction);
      return mergeExtractions(fromText, fromVision, { preferVisionIdentity: distrustTextIdentity });
    } catch (e) {
      console.warn(`[extraction] vision escalation skipped: ${e.message}`);
      return fromText;
    }
  }

  // Thin or no text — this is a drawing/scan. Read it with vision.
  console.log(`[extraction] thin text (${textLen} chars) — reading "${sourceFileName || "document"}" with vision`);
  const images = await renderPages(pdfBuffer);
  return extractFromImages(images, docLabel, sourceFileName);
}

/**
 * Merge two extractions, keeping the UNION of attributes/notes.
 * `preferVisionIdentity` (default true): for a graphic/scan sheet vision is the ground truth, so its
 * identity fields overwrite the base; when false (the text identity was already trustworthy) vision
 * only fills gaps. This makes the code match its long-stated intent — vision is not a mere gap-filler.
 */
// Drop duplicate rows the text + vision passes both produced (same group + name + value + unit), keeping
// the higher-confidence copy — otherwise a hybrid sheet showed every spec twice, and identical raw
// strings could even make the rules engine flag a non-existent "ambiguous" conflict.
function dedupeAttrs(list) {
  const seen = new Map();
  for (const a of list || []) {
    const key = `${normKey(a.attr_group)}|${normKey(a.name)}|${normKey(a.value)}|${normKey(a.unit)}`;
    const prev = seen.get(key);
    if (!prev || (a.confidence ?? 1) > (prev.confidence ?? 1)) seen.set(key, a);
  }
  return [...seen.values()];
}
function dedupeNotes(list) {
  const seen = new Map();
  for (const n of list || []) { const k = normKey(n.content); if (k && !seen.has(k)) seen.set(k, n); }
  return [...seen.values()];
}

function mergeExtractions(base, extra, { preferVisionIdentity = true } = {}) {
  const model = { ...(base.model || {}) };
  for (const k of ["brand", "model_number", "category", "equipment_type", "series", "power_type", "display_name", "description"]) {
    const bv = String(model[k] || "").trim();
    const ev = String(extra?.model?.[k] || "").trim();
    if (ev && (preferVisionIdentity || !bv)) model[k] = extra.model[k];
  }
  return {
    model,
    attributes: dedupeAttrs([...(base.attributes || []), ...(extra?.attributes || [])]),
    notes: dedupeNotes([...(base.notes || []), ...(extra?.notes || [])]),
  };
}

/** One OpenAI call with the shared, honest error mapping. */
async function callOpenAI(messages) {
  try {
    return await getOpenAI().chat.completions.create({
      model: env.extractionModel,
      temperature: 0,
      // Give a dense datasheet enough room to return every attribute. Without this the response can hit
      // the model's default output ceiling, get cut mid-JSON, and fail the whole extraction.
      max_tokens: 16000,
      response_format: { type: "json_schema", json_schema: EXTRACTION_SCHEMA },
      messages,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const status = err?.status || err?.statusCode;
    const code = err?.code || err?.error?.code;
    // ALWAYS log the original error — masking a rate-limit as a billing problem once cost real time.
    console.error(`[extraction] OpenAI call failed — status=${status} code=${code} model=${env.extractionModel}: ${msg}`);
    if (code === "insufficient_quota" || /insufficient_quota|billing|exceeded your current quota/i.test(msg)) {
      throw Object.assign(
        new Error("OpenAI quota exceeded. AI PDF/folder extraction needs billing credits on the OpenAI account. Excel bulk and manual entry still work without AI."),
        { status: 402 },
      );
    }
    if (status === 429) {
      throw Object.assign(
        new Error("OpenAI is rate-limiting this account right now. Wait a moment and retry — this is temporary, not a billing problem."),
        { status: 429 },
      );
    }
    if (status === 401 || /incorrect api key|invalid api key/i.test(msg)) {
      throw Object.assign(new Error("OpenAI API key is invalid. Check OPENAI_API_KEY in server/.env."), { status: 503 });
    }
    throw Object.assign(new Error(msg), { status: status && status < 500 ? status : 502 });
  }
}

function parseExtraction(resp) {
  const choice = resp.choices?.[0];
  const msg = choice?.message;
  // A refusal returns content:null with a refusal string — never silently treat it as an empty draft.
  if (msg?.refusal) {
    throw Object.assign(new Error(`The AI declined to extract this document: ${msg.refusal}`), { status: 422 });
  }
  // A truncated response ("length") is cut mid-JSON — fail loudly instead of crashing on JSON.parse.
  if (choice?.finish_reason === "length") {
    throw Object.assign(
      new Error("The datasheet produced more data than one pass allows (the response was truncated). Split the PDF into fewer pages and retry."),
      { status: 502 },
    );
  }
  const raw = msg?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`Extraction returned malformed JSON and could not be read (${e.message}).`), { status: 502 });
  }
  parsed.attributes = parsed.attributes || [];
  parsed.notes = parsed.notes || [];
  parsed.model = parsed.model || {};
  return parsed;
}

module.exports = { extractFromPages, extractFromImages, extractFromPdf };
