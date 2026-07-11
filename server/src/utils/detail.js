const { supabase } = require("../config/supabase");

/** Build the full detail object for a knowledge entry (used by admin review + user portal). */
async function getEntryDetail(entryId) {
  const { data: entry, error: e1 } = await supabase
    .from("ceks_knowledge_entries")
    .select("*")
    .eq("id", entryId)
    .single();
  if (e1) throw new Error(e1.message);
  if (!entry) return null;

  let version = null;
  if (entry.current_version_id) {
    const { data } = await supabase.from("ceks_knowledge_versions").select("*").eq("id", entry.current_version_id).single();
    version = data;
  }

  let attributes = [];
  let notes = [];
  if (version) {
    const { data: attrs } = await supabase
      .from("ceks_knowledge_attributes")
      .select("*")
      .eq("version_id", version.id)
      .order("attr_group", { ascending: true })
      .order("sort_order", { ascending: true });
    attributes = attrs || [];
    const { data: ns } = await supabase.from("ceks_engineering_notes").select("*").eq("version_id", version.id);
    notes = ns || [];
  }

  // model context via link
  let model = null;
  const { data: link } = await supabase
    .from("ceks_knowledge_links")
    .select("scope_id")
    .eq("knowledge_entry_id", entryId)
    .eq("scope_type", "model")
    .limit(1);
  if (link && link[0]) {
    const { data: m } = await supabase.from("ceks_models").select("*").eq("id", link[0].scope_id).single();
    if (m) {
      const { data: b } = await supabase.from("ceks_brands").select("*").eq("id", m.brand_id).single();
      const { data: t } = b ? await supabase.from("ceks_equipment_types").select("*").eq("id", b.equipment_type_id).single() : { data: null };
      const { data: c } = t ? await supabase.from("ceks_categories").select("*").eq("id", t.category_id).single() : { data: null };
      model = {
        id: m.id,
        model_number: m.model_number,
        display_name: m.display_name,
        series: m.series || null,
        power_type: m.power_type || null,
        image_url: m.image_url || null,
        brand: b ? b.name : null,
        equipment_type: t ? t.name : null,
        category: c ? c.name : null,
      };
    }
  }

  // ALL related documents attached to this entry (datasheet, manuals, spare parts, technical data…)
  const { data: linkedDocs } = await supabase
    .from("ceks_import_documents")
    .select("*")
    .eq("knowledge_entry_id", entryId);
  let documents = linkedDocs || [];
  // include any source docs referenced by attributes that aren't linked (backward compat)
  const have = new Set(documents.map((d) => d.id));
  const missing = [...new Set(attributes.map((a) => a.source_document_id).filter(Boolean))].filter((id) => !have.has(id));
  if (missing.length) {
    const { data: extra } = await supabase.from("ceks_import_documents").select("*").in("id", missing);
    documents = documents.concat(extra || []);
  }

  // CAD / media files
  const { data: files } = await supabase.from("ceks_file_assets").select("*").eq("knowledge_entry_id", entryId);

  return { entry, version, model, attributes, notes, documents, files: files || [] };
}

module.exports = { getEntryDetail };
