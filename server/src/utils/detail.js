const { supabase } = require("../config/supabase");

const RECS_SELECT =
  "id, parameter_id, value_text, value_num, unit, final_value, final_unit, status, rule_code, rule_version, manufacturer_value, manufacturer_unit, decided_at, ceks_parameters(key,label), ceks_disciplines(code,name)";

/** Build the full detail object for a knowledge entry (used by admin review + user portal). */
async function getEntryDetail(entryId) {
  const { data: entry, error: e1 } = await supabase
    .from("ceks_knowledge_entries")
    .select("*")
    .eq("id", entryId)
    .single();
  if (e1) throw new Error(e1.message);
  if (!entry) return null;

  const versionId = entry.current_version_id;
  const empty = Promise.resolve({ data: null });

  // Everything that depends only on entryId / versionId is independent — fetch it in ONE parallel
  // round instead of ~7 serial round trips. (Only the model brand→type→category lookup below is a
  // genuine dependency chain.)
  const [versionRes, linkRes, linkedDocsRes, filesRes, attrsRes, notesRes, recsRes] = await Promise.all([
    versionId ? supabase.from("ceks_knowledge_versions").select("*").eq("id", versionId).single() : empty,
    supabase.from("ceks_knowledge_links").select("scope_id").eq("knowledge_entry_id", entryId).eq("scope_type", "model").limit(1),
    supabase.from("ceks_import_documents").select("*").eq("knowledge_entry_id", entryId),
    supabase.from("ceks_file_assets").select("*").eq("knowledge_entry_id", entryId),
    versionId
      ? supabase.from("ceks_knowledge_attributes").select("*").eq("version_id", versionId).order("attr_group", { ascending: true }).order("sort_order", { ascending: true })
      : Promise.resolve({ data: [] }),
    versionId ? supabase.from("ceks_engineering_notes").select("*").eq("version_id", versionId) : Promise.resolve({ data: [] }),
    versionId ? supabase.from("ceks_recommendations").select(RECS_SELECT).eq("version_id", versionId).eq("is_current", true) : Promise.resolve({ data: [] }),
  ]);

  const version = versionRes.data || null;
  const attributes = attrsRes.data || [];
  const notes = notesRes.data || [];

  // model context via link → model → brand → type → category (an inherent dependency chain)
  let model = null;
  const link = linkRes.data && linkRes.data[0];
  if (link) {
    const { data: m } = await supabase.from("ceks_models").select("*").eq("id", link.scope_id).single();
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
  let documents = linkedDocsRes.data || [];
  // include any source docs referenced by attributes that aren't linked (backward compat)
  const have = new Set(documents.map((d) => d.id));
  const missing = [...new Set(attributes.map((a) => a.source_document_id).filter(Boolean))].filter((id) => !have.has(id));
  if (missing.length) {
    const { data: extra } = await supabase.from("ceks_import_documents").select("*").in("id", missing);
    documents = documents.concat(extra || []);
  }

  // CULINOVA engineering recommendations (manufacturer data above is untouched — client item 3).
  const recommendations = (recsRes.data || [])
    .filter((r) => !["rejected", "no_rule", "missing_input"].includes(r.status))
    .map((r) => ({
      parameter_key: r.ceks_parameters?.key,
      parameter: r.ceks_parameters?.label,
      discipline: r.ceks_disciplines?.name || null,
      value: r.final_value ?? r.value_text ?? (r.value_num != null ? String(r.value_num) : null),
      unit: r.final_unit || r.unit,
      status: r.status,
      manufacturer_value: r.manufacturer_value,
      manufacturer_unit: r.manufacturer_unit,
      traceability: r.rule_code ? `Generated from ${r.ceks_disciplines?.name || ""} Rule ${r.rule_code} (v${r.rule_version})`.replace(/\s+/g, " ").trim() : null,
    }));

<<<<<<< HEAD
  return { entry, version, model, attributes, notes, documents, files: filesRes.data || [], recommendations };
=======
  // CULINOVA engineering recommendations (manufacturer data is above, untouched — client item 3).
  // The ERP and the read-only portal consume these; each carries its rule traceability.
  let recommendations = [];
  if (version) {
    const { data: recs } = await supabase
      .from("ceks_recommendations")
      .select("id, parameter_id, value_text, value_num, unit, final_value, final_unit, status, rule_code, rule_version, manufacturer_value, manufacturer_unit, decided_at, ceks_parameters(key,label), ceks_disciplines(code,name)")
      .eq("version_id", version.id)
      .eq("is_current", true);
    recommendations = (recs || [])
      .filter((r) => !["rejected", "no_rule", "missing_input"].includes(r.status))
      .map((r) => ({
        parameter_key: r.ceks_parameters?.key,
        parameter: r.ceks_parameters?.label,
        discipline: r.ceks_disciplines?.name || null,
        value: r.final_value ?? r.value_text ?? (r.value_num != null ? String(r.value_num) : null),
        unit: r.final_unit || r.unit,
        status: r.status,
        manufacturer_value: r.manufacturer_value,
        manufacturer_unit: r.manufacturer_unit,
        traceability: r.rule_code ? `Generated from ${r.ceks_disciplines?.name || ""} Rule ${r.rule_code} (v${r.rule_version})`.replace(/\s+/g, " ").trim() : null,
      }));
  }

  return { entry, version, model, attributes, notes, documents, files: files || [], recommendations };
>>>>>>> bc87eb820bc0f636a95c3d98dfef902ce9843d54
}

module.exports = { getEntryDetail };
