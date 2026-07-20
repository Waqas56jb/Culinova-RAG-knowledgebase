/**
 * BULK PRODUCT CREATION — the same result as persistDraft(), but a fixed number of database calls
 * per BATCH instead of per ROW.
 *
 * Importing row-by-row meant ~8 network round trips per product. Over a remote database that is
 * ~3–4 seconds each, so a 144-row catalogue took roughly ten minutes and could never complete inside
 * a serverless function's time limit. Here every step is done for the whole batch at once:
 *
 *      resolve taxonomy → models → entries → versions → link versions → attributes → notes → flags
 *
 * That is ~9 round trips for a batch of ANY size, so 50 products cost about the same as one.
 *
 * Existing products are reused, never duplicated: models are matched on (brand, model_number) first
 * and only the genuinely new ones are inserted.
 */
const { supabase } = require("../config/supabase");
const { findOrCreateCategory, findOrCreateType, findOrCreateBrand, slug } = require("../utils/draft");

const clean = (v) => (v == null ? null : String(v).trim() || null);

async function insertMany(table, rows, label) {
  if (!rows.length) return [];
  const { data, error } = await supabase.from(table).insert(rows).select();
  if (error) throw new Error(`${label || table}: ${error.message}`);
  return data || [];
}

/**
 * Create one batch of products.
 *   products: [{ id:{code,name,category,type,source,description,remarks}, attributes:[], notApplicable:[] }]
 * Returns { imported, skipped, failed, entries:[{id,title,code}], errors:[] }
 */
async function bulkCreateProducts(products, { origin = "excel", sourceDocument = "CULINOVA Product Catalogue" } = {}) {
  const out = { imported: 0, skipped: 0, failed: 0, entries: [], errors: [] };
  const usable = products.filter((p) => p?.id?.code || p?.id?.name);
  out.skipped = products.length - usable.length;
  if (!usable.length) return out;

  // ── 1. taxonomy — one resolve per DISTINCT category/type/brand (cached inside draft.js) ────────
  const brandOf = new Map(); // "cat|type|brand" → brand row
  for (const p of usable) {
    const key = `${p.id.category || ""}|${p.id.type || ""}|${p.id.source || "CULINOVA"}`;
    if (brandOf.has(key)) continue;
    const category = await findOrCreateCategory(p.id.category);
    const type = await findOrCreateType(category.id, p.id.type);
    const brand = await findOrCreateBrand(type.id, p.id.source || "CULINOVA");
    brandOf.set(key, brand);
  }
  const brandFor = (p) => brandOf.get(`${p.id.category || ""}|${p.id.type || ""}|${p.id.source || "CULINOVA"}`);

  // ── 2. models — reuse what exists, insert only the new ones ────────────────────────────────────
  const codes = [...new Set(usable.map((p) => p.id.code || p.id.name))];
  const brandIds = [...new Set(usable.map((p) => brandFor(p).id))];
  const { data: existingModels } = await supabase
    .from("ceks_models")
    .select("id, brand_id, model_number")
    .in("brand_id", brandIds)
    .in("model_number", codes);

  const modelKey = (brandId, code) => `${brandId}|${String(code).toLowerCase()}`;
  const modelMap = new Map((existingModels || []).map((m) => [modelKey(m.brand_id, m.model_number), m]));

  const newModels = [];
  for (const p of usable) {
    const code = p.id.code || p.id.name;
    const b = brandFor(p);
    if (modelMap.has(modelKey(b.id, code))) continue;
    if (newModels.some((m) => m.brand_id === b.id && String(m.model_number).toLowerCase() === String(code).toLowerCase())) continue;
    newModels.push({
      brand_id: b.id,
      model_number: code,
      display_name: p.id.name || code,
      description: p.id.description || null,
    });
  }
  for (const m of await insertMany("ceks_models", newModels, "models")) modelMap.set(modelKey(m.brand_id, m.model_number), m);

  // ── 3. DEDUP — one knowledge entry per model, exactly like persistDraft() ──────────────────────
  // Re-uploading the same sheet must NOT create a second entry for the same product. Where a model
  // already has an entry we add a NEW VERSION for re-review; only genuinely new models get an entry.
  const modelIdFor = (p) => modelMap.get(modelKey(brandFor(p).id, p.id.code || p.id.name))?.id || null;
  const modelIds = [...new Set(usable.map(modelIdFor).filter(Boolean))];
  const { data: existingLinks } = modelIds.length
    ? await supabase.from("ceks_knowledge_links").select("knowledge_entry_id, scope_id").eq("scope_type", "model").in("scope_id", modelIds)
    : { data: [] };
  const entryByModel = new Map((existingLinks || []).map((l) => [l.scope_id, l.knowledge_entry_id]));

  const { data: kType } = await supabase.from("ceks_knowledge_types").select("id").eq("name", "specification").limit(1);
  const knowledgeTypeId = kType?.[0]?.id || null;

  const entryFieldsFor = (p) => {
    const b = brandFor(p);
    const code = p.id.code || p.id.name;
    return {
      title: `${b.name} ${code}`.trim(),
      code,
      summary: p.id.description || null,
      current_status: "draft",
      origin,
      category: p.id.category || null,
      equipment_type: p.id.type || null,
      brand: b.name,
      model_number: code,
    };
  };

  const fresh = usable.filter((p) => !entryByModel.has(modelIdFor(p)));
  const newEntries = await insertMany(
    "ceks_knowledge_entries",
    fresh.map((p) => ({ knowledge_type_id: knowledgeTypeId, ...entryFieldsFor(p) })),
    "entries",
  );
  if (newEntries.length !== fresh.length) {
    out.errors.push({ error: `expected ${fresh.length} new entries, database returned ${newEntries.length}` });
  }
  fresh.forEach((p, i) => { if (newEntries[i]) entryByModel.set(modelIdFor(p), newEntries[i].id); });

  // every product now resolves to an entry id, whether it was just created or already existed
  const entryIdFor = (p) => entryByModel.get(modelIdFor(p)) || null;
  const placed = usable.filter((p) => entryIdFor(p));
  out.skipped += usable.length - placed.length;

  // ── 4. versions — version 1 for a new entry, max+1 for one that already existed ───────────────
  const revisedIds = placed.map(entryIdFor).filter((id) => !newEntries.some((e) => e.id === id));
  const { data: priorVersions } = revisedIds.length
    ? await supabase.from("ceks_knowledge_versions").select("knowledge_entry_id, version_number").in("knowledge_entry_id", revisedIds)
    : { data: [] };
  const maxVersion = new Map();
  for (const v of priorVersions || []) {
    const cur = maxVersion.get(v.knowledge_entry_id) || 0;
    if (v.version_number > cur) maxVersion.set(v.knowledge_entry_id, v.version_number);
  }

  const versions = await insertMany(
    "ceks_knowledge_versions",
    placed.map((p) => {
      const id = entryIdFor(p);
      return { knowledge_entry_id: id, version_number: (maxVersion.get(id) || 0) + 1, status: "draft" };
    }),
    "versions",
  );
  const versionByEntry = new Map(versions.map((v) => [v.knowledge_entry_id, v]));

  // ── 5. point each entry at its new version and refresh its identity ───────────────────────────
  const entryUpdates = placed.map((p) => ({
    id: entryIdFor(p),
    knowledge_type_id: knowledgeTypeId,
    ...entryFieldsFor(p),
    current_version_id: versionByEntry.get(entryIdFor(p))?.id || null,
    updated_at: new Date().toISOString(),
  }));
  if (entryUpdates.length) {
    const { error } = await supabase.from("ceks_knowledge_entries").upsert(entryUpdates, { onConflict: "id" });
    if (error) out.errors.push({ error: `entry update: ${error.message}` });
  }

  // ── 6. link entry ↔ model — only for the entries created just now ─────────────────────────────
  const links = fresh
    .map((p) => ({ knowledge_entry_id: entryIdFor(p), scope_type: "model", scope_id: modelIdFor(p) }))
    .filter((l) => l.knowledge_entry_id && l.scope_id);
  await insertMany("ceks_knowledge_links", links, "links");

  // ── 7. attributes + notes — every product's rows in a single call each ─────────────────────────
  const attrRows = [];
  const noteRows = [];
  const historyRows = [];
  for (const p of placed) {
    const v = versionByEntry.get(entryIdFor(p));
    if (!v) continue;
    (p.attributes || []).forEach((a, i) => {
      attrRows.push({
        version_id: v.id,
        attr_group: a.attr_group || "specification",
        name: a.name,
        value: a.value ?? null,
        unit: a.unit ?? null,
        sort_order: i,
        origin: a.origin || "manual",
        source_document: a.source_document || sourceDocument,
        confidence: a.confidence ?? 1,
        verified: false,
      });
    });
    if (clean(p.id.remarks)) noteRows.push({ version_id: v.id, content: clean(p.id.remarks), note_type: "engineering" });
    historyRows.push({
      version_id: v.id,
      from_status: null,
      to_status: "draft",
      comment: v.version_number > 1 ? `New version ${v.version_number} via ${origin}` : `Created via ${origin}`,
    });
  }
  await insertMany("ceks_knowledge_attributes", attrRows, "attributes");
  await insertMany("ceks_engineering_notes", noteRows, "notes");
  await insertMany("ceks_knowledge_status_history", historyRows, "status history");

  // ── 8. record the utilities each product explicitly does NOT need (drives section hiding) ──────
  const naUpdates = [];
  for (const p of placed) {
    const v = versionByEntry.get(entryIdFor(p));
    if (v && (p.notApplicable || []).length) naUpdates.push({ ...v, not_applicable_disciplines: p.notApplicable });
  }
  if (naUpdates.length) {
    const { error } = await supabase.from("ceks_knowledge_versions").upsert(naUpdates, { onConflict: "id" });
    if (error) out.errors.push({ error: `applicability flags: ${error.message}` });
  }

  const titleFor = (p) => entryFieldsFor(p).title;
  out.imported = placed.length;
  out.created = newEntries.length;
  out.revised = placed.length - newEntries.length;
  out.entries = placed.map((p) => ({
    id: entryIdFor(p),
    title: titleFor(p),
    code: p.id.code || p.id.name,
    version: versionByEntry.get(entryIdFor(p))?.version_number || 1,
  }));
  out.attributes = attrRows.length;
  return out;
}

module.exports = { bulkCreateProducts };
