const XLSX = require("xlsx");
const { supabase } = require("../config/supabase");
const { persistDraft } = require("../utils/draft");

// header (normalized) → identity field
const IDENTITY = {
  model_number: ["product code", "code", "model", "model number", "model no", "item code", "sku", "rule id", "rule", "rule no", "ref", "ref no", "reference", "id", "tag", "tag no"],
  display_name: ["product name", "name", "item name"],
  category: ["product category", "category"],
  equipment_type: ["product type", "type", "equipment type"],
  brand: ["brand", "manufacturer", "make", "supplier"],
  series: ["series", "line", "series / line"],
  description: ["description / use", "description", "discription", "desc", "use", "product description"],
  power_type: ["power type", "power"],
};
const IMAGE_KEYS = ["image url", "image", "product image", "image link", "photo", "picture"];
const NOTE_KEYS = ["engineering notes", "notes", "remarks", "note"];
const MIME = { pdf: "application/pdf", dwg: "image/vnd.dwg", dxf: "image/vnd.dxf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", step: "application/step", stp: "application/step", ifc: "application/octet-stream" };

function norm(h) {
  return String(h || "").toLowerCase().replace(/\*/g, "").replace(/\s+/g, " ").trim();
}
function matchIdentity(header) {
  const n = norm(header).replace(/\(.*\)/, "").trim(); // ignore parenthetical hints, e.g. "Power Type (Electric/Gas/Neutral)"
  for (const [field, keys] of Object.entries(IDENTITY)) if (keys.includes(n)) return field;
  return null;
}
// specific sections are checked BEFORE dimensions so e.g. "Cold Water Height" → water_drain (not dimensions)
function sectionFor(header) {
  const n = norm(header);
  if (/(volt|phase|frequency|current|breaker|cable|socket|isolat|electr|rcd|amp|load|power|watt|\bkw\b)/.test(n)) return "electrical";
  if (/(water|drain|plumb)/.test(n)) return "water_drain";
  if (/gas/.test(n)) return "gas";
  if (/(vent|exhaust|airflow|hood|steam|fresh air|heat reject)/.test(n)) return "ventilation";
  if (/(indoor|outdoor|floor|mount)/.test(n) && !/clearance/.test(n)) return "installation";
  if (/(length|width|depth|height|weight|dimension|clearance)/.test(n)) return "dimensions_clearance";
  return "technical_specification";
}
const isUrl = (v) => /^https?:\/\//i.test(String(v || "").trim());
const blank = (v) => { const s = String(v == null ? "" : v).trim(); return s === "" || s === "—" || s.toLowerCase() === "n/a"; };
const fileNameFromUrl = (u, fallback) => { try { const seg = decodeURIComponent(String(u).split(/[?#]/)[0].split("/").pop() || ""); return seg || fallback; } catch { return fallback; } };
const extOf = (u) => (String(u).split(/[?#]/)[0].split(".").pop() || "").toLowerCase();

// A link column (custom items): direct Image / Drawing (CAD) / Datasheet or Manual PDF link.
function linkKind(header) {
  const n = norm(header);
  if (IMAGE_KEYS.includes(n)) return { kind: "image" };
  if (!/link|url/.test(n)) return null; // require an explicit "link"/"url" so we never clobber a spec column
  if (/(drawing|cad)/.test(n)) return { kind: "drawing" };
  if (/manual/.test(n)) return { kind: "doc", doc_type: "installation_manual" };
  if (/(datasheet|data sheet|spec sheet)/.test(n)) return { kind: "doc", doc_type: "datasheet" };
  if (/(pdf|document|\bdoc\b)/.test(n)) return { kind: "doc", doc_type: "datasheet" };
  return null;
}

/** Parse an Excel workbook buffer into per-row {model, attributes, notes, image_url}. */
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => (h == null ? "" : String(h)));

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c == null || String(c).trim() === "")) continue;
    const rec = { model: {}, attributes: [], notes: [], image_url: null, drawings: [], documents: [] };
    headers.forEach((h, c) => {
      const val = row[c];
      if (blank(val)) return;
      const n = norm(h);
      const link = linkKind(h);
      if (link) {
        const url = String(val).trim();
        if (link.kind === "image") { if (isUrl(url)) rec.image_url = url; return; }
        if (link.kind === "drawing") { rec.drawings.push(url); return; }
        if (link.kind === "doc") { rec.documents.push({ url, doc_type: link.doc_type }); return; }
      }
      if (NOTE_KEYS.includes(n)) { rec.notes.push({ content: String(val).trim() }); return; }
      const idField = matchIdentity(h);
      if (idField) { rec.model[idField] = String(val).trim(); return; }
      if (["no.", "no", "sr", "sr.", "#", "s.no"].includes(n)) return;
      const cleanName = String(h).replace(/\*/g, "").trim();
      // a component-photo column (e.g. "Socket Photo") holding an image URL → attach as a photo field
      if (/\b(photo|image)\b/.test(n) && isUrl(val)) {
        rec.attributes.push({ attr_group: sectionFor(h), name: cleanName, value: null, image_url: String(val).trim(), source_document: "Excel Import" });
        return;
      }
      rec.attributes.push({ attr_group: sectionFor(h), name: cleanName, value: String(val).trim(), unit: null, source_document: "Excel Import", source_page: null, confidence: null });
    });
    records.push(rec);
  }
  return { headers, records };
}

/** Import an Excel workbook: create a Draft per row that has a model code. */
async function importWorkbook(buffer, { log = () => {} } = {}) {
  const { records } = parseWorkbook(buffer);
  const results = [];
  let skipped = 0;
  for (const rec of records) {
    if (!rec.model.model_number) { skipped++; continue; }
    if (!rec.model.brand) rec.model.brand = "CULINOVA";
    try {
      const draft = await persistDraft({ model: rec.model, attributes: rec.attributes, notes: rec.notes, origin: "excel" });
      if (rec.image_url) await supabase.from("ceks_models").update({ image_url: rec.image_url }).eq("id", draft.model.id);
      // custom-item links: attach drawing (CAD) and PDF documents by URL (no binary upload)
      for (const url of rec.drawings) {
        await supabase.from("ceks_file_assets").insert({
          knowledge_entry_id: draft.entry_id, asset_type: "cad", file_name: fileNameFromUrl(url, "Drawing"),
          storage_url: url, mime_type: MIME[extOf(url)] || null, category_tag: "2D Drawing",
        });
      }
      for (const d of rec.documents) {
        await supabase.from("ceks_import_documents").insert({
          knowledge_entry_id: draft.entry_id, file_name: fileNameFromUrl(d.url, "Document"),
          doc_type: d.doc_type, storage_url: d.url, status: "uploaded",
        });
      }
      results.push({ ok: true, entry_id: draft.entry_id, title: draft.title, fields: rec.attributes.length, drawings: rec.drawings.length, documents: rec.documents.length });
      log(`  imported ${draft.title}`);
    } catch (e) {
      results.push({ ok: false, model: rec.model.model_number, error: e.message });
    }
  }
  return { imported: results.filter((r) => r.ok).length, skipped, total: records.length, results };
}

// ---- standardized template (columns match the importer's mapping) ----
const TEMPLATE_COLUMNS = [
  "Product Code*", "Product Name", "Brand*", "Category*", "Equipment Type*", "Series", "Power Type (Electric/Gas/Neutral)", "Description",
  "Image URL", "Drawing / CAD Link", "Datasheet PDF Link", "Manual PDF Link",
  "Capacity", "Material", "Operating Temperature",
  "Voltage (V)", "Phase", "Frequency (Hz)", "Total Power (kW)", "Full Load Current (A)", "Recommended Breaker (A)", "Recommended Cable Size", "Socket / Plug Type", "Isolator Switch", "Electrical Connection Height (mm)",
  "Cold Water Connection Type", "Cold Water Diameter", "Cold Water Height (mm)", "Hot Water Connection Type", "Hot Water Diameter", "Drain Connection Type", "Drain Diameter", "Drain Height (mm)", "Drain Method (Gravity/Pumped)", "Water Pressure",
  "Gas Type (NG/LPG)", "Gas Connection Diameter", "Gas Connection Height (mm)", "Gas Pressure", "Gas Consumption",
  "Hood Required", "Exhaust Airflow (CFM or m3/h)", "Fresh Air", "Heat Rejection", "Steam Extraction",
  "Width (mm)", "Depth (mm)", "Height (mm)", "Weight (kg)", "Front Clearance (mm)", "Rear Clearance (mm)", "Left Clearance (mm)", "Right Clearance (mm)", "Top Clearance (mm)", "Floor Fixing",
  "Indoor / Outdoor", "Floor Requirements", "Mounting",
  "Engineering Notes",
];
const EXAMPLE_ROW = [
  "XEVC-1011", "CHEFTOP Combi Oven", "UNOX", "Cooking Equipment", "Combi Oven", "CHEFTOP MIND.Maps", "Electric", "Electric combi oven, 10 x GN 1/1",
  "https://your-storage/xevc-1011.jpg", "https://your-storage/xevc-1011-drawing.pdf", "https://your-storage/xevc-1011-datasheet.pdf", "https://your-storage/xevc-1011-manual.pdf",
  "10 x GN 1/1", "AISI 304", "30-260 C",
  "380-415", "3PH+N+PE", "50/60", "18.5", "30", "40", "5G x 6 mm2", "—", "40A", "1100",
  "3/4\" NPT", "DN20", "600", "—", "—", "Open funnel", "DN40", "150", "Gravity", "150-600 kPa",
  "—", "—", "—", "—", "—",
  "Yes", "600 m3/h", "Required", "2.1 kW", "Required",
  "860", "800", "1010", "121", "50", "50", "50", "50", "500", "Adjustable feet",
  "Indoor", "Level, sealed floor", "Floor / stand mounted",
  "Provide water softener; keep 500mm top clearance for steam exhaust.",
];

/** Build the standardized template as an xlsx buffer. */
function buildTemplateBuffer() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS, EXAMPLE_ROW]);
  ws["!cols"] = TEMPLATE_COLUMNS.map((h) => ({ wch: Math.max(14, Math.min(34, h.length + 3)) }));
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws, "EOS Equipment Import");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

module.exports = { parseWorkbook, importWorkbook, buildTemplateBuffer, TEMPLATE_COLUMNS };
