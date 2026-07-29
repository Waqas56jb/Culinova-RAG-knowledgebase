/**
 * READ-ONLY diagnostic for the CULINOVA Engineering Standards (category-profile) workbooks.
 * Runs the REAL categoryProfiles pipeline (readSheet → planColumns → buildProfile → buildAttributes →
 * classifyCell) and shows, with FULL untruncated values, exactly how every column is classified and
 * what every cell resolves to — so we can catch any mis-classification before a real upload.
 *
 * Writes NOTHING to the database.
 *
 *   node cli/probe-standards.js "CULINOVA_Cooking_Engineering_Standards_v1.0.xlsx" cooking
 *   node cli/probe-standards.js "<file>" <domain> --rows        # also dump every row's identity
 */
require("dotenv").config();
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const cat = require("../src/services/categoryProfiles");

const file = process.argv[2] || "CULINOVA_Cooking_Engineering_Standards_v1.0.xlsx";
const domain = process.argv[3] || "cooking";
const SHOW_ROWS = process.argv.includes("--rows");

// identity keys, for reporting
const IDENTITY_KEYS = ["code", "category_name", "family", "engineering_group", "classifier", "approval", "status", "version", "commissioning", "notes"];

(async () => {
  const full = path.resolve(__dirname, "../..", file);
  if (!fs.existsSync(full)) { console.error("missing file:", full); process.exit(1); }
  const wb = XLSX.read(fs.readFileSync(full), { type: "buffer" });

  console.log(`\nFILE: ${file}   (domain: ${domain})`);
  console.log("SHEETS:", wb.SheetNames.join(" | "));
  console.log(`IMPORTED SHEET: "${wb.SheetNames[0]}"  ← categoryProfiles reads ONLY the first sheet (README is ignored)\n`);

  // load the parameter dictionary read-only (parameter linkage is best-effort; never blocks import)
  let dict = { paramById: new Map(), resolveParameter: () => null };
  try {
    const dictSvc = require("../src/services/params");
    dict = await dictSvc.load(true);
    console.log(`parameter dictionary loaded (best-effort linkage)\n`);
  } catch (e) {
    console.log(`⚠ dictionary not loaded (${e.message}) — parameter_id linkage will show null; classification is unaffected\n`);
  }

  const { headers, rows } = cat.readSheet(wb);
  const { identityIndex, identityCols } = cat.planColumns(headers);

  // ── COLUMN PLAN ──
  console.log(`═══ COLUMN PLAN ═══  (${headers.length} columns, ${rows.length} data rows)`);
  const idxToIdentity = {};
  for (const k of IDENTITY_KEYS) if (identityIndex[k] != null) idxToIdentity[identityIndex[k]] = k;
  headers.forEach((h, i) => {
    const tag = identityCols.has(i) ? `IDENTITY → ${idxToIdentity[i] || "?"}` : "attribute";
    console.log(`  [${String(i).padStart(2)}] ${String(h || "(blank)").padEnd(32)} → ${tag}`);
  });
  // which identity keys never found a column?
  const missingIdentity = IDENTITY_KEYS.filter((k) => identityIndex[k] == null);
  console.log("\n  identity columns mapped:", IDENTITY_KEYS.filter((k) => identityIndex[k] != null).join(", "));
  if (missingIdentity.length) console.log("  identity keys with NO column:", missingIdentity.join(", "));

  // ── PER-CELL CLASSIFICATION, grouped by directive with DISTINCT full values ──
  const byDirective = {};              // directive → Map(rawValue → count)
  const perColumnDirectives = {};      // column_label → Set(directives)  (catch a column split across directives)
  const tally = {};
  let totalAttrs = 0;
  const rowIdentities = [];

  for (const row of rows) {
    const profile = cat.buildProfile(row ? row : [], identityIndex, domain, file);
    if (!profile.code && !profile.category_name) continue;
    rowIdentities.push(profile);
    for (let i = 0; i < headers.length; i++) {
      if (identityCols.has(i)) continue;
      const label = headers[i];
      if (!label) continue;
      const cls = cat.classifyCell(row[i]);
      if (!cls) continue;
      totalAttrs++;
      tally[cls.directive] = (tally[cls.directive] || 0) + 1;
      const raw = row[i] == null ? "" : String(row[i]).trim();
      byDirective[cls.directive] = byDirective[cls.directive] || new Map();
      byDirective[cls.directive].set(raw, (byDirective[cls.directive].get(raw) || 0) + 1);
      (perColumnDirectives[label] = perColumnDirectives[label] || new Set()).add(cls.directive);
    }
  }

  console.log(`\n═══ DIRECTIVE TALLY ═══  (${totalAttrs} attribute cells across ${rowIdentities.length} categories)`);
  for (const [d, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(16)} ${n}`);

  console.log(`\n═══ DISTINCT VALUES PER DIRECTIVE ═══  (verify every value belongs under its directive)`);
  for (const d of Object.keys(byDirective).sort()) {
    const m = byDirective[d];
    console.log(`\n  ▸ ${d}  (${m.size} distinct)`);
    for (const [v, n] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`      ${String(n).padStart(3)}×  ${JSON.stringify(v)}`);
    }
  }

  // ── GAP SCAN ──
  console.log(`\n═══ GAP SCAN ═══`);
  const flags = [];
  // NOTE: use `== null`, not `!x` — column index 0 is a valid mapping but falsy in JS.
  if (identityIndex.code == null) flags.push("no CODE identity column (Rule ID / Category Code)");
  if (identityIndex.category_name == null) flags.push("no CATEGORY NAME identity column");
  // a "fixed" value that smells like it should have been another directive is a REAL mis-classification
  const fixedVals = byDirective.fixed ? [...byDirective.fixed.keys()] : [];
  for (const v of fixedVals) {
    if (/^n\s*\/?\s*a$/i.test(v)) flags.push(`"${v}" classified fixed but looks like N/A`);
    if (/culinova/i.test(v) && /rule/i.test(v)) flags.push(`"${v}" classified fixed but mentions a CULINOVA rule`);
    if (/ashrae|calculation/i.test(v)) flags.push(`"${v}" classified fixed but mentions calculation/ASHRAE`);
    if (v.includes("→")) flags.push(`"${v}" classified fixed but contains an arrow chain`);
  }
  console.log(flags.length ? flags.map((f) => "  ⚠ " + f).join("\n") : "  ✓ no classification flags");

  // STRUCTURAL WARNINGS — shifted/extra cells (data under a blank column, bad Status/Version). Real defects.
  const sw = cat.detectStructuralIssues(headers, rows, identityIndex);
  console.log(`\n═══ STRUCTURAL WARNINGS ═══  (shifted / extra cells — a human must fix these in the source)`);
  if (sw.length) sw.forEach((w) => w.issues.forEach((iss) => console.log(`  ⚠ row ${w.row} · ${w.code}: ${iss}`)));
  else console.log("  ✓ none — every row's columns line up");

  // INFORMATIONAL — a column carrying different directives across categories is EXPECTED (one category's
  // drain is N/A, another's is Gravity, another's is Manufacturer-dependent). Shown, not flagged as a fault.
  const multi = Object.entries(perColumnDirectives).filter(([, s]) => s.size >= 3);
  if (multi.length) {
    console.log("\n  (info) columns carrying several directives across categories — expected variety, not an error:");
    for (const [label, set] of multi) console.log(`    · ${label}: ${[...set].join(", ")}`);
  }

  if (SHOW_ROWS) {
    console.log(`\n═══ PER-ROW IDENTITY ═══`);
    rowIdentities.forEach((p, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${p.code || "(no code)"}  ·  ${p.category_name}  ·  family=${p.family}  ·  group=${p.engineering_group}  ·  classifier=${p.classifier}  ·  approval=${p.engineer_approval_required}  ·  status=${p.status}  ·  ver=${p.version}`);
    });
  }

  console.log(`\nDONE — read-only, nothing written.\n`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
