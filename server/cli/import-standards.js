/**
 * Import the CULINOVA Engineering Standards workbooks (category profiles) into EOS.
 *
 *   node cli/import-standards.js            # preview only (writes nothing)
 *   node cli/import-standards.js --commit   # import both files
 *
 * Faithful + honest: every cell is stored verbatim and classified; unresolved discipline-rule
 * references and calculation directives are counted and reported as PENDING, never fabricated.
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { supabase } = require("../src/config/supabase");
const cat = require("../src/services/categoryProfiles");

const COMMIT = process.argv.includes("--commit");
const AUTOLINK = process.argv.includes("--autolink");
const ROOT = path.join(__dirname, "..", "..");
// One entry per equipment-family workbook the client has delivered. Adding a new family is ONE line
// here (or an upload through the Admin Portal) — no code change.
const FILES = [
  { domain: "cooking", file: "CULINOVA_Cooking_Engineering_Standards_v1.0.xlsx" },
  { domain: "refrigeration", file: "CULINOVA_Refrigeration_Engineering_Standards_v1.0.xlsx" },
  { domain: "food_preparation", file: "CULINOVA_Food_Preparation_Engineering_Standards_v1.0_DETAILED.xlsx" },
  { domain: "warewashing", file: "CULINOVA_Warewashing_Engineering_Standards_v1.0_FULL.xlsx" },
  { domain: "ice_machines", file: "CULINOVA_Ice_Machines_Engineering_Standards_v1.0_FULL.xlsx" },
];

(async () => {
  console.log(`\n######## CULINOVA ENGINEERING STANDARDS — ${COMMIT ? "IMPORT" : "PREVIEW"} ########`);

  for (const { domain, file } of FILES) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) { console.error(`  ✗ missing: ${file}`); continue; }
    const wb = XLSX.read(fs.readFileSync(full), { type: "buffer" });

    console.log(`\n── ${file}  (domain: ${domain}) ──`);
    const out = COMMIT
      ? await cat.importWorkbook(wb, { domain, source_file: file })
      : await cat.preview(wb, { domain });

    if (COMMIT) {
      console.log(`  profiles created: ${out.profiles}  ·  updated: ${out.updated}  ·  attributes: ${out.attributes}`);
      console.log(`  directive breakdown: ${Object.entries(out.by_directive).map(([k, v]) => `${k}=${v}`).join("  ")}`);
      console.log(`  PENDING → discipline-rule references: ${out.pending_refs}  ·  calculation directives: ${out.pending_calcs}`);
      if (out.errors.length) { console.log(`  errors (${out.errors.length}):`); out.errors.slice(0, 8).forEach((e) => console.log(`    row ${e.row} ${e.code}: ${e.error}`)); }
    } else {
      console.log(`  categories: ${out.categories}  ·  columns: ${out.columns}`);
      console.log(`  directive breakdown: ${Object.entries(out.by_directive).map(([k, v]) => `${k}=${v}`).join("  ")}`);
      console.log(`  pending examples:`);
      out.pending_examples.slice(0, 6).forEach((p) => console.log(`    ${p.category} · ${p.attribute} = "${p.value}" (${p.kind})`));
    }
  }

  // Backfill: link EXISTING equipment to its standard where the type is an exact match. Safe —
  // autoLink never overwrites an engineer's link and only acts on a score-100 match.
  if (AUTOLINK) {
    console.log("\n── AUTO-LINK existing equipment (exact matches only) ──");
    const { data: entries } = await supabase.from("ceks_knowledge_entries").select("id").limit(5000);
    let linked = 0;
    for (const e of entries || []) {
      const r = await cat.autoLink(e.id).catch(() => null);
      if (r) linked++;
    }
    console.log(`  linked ${linked} of ${(entries || []).length} equipment entries to a category standard`);
  }

  console.log(COMMIT ? "\n✔ Import complete.\n" : AUTOLINK ? "\n✔ Auto-link complete.\n" : "\nPreview only. Re-run with --commit to import, --autolink to link existing equipment.\n");
  process.exit(0);
})().catch((e) => { console.error("\n✖ IMPORT FAILED:", e.message); console.error(e.stack); process.exit(1); });
