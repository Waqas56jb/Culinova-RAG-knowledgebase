const { supabase } = require("../config/supabase");
const { getEntryDetail } = require("./detail");
const { indexEntry } = require("../services/embeddings");

/** Move an entry to a new status + log history. */
async function setStatus(entryId, toStatus, comment) {
  const { data: entry } = await supabase.from("ceks_knowledge_entries").select("*").eq("id", entryId).single();
  if (!entry) return null;
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

/** Approve an entry and (best-effort) index it into Chroma for semantic search. */
async function approveAndIndex(entryId, comment) {
  await setStatus(entryId, "approved", comment);
  try {
    const d = await getEntryDetail(entryId);
    const attrText = (d.attributes || []).map((a) => `${a.name}: ${a.value ?? ""}${a.unit ? " " + a.unit : ""}`).join("\n");
    const noteText = (d.notes || []).map((n) => n.content).join("\n");
    await indexEntry({
      id: d.entry.id,
      title: d.entry.title,
      text: `${attrText}\n${noteText}`,
      metadata: {
        entry_id: d.entry.id,
        title: d.entry.title,
        model_number: d.model?.model_number || "",
        brand: d.model?.brand || "",
        category: d.model?.category || "",
        equipment_type: d.model?.equipment_type || "",
      },
    });
  } catch {}
}

module.exports = { setStatus, approveAndIndex };
