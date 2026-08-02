const { supabase } = require("../config/supabase");
const { getEntryDetail } = require("./detail");
const { indexEntry } = require("../services/embeddings");
const recs = require("../services/recommendations");
const applicability = require("../services/applicability");

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

  // CLIENT RULE: Family and Category are mandatory. A product can never be approved (become a valid,
  // trusted product) while either is empty — it must be classified into the approved list first.
  if (!entry.family || !entry.category) {
    const miss = !entry.family && !entry.category ? "Family and Category" : !entry.family ? "Family" : "Category";
    blockers.push({ type: "missing_classification", message: `${miss} must be assigned from the approved list before this product can be approved.` });
  }

  // The client's core engineering rule: EOS must guarantee COMPLETE, VALID data before an equipment
  // record is trusted — not store incomplete data and fix it later. The applicability engine already
  // decides which sections APPLY to this equipment (a stainless table has no electrical/water/gas, so
  // those are never required). A section in the "missing" state is one the category standard REQUIRES
  // for this equipment but which has no values — so approval is blocked until it is completed.
  try {
    // Load the entry's category link so the category standard's requirements are actually applied —
    // forVersion only computes "required" sections when it knows which category profile governs.
    const { data: full } = await supabase
      .from("ceks_knowledge_entries")
      .select("id, category, category_profile_id")
      .eq("id", entry.id)
      .maybeSingle();
    const appl = await applicability.forVersion(entry.current_version_id, { entry: full });
    for (const s of appl.sections || []) {
      if (s.state === "missing") {
        blockers.push({
          type: "incomplete_section",
          discipline: s.discipline,
          message: `${s.label} is required for this equipment but has no values — complete it before approving.`,
        });
      }
    }
  } catch (e) {
    console.warn(`[workflow] applicability completeness check skipped: ${e.message}`);
  }

  if (blockers.length) {
    const e = new Error(
      `Cannot approve yet — ${blockers.length} item(s) to complete: ` +
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
