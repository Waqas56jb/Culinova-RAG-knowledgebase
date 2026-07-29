/**
 * SAME CODE → SAME PHOTO (one-off runner).
 * Links each code series' photo across all its sizes (blank images only, never overwrites).
 * The import pipeline runs this automatically after every catalogue import; this CLI is for a manual
 * pass over whatever is already in the library.
 *
 *   node cli/link-series-images.js
 */
require("dotenv").config();
const { propagateSeriesImages } = require("../src/services/seriesImages");

(async () => {
  console.log("\nLinking one photo per code series (same code → same photo)…\n");
  const { filled, series } = await propagateSeriesImages();
  for (const s of series) console.log(`  ${s.key.padEnd(8)} filled ${s.filled} product(s) from ${s.from}`);
  console.log(`\n✔ ${filled} product image(s) linked.\n`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
