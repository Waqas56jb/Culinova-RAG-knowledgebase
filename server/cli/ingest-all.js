/**
 * CLI: ingest ALL model folders under a root (e.g. the EQUIPMENTS folder).
 * A "model folder" = a leaf directory that contains files.
 * Usage:  node cli/ingest-all.js "<root folder>"
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ingestModelFolder } = require("../src/services/ingestModel");

function findModelFolders(root) {
  const out = [];
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory());
    const files = entries.filter((e) => e.isFile());
    if (subdirs.length === 0 && files.length > 0) { out.push(dir); return; }
    for (const s of subdirs) walk(path.join(dir, s.name));
  })(root);
  return out;
}

(async () => {
  const root = process.argv[2];
  if (!root) { console.error("Provide the root folder (e.g. ./EQUIPMENTS)."); process.exit(1); }
  const folders = findModelFolders(root);
  console.log(`Found ${folders.length} model folders.\n`);
  let ok = 0, fail = 0;
  for (const f of folders) {
    try {
      const r = await ingestModelFolder(f, { log: (m) => console.log(m) });
      console.log(`✔ ${r.title} — ${JSON.stringify(r.counts)}\n`);
      ok++;
    } catch (e) {
      console.error(`✖ ${f}: ${e.message}\n`);
      fail++;
    }
  }
  console.log(`\nDONE. ${ok} ingested, ${fail} failed.`);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
