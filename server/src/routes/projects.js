/**
 * PROJECT ENGINEERING WORKSPACE (client items 7, 8, 9, 10, 15, 16).
 *
 * Projects select APPROVED EOS equipment, give each an item number / qty / area / zone, and from
 * that selection generate every engineering schedule, the AutoCAD-ready table, the MEP point
 * schedule, the coordinate export and the project engineering report.
 *
 * Excel/CSV exports are produced here (xlsx). Print-ready/PDF outputs are rendered by the Admin
 * Portal from the same JSON, so the numbers can never disagree between formats.
 */
const express = require("express");
const XLSX = require("xlsx");
const { supabase } = require("../config/supabase");
const auth = require("../services/auth");
const schedules = require("../services/schedules");
const mep = require("../services/mepPoints");

const router = express.Router();
router.use(express.json({ limit: "2mb" }));
router.use(auth.authRequired);

const canRead = auth.requirePermission("project.read");
const canManage = auth.requirePermission("project.manage");
const canExport = auth.requirePermission("project.export");

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[projects]", e.stack || e.message);
    res.status(status).json({ error: status >= 500 ? "Something went wrong." : e.message });
  });
const bad = (m, s = 422) => Object.assign(new Error(m), { status: s });

const audit = (user, id, action, changes) =>
  supabase.from("ceks_audit_log").insert({
    user_id: user?.id || null, actor_name: user?.full_name || user?.email || null,
    entity_type: "project", entity_id: id, action, changes: changes || null,
  });

// ── PROJECTS ──────────────────────────────────────────────────────────────────
router.get("/", canRead, wrap(async (req, res) => {
  let q = supabase
    .from("ceks_projects")
    .select("*, ceks_project_items(count)")
    .order("created_at", { ascending: false });
  if (req.query.status) q = q.eq("status", req.query.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  res.json(data || []);
}));

router.post("/", canManage, wrap(async (req, res) => {
  const { name, code, client, location, description } = req.body || {};
  if (!name || !String(name).trim()) throw bad("A project name is required.");
  const { data, error } = await supabase
    .from("ceks_projects")
    .insert({
      name: String(name).trim(), code: code ? String(code).trim() : null,
      client: client || null, location: location || null, description: description || null,
      status: "draft", created_by: req.user.id,
    })
    .select().single();
  if (error) throw bad(error.code === "23505" ? `Project code "${code}" already exists.` : error.message);
  await audit(req.user, data.id, "created", { name: data.name });
  res.status(201).json(data);
}));

router.get("/meta/point-types", canRead, wrap(async (_req, res) => {
  res.json(await mep.loadPointTypes());
}));

router.get("/meta/schedule-types", canRead, wrap(async (_req, res) => {
  const { data } = await supabase.from("ceks_schedule_types").select("*").eq("is_active", true).order("sort_order");
  res.json(data || []);
}));

router.get("/:id", canRead, wrap(async (req, res) => {
  const { data: project } = await supabase.from("ceks_projects").select("*").eq("id", req.params.id).maybeSingle();
  if (!project) throw bad("Project not found.", 404);

  const { data: items } = await supabase
    .from("ceks_project_items")
    .select("*, ceks_knowledge_entries(id, title, code, brand, category, equipment_type, power_type, model_number, current_status)")
    .eq("project_id", req.params.id)
    .neq("status", "removed")
    .order("sort_order").order("created_at");

  const { data: revisions } = await supabase
    .from("ceks_project_item_revisions")
    .select("id, revision, label, created_at, created_by")
    .eq("project_id", req.params.id)
    .order("revision", { ascending: false });

  const { data: drawings } = await supabase
    .from("ceks_drawings")
    .select("id, name, kind, storage_url, revision, updated_at")
    .eq("project_id", req.params.id)
    .order("created_at");

  res.json({ ...project, items: items || [], revisions: revisions || [], drawings: drawings || [] });
}));

router.patch("/:id", canManage, wrap(async (req, res) => {
  const patch = { updated_at: new Date().toISOString() };
  for (const k of ["name", "code", "client", "location", "description", "status"]) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  if (patch.status && !["draft", "under_review", "approved", "published", "archived"].includes(patch.status)) {
    throw bad("Invalid status.");
  }
  const { data, error } = await supabase.from("ceks_projects").update(patch).eq("id", req.params.id).select().single();
  if (error) throw new Error(error.message);
  await audit(req.user, req.params.id, "updated", patch);
  res.json(data);
}));

// ── EQUIPMENT SELECTION (item 7) ─────────────────────────────────────────────
router.post("/:id/items", canManage, wrap(async (req, res) => {
  const { entry_id, qty, item_number, area, section, room, zone, notes } = req.body || {};
  if (!entry_id) throw bad("Choose an equipment entry.");

  // only APPROVED equipment may enter a project — that is the whole point of the review flow
  const { data: entry } = await supabase
    .from("ceks_knowledge_entries")
    .select("id, title, current_status")
    .eq("id", entry_id).maybeSingle();
  if (!entry) throw bad("Equipment entry not found.", 404);
  if (entry.current_status !== "approved") {
    throw bad(`"${entry.title}" is not approved yet — only approved equipment can be added to a project.`, 409);
  }

  const { count } = await supabase
    .from("ceks_project_items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", req.params.id);

  const { data, error } = await supabase
    .from("ceks_project_items")
    .insert({
      project_id: req.params.id,
      entry_id,
      qty: Number(qty) > 0 ? Number(qty) : 1,
      item_number: item_number || `K-${String((count || 0) + 1).padStart(2, "0")}`,
      area: area || null, section: section || null, room: room || null, zone: zone || null,
      notes: notes || null,
      sort_order: (count || 0) + 1,
      created_by: req.user.id,
    })
    .select("*, ceks_knowledge_entries(id, title, code, brand, equipment_type, power_type)")
    .single();
  if (error) throw new Error(error.message);
  await audit(req.user, req.params.id, "item_added", { entry: entry.title });
  res.status(201).json(data);
}));

router.patch("/:id/items/:itemId", canManage, wrap(async (req, res) => {
  const patch = { updated_at: new Date().toISOString() };
  for (const k of ["qty", "item_number", "area", "section", "room", "zone", "notes", "sort_order"]) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  if (patch.qty != null && !(Number(patch.qty) > 0)) throw bad("Quantity must be a positive number.");
  const { data, error } = await supabase
    .from("ceks_project_items").update(patch)
    .eq("id", req.params.itemId).eq("project_id", req.params.id)
    .select().single();
  if (error) throw new Error(error.message);
  res.json(data);
}));

/** Replace with an approved alternative (item 7) — the old line is kept, marked "replaced". */
router.post("/:id/items/:itemId/replace", canManage, wrap(async (req, res) => {
  const { entry_id } = req.body || {};
  if (!entry_id) throw bad("Choose the replacement equipment.");

  const { data: oldItem } = await supabase
    .from("ceks_project_items").select("*").eq("id", req.params.itemId).eq("project_id", req.params.id).maybeSingle();
  if (!oldItem) throw bad("Project item not found.", 404);

  const { data: entry } = await supabase
    .from("ceks_knowledge_entries").select("id, title, current_status").eq("id", entry_id).maybeSingle();
  if (!entry) throw bad("Replacement entry not found.", 404);
  if (entry.current_status !== "approved") throw bad(`"${entry.title}" is not approved — it cannot replace project equipment.`, 409);

  const { data: newItem, error } = await supabase
    .from("ceks_project_items")
    .insert({
      project_id: req.params.id, entry_id,
      qty: oldItem.qty, item_number: oldItem.item_number,
      area: oldItem.area, section: oldItem.section, room: oldItem.room, zone: oldItem.zone,
      notes: oldItem.notes, sort_order: oldItem.sort_order, created_by: req.user.id,
    })
    .select().single();
  if (error) throw new Error(error.message);

  await supabase.from("ceks_project_items")
    .update({ status: "replaced", replaced_by: newItem.id, updated_at: new Date().toISOString() })
    .eq("id", oldItem.id);

  // drawing placements follow the replacement, so the plan does not lose the position
  await supabase.from("ceks_drawing_placements").update({ project_item_id: newItem.id }).eq("project_item_id", oldItem.id);

  await audit(req.user, req.params.id, "item_replaced", { from: oldItem.entry_id, to: entry_id });
  res.json({ replaced: oldItem.id, item: newItem });
}));

router.delete("/:id/items/:itemId", canManage, wrap(async (req, res) => {
  const { error } = await supabase
    .from("ceks_project_items")
    .update({ status: "removed", updated_at: new Date().toISOString() })
    .eq("id", req.params.itemId).eq("project_id", req.params.id);
  if (error) throw new Error(error.message);
  await audit(req.user, req.params.id, "item_removed", { item: req.params.itemId });
  res.json({ ok: true });
}));

// ── REVISIONS (item 7: "save multiple equipment revisions") ──────────────────
router.post("/:id/revisions", canManage, wrap(async (req, res) => {
  const { data: project } = await supabase.from("ceks_projects").select("*").eq("id", req.params.id).maybeSingle();
  if (!project) throw bad("Project not found.", 404);

  const { data: items } = await supabase
    .from("ceks_project_items")
    .select("*, ceks_knowledge_entries(title, code, brand)")
    .eq("project_id", req.params.id)
    .eq("status", "active");

  const revision = (project.revision || 1);
  const { data, error } = await supabase
    .from("ceks_project_item_revisions")
    .insert({
      project_id: req.params.id, revision,
      label: req.body?.label || `Revision ${revision}`,
      snapshot: { items: items || [], saved_at: new Date().toISOString() },
      created_by: req.user.id,
    })
    .select().single();
  if (error) throw new Error(error.message);

  await supabase.from("ceks_projects")
    .update({ revision: revision + 1, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);

  await audit(req.user, req.params.id, "revision_saved", { revision });
  res.status(201).json(data);
}));

router.get("/:id/revisions/:rev", canRead, wrap(async (req, res) => {
  const { data } = await supabase
    .from("ceks_project_item_revisions")
    .select("*")
    .eq("project_id", req.params.id).eq("revision", Number(req.params.rev))
    .maybeSingle();
  if (!data) throw bad("Revision not found.", 404);
  res.json(data);
}));

// ── SCHEDULES (item 8) ────────────────────────────────────────────────────────
router.get("/:id/schedules", canRead, wrap(async (req, res) => {
  res.json(await schedules.buildAllSchedules(req.params.id));
}));

router.get("/:id/schedules/:code", canRead, wrap(async (req, res) => {
  res.json(await schedules.buildSchedule(req.params.id, req.params.code));
}));

// ── EXPORTS ──────────────────────────────────────────────────────────────────
function sheetFromSchedule(s) {
  const header = s.columns.map((c) => c.label);
  const rows = s.rows.map((r) => s.columns.map((c) => r[c.key] ?? ""));
  if (Object.keys(s.totals || {}).length) {
    rows.push(s.columns.map((c, i) => (i === 0 ? "TOTAL" : s.totals[c.key] ?? "")));
  }
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = s.columns.map((c) => ({ wch: Math.max(12, c.label.length + 2) }));
  return ws;
}

const sendXlsx = (res, wb, filename) => {
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buf);
};

const sendCsv = (res, ws, filename) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(XLSX.utils.sheet_to_csv(ws));
};

const safe = (s) => String(s || "project").replace(/[^\w\-]+/g, "_").slice(0, 60);

/** one schedule → .xlsx or .csv */
router.get("/:id/schedules/:code/export", canExport, wrap(async (req, res) => {
  const s = await schedules.buildSchedule(req.params.id, req.params.code);
  const ws = sheetFromSchedule(s);
  const base = `${safe(s.project.code || s.project.name)}_${s.schedule.code}`;
  if ((req.query.format || "xlsx") === "csv") return sendCsv(res, ws, `${base}.csv`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, s.schedule.name.slice(0, 31));
  sendXlsx(res, wb, `${base}.xlsx`);
}));

/** every schedule in one workbook — the full engineering package */
router.get("/:id/schedules-export/all", canExport, wrap(async (req, res) => {
  const all = await schedules.buildAllSchedules(req.params.id);
  if (!all.length) throw bad("No active schedules.");
  const wb = XLSX.utils.book_new();
  for (const s of all) XLSX.utils.book_append_sheet(wb, sheetFromSchedule(s), s.schedule.name.slice(0, 31));
  sendXlsx(res, wb, `${safe(all[0].project.code || all[0].project.name)}_MEP_Schedules.xlsx`);
}));

/** AUTOCAD-READY schedule (item 9) — clean flat table, xlsx or csv */
router.get("/:id/autocad-schedule", canExport, wrap(async (req, res) => {
  const a = await schedules.buildAutocadSchedule(req.params.id);
  const header = ["Item No.", "Equipment Code", "Equipment", "Utility Type", "Point Description",
    "Required Capacity", "Connection Size", "Recommended Height", "Engineering Note", "Color", "Symbol"];
  const rows = a.rows.map((r) => [r.item_number, r.equipment_code, r.equipment, r.utility_type,
    r.point_description, r.required_capacity, r.connection_size, r.recommended_height,
    r.engineering_note, r.color, r.symbol]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((h) => ({ wch: Math.max(14, h.length + 2) }));
  const base = `${safe(a.project.code || a.project.name)}_AutoCAD_Schedule`;
  if (req.query.format === "json") return res.json(a);
  if (req.query.format === "csv") return sendCsv(res, ws, `${base}.csv`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "AutoCAD Schedule");
  sendXlsx(res, wb, `${base}.xlsx`);
}));

/** MEP POINT SCHEDULE (item 10) */
router.get("/:id/mep-points", canRead, wrap(async (req, res) => {
  res.json(await schedules.buildPointSchedule(req.params.id));
}));

router.get("/:id/mep-points/export", canExport, wrap(async (req, res) => {
  const s = await schedules.buildPointSchedule(req.params.id);
  const header = ["Point ID", "Item No.", "Equipment", "Equipment Code", "Area", "Utility", "Code",
    "Value", "Height", "Notes", "Color", "Symbol", "Source"];
  const rows = [];
  for (const it of s.items) {
    for (const p of it.points) {
      rows.push([p.point_id, it.item_number, it.equipment, it.equipment_code, it.area || "",
        p.label, p.code, p.value || "", p.height || "", p.note || "", p.color, p.symbol, p.source || ""]);
    }
  }
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const base = `${safe(s.project.code || s.project.name)}_MEP_Points`;
  if (req.query.format === "csv") return sendCsv(res, ws, `${base}.csv`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "MEP Points");
  sendXlsx(res, wb, `${base}.xlsx`);
}));

/**
 * COORDINATE EXPORT (item 15) — every placed equipment + utility point with X/Y/rotation,
 * for the design team to use inside AutoCAD. Coordinates are normalised 0..1 plus the
 * drawing's native size so they can be scaled to any sheet.
 */
router.get("/:id/coordinates/export", canExport, wrap(async (req, res) => {
  const { data: drawings } = await supabase
    .from("ceks_drawings").select("*").eq("project_id", req.params.id);
  if (!drawings?.length) throw bad("This project has no drawings yet.");

  const header = ["Drawing", "Revision", "Equipment ID", "Item No.", "Equipment", "X", "Y", "Rotation",
    "Point Type", "Point Code", "Point X", "Point Y", "Color", "Symbol", "Value", "Connection Height", "Notes"];
  const rows = [];

  for (const d of drawings) {
    const { data: placements } = await supabase
      .from("ceks_drawing_placements")
      .select("*, ceks_project_items(item_number, entry_id, ceks_knowledge_entries(title, code)), ceks_drawing_points(*, ceks_utility_point_types(code, label, color, symbol))")
      .eq("drawing_id", d.id);
    for (const pl of placements || []) {
      const item = pl.ceks_project_items;
      const entry = item?.ceks_knowledge_entries;
      const base = [d.name, d.revision, entry?.code || "", item?.item_number || "", entry?.title || "",
        Number(pl.x).toFixed(4), Number(pl.y).toFixed(4), Number(pl.rotation).toFixed(1)];
      const points = pl.ceks_drawing_points || [];
      if (!points.length) rows.push([...base, "", "", "", "", "", "", "", "", ""]);
      for (const pt of points) {
        const t = pt.ceks_utility_point_types;
        rows.push([...base, t?.label || "", pt.point_code || t?.code || "",
          (Number(pl.x) + Number(pt.dx)).toFixed(4), (Number(pl.y) + Number(pt.dy)).toFixed(4),
          t?.color || "", t?.symbol || "", pt.value || "", pt.height || "", pt.note || ""]);
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  const { data: project } = await supabase.from("ceks_projects").select("name, code").eq("id", req.params.id).single();
  const base = `${safe(project?.code || project?.name)}_Coordinates`;
  if (req.query.format === "csv") return sendCsv(res, ws, `${base}.csv`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Coordinates");
  sendXlsx(res, wb, `${base}.xlsx`);
}));

/**
 * PROJECT ENGINEERING REPORT (item 16) — equipment list, manufacturer data vs CULINOVA
 * recommendations per discipline, missing info, approval status, rule traceability, documents.
 * JSON here; the Admin Portal renders it print-ready (browser PDF) and Excel via the exports above.
 */
router.get("/:id/report", canRead, wrap(async (req, res) => {
  const data = await schedules.loadProjectData(req.params.id);
  const dict = data.dict;

  // optional filter: ?area=Main Kitchen  or  ?items=id1,id2
  let items = data.items;
  if (req.query.area) items = items.filter((x) => (x.item.area || "") === req.query.area);
  if (req.query.items) {
    const wanted = new Set(String(req.query.items).split(","));
    items = items.filter((x) => wanted.has(x.item.id));
  }

  const out = [];
  for (const loaded of items) {
    const versionId = loaded.entry.current_version_id;
    let validations = [];
    if (versionId) {
      const { data: v } = await supabase
        .from("ceks_validations").select("*").eq("version_id", versionId).eq("status", "open");
      validations = v || [];
    }
    const recsByDiscipline = {};
    for (const r of loaded.recommendations) {
      const p = dict.paramById.get(r.parameter_id);
      const d = p?.discipline_id ? dict.disciplineById.get(p.discipline_id) : null;
      const key = d?.code || "general";
      if (!recsByDiscipline[key]) recsByDiscipline[key] = { discipline: d?.name || "General", rows: [] };
      recsByDiscipline[key].rows.push({
        parameter: p?.label || "?",
        culinova_value: r.final_value ?? r.value_text ?? (r.value_num != null ? String(r.value_num) : null),
        unit: r.final_unit || r.unit,
        manufacturer_value: r.manufacturer_value,
        manufacturer_unit: r.manufacturer_unit,
        status: r.status,
        traceability: r.rule_code ? `Generated from Rule ${r.rule_code} (v${r.rule_version})` : null,
      });
    }
    const points = versionId
      ? await mep.pointsForVersion(versionId, { attributes: loaded.attributes, recommendations: loaded.recommendations })
      : [];
    const { data: docs } = await supabase
      .from("ceks_import_documents").select("id, file_name, doc_type, storage_url")
      .eq("knowledge_entry_id", loaded.entry.id);

    out.push({
      item_number: loaded.item.item_number,
      qty: Number(loaded.item.qty || 1),
      area: [loaded.item.area, loaded.item.section, loaded.item.room].filter(Boolean).join(" / ") || null,
      zone: loaded.item.zone,
      equipment: {
        id: loaded.entry.id, title: loaded.entry.title, code: loaded.entry.code,
        brand: loaded.entry.brand, type: loaded.entry.equipment_type, power_type: loaded.entry.power_type,
        status: loaded.entry.current_status,
      },
      manufacturer_data: loaded.attributes.map((a) => ({
        group: a.attr_group, name: a.name, value: a.value, unit: a.unit,
        source: a.source_document ? `${a.source_document}${a.source_page ? ", p." + a.source_page : ""}` : null,
      })),
      culinova_recommendations: Object.values(recsByDiscipline),
      mep_points: points,
      missing_information: validations.map((v) => ({ severity: v.severity, message: v.message, reason: v.reason })),
      documents: docs || [],
    });
  }

  res.json({
    project: {
      id: data.project.id, name: data.project.name, code: data.project.code,
      client: data.project.client, location: data.project.location,
      revision: data.project.revision, status: data.project.status,
    },
    generated_at: new Date().toISOString(),
    generated_by: req.user.full_name || req.user.email,
    item_count: out.length,
    items: out,
  });
}));

module.exports = router;
