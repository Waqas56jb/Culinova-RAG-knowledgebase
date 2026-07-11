const express = require("express");
const { supabase } = require("../config/supabase");
const { approveAndIndex, setStatus } = require("../utils/workflow");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

const SORTABLE = ["title", "created_at", "updated_at", "current_status", "brand", "category", "model_number"];

/** GET /api/admin/entries — search + filter + sort + paginate over all entries. */
router.get("/entries", async (req, res) => {
  try {
    const { search, status, brand, category, equipment_type, power_type, origin } = req.query;
    const sort = SORTABLE.includes(req.query.sort) ? req.query.sort : "updated_at";
    const order = req.query.order === "asc";
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "25", 10)));

    let q = supabase.from("ceks_knowledge_entries").select("*", { count: "exact" });
    if (status && status !== "all") {
      if (status === "pending") q = q.in("current_status", ["draft", "under_review"]);
      else q = q.eq("current_status", status);
    }
    if (brand) q = q.eq("brand", brand);
    if (category) q = q.eq("category", category);
    if (equipment_type) q = q.eq("equipment_type", equipment_type);
    if (power_type) q = q.eq("power_type", power_type);
    if (origin) q = q.eq("origin", origin);
    if (search) q = q.or(`title.ilike.%${search}%,code.ilike.%${search}%,model_number.ilike.%${search}%`);
    q = q.order(sort, { ascending: order }).range((page - 1) * limit, (page - 1) * limit + limit - 1);

    const { data, count, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ items: data || [], total: count || 0, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/filters?category=&brand=&equipment_type=
 * Dependent (faceted) filters: each facet's options are narrowed by the
 * selections above it (category → brand → type → power).
 */
router.get("/filters", async (req, res) => {
  try {
    const { category, brand, equipment_type } = req.query;
    const { data } = await supabase.from("ceks_knowledge_entries").select("category,brand,equipment_type,power_type");
    const rows = data || [];
    const uniq = (arr, k) => [...new Set(arr.map((x) => x[k]).filter(Boolean))].sort();
    const byCat = rows.filter((r) => !category || r.category === category);
    const byBrand = byCat.filter((r) => !brand || r.brand === brand);
    const byType = byBrand.filter((r) => !equipment_type || r.equipment_type === equipment_type);
    res.json({
      category: uniq(rows, "category"),
      brand: uniq(byCat, "brand"),
      equipment_type: uniq(byBrand, "equipment_type"),
      power_type: uniq(byType, "power_type"),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/admin/stats — dashboard statistics. */
router.get("/stats", async (_req, res) => {
  try {
    const { data } = await supabase.from("ceks_knowledge_entries").select("current_status,category,brand,power_type");
    const rows = data || [];
    const countBy = (k) => rows.reduce((m, r) => ((m[r[k] || "—"] = (m[r[k] || "—"] || 0) + 1), m), {});
    res.json({
      total: rows.length,
      byStatus: countBy("current_status"),
      byCategory: countBy("category"),
      byBrand: countBy("brand"),
      byPowerType: countBy("power_type"),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/bulk-approve  { ids: [] } */
router.post("/bulk-approve", async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    let approved = 0;
    for (const id of ids) {
      try { await approveAndIndex(id, "Bulk approved"); approved++; } catch {}
    }
    res.json({ ok: true, approved, total: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/bulk-reject  { ids: [], comment } */
router.post("/bulk-reject", async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    let done = 0;
    for (const id of ids) {
      try { await setStatus(id, "rejected", req.body.comment || "Bulk rejected"); done++; } catch {}
    }
    res.json({ ok: true, rejected: done, total: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
