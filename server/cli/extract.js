/**
 * CLI: extract structured engineering data from one PDF and print it.
 * Usage:  node cli/extract.js "<path-to-pdf>" [DocumentLabel]
 */
require("dotenv").config();
const fs = require("fs");
const { extractPages } = require("../src/services/pdf");
const { extractFromPages } = require("../src/services/extraction");

(async () => {
  const p = process.argv[2];
  const label = process.argv[3] || "Datasheet";
  if (!p) { console.error("Provide a PDF path."); process.exit(1); }
  const buf = fs.readFileSync(p);
  const { pages, numpages } = await extractPages(buf);
  console.log(`\n=== ${p}`);
  console.log(`pages: ${numpages} | label: ${label}\n`);
  const r = await extractFromPages(pages, label);
  console.log("MODEL:", JSON.stringify(r.model, null, 2));
  console.log(`\nATTRIBUTES (${r.attributes.length}):`);
  for (const a of r.attributes)
    console.log(`  [${a.attr_group}] ${a.name} = ${a.value ?? ""} ${a.unit ?? ""}  (p.${a.source_page}, conf ${a.confidence})`);
  console.log(`\nNOTES (${r.notes.length}):`);
  for (const n of r.notes) console.log(`  • ${n.content} (p.${n.source_page})`);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
