/**
 * SCOPED reset — empties ONLY the equipment-model knowledge graph so the Library and dashboard start
 * from zero for step-by-step testing:
 *   knowledge entries · versions · attributes · notes · links · status history · engine outputs, and
 *   the relational category → equipment_type → brand → model chain.
 *
 * KEEPS everything else, untouched: the Family → Category taxonomy (ceks_equipment_taxonomy), the
 * Engineering Standards (category profiles), the discipline rules, the parameter dictionary, disciplines,
 * engineering requests, import history, and all users/roles.
 *
 * Irreversible, no backup. Refuses to run without the explicit flag:
 *     node cli/wipe-models.js --confirm
 *
 * FK order is resolved by iterate-until-stable deletion; the entries↔versions cycle is broken by
 * nulling current_version_id before versions are deleted (same technique as reset-eos.js).
 */
require("dotenv").config();
const { supabase } = require("../src/config/supabase");

// the equipment-model graph — children before parents (order is also auto-resolved by the loop)
const TARGETS = [
  "ceks_knowledge_attributes", "ceks_engineering_notes", "ceks_knowledge_status_history",
  "ceks_knowledge_links", "ceks_recommendation_history", "ceks_recommendations", "ceks_recalc_alerts",
  "ceks_validations", "ceks_knowledge_versions", "ceks_knowledge_entries",
  "ceks_models", "ceks_brands", "ceks_equipment_types", "ceks_categories",
];
// shown after the wipe to prove the reference data survived
const KEEP_SHOW = [
  "ceks_equipment_taxonomy", "ceks_category_profiles", "ceks_category_profile_attributes",
  "ceks_rules", "ceks_parameters", "ceks_disciplines", "ceks_engineering_requests", "ceks_users",
];

const count = async (t) => { const r = await supabase.from(t).select("*", { count: "exact", head: true }); return r.error ? null : r.count; };
async function delAll(t) {
  // break the entries↔versions cycle before deleting versions
  if (t === "ceks_knowledge_versions") await supabase.from("ceks_knowledge_entries").update({ current_version_id: null }).not("id", "is", null);
  const { error } = await supabase.from(t).delete().not("id", "is", null);
  return error ? error.message : null;
}

(async () => {
  if (!process.argv.includes("--confirm")) {
    console.log("\n  Refusing without --confirm. This empties ONLY the equipment-model graph\n  (keeps taxonomy, Engineering Standards, rules, dictionary, requests, users).\n  Re-run:  node cli/wipe-models.js --confirm\n");
    process.exit(1);
  }
  console.log("\n  SCOPED WIPE — equipment models only …\n  " + "─".repeat(52));
  const remaining = {};
  for (const t of TARGETS) { const c = await count(t); if (c !== null) remaining[t] = c; }
  const present = Object.keys(remaining);
  const before = present.reduce((n, t) => n + remaining[t], 0);
  const lastErr = {};
  let pass = 0;
  while (true) {
    pass++;
    let progressed = false;
    for (const t of present) {
      if (remaining[t] === 0) continue;
      lastErr[t] = await delAll(t);
      const c = await count(t);
      if (c < remaining[t]) progressed = true;
      remaining[t] = c;
    }
    const left = present.filter((t) => remaining[t] > 0);
    if (!left.length) { console.log(`   all ${present.length} model tables empty after ${pass} pass(es)  ·  ${before} rows removed.`); break; }
    if (!progressed || pass > 8) { console.log(`   stopped after ${pass} passes — still holding rows:`); left.forEach((t) => console.log(`     ! ${t}: ${remaining[t]}${lastErr[t] ? " — " + lastErr[t] : ""}`)); break; }
  }
  console.log("  " + "─".repeat(52));
  console.log("  KEPT (verified reference data — untouched):");
  for (const t of KEEP_SHOW) { const c = await count(t); if (c !== null) console.log(`     ${t.padEnd(34)} ${String(c).padStart(5)}`); }
  console.log("");
})().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
