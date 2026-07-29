/**
 * READ-ONLY: prove the discipline RULES in the database match what the CLI extracts from the source
 * rules workbook — every rule's conditions and outputs, exactly. Writes NOTHING.
 *
 *   node cli/verify-rules-db.js "../ELECTRICAL.xlsx" electrical
 */
require("dotenv").config();
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const { supabase } = require("../src/config/supabase");
const dictSvc = require("../src/services/params");
const ruleImport = require("../src/services/ruleImport");

const fileArg = process.argv[2] || "../ELECTRICAL.xlsx";
const discCode = process.argv[3] || "electrical";
const clean = (s) => String(s ?? "").trim();

const cKey = (c) => JSON.stringify({
  p: c.parameter_id,
  op: c.operator,
  n: c.value_num == null ? null : Number(c.value_num),
  t: c.value_text == null ? null : clean(c.value_text),
  mn: c.value_min == null ? null : Number(c.value_min),
  mx: c.value_max == null ? null : Number(c.value_max),
  l: Array.isArray(c.value_list) ? c.value_list.map((x) => clean(x)).sort() : null,
  u: c.unit == null ? null : clean(c.unit),
});
const oKey = (o) => JSON.stringify({
  p: o.parameter_id,
  t: o.value_text == null ? null : clean(o.value_text),
  n: o.value_num == null ? null : Number(o.value_num),
  u: o.unit == null ? null : clean(o.unit),
});
const multiset = (arr) => arr.map((x) => x).sort();
const sameSet = (a, b) => a.length === b.length && multiset(a).every((v, i) => v === multiset(b)[i]);

(async () => {
  const full = path.isAbsolute(fileArg) ? fileArg : path.resolve(__dirname, "..", fileArg);
  if (!fs.existsSync(full)) { console.error("missing file:", full); process.exit(1); }
  const wb = XLSX.read(fs.readFileSync(full), { type: "buffer" });
  const dict = await dictSvc.load(true);

  const { data: disc } = await supabase.from("ceks_disciplines").select("id,name").eq("code", discCode).maybeSingle();
  if (!disc) { console.error("discipline not found:", discCode); process.exit(1); }

  // EXPECTED from the workbook (same pipeline the importer uses)
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  const headers = (raw[0] || []).map(clean);
  const rows = raw.slice(1);
  const plan = await ruleImport.planColumns(headers, dict);
  const expected = new Map();
  rows.forEach((r, i) => {
    const rule = ruleImport.rowToRule(r, plan, dict, disc.id, i);
    if (rule._issues.length) return;            // only rules that would import
    expected.set(clean(rule.code), rule);
  });

  console.log(`\nFILE: ${fileArg}   DISCIPLINE: ${disc.name}`);
  console.log(`CLI-ready rules: ${expected.size}`);

  // ACTUAL from the DB
  const { data: dbRules } = await supabase
    .from("ceks_rules").select("id, code, name, description").eq("discipline_id", disc.id);
  const dbByCode = new Map((dbRules || []).map((r) => [clean(r.code), r]));
  console.log(`DB rules (this discipline): ${(dbRules || []).length}`);

  const mismatches = [];
  for (const c of expected.keys()) if (!dbByCode.has(c)) mismatches.push(`RULE MISSING IN DB: ${c}`);

  let exact = 0, condsChecked = 0, outsChecked = 0;
  for (const [code, exp] of expected) {
    const db = dbByCode.get(code);
    if (!db) continue;
    const issues = [];

    const { data: dbConds } = await supabase.from("ceks_rule_conditions").select("*").eq("rule_id", db.id);
    const { data: dbOuts } = await supabase.from("ceks_rule_outputs").select("*").eq("rule_id", db.id);

    const expCondKeys = exp.conditions.map(cKey);
    const dbCondKeys = (dbConds || []).map(cKey);
    condsChecked += expCondKeys.length;
    if (!sameSet(expCondKeys, dbCondKeys)) {
      issues.push(`  CONDITIONS differ:\n    file: ${expCondKeys.join("\n          ")}\n    DB:   ${dbCondKeys.join("\n          ")}`);
    }

    const expOutKeys = exp.outputs.map(oKey);
    const dbOutKeys = (dbOuts || []).map(oKey);
    outsChecked += expOutKeys.length;
    if (!sameSet(expOutKeys, dbOutKeys)) {
      issues.push(`  OUTPUTS differ:\n    file: ${expOutKeys.join("\n          ")}\n    DB:   ${dbOutKeys.join("\n          ")}`);
    }

    if (issues.length) mismatches.push(`✗ ${code} (${exp.description || ""}):\n${issues.join("\n")}`);
    else exact++;
  }

  console.log(`\n═══ RESULT ═══`);
  console.log(`rules exact (all conditions + all outputs): ${exact}/${expected.size}`);
  console.log(`condition rows checked: ${condsChecked}   ·   output rows checked: ${outsChecked}`);
  if (mismatches.length) {
    console.log(`\n⚠ MISMATCHES (${mismatches.length}):\n`);
    mismatches.forEach((m) => console.log(m + "\n"));
    process.exit(2);
  }
  console.log(`\nRESULT: ✅ PERFECT — every DB rule's conditions and outputs exactly match the workbook.`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
