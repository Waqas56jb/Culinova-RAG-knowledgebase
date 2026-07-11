/**
 * CLI: ingest one equipment MODEL folder end-to-end.
 * Usage:  node cli/ingest-folder.js "<path to model folder>"
 */
require("dotenv").config();
const { ingestModelFolder } = require("../src/services/ingestModel");

(async () => {
  const folder = process.argv[2];
  if (!folder) { console.error("Provide a model folder path."); process.exit(1); }
  const r = await ingestModelFolder(folder, { log: (m) => console.log(m) });
  console.log("\n✔ Ingested:", r.title);
  console.log("  entry:", r.entry_id);
  console.log("  identity:", JSON.stringify(r.identity));
  console.log("  counts:", JSON.stringify(r.counts));
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
