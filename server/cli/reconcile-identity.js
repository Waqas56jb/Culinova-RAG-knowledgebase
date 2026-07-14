/**
 * IDENTITY RECONCILIATION — clean up the equipment identity hierarchy.
 *
 * The find-or-create ingestion path can leave two kinds of debris:
 *   1. ORPHANED MODELS — ceks_models rows with no ceks_knowledge_links pointing at them (an entry's
 *      identity was corrected, and the old model was left dangling).
 *   2. DUPLICATE brands / categories — the same name stored twice with different casing/whitespace.
 *
 * This tool REPORTS both, and (with --apply) deletes the orphaned models. It is DRY-RUN by default,
 * refuses to touch a model that is still referenced, and never merges brand/category rows
 * automatically — that is surfaced for a human, because a wrong merge is hard to undo.
 *
 *   node cli/reconcile-identity.js            # report only (safe)
 *   node cli/reconcile-identity.js --apply    # additionally delete orphaned models
 */
require("dotenv").config();
const { supabase } = require("../src/config/supabase");

const APPLY = process.argv.includes("--apply");
const norm = (s) => String(s ?? "").trim().toLowerCase();

async function allRows(table, columns) {
  // page past PostgREST's 1000-row cap so the report is exact
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return out;
}

function duplicateGroups(rows, nameKey) {
  const byName = new Map();
  for (const r of rows) {
    const k = norm(r[nameKey]);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  return [...byName.entries()].filter(([, g]) => g.length > 1);
}

(async () => {
  console.log(`\n######## IDENTITY RECONCILIATION ${APPLY ? "(APPLY)" : "(dry-run)"} ########\n`);

  const [models, links, brands, categories] = await Promise.all([
    allRows("ceks_models", "id, model_number, display_name, brand_id, created_at"),
    allRows("ceks_knowledge_links", "scope_id, scope_type"),
    allRows("ceks_brands", "id, name, equipment_type_id"),
    allRows("ceks_categories", "id, name"),
  ]);

  const linkedModelIds = new Set(links.filter((l) => l.scope_type === "model").map((l) => String(l.scope_id)));
  const orphans = models.filter((m) => !linkedModelIds.has(String(m.id)));

  console.log(`Models: ${models.length} · linked: ${linkedModelIds.size} · ORPHANED: ${orphans.length}`);
  for (const o of orphans.slice(0, 25)) console.log(`  · ${o.model_number || o.display_name || o.id}  (${o.id})`);
  if (orphans.length > 25) console.log(`  … and ${orphans.length - 25} more`);

  const dupBrands = duplicateGroups(brands, "name");
  const dupCats = duplicateGroups(categories, "name");
  console.log(`\nDuplicate brand names: ${dupBrands.length}`);
  for (const [name, g] of dupBrands.slice(0, 15)) console.log(`  · "${g[0].name}" ×${g.length}`);
  console.log(`Duplicate category names: ${dupCats.length}`);
  for (const [name, g] of dupCats.slice(0, 15)) console.log(`  · "${g[0].name}" ×${g.length}`);

  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to delete the ${orphans.length} orphaned model(s).`);
    console.log(`Duplicate brands/categories are reported only — merge them deliberately from the Admin Portal.\n`);
    process.exit(0);
  }

  let deleted = 0;
  for (const o of orphans) {
    // last-chance guard: never delete a model that something still references
    const { count } = await supabase.from("ceks_knowledge_links").select("scope_id", { count: "exact", head: true }).eq("scope_id", o.id);
    if (count && count > 0) continue;
    const { error } = await supabase.from("ceks_models").delete().eq("id", o.id);
    if (error) { console.warn(`  ✗ ${o.id}: ${error.message}`); continue; }
    deleted++;
  }
  console.log(`\n✔ Deleted ${deleted} orphaned model(s). Duplicate brands/categories left for manual review.\n`);
  process.exit(0);
})().catch((e) => {
  console.error("\n✖ RECONCILIATION FAILED:", e.message);
  process.exit(1);
});
