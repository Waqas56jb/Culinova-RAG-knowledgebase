const express = require("express");
const multer = require("multer");
const { supabase } = require("../config/supabase");
const { getEntryDetail } = require("../utils/detail");
const { uploadBuffer } = require("../services/storage");
const { indexEntry } = require("../services/embeddings");
const { updateEntryIdentity } = require("../utils/draft");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
router.use(express.json({ limit: "2mb" }));

async function versionIdFor(entryId) {
  const { data: entry } = await supabase.from("ceks_knowledge_entries").select("current_version_id").eq("id", entryId).single();
  return entry && entry.current_version_id;
}

/** GET /api/review/drafts?status=draft|under_review|all */
router.get("/drafts", async (req, res) => {
  try {
    const status = req.query.status || "pending";
    let q = supabase.from("ceks_knowledge_entries").select("*").order("created_at", { ascending: false });
    if (status === "pending") q = q.in("current_status", ["draft", "under_review"]);
    else if (status !== "all") q = q.eq("current_status", status);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ items: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/entries/:id  — remove an entry (cascades versions/attributes/links) */
router.delete("/entries/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("ceks_knowledge_entries").delete().eq("id", req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/entries/:id  full detail */
router.get("/entries/:id", async (req, res) => {
  try {
    const detail = await getEntryDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Not found" });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /api/entries/:id/identity — correct equipment identity (brand/category/type/series/model/power) */
router.patch("/entries/:id/identity", async (req, res) => {
  try {
    const result = await updateEntryIdentity(req.params.id, req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/entries/:id/find-documents — suggest sources for any missing document types */
router.get("/entries/:id/find-documents", async (req, res) => {
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
router.get("/entries/:id/history", async (req, res) => {
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
router.patch("/attributes/:id", async (req, res) => {
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
router.post("/entries/:id/attributes", async (req, res) => {
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
router.post("/attributes/:id/photo", upload.single("image"), async (req, res) => {
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
router.delete("/attributes/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("ceks_knowledge_attributes").delete().eq("id", req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function transition(entryId, toStatus, comment) {
  const { data: entry, error } = await supabase.from("ceks_knowledge_entries").select("*").eq("id", entryId).single();
  if (error) throw new Error(error.message);
  const patch = { current_status: toStatus, updated_at: new Date().toISOString() };
  if (toStatus === "approved") patch.approved_at = new Date().toISOString();
  await supabase.from("ceks_knowledge_entries").update(patch).eq("id", entryId);
  if (entry.current_version_id) {
    await supabase.from("ceks_knowledge_versions").update({ status: toStatus }).eq("id", entry.current_version_id);
    await supabase.from("ceks_knowledge_status_history").insert({
      version_id: entry.current_version_id,
      from_status: entry.current_status,
      to_status: toStatus,
      comment: comment || null,
    });
  }
  return entry;
}

/** POST /api/entries/:id/submit */
router.post("/entries/:id/submit", async (req, res) => {
  try {
    await transition(req.params.id, "under_review", req.body.comment);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/entries/:id/reject  { comment } */
router.post("/entries/:id/reject", async (req, res) => {
  try {
    await transition(req.params.id, "rejected", req.body.comment);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/entries/:id/approve — approve + index into Chroma (best-effort) */
router.post("/entries/:id/approve", async (req, res) => {
  try {
    await transition(req.params.id, "approved", req.body.comment);
    const detail = await getEntryDetail(req.params.id);

    // best-effort semantic index
    const attrText = (detail.attributes || [])
      .map((a) => `${a.name}: ${a.value ?? ""}${a.unit ? " " + a.unit : ""}`)
      .join("\n");
    const noteText = (detail.notes || []).map((n) => n.content).join("\n");
    indexEntry({
      id: detail.entry.id,
      title: detail.entry.title,
      text: `${attrText}\n${noteText}`,
      metadata: {
        entry_id: detail.entry.id,
        title: detail.entry.title,
        model_number: detail.model?.model_number || "",
        brand: detail.model?.brand || "",
        category: detail.model?.category || "",
        equipment_type: detail.model?.equipment_type || "",
      },
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
router.post("/reindex", async (req, res) => {
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
