/**
 * VALUE NORMALISATION.
 *
 * The manufacturer's extracted value is SACRED — it is never modified. These functions produce a
 * COMPARABLE form of it, stored in separate columns beside the original:
 *
 *   "380...415"  → value_min 380,  value_max 415   (a range, exactly as the datasheet meant it)
 *   "50/60"      → value_min 50,   value_max 60
 *   "2.5"        → value_num 2.5
 *   "≤ 1000"     → value_max 1000                   (an UPPER BOUND — never an exact 1000)
 *   "≥ 200"      → value_min 200                    (a LOWER BOUND)
 *   "230 ± 10"   → value_min 220,  value_max 240
 *   "3N"         → value_canonical "3-Phase"
 *   "24.0 kW"    → value_num 24, unit_canonical "kW"
 *
 * Without this, a rule condition like "Current between 16 A and 20 A" cannot be evaluated at all —
 * which is why this is the hard prerequisite for the whole engine.
 *
 * When a value cannot be normalised we say SO (normalize_note) and leave it unnormalised. We never
 * coerce, round, or pick one end of a range to make it "work"; and we never silently drop an
 * inequality that changes what the number MEANS.
 */
const { supabase } = require("../config/supabase");
const dictSvc = require("./params");

// Range separators seen in the live data: "380-415", "380...415", "50/60", "380 to 415", "380~415"
const RANGE_RE = /^\s*(-?\d+(?:[.,]\d+)?)\s*(?:\.{2,3}|-{1,2}|\/|~|to)\s*(-?\d+(?:[.,]\d+)?)\s*(.*)$/i;
// Centre ± tolerance: "230 ± 10", "230 +/- 10"
const TOL_RE = /^\s*(-?\d+(?:[.,]\d+)?)\s*(?:±|\+\/-|\+-)\s*(\d+(?:[.,]\d+)?)\s*(.*)$/;
// A single number, optionally prefixed by a BOUND operator we must NOT discard.
const BOUND_RE = /^\s*(>=|<=|=>|=<|≥|≤|>|<|~|≈|=)?\s*(-?\d+(?:[.,]\d+)?)\s*(.*)$/;

const num = (s) => {
  const n = Number(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

// Map a raw operator glyph to a canonical bound kind.
function boundKind(op) {
  switch (op) {
    case ">=": case "=>": case "≥": return "gte";
    case ">": return "gt";
    case "<=": case "=<": case "≤": return "lte";
    case "<": return "lt";
    case "~": case "≈": return "approx";
    default: return null; // "=" or no operator → exact
  }
}

/**
 * Parse a raw value string into { num, min, max, tail, bound }.
 *   bound: null | 'range' | 'tolerance' | 'gte' | 'gt' | 'lte' | 'lt' | 'approx'
 * A lower bound (≥ / >) becomes {min:N, max:null}; an upper bound (≤ / <) becomes {min:null, max:N}.
 * The distinction between strict (< >) and inclusive (≤ ≥) is preserved in `bound` and surfaced in
 * the note — the DB has no separate column for it, so we record min/max inclusively and say so.
 */
function parseNumeric(raw) {
  const none = { num: null, min: null, max: null, tail: null, bound: null };
  if (raw == null) return none;
  const s = String(raw).trim();
  if (!s) return none;

  const r = RANGE_RE.exec(s);
  if (r) {
    const a = num(r[1]); const b = num(r[2]);
    if (a != null && b != null) {
      return { num: null, min: Math.min(a, b), max: Math.max(a, b), tail: (r[3] || "").trim() || null, bound: "range" };
    }
  }

  const t = TOL_RE.exec(s);
  if (t) {
    const c = num(t[1]); const tol = num(t[2]);
    if (c != null && tol != null) {
      return { num: null, min: c - Math.abs(tol), max: c + Math.abs(tol), tail: (t[3] || "").trim() || null, bound: "tolerance" };
    }
  }

  const m = BOUND_RE.exec(s);
  if (m) {
    const a = num(m[2]);
    if (a != null) {
      const kind = boundKind(m[1]);
      const tail = (m[3] || "").trim() || null;
      if (kind === "gte" || kind === "gt") return { num: null, min: a, max: null, tail, bound: kind };
      if (kind === "lte" || kind === "lt") return { num: null, min: null, max: a, tail, bound: kind };
      // 'approx' and exact both keep a point value; 'approx' is flagged so its confidence drops
      return { num: a, min: null, max: null, tail, bound: kind === "approx" ? "approx" : null };
    }
  }
  return none;
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

const BOUND_NOTE = {
  gte: "Stated as a minimum (≥); recorded as a lower bound.",
  gt: "Stated as greater-than (>); recorded as a lower bound.",
  lte: "Stated as a maximum (≤); recorded as an upper bound.",
  lt: "Stated as less-than (<); recorded as an upper bound.",
  approx: "Stated as approximate (~); recorded as a nominal value.",
  tolerance: "Stated as a tolerance band; recorded as a min–max range.",
};

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

  // ── enum / text / boolean ────────────────────────────────────────────────────
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
  if (parsed.num == null && parsed.min == null && parsed.max == null) {
    out.normalize_note = `Could not read a number from "${attr.value}" for ${param.label}.`;
    return out;
  }

  const boundNote = parsed.bound && BOUND_NOTE[parsed.bound] ? BOUND_NOTE[parsed.bound] : null;
  const rawUnit = attr.unit || sniffUnit(parsed.tail, attr.name);
  const target = param.canonical_unit;

  const setNote = (extra) => {
    out.normalize_note = [boundNote, extra].filter(Boolean).join(" ") || null;
  };

  if (!target) {
    // the parameter has no canonical unit → keep the numbers as they are
    out.value_num = parsed.num;
    out.value_min = parsed.min;
    out.value_max = parsed.max;
    out.unit_canonical = rawUnit || null;
    setNote(null);
    return out;
  }

  if (!rawUnit) {
    // no unit anywhere → take the number at face value in the canonical unit and SAY we assumed it,
    // so an engineer can see the assumption instead of it being invisible.
    out.value_num = parsed.num;
    out.value_min = parsed.min;
    out.value_max = parsed.max;
    out.unit_canonical = target;
    setNote(`No unit was stated; the value was read as ${target}.`);
    return out;
  }

  const conv = (v) => (v == null ? null : dictSvc.convert(dict, v, rawUnit, target));
  const cn = conv(parsed.num);
  const cmin = conv(parsed.min);
  const cmax = conv(parsed.max);

  // Only the values that were ACTUALLY present must convert. A one-sided bound (min-only or max-only)
  // must not trip the "no conversion" check on its absent half.
  const present = [[parsed.num, cn], [parsed.min, cmin], [parsed.max, cmax]].filter(([raw]) => raw != null);
  if (present.some(([, c]) => c === null)) {
    out.normalize_note = `No conversion from "${rawUnit}" to "${target}" for ${param.label}. Add it to Unit Conversions.`;
    out.unit_canonical = null;
    return out;
  }

  out.value_num = cn;
  out.value_min = cmin;
  out.value_max = cmax;
  out.unit_canonical = target;
  setNote(null);
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

  const report = { total: (attrs || []).length, mapped: 0, unmapped: 0, unreadable: 0, updated: 0 };

  // Bulk the writes: build all rows and upsert once, instead of one UPDATE per attribute (N+1).
  // We spread the FULL original row so the upsert's insert-path satisfies NOT NULL columns
  // (version_id, name, …); ON CONFLICT (id) only ever UPDATEs, and the raw value/unit are re-supplied
  // unchanged — only the normalisation columns actually differ.
  const updates = [];
  for (const a of attrs || []) {
    const cols = normalizeAttribute(dict, a);
    if (cols.parameter_id) report.mapped++;
    else report.unmapped++;
    if (cols.parameter_id && cols.value_num == null && cols.value_min == null && cols.value_max == null && !cols.value_canonical) report.unreadable++;
    updates.push({ ...a, ...cols });
  }
  if (updates.length) {
    const { error: upErr } = await supabase.from("ceks_knowledge_attributes").upsert(updates, { onConflict: "id" });
    if (upErr) throw new Error(upErr.message);
    report.updated = updates.length;
  }
  return report;
}

/** A stable representation of an attribute's normalised value, for distinct-value comparison. */
function reprOf(a) {
  if (a.value_num != null) return `n:${Number(a.value_num)}`;
  if (a.value_min != null || a.value_max != null) return `r:${a.value_min ?? "-inf"}..${a.value_max ?? "inf"}`;
  if (a.value_canonical != null) return `c:${String(a.value_canonical).trim().toLowerCase()}`;
  return `v:${String(a.value ?? "").trim().toLowerCase()}`;
}

function factFromRow(p, a, extra = {}) {
  return {
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
      // if a note was needed to produce a numeric value, an assumption was made → trust it a bit less
      assumed: !!a.normalize_note && (a.value_num != null || a.value_min != null || a.value_max != null),
    },
    ...extra,
  };
}

/**
 * The evaluation SCOPE for one knowledge version: canonical parameter key → value.
 *
 * When several attributes map to the SAME parameter with DIFFERENT values (e.g. Voltage 230 and 400
 * on the same datasheet), the old code silently kept whichever row the DB returned first. That is
 * exactly the kind of guess the client forbade. Now: a single VERIFIED value resolves it; otherwise
 * the fact is marked `ambiguous` with all its candidates, and the engine raises an ambiguous_input
 * validation and refuses to use it — an engineer must choose.
 */
async function buildScope(versionId, entry = null) {
  const dict = await dictSvc.load();
  const { data: attrs } = await supabase
    .from("ceks_knowledge_attributes")
    .select("*")
    .eq("version_id", versionId);

  // group all mapped attributes by canonical parameter
  const byKey = new Map();
  for (const a of attrs || []) {
    if (!a.parameter_id) continue;
    const p = dict.paramById.get(a.parameter_id);
    if (!p) continue;
    if (!byKey.has(p.key)) byKey.set(p.key, { p, rows: [] });
    byKey.get(p.key).rows.push(a);
  }

  const scope = {};
  for (const [key, { p, rows }] of byKey) {
    const distinct = new Map();
    for (const a of rows) if (!distinct.has(reprOf(a))) distinct.set(reprOf(a), a);

    if (distinct.size === 1) {
      const chosen = rows.find((r) => r.verified) || rows[0];
      scope[key] = factFromRow(p, chosen);
      continue;
    }

    // multiple distinct values — a single verified value settles it decisively
    const verified = rows.filter((r) => r.verified);
    const verifiedDistinct = new Set(verified.map(reprOf));
    if (verified.length && verifiedDistinct.size === 1) {
      scope[key] = factFromRow(p, verified[0]);
      continue;
    }

    // genuinely ambiguous → keep a tentative value but flag it; the engine will not use it
    const chosen = verified[0] || rows[0];
    const candidates = [...distinct.values()].map((a) => {
      const parts = [];
      if (a.value_num != null) parts.push(`${a.value_num}`);
      else if (a.value_min != null || a.value_max != null) parts.push(`${a.value_min ?? "…"}–${a.value_max ?? "…"}`);
      else parts.push(`${a.value_canonical ?? a.value ?? "?"}`);
      const unit = a.unit_canonical || a.unit;
      return `${parts[0]}${unit ? " " + unit : ""}${a.verified ? " (verified)" : ""}`;
    });
    scope[key] = factFromRow(p, chosen, { ambiguous: true, candidates });
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
        source: { origin: "entry", field: key, confidence: 1, verified: true, assumed: false },
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
  reprOf,
};
