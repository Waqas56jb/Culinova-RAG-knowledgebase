/**
 * TECHNICAL SECTION APPLICABILITY.
 *
 * Which engineering sections should EOS actually SHOW for a given piece of equipment?
 *
 * A stainless-steel work table has no electrical, water or gas connection — those sections must be
 * hidden completely, not rendered empty and not flagged "Missing". "Missing" means *we should have
 * this value and we don't*; "not applicable" means *this will never exist for this item*. Showing one
 * as the other is what makes an interface noisy and untrustworthy.
 *
 * Nothing here is hardcoded to a category or a utility. Every decision comes from data:
 *   1. ceks_disciplines            — the list of disciplines AND which attr_groups belong to each
 *   2. the version's declaration   — what the SOURCE explicitly marked N/A (not_applicable_disciplines)
 *   3. the linked category standard— the CULINOVA profile's directives for that equipment category
 *   4. the item's own attributes   — what the datasheet actually provided
 *
 * Add a discipline, a category standard, or a new equipment family and this logic keeps working
 * unchanged — which is exactly the requirement: dynamic technical fields, not a fixed form.
 */
const { supabase } = require("../config/supabase");

/** A value that carries no information — treated as "no data", never as a real reading. */
const EMPTY_VALUE = /^\s*(n\s*\/?\s*a|not applicable|none|-{1,3}|—|–|null|nil)\s*$/i;
const hasRealValue = (v) => v != null && String(v).trim() !== "" && !EMPTY_VALUE.test(String(v));

/**
 * Which discipline does a free-text label belong to? Resolved against the DISCIPLINES TABLE, so it
 * follows the data (adding "Laundry" as a discipline makes "Laundry Requirement" resolve by itself).
 */
function disciplineForLabel(label, disciplines) {
  const l = String(label || "").toLowerCase();
  if (!l) return null;
  let best = null;
  for (const d of disciplines) {
    const name = String(d.name || "").toLowerCase();
    const code = String(d.code || "").toLowerCase().replace(/_/g, " ");
    for (const token of [name, code]) {
      if (token && token.length >= 3 && l.includes(token)) {
        // prefer the longest match so "fresh air" never loses to "air"
        if (!best || token.length > best.len) best = { code: d.code, len: token.length };
      }
    }
  }
  return best ? best.code : null;
}

/** attr_group → discipline code, straight from ceks_disciplines.attr_groups. */
function groupToDiscipline(disciplines) {
  const map = new Map();
  for (const d of disciplines) for (const g of d.attr_groups || []) if (!map.has(g)) map.set(g, d.code);
  return map;
}

/**
 * Compute the section state for one equipment version.
 * Returns, per discipline: 'applicable' | 'missing' | 'not_applicable', plus why.
 */
async function forVersion(versionId, { entry = null, attributes = null } = {}) {
  const [{ data: disciplines }, { data: version }] = await Promise.all([
    supabase.from("ceks_disciplines").select("code,name,attr_groups,sort_order,color,symbol").order("sort_order"),
    supabase.from("ceks_knowledge_versions").select("id,not_applicable_disciplines").eq("id", versionId).maybeSingle(),
  ]);
  const discs = disciplines || [];
  if (!discs.length) return { sections: [], hidden: [] };

  // the item's own attributes (may be supplied by the caller to avoid a second round trip)
  let attrs = attributes;
  if (!attrs) {
    const { data } = await supabase
      .from("ceks_knowledge_attributes")
      .select("attr_group,name,value")
      .eq("version_id", versionId);
    attrs = data || [];
  }

  // 1) what the SOURCE explicitly declared as not applicable
  const declaredNA = new Set(version?.not_applicable_disciplines || []);

  // 2) what the CATEGORY STANDARD says, when one governs this equipment
  const profileState = new Map(); // discipline code → 'required' | 'not_applicable'
  if (entry?.category_profile_id) {
    const { data: pattrs } = await supabase
      .from("ceks_category_profile_attributes")
      .select("column_label, directive, raw_value, ceks_parameters(discipline_id)")
      .eq("profile_id", entry.category_profile_id);
    const byDisc = new Map(); // code → { total, na, required }
    for (const a of pattrs || []) {
      const code = disciplineForLabel(a.column_label, discs);
      if (!code) continue;
      if (!byDisc.has(code)) byDisc.set(code, { total: 0, na: 0, required: 0 });
      const s = byDisc.get(code);
      s.total++;
      if (a.directive === "not_applicable") s.na++;
      // anything that produces or demands a real value means the discipline DOES apply
      else if (["policy", "fixed", "manufacturer", "culinova_rule", "calculation", "options"].includes(a.directive)) {
        const negative = a.directive === "policy" && /^(no|not required|none)\b/i.test(String(a.raw_value || ""));
        if (!negative) s.required++;
      }
    }
    for (const [code, s] of byDisc) {
      if (s.required > 0) profileState.set(code, "required");
      else if (s.total > 0 && s.na === s.total) profileState.set(code, "not_applicable");
    }
  }

  // 3) what the item's own data actually contains
  const g2d = groupToDiscipline(discs);
  const dataCount = new Map(); // discipline code → count of real values
  for (const a of attrs) {
    const code = g2d.get(a.attr_group) || disciplineForLabel(a.attr_group, discs) || disciplineForLabel(a.name, discs);
    if (!code) continue;
    if (hasRealValue(a.value)) dataCount.set(code, (dataCount.get(code) || 0) + 1);
  }

  // ── decide ────────────────────────────────────────────────────────────────
  const sections = [];
  for (const d of discs) {
    const code = d.code;
    const values = dataCount.get(code) || 0;
    let state, reason;

    if (declaredNA.has(code)) {
      state = "not_applicable";
      reason = "The source datasheet explicitly marks this utility as not applicable.";
    } else if (profileState.get(code) === "not_applicable" && values === 0) {
      state = "not_applicable";
      reason = "The CULINOVA category standard marks this utility as not applicable for this category.";
    } else if (values > 0) {
      state = "applicable";
      reason = `${values} value(s) available.`;
    } else if (profileState.get(code) === "required") {
      state = "missing";
      reason = "The category standard requires this utility, but the datasheet provided no values.";
    } else {
      // no data, no requirement, no declaration → nothing to show. Do NOT render an empty section.
      state = "not_applicable";
      reason = "No requirement and no data — nothing to show for this item.";
    }

    sections.push({
      discipline: code,
      label: d.name,
      color: d.color || null,
      symbol: d.symbol || null,
      attr_groups: d.attr_groups || [],
      state,
      reason,
      value_count: values,
    });
  }

  return {
    sections,
    visible: sections.filter((s) => s.state !== "not_applicable").map((s) => s.discipline),
    hidden: sections.filter((s) => s.state === "not_applicable").map((s) => s.discipline),
    missing: sections.filter((s) => s.state === "missing").map((s) => s.discipline),
  };
}

module.exports = { forVersion, hasRealValue, disciplineForLabel, groupToDiscipline };
