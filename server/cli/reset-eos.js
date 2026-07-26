/**
 * DANGER — full EOS content reset. Empties EVERY content/config table (knowledge library, dictionary,
 * category profiles, rules, drawings, engineering requests, import history…) so the system can be
 * re-tested from a blank slate. KEEPS ONLY the auth tables (users, roles, permissions, sessions) so you
 * can still log in and drive the import from the UI.
 *
 * This is irreversible and has NO backup. It refuses to run without the explicit flag:
 *
 *     node cli/reset-eos.js --confirm
 *
 * Iterate-until-stable deletion resolves foreign-key order automatically; the entries<->versions cycle
 * is broken by nulling current_version_id first.
 */
require("dotenv").config();
const { supabase } = require("../src/config/supabase");

const KEEP = new Set(["ceks_users", "ceks_roles", "ceks_user_roles", "ceks_role_permissions", "ceks_permissions", "ceks_sessions"]);

const ALL = [
  "ceks_audit_log", "ceks_brand_aliases", "ceks_brands", "ceks_categories", "ceks_category_profile_attributes",
  "ceks_category_profiles", "ceks_disciplines", "ceks_drawing_annotations", "ceks_drawing_placements",
  "ceks_drawing_points", "ceks_drawing_revisions", "ceks_drawings", "ceks_engine_settings", "ceks_engineering_notes",
  "ceks_engineering_requests", "ceks_equipment_types", "ceks_file_assets", "ceks_import_documents", "ceks_import_jobs",
  "ceks_knowledge_attributes", "ceks_knowledge_entries", "ceks_knowledge_links", "ceks_knowledge_status_history",
  "ceks_knowledge_types", "ceks_knowledge_versions", "ceks_models", "ceks_parameter_aliases", "ceks_parameters",
  "ceks_project_item_revisions", "ceks_project_items", "ceks_projects", "ceks_recalc_alerts",
  "ceks_recommendation_history", "ceks_recommendations", "ceks_rule_conditions", "ceks_rule_constants",
  "ceks_rule_outputs", "ceks_rule_versions", "ceks_rules", "ceks_schedule_types", "ceks_unit_conversions",
  "ceks_utility_point_types", "ceks_validations", "ceks_value_normalizations",
];
const TARGETS = ALL.filter((t) => !KEEP.has(t));

const count = async (t) => { const r = await supabase.from(t).select("*", { count: "exact", head: true }); return r.error ? null : r.count; };
async function delAll(t) {
  if (t === "ceks_knowledge_versions") await supabase.from("ceks_knowledge_entries").update({ current_version_id: null }).not("id", "is", null);
  const { error } = await supabase.from(t).delete().not("id", "is", null);
  return error ? error.message : null;
}

async function run() {
  if (!process.argv.includes("--confirm")) {
    console.log("\n  Refusing to run without --confirm. This EMPTIES every EOS content table (keeps only login).\n  Re-run:  node cli/reset-eos.js --confirm\n");
    process.exit(1);
  }
  console.log("\n  FULL EOS content reset (keeping auth) …\n  " + "─".repeat(52));
  const remaining = {};
  for (const t of TARGETS) { const c = await count(t); if (c !== null) remaining[t] = c; }
  const present = Object.keys(remaining);
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
    if (!left.length) { console.log(`   all ${present.length} content tables empty after ${pass} pass(es).`); break; }
    if (!progressed || pass > 8) { console.log(`   stopped after ${pass} passes — ${left.length} table(s) still hold rows.`); break; }
  }
  console.log("  " + "─".repeat(52));
  const stuck = present.filter((t) => remaining[t] > 0);
  console.log(`   cleared ${present.length - stuck.length}/${present.length} content tables.`);
  for (const t of stuck) console.log(`     ! ${t}: ${remaining[t]} left${lastErr[t] ? " — " + lastErr[t] : ""}`);
  console.log("\n  KEPT (auth — you can still log in):");
  for (const t of KEEP) { const c = await count(t); if (c !== null) console.log(`     ${t.padEnd(26)} ${String(c).padStart(5)}`); }
  console.log("");
}

run().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
