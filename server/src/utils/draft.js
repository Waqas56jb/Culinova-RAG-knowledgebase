const crypto = require("crypto");
const { supabase } = require("../config/supabase");

function slug(text, fallback = "ITEM") {
  const s = (text || "").toString().trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s || fallback;
}

async function first(query) {
  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  return data && data[0] ? data[0] : null;
}

async function insertOne(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

// in-memory caches to avoid re-resolving the same hierarchy on every row of a bulk import
const _cache = { cat: new Map(), type: new Map(), brand: new Map() };

async function findOrCreateCategory(name) {
  const clean = name || "Uncategorized";
  const key = clean.toLowerCase();
  if (_cache.cat.has(key)) return _cache.cat.get(key);
  let row = await first(supabase.from("ceks_categories").select("*").ilike("name", clean));
  if (!row) row = await insertOne("ceks_categories", { name: clean, code: slug(clean, "CAT") + "-" + Date.now().toString().slice(-4) });
  _cache.cat.set(key, row);
  return row;
}

async function findOrCreateType(categoryId, name) {
  const clean = name || "General";
  const key = categoryId + "|" + clean.toLowerCase();
  if (_cache.type.has(key)) return _cache.type.get(key);
  let row = await first(supabase.from("ceks_equipment_types").select("*").eq("category_id", categoryId).ilike("name", clean));
  if (!row) row = await insertOne("ceks_equipment_types", { category_id: categoryId, name: clean, code: slug(clean, "TYPE") });
  _cache.type.set(key, row);
  return row;
}

async function findOrCreateBrand(typeId, name) {
  const clean = name || "Unknown";
  const key = typeId + "|" + clean.toLowerCase();
  if (_cache.brand.has(key)) return _cache.brand.get(key);
  let row = await first(supabase.from("ceks_brands").select("*").eq("equipment_type_id", typeId).ilike("name", clean));
  if (!row) row = await insertOne("ceks_brands", { equipment_type_id: typeId, name: clean, code: slug(clean, "BRAND") });
  _cache.brand.set(key, row);
  return row;
}

/**
 * Turn a source file name into a readable identifier when nothing better is known.
 * "PL30 Datasheet.pdf" → "PL30 Datasheet". This is REAL data (the file the user uploaded), not an
 * invented value, so it is safe to show — the reviewer recognises their own file and can correct it.
 */
function stemFromFileName(name) {
  if (!name) return "";
  const base = String(name).replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Decide the model identifier WITHOUT ever fabricating one.
 *
 * The old code generated "MODEL-" + a slice of the current timestamp when extraction returned no
 * model number. That fake value (e.g. "MODEL-70988") looked exactly like a real manufacturer model
 * and reached the reviewer as if it had come from the document — which is precisely what confused
 * the client ("I don't know from where this name"). It is gone.
 *
 * Instead we fall back only to things that are REAL: the extracted number, the display name, or the
 * uploaded file's own name. Only when none of those exist do we use an explicit, honest
 * "UNIDENTIFIED-xxxx" marker — which reads as "a human must set this", not as a genuine model, and
 * carries a short unique suffix so two unidentified uploads never collapse into one model.
 */
function resolveModelIdentifier({ model_number, display_name, source_file }, brandId) {
  const clean = (v) => (v == null ? "" : String(v).trim());
  if (clean(model_number)) return { value: clean(model_number), identified: true };
  if (clean(display_name)) return { value: clean(display_name), identified: false };
  const fromFile = stemFromFileName(source_file);
  if (fromFile) return { value: fromFile, identified: false };
  // last resort — explicitly unidentified, unique so it cannot merge with another unknown item
  const suffix = crypto.randomUUID().slice(0, 4).toUpperCase();
  return { value: `UNIDENTIFIED-${suffix}`, identified: false };
}

async function findOrCreateModel(brandId, modelIdentifier, extra = {}) {
  const clean = modelIdentifier;
  const existing = await first(
    supabase.from("ceks_models").select("*").eq("brand_id", brandId).ilike("model_number", clean)
  );
  if (existing) return existing;
  return insertOne("ceks_models", { brand_id: brandId, model_number: clean, ...extra });
}

/**
 * Persist a Draft knowledge entry from extracted data.
 * @param {object} p
 * @param {object} p.model  {category, equipment_type, brand, model_number, display_name, description}
 * @param {Array}  p.attributes  each {attr_group,name,value,unit,source_document,source_document_id,source_page,confidence}
 * @param {Array}  p.notes  each {note_type,content,source_document,source_page,confidence}
 * @param {string} p.origin 'ai_pdf' | 'excel' | 'manual'
 */
async function persistDraft({ model = {}, attributes = [], notes = [], origin = "ai_pdf" }) {
  const category = await findOrCreateCategory(model.category);
  const type = await findOrCreateType(category.id, model.equipment_type);
  const brand = await findOrCreateBrand(type.id, model.brand);
  // Never fabricate a model number. resolveModelIdentifier only ever returns real data (the
  // extracted number, the display name, or the source file name), or an explicit UNIDENTIFIED marker.
  const identifier = resolveModelIdentifier(
    { model_number: model.model_number, display_name: model.display_name, source_file: model.source_file },
    brand.id,
  );
  const modelRow = await findOrCreateModel(brand.id, identifier.value, {
    display_name: model.display_name || null,
    description: model.description || null,
    series: model.series || null,
  });

  // keep model identity fresh on re-upload (existing columns)
  await supabase
    .from("ceks_models")
    .update({
      display_name: model.display_name || modelRow.display_name || null,
      series: model.series || modelRow.series || null,
      description: model.description || modelRow.description || null,
    })
    .eq("id", modelRow.id);
  // power_type / image_url are newer columns — best effort (ignored if not migrated yet)
  await supabase
    .from("ceks_models")
    .update({ power_type: model.power_type || modelRow.power_type || null })
    .eq("id", modelRow.id);

  const brandKnown = brand.name && brand.name.toLowerCase() !== "unknown";
  const title = brandKnown ? `${brand.name} ${modelRow.model_number}` : (model.display_name || modelRow.model_number);
  const attrOrigin = origin === "ai_pdf" ? "ai_extracted" : origin === "excel" ? "excel" : "manual";
  // denormalized identity for fast admin search/filter/sort
  const identityFields = {
    category: category.name,
    brand: brand.name,
    equipment_type: type.name,
    power_type: model.power_type || null,
    model_number: modelRow.model_number,
  };

  // ---- DEDUP: one knowledge entry per model ----------------------------
  // If this model already has an entry, add a NEW VERSION for re-review
  // instead of creating a duplicate entry.
  const existing = await first(
    supabase.from("ceks_knowledge_links").select("knowledge_entry_id").eq("scope_type", "model").eq("scope_id", modelRow.id)
  );

  let entryId;
  let versioned = false;
  let versionNumber = 1;

  if (existing) {
    entryId = existing.knowledge_entry_id;
    versioned = true;
    const lastVersion = await first(
      supabase.from("ceks_knowledge_versions").select("version_number").eq("knowledge_entry_id", entryId).order("version_number", { ascending: false })
    );
    versionNumber = (lastVersion ? lastVersion.version_number : 0) + 1;
  } else {
    const kType = await first(supabase.from("ceks_knowledge_types").select("*").eq("name", "specification"));
    const entry = await insertOne("ceks_knowledge_entries", {
      knowledge_type_id: kType ? kType.id : null,
      title,
      code: modelRow.model_number,
      summary: model.description || null,
      current_status: "draft",
      origin,
      ...identityFields,
    });
    entryId = entry.id;
    await supabase.from("ceks_knowledge_links").insert({
      knowledge_entry_id: entryId,
      scope_type: "model",
      scope_id: modelRow.id,
    });
  }

  const version = await insertOne("ceks_knowledge_versions", {
    knowledge_entry_id: entryId,
    version_number: versionNumber,
    status: "draft",
  });

  // point the entry at the new version + refresh title/summary + reset to draft for review
  await supabase
    .from("ceks_knowledge_entries")
    .update({
      current_version_id: version.id,
      current_status: "draft",
      origin,
      title,
      summary: model.description || null,
      ...identityFields,
      updated_at: new Date().toISOString(),
    })
    .eq("id", entryId);

  // attributes
  if (attributes.length) {
    const rows = attributes.map((a, i) => ({
      version_id: version.id,
      attr_group: a.attr_group || "other",
      name: a.name,
      value: a.value ?? null,
      unit: a.unit ?? null,
      sort_order: i,
      origin: attrOrigin,
      source_document_id: a.source_document_id ?? null,
      source_document: a.source_document ?? null,
      source_page: a.source_page ?? null,
      confidence: a.confidence ?? null,
      image_url: a.image_url ?? null,
    }));
    const { error } = await supabase.from("ceks_knowledge_attributes").insert(rows);
    if (error) throw new Error(`knowledge_attributes: ${error.message}`);
  }

  // notes
  if (notes.length) {
    const rows = notes.map((n) => ({
      version_id: version.id,
      note_type: n.note_type ?? null,
      content: n.content,
      source_document: n.source_document ?? null,
      source_page: n.source_page ?? null,
    }));
    const { error } = await supabase.from("ceks_engineering_notes").insert(rows);
    if (error) throw new Error(`engineering_notes: ${error.message}`);
  }

  await supabase.from("ceks_knowledge_status_history").insert({
    version_id: version.id,
    from_status: null,
    to_status: "draft",
    comment: versioned ? `New version ${versionNumber} via ${origin}` : `Created via ${origin}`,
  });

  return {
    entry_id: entryId,
    version_id: version.id,
    title,
    versioned,
    version_number: versionNumber,
    model: { id: modelRow.id, model_number: modelRow.model_number, brand: brand.name, category: category.name, type: type.name },
    counts: { attributes: attributes.length, notes: notes.length },
  };
}

/**
 * Update an entry's equipment identity (reviewer correction).
 * Re-resolves the Category/Type/Brand hierarchy and updates the model + denormalized entry fields.
 */
async function updateEntryIdentity(entryId, id) {
  const link = await first(
    supabase.from("ceks_knowledge_links").select("scope_id").eq("knowledge_entry_id", entryId).eq("scope_type", "model")
  );
  if (!link) throw new Error("Model not found for this entry.");
  const modelId = link.scope_id;

  const category = await findOrCreateCategory(id.category);
  const type = await findOrCreateType(category.id, id.equipment_type);
  const brand = await findOrCreateBrand(type.id, id.brand);

  await supabase
    .from("ceks_models")
    .update({
      brand_id: brand.id,
      model_number: id.model_number,
      series: id.series || null,
      power_type: id.power_type || null,
      description: id.description ?? null,
      display_name: id.display_name || null,
    })
    .eq("id", modelId);

  const brandKnown = brand.name && brand.name.toLowerCase() !== "unknown";
  const title = brandKnown ? `${brand.name} ${id.model_number}` : id.display_name || id.model_number;
  await supabase
    .from("ceks_knowledge_entries")
    .update({
      title,
      code: id.model_number,
      summary: id.description ?? null,
      category: category.name,
      brand: brand.name,
      equipment_type: type.name,
      power_type: id.power_type || null,
      model_number: id.model_number,
      updated_at: new Date().toISOString(),
    })
    .eq("id", entryId);

  return { title, category: category.name, brand: brand.name, equipment_type: type.name };
}

module.exports = {
  persistDraft, updateEntryIdentity, slug,
  // exported so a bulk importer can resolve the same taxonomy without duplicating this logic
  findOrCreateCategory, findOrCreateType, findOrCreateBrand,
};
