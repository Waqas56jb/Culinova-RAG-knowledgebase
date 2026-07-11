const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { supabase } = require("../config/supabase");
const { extractPages } = require("./pdf");
const { extractFromPages } = require("./extraction");
const { uploadBuffer } = require("./storage");
const { extractMainImage } = require("./pdfImage");
const { persistDraft } = require("../utils/draft");

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp"];
const CAD_EXT = ["dwg", "dxf", "step", "stp", "iges", "igs"];
const GENERIC_BRAND = ["PROJECT", "MODELS", "EQUIPMENT", "EQUIPMENTS"];

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", dwg: "application/acad", dxf: "image/vnd.dxf" };

/** Classify a file by name/extension into a document/asset type. */
function classify(filename) {
  const f = filename.toLowerCase();
  const ext = f.split(".").pop();
  if (IMAGE_EXT.includes(ext)) return { kind: "image", ext };
  if (CAD_EXT.includes(ext)) {
    const view = /top/.test(f) ? "Top View" : /front/.test(f) ? "Front View" : /side/.test(f) ? "Side View"
      : /iso/.test(f) ? "Isometric" : /mep|layout/.test(f) ? "MEP Layout"
      : /3d|step|stp|iges|igs/.test(f) ? "3D Model" : /2d/.test(f) ? "2D Drawing" : "CAD Drawing";
    return { kind: "cad", ext, doc_type: "cad", label: "CAD Drawing", view };
  }
  if (ext === "pdf") {
    if (f.includes("technical")) return { kind: "pdf", doc_type: "technical_data", label: "Technical Data", extract: true };
    if (f.includes("spare")) return { kind: "pdf", doc_type: "spare_parts", label: "Spare Parts Manual", extract: false };
    if (f.includes("install")) return { kind: "pdf", doc_type: "installation_manual", label: "Installation Manual", extract: true };
    if (f.includes("service")) return { kind: "pdf", doc_type: "service_manual", label: "Service Manual", extract: false };
    if (f.includes("user") || f.includes("manual")) return { kind: "pdf", doc_type: "user_manual", label: "User Manual", extract: false };
    if (f.includes("data sheet") || f.includes("datasheet") || f.includes("data-sheet"))
      return { kind: "pdf", doc_type: "datasheet", label: "Datasheet", extract: true };
    // any other PDF (often the datasheet named by model number) — extract it too
    return { kind: "pdf", doc_type: "datasheet", label: "Datasheet", extract: true };
  }
  return { kind: "other", ext };
}

function titleCase(s) {
  if (!s) return s;
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Derive Category / Brand / Model from the model folder path segments. */
function deriveIdentity(folderPath) {
  const norm = folderPath.replace(/\\/g, "/").replace(/\/+$/, "");
  let parts = norm.split("/").filter(Boolean);
  const idx = parts.findIndex((p) => p.toUpperCase() === "EQUIPMENTS");
  if (idx >= 0) parts = parts.slice(idx + 1);
  const model_number = parts[parts.length - 1];
  const category = parts.length >= 2 ? titleCase(parts[0]) : null;
  let brand = parts.length >= 3 ? parts[parts.length - 2] : null;
  if (brand && GENERIC_BRAND.includes(brand.toUpperCase())) brand = null; // ignore grouping folders
  return { category, brand, model_number };
}

function mergeAi(results) {
  const keys = ["category", "equipment_type", "brand", "series", "model_number", "power_type", "display_name", "description"];
  const m = {};
  for (const k of keys) for (const r of results) { const v = r.model && r.model[k]; if (v) { m[k] = v; break; } }
  return m;
}

/**
 * Ingest one equipment model folder end-to-end:
 * identity from folder, engineering data from AI, related documents + product image + CAD attached.
 */
/** Ingest one model from in-memory files. files = [{ name, buffer }]. modelPath = model folder path (for identity). */
async function ingestModelFiles({ modelPath, files, log = () => {} }) {
  const identity = deriveIdentity(modelPath);
  const items = files.map((f) => ({ file: f.name, buffer: f.buffer, ...classify(f.name) }));

  log(`Model: ${identity.category} › ${identity.brand || "?"} › ${identity.model_number}  (${files.length} files)`);

  // 1) extract engineering data from datasheet + technical data
  let extractSources = items.filter((x) => x.kind === "pdf" && x.extract);
  // fallback: if nothing was flagged for extraction but PDFs exist, extract the first PDF anyway
  if (!extractSources.length) {
    const anyPdf = items.find((x) => x.kind === "pdf");
    if (anyPdf) extractSources = [{ ...anyPdf, extract: true }];
  }
  const results = [];
  for (const c of extractSources) {
    const { pages, numpages } = await extractPages(c.buffer);
    const r = await extractFromPages(pages, c.label);
    results.push({ c, r, buf: c.buffer, numpages });
    log(`  extracted ${c.label}: ${r.attributes.length} fields (${numpages}p)`);
  }
  const ai = mergeAi(results.map((x) => x.r));

  // 2) upload the extract-source PDFs first, so attributes can reference them (click-to-source)
  const labelToDoc = {};
  const uploadedDocIds = [];
  for (const { c, buf, numpages } of results) {
    const url = await uploadBuffer(`pdfs/${crypto.randomUUID()}.pdf`, buf, "application/pdf");
    const doc = await supabase
      .from("ceks_import_documents")
      .insert({ file_name: c.file, doc_type: c.doc_type, storage_url: url, page_count: numpages, status: "extracted" })
      .select().single();
    if (doc.error) throw new Error("import_documents: " + doc.error.message);
    labelToDoc[c.label] = doc.data.id;
    uploadedDocIds.push(doc.data.id);
  }

  // 3) attributes + notes with source document reference
  const attributes = [];
  for (const { c, r } of results)
    for (const a of r.attributes) attributes.push({ ...a, source_document: c.label, source_document_id: labelToDoc[c.label] || null });
  const notes = [];
  for (const { c, r } of results)
    for (const n of r.notes) notes.push({ ...n, source_document: c.label });

  // 4) final model — folder identity is authoritative; AI fills the rest
  const model = {
    category: identity.category || ai.category,
    brand: identity.brand || ai.brand,
    model_number: identity.model_number || ai.model_number,
    equipment_type: ai.equipment_type,
    series: ai.series,
    power_type: ai.power_type,
    display_name: ai.display_name,
    description: ai.description,
  };

  const draft = await persistDraft({ model, attributes, notes, origin: "ai_pdf" });
  const entryId = draft.entry_id;
  const modelId = draft.model.id;

  // re-ingest: clear previously-attached documents/files so they don't accumulate.
  // (the source docs just uploaded in this run are not linked yet, so they survive)
  await supabase.from("ceks_import_documents").delete().eq("knowledge_entry_id", entryId);
  await supabase.from("ceks_file_assets").delete().eq("knowledge_entry_id", entryId);

  // link the extract-source docs to the entry
  if (uploadedDocIds.length)
    await supabase.from("ceks_import_documents").update({ knowledge_entry_id: entryId }).in("id", uploadedDocIds);

  // 5) attach the remaining PDFs (manuals, spare parts) as related documents
  for (const c of items.filter((x) => x.kind === "pdf" && !x.extract)) {
    const url = await uploadBuffer(`pdfs/${crypto.randomUUID()}.pdf`, c.buffer, "application/pdf");
    await supabase.from("ceks_import_documents").insert({
      knowledge_entry_id: entryId, file_name: c.file, doc_type: c.doc_type, storage_url: url, status: "uploaded",
    });
    log(`  attached ${c.label}`);
  }

  // 6) product image — prefer the image embedded in the datasheet PDF; fall back to a folder image
  let imageSet = false;
  const dsResult = results.find((x) => x.c.doc_type === "datasheet") || results[0];
  if (dsResult) {
    try {
      const extracted = await extractMainImage(dsResult.buf);
      if (extracted) {
        const url = await uploadBuffer(`images/${modelId}.png`, extracted.buffer, "image/png");
        await supabase.from("ceks_models").update({ image_url: url }).eq("id", modelId);
        imageSet = true;
        log(`  product image extracted from datasheet (${extracted.width}x${extracted.height})`);
      }
    } catch (e) { log(`  (pdf image extraction skipped: ${e.message})`); }
  }
  if (!imageSet) {
    const img = items.find((x) => x.kind === "image");
    if (img) {
      const url = await uploadBuffer(`images/${modelId}.${img.ext}`, img.buffer, MIME[img.ext] || "image/png");
      await supabase.from("ceks_models").update({ image_url: url }).eq("id", modelId);
      log(`  product image set (from folder)`);
    }
  }

  // 7) CAD drawings → file_assets
  for (const c of items.filter((x) => x.kind === "cad")) {
    const url = await uploadBuffer(`cad/${crypto.randomUUID()}.${c.ext}`, c.buffer, MIME[c.ext] || "application/octet-stream");
    await supabase.from("ceks_file_assets").insert({
      knowledge_entry_id: entryId, asset_type: "cad", file_name: c.file, storage_url: url,
      mime_type: MIME[c.ext] || null, category_tag: c.view || null,
    });
    log(`  attached CAD ${c.file} (${c.view})`);
  }

  return {
    entry_id: entryId,
    model_id: modelId,
    title: draft.title,
    identity: model,
    versioned: draft.versioned,
    counts: {
      attributes: attributes.length,
      documents: items.filter((x) => x.kind === "pdf").length,
      cad: items.filter((x) => x.kind === "cad").length,
      image: imageSet ? 1 : 0,
    },
  };
}

/** CLI/disk wrapper: read a model folder from disk and ingest it. */
async function ingestModelFolder(folderPath, opts = {}) {
  const names = fs.readdirSync(folderPath).filter((f) => fs.statSync(path.join(folderPath, f)).isFile());
  const files = names.map((name) => ({ name, buffer: fs.readFileSync(path.join(folderPath, name)) }));
  return ingestModelFiles({ modelPath: folderPath, files, ...opts });
}

module.exports = { ingestModelFiles, ingestModelFolder, classify, deriveIdentity };
