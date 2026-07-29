/**
 * Generate the ONE official EOS Equipment Import Template (.xlsx) — comprehensive edition.
 *
 * Identity columns + EVERY engineering spec field, grouped and colour-coded by discipline (Electrical,
 * Water/Plumbing, Drainage, Gas, Ventilation) plus Dimensions & Clearances. The spec columns are pulled
 * live from the Parameter Dictionary (input fields only — EOS computes the "Recommended …" outputs), so
 * headers map cleanly with no surprises. "Products" is sheet #1 (the importer reads the first sheet),
 * with dropdowns for Family / Category (dependent) / Power / Status, example rows, an Instructions sheet,
 * and a live Families & Categories reference. Fill the applicable columns, leave the rest blank.
 *
 *   node cli/make-import-template.js [outfile.xlsx]
 */
require("dotenv").config();
const path = require("path");
const ExcelJS = require("exceljs");
const { supabase } = require("../src/config/supabase");

const OUT = process.argv[2] || path.join(__dirname, "..", "..", "EOS_Import_Template.xlsx");
const sanitize = (f) => f.replace(/ /g, "_").replace(/&/g, "_");
const colLetter = (n) => { let s = "", x = n; while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); } return s; };

// identity columns — fixed positions A..K (validations below rely on A/B/G/I)
const IDENTITY_COLS = [
  { h: "Equipment Family", w: 24, req: true, fill: "FF3730A3", note: "Pick from the list (12 families)" },
  { h: "Equipment Category", w: 26, req: true, fill: "FF3730A3", note: "Pick from the list (filtered by the Family you chose)" },
  { h: "Product Code", w: 16, req: true, fill: "FF3730A3", note: "UNIQUE id — how EOS recognises the item on re-import. Keep it stable." },
  { h: "Product Name", w: 30, req: true, fill: "FF3730A3" },
  { h: "Brand / Manufacturer", w: 20, req: true, fill: "FF3730A3", note: "The maker, e.g. MBM" },
  { h: "Series / Line", w: 16, fill: "FF4F46E5", note: "Product line, e.g. Magistra" },
  { h: "Power Type", w: 12, fill: "FF4F46E5", note: "Electric / Gas / Neutral" },
  { h: "Description / Use", w: 28, fill: "FF4F46E5" },
  { h: "Status", w: 12, fill: "FF4F46E5", note: "Draft (default) or Approved" },
  { h: "Remarks", w: 22, fill: "FF4F46E5" },
  { h: "Product Image", w: 16, fill: "FF4F46E5", note: "Paste the picture INTO the cell (optional)" },
];
const DISC_COLOR = { Electrical: "FF0E7490", Plumbing: "FF1D4ED8", Drainage: "FF0F766E", Gas: "FFB91C1C", Ventilation: "FF7C3AED" };
const PHYSICAL = { name: "Dimensions & Clearances", color: "FF4D7C0F",
  cols: ["Overall Width (mm)", "Overall Depth (mm)", "Overall Height (mm)", "Net Weight (kg)", "Rear Clearance (mm)", "Side Clearance (mm)", "Top Clearance (mm)"] };

(async () => {
  const { data: taxo } = await supabase.from("ceks_equipment_taxonomy").select("family, category, sort_order").order("family").order("sort_order");
  const families = []; const catsByFamily = {};
  for (const r of taxo || []) { if (!catsByFamily[r.family]) { catsByFamily[r.family] = []; families.push(r.family); } catsByFamily[r.family].push(r.category); }

  const { data: disc } = await supabase.from("ceks_disciplines").select("id, name, sort_order").order("sort_order");
  const { data: params } = await supabase.from("ceks_parameters").select("label, discipline_id, canonical_unit, role, sort_order").order("sort_order");
  const inputs = (params || []).filter((p) => p.discipline_id && (p.role === "input" || p.role === "both"));

  // spec columns, grouped by discipline (dictionary inputs) + a Dimensions & Clearances group
  const specCols = [];
  for (const d of disc || []) {
    const ps = inputs.filter((p) => p.discipline_id === d.id);
    for (const p of ps) specCols.push({ h: p.label + (p.canonical_unit ? ` (${p.canonical_unit})` : ""), w: Math.max(12, p.label.length + 3), fill: DISC_COLOR[d.name] || "FF6B7280", disc: d.name });
  }
  for (const h of PHYSICAL.cols) specCols.push({ h, w: 16, fill: PHYSICAL.color, disc: PHYSICAL.name });

  const COLS = [...IDENTITY_COLS, ...specCols];

  const wb = new ExcelJS.Workbook();
  wb.creator = "CULINOVA EOS"; wb.created = new Date(2026, 0, 1);

  // ── 1) Products (import sheet — first) ────────────────────────────────────
  const ws = wb.addWorksheet("Products");
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const header = ws.addRow(COLS.map((c) => c.h + (c.req ? " *" : "")));
  header.height = 30;
  COLS.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.w;
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.fill } };
    cell.alignment = { vertical: "middle", wrapText: true };
    if (c.note) cell.note = c.note;
  });
  const exRow = (vals) => ws.addRow(COLS.map((c) => (c.h in vals ? vals[c.h] : "")));
  exRow({ "Equipment Family": "Cooking", "Equipment Category": "Combi Oven", "Product Code": "XEVC-1011-EPRM", "Product Name": "UNOX ChefTop Combi Oven 10x GN1/1", "Brand / Manufacturer": "UNOX", "Series / Line": "ChefTop", "Power Type": "Electric", "Description / Use": "10-tray electric combi oven", "Status": "Draft", "Phase": "3", "Voltage (V)": 400, "Frequency (Hz)": 50, "Power (kW)": 18.9, "Current (A)": 32, "Overall Width (mm)": 860, "Overall Depth (mm)": 750, "Overall Height (mm)": 1010, "Net Weight (kg)": 120 });
  exRow({ "Equipment Family": "Cooking", "Equipment Category": "Gas Range", "Product Code": "GR-6B-01", "Product Name": "6-Burner Gas Range", "Brand / Manufacturer": "MBM", "Series / Line": "Magistra", "Power Type": "Gas", "Description / Use": "6 open burners", "Status": "Draft", "Gas Type": "NG / LPG", "Gas Pressure (mbar)": 20, "Gas Power (kW)": 33, "Overall Width (mm)": 900, "Overall Depth (mm)": 900, "Overall Height (mm)": 850 });

  // ── 2) Families & Categories (reference + dependent-dropdown source) ───────
  const lists = wb.addWorksheet("Families & Categories");
  families.forEach((fam, ci) => {
    const col = ci + 1;
    const hdr = lists.getCell(1, col); hdr.value = fam; hdr.font = { bold: true }; hdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF6" } };
    lists.getColumn(col).width = Math.max(16, fam.length + 2);
    catsByFamily[fam].forEach((cat, ri) => { lists.getCell(ri + 2, col).value = cat; });
    const L = colLetter(col);
    wb.definedNames.add(`'Families & Categories'!$${L}$2:$${L}$${catsByFamily[fam].length + 1}`, sanitize(fam));
  });

  // validations on Products rows 2..600 (A Family, B Category dependent, G Power, I Status)
  const famList = '"' + families.join(",") + '"';
  for (let r = 2; r <= 600; r++) {
    ws.getCell(`A${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [famList], showErrorMessage: true, errorStyle: "warning", errorTitle: "Pick a Family", error: "Choose one of the 12 equipment families." };
    ws.getCell(`B${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`=INDIRECT(SUBSTITUTE(SUBSTITUTE($A${r}," ","_"),"&","_"))`], showErrorMessage: false };
    ws.getCell(`G${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Electric,Gas,Neutral"'], showErrorMessage: true, errorStyle: "warning", errorTitle: "Power Type", error: "Electric, Gas or Neutral." };
    ws.getCell(`I${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Draft,Approved"'], showErrorMessage: false };
  }

  // ── 3) Instructions ───────────────────────────────────────────────────────
  const info = wb.addWorksheet("Instructions");
  info.getColumn(1).width = 4; info.getColumn(2).width = 116;
  const line = (t, bold) => { const row = info.addRow(["", t]); if (bold) row.getCell(2).font = { bold: true, size: bold === 2 ? 14 : 12 }; return row; };
  line("CULINOVA EOS — Equipment Import Template", 2);
  line("");
  line("HOW TO USE", 1);
  line("1.  One row = one product. Fill the 'Products' sheet (the first tab). Fill the columns that apply and LEAVE THE REST BLANK.");
  line("2.  Columns marked * are REQUIRED: Equipment Family, Equipment Category, Product Code, Product Name, Brand / Manufacturer.");
  line("3.  Equipment Family — pick from the dropdown (12 families).  Equipment Category — dropdown filtered by the Family you chose.");
  line("4.  Product Code — the UNIQUE identifier. EOS uses it to recognise the item on re-import, so keep it stable and never reuse a code.");
  line("5.  Brand / Manufacturer = the maker (e.g. MBM). Put the product line in 'Series / Line' (e.g. Magistra).");
  line("6.  Engineering columns are grouped and colour-coded by discipline: Electrical, Water/Plumbing, Drainage, Gas, Ventilation, and Dimensions & Clearances.");
  line("7.  You can ADD your own extra columns too — any extra header becomes an engineering attribute automatically.");
  line("8.  EOS computes the 'Recommended …' values (cable size, breaker, pipe size, clearances, airflow…) from these inputs, so those are NOT in the template.");
  line("9.  Product Image — paste the picture directly INTO the cell (optional). Imported items arrive as DRAFT for review.");
  line("");
  line("RE-IMPORT / UPDATES", 1);
  line("• EOS matches items by Product Code: existing items are UPDATED, new items are ADDED — you never delete and re-import everything. Renaming a code creates a NEW item.");
  line("");
  line("REFERENCE", 1);
  line("• 'Families & Categories' sheet — every valid Family and its Categories (12 families, 194 categories).");

  await wb.xlsx.writeFile(OUT);
  console.log(`\n✔ Template written: ${OUT}`);
  console.log(`  ${IDENTITY_COLS.length} identity + ${specCols.length} spec columns (${COLS.length} total) · ${families.length} families · ${(taxo || []).length} categories\n`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
