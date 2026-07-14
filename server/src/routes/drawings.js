/**
 * DRAWING WORKSPACE (client items 12–14).
 *
 * Upload a PDF/image plan → place project equipment on it → each placement automatically gets its
 * coloured MEP points (from the equipment's own data) → move / rotate / annotate → save revisions.
 *
 * Coordinates are stored NORMALISED (0..1 of the sheet) so the same data drives the on-screen
 * editor, the annotated export and the AutoCAD coordinate list. The annotated PDF/image export is
 * rendered by the Admin Portal from this exact JSON (browser canvas/print), so what you see is
 * literally what exports.
 */
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { supabase } = require("../config/supabase");
const { env } = require("../config/env");
const auth = require("../services/auth");
const { uploadBuffer } = require("../services/storage");
const mep = require("../services/mepPoints");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.uploadMaxFileMb * 1024 * 1024, files: 1 } });
router.use(auth.authRequired);

const canRead = auth.requirePermission("project.read");
const canManage = auth.requirePermission("project.manage");

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[drawings]", e.stack || e.message);
    res.status(status).json({ error: status >= 500 ? "Something went wrong." : e.message });
  });
const bad = (m, s = 422) => Object.assign(new Error(m), { status: s });
const json = express.json({ limit: "4mb" });

// ── CREATE: upload a plan (PDF or image) into a project ─────────────────────
router.post("/", canManage, upload.single("file"), wrap(async (req, res) => {
  if (!req.file) throw bad("Attach a PDF or image plan.");
  const { project_id, name } = req.body || {};
  if (!project_id) throw bad("project_id is required.");

  const { data: project } = await supabase.from("ceks_projects").select("id").eq("id", project_id).maybeSingle();
  if (!project) throw bad("Project not found.", 404);

  const mime = req.file.mimetype || "";
  const isPdf = mime === "application/pdf" || /\.pdf$/i.test(req.file.originalname);
  const isImage = /^image\//.test(mime);
  if (!isPdf && !isImage) throw bad("Only PDF or image plans are supported.");

  const ext = isPdf ? "pdf" : (req.file.originalname.split(".").pop() || "png").toLowerCase();
  const key = `drawings/${project_id}/${crypto.randomUUID()}.${ext}`;
  const url = await uploadBuffer(key, req.file.buffer, mime || (isPdf ? "application/pdf" : "image/png"));

  const { data, error } = await supabase
    .from("ceks_drawings")
    .insert({
      project_id,
      name: name || req.file.originalname,
      kind: isPdf ? "pdf" : "image",
      storage_url: url,
      created_by: req.user.id,
    })
    .select().single();
  if (error) throw new Error(error.message);
  res.status(201).json(data);
}));

// ── READ: the full editable state of one drawing ─────────────────────────────
async function drawingState(drawingId) {
  const { data: drawing } = await supabase.from("ceks_drawings").select("*").eq("id", drawingId).maybeSingle();
  if (!drawing) throw bad("Drawing not found.", 404);

  const { data: placements } = await supabase
    .from("ceks_drawing_placements")
    .select("*, ceks_project_items(id, item_number, qty, area, section, room, zone, status, entry_id, ceks_knowledge_entries(id, title, code, brand, equipment_type, power_type, current_version_id)), ceks_drawing_points(*, ceks_utility_point_types(code, label, color, symbol))")
    .eq("drawing_id", drawingId)
    .order("created_at");

  const { data: annotations } = await supabase
    .from("ceks_drawing_annotations").select("*").eq("drawing_id", drawingId).order("created_at");

  const { data: revisions } = await supabase
    .from("ceks_drawing_revisions")
    .select("id, revision, label, created_at")
    .eq("drawing_id", drawingId)
    .order("revision", { ascending: false });

  const pointTypes = await mep.loadPointTypes();
  return { drawing, placements: placements || [], annotations: annotations || [], revisions: revisions || [], point_types: pointTypes };
}

router.get("/:id", canRead, wrap(async (req, res) => {
  res.json(await drawingState(req.params.id));
}));

router.patch("/:id", canManage, json, wrap(async (req, res) => {
  const patch = { updated_at: new Date().toISOString() };
  for (const k of ["name", "page", "width", "height", "legend_note"]) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const { data, error } = await supabase.from("ceks_drawings").update(patch).eq("id", req.params.id).select().single();
  if (error) throw new Error(error.message);
  res.json(data);
}));

router.delete("/:id", canManage, wrap(async (req, res) => {
  const { error } = await supabase.from("ceks_drawings").delete().eq("id", req.params.id);
  if (error) throw new Error(error.message);
  res.json({ ok: true });
}));

// ── PLACE equipment on the drawing (item 12) ─────────────────────────────────
// The placement is created WITH its coloured MEP points, generated from the equipment's own data.
router.post("/:id/placements", canManage, json, wrap(async (req, res) => {
  const { project_item_id, x, y } = req.body || {};
  if (!project_item_id) throw bad("Choose the project equipment to place.");

  const { data: drawing } = await supabase.from("ceks_drawings").select("id, project_id").eq("id", req.params.id).maybeSingle();
  if (!drawing) throw bad("Drawing not found.", 404);

  const { data: item } = await supabase
    .from("ceks_project_items")
    .select("id, item_number, project_id, ceks_knowledge_entries(current_version_id)")
    .eq("id", project_item_id).maybeSingle();
  if (!item || item.project_id !== drawing.project_id) throw bad("That equipment does not belong to this project.", 409);

  const { data: placement, error } = await supabase
    .from("ceks_drawing_placements")
    .insert({
      drawing_id: req.params.id,
      project_item_id,
      x: Number(x) || 0.5, y: Number(y) || 0.5,
      label: item.item_number || null,
    })
    .select().single();
  if (error) throw new Error(error.message);

  // auto-generate the coloured utility points, spread around the equipment
  const versionId = item.ceks_knowledge_entries?.current_version_id;
  if (versionId) {
    const points = await mep.pointsForVersion(versionId);
    if (points.length) {
      const rows = points.map((p, i) => ({
        placement_id: placement.id,
        point_type_id: p.point_type_id,
        point_code: `${item.item_number || "ITEM"}-${p.code}`,
        dx: 0.018 * Math.cos((2 * Math.PI * i) / points.length),
        dy: 0.018 * Math.sin((2 * Math.PI * i) / points.length),
        value: p.value, unit: p.unit, height: p.height, note: p.note,
      }));
      await supabase.from("ceks_drawing_points").insert(rows);
    }
  }

  const state = await drawingState(req.params.id);
  res.status(201).json({ placement_id: placement.id, ...state });
}));

router.patch("/:id/placements/:pid", canManage, json, wrap(async (req, res) => {
  const patch = { updated_at: new Date().toISOString() };
  for (const k of ["x", "y", "rotation", "scale", "label"]) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const { data, error } = await supabase
    .from("ceks_drawing_placements").update(patch)
    .eq("id", req.params.pid).eq("drawing_id", req.params.id)
    .select().single();
  if (error) throw new Error(error.message);
  res.json(data);
}));

router.delete("/:id/placements/:pid", canManage, wrap(async (req, res) => {
  const { error } = await supabase
    .from("ceks_drawing_placements").delete()
    .eq("id", req.params.pid).eq("drawing_id", req.params.id);
  if (error) throw new Error(error.message);
  res.json({ ok: true });
}));

/** regenerate a placement's points from the CURRENT equipment data (e.g. after recalculation) */
router.post("/:id/placements/:pid/regenerate-points", canManage, wrap(async (req, res) => {
  const { data: pl } = await supabase
    .from("ceks_drawing_placements")
    .select("id, ceks_project_items(item_number, ceks_knowledge_entries(current_version_id))")
    .eq("id", req.params.pid).eq("drawing_id", req.params.id).maybeSingle();
  if (!pl) throw bad("Placement not found.", 404);
  const versionId = pl.ceks_project_items?.ceks_knowledge_entries?.current_version_id;
  if (!versionId) throw bad("The equipment has no data version.");

  await supabase.from("ceks_drawing_points").delete().eq("placement_id", pl.id);
  const points = await mep.pointsForVersion(versionId);
  if (points.length) {
    await supabase.from("ceks_drawing_points").insert(points.map((p, i) => ({
      placement_id: pl.id,
      point_type_id: p.point_type_id,
      point_code: `${pl.ceks_project_items?.item_number || "ITEM"}-${p.code}`,
      dx: 0.018 * Math.cos((2 * Math.PI * i) / points.length),
      dy: 0.018 * Math.sin((2 * Math.PI * i) / points.length),
      value: p.value, unit: p.unit, height: p.height, note: p.note,
    })));
  }
  res.json(await drawingState(req.params.id));
}));

// ── POINTS: move / edit / hide / add / remove (items 10–12) ──────────────────
router.post("/:id/points", canManage, json, wrap(async (req, res) => {
  const { placement_id, point_type_id, dx, dy, value, unit, height, note, point_code } = req.body || {};
  if (!placement_id || !point_type_id) throw bad("placement_id and point_type_id are required.");
  const { data, error } = await supabase
    .from("ceks_drawing_points")
    .insert({
      placement_id, point_type_id,
      dx: Number(dx) || 0, dy: Number(dy) || 0,
      value: value || null, unit: unit || null, height: height || null, note: note || null,
      point_code: point_code || null,
    })
    .select("*, ceks_utility_point_types(code, label, color, symbol)").single();
  if (error) throw new Error(error.message);
  res.status(201).json(data);
}));

router.patch("/:id/points/:pointId", canManage, json, wrap(async (req, res) => {
  const patch = { updated_at: new Date().toISOString() };
  for (const k of ["dx", "dy", "value", "unit", "height", "note", "is_visible", "point_code"]) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  const { data, error } = await supabase
    .from("ceks_drawing_points").update(patch).eq("id", req.params.pointId)
    .select("*, ceks_utility_point_types(code, label, color, symbol)").single();
  if (error) throw new Error(error.message);
  res.json(data);
}));

router.delete("/:id/points/:pointId", canManage, wrap(async (req, res) => {
  const { error } = await supabase.from("ceks_drawing_points").delete().eq("id", req.params.pointId);
  if (error) throw new Error(error.message);
  res.json({ ok: true });
}));

// ── ANNOTATIONS: notes, labels, dimensions (item 12) ─────────────────────────
router.post("/:id/annotations", canManage, json, wrap(async (req, res) => {
  const { kind, text, x, y, x2, y2, color } = req.body || {};
  if (!text || !String(text).trim()) throw bad("The annotation needs text.");
  const k = ["note", "label", "dimension"].includes(kind) ? kind : "note";
  const { data, error } = await supabase
    .from("ceks_drawing_annotations")
    .insert({
      drawing_id: req.params.id, kind: k, text: String(text).trim(),
      x: Number(x) || 0.5, y: Number(y) || 0.5,
      x2: x2 != null ? Number(x2) : null, y2: y2 != null ? Number(y2) : null,
      color: color || null,
    })
    .select().single();
  if (error) throw new Error(error.message);
  res.status(201).json(data);
}));

router.patch("/:id/annotations/:aid", canManage, json, wrap(async (req, res) => {
  const patch = {};
  for (const k of ["text", "x", "y", "x2", "y2", "color", "kind"]) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const { data, error } = await supabase
    .from("ceks_drawing_annotations").update(patch)
    .eq("id", req.params.aid).eq("drawing_id", req.params.id)
    .select().single();
  if (error) throw new Error(error.message);
  res.json(data);
}));

router.delete("/:id/annotations/:aid", canManage, wrap(async (req, res) => {
  const { error } = await supabase
    .from("ceks_drawing_annotations").delete()
    .eq("id", req.params.aid).eq("drawing_id", req.params.id);
  if (error) throw new Error(error.message);
  res.json({ ok: true });
}));

// ── REVISIONS: freeze the whole annotated state (item 12) ────────────────────
router.post("/:id/revisions", canManage, json, wrap(async (req, res) => {
  const state = await drawingState(req.params.id);
  const revision = state.drawing.revision || 1;
  const { data, error } = await supabase
    .from("ceks_drawing_revisions")
    .insert({
      drawing_id: req.params.id,
      revision,
      label: req.body?.label || `Revision ${revision}`,
      snapshot: {
        placements: state.placements,
        annotations: state.annotations,
        saved_at: new Date().toISOString(),
      },
      created_by: req.user.id,
    })
    .select().single();
  if (error) throw new Error(error.message);
  await supabase.from("ceks_drawings")
    .update({ revision: revision + 1, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);
  res.status(201).json(data);
}));

router.get("/:id/revisions/:rev", canRead, wrap(async (req, res) => {
  const { data } = await supabase
    .from("ceks_drawing_revisions").select("*")
    .eq("drawing_id", req.params.id).eq("revision", Number(req.params.rev))
    .maybeSingle();
  if (!data) throw bad("Revision not found.", 404);
  res.json(data);
}));

module.exports = router;
