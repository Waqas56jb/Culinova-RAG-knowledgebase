/**
 * Generate the ONE official EOS Equipment Import Template (.xlsx).
 *
 * Columns match the importer's aliases exactly, so a file built from this template maps cleanly with
 * no formatting/mapping surprises. "Products" is sheet #1 (the importer reads the first sheet). Includes
 * dropdowns + validation (Family, Category — dependent on the chosen Family — Power, Status), example
 * rows, an Instructions sheet, and a live Families & Categories reference pulled from the taxonomy.
 *
 *   node cli/make-import-template.js [outfile.xlsx]
 */
require("dotenv").config();
const path = require("path");
const ExcelJS = require("exceljs");
const { supabase } = require("../src/config/supabase");

const OUT = process.argv[2] || path.join(__dirname, "..", "..", "EOS_Import_Template.xlsx");
const sanitize = (f) => f.replace(/ /g, "_").replace(/&/g, "_"); // family → a valid defined-name
const colLetter = (n) => { let s = "", x = n; while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); } return s; };

const COLS = [
  { h: "Equipment Family", w: 24, req: true, note: "Pick from the list (12 families)" },
  { h: "Equipment Category", w: 26, req: true, note: "Pick from the list (filtered by the Family you chose)" },
  { h: "Product Code", w: 16, req: true, note: "UNIQUE id — how EOS recognises the item on re-import. Keep it stable." },
  { h: "Product Name", w: 30, req: true },
  { h: "Brand / Manufacturer", w: 20, req: true, note: "The maker, e.g. MBM" },
  { h: "Series / Line", w: 16, note: "Product line, e.g. Magistra" },
  { h: "Power Type", w: 12, note: "Electric / Gas / Neutral" },
  { h: "Description / Use", w: 30 },
  { h: "Status", w: 12, note: "Draft (default) or Approved" },
  { h: "Remarks", w: 24 },
  { h: "Product Image", w: 16, note: "Paste the picture INTO the cell (optional)" },
  { h: "Voltage (V)", w: 12, spec: true },
  { h: "Phase", w: 10, spec: true },
  { h: "Total Power (kW)", w: 14, spec: true },
  { h: "Current (A)", w: 12, spec: true },
  { h: "Width (mm)", w: 12, spec: true },
  { h: "Depth (mm)", w: 12, spec: true },
  { h: "Height (mm)", w: 12, spec: true },
  { h: "Weight (kg)", w: 12, spec: true },
];

(async () => {
  const { data } = await supabase.from("ceks_equipment_taxonomy").select("family, category, sort_order").order("family").order("sort_order");
  const families = [];
  const catsByFamily = {};
  for (const r of data || []) { if (!catsByFamily[r.family]) { catsByFamily[r.family] = []; families.push(r.family); } catsByFamily[r.family].push(r.category); }

  const wb = new ExcelJS.Workbook();
  wb.creator = "CULINOVA EOS";
  wb.created = new Date(2026, 0, 1);

  // ── 1) Products — the import sheet (MUST be first; importer reads sheet #1) ────
  const ws = wb.addWorksheet("Products");
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const header = ws.addRow(COLS.map((c) => c.h + (c.req ? " *" : "")));
  header.height = 24;
  COLS.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.w;
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.req ? "FF3730A3" : c.spec ? "FF6B7280" : "FF4F46E5" } };
    cell.alignment = { vertical: "middle", wrapText: true };
    if (c.note) cell.note = c.note;
  });
  ws.addRow(["Cooking", "Combi Oven", "XEVC-1011-EPRM", "UNOX ChefTop Combi Oven 10x GN1/1", "UNOX", "ChefTop", "Electric", "10-tray electric combi oven", "Draft", "", "", 400, "3", 18.9, 32, 860, 750, 1010, 120]);
  ws.addRow(["Refrigeration", "Reach-In Refrigerator", "REF-EX-01", "Upright Refrigerator 600L", "MBM", "", "Electric", "Single-door reach-in", "Draft", "", "", 230, "1", 0.3, 2, 700, 800, 2000, 110]);

  // ── 2) Families & Categories — reference + the dropdown source (named ranges) ──
  const lists = wb.addWorksheet("Families & Categories");
  families.forEach((fam, ci) => {
    const col = ci + 1;
    const hdr = lists.getCell(1, col); hdr.value = fam; hdr.font = { bold: true }; hdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF6" } };
    lists.getColumn(col).width = Math.max(16, fam.length + 2);
    catsByFamily[fam].forEach((cat, ri) => { lists.getCell(ri + 2, col).value = cat; });
    const L = colLetter(col);
    wb.definedNames.add(`'Families & Categories'!$${L}$2:$${L}$${catsByFamily[fam].length + 1}`, sanitize(fam));
  });

  // validations on the Products sheet (rows 2..600)
  const famList = '"' + families.join(",") + '"'; // ~190 chars, under the 255 inline-list limit
  for (let r = 2; r <= 600; r++) {
    ws.getCell(`A${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [famList], showErrorMessage: true, errorStyle: "warning", errorTitle: "Pick a Family", error: "Choose one of the 12 equipment families." };
    ws.getCell(`B${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`=INDIRECT(SUBSTITUTE(SUBSTITUTE($A${r}," ","_"),"&","_"))`], showErrorMessage: false };
    ws.getCell(`G${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Electric,Gas,Neutral"'], showErrorMessage: true, errorStyle: "warning", errorTitle: "Power Type", error: "Electric, Gas or Neutral." };
    ws.getCell(`I${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ['"Draft,Approved"'], showErrorMessage: false };
  }

  // ── 3) Instructions ───────────────────────────────────────────────────────
  const info = wb.addWorksheet("Instructions");
  info.getColumn(1).width = 4; info.getColumn(2).width = 112;
  const line = (t, bold) => { const row = info.addRow(["", t]); if (bold) row.getCell(2).font = { bold: true, size: bold === 2 ? 14 : 12 }; return row; };
  line("CULINOVA EOS — Equipment Import Template", 2);
  line("");
  line("HOW TO USE", 1);
  line("1.  One row = one product. Fill the 'Products' sheet (the first tab).");
  line("2.  Columns marked * are REQUIRED: Equipment Family, Equipment Category, Product Code, Product Name, Brand / Manufacturer.");
  line("3.  Equipment Family — pick from the dropdown (12 families).");
  line("4.  Equipment Category — pick from the dropdown; it is filtered by the Family you selected.");
  line("5.  Product Code — the UNIQUE identifier. EOS uses it to recognise the item on re-import, so keep it stable and never reuse a code.");
  line("6.  Brand / Manufacturer = the maker (e.g. MBM). Put the product line in 'Series / Line' (e.g. Magistra).");
  line("7.  Power Type — Electric, Gas or Neutral.");
  line("8.  Product Image — paste the picture directly INTO the cell (optional). You may also supply images named by code separately.");
  line("9.  Any EXTRA column you add (e.g. Voltage, Total Power, Gas Pressure) becomes an engineering specification automatically.");
  line("10. Imported items arrive as DRAFT for review before they are approved.");
  line("");
  line("RE-IMPORT / UPDATES", 1);
  line("• EOS matches items by Product Code: existing items are UPDATED (a new draft version), new items are ADDED — you never delete and re-import everything.");
  line("• Renaming a code creates a NEW item (the old one stays). Keep codes stable.");
  line("");
  line("REFERENCE", 1);
  line("• The 'Families & Categories' sheet lists every valid Family and its Categories (12 families, 194 categories).");

  await wb.xlsx.writeFile(OUT);
  console.log(`\n✔ Template written: ${OUT}`);
  console.log(`  sheet order: Products (import) · Families & Categories · Instructions`);
  console.log(`  ${families.length} families · ${(data || []).length} categories · ${COLS.length} columns (5 required)\n`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
