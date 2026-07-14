/**
 * ENGINEERING SCHEDULE GENERATOR (client items 8, 9, 15, 16).
 *
 * A schedule TYPE (Equipment / Electrical Load / … / Combined MEP) is a row in
 * ceks_schedule_types whose COLUMNS are data — the Admin Portal can re-shape any schedule without a
 * deploy. This service only knows how to RESOLVE a column against a project item:
 *
 *   "item_number" | "description" | "brand" | "model" | "qty" | "area" | "dimensions" | ...
 *   "param:electrical.power"  → the manufacturer's normalised value for that parameter
 *   "rec:electrical.cable_size" → the current CULINOVA recommendation (engineer's final value first)
 *   "attr:cold water"          → first attribute whose name contains the text
 *   "total_power"              → qty × power (the electrical load schedule's load column)
 *
 * Every generated row keeps the item's identity so the exports (Excel/CSV/AutoCAD) are traceable.
 */
const { supabase } = require("../config/supabase");
const dictSvc = require("./params");
const mep = require("./mepPoints");

/** all ACTIVE items of a project, with entry identity, attributes and current recommendations */
async function loadProjectData(projectId) {
  const { data: project } = await supabase.from("ceks_projects").select("*").eq("id", projectId).maybeSingle();
  if (!project) throw Object.assign(new Error("Project not found."), { status: 404 });

  const { data: items } = await supabase
    .from("ceks_project_items")
    .select("*, ceks_knowledge_entries(id, title, code, brand, category, equipment_type, power_type, model_number, current_version_id, current_status)")
    .eq("project_id", projectId)
    .eq("status", "active")
    .order("sort_order")
    .order("created_at");

  const dict = await dictSvc.load();
  const out = [];
  for (const it of items || []) {
    const entry = it.ceks_knowledge_entries;
    if (!entry) continue;
    let attributes = [];
    let recommendations = [];
    if (entry.current_version_id) {
      const [a, r] = await Promise.all([
        supabase.from("ceks_knowledge_attributes").select("*").eq("version_id", entry.current_version_id),
        supabase.from("ceks_recommendations").select("*").eq("version_id", entry.current_version_id).eq("is_current", true),
      ]);
      attributes = a.data || [];
      recommendations = r.data || [];
    }
    out.push({ item: it, entry, attributes, recommendations });
  }
  return { project, items: out, dict };
}

const attrText = (a) => (a ? `${a.value ?? ""}${a.unit ? " " + a.unit : ""}`.trim() || null : null);

function dimensionsOf(attributes) {
  const dims = attributes.filter((a) => a.attr_group === "dimensions_clearance");
  const overall = dims.find((a) => /overall|dimension/i.test(a.name || ""));
  if (overall) return attrText(overall);
  const pick = (re) => attrText(dims.find((a) => re.test(a.name || "")));
  const parts = [pick(/length/i), pick(/width|depth/i), pick(/height/i)].filter(Boolean);
  return parts.length ? parts.join(" × ") : null;
}

/** resolve ONE column key for one loaded item */
function resolveCell(key, loaded, dict) {
  const { item, entry, attributes, recommendations } = loaded;

  if (key.startsWith("param:")) {
    const pkey = key.slice(6);
    const p = dict.paramByKey.get(pkey);
    if (!p) return null;
    const a = attributes.find((x) => x.parameter_id === p.id);
    if (!a) return null;
    if (a.value_canonical != null) return a.value_canonical;
    if (a.value_min != null && a.value_max != null) return `${a.value_min}–${a.value_max}${a.unit_canonical ? " " + a.unit_canonical : ""}`;
    if (a.value_num != null) return `${a.value_num}${a.unit_canonical ? " " + a.unit_canonical : ""}`;
    return attrText(a);
  }

  if (key.startsWith("rec:")) {
    const pkey = key.slice(4);
    const p = dict.paramByKey.get(pkey);
    if (!p) return null;
    const r = recommendations.find((x) => x.parameter_id === p.id && !["rejected", "no_rule", "missing_input"].includes(x.status));
    if (!r) return null;
    const v = r.final_value ?? r.value_text ?? (r.value_num != null ? String(r.value_num) : null);
    if (v == null) return null;
    const unit = r.final_unit || r.unit;
    return `${v}${unit ? " " + unit : ""}`.trim();
  }

  if (key.startsWith("attr:")) {
    const frag = key.slice(5).toLowerCase();
    const a = attributes.find((x) => String(x.name || "").toLowerCase().includes(frag));
    return attrText(a);
  }

  switch (key) {
    case "item_number": return item.item_number || null;
    case "description": return entry.title;
    case "brand": return entry.brand || null;
    case "model": return entry.model_number || entry.code || null;
    case "qty": return item.qty != null ? Number(item.qty) : 1;
    case "area": return [item.area, item.section, item.room].filter(Boolean).join(" / ") || null;
    case "zone": return item.zone || null;
    case "power_type": return entry.power_type || null;
    case "dimensions": return dimensionsOf(loaded.attributes);
    case "notes": return item.notes || null;
    case "total_power": {
      const p = dict.paramByKey.get("electrical.power");
      const a = p ? loaded.attributes.find((x) => x.parameter_id === p.id) : null;
      const kw = a?.value_num != null ? Number(a.value_num) : null;
      return kw != null ? Number((kw * Number(item.qty || 1)).toFixed(2)) : null;
    }
    default: return null;
  }
}

/** Build one schedule (rows + columns + totals) for a project. */
async function buildSchedule(projectId, scheduleCode, preloaded = null) {
  const { data: type } = await supabase
    .from("ceks_schedule_types")
    .select("*")
    .eq("code", scheduleCode)
    .eq("is_active", true)
    .maybeSingle();
  if (!type) throw Object.assign(new Error(`Unknown schedule "${scheduleCode}".`), { status: 404 });

  const data = preloaded || (await loadProjectData(projectId));
  const columns = Array.isArray(type.columns) ? type.columns : [];

  const rows = data.items.map((loaded) => {
    const row = {};
    for (const col of columns) row[col.key] = resolveCell(col.key, loaded, data.dict);
    row.__item_id = loaded.item.id;
    row.__entry_id = loaded.entry.id;
    return row;
  });

  // numeric totals (Total Load etc.)
  const totals = {};
  for (const col of columns) {
    const nums = rows.map((r) => r[col.key]).filter((v) => typeof v === "number");
    if (nums.length) totals[col.key] = Number(nums.reduce((s, v) => s + v, 0).toFixed(2));
  }

  return {
    project: { id: data.project.id, name: data.project.name, code: data.project.code, client: data.project.client, location: data.project.location, revision: data.project.revision },
    schedule: { code: type.code, name: type.name },
    generated_at: new Date().toISOString(),
    columns,
    rows,
    totals,
    item_count: rows.length,
  };
}

/** All 13 schedules in one pass (loads project data once). */
async function buildAllSchedules(projectId) {
  const { data: types } = await supabase
    .from("ceks_schedule_types")
    .select("code")
    .eq("is_active", true)
    .order("sort_order");
  const preloaded = await loadProjectData(projectId);
  const out = [];
  for (const t of types || []) out.push(await buildSchedule(projectId, t.code, preloaded));
  return out;
}

/**
 * AUTOCAD-READY SCHEDULE (item 9) — one clean flat table across all utilities:
 * item no · equipment code · utility type · point description · required capacity ·
 * connection size · recommended height · engineering note · colour · symbol.
 */
async function buildAutocadSchedule(projectId, preloaded = null) {
  const data = preloaded || (await loadProjectData(projectId));
  const rows = [];
  for (const loaded of data.items) {
    const versionId = loaded.entry.current_version_id;
    if (!versionId) continue;
    const points = await mep.pointsForVersion(versionId, {
      attributes: loaded.attributes,
      recommendations: loaded.recommendations,
    });
    for (const p of points) {
      rows.push({
        item_number: loaded.item.item_number || "",
        equipment_code: loaded.entry.code || loaded.entry.model_number || "",
        equipment: loaded.entry.title,
        utility_type: p.label,
        utility_code: p.code,
        point_description: p.note || p.label,
        required_capacity: p.value || "",
        connection_size: /size|dn|ø/i.test(p.value || "") ? p.value : "",
        recommended_height: p.height || "",
        engineering_note: p.note || "",
        color: p.color,
        symbol: p.symbol,
        source: p.source,
      });
    }
  }
  return {
    project: { id: data.project.id, name: data.project.name, code: data.project.code, revision: data.project.revision },
    generated_at: new Date().toISOString(),
    rows,
  };
}

/**
 * MEP POINT SCHEDULE (item 10) — per equipment item, its required points grouped by utility,
 * each with point id, colour, symbol, value, unit, height, notes.
 */
async function buildPointSchedule(projectId, preloaded = null) {
  const data = preloaded || (await loadProjectData(projectId));
  const items = [];
  for (const loaded of data.items) {
    const versionId = loaded.entry.current_version_id;
    const points = versionId
      ? await mep.pointsForVersion(versionId, { attributes: loaded.attributes, recommendations: loaded.recommendations })
      : [];
    items.push({
      item_id: loaded.item.id,
      item_number: loaded.item.item_number,
      equipment: loaded.entry.title,
      equipment_code: loaded.entry.code || loaded.entry.model_number,
      area: [loaded.item.area, loaded.item.section, loaded.item.room].filter(Boolean).join(" / ") || null,
      qty: Number(loaded.item.qty || 1),
      points: points.map((p, i) => ({
        point_id: `${loaded.item.item_number || "ITEM"}-${p.code}${i > 0 ? "-" + (i + 1) : ""}`,
        ...p,
      })),
    });
  }
  return {
    project: { id: data.project.id, name: data.project.name, code: data.project.code, revision: data.project.revision },
    generated_at: new Date().toISOString(),
    items,
  };
}

module.exports = { loadProjectData, buildSchedule, buildAllSchedules, buildAutocadSchedule, buildPointSchedule };
