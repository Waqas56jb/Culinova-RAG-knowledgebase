const express = require("express");
const { supabase } = require("../config/supabase");
const { approveAndIndex, setStatus } = require("../utils/workflow");
const { buildOrIlike } = require("../utils/pgrst");
const auth = require("../services/auth");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

const canRead = auth.requirePermission("knowledge.read");
const canApprove = auth.requirePermission("knowledge.approve");

const SORTABLE = ["title", "created_at", "updated_at", "current_status", "family", "brand", "category", "model_number"];
const UNSPECIFIED = "Unspecified"; // must match the NULL label used by ceks_entry_stats()

/** GET /api/admin/entries — search + filter + sort + paginate over all entries. */
router.get("/entries", canRead, async (req, res) => {
  try {
    const { search, status, family, brand, category, equipment_type, power_type, origin } = req.query;
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
    q = applyFacet(q, "family", family);
    q = applyFacet(q, "brand", brand);
    q = applyFacet(q, "category", category);
    q = applyFacet(q, "equipment_type", equipment_type);
    q = applyFacet(q, "power_type", power_type);
    if (origin) q = q.eq("origin", origin);
    // CLIENT RULE: a product with an empty Family or Category is NOT a valid product — it must never
    // appear in the normal list. The default list hides them; the review queue is reached by selecting
    // the "Unspecified" facet on Family or Category (which uses IS NULL above).
    const reviewMode = family === UNSPECIFIED || category === UNSPECIFIED;
    if (!reviewMode) { q = q.not("family", "is", null).not("category", "is", null); }
    if (search) {
      // dotted model codes (TBS.180) must survive — buildOrIlike quotes the value so "." is literal
      const clause = buildOrIlike(["title", "code", "model_number"], search);
      if (clause) q = q.or(clause);
    }
    q = q.order(sort, { ascending: order }).range((page - 1) * limit, (page - 1) * limit + limit - 1);

    const { data, count, error } = await q;
    if (error) throw new Error(error.message);

    // Attach each entry's model image so the Library list can show it. The image lives on
    // ceks_models (linked via ceks_knowledge_links), not on the entry row — without this join the
    // list only ever had a placeholder, which is what the client saw.
    const items = data || [];
    const entryIds = items.map((e) => e.id);
    if (entryIds.length) {
      const { data: links } = await supabase
        .from("ceks_knowledge_links")
        .select("knowledge_entry_id, scope_id")
        .eq("scope_type", "model")
        .in("knowledge_entry_id", entryIds);
      const modelIds = [...new Set((links || []).map((l) => l.scope_id).filter(Boolean))];
      const { data: models } = modelIds.length
        ? await supabase.from("ceks_models").select("id, image_url").in("id", modelIds)
        : { data: [] };
      const imgByModel = new Map((models || []).map((m) => [m.id, m.image_url]));
      const modelByEntry = new Map((links || []).map((l) => [l.knowledge_entry_id, l.scope_id]));
      for (const e of items) e.image_url = imgByModel.get(modelByEntry.get(e.id)) || null;
    }

    res.json({ items, total: count || 0, page, limit });
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
    const { family, category, brand, equipment_type } = req.query;
    const { data, error } = await supabase.rpc("ceks_entry_facets", {
      p_family: family || null,
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

/**
 * GET /api/admin/taxonomy — the master Family → Category map (from ceks_equipment_taxonomy).
 * Drives the cascading Family → Category dropdowns on the create/import screens so every item is
 * filed under the correct level and the two can never be mixed.
 */
router.get("/taxonomy", canRead, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("ceks_equipment_taxonomy")
      .select("family, category, sort_order")
      .order("family", { ascending: true })
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    const families = [];
    const categoriesByFamily = {};
    for (const r of data || []) {
      if (!categoriesByFamily[r.family]) { categoriesByFamily[r.family] = []; families.push(r.family); }
      categoriesByFamily[r.family].push(r.category);
    }
    res.json({ families, categoriesByFamily });
  } catch (err) {
    console.error("[admin/taxonomy]", err.message);
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
