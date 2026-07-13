/**
 * THE PARAMETER DICTIONARY — the canonical vocabulary of the platform.
 *
 * A rule cannot match a fact it cannot name. In the live knowledge base the same fact arrives as
 * "Power Load" / "Connected Load" / "Total Power"; the same phase as "3N" / "3PH+N+PE" / "3 Phase".
 * This module is the one place that turns those into a single canonical parameter.
 *
 * Everything it uses — parameters, aliases, unit conversions, value normalisations, disciplines —
 * lives in the DATABASE and is editable from the Admin Portal. Nothing here is hardcoded.
 */
const { supabase } = require("../config/supabase");

const TTL_MS = 30_000;
let cache = { at: 0, data: null };

async function load(force = false) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const [disciplines, parameters, aliases, units, valueNorms, constants, settings] = await Promise.all([
    supabase.from("ceks_disciplines").select("*").order("sort_order"),
    supabase.from("ceks_parameters").select("*").order("sort_order"),
    supabase.from("ceks_parameter_aliases").select("*"),
    supabase.from("ceks_unit_conversions").select("*"),
    supabase.from("ceks_value_normalizations").select("*"),
    supabase.from("ceks_rule_constants").select("*"),
    supabase.from("ceks_engine_settings").select("*"),
  ]);

  const params = parameters.data || [];
  const byId = new Map(params.map((p) => [p.id, p]));
  const byKey = new Map(params.map((p) => [p.key, p]));

  // alias → parameter. Exact aliases are indexed; contains/regex are scanned (there are few).
  const exact = new Map();
  const fuzzy = [];
  for (const a of aliases.data || []) {
    const p = byId.get(a.parameter_id);
    if (!p) continue;
    if (a.match_type === "exact") exact.set(a.alias.trim().toLowerCase(), p);
    else fuzzy.push({ ...a, param: p });
  }

  // unit conversion graph: from|to → { factor, offset }
  const conv = new Map();
  for (const u of units.data || []) {
    conv.set(`${String(u.from_unit).toLowerCase()}|${String(u.to_unit).toLowerCase()}`, {
      factor: Number(u.factor) || 1,
      offset: Number(u.offset) || 0,
    });
  }

  // value normalisation, grouped by parameter
  const norms = new Map();
  for (const v of valueNorms.data || []) {
    if (!norms.has(v.parameter_id)) norms.set(v.parameter_id, []);
    norms.get(v.parameter_id).push(v);
  }

  const settingsMap = {};
  for (const s of settings.data || []) settingsMap[s.key] = s.value;

  const constantsMap = {};
  for (const c of constants.data || []) constantsMap[c.key] = Number(c.value);

  cache = {
    at: Date.now(),
    data: {
      disciplines: disciplines.data || [],
      disciplineById: new Map((disciplines.data || []).map((d) => [d.id, d])),
      disciplineByCode: new Map((disciplines.data || []).map((d) => [d.code, d])),
      parameters: params,
      paramById: byId,
      paramByKey: byKey,
      aliasExact: exact,
      aliasFuzzy: fuzzy,
      conversions: conv,
      valueNorms: norms,
      constants: constantsMap,
      settings: settingsMap,
    },
  };
  return cache.data;
}

function invalidate() {
  cache = { at: 0, data: null };
}

/**
 * Which canonical parameter is this raw attribute name?
 * Exact alias → contains → regex. Returns null when we genuinely do not know — the Admin Portal
 * then shows it as "unmapped", and the engineer adds an alias. We never guess a mapping.
 */
function resolveParameter(dict, rawName) {
  if (!rawName) return null;
  const name = String(rawName).trim();
  const lower = name.toLowerCase();

  const hit = dict.aliasExact.get(lower);
  if (hit) return hit;

  for (const a of dict.aliasFuzzy) {
    if (a.match_type === "contains" && lower.includes(String(a.alias).toLowerCase())) return a.param;
    if (a.match_type === "regex") {
      try {
        if (new RegExp(a.alias, "i").test(name)) return a.param;
      } catch { /* an invalid regex in the dictionary must not break ingestion */ }
    }
  }
  return null;
}

/** Convert a number between units using the DB conversion table. Returns null if we cannot. */
function convert(dict, value, fromUnit, toUnit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (!fromUnit || !toUnit) return null;
  const f = String(fromUnit).trim().toLowerCase();
  const t = String(toUnit).trim().toLowerCase();
  if (f === t) return n;
  const c = dict.conversions.get(`${f}|${t}`);
  if (!c) return null;             // unknown conversion → the caller raises unit_unknown, never a guess
  return n * c.factor + c.offset;
}

/** Map a raw string onto a canonical enum value using the DB rules ("3N" → "3-Phase"). */
function normalizeEnum(dict, parameter, rawValue) {
  if (rawValue == null) return null;
  const raw = String(rawValue).trim();
  const rules = dict.valueNorms.get(parameter.id) || [];

  for (const r of rules) {
    if (r.match_type === "exact" && raw.toLowerCase() === String(r.raw_pattern).toLowerCase()) return r.canonical_value;
  }
  for (const r of rules) {
    if (r.match_type === "contains" && raw.toLowerCase().includes(String(r.raw_pattern).toLowerCase())) return r.canonical_value;
  }
  for (const r of rules) {
    if (r.match_type === "regex") {
      try {
        if (new RegExp(r.raw_pattern, "i").test(raw)) return r.canonical_value;
      } catch { /* ignore a bad pattern */ }
    }
  }

  // already a legal value for this enum?
  const allowed = Array.isArray(parameter.allowed_values) ? parameter.allowed_values : null;
  if (allowed && allowed.some((v) => String(v).toLowerCase() === raw.toLowerCase())) return raw;

  return null; // unknown spelling → flagged, never guessed
}

const setting = (dict, key, fallback = null) => (dict.settings[key] !== undefined ? dict.settings[key] : fallback);
const settingNum = (dict, key, fallback) => {
  const v = Number(setting(dict, key));
  return Number.isFinite(v) ? v : fallback;
};
const settingBool = (dict, key, fallback = false) => {
  const v = setting(dict, key);
  if (v === undefined || v === null) return fallback;
  return String(v).toLowerCase() === "true";
};

module.exports = {
  load,
  invalidate,
  resolveParameter,
  convert,
  normalizeEnum,
  setting,
  settingNum,
  settingBool,
};
