/**
 * ONE canonical brand identity per company — applied at the single choke point where brands are
 * created (draft.js findOrCreateBrand), and reused by the cleanup CLI, so create-time and cleanup
 * can never drift.
 *
 * The client's rule: "multiple brands representing the same company — CULINOVA, CULINOVA Standard,
 * CULINOX, CULINOVA CUSTOM, CUSTOM FABRICATION — must be ONE brand: CULINOVA. Product lines /
 * standards are handled separately, not as different brands."
 *
 * Data-first: the SEED_ALIASES below cover the known variants, and loadAliases() can hydrate more
 * from a `ceks_brand_aliases` table so the client extends coverage by inserting rows — no redeploy.
 * An unknown brand is returned UNCHANGED, so genuinely distinct brands are never merged by accident.
 */

/** Case / punctuation / spacing-insensitive key. "CULINOVA Standard" and "culinova-standard" collide. */
const keyOf = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// variant key → canonical brand
const SEED_ALIASES = {
  "culinova": "CULINOVA",
  "culinova standard": "CULINOVA",
  "culinova custom": "CULINOVA",
  "custom fabrication": "CULINOVA",
  "culinox": "CULINOVA",
  "nova cool": "NOVA COOL",
  "bartscher": "BARTSCHER",
  "fagor": "FAGOR",
  "fafor": "FAGOR",
};

let _dbAliases = null;

/** Optional: load extra aliases from a data table so the client adds them without a code change. */
async function loadAliases(supabase) {
  if (_dbAliases) return _dbAliases;
  _dbAliases = {};
  try {
    const { data } = await supabase.from("ceks_brand_aliases").select("alias, canonical");
    for (const r of data || []) if (r.alias && r.canonical) _dbAliases[keyOf(r.alias)] = r.canonical;
  } catch {
    /* table may not exist yet — seed aliases still apply */
  }
  return _dbAliases;
}

/** Map any brand name to its canonical identity; unknown brands pass through unchanged. */
function canonicalBrand(name, extra = null) {
  const k = keyOf(name);
  if (!k) return name;
  return { ...SEED_ALIASES, ...(_dbAliases || {}), ...(extra || {}) }[k] || name;
}

module.exports = { canonicalBrand, loadAliases, keyOf, SEED_ALIASES };
