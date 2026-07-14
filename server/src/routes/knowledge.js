const express = require("express");
const { supabase } = require("../config/supabase");
const { getEntryDetail } = require("../utils/detail");
const { semanticSearch } = require("../services/embeddings");
const { sanitizeSearch } = require("../utils/pgrst");

const router = express.Router();

/** GET /api/knowledge?query=...   approved knowledge only (User Portal) */
router.get("/", async (req, res) => {
  try {
    const query = (req.query.query || "").trim();
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit || "24", 10)));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    if (query) {
      // try semantic search first (vector DB scales to thousands)
      const ids = await semanticSearch(query, 60);
      if (ids && ids.length) {
        const { data } = await supabase
          .from("ceks_knowledge_entries")
          .select("*")
          .in("id", ids)
          .eq("current_status", "approved");
        const order = new Map(ids.map((id, i) => [id, i]));
        const sorted = (data || []).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
        return res.json({ items: sorted.slice(from, to + 1), page, limit, total: sorted.length, mode: "semantic" });
      }
      // fallback: indexed text search on title/code (input neutralised for the PostgREST filter grammar)
      const s = sanitizeSearch(query);
      let tq = supabase
        .from("ceks_knowledge_entries")
        .select("*", { count: "exact" })
        .eq("current_status", "approved");
      if (s) tq = tq.or(`title.ilike.%${s}%,code.ilike.%${s}%`);
      const { data, count } = await tq.order("title").range(from, to);
      return res.json({ items: data || [], page, limit, total: count || 0, mode: "text" });
    }

    const { data, count, error } = await supabase
      .from("ceks_knowledge_entries")
      .select("*", { count: "exact" })
      .eq("current_status", "approved")
      .order("title")
      .range(from, to);
    if (error) throw new Error(error.message);
    res.json({ items: data || [], page, limit, total: count || 0, mode: "all" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/knowledge/:id  approved detail */
router.get("/:id", async (req, res) => {
  try {
    const detail = await getEntryDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Not found" });
    if (detail.entry.current_status !== "approved") {
      return res.status(403).json({ error: "This knowledge is not yet approved." });
    }
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
