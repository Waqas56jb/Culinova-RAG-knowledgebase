/**
 * BULK DATASHEET MATCHING — link an uploaded PDF to the right equipment model by its PRODUCT CODE.
 *
 * The client uploads a batch of datasheets named by code (TBS.100.pdf, TBS.150 datasheet.pdf, …). This
 * finds, for each file, the existing product whose code it carries — exactly, as a token, or embedded in
 * the file name — and (optionally) attaches the PDF to that product as its datasheet. Nothing is guessed:
 * a file whose code matches no product is reported as UNMATCHED, never attached to the wrong item.
 */
const { supabase } = require("../config/supabase");

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Load every product code once → a lookup for matching. */
async function loadCodeIndex() {
  const entries = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("ceks_knowledge_entries").select("id, title, model_number, code").range(from, from + 999);
    if (error) throw new Error(error.message);
    entries.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const byNorm = new Map();
  const list = [];
  for (const e of entries) {
    const code = e.model_number || e.code;
    if (!code) continue;
    const n = norm(code);
    if (!byNorm.has(n)) byNorm.set(n, { entry_id: e.id, title: e.title, code });
    list.push({ n, code, entry: { entry_id: e.id, title: e.title, code } });
  }
  return { byNorm, list };
}

const letterPrefix = (code) => (String(code).match(/^[A-Za-z]+/) || [""])[0].toUpperCase();
const tierOf = (code) => { const m = String(code).match(/-(\d+)\s*$/); return m ? m[1] : null; };

/**
 * Find EVERY product a file name belongs to. Returns { how, products:[{entry_id,title,code}] }.
 *   "TBS.100.pdf"        → ONE product   (TBS.100)                 how = exact
 *   "TBS.150 sheet.pdf"  → ONE product   (TBS.150)                 how = contains
 *   "TBS.pdf"            → the whole SERIES (all TBS.* models)     how = series      ← ONE PDF, MANY products
 *   "OS-1.pdf"           → the OS single-tier series (OS.####-1)   how = series
 * A series is matched by the EXACT letter prefix (so "TB" never sweeps in "TBS"), plus a tier (-1/-2)
 * when the file name carries one. No match → products: [].
 */
function matchFilename(filename, idx) {
  const stem = String(filename || "").replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  const nStem = norm(stem);
  if (!nStem) return { how: null, products: [] };
  // 1) the whole name is exactly a product code
  if (idx.byNorm.has(nStem)) return { how: "exact", products: [idx.byNorm.get(nStem)] };
  // 2) a specific product code embedded in the name (longest wins → TBS beats TB/TS)
  let best = null;
  for (const { n, entry } of idx.list) if (n.length >= 4 && nStem.includes(n) && (!best || n.length > best.n.length)) best = { n, entry };
  if (best) return { how: "contains", products: [best.entry] };
  // 3) a SERIES name → every product in that series (this is the shared-datasheet case)
  const m = stem.match(/^([A-Za-z]+)(?:[\s._-]*(\d))?/);
  if (m) {
    const prefix = m[1].toUpperCase(), tier = m[2] || null;
    const products = [], seen = new Set();
    for (const { code, entry } of idx.list) {
      if (letterPrefix(code) !== prefix) continue;
      if (tier && tierOf(code) !== tier) continue;
      if (!seen.has(entry.entry_id)) { seen.add(entry.entry_id); products.push(entry); }
    }
    if (products.length) return { how: "series", products };
  }
  return { how: null, products: [] };
}

/** Match a batch of file names against existing products. Read-only. */
async function matchBatch(filenames) {
  const idx = await loadCodeIndex();
  const matched = [], unmatched = [];
  for (const f of filenames) {
    const { how, products } = matchFilename(f, idx);
    if (products.length) matched.push({ filename: f, how, count: products.length, products });
    else unmatched.push({ filename: f });
  }
  return { total: filenames.length, matched, unmatched };
}

/**
 * Attach each uploaded PDF (already in storage) to EVERY product it matches — so one shared datasheet
 * (e.g. "TBS.pdf") links to the whole series in a single action.
 *   files: [{ filename, storage_url, doc_type? }]
 * Returns { attached:[{filename, how, products:[…]}], links, unmatched:[…] }.
 */
async function attachBatch(files, { user = null } = {}) {
  const idx = await loadCodeIndex();
  const attached = [], unmatched = [];
  let links = 0;
  for (const f of files) {
    const { how, products } = matchFilename(f.filename, idx);
    if (!products.length) { unmatched.push({ filename: f.filename }); continue; }
    const rows = products.map((p) => ({
      file_name: f.filename, doc_type: f.doc_type || "datasheet", storage_url: f.storage_url || null,
      status: "uploaded", knowledge_entry_id: p.entry_id, uploaded_by: user?.id || null,
    }));
    const { data, error } = await supabase.from("ceks_import_documents").insert(rows).select("id, knowledge_entry_id");
    if (error) { unmatched.push({ filename: f.filename, error: error.message }); continue; }
    links += (data || []).length;
    attached.push({ filename: f.filename, how, count: products.length, products: products.map((p) => ({ code: p.code, entry_id: p.entry_id })) });
  }
  return { total: files.length, links, attached, unmatched };
}

module.exports = { loadCodeIndex, matchFilename, matchBatch, attachBatch, norm };
