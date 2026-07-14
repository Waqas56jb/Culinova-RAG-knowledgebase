const express = require("express");
const multer = require("multer");
const { supabase } = require("../config/supabase");
const { getEntryDetail } = require("../utils/detail");
const { uploadBuffer } = require("../services/storage");
const { indexEntry } = require("../services/embeddings");
const { updateEntryIdentity } = require("../utils/draft");
const { setStatus, approveAndIndex } = require("../utils/workflow");
const auth = require("../services/auth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
router.use(express.json({ limit: "2mb" }));

// These are the reviewer/engineer routes — signed-in only. The client requires "who approved it" on
// every entry, so every transition below records an identity.
const canRead = auth.requirePermission("knowledge.read");
const canEdit = auth.requirePermission("knowledge.edit");
const canDelete = auth.requirePermission("knowledge.delete");
const canSubmit = auth.requirePermission("knowledge.submit");
const canApprove = auth.requirePermission("knowledge.approve");

async function versionIdFor(entryId) {
  const { data: entry } = await supabase.from("ceks_knowledge_entries").select("current_version_id").eq("id", entryId).single();
  return entry && entry.current_version_id;
}

/** GET /api/review/drafts?status=draft|under_review|all&page=&limit= */
router.get("/drafts", canRead, async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "100", 10)));
    const from = (page - 1) * limit;

    // paginate + exact count — an unbounded select is silently capped at 1000 rows by PostgREST,
    // which quietly hides drafts past that point from the reviewer.
    let q = supabase
      .from("ceks_knowledge_entries")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, from + limit - 1);
    if (status === "pending") q = q.in("current_status", ["draft", "under_review"]);
    else if (status !== "all") q = q.eq("current_status", status);
    const { data, count, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ items: data || [], total: count || 0, page, limit });
  } catch (err) {
    console.error("[review/drafts]", err.message);
    res.status(500).json({ error: "Something went wrong." });
  }
});

/** DELETE /api/entries/:id  — remove an entry (cascades versions/attributes/links) */
router.delete("/entries/:id", canDelete, async (req, res) => {
  try {
    const { error } = await supabase.from("ceks_knowledge_entries").delete().eq("id", req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/entries/:id  full detail */
router.get("/entries/:id", canRead, async (req, res) => {
  try {
    const detail = await getEntryDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Not found" });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/entries/:id/identity — correct equipment identity (brand/category/type/series/model/power) */
router.patch("/entries/:id/identity", canEdit, async (req, res) => {
  try {
    const result = await updateEntryIdentity(req.params.id, req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/entries/:id/find-documents — suggest sources for any missing document types */
router.get("/entries/:id/find-documents", canRead, async (req, res) => {
  try {
    const d = await getEntryDetail(req.params.id);
    if (!d) return res.status(404).json({ error: "Not found" });
    const present = new Set((d.documents || []).map((x) => x.doc_type));
    const wanted = [
      ["datasheet", "Datasheet"], ["technical_data", "Technical Data"], ["installation_manual", "Installation Manual"],
      ["service_manual", "Service Manual"], ["spare_parts", "Spare Parts Manual"], ["user_manual", "User Manual"],
    ];
    const q = `${d.model?.brand || ""} ${d.model?.model_number || ""}`.trim();
    const suggestions = wanted
      .filter(([t]) => !present.has(t))
      .map(([doc_type, label]) => ({
        doc_type, label,
        search_url: `https://www.google.com/search?q=${encodeURIComponent(`${q} ${label} filetype:pdf`)}`,
      }));
    res.json({ model: q, present: [...present], suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/entries/:id/history — full approval history across versions */
router.get("/entries/:id/history", canRead, async (req, res) => {
  try {
    const { data: versions } = await supabase
      .from("ceks_knowledge_versions")
      .select("id,version_number")
      .eq("knowledge_entry_id", req.params.id);
    const vids = (versions || []).map((v) => v.id);
    let history = [];
    if (vids.length) {
      const { data } = await supabase
        .from("ceks_knowledge_status_history")
        .select("*")
        .in("version_id", vids)
        .order("changed_at", { ascending: true });
      history = data || [];
    }
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/attributes/:id  { name, value, unit, verified } — engineer correction */
router.patch("/attributes/:id", canEdit, async (req, res) => {
  try {
    const allowed = ["name", "value", "unit", "verified", "attr_group"];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data, error } = await supabase
      .from("ceks_knowledge_attributes")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, attribute: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/entries/:id/attributes  { attr_group, name, value, unit } — add a field (fills a required slot) */
router.post("/entries/:id/attributes", canEdit, async (req, res) => {
  try {
    const versionId = await versionIdFor(req.params.id);
    if (!versionId) return res.status(404).json({ error: "Entry has no version." });
    const { attr_group, name, value = null, unit = null } = req.body || {};
    if (!attr_group || !name) return res.status(400).json({ error: "attr_group and name are required." });
    const { data, error } = await supabase
      .from("ceks_knowledge_attributes")
      .insert({ version_id: versionId, attr_group, name, value, unit, origin: "manual", source_document: "Manual entry" })
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, attribute: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/attributes/:id/photo  (multipart: image) — attach a component photo to a field */
router.post("/attributes/:id/photo", canEdit, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const ext = (req.file.originalname.split(".").pop() || "png").toLowerCase();
    const url = await uploadBuffer(`attr-photos/${req.params.id}-${Date.now()}.${ext}`, req.file.buffer, req.file.mimetype || "image/png");
    const { data, error } = await supabase
      .from("ceks_knowledge_attributes")
      .update({ image_url: url })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, attribute: data, image_url: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/attributes/:id */
router.delete("/attributes/:id", canEdit, async (req, res) => {
  try {
    const { error } = await supabase.from("ceks_knowledge_attributes").delete().eq("id", req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/entries/:id/submit */
router.post("/entries/:id/submit", canSubmit, async (req, res) => {
  try {
    await setStatus(req.params.id, "under_review", req.body.comment, req.user);
    res.json({ ok: true });
  } catch (err) {
    console.error("[review/submit]", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong." });
  }
});

/** POST /api/entries/:id/reject  { comment } */
router.post("/entries/:id/reject", canApprove, async (req, res) => {
  try {
    await setStatus(req.params.id, "rejected", req.body.comment, req.user);
    res.json({ ok: true });
  } catch (err) {
    console.error("[review/reject]", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong." });
  }
});

/**
 * POST /api/entries/:id/approve — approve (+ index for search). Approval is BLOCKED by the shared
 * workflow if any CULINOVA recommendation is still unresolved (the client's rule); the blockers are
 * returned so the reviewer knows exactly what to resolve first.
 */
router.post("/entries/:id/approve", canApprove, async (req, res) => {
  try {
    await approveAndIndex(req.params.id, req.body.comment, req.user);
    res.json({ ok: true });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message, blockers: err.blockers || [] });
    console.error("[review/approve]", err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong." });
  }
});

function entryToText(detail) {
  const attrText = (detail.attributes || [])
    .map((a) => `${a.name}: ${a.value ?? ""}${a.unit ? " " + a.unit : ""}`)
    .join("\n");
  const noteText = (detail.notes || []).map((n) => n.content).join("\n");
  return `${attrText}\n${noteText}`;
}

/** POST /api/reindex — (re)build the Chroma index for ALL approved entries */
router.post("/reindex", canApprove, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("ceks_knowledge_entries")
      .select("id")
      .eq("current_status", "approved");
    if (error) throw new Error(error.message);
    let indexed = 0;
    for (const e of data || []) {
      const detail = await getEntryDetail(e.id);
      const ok = await indexEntry({
        id: detail.entry.id,
        title: detail.entry.title,
        text: entryToText(detail),
        metadata: {
          entry_id: detail.entry.id,
          title: detail.entry.title,
          model_number: detail.model?.model_number || "",
          brand: detail.model?.brand || "",
          category: detail.model?.category || "",
          equipment_type: detail.model?.equipment_type || "",
        },
      });
      if (ok) indexed++;
    }
    res.json({ ok: true, indexed, total: (data || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
