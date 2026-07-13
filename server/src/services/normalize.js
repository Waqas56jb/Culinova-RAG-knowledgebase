/**
 * VALUE NORMALISATION.
 *
 * The manufacturer's extracted value is SACRED — it is never modified. These functions produce a
 * COMPARABLE form of it, stored in separate columns beside the original:
 *
 *   "380...415"  → value_min 380,  value_max 415   (a range, exactly as the datasheet meant it)
 *   "50/60"      → value_min 50,   value_max 60
 *   "2.5"        → value_num 2.5
 *   "3N"         → value_canonical "3-Phase"
 *   "24.0 kW"    → value_num 24, unit_canonical "kW"
 *   "150-600 kPa"→ min 150, max 600, unit "kPa"
 *
 * Without this, a rule condition like "Current between 16 A and 20 A" cannot be evaluated at all —
 * which is why this is the hard prerequisite for the whole engine.
 *
 * When a value cannot be normalised we say SO (normalize_note) and leave it unnormalised. We never
 * coerce, round, or pick one end of a range to make it "work".
 */
const { supabase } = require("../config/supabase");
const dictSvc = require("./params");

// Range separators seen in the live data: "380-415", "380...415", "50/60", "380 to 415", "380~415"
const RANGE_RE = /^\s*(-?\d+(?:[.,]\d+)?)\s*(?:\.{2,3}|-{1,2}|\/|~|to)\s*(-?\d+(?:[.,]\d+)?)\s*(.*)$/i;
// A single number, optionally followed by a unit: "24.0 kW", "2,5", "≥ 200 kPa"
const NUM_RE = /^\s*[≥≤><~=]*\s*(-?\d+(?:[.,]\d+)?)\s*(.*)$/;

const num = (s) => {
  const n = Number(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse a raw value string into { num, min, max, tail } without any unit knowledge.
 * `tail` is whatever followed the number(s) — often the unit when the unit column was empty
 * (the Excel importer always leaves unit null, so the unit hides inside the value or the name).
 */
function parseNumeric(raw) {
  if (raw == null) return { num: null, min: null, max: null, tail: null };
  const s = String(raw).trim();
  if (!s) return { num: null, min: null, max: null, tail: null };

  const r = RANGE_RE.exec(s);
  if (r) {
    const a = num(r[1]);
    const b = num(r[2]);
    if (a != null && b != null) {
      return { num: null, min: Math.min(a, b), max: Math.max(a, b), tail: (r[3] || "").trim() || null };
    }
  }
  const m = NUM_RE.exec(s);
  if (m) {
    const a = num(m[1]);
    if (a != null) return { num: a, min: null, max: null, tail: (m[2] || "").trim() || null };
  }
  return { num: null, min: null, max: null, tail: null };
}

/** Pull a unit out of a trailing fragment or a field name like "Voltage (V)". */
function sniffUnit(tail, name) {
  const clean = (u) => (u ? String(u).replace(/[()[\]]/g, "").trim() : null);
  if (tail) {
    const t = clean(tail);
    if (t && /^[a-zA-Z°%³/·.\-]+\d?$/.test(t)) return t;
  }
  if (name) {
    const m = /\(([^)]+)\)\s*$/.exec(String(name));
    if (m) return clean(m[1]);
  }
  return null;
}

/**
 * Normalise ONE attribute row against the dictionary.
 * Returns the columns to write — never mutates `value` or `unit`.
 */
function normalizeAttribute(dict, attr) {
  const param = dictSvc.resolveParameter(dict, attr.name);

  const out = {
    parameter_id: param ? param.id : null,
    value_num: null,
    value_min: null,
    value_max: null,
    value_canonical: null,
    unit_canonical: null,
    normalized_at: new Date().toISOString(),
    normalize_note: null,
  };

  if (!param) {
    out.normalize_note = `No canonical parameter is mapped to "${attr.name}". Add an alias in the Parameter Dictionary.`;
    return out;
  }

  // ── enum / text ─────────────────────────────────────────────────────────────
  if (param.data_type === "enum") {
    const canon = dictSvc.normalizeEnum(dict, param, attr.value);
    if (canon) out.value_canonical = canon;
    else out.normalize_note = `"${attr.value}" is not a recognised value for ${param.label}. Add a value mapping in the Parameter Dictionary.`;
    return out;
  }

  if (param.data_type === "text") {
    out.value_canonical = attr.value == null ? null : String(attr.value).trim() || null;
    return out;
  }

  if (param.data_type === "boolean") {
    const v = String(attr.value || "").trim().toLowerCase();
    if (["yes", "true", "required", "y", "1"].includes(v)) out.value_canonical = "true";
    else if (["no", "false", "not required", "n", "0"].includes(v)) out.value_canonical = "false";
    else out.normalize_note = `"${attr.value}" is not a yes/no value for ${param.label}.`;
    return out;
  }

  // ── number ──────────────────────────────────────────────────────────────────
  const parsed = parseNumeric(attr.value);
  if (parsed.num == null && parsed.min == null) {
    out.normalize_note = `Could not read a number from "${attr.value}" for ${param.label}.`;
    return out;
  }

  const rawUnit = attr.unit || sniffUnit(parsed.tail, attr.name);
  const target = param.canonical_unit;

  if (!target) {
    // the parameter has no canonical unit → keep the numbers as they are
    out.value_num = parsed.num;
    out.value_min = parsed.min;
    out.value_max = parsed.max;
    out.unit_canonical = rawUnit || null;
    return out;
  }

  if (!rawUnit) {
    // no unit anywhere → assume nothing. Take the number at face value in the canonical unit and
    // SAY that we did, so an engineer can see the assumption instead of it being invisible.
    out.value_num = parsed.num;
    out.value_min = parsed.min;
    out.value_max = parsed.max;
    out.unit_canonical = target;
    out.normalize_note = `No unit was stated; the value was read as ${target}.`;
    return out;
  }

  const conv = (v) => (v == null ? null : dictSvc.convert(dict, v, rawUnit, target));
  const cn = conv(parsed.num);
  const cmin = conv(parsed.min);
  const cmax = conv(parsed.max);

  const wanted = parsed.num != null ? [cn] : [cmin, cmax];
  if (wanted.some((x) => x === null)) {
    out.normalize_note = `No conversion from "${rawUnit}" to "${target}" for ${param.label}. Add it to Unit Conversions.`;
    out.unit_canonical = null;
    return out;
  }

  out.value_num = cn;
  out.value_min = cmin;
  out.value_max = cmax;
  out.unit_canonical = target;
  return out;
}

/** Normalise every attribute of one knowledge version and persist the derived columns. */
async function normalizeVersion(versionId) {
  const dict = await dictSvc.load();
  const { data: attrs, error } = await supabase
    .from("ceks_knowledge_attributes")
    .select("*")
    .eq("version_id", versionId);
  if (error) throw new Error(error.message);

  const report = { total: (attrs || []).length, mapped: 0, unmapped: 0, unreadable: 0 };

  for (const a of attrs || []) {
    const cols = normalizeAttribute(dict, a);
    if (cols.parameter_id) report.mapped++;
    else report.unmapped++;
    if (cols.parameter_id && cols.value_num == null && cols.value_min == null && !cols.value_canonical) report.unreadable++;

    await supabase.from("ceks_knowledge_attributes").update(cols).eq("id", a.id);
  }
  return report;
}

/**
 * The evaluation SCOPE for one knowledge version: canonical parameter key → value.
 * This is what rule conditions are matched against and what derivation formulas read.
 * Each value keeps its provenance (which attribute, which page, what confidence) so every
 * recommendation can say exactly what it was computed from.
 */
async function buildScope(versionId, entry = null) {
  const dict = await dictSvc.load();
  const { data: attrs } = await supabase
    .from("ceks_knowledge_attributes")
    .select("*")
    .eq("version_id", versionId);

  const scope = {};   // key → { value, num, min, max, unit, source }
  for (const a of attrs || []) {
    if (!a.parameter_id) continue;
    const p = dict.paramById.get(a.parameter_id);
    if (!p) continue;
    // first one wins, but prefer a verified attribute over an unverified one
    const existing = scope[p.key];
    if (existing && existing.source.verified && !a.verified) continue;

    scope[p.key] = {
      parameter_id: p.id,
      key: p.key,
      label: p.label,
      data_type: p.data_type,
      value: a.value_canonical ?? a.value,
      num: a.value_num,
      min: a.value_min,
      max: a.value_max,
      unit: a.unit_canonical || a.unit,
      source: {
        origin: "manufacturer",
        attribute_id: a.id,
        raw_name: a.name,
        raw_value: a.value,
        raw_unit: a.unit,
        document: a.source_document,
        page: a.source_page,
        confidence: a.confidence == null ? null : Number(a.confidence),
        verified: !!a.verified,
      },
    };
  }

  // the entry's own identity is matchable too: "Equipment Category = Combi Oven"
  if (entry) {
    const idents = [
      ["equipment.category", entry.category],
      ["equipment.type", entry.equipment_type],
      ["equipment.brand", entry.brand],
      ["equipment.power_type", entry.power_type],
    ];
    for (const [key, value] of idents) {
      if (value == null || value === "") continue;
      const p = dict.paramByKey.get(key);
      if (!p) continue;
      scope[key] = {
        parameter_id: p.id,
        key,
        label: p.label,
        data_type: p.data_type,
        value: String(value),
        num: null, min: null, max: null, unit: null,
        source: { origin: "entry", field: key, confidence: 1, verified: true },
      };
    }
  }

  return { scope, constants: dict.constants, dict };
}

module.exports = {
  parseNumeric,
  sniffUnit,
  normalizeAttribute,
  normalizeVersion,
  buildScope,
};
