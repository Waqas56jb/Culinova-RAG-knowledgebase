/**
 * ENGINEERING STANDARDS — the Category Profile layer (the CULINOVA Cooking / Refrigeration workbooks).
 *
 * These are the per-category profiles that sit ABOVE the discipline condition→output rules in
 * routes/rules.js. This router lets the Admin Portal upload, preview, and review them, and — crucially
 * — see exactly what is still PENDING on the discipline rule tables and calculation formulas that the
 * workbooks reference but do not themselves contain.
 */
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const { supabase } = require("../config/supabase");
const { env } = require("../config/env");
const auth = require("../services/auth");
const cat = require("../services/categoryProfiles");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.uploadMaxFileMb * 1024 * 1024, files: 1 } });

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[standards]", e.stack || e.message);
    res.status(status).json({ error: status >= 500 ? "Something went wrong." : e.message });
  });
const bad = (m, s = 422) => Object.assign(new Error(m), { status: s });

router.use(express.json({ limit: "1mb" }));
router.use(auth.authRequired);

const canRead = auth.requirePermission("rule.read");
const canImport = auth.requirePermission("rule.create");
const canLink = auth.requirePermission("knowledge.edit");

// ── list category profiles ────────────────────────────────────────────────────
router.get("/category-profiles", canRead, wrap(async (req, res) => {
  let q = supabase
    .from("ceks_category_profiles")
    .select("id, domain, code, category_name, family, engineering_group, classifier, status, version, engineer_approval_required, ceks_category_profile_attributes(count)")
    .order("domain").order("code");
  if (req.query.domain) q = q.eq("domain", req.query.domain);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  res.json({ profiles: data || [] });
}));

// ── one profile, its attributes grouped by directive ─────────────────────────
router.get("/category-profiles/:id", canRead, wrap(async (req, res) => {
  const { data: profile } = await supabase.from("ceks_category_profiles").select("*").eq("id", req.params.id).maybeSingle();
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  const { data: attrs } = await supabase
    .from("ceks_category_profile_attributes")
    .select("*, ceks_parameters(key,label)")
    .eq("profile_id", profile.id)
    .order("sort_order");
  const grouped = {};
  for (const a of attrs || []) { (grouped[a.directive] = grouped[a.directive] || []).push(a); }
  res.json({
    profile,
    attributes: attrs || [],
    grouped,
    pending: (attrs || []).filter((a) => a.pending),
  });
}));

/**
 * The PENDING report — what these standards reference but do not yet contain. This is precisely the
 * work waiting on the discipline rule tables (Electrical, Gas, …) and the calculation formulas the
 * client is preparing. Nothing here is a defect; it is an honest inventory of the open dependencies.
 */
router.get("/pending", canRead, wrap(async (_req, res) => {
  const { data } = await supabase
    .from("ceks_category_profile_attributes")
    .select("directive, directive_detail, column_label, raw_value, ceks_category_profiles(domain,category_name)")
    .eq("pending", true);

  const ruleRefs = {}; // discipline → { count, columns:Set }
  const calcs = {};     // directive_detail → count
  for (const a of data || []) {
    if (a.directive === "culinova_rule") {
      const d = a.directive_detail || "unknown";
      if (!ruleRefs[d]) ruleRefs[d] = { discipline: d, count: 0, columns: new Set() };
      ruleRefs[d].count++;
      ruleRefs[d].columns.add(a.column_label);
    } else if (a.directive === "calculation") {
      const k = a.raw_value || a.directive_detail || "calculation";
      calcs[k] = (calcs[k] || 0) + 1;
    }
  }
  res.json({
    summary: "These profiles reference discipline rule tables and calculation formulas that are provided separately. Until those are supplied, EOS stores the reference and will not fabricate a value.",
    rule_tables_needed: Object.values(ruleRefs).map((r) => ({ discipline: r.discipline, references: r.count, columns: [...r.columns] })),
    calculations_needed: Object.entries(calcs).map(([formula, count]) => ({ formula, occurrences: count })),
  });
}));

// ── APPLY a profile to an equipment entry (the engine integration) ───────────
async function loadEntry(entryId) {
  const { data: entry } = await supabase
    .from("ceks_knowledge_entries")
    .select("id, title, brand, category, equipment_type, category_profile_id, category_profile_source")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) throw bad("Equipment entry not found.", 404);
  return entry;
}

/** The category standard applied to ONE equipment: requirements, manufacturer-sourced, pending. */
router.get("/for-equipment/:entryId", canRead, wrap(async (req, res) => {
  const entry = await loadEntry(req.params.entryId);
  const view = await cat.forEntry(entry);
  res.json({ entry: { id: entry.id, title: entry.title, category: entry.category, equipment_type: entry.equipment_type }, ...view });
}));

/** Profiles EOS suggests for this equipment (for the engineer to pick when there's no exact match). */
router.get("/for-equipment/:entryId/candidates", canRead, wrap(async (req, res) => {
  const entry = await loadEntry(req.params.entryId);
  res.json({ candidates: await cat.matchCandidates(entry) });
}));

/** Engineer binds (or unbinds) the equipment to a category profile. */
router.post("/for-equipment/:entryId/link", canLink, wrap(async (req, res) => {
  const entry = await loadEntry(req.params.entryId);
  const profileId = req.body?.profile_id || null;
  if (profileId) {
    const { data: profile } = await supabase.from("ceks_category_profiles").select("id").eq("id", profileId).maybeSingle();
    if (!profile) throw bad("That category profile does not exist.", 404);
  }
  const { error } = await supabase
    .from("ceks_knowledge_entries")
    .update({ category_profile_id: profileId, category_profile_source: profileId ? "engineer" : null, updated_at: new Date().toISOString() })
    .eq("id", entry.id);
  if (error) throw new Error(error.message);
  const fresh = await loadEntry(entry.id);
  res.json(await cat.forEntry(fresh));
}));

// ── import (preview + commit) ─────────────────────────────────────────────────
router.post("/import/preview", canImport, upload.single("file"), wrap(async (req, res) => {
  if (!req.file) throw bad("Attach an .xlsx standards file.");
  if (!req.body.domain) throw bad("Provide the domain (e.g. cooking / refrigeration).");
  const wb = XLSX.read(req.file.buffer, { type: "buffer" });
  res.json(await cat.preview(wb, { domain: String(req.body.domain).trim().toLowerCase(), sheet: req.body.sheet || null }));
}));

router.post("/import/commit", canImport, upload.single("file"), wrap(async (req, res) => {
  if (!req.file) throw bad("Attach an .xlsx standards file.");
  if (!req.body.domain) throw bad("Provide the domain (e.g. cooking / refrigeration).");
  const wb = XLSX.read(req.file.buffer, { type: "buffer" });
  const out = await cat.importWorkbook(wb, {
    domain: String(req.body.domain).trim().toLowerCase(),
    sheet: req.body.sheet || null,
    source_file: req.file.originalname,
    user: req.user,
  });
  res.json(out);
}));

module.exports = router;
