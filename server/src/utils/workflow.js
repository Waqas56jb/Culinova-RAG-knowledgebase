const { supabase } = require("../config/supabase");
const { getEntryDetail } = require("./detail");
const { indexEntry } = require("../services/embeddings");
const recs = require("../services/recommendations");

/**
 * The ONE place a knowledge entry changes status. review.js used to carry its own copy of this logic;
 * two implementations that can drift is exactly how an approval path quietly skips a control. Every
 * transition records WHO did it (the client requires an identity on every approval).
 */
async function setStatus(entryId, toStatus, comment, actor = null) {
  const { data: entry } = await supabase.from("ceks_knowledge_entries").select("*").eq("id", entryId).single();
  if (!entry) return null;
  const patch = { current_status: toStatus, updated_at: new Date().toISOString() };
  if (toStatus === "approved") { patch.approved_at = new Date().toISOString(); patch.approved_by = actor?.id || null; }
  if (toStatus === "under_review") patch.reviewed_by = actor?.id || null;
  await supabase.from("ceks_knowledge_entries").update(patch).eq("id", entryId);
  if (entry.current_version_id) {
    await supabase.from("ceks_knowledge_versions").update({ status: toStatus }).eq("id", entry.current_version_id);
    await supabase.from("ceks_knowledge_status_history").insert({
      version_id: entry.current_version_id,
      from_status: entry.current_status,
      to_status: toStatus,
      changed_by: actor?.id || null,
      comment: comment || null,
    });
  }
  return entry;
}

/**
 * The client's hard rule: an entry cannot be approved while a CULINOVA recommendation is unresolved
 * (an engineer must accept / modify / reject it, or clear a blocking validation). Enforced here so
 * NO approval path — single or bulk — can bypass it. Entries with no recommendations have no blockers.
 */
async function assertApprovable(entry) {
  if (!entry || !entry.current_version_id) return;
  const blockers = await recs.approvalBlockers(entry.current_version_id);
  if (blockers.length) {
    const e = new Error(
      `Cannot approve yet — ${blockers.length} unresolved item(s): ` +
        blockers.slice(0, 3).map((b) => b.message).join(" ") + (blockers.length > 3 ? " …" : "")
    );
    e.status = 409;
    e.blockers = blockers;
    throw e;
  }
}

/** Approve an entry (enforcing the approval-blocker rule) and best-effort index it for search. */
async function approveAndIndex(entryId, comment, actor = null) {
  const { data: entry } = await supabase
    .from("ceks_knowledge_entries")
    .select("id, current_version_id, current_status")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) { const e = new Error("Entry not found"); e.status = 404; throw e; }

  await assertApprovable(entry);
  await setStatus(entryId, "approved", comment, actor);

  // best-effort semantic index — a Chroma outage must not fail the approval
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
  } catch (e) {
    console.warn(`[workflow] indexing entry ${entryId} failed (approval still succeeded): ${e.message}`);
  }
}

module.exports = { setStatus, approveAndIndex, assertApprovable };
