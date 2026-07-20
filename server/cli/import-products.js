/**
 * Import a PRODUCT CATALOGUE workbook (one row = one product) into the knowledge base.
 *
 *   node cli/import-products.js "SS_Items EOS.xlsx"            # preview only — writes nothing
 *   node cli/import-products.js "SS_Items EOS.xlsx" --commit   # import as DRAFT entries
 *
 * Generic: works for any product sheet. Columns are interpreted via the Parameter Dictionary and the
 * Disciplines table, never hardcoded. A utility column marked "N/A" switches that whole discipline
 * off for the item, so EOS hides the section instead of showing it empty.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const cat = require("../src/services/productCatalogImport");

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const file = args.find((a) => !a.startsWith("--")) || "SS_Items EOS.xlsx";
const full = path.isAbsolute(file) ? file : path.join(__dirname, "..", "..", file);

(async () => {
  if (!fs.existsSync(full)) { console.error(`✖ File not found: ${full}`); process.exit(1); }
  console.log(`\n######## PRODUCT CATALOGUE — ${COMMIT ? "IMPORT" : "PREVIEW"} ########`);
  console.log(`  file: ${path.basename(full)}\n`);
  const wb = XLSX.read(fs.readFileSync(full), { type: "buffer" });

  if (!COMMIT) {
    const p = await cat.preview(wb);
    console.log(`  sheet "${p.sheet}" — ${p.products} products (${p.with_code} with a code), ${p.columns} columns`);
    console.log(`  identity columns:`);
    p.identity_columns.forEach((c) => console.log(`     ${c}`));
    if (p.ignored_columns.length) console.log(`  ignored: ${p.ignored_columns.join(", ")}`);
    console.log(`  attribute columns: ${p.attribute_columns}`);
    console.log(`  mapped to a discipline:`);
    p.mapped_to_discipline.forEach((c) => console.log(`     ${c}`));
    console.log(`  NOT-APPLICABLE declared (utility → how many products):`);
    Object.entries(p.not_applicable_tally).forEach(([d, n]) => console.log(`     ${d.padEnd(14)} ${n} products`));
    console.log(`  sample:`);
    p.sample.forEach((s) => console.log(`     ${s.code} · ${String(s.name).slice(0, 34)} · ${s.category}/${s.type} · ${s.attributes} attrs · N/A: [${s.not_applicable.join(", ")}]`));
    console.log(`\nPreview only. Re-run with --commit to import.\n`);
    process.exit(0);
  }

  const r = await cat.importWorkbook(wb, { source_file: path.basename(full) });
  console.log(`  products: ${r.products}  ·  imported: ${r.imported}  ·  skipped: ${r.skipped}  ·  attributes: ${r.attributes}`);
  console.log(`  not-applicable declared:`, JSON.stringify(r.not_applicable_tally));
  if (r.errors.length) {
    console.log(`  errors (${r.errors.length}):`);
    r.errors.slice(0, 8).forEach((e) => console.log(`     row ${e.row} ${e.code}: ${e.error}`));
  }
  console.log(`\n✔ Import complete — entries created as DRAFT for review.\n`);
  process.exit(0);
})().catch((e) => { console.error("\n✖ FAILED:", e.message); console.error(e.stack); process.exit(1); });
