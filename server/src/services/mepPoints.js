/**
 * MEP POINTS (client items 10 & 11).
 *
 * For a piece of equipment, decide WHICH utility points it needs — from its own data, never a guess:
 *   • Electrical point  → it has electrical power/voltage/current data (or power_type Electric)
 *   • CW / HW points    → cold/hot water attributes exist
 *   • Drain point       → drain attributes exist
 *   • Gas point         → gas attributes exist (or power_type Gas)
 *   • Exhaust / FA      → ventilation attributes or approved ventilation recommendations exist
 *
 * The colour & symbol of every point type live in ceks_utility_point_types — admin-editable data.
 * Each point carries its value (e.g. "24 kW", "DN20"), unit, height and the parameter it came from,
 * so the drawing, the point schedule and the coordinate export all say the same thing.
 */
const { supabase } = require("../config/supabase");
const dictSvc = require("./params");

async function loadPointTypes() {
  const { data } = await supabase
    .from("ceks_utility_point_types")
    .select("*, ceks_disciplines(code,name)")
    .eq("is_active", true)
    .order("sort_order");
  return data || [];
}

/** first attribute whose name matches any of the patterns (case-insensitive) */
const findAttr = (attrs, patterns) =>
  attrs.find((a) => patterns.some((p) => p.test(a.name || "")));

const val = (a) => (a ? `${a.value ?? ""}${a.unit ? " " + a.unit : ""}`.trim() || null : null);

/**
 * The required MEP points for one knowledge version.
 * `recommendations` are the current CULINOVA recommendations (already loaded by the caller), used
 * both to detect a need (e.g. exhaust airflow was recommended) and to fill the point's value.
 */
async function pointsForVersion(versionId, { attributes = null, recommendations = null } = {}) {
  const dict = await dictSvc.load();
  const types = await loadPointTypes();
  const byCode = new Map(types.map((t) => [t.code, t]));

  let attrs = attributes;
  if (!attrs) {
    const { data } = await supabase.from("ceks_knowledge_attributes").select("*").eq("version_id", versionId);
    attrs = data || [];
  }
  let recs = recommendations;
  if (!recs) {
    const { data } = await supabase
      .from("ceks_recommendations")
      .select("*")
      .eq("version_id", versionId)
      .eq("is_current", true);
    recs = data || [];
  }

  const recByKey = new Map();
  for (const r of recs) {
    const p = dict.paramById.get(r.parameter_id);
    if (p) recByKey.set(p.key, r);
  }
  const recValue = (key) => {
    const r = recByKey.get(key);
    if (!r) return null;
    const v = r.final_value ?? r.value_text ?? (r.value_num != null ? String(r.value_num) : null);
    return v ? `${v}${r.final_unit || r.unit ? " " + (r.final_unit || r.unit) : ""}`.trim() : null;
  };

  const grouped = {};
  for (const a of attrs) (grouped[a.attr_group] = grouped[a.attr_group] || []).push(a);
  const electrical = grouped.electrical || [];
  const water = grouped.water_drain || [];
  const gas = grouped.gas || [];
  const vent = grouped.ventilation || [];

  const points = [];
  const push = (code, { value, unit, height, note, source }) => {
    const t = byCode.get(code);
    if (!t) return;
    points.push({
      point_type_id: t.id,
      code: t.code,
      label: t.label,
      color: t.color,
      symbol: t.symbol,
      discipline: t.ceks_disciplines?.code || null,
      value: value || null,
      unit: unit || null,
      height: height || null,
      note: note || null,
      source: source || null,
    });
  };

  // ── Electrical ──────────────────────────────────────────────────────────────
  const power = findAttr(electrical, [/power/i, /load/i]);
  const voltage = findAttr(electrical, [/voltage/i]);
  if (power || voltage || electrical.length) {
    const conn = recValue("electrical.connection") || val(findAttr(electrical, [/connection/i]));
    push("EP", {
      value: val(power) || val(voltage),
      height: val(findAttr(electrical, [/height/i])),
      note: [
        conn ? `Connection: ${conn}` : null,
        recValue("electrical.cable_size") ? `Cable: ${recValue("electrical.cable_size")}` : null,
        recValue("electrical.breaker") ? `Breaker: ${recValue("electrical.breaker")}` : null,
        recValue("electrical.isolator") ? `Isolator: ${recValue("electrical.isolator")}` : null,
      ].filter(Boolean).join(" · ") || null,
      source: power ? "manufacturer" : "culinova",
    });
  }

  // ── Cold / Hot water ────────────────────────────────────────────────────────
  const cw = findAttr(water, [/cold\s*water/i, /water\s*inlet/i, /water\s*connection/i]);
  if (cw) {
    push("CW", {
      value: val(cw) || recValue("plumbing.water_connection_size"),
      height: val(findAttr(water, [/cold.*height/i])),
      source: "manufacturer",
    });
  }
  const hw = findAttr(water, [/hot\s*water/i]);
  const hwRec = recValue("plumbing.hot_water_required");
  if (hw || (hwRec && !/^no\b/i.test(hwRec))) {
    push("HW", {
      value: val(hw) || hwRec,
      height: val(findAttr(water, [/hot.*height/i])),
      source: hw ? "manufacturer" : "culinova",
    });
  }

  // ── Drain ───────────────────────────────────────────────────────────────────
  const drain = findAttr(water, [/drain/i]);
  if (drain || recValue("drainage.recommended_drain_size")) {
    push("DR", {
      value: val(drain) || recValue("drainage.recommended_drain_size"),
      height: val(findAttr(water, [/drain.*height/i])),
      note: val(findAttr(water, [/drain.*method/i, /gravity|pumped/i])),
      source: drain ? "manufacturer" : "culinova",
    });
  }

  // ── Gas ─────────────────────────────────────────────────────────────────────
  if (gas.length) {
    push("GAS", {
      value: val(findAttr(gas, [/connection|diameter|size/i])) || recValue("gas.recommended_pipe_size"),
      height: val(findAttr(gas, [/height/i])),
      note: [
        val(findAttr(gas, [/type/i])) ? `Type: ${val(findAttr(gas, [/type/i]))}` : null,
        val(findAttr(gas, [/pressure/i])) ? `Pressure: ${val(findAttr(gas, [/pressure/i]))}` : null,
        recValue("gas.isolation_valve") ? `Isolation: ${recValue("gas.isolation_valve")}` : null,
      ].filter(Boolean).join(" · ") || null,
      source: "manufacturer",
    });
  }

  // ── Ventilation ─────────────────────────────────────────────────────────────
  const exhaust = findAttr(vent, [/exhaust/i, /extraction/i]) || null;
  const exhaustRec = recValue("ventilation.exhaust_airflow");
  if (exhaust || exhaustRec) {
    push("EX", {
      value: val(exhaust) || exhaustRec,
      note: recValue("ventilation.hood_required") ? `Hood: ${recValue("ventilation.hood_required")}` : null,
      source: exhaust ? "manufacturer" : "culinova",
    });
  }
  const fresh = findAttr(vent, [/fresh\s*air/i]);
  const freshRec = recValue("ventilation.fresh_air");
  if (fresh || freshRec) {
    push("FA", { value: val(fresh) || freshRec, source: fresh ? "manufacturer" : "culinova" });
  }

  return points;
}

module.exports = { pointsForVersion, loadPointTypes };
