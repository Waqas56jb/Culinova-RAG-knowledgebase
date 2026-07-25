/**
 * Backfill the `unit` column for equipment attributes imported BEFORE header/value unit-parsing existed.
 *
 * Older imports stored the unit stuck inside the field name ("Length (mm)*") or inside the value cell
 * ("1 mm"), leaving the dedicated `unit` column blank — so the Review/Library screen showed an empty
 * UNIT column even though the unit was right there in the data. This normalises every existing
 * attribute to the SAME shape a fresh import now produces, reusing the exact same parsers
 * (parseHeader + splitValueUnit) so the CLI and import can never disagree:
 *
 *   name "Length (mm)*"  value "2400"  unit ∅  →  name "Length"    value "2400"  unit "mm"
 *   name "Thickness*"    value "1 mm"  unit ∅  →  name "Thickness"  value "1"     unit "mm"
 *   name "Material*"     value "SS304" unit ∅  →  name "Material"   value "SS304" unit ∅   (name cleaned)
 *
 * The "*" (a mandatory marker) is stripped from the name because mandatory-ness is driven by the
 * category profile, not by a "*" baked into the field name — matching what the importer already does.
 *
 * Safety: never overwrites a unit that is already set; only splits a value when it is a number
 * followed by a RECOGNISED unit token, so real values (SS304, Brushed, TABLE MOUNTED…) are untouched.
 *
 *   node cli/backfill-units.js --dry-run   (show what would change, write nothing)
 *   node cli/backfill-units.js             (apply)
 */
require("dotenv").config();
const { supabase } = require("../src/config/supabase");
const { parseHeader, splitValueUnit, UNIT_TOKENS, unitKey } = require("../src/services/productCatalogImport");

// Is `u` a genuine unit, not a descriptive qualifier? parseHeader treats ANY trailing parenthetical as
// a unit, so "Phase (Standard)" / "Weight (Alpha35)" / "Connected Load (Electric)" would otherwise be
// mis-read. Accept only a recognised unit token — or a compound like "L×W×D mm" that CONTAINS one.
function isRealUnit(u) {
  if (!u) return false;
  if (UNIT_TOKENS.has(unitKey(u))) return true;
  return u.split(/[\s×xX/·,()]+/).filter(Boolean).some((t) => UNIT_TOKENS.has(unitKey(t)));
}

// Work out the change (if any) for one attribute row. Returns a patch object or null.
// SAFETY: only rows with a BLANK unit are ever touched — a row that already has a unit was imported
// correctly and is left completely alone (so real qualifiers in its name are never stripped).
function planPatch(a) {
  if (a.unit) return null;
  const name = (a.name || "").trim();
  const ph = parseHeader(name);

  // A) a genuine unit lives in the field name ("Length (mm)*" → name "Length", unit "mm")
  if (ph.unit && isRealUnit(ph.unit)) {
    const patch = { unit: ph.unit };
    if (ph.name && ph.name !== name) patch.name = ph.name; // parseHeader already stripped "*" and "(unit)"
    return patch;
  }

  // B) a genuine unit lives in the value cell ("1 mm" → value "1", unit "mm")
  const sv = splitValueUnit(a.value);
  if (sv.unit) {
    const patch = { unit: sv.unit, value: sv.value };
    const cleaned = name.replace(/\*/g, "").trim(); // strip ONLY the mandatory marker, keep qualifiers
    if (cleaned && cleaned !== name) patch.name = cleaned;
    return patch;
  }

  return null; // no confident unit — leave the row untouched
}

async function run(dryRun) {
  console.log(`\n  Backfilling attribute units${dryRun ? " (DRY RUN — nothing is written)" : ""}\n  ${"─".repeat(56)}`);
  const pageSize = 1000;
  let from = 0, scanned = 0, changed = 0, failed = 0;
  const examples = [];

  for (;;) {
    const { data, error } = await supabase
      .from("ceks_knowledge_attributes")
      .select("id, name, value, unit")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    scanned += data.length;

    for (const a of data) {
      const patch = planPatch(a);
      if (!patch) continue;
      changed++;
      if (examples.length < 20) {
        examples.push(`    ${JSON.stringify({ name: a.name, value: a.value, unit: a.unit })}  →  ${JSON.stringify(patch)}`);
      }
      if (!dryRun) {
        const { error: ue } = await supabase.from("ceks_knowledge_attributes").update(patch).eq("id", a.id);
        if (ue) { failed++; console.error(`    update failed ${a.id}: ${ue.message}`); }
      }
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log("  examples:");
  examples.forEach((e) => console.log(e));
  console.log(`  ${"─".repeat(56)}`);
  console.log(`  scanned: ${scanned}   ${dryRun ? "would change" : "changed"}: ${changed}${failed ? `   failed: ${failed}` : ""}`);
  console.log(`  ${dryRun ? "Dry run complete — re-run without --dry-run to apply." : "Done."}\n`);
}

run(process.argv.includes("--dry-run"))
  .then(() => process.exit(0))
  .catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
