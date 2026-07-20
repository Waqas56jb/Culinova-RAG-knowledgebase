/**
 * Import a discipline rules workbook (e.g. ELECTRICAL.xlsx) into EOS as DRAFT rules.
 *
 *   node cli/import-rules.js ../ELECTRICAL.xlsx --discipline=electrical
 *   node cli/import-rules.js ../ELECTRICAL.xlsx --discipline=electrical --commit
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const { supabase } = require("../src/config/supabase");
const ruleImport = require("../src/services/ruleImport");

const COMMIT = process.argv.includes("--commit");
const fileArg = process.argv.find((a) => a.endsWith(".xlsx") || a.endsWith(".xls"));
const discArg = (process.argv.find((a) => a.startsWith("--discipline=")) || "").split("=")[1] || "electrical";

(async () => {
  if (!fileArg) {
    console.error("Usage: node cli/import-rules.js <file.xlsx> --discipline=electrical [--commit]");
    process.exit(1);
  }
  const full = path.isAbsolute(fileArg) ? fileArg : path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(full)) {
    console.error("File not found:", full);
    process.exit(1);
  }

  const { data: disc, error } = await supabase.from("ceks_disciplines").select("id,code,name").eq("code", discArg).maybeSingle();
  if (error) throw error;
  if (!disc) {
    console.error(`Discipline not found: ${discArg}`);
    process.exit(1);
  }

  const wb = XLSX.read(fs.readFileSync(full), { type: "buffer" });
  console.log(`\n######## RULE IMPORT — ${path.basename(full)} → ${disc.name} (${COMMIT ? "COMMIT" : "PREVIEW"}) ########\n`);

  if (!COMMIT) {
    const prev = await ruleImport.preview(wb, { discipline_id: disc.id });
    console.log(`sheet: ${prev.sheet}`);
    console.log(`rows: ${prev.total_rows}  ·  ready: ${prev.ready}  ·  problems: ${prev.with_problems}`);
    console.log(`unmapped columns: ${(prev.unmapped || []).map((c) => c.header).join(", ") || "(none)"}`);
    if (prev.sample?.length) {
      console.log("\nsample ready rules:");
      prev.sample.forEach((r) => {
        console.log(`  ${r.code}: ${r.description}`);
        console.log(`    if: ${(r.conditions || []).join("; ")}`);
        console.log(`    then: ${(r.outputs || []).join("; ")}`);
      });
    }
    if (prev.problems?.length) {
      console.log("\nproblems:");
      prev.problems.forEach((p) => console.log(`  ${p.code}: ${(p.issues || []).join("; ")}`));
    }
    console.log("\nPreview only. Re-run with --commit to create DRAFT rules.\n");
    process.exit(0);
  }

  const out = await ruleImport.commit(wb, { discipline_id: disc.id });
  console.log(`created: ${out.created}  ·  skipped: ${out.skipped}  ·  failed: ${out.failed}`);
  if (out.errors?.length) {
    out.errors.slice(0, 10).forEach((e) => console.log(`  row ${e.row} ${e.code}: ${(e.issues || [e.error]).join("; ")}`));
  }
  console.log("\n✔ Rules imported as DRAFT — approve them in Admin → Rules.\n");
  process.exit(0);
})().catch((e) => {
  console.error("\n✖ IMPORT FAILED:", e.message);
  process.exit(1);
});
