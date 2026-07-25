/**
 * Standardise duplicate / case-variant brands into one consistent identity per company.
 *
 * The client flagged: "We have multiple brands representing the same company — CULINOVA,
 * CULINOVA Standard, CULINOX. We need one consistent brand identity; product lines / standards
 * should be handled separately, not as different brands." Plus obvious case duplicates
 * (NOVA COOL / Nova cool, BARTSCHER / Bartscher, FAGOR / Fagor / Fafor).
 *
 * This maps every variant to its canonical brand across:
 *   • ceks_knowledge_entries.brand   (the value users see and filter on)
 *   • ceks_knowledge_entries.title   (re-titled so "CULINOVA Standard TBS.70" → "CULINOVA TBS.70")
 *   • ceks_brands.name               (the brand master)
 *
 * The CANONICAL map is the single source of truth — edit it, not the data. Run:
 *   node cli/standardize-brands.js            (apply)
 *   node cli/standardize-brands.js --dry-run  (show what would change, write nothing)
 */
require("dotenv").config();
const { supabase } = require("../src/config/supabase");
const { canonicalBrand, loadAliases } = require("../src/utils/brandCanonical");

// The canonical map is now the SHARED module used at import time too, so the CLI and create-time can
// never disagree. Returns null when a brand is already canonical (nothing to change).
const canonicalOf = (name) => {
  const canon = canonicalBrand(name);
  return canon === name ? null : canon;
};

async function run(dryRun) {
  await loadAliases(supabase); // hydrate any client-added aliases from ceks_brand_aliases (if present)
  console.log(`\n  Standardising brands${dryRun ? " (DRY RUN — nothing is written)" : ""}\n  ${"─".repeat(50)}`);

  // 1) entries — brand + title
  const { data: entries } = await supabase
    .from("ceks_knowledge_entries")
    .select("id, brand, title, code, model_number");
  let entryChanges = 0;
  const summary = {};
  for (const e of entries || []) {
    const canon = canonicalOf(e.brand);
    if (!canon || canon === e.brand) continue;
    const key = `${e.brand} → ${canon}`;
    summary[key] = (summary[key] || 0) + 1;
    entryChanges++;
    if (!dryRun) {
      const patch = { brand: canon };
      // re-title: replace a leading old-brand prefix with the canonical one
      if (e.title && e.title.startsWith(e.brand)) {
        patch.title = `${canon}${e.title.slice(e.brand.length)}`;
      }
      await supabase.from("ceks_knowledge_entries").update(patch).eq("id", e.id);
    }
  }
  console.log("  entries:");
  for (const [k, v] of Object.entries(summary)) console.log(`    ${k}  (${v})`);
  if (!entryChanges) console.log("    (none)");

  // 2) brand master — rename variants to canonical (duplicates that collapse are harmless: the name
  //    is not unique-constrained, and models still point at their brand_id)
  const { data: brands } = await supabase.from("ceks_brands").select("id, name");
  let brandChanges = 0;
  for (const b of brands || []) {
    const canon = canonicalOf(b.name);
    if (!canon || canon === b.name) continue;
    brandChanges++;
    if (!dryRun) await supabase.from("ceks_brands").update({ name: canon }).eq("id", b.id);
  }
  console.log(`  brand master rows renamed: ${brandChanges}`);

  // 3) verify
  if (!dryRun) {
    const { data: after } = await supabase.from("ceks_knowledge_entries").select("brand");
    const c = {};
    for (const r of after || []) { const v = r.brand || "(none)"; c[v] = (c[v] || 0) + 1; }
    const culinova = ["CULINOVA", "CULINOVA Standard", "CULINOX", "Culinox"].reduce((s, k) => s + (c[k] || 0), 0);
    console.log(`\n  after: CULINOVA now ${c["CULINOVA"] || 0} entries (was split across CULINOVA/CULINOVA Standard/CULINOX).`);
    console.log("  distinct brands now:", Object.keys(c).length);
  }
  console.log(`  ${"─".repeat(50)}\n  ${dryRun ? "Dry run complete." : "Done."}\n`);
}

run(process.argv.includes("--dry-run")).then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
