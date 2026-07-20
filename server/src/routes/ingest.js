const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const { supabase } = require("../config/supabase");
const { extractPages } = require("../services/pdf");
const { extractFromPages } = require("../services/extraction");
const { uploadPdf, uploadBuffer } = require("../services/storage");
const { ingestModelFiles } = require("../services/ingestModel");
const { extractMainImage } = require("../services/pdfImage");
const XLSX = require("xlsx");
const { importWorkbook, buildTemplateBuffer } = require("../services/excelImport");
const productCatalog = require("../services/productCatalogImport");
const { persistDraft } = require("../utils/draft");
const auth = require("../services/auth");
const dictSvc = require("../services/params");
const recs = require("../services/recommendations");
const categoryProfiles = require("../services/categoryProfiles");

/**
 * Client item 2 — "after EOS extracts the equipment information, it should automatically compare the
 * extracted values with the approved CULINOVA Engineering Rules". Policy-controlled by the
 * auto_apply_on_extract engine setting (Admin Portal). Best-effort: an engine problem must never
 * lose an upload — the engineer can always run it again from the Review screen.
 */
async function autoApplyRules(entryId, actor) {
  // Bind the equipment to its CULINOVA category standard on an EXACT type match — independent of the
  // rules-engine setting, best-effort so it can never fail an upload.
  try { await categoryProfiles.autoLink(entryId); } catch (e) { console.warn("[ingest] category auto-link failed:", e.message); }
  try {
    const dict = await dictSvc.load();
    if (!dictSvc.settingBool(dict, "auto_apply_on_extract", true)) return null;
    const { data: entry } = await supabase
      .from("ceks_knowledge_entries")
      .select("current_version_id")
      .eq("id", entryId)
      .maybeSingle();
    if (!entry?.current_version_id) return null;
    return await recs.generateForVersion(entry.current_version_id, { actor, trigger: "extraction" });
  } catch (e) {
    console.warn("[ingest] rules engine auto-apply failed:", e.message);
    return null;
  }
}

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

// Importing equipment writes to the knowledge base — it was open to the public internet until now.
const canIngest = auth.requirePermission("knowledge.ingest");
const canEdit = auth.requirePermission("knowledge.edit");

const DOC_LABELS = {
  datasheet: "Datasheet",
  installation_manual: "Installation Manual",
  maintenance_manual: "Maintenance Manual",
  other: "Document",
};

function mergeModel(results) {
  const keys = ["category", "equipment_type", "brand", "model_number", "display_name", "description"];
  const merged = {};
  for (const k of keys) {
    for (const r of results) {
      const v = r.result.model && r.result.model[k];
      if (v) { merged[k] = v; break; }
    }
  }
  return merged;
}

/**
 * POST /api/ingest/pdf
 * multipart: files[] (PDFs) + doc_types (JSON array aligned to files, optional)
 * One upload session = one equipment model (may include several documents).
 */
router.post("/pdf", canIngest, upload.array("files", 10), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: "No files uploaded." });

    let docTypes = [];
    try { docTypes = JSON.parse(req.body.doc_types || "[]"); } catch { docTypes = []; }

    const results = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const docType = docTypes[i] || "datasheet";
      const label = DOC_LABELS[docType] || "Document";

      // store the PDF in Supabase Storage so the reviewer can open the source page
      const fileId = crypto.randomUUID();
      const storageUrl = await uploadPdf(fileId, file.buffer);

      const { pages, numpages } = await extractPages(file.buffer);

      const doc = await supabase
        .from("ceks_import_documents")
        .insert({
          file_name: file.originalname,
          doc_type: docType,
          storage_url: storageUrl,
          page_count: numpages,
          status: "extracting",
        })
        .select()
        .single();
      if (doc.error) throw new Error(doc.error.message);

      const extracted = await extractFromPages(pages, label, file.originalname);
      await supabase.from("ceks_import_documents").update({ status: "extracted" }).eq("id", doc.data.id);

      results.push({ docId: doc.data.id, label, docType, buffer: file.buffer, result: extracted });
    }

    // merge attributes/notes across documents, tagging each with its source
    const attributes = [];
    const notes = [];
    for (const r of results) {
      for (const a of r.result.attributes) {
        attributes.push({ ...a, source_document: r.label, source_document_id: r.docId });
      }
      for (const n of r.result.notes) {
        notes.push({ ...n, source_document: r.label });
      }
    }

    const model = mergeModel(results);
    // carry the first document's real file name so, if the model number could not be extracted, the
    // fallback uses the uploaded file's own name instead of a fabricated one.
    model.source_file = req.files[0]?.originalname || null;
    const draft = await persistDraft({ model, attributes, notes, origin: "ai_pdf" });

    // link the uploaded documents to the entry (so they appear under Related Documents)
    await supabase.from("ceks_import_documents").update({ knowledge_entry_id: draft.entry_id }).in("id", results.map((r) => r.docId));

    // extract the product image from the datasheet PDF (fall back to the first PDF)
    try {
      const src = results.find((r) => r.docType === "datasheet") || results[0];
      if (src) {
        const extractedImg = await extractMainImage(src.buffer);
        if (extractedImg) {
          const url = await uploadBuffer(`images/${draft.model.id}.png`, extractedImg.buffer, "image/png");
          await supabase.from("ceks_models").update({ image_url: url }).eq("id", draft.model.id);
        }
      }
    } catch (e) { console.warn("[ingest/pdf] image extraction:", e.message); }

    const engine = await autoApplyRules(draft.entry_id, req.user);

    res.json({ ok: true, draft, engine, documents: results.map((r) => ({ id: r.docId, label: r.label })) });
  } catch (err) {
    console.error("[ingest/pdf]", err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || "PDF extraction failed." });
  }
});

/**
 * POST /api/ingest/folder
 * multipart: files[] (all files of one or more model folders) + paths (JSON array of
 * each file's relative path, aligned to files). Groups files by their model folder and
 * runs the full auto-organize pipeline per model.
 */
router.post("/folder", canIngest, upload.array("files", 400), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: "No files uploaded." });
    let paths = [];
    try { paths = JSON.parse(req.body.paths || "[]"); } catch { paths = []; }

    // group files by their model folder (parent directory of the relative path)
    const groups = {};
    req.files.forEach((f, i) => {
      const rel = (paths[i] || f.originalname).replace(/\\/g, "/");
      const dir = rel.split("/").slice(0, -1).join("/");
      (groups[dir] = groups[dir] || []).push({ name: f.originalname, buffer: f.buffer });
    });

    const models = [];
    for (const [dir, files] of Object.entries(groups)) {
      // skip folders with no PDF (e.g. stray image-only dirs)
      if (!files.some((f) => f.name.toLowerCase().endsWith(".pdf"))) continue;
      try {
        const r = await ingestModelFiles({ modelPath: dir, files, log: () => {} });
        await autoApplyRules(r.entry_id, req.user);
        models.push({ ok: true, entry_id: r.entry_id, title: r.title, counts: r.counts, versioned: r.versioned });
      } catch (e) {
        models.push({ ok: false, folder: dir, error: e.message, status: e.status || 500 });
      }
    }

    if (!models.length) {
      return res.status(422).json({ ok: false, error: "No model folders with PDFs were found in the upload.", models: [] });
    }
    const failed = models.filter((m) => !m.ok);
    if (failed.length === models.length) {
      const status = failed[0].status || 502;
      return res.status(status).json({
        ok: false,
        error: failed[0].error || "Folder extraction failed for every model.",
        models,
      });
    }

    res.json({ ok: true, models, failed: failed.length });
  } catch (err) {
    console.error("[ingest/folder]", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** GET /api/ingest/excel-template — download the standardized EOS import template (.xlsx) */
router.get("/excel-template", auth.authRequired, (req, res) => {
  try {
    const buf = buildTemplateBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="EOS-Equipment-Import-Template.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error("[ingest/excel-template]", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ingest/excel  (multipart: file) — Excel bulk import (one Draft per row).
 *
 * The user should not have to know which importer their file needs, so the format is DETECTED:
 *   • the EOS import template  → the template importer
 *   • any other product sheet  → the generic product-catalogue importer, which maps columns through
 *     the Parameter Dictionary + Disciplines and records utilities explicitly marked "N/A" so those
 *     sections are hidden for the item (a work table has no electrical/water/gas).
 * Uploading the same file through the UI and the CLI now produces IDENTICAL results — previously the
 * two paths disagreed on the brand column and created duplicate entries for the same products.
 */
router.post("/excel", canIngest, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No Excel file uploaded." });
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const headers = (XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, blankrows: false })[0] || [])
      .map((h) => String(h ?? "").trim().toLowerCase());

    // The EOS template is identified by its own signature columns; anything else is a generic sheet.
    const isEosTemplate = headers.includes("brand*") && headers.includes("equipment type*");

    if (isEosTemplate) {
      const r = await importWorkbook(req.file.buffer, { log: () => {} });
      for (const row of r.results || []) {
        if (row.ok && row.entry_id) await autoApplyRules(row.entry_id, req.user);
      }
      return res.json({ ok: true, format: "eos_template", ...r });
    }

    const r = await productCatalog.importWorkbook(wb, {
      source_file: req.file.originalname,
      actor: req.user,
    });
    res.json({
      ok: true,
      format: "product_catalogue",
      imported: r.imported,
      skipped: r.skipped,
      products: r.products,
      attributes: r.attributes,
      not_applicable: r.not_applicable_tally,
      errors: r.errors,
    });
  } catch (err) {
    console.error("[ingest/excel]", err);
    res.status(err.status || 500).json({ error: err.message || "Excel import failed." });
  }
});

/** POST /api/ingest/image/:entryId  (multipart: image) — manually set/replace the product image */
router.post("/image/:entryId", canEdit, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const { data: link } = await supabase
      .from("ceks_knowledge_links")
      .select("scope_id")
      .eq("knowledge_entry_id", req.params.entryId)
      .eq("scope_type", "model")
      .limit(1);
    if (!link || !link[0]) return res.status(404).json({ error: "Model not found." });
    const modelId = link[0].scope_id;
    const ext = (req.file.originalname.split(".").pop() || "png").toLowerCase();
    const url = await uploadBuffer(`images/${modelId}-${Date.now()}.${ext}`, req.file.buffer, req.file.mimetype || "image/png");
    await supabase.from("ceks_models").update({ image_url: url }).eq("id", modelId);
    res.json({ ok: true, image_url: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/ingest/manual  { model, attributes, notes } */
router.post("/manual", canIngest, express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const { model = {}, attributes = [], notes = [] } = req.body || {};
    // Manual entry is a human typing the profile — the model number (or at least a display name) must
    // be given. Refuse rather than accept a blank identity, so we never quietly create an
    // "UNIDENTIFIED" record from a manual form.
    const hasIdentity = String(model.model_number || "").trim() || String(model.display_name || "").trim();
    if (!hasIdentity) {
      return res.status(422).json({ error: "A model number (or a display name) is required for manual entry." });
    }
    const draft = await persistDraft({ model, attributes, notes, origin: "manual" });
    const engine = await autoApplyRules(draft.entry_id, req.user);
    res.json({ ok: true, draft, engine });
  } catch (err) {
    console.error("[ingest/manual]", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
