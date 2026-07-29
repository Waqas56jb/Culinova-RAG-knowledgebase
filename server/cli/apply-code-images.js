/**
 * APPLY CLIENT-NAMED IMAGES BY CODE SERIES.
 *
 * The client supplies one image per code series, named after that series:
 *   COS.png · OS-1.png · os-2.png · TS.png · TB.png · TBS.png · ws.png · WSP.png · PWL.png · PWR.png
 * Every product model whose code belongs to a series gets THAT series' image — mapped by the product
 * code (prefix + tier), never by category or a generic picture. Existing images ARE overwritten, so a
 * wrong/misaligned embedded picture is corrected.
 *
 *   node cli/apply-code-images.js [folder]        # default folder = repo root
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { supabase } = require("../src/config/supabase");
const { uploadBuffer } = require("../src/services/storage");

const CT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

// candidate series keys for a code, most specific first: OS.2404-1 → ["OS-1","OS"]; COS.704-2 → ["COS-2","COS"]
function candidates(code) {
  const s = String(code || "").trim();
  const m = s.match(/^([A-Za-z]+)\.?\d+(?:-(\d+))?$/);
  if (!m) return [];
  const prefix = m[1].toUpperCase();
  return m[2] ? [`${prefix}-${m[2]}`, prefix] : [prefix];
}

(async () => {
  const folder = process.argv[2] || path.join(__dirname, "../../");
  const imgFiles = fs.readdirSync(folder).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  // filename (without ext, upper-cased) is the series key: "os-2.png" → "OS-2", "COS.png" → "COS"
  const fileBySeries = {};
  for (const f of imgFiles) fileBySeries[f.replace(/\.[^.]+$/, "").toUpperCase()] = path.join(folder, f);
  console.log("series images found: " + Object.keys(fileBySeries).sort().join(", ") + "\n");

  // upload each image once, lazily, caching its URL
  const urlCache = {};
  async function urlFor(seriesKey) {
    if (urlCache[seriesKey] !== undefined) return urlCache[seriesKey];
    const fp = fileBySeries[seriesKey];
    if (!fp) return (urlCache[seriesKey] = null);
    const ext = path.extname(fp).slice(1).toLowerCase();
    const url = await uploadBuffer(`images/series/${seriesKey}-${crypto.randomUUID().slice(0, 8)}.${ext}`, fs.readFileSync(fp), CT[ext] || "image/png");
    return (urlCache[seriesKey] = url);
  }

  // every model with a code
  const models = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("ceks_models").select("id, model_number, image_url").range(from, from + 999);
    if (error) throw new Error(error.message);
    models.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const perSeries = {};
  let updated = 0;
  const unmatched = new Set();
  for (const m of models) {
    let matchedKey = null;
    for (const c of candidates(m.model_number)) if (fileBySeries[c]) { matchedKey = c; break; }
    if (!matchedKey) { if (candidates(m.model_number).length) unmatched.add(candidates(m.model_number)[0]); continue; }
    const url = await urlFor(matchedKey);
    if (!url) continue;
    const { error } = await supabase.from("ceks_models").update({ image_url: url }).eq("id", m.id);
    if (!error) { updated++; perSeries[matchedKey] = (perSeries[matchedKey] || 0) + 1; }
  }

  console.log("── applied (overwriting any wrong image) ──");
  for (const k of Object.keys(perSeries).sort()) console.log(`  ${k.padEnd(8)} → ${perSeries[k]} product(s)  (from ${path.basename(fileBySeries[k])})`);
  const usedFiles = Object.keys(perSeries);
  const unusedImages = Object.keys(fileBySeries).filter((k) => !usedFiles.includes(k));
  if (unusedImages.length) console.log(`\n  (no products yet for these images: ${unusedImages.join(", ")})`);
  if (unmatched.size) console.log(`\n  ⚠ product series with NO matching image file: ${[...unmatched].join(", ")}`);
  console.log(`\n✔ ${updated} product image(s) set by code.\n`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
