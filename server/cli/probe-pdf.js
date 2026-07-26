/**
 * READ-ONLY diagnostic: run the real PDF extraction on every file in ../pdf and cross-check the result
 * against the raw PDF text, so we can honestly see whether the model + specs are right, nothing is
 * hallucinated, and nothing is missed. Writes NOTHING to the database.
 *
 *   node cli/probe-pdf.js                 # all PDFs in ../pdf
 *   node cli/probe-pdf.js XEFR-10EU...pdf # one file
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { extractPages } = require("../src/services/pdf");
const { extractFromPdf } = require("../src/services/extraction");

const PDF_DIR = path.resolve(__dirname, "../../pdf");
const OUT = path.resolve(__dirname, "../../pdf-probe-results.json");
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function probe(file) {
  const buf = fs.readFileSync(path.join(PDF_DIR, file));
  let rawText = "", numpages = 0;
  try { const r = await extractPages(buf); rawText = (r.pages || []).join("\n"); numpages = r.numpages || (r.pages || []).length; } catch { rawText = ""; }
  const textLen = rawText.replace(/\s+/g, "").length;

  const t0 = Date.now();
  let res, err = null;
  try { res = await extractFromPdf(buf, "Datasheet", file); }
  catch (e) { err = e.message; res = { model: {}, attributes: [], notes: [] }; }
  const ms = Date.now() - t0;

  const m = res.model || {};
  const attrs = res.attributes || [];
  const ntext = norm(rawText);

  // Honesty cross-checks against the raw text.
  const modelInText = m.model_number ? ntext.includes(norm(m.model_number)) : null;
  const brandInText = m.brand ? ntext.includes(norm(m.brand)) : null;
  let grounded = 0, checked = 0;
  const ungroundedSamples = [];
  for (const a of attrs) {
    const v = String(a.value || "").trim();
    if (!v) continue;
    checked++;
    if (ntext.includes(norm(v))) grounded++;
    else if (ungroundedSamples.length < 8) ungroundedSamples.push(`${a.name}=${v}${a.unit ? " " + a.unit : ""}`);
  }
  const groundPct = checked ? Math.round((grounded / checked) * 100) : null;
  const usedVision = textLen < 400; // pure-scan → vision; hybrid/escalation may also add vision

  return {
    file, numpages, textLen, usedVision, ms, err,
    model: { brand: m.brand, model_number: m.model_number, category: m.category, equipment_type: m.equipment_type, power_type: m.power_type, series: m.series },
    attrCount: attrs.length, noteCount: (res.notes || []).length,
    modelInText, brandInText, groundPct, checked,
    ungroundedSamples, attrs,
  };
}

(async () => {
  const arg = process.argv[2];
  const files = arg ? [arg] : fs.readdirSync(PDF_DIR).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  console.log(`\n  Probing ${files.length} PDF(s) from ${PDF_DIR}\n  ${"═".repeat(70)}`);
  const all = [];
  for (const f of files) {
    process.stdout.write(`\n  ▶ ${f}\n`);
    const r = await probe(f).catch((e) => ({ file: f, fatal: e.message }));
    all.push(r);
    fs.writeFileSync(OUT, JSON.stringify(all, null, 2)); // incremental save
    if (r.fatal) { console.log(`     FATAL: ${r.fatal}`); continue; }
    console.log(`     pages=${r.numpages} textChars=${r.textLen} path=${r.usedVision ? "VISION" : "text(+vision if needed)"} time=${(r.ms / 1000).toFixed(1)}s${r.err ? " ERROR=" + r.err : ""}`);
    console.log(`     MODEL: brand=${JSON.stringify(r.model.brand)} model_number=${JSON.stringify(r.model.model_number)} type=${JSON.stringify(r.model.equipment_type)} power=${JSON.stringify(r.model.power_type)}`);
    console.log(`     model_number printed in text? ${r.modelInText === null ? "n/a" : r.modelInText ? "YES ✓" : "NO ✗ (from graphic/vision — verify)"}   brand in text? ${r.brandInText === null ? "n/a" : r.brandInText ? "YES ✓" : "NO"}`);
    console.log(`     attributes=${r.attrCount}  notes=${r.noteCount}  value-grounding=${r.groundPct === null ? "n/a" : r.groundPct + "% of " + r.checked + " values found verbatim in text"}`);
    if (r.ungroundedSamples.length) console.log(`     values NOT found verbatim in text (vision-derived or need review): ${r.ungroundedSamples.join(" | ")}`);
  }
  console.log(`\n  ${"═".repeat(70)}\n  Full JSON (all attributes per PDF) saved to: ${OUT}\n`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
