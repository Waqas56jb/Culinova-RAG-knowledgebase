/**
 * READ-ONLY diagnostic: run the REAL Excel parsing pipeline on a workbook and show exactly how every
 * column is classified and what each row extracts to — so we can see real gaps before fixing. Writes
 * NOTHING to the database.
 *   node cli/probe-excel.js "SS_Items EOS.xlsx"          # first sheet
 *   node cli/probe-excel.js "SS_Items EOS.xlsx" 5        # show 5 sample rows
 */
require("dotenv").config();
const XLSX = require("xlsx");
const path = require("path");
const pc = require("../src/services/productCatalogImport");

(async () => {
  const file = process.argv[2] || "SS_Items EOS.xlsx";
  const nRows = parseInt(process.argv[3], 10) || 3;
  const wb = XLSX.readFile(path.resolve(__dirname, "../..", file));
  console.log(`\nFILE: ${file}`);
  console.log("SHEETS:", wb.SheetNames.join(" | "), wb.SheetNames.length > 1 ? "  ⚠ MULTIPLE SHEETS — only the first is imported" : "");

  const sheet = wb.SheetNames[0];
  const { headers, rows } = pc.readSheet(wb, sheet);
  const ctx = await pc.loadPlanContext();
  const plan = await pc.planColumns(headers, ctx);

  console.log(`\nsheet="${sheet}"  headers=${headers.length}  data rows=${rows.length}`);
  console.log("\n═══ COLUMN CLASSIFICATION ═══");
  const counts = {};
  for (const c of plan) {
    counts[c.kind] = (counts[c.kind] || 0) + 1;
    let d = c.kind.toUpperCase();
    if (c.kind === "identity") d += ` → ${c.identity}`;
    else if (c.kind === "image") d += " (product image)";
    else if (c.kind === "attribute") {
      d += ` [${c.attr_group}${c.discipline ? " / " + c.discipline : ""}]`;
      if (c.field_name && c.field_name !== c.header) d += ` name="${c.field_name}"`;
      if (c.unit) d += ` unit="${c.unit}"`;
      if (c.mandatory) d += " *";
      if (c.is_requirement) d += `  ⟵ REQUIREMENT (N/A hides discipline "${c.discipline}")`;
    }
    console.log("  " + String(c.header || "(blank)").padEnd(34) + " → " + d);
  }
  console.log("  ── kinds:", JSON.stringify(counts));

  console.log(`\n═══ SAMPLE ROWS (first ${nRows}) ═══`);
  for (let i = 0; i < Math.min(nRows, rows.length); i++) {
    const p = pc.rowToProduct(rows[i], plan);
    console.log(`\n  ROW ${i + 1}  id=${JSON.stringify(p.id)}`);
    console.log(`    attributes (${p.attributes.length}):`);
    for (const a of p.attributes) console.log(`      ${a.name} = ${JSON.stringify(a.value)}${a.unit ? "  [" + a.unit + "]" : ""}${a.mandatory ? " *" : ""}`);
    if (p.notApplicable.length) console.log(`    N/A disciplines: ${p.notApplicable.join(", ")}`);
    if (p.image_url) console.log(`    image_url: ${p.image_url}`);
    if (p.notes.length) console.log(`    notes: ${p.notes.map((n) => n.content).join(" | ")}`);
  }

  // quick gap scan
  console.log("\n═══ GAP SCAN ═══");
  const flags = [];
  if (wb.SheetNames.length > 1) flags.push(`${wb.SheetNames.length} sheets but only "${sheet}" is imported`);
  const blankHeaders = plan.filter((c) => !String(c.header || "").trim()).length;
  if (blankHeaders) flags.push(`${blankHeaders} blank header column(s)`);
  const ids = plan.filter((c) => c.kind === "identity").map((c) => c.identity);
  for (const need of ["code", "name"]) if (!ids.includes(need)) flags.push(`no identity column mapped to "${need}"`);
  if (!ids.includes("source") && !ids.includes("brand")) flags.push("no brand/source column → every item will default to CULINOVA");
  const suspectUnits = plan.filter((c) => c.unit && /[a-z]{4,}|\/|electric|gas|gravity|pumped|approx/i.test(c.unit));
  for (const c of suspectUnits) flags.push(`suspect unit on "${c.header}": unit="${c.unit}" (probably NOT a unit)`);
  console.log(flags.length ? flags.map((f) => "  ⚠ " + f).join("\n") : "  ✓ no obvious column-level flags");
  console.log("");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
