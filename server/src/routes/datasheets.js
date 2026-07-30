/**
 * DATASHEET IMPORT ENGINE (Step 2) — bulk-attach PDF datasheets to EXISTING products by product code.
 *
 * Flow: the client uploads PDFs straight to storage (via /api/ingest/pdf-upload-url), then calls:
 *   POST /api/datasheets/preview  { filenames:[…] }               → dry-run: which file matches which product(s)
 *   POST /api/datasheets/attach   { files:[{filename,storage_path,doc_type?}] } → attach each PDF to its product(s)
 *
 * Matching is by PRODUCT CODE in the file name (see services/datasheetMatch):
 *   "TBS.100.pdf" → the one product TBS.100;  "TBS.pdf" → the whole TBS series (one shared datasheet,
 *   many products, in a single action). A file whose code matches no product is reported UNMATCHED and
 *   is never attached to the wrong item.
 */
const express = require("express");
const { urlForKey } = require("../services/storage");
const auth = require("../services/auth");
const { matchBatch, attachBatch } = require("../services/datasheetMatch");

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(auth.authRequired);
const canIngest = auth.requirePermission("knowledge.ingest");

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (!e.status) console.error("[datasheets]", e.stack || e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong." });
  });

/** Dry-run — show exactly which product(s) each file name will attach to. Writes nothing. */
router.post("/preview", canIngest, wrap(async (req, res) => {
  const filenames = Array.isArray(req.body?.filenames) ? req.body.filenames.filter(Boolean) : [];
  res.json(await matchBatch(filenames));
}));

/** Attach each already-uploaded PDF to every product it matches (series name → whole series). */
router.post("/attach", canIngest, wrap(async (req, res) => {
  const inFiles = Array.isArray(req.body?.files) ? req.body.files : [];
  const files = [];
  for (const f of inFiles) {
    if (!f || !f.filename) continue;
    let storage_url = f.storage_url || null;
    if (!storage_url && f.storage_path) { try { storage_url = await urlForKey(f.storage_path); } catch { /* keep null; attach still records the file name */ } }
    files.push({ filename: f.filename, storage_url, doc_type: f.doc_type || "datasheet" });
  }
  res.json(await attachBatch(files, { user: req.user }));
}));

module.exports = router;
