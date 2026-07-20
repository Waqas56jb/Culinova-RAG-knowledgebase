/**
 * BATCHED IMPORT JOBS — a large upload that can never time out, with live progress.
 *
 *   POST /api/import-jobs/prepare        (multipart file)  → parse once, park the rows, return a preview + ETA
 *   POST /api/import-jobs/:id/batch      { size }          → process the next slice, return progress
 *   GET  /api/import-jobs/:id                              → current status (for the progress bar)
 *   GET  /api/import-jobs/:id/preview                      → what was actually created, to eyeball it
 *   POST /api/import-jobs/:id/cancel                       → stop a run
 *
 * Nothing long-running happens inside a single request, so a 1,000-row catalogue is as safe as a
 * 10-row one. The ETA is MEASURED from the batches already done — never a made-up number.
 */
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const { supabase } = require("../config/supabase");
const { env } = require("../config/env");
const auth = require("../services/auth");
const productCatalog = require("../services/productCatalogImport");
const { bulkCreateProducts } = require("../services/bulkCreate");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.uploadMaxFileMb * 1024 * 1024, files: 1 } });

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[import-jobs]", e.stack || e.message);
    res.status(status).json({ error: status >= 500 ? "Something went wrong." : e.message });
  });
const bad = (m, s = 422) => Object.assign(new Error(m), { status: s });

router.use(express.json({ limit: "1mb" }));
router.use(auth.authRequired);
const canIngest = auth.requirePermission("knowledge.ingest");

/** Rows are parked in the job, so each batch call is stateless and can run on any instance. */
router.post("/prepare", canIngest, upload.single("file"), wrap(async (req, res) => {
  if (!req.file) throw bad("Attach an .xlsx file.");
  const wb = XLSX.read(req.file.buffer, { type: "buffer" });
  const sheetName = req.body.sheet || wb.SheetNames[0];

  const { headers, rows } = productCatalog.readSheet(wb, sheetName);
  const planContext = await productCatalog.loadPlanContext();
  const plan = await productCatalog.planColumns(headers, planContext);

  // turn every row into a product payload ONCE, so batches are pure inserts
  const products = rows.map((r) => productCatalog.rowToProduct(r, plan));
  const usable = products.filter((p) => p.id.code || p.id.name);

  const naTally = {};
  for (const p of products) for (const d of p.notApplicable || []) naTally[d] = (naTally[d] || 0) + 1;

  const { data: job, error } = await supabase
    .from("ceks_import_jobs")
    .insert({
      kind: "product_catalogue",
      source_file: req.file.originalname,
      sheet: sheetName,
      format: "product_catalogue",
      status: "pending",
      total: usable.length,
      rows: products,
      plan: plan.map((c) => ({ header: c.header, kind: c.kind, discipline: c.discipline || null, identity: c.identity || null })),
      summary: { not_applicable: naTally, columns: plan.length, skipped_rows: products.length - usable.length },
      created_by: req.user.id,
    })
    .select("id, total, source_file, sheet, summary, plan")
    .single();
  if (error) throw new Error(error.message);

  res.json({
    job_id: job.id,
    total: job.total,
    source_file: job.source_file,
    sheet: job.sheet,
    columns: plan.length,
    identity_columns: plan.filter((c) => c.kind === "identity").map((c) => `${c.header} → ${c.identity}`),
    mapped_to_discipline: plan.filter((c) => c.kind === "attribute" && c.discipline).map((c) => `${c.header} → ${c.discipline}`),
    not_applicable: job.summary?.not_applicable || {},
    skipped_rows: job.summary?.skipped_rows || 0,
    // a first look at the real parsed data before anything is written
    preview: usable.slice(0, 5).map((p) => ({
      code: p.id.code, name: p.id.name, category: p.id.category, type: p.id.type,
      attributes: p.attributes.length, not_applicable: p.notApplicable,
    })),
    recommended_batch_size: 25,
  });
}));

/** Process the next slice. Small, fast, and safe to retry. */
router.post("/:id/batch", canIngest, wrap(async (req, res) => {
  const size = Math.min(Math.max(parseInt(req.body?.size, 10) || 25, 1), 100);
  const { data: job } = await supabase.from("ceks_import_jobs").select("*").eq("id", req.params.id).maybeSingle();
  if (!job) throw bad("Import job not found.", 404);
  if (job.status === "cancelled") throw bad("This import was cancelled.", 409);
  if (job.processed >= job.total) {
    return res.json({ done: true, processed: job.processed, total: job.total, imported: job.imported, failed: job.failed });
  }

  const all = Array.isArray(job.rows) ? job.rows : [];
  const usable = all.filter((p) => p?.id?.code || p?.id?.name);
  const slice = usable.slice(job.processed, job.processed + size);

  const started = Date.now();
  let result;
  try {
    result = await bulkCreateProducts(slice, { origin: "excel", sourceDocument: job.source_file || "Product Catalogue" });
  } catch (e) {
    // one bad batch must never destroy the run — record it and let the client continue
    result = { imported: 0, skipped: 0, failed: slice.length, entries: [], errors: [{ error: e.message }], attributes: 0 };
  }
  const ms = Date.now() - started;

  const processed = job.processed + slice.length;
  const imported = job.imported + (result.imported || 0);
  const failed = job.failed + (result.failed || 0);
  const msElapsed = (job.ms_elapsed || 0) + ms;
  const done = processed >= job.total;

  await supabase.from("ceks_import_jobs").update({
    status: done ? "completed" : "running",
    processed, imported, failed,
    ms_elapsed: msElapsed,
    entry_ids: [...(job.entry_ids || []), ...(result.entries || []).map((e) => e.id)].slice(0, 2000),
    errors: [...(job.errors || []), ...(result.errors || [])].slice(0, 200),
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);

  // ETA measured from real throughput so far — not an invented number
  const perRow = processed > 0 ? msElapsed / processed : 0;
  const remaining = Math.max(0, job.total - processed);

  res.json({
    done,
    processed, total: job.total, imported, failed,
    batch: {
      size: slice.length,
      ms,
      imported: result.imported || 0,
      created: result.created || 0,
      revised: result.revised || 0,
      attributes: result.attributes || 0,
      // what was just written — this is the live "scraping" feed the UI streams. `version` > 1 means
      // the product already existed and was re-versioned for review rather than duplicated.
      items: (result.entries || []).map((e) => ({ code: e.code, title: e.title, version: e.version || 1 })),
      errors: result.errors || [],
    },
    percent: job.total ? Math.round((processed / job.total) * 100) : 100,
    eta_seconds: Math.round((perRow * remaining) / 1000),
    rate_per_second: perRow > 0 ? Number((1000 / perRow).toFixed(2)) : null,
  });
}));

router.get("/:id", canIngest, wrap(async (req, res) => {
  const { data: job } = await supabase
    .from("ceks_import_jobs")
    .select("id,status,total,processed,imported,skipped,failed,source_file,sheet,summary,errors,ms_elapsed,created_at")
    .eq("id", req.params.id).maybeSingle();
  if (!job) throw bad("Import job not found.", 404);
  const perRow = job.processed > 0 ? job.ms_elapsed / job.processed : 0;
  res.json({
    ...job,
    percent: job.total ? Math.round((job.processed / job.total) * 100) : 0,
    eta_seconds: Math.round((perRow * Math.max(0, job.total - job.processed)) / 1000),
  });
}));

/** What did this import actually create? Used by the preview button. */
router.get("/:id/preview", canIngest, wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  const { data: job } = await supabase.from("ceks_import_jobs").select("entry_ids, source_file, imported, total").eq("id", req.params.id).maybeSingle();
  if (!job) throw bad("Import job not found.", 404);
  const ids = (job.entry_ids || []).slice(0, limit);
  if (!ids.length) return res.json({ source_file: job.source_file, imported: job.imported, items: [] });

  const { data: entries } = await supabase
    .from("ceks_knowledge_entries")
    .select("id,title,code,category,equipment_type,brand,current_status,current_version_id")
    .in("id", ids);

  const vids = (entries || []).map((e) => e.current_version_id).filter(Boolean);
  const { data: attrs } = vids.length
    ? await supabase.from("ceks_knowledge_attributes").select("version_id,name,value,unit,attr_group").in("version_id", vids)
    : { data: [] };
  const byVersion = new Map();
  for (const a of attrs || []) {
    if (!byVersion.has(a.version_id)) byVersion.set(a.version_id, []);
    byVersion.get(a.version_id).push(a);
  }

  res.json({
    source_file: job.source_file,
    imported: job.imported,
    total: job.total,
    items: (entries || []).map((e) => ({
      id: e.id, title: e.title, code: e.code, category: e.category, type: e.equipment_type,
      brand: e.brand, status: e.current_status,
      attributes: (byVersion.get(e.current_version_id) || []).slice(0, 30),
    })),
  });
}));

router.post("/:id/cancel", canIngest, wrap(async (req, res) => {
  const { data } = await supabase.from("ceks_import_jobs")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", req.params.id).select("id,status,processed,imported").single();
  res.json(data);
}));

module.exports = router;
