const express = require("express");
const { supabase } = require("../config/supabase");
const { approveAndIndex, setStatus } = require("../utils/workflow");
const { sanitizeSearch } = require("../utils/pgrst");
const auth = require("../services/auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

const canRead = auth.requirePermission("knowledge.read");
const canApprove = auth.requirePermission("knowledge.approve");

const SORTABLE = ["title", "created_at", "updated_at", "current_status", "brand", "category", "model_number"];
const UNSPECIFIED = "Unspecified"; // must match the NULL label used by ceks_entry_stats()

/** GET /api/admin/entries — search + filter + sort + paginate over all entries. */
router.get("/entries", canRead, async (req, res) => {
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
    // "Unspecified" is the DASHBOARD's label for a NULL value (see ceks_entry_stats). When the user
    // filters by it, they mean "records that have no value here", i.e. IS NULL — not the literal text.
    const applyFacet = (query, col, val) => {
      if (!val) return query;
      return val === UNSPECIFIED ? query.is(col, null) : query.eq(col, val);
    };
    q = applyFacet(q, "brand", brand);
    q = applyFacet(q, "category", category);
    q = applyFacet(q, "equipment_type", equipment_type);
    q = applyFacet(q, "power_type", power_type);
    if (origin) q = q.eq("origin", origin);
    if (search) {
      const s = sanitizeSearch(search);
      if (s) q = q.or(`title.ilike.%${s}%,code.ilike.%${s}%,model_number.ilike.%${s}%`);
    }
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
router.get("/filters", canRead, async (req, res) => {
  try {
    // Dependent facets computed in the database (DISTINCT ... WHERE upstream filters), NOT by pulling
    // the whole table into Node — which PostgREST silently caps at 1000 rows, making facets wrong.
    const { category, brand, equipment_type } = req.query;
    const { data, error } = await supabase.rpc("ceks_entry_facets", {
      p_category: category || null,
      p_brand: brand || null,
      p_type: equipment_type || null,
    });
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    console.error("[admin/filters]", err.message);
    res.status(500).json({ error: "Something went wrong." });
  }
});

/** GET /api/admin/stats — dashboard statistics, aggregated in Postgres (exact at any scale). */
router.get("/stats", canRead, async (_req, res) => {
  try {
    const { data, error } = await supabase.rpc("ceks_entry_stats");
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (err) {
    console.error("[admin/stats]", err.message);
    res.status(500).json({ error: "Something went wrong." });
  }
});

/** POST /api/admin/bulk-approve  { ids: [] } — returns a per-id result so failures are never hidden. */
router.post("/bulk-approve", canApprove, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const results = [];
    let approved = 0;
    for (const id of ids) {
      try {
        await approveAndIndex(id, "Bulk approved", req.user);
        approved++;
        results.push({ id, ok: true });
      } catch (e) {
        // most commonly a 409: the entry still has unresolved recommendations
        results.push({ id, ok: false, error: e.message, blockers: e.blockers || undefined });
      }
    }
    res.json({ ok: true, approved, failed: ids.length - approved, total: ids.length, results });
  } catch (err) {
    console.error("[admin/bulk-approve]", err.message);
    res.status(500).json({ error: "Something went wrong." });
  }
});

/** POST /api/admin/bulk-reject  { ids: [], comment } — per-id result. */
router.post("/bulk-reject", canApprove, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const results = [];
    let rejected = 0;
    for (const id of ids) {
      try {
        await setStatus(id, "rejected", req.body.comment || "Bulk rejected", req.user);
        rejected++;
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    res.json({ ok: true, rejected, failed: ids.length - rejected, total: ids.length, results });
  } catch (err) {
    console.error("[admin/bulk-reject]", err.message);
    res.status(500).json({ error: "Something went wrong." });
  }
});

module.exports = router;
