/**
 * SAME CODE → SAME PHOTO.
 *
 * The client's catalogues list one product per size within a series (COS.704-2, COS.804-2, … OS.2404-1,
 * OS.2404-2 …) but embed the photo on only ONE row of each series. This links that photo across the
 * whole series automatically: every model whose image is blank inherits the image of another model in
 * the SAME series. It only ever FILLS a blank — it never overwrites an image a product already has.
 *
 * The "series" is the code's letter prefix plus its tier suffix (-1 / -2), with the size number ignored:
 *   COS.704-2 → "COS-2"     OS.2404-1 → "OS-1"     OS.2404-2 → "OS-2"     TS.240 → "TS"     WSP.704 → "WSP"
 * A code that is NOT a size-series code (e.g. XEVC-1011-EPRM, C-E961 OP, 150182) returns null and is left
 * alone — so unrelated products can never accidentally share a photo.
 */
const { supabase } = require("../config/supabase");

function seriesKey(code) {
  const s = String(code || "").trim();
  // PREFIX (letters) · optional dot · SIZE (digits) · optional -TIER  →  e.g. COS.704-2, TS.240, OS.2404-1
  const m = s.match(/^([A-Za-z]+)\.?\d+(?:-(\d+))?$/);
  if (!m) return null; // not a size series → never grouped
  return m[2] ? `${m[1].toUpperCase()}-${m[2]}` : m[1].toUpperCase();
}

/**
 * Fill every blank model image from another model in the same code series. DB-wide, idempotent, and
 * safe to run after any import. Returns { filled, series: [{key, from, filled}] }.
 */
async function propagateSeriesImages() {
  // page through every model so the 1000-row PostgREST cap can never truncate the set
  const models = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("ceks_models").select("id, model_number, image_url").range(from, from + 999);
    if (error) throw new Error(error.message);
    models.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const groups = new Map(); // key → { source, sourceCode, blanks:[id] }
  for (const m of models) {
    const key = seriesKey(m.model_number);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { source: null, sourceCode: null, blanks: [] });
    const g = groups.get(key);
    if (m.image_url) { if (!g.source) { g.source = m.image_url; g.sourceCode = m.model_number; } }
    else g.blanks.push(m.id);
  }

  const series = [];
  let filled = 0;
  for (const [key, g] of groups) {
    if (!g.source || !g.blanks.length) continue;
    let n = 0;
    for (const id of g.blanks) {
      const { error } = await supabase.from("ceks_models").update({ image_url: g.source }).eq("id", id);
      if (!error) { n++; filled++; }
    }
    if (n) series.push({ key, from: g.sourceCode, filled: n });
  }
  return { filled, series };
}

module.exports = { propagateSeriesImages, seriesKey };
