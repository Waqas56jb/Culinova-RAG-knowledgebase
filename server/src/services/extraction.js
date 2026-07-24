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
        `value you can actually see, following the schema. ${fileHint}` +
        `The model_number is usually the most prominent code near the product name or in the header.`,
    },
    ...pageImages.map((buf) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${buf.toString("base64")}`, detail: "high" },
    })),
  ];

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
async function extractFromPdf(pdfBuffer, docLabel, sourceFileName = "") {
  const { extractPages } = require("./pdf");
  const { renderPages } = require("./pdfImage");

  let pages = [];
  try { ({ pages } = await extractPages(pdfBuffer)); } catch { pages = []; }
  const textLen = String((pages || []).join(" ")).replace(/\s+/g, "").length;

  // Enough real text to trust the fast path? (dimension-only sheets fall well below this.)
  const THIN_TEXT = 400;
  if (textLen >= THIN_TEXT) {
    const fromText = await extractFromPages(pages, docLabel, sourceFileName);
    if (String(fromText?.model?.model_number || "").trim()) return fromText;
    // text was rich but the identity is missing — the model is probably in a graphic; let vision try
    try {
      const images = await renderPages(pdfBuffer);
      const fromVision = await extractFromImages(images, docLabel, sourceFileName);
      // keep the richer text attributes, but take the model identity vision could read
      return mergeExtractions(fromText, fromVision);
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

/** Prefer vision's identity, keep the union of attributes/notes. */
function mergeExtractions(base, extra) {
  const model = { ...(base.model || {}) };
  for (const k of ["brand", "model_number", "category", "equipment_type", "series", "power_type", "display_name", "description"]) {
    if (!String(model[k] || "").trim() && String(extra?.model?.[k] || "").trim()) model[k] = extra.model[k];
  }
  return {
    model,
    attributes: [...(base.attributes || []), ...(extra?.attributes || [])],
    notes: [...(base.notes || []), ...(extra?.notes || [])],
  };
}

/** One OpenAI call with the shared, honest error mapping. */
async function callOpenAI(messages) {
  try {
    return await getOpenAI().chat.completions.create({
      model: env.extractionModel,
      temperature: 0,
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
  const raw = resp.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  parsed.attributes = parsed.attributes || [];
  parsed.notes = parsed.notes || [];
  parsed.model = parsed.model || {};
  return parsed;
}

module.exports = { extractFromPages, extractFromImages, extractFromPdf };
