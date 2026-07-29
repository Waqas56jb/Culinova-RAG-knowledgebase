/**
 * READ-ONLY: after a real UI upload, prove the DATABASE matches what the CLI pipeline extracts from
 * the source workbook — category by category, attribute by attribute. Writes NOTHING.
 *
 *   node cli/verify-standards-db.js "CULINOVA_Cooking_Engineering_Standards_v1.0.xlsx" cooking
 *
 * Attributes are fetched PER PROFILE (never one big query) so Supabase's 1000-row default cap can
 * never silently truncate the comparison — that was the SS_Items false alarm.
 */
require("dotenv").config();
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const { supabase } = require("../src/config/supabase");
const dictSvc = require("../src/services/params");
const cat = require("../src/services/categoryProfiles");

const file = process.argv[2] || "CULINOVA_Cooking_Engineering_Standards_v1.0.xlsx";
const domain = process.argv[3] || "cooking";
const norm = (v) => (v == null ? null : String(v).trim() || null);
const key = (s) => String(s || "").trim().toLowerCase();

(async () => {
  const full = path.resolve(__dirname, "../..", file);
  if (!fs.existsSync(full)) { console.error("missing file:", full); process.exit(1); }
  const wb = XLSX.read(fs.readFileSync(full), { type: "buffer" });
  const dict = await dictSvc.load(true);

  // ── EXPECTED (what the CLI pipeline extracts from the Excel) ──
  const { headers, rows } = cat.readSheet(wb);
  const { identityIndex, identityCols } = cat.planColumns(headers);
  const expected = new Map(); // code → { profile, attrs: Map(label → {raw_value,directive,pending}) }
  for (const row of rows) {
    const p = cat.buildProfile(row, identityIndex, domain, file);
    if (!p.code && !p.category_name) continue;
    const attrs = await cat.buildAttributes(row, headers, identityCols, dict);
    const am = new Map();
    for (const a of attrs) am.set(key(a.column_label), { column_label: a.column_label, raw_value: norm(a.raw_value), directive: a.directive, pending: a.pending });
    expected.set(key(p.code), { profile: p, attrs: am });
  }

  // ── ACTUAL (what the UI upload wrote to the DB) ──
  const { data: dbProfiles, error } = await supabase
    .from("ceks_category_profiles")
    .select("id, code, category_name, family, engineering_group, classifier, status, version, engineer_approval_required")
    .eq("domain", domain);
  if (error) { console.error("DB error:", error.message); process.exit(1); }

  console.log(`\nFILE: ${file}   DOMAIN: ${domain}`);
  console.log(`CLI-expected categories: ${expected.size}   ·   DB categories: ${(dbProfiles || []).length}`);

  const dbByCode = new Map((dbProfiles || []).map((p) => [key(p.code), p]));
  const mismatches = [];
  let attrPairsChecked = 0, attrExactDb = 0, catsExact = 0;

  // categories present on one side only
  for (const c of expected.keys()) if (!dbByCode.has(c)) mismatches.push(`CATEGORY MISSING IN DB: ${c}`);
  for (const c of dbByCode.keys()) if (!expected.has(c)) mismatches.push(`EXTRA CATEGORY IN DB (not in file): ${c}`);

  // compare each category that exists on both sides
  for (const [code, exp] of expected) {
    const db = dbByCode.get(code);
    if (!db) continue;
    const catIssues = [];

    // identity fields
    const idFields = [
      ["category_name", exp.profile.category_name],
      ["family", exp.profile.family],
      ["engineering_group", exp.profile.engineering_group],
      ["classifier", exp.profile.classifier],
      ["status", exp.profile.status],
      ["version", exp.profile.version],
      ["engineer_approval_required", exp.profile.engineer_approval_required],
    ];
    for (const [f, ev] of idFields) {
      const dv = db[f];
      const same = f === "engineer_approval_required" ? Boolean(ev) === Boolean(dv) : key(ev) === key(dv);
      if (!same) catIssues.push(`  ${f}: file=${JSON.stringify(ev)}  DB=${JSON.stringify(dv)}`);
    }

    // attributes — fetch THIS profile's rows only (≤ ~90; never hits the 1000 cap)
    const { data: dbAttrs } = await supabase
      .from("ceks_category_profile_attributes")
      .select("column_label, raw_value, directive, pending")
      .eq("profile_id", db.id);
    const dbAttrMap = new Map((dbAttrs || []).map((a) => [key(a.column_label), a]));

    for (const [lbl, ea] of exp.attrs) {
      attrPairsChecked++;
      const da = dbAttrMap.get(lbl);
      if (!da) { catIssues.push(`  ATTR MISSING IN DB: "${ea.column_label}" (=${JSON.stringify(ea.raw_value)})`); continue; }
      const vOk = key(ea.raw_value) === key(da.raw_value);
      const dOk = ea.directive === da.directive;
      const pOk = Boolean(ea.pending) === Boolean(da.pending);
      if (vOk && dOk && pOk) attrExactDb++;
      else catIssues.push(`  ATTR DIFF "${ea.column_label}": file={val:${JSON.stringify(ea.raw_value)},dir:${ea.directive},pend:${ea.pending}}  DB={val:${JSON.stringify(da.raw_value)},dir:${da.directive},pend:${da.pending}}`);
    }
    for (const lbl of dbAttrMap.keys()) if (!exp.attrs.has(lbl)) catIssues.push(`  EXTRA ATTR IN DB: "${dbAttrMap.get(lbl).column_label}"`);

    if (catIssues.length) mismatches.push(`✗ ${code} (${exp.profile.category_name}):\n${catIssues.join("\n")}`);
    else catsExact++;
  }

  console.log(`\n═══ RESULT ═══`);
  console.log(`categories exact (identity + every attribute): ${catsExact}/${expected.size}`);
  console.log(`attribute cells checked: ${attrPairsChecked}   ·   exact value+directive+pending match: ${attrExactDb}`);
  if (mismatches.length) {
    console.log(`\n⚠ MISMATCHES (${mismatches.length}):\n`);
    mismatches.forEach((m) => console.log(m + "\n"));
    console.log("RESULT: ✗ DB does NOT fully match the file — see above.");
    process.exit(2);
  }
  console.log(`\nRESULT: ✅ PERFECT — the DB is an EXACT match of the CLI extraction. Zero differences.`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
