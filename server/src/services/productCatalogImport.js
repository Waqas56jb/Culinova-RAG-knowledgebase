/**
 * GENERALIZED PRODUCT-CATALOGUE IMPORT.
 *
 * Imports a sheet where each ROW is a product (e.g. the CULINOVA SS_Items workbook: 144 stainless
 * fabrication items with dimensions, material, finish, mounting …), as opposed to the Engineering
 * Standards workbooks where each row is a CATEGORY.
 *
 * Nothing about any particular workbook is hardcoded. Every column is interpreted using data:
 *   • identity columns are matched by ALIAS LISTS (code / name / category / type / status …)
 *   • every other column becomes an ATTRIBUTE, grouped into a discipline by
 *       1. the Parameter Dictionary (header → parameter → discipline), else
 *       2. the DISCIPLINES table (header text contains a discipline name/code), else
 *       3. a neutral "specification" group
 *   • a column whose value is "N/A" is NOT stored as a fake value. When such a column belongs to a
 *     discipline, that discipline is recorded as explicitly NOT APPLICABLE for the item, which is
 *     what lets the UI hide the whole section instead of showing it empty or "Missing".
 *
 * Add a new workbook, a new discipline, or a new dictionary alias and this importer adapts — no code
 * change. Rows land as DRAFT; a human still reviews and approves them.
 */
const XLSX = require("xlsx");
const { supabase } = require("../config/supabase");
const { persistDraft } = require("../utils/draft");
const dictSvc = require("./params");
const { hasRealValue, disciplineForLabel } = require("./applicability");

const clean = (v) => (v == null ? null : String(v).trim() || null);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Identity columns — matched by alias so any vendor's header spelling works. */
const IDENTITY = {
  code: ["product code", "code", "item code", "sku", "model number", "model", "rule id", "category code"],
  name: ["product name", "name", "description name", "item name", "title"],
  category: ["product category", "category", "equipment category"],
  type: ["product type", "type", "equipment type"],
  description: ["description use", "description", "use", "scope"],
  status: ["status"],
  source: ["source type", "source"],
  remarks: ["remarks", "remark", "notes", "engineering notes"],
};
function identityKeyFor(header) {
  const h = norm(header);
  for (const [key, names] of Object.entries(IDENTITY)) if (names.includes(h)) return key;
  return null;
}

/** A column that states whether a utility is needed at all (e.g. "Electrical Requirement"). */
const REQUIREMENT_RE = /\b(requirement|required|connection)\b/i;

/** An image / photo column, matched by keyword so any sheet's naming works. */
const IMAGE_RE = /\b(image|images|photo|photos|picture|pictures|thumbnail|thumb)\b/;
const isImageHeader = (h) => IMAGE_RE.test(norm(h));
/** Only real, renderable image references become the product image. */
const isDisplayableImage = (v) => /^(https?:\/\/|data:image\/)/i.test(String(v || "").trim());

// Units are DATA, not column names — extend freely. Only used to peel a bare trailing unit token;
// a parenthetical unit needs no lexicon at all.
const UNIT_TOKENS = new Set([
  "mm", "cm", "m", "km", "in", "ft", "kg", "g", "mg", "t", "l", "ml",
  "w", "kw", "kva", "v", "a", "hz", "cfm", "m3h", "m³h", "bar", "pa", "kpa", "psi",
  "c", "f", "°c", "°f", "rpm", "db", "lm", "lux", "%",
]);
const unitKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9°%]/g, "");

/**
 * Split ANY header into { name, unit, mandatory }. Generalized — no column names hardcoded:
 *   "Length (mm)*"          → { name: "Length", unit: "mm", mandatory: true }
 *   "Bowl Size (L×W×D mm)"  → { name: "Bowl Size", unit: "L×W×D mm" }
 *   "Hood Exhaust CFM"      → { name: "Hood Exhaust", unit: "CFM" }
 *   "Material*"             → { name: "Material", unit: null, mandatory: true }
 *   "Backsplash Height"     → { name: "Backsplash Height", unit: null }  (no false unit)
 */
function parseHeader(rawHeader) {
  const original = String(rawHeader == null ? "" : rawHeader).trim();
  let name = original;
  const mandatory = name.includes("*"); // "*" anywhere marks a mandatory field
  name = name.replace(/\*/g, "").trim();
  let unit = null;
  const paren = name.match(/[([{]\s*([^()[\]{}]*?)\s*[)\]}]\s*$/); // trailing (mm), [°C], (L×W×D mm)
  if (paren) {
    unit = paren[1].trim() || null;
    name = name.slice(0, paren.index).trim();
  } else {
    // a bare trailing unit token, but only when it is a RECOGNISED unit (never strip real words)
    const m = name.match(/[\s/]([^\s/]+)$/);
    if (m && UNIT_TOKENS.has(unitKey(m[1]))) { unit = m[1].trim(); name = name.slice(0, m.index).trim(); }
  }
  name = name.replace(/[\s/×xX,.\-–—:]+$/u, "").trim(); // tidy any dangling separator
  return { name: name || original.replace(/\*/g, "").trim(), unit, mandatory };
}

/**
 * Peel a trailing unit off a VALUE cell — but ONLY a recognised unit right after a number, so real
 * values are never mangled:
 *   "1 mm"    → { value: "1",    unit: "mm" }
 *   "12.5kg"  → { value: "12.5", unit: "kg" }
 *   "SS304"   → { value: "SS304", unit: null }   (not number-led)
 *   "700"     → { value: "700",  unit: null }     (no unit part)
 *   "R 1/2"   → { value: "R 1/2", unit: null }     ("1/2" is not a known unit)
 * Used when the column header carried no unit of its own, so a unit written inside the cell still
 * lands in the dedicated unit column instead of staying stuck in the value.
 */
function splitValueUnit(rawValue) {
  const v = String(rawValue == null ? "" : rawValue).trim();
  const m = v.match(/^(-?[\d.,]+)\s*([A-Za-zµ°%/³²]+)$/);
  if (m && UNIT_TOKENS.has(unitKey(m[2]))) return { value: m[1].trim(), unit: m[2].trim() };
  return { value: v, unit: null };
}

/**
 * Decide, for every column, what it means. Returns a plan the caller can inspect before committing.
 */
async function planColumns(headers, { dict, disciplines }) {
  const plan = [];
  for (let i = 0; i < headers.length; i++) {
    const header = clean(headers[i]);
    if (!header) continue;

    // a pure row-number column carries no engineering meaning
    if (/^(no|s\s*no|sr|#|index)\.?$/i.test(header)) { plan.push({ index: i, header, kind: "ignore" }); continue; }

    const idKey = identityKeyFor(header);
    if (idKey) { plan.push({ index: i, header, kind: "identity", identity: idKey }); continue; }

    // an image / photo column — captured before attribute classification so it is never misfiled
    if (isImageHeader(header)) { plan.push({ index: i, header, kind: "image" }); continue; }

    // split the header into a clean field name, its unit, and whether it is mandatory ("*")
    const parsed = parseHeader(header);

    // 1) dictionary: prefer the CLEAN name (better matches), fall back to the raw header
    const param = dictSvc.resolveParameter(dict, parsed.name) || dictSvc.resolveParameter(dict, header);
    let discipline = null;
    if (param?.discipline_id) {
      const d = dict.disciplineById.get(param.discipline_id);
      if (d) discipline = d.code;
    }
    // 2) fall back to matching the (clean) name against the disciplines table itself
    if (!discipline) discipline = disciplineForLabel(parsed.name, disciplines) || disciplineForLabel(header, disciplines);

    const disc = disciplines.find((d) => d.code === discipline);
    plan.push({
      index: i,
      header,
      kind: "attribute",
      field_name: parsed.name,
      unit: parsed.unit,
      mandatory: parsed.mandatory,
      parameter_id: param ? param.id : null,
      parameter_label: param ? param.label : null,
      discipline,
      // group the attribute under the discipline's own attr_group when we know it
      attr_group: (disc && (disc.attr_groups || [])[0]) || "specification",
      // a "… Requirement" column is what declares whether a whole utility applies
      is_requirement: REQUIREMENT_RE.test(header) && !!discipline,
    });
  }
  return plan;
}

function readSheet(wb, sheetName) {
  const name = sheetName || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw Object.assign(new Error(`Sheet "${name}" not found. Sheets: ${wb.SheetNames.join(", ")}`), { status: 422 });
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  if (rows.length < 2) throw Object.assign(new Error("The sheet has no data rows."), { status: 422 });
  return { name, headers: (rows[0] || []).map((h) => clean(h) || ""), rows: rows.slice(1) };
}

/** Build one product's draft payload from a row + the column plan. */
function rowToProduct(row, plan) {
  const id = {};
  const attributes = [];
  const notApplicable = new Set();
  let image_url = null;
  const notes = [];

  for (const col of plan) {
    if (col.kind === "ignore") continue;
    const raw = clean(row[col.index]);

    if (col.kind === "identity") { if (raw) id[col.identity] = raw; continue; }

    // an image column: a displayable URL becomes the product image; a bare folder/file name is
    // recorded as a note (visible to the reviewer) rather than shown as a broken <img> or a fake spec.
    if (col.kind === "image") {
      if (!raw) continue;
      if (isDisplayableImage(raw)) { if (!image_url) image_url = raw; }
      else notes.push({ note_type: "photo_reference", content: `${col.header}: ${raw}` });
      continue;
    }

    // A requirement column that says N/A switches the WHOLE discipline off for this item.
    if (col.is_requirement && !hasRealValue(raw)) { notApplicable.add(col.discipline); continue; }
    // Any other empty / N/A cell is simply absent — never store a fake "N/A" value.
    if (!hasRealValue(raw)) continue;

    // The header's own unit wins; otherwise peel a unit written inside the value cell ("1 mm" → 1 + mm).
    const peeled = col.unit ? { value: raw, unit: col.unit } : splitValueUnit(raw);
    attributes.push({
      attr_group: col.attr_group,
      name: col.parameter_label || col.field_name || col.header,
      value: peeled.value,
      unit: peeled.unit || null,
      mandatory: !!col.mandatory,
      origin: "manual",
      source_document: "CULINOVA Product Catalogue",
      confidence: 1,
      verified: false,
    });
  }
  return { id, attributes, notApplicable: [...notApplicable], image_url, notes };
}

/** Preview — classify everything, write nothing. */
async function preview(wb, { sheet = null } = {}) {
  const dict = await dictSvc.load(true);
  const { data: disciplines } = await supabase.from("ceks_disciplines").select("code,name,attr_groups").order("sort_order");
  const { headers, rows, name } = readSheet(wb, sheet);
  const plan = await planColumns(headers, { dict, disciplines: disciplines || [] });

  const sample = [];
  const naTally = {};
  let withCode = 0;
  for (const row of rows) {
    const p = rowToProduct(row, plan);
    if (p.id.code) withCode++;
    for (const d of p.notApplicable) naTally[d] = (naTally[d] || 0) + 1;
    if (sample.length < 3 && p.id.code) {
      sample.push({ code: p.id.code, name: p.id.name, category: p.id.category, type: p.id.type, attributes: p.attributes.length, not_applicable: p.notApplicable });
    }
  }
  return {
    sheet: name,
    products: rows.length,
    with_code: withCode,
    columns: plan.length,
    identity_columns: plan.filter((c) => c.kind === "identity").map((c) => `${c.header} → ${c.identity}`),
    ignored_columns: plan.filter((c) => c.kind === "ignore").map((c) => c.header),
    attribute_columns: plan.filter((c) => c.kind === "attribute").length,
    mapped_to_discipline: plan.filter((c) => c.kind === "attribute" && c.discipline).map((c) => `${c.header} → ${c.discipline}`),
    not_applicable_tally: naTally,
    sample,
  };
}

/** Commit — creates one DRAFT knowledge entry per product row. */
async function importWorkbook(wb, { sheet = null, source_file = null, actor = null } = {}) {
  const dict = await dictSvc.load(true);
  const { data: disciplines } = await supabase.from("ceks_disciplines").select("code,name,attr_groups").order("sort_order");
  const { headers, rows } = readSheet(wb, sheet);
  const plan = await planColumns(headers, { dict, disciplines: disciplines || [] });

  const report = { products: rows.length, imported: 0, skipped: 0, attributes: 0, not_applicable_tally: {}, errors: [] };

  for (let r = 0; r < rows.length; r++) {
    const { id, attributes, notApplicable, image_url, notes: photoNotes } = rowToProduct(rows[r], plan);
    if (!id.code && !id.name) { report.skipped++; continue; }

    try {
      const draft = await persistDraft({
        model: {
          model_number: id.code || id.name,
          display_name: id.name || id.code,
          description: id.description || null,
          category: id.category || null,
          equipment_type: id.type || null,
          brand: id.source || "CULINOVA",
        },
        attributes,
        notes: [
          ...(id.remarks ? [{ content: id.remarks, note_type: "engineering" }] : []),
          ...(photoNotes || []),
        ],
        origin: "excel",
      });

      // a displayable image URL becomes the product image
      if (image_url && draft?.model?.id) {
        await supabase.from("ceks_models").update({ image_url }).eq("id", draft.model.id);
      }

      // record the utilities this product explicitly does NOT need, so the UI hides those sections
      if (notApplicable.length && draft?.version_id) {
        await supabase
          .from("ceks_knowledge_versions")
          .update({ not_applicable_disciplines: notApplicable })
          .eq("id", draft.version_id);
      }

      report.imported++;
      report.attributes += attributes.length;
      for (const d of notApplicable) report.not_applicable_tally[d] = (report.not_applicable_tally[d] || 0) + 1;
    } catch (e) {
      report.errors.push({ row: r + 2, code: id.code || id.name, error: e.message });
    }
  }
  report.source_file = source_file;
  return report;
}

/** The data planColumns() needs (dictionary + disciplines). Shared with the batched import job. */
async function loadPlanContext() {
  const dict = await dictSvc.load(true);
  const { data: disciplines } = await supabase.from("ceks_disciplines").select("code,name,attr_groups").order("sort_order");
  return { dict, disciplines: disciplines || [] };
}

module.exports = { preview, importWorkbook, planColumns, rowToProduct, readSheet, loadPlanContext, parseHeader, splitValueUnit, UNIT_TOKENS, unitKey };
