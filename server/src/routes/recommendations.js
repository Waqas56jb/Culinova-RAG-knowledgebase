/**
 * RECOMMENDATIONS — the API behind the CULINOVA engineering recommendations shown on the Review
 * screen, plus the Engineering Recommendation Report.
 *
 * The engine itself lives in services/recommendations.js and services/ruleEngine.js. This router is
 * the thin, guarded HTTP layer over it. It NEVER contains an engineering value or a formula.
 *
 * Client requirements honoured here:
 *   • Traceability (item 5): every recommendation carries its rule id, category, version, the exact
 *     inputs used, and who decided it.
 *   • History (item 6): the full decision/recalculation trail per item.
 *   • Reports (item 8): per-item now; project-level aggregation over many items too.
 *   • Approval gate: an entry cannot be approved while a recommendation is unresolved.
 */
const express = require("express");
const { supabase } = require("../config/supabase");
const auth = require("../services/auth");
const recs = require("../services/recommendations");
const dictSvc = require("../services/params");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use(auth.authRequired);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[recommendations]", e.stack || e.message);
    res.status(status).json({ error: status >= 500 ? "Something went wrong." : e.message });
  });
const bad = (m, s = 422) => Object.assign(new Error(m), { status: s });

const canRead = auth.requirePermission("recommendation.read");
const canRun = auth.requirePermission("recommendation.run");
const canDecide = auth.requirePermission("recommendation.decide");

/** entry → its current knowledge version. Most callers hold an entry id, not a version id. */
async function currentVersionId(entryId) {
  const { data: entry } = await supabase
    .from("ceks_knowledge_entries")
    .select("id, current_version_id, title, code")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) throw bad("Equipment entry not found.", 404);
  if (!entry.current_version_id) throw bad("This entry has no version yet.", 409);
  return { entry, versionId: entry.current_version_id };
}

// ── READ: everything the Review screen needs for one entry/version ───────────
router.get("/entry/:entryId", canRead, wrap(async (req, res) => {
  const { entry, versionId } = await currentVersionId(req.params.entryId);
  const data = await recs.forVersion(versionId);
  res.json({ entry: { id: entry.id, title: entry.title, code: entry.code }, ...data });
}));

router.get("/version/:versionId", canRead, wrap(async (req, res) => {
  res.json(await recs.forVersion(req.params.versionId));
}));

// ── RUN THE ENGINE ────────────────────────────────────────────────────────────
router.post("/entry/:entryId/generate", canRun, wrap(async (req, res) => {
  const { versionId } = await currentVersionId(req.params.entryId);
  const out = await recs.generateForVersion(versionId, { actor: req.user, trigger: req.body?.trigger || "manual" });
  res.json(out);
}));

router.post("/version/:versionId/generate", canRun, wrap(async (req, res) => {
  const out = await recs.generateForVersion(req.params.versionId, { actor: req.user, trigger: req.body?.trigger || "manual" });
  res.json(out);
}));

/**
 * Recalculate — the deliberate action an engineer takes after a "Recalculation Available" alert.
 * Nothing is auto-rewritten; this is the human choosing to apply the new rule version, and it clears
 * the alert once done.
 */
router.post("/version/:versionId/recalculate", canRun, wrap(async (req, res) => {
  const out = await recs.generateForVersion(req.params.versionId, { actor: req.user, trigger: "recalculate" });
  await supabase
    .from("ceks_recalc_alerts")
    .update({ status: "recalculated", handled_by: req.user.id, handled_at: new Date().toISOString() })
    .eq("version_id", req.params.versionId)
    .eq("status", "pending");
  res.json({ ...out, recalculated: true });
}));

// ── THE ENGINEER'S DECISION (accept / modify / reject — reason mandatory) ─────
router.post("/:recommendationId/decide", canDecide, wrap(async (req, res) => {
  const { action, value, unit, note } = req.body || {};
  const updated = await recs.decide(req.params.recommendationId, { action, value, unit, note, actor: req.user });
  res.json(updated);
}));

// ── TRACEABILITY — the full provenance of ONE recommendation ─────────────────
router.get("/:recommendationId/trace", canRead, wrap(async (req, res) => {
  const { data: rec } = await supabase
    .from("ceks_recommendations")
    .select("*")
    .eq("id", req.params.recommendationId)
    .maybeSingle();
  if (!rec) throw bad("Recommendation not found.", 404);

  const dict = await dictSvc.load();
  const param = dict.paramById.get(rec.parameter_id);
  const discipline = rec.discipline_id ? dict.disciplineById.get(rec.discipline_id) : null;

  // the exact rule TEXT that produced it, frozen at approval — never the live rule
  let ruleSnapshot = null;
  if (rec.rule_id) {
    const { data: ver } = await supabase
      .from("ceks_rule_versions")
      .select("snapshot, approved_at, approved_by")
      .eq("rule_id", rec.rule_id)
      .eq("version", rec.rule_version)
      .maybeSingle();
    ruleSnapshot = ver || null;
  }

  const { data: history } = await supabase
    .from("ceks_recommendation_history")
    .select("*")
    .eq("recommendation_id", rec.id)
    .order("created_at", { ascending: true });

  res.json({
    recommendation: {
      ...rec,
      parameter_key: param?.key,
      parameter_label: param?.label,
    },
    // printed exactly like the client's example
    statement: rec.rule_code
      ? `Generated from ${discipline?.name || ""} Rule ${rec.rule_code} (v${rec.rule_version})`.replace(/\s+/g, " ").trim()
      : "Set manually — no rule matched.",
    discipline: discipline || null,
    manufacturer: rec.manufacturer_value != null
      ? { value: rec.manufacturer_value, unit: rec.manufacturer_unit, attribute_id: rec.manufacturer_attribute_id }
      : null,
    matched_conditions: rec.matched_conditions || [],
    inputs_used: rec.inputs_used || [],
    rule_snapshot: ruleSnapshot?.snapshot || null,
    rule_approved_at: ruleSnapshot?.approved_at || null,
    history: history || [],
  });
}));

// ── HISTORY (item 6) — the whole trail for an entry/version ──────────────────
router.get("/version/:versionId/history", canRead, wrap(async (req, res) => {
  const { data } = await supabase
    .from("ceks_recommendation_history")
    .select("*, ceks_parameters(key,label)")
    .eq("version_id", req.params.versionId)
    .order("created_at", { ascending: false });
  res.json(data || []);
}));

// ── APPROVAL BLOCKERS — why this entry cannot be approved yet ─────────────────
router.get("/version/:versionId/blockers", canRead, wrap(async (req, res) => {
  const blockers = await recs.approvalBlockers(req.params.versionId);
  res.json({ can_approve: blockers.length === 0, blockers });
}));

// ── VALIDATIONS (item 4) ──────────────────────────────────────────────────────
router.get("/version/:versionId/validations", canRead, wrap(async (req, res) => {
  const { data } = await supabase
    .from("ceks_validations")
    .select("*, ceks_parameters(key,label)")
    .eq("version_id", req.params.versionId)
    .order("severity")
    .order("created_at");
  res.json(data || []);
}));

router.post("/validations/:id/resolve", canDecide, wrap(async (req, res) => {
  const { data, error } = await supabase
    .from("ceks_validations")
    .update({
      status: "resolved",
      resolved_by: req.user.id,
      resolved_at: new Date().toISOString(),
      resolution_note: req.body?.note || "Resolved by engineer.",
    })
    .eq("id", req.params.id)
    .select().single();
  if (error) throw new Error(error.message);
  res.json(data);
}));

// ── ENGINEERING RECOMMENDATION REPORT (item 7) — per item ────────────────────
async function buildItemReport(versionId) {
  const { data: version } = await supabase
    .from("ceks_knowledge_versions")
    .select("id, version_number, status, knowledge_entry_id")
    .eq("id", versionId)
    .maybeSingle();
  if (!version) throw bad("Version not found.", 404);

  const { data: entry } = await supabase
    .from("ceks_knowledge_entries")
    .select("id, title, code, current_status")
    .eq("id", version.knowledge_entry_id)
    .maybeSingle();

  const data = await recs.forVersion(versionId);

  const disciplines = data.disciplines.map((d) => ({
    discipline: d.discipline,
    rows: d.items.map((r) => ({
      parameter: r.parameter_label,
      culinova_value: r.final_value ?? r.value_text ?? (r.value_num != null ? String(r.value_num) : null),
      unit: r.final_unit || r.unit,
      manufacturer_value: r.manufacturer_value,
      manufacturer_unit: r.manufacturer_unit,
      status: r.status,
      decided_by: r.decided_by,
      decision_note: r.decision_note,
      confidence: r.confidence,
      traceability: r.traceability,   // "Generated from Electrical Rule E-006 (v1)"
    })),
  }));

  return {
    generated_at: new Date().toISOString(),
    entry: entry || null,
    version: { id: version.id, number: version.version_number, status: version.status },
    disciplines,
    validations: (data.validations || []).map((v) => ({ severity: v.severity, code: v.code, message: v.message, status: v.status })),
    recalc_alerts: data.recalc_alerts || [],
    approval: { can_approve: data.blockers.length === 0, blockers: data.blockers },
    totals: {
      recommendations: (data.recommendations || []).length,
      accepted: (data.recommendations || []).filter((r) => r.status === "accepted").length,
      modified: (data.recommendations || []).filter((r) => r.status === "modified").length,
      rejected: (data.recommendations || []).filter((r) => r.status === "rejected").length,
      open_validations: (data.validations || []).filter((v) => v.status === "open").length,
    },
  };
}

router.get("/entry/:entryId/report", canRead, wrap(async (req, res) => {
  const { versionId } = await currentVersionId(req.params.entryId);
  res.json(await buildItemReport(versionId));
}));

router.get("/version/:versionId/report", canRead, wrap(async (req, res) => {
  res.json(await buildItemReport(req.params.versionId));
}));

/**
 * PROJECT-LEVEL AGGREGATION (item 8 — "project-level aggregation must remain part of Phase 2").
 * Give it a set of entry ids; it aggregates the per-item reports into discipline schedules — the
 * shape the Layer-3 schedule generators will consume, but available now for a report over any
 * selection of equipment.
 */
router.post("/report/aggregate", canRead, wrap(async (req, res) => {
  const entryIds = Array.isArray(req.body?.entry_ids) ? req.body.entry_ids : [];
  if (!entryIds.length) throw bad("Give a list of entry_ids.");
  if (entryIds.length > 500) throw bad("Too many items in one report (max 500).");

  const items = [];
  const byDiscipline = {};
  const problems = [];

  for (const entryId of entryIds) {
    try {
      const { versionId, entry } = await currentVersionId(entryId);
      const report = await buildItemReport(versionId);
      items.push({ entry_id: entryId, title: entry.title, code: entry.code, totals: report.totals, can_approve: report.approval.can_approve });

      for (const d of report.disciplines) {
        const key = d.discipline.code;
        if (!byDiscipline[key]) byDiscipline[key] = { discipline: d.discipline, rows: [] };
        for (const row of d.rows) {
          byDiscipline[key].rows.push({ equipment: entry.title, equipment_code: entry.code, ...row });
        }
      }
    } catch (e) {
      problems.push({ entry_id: entryId, error: e.message });
    }
  }

  res.json({
    generated_at: new Date().toISOString(),
    item_count: items.length,
    items,
    schedules: Object.values(byDiscipline),
    problems,
    totals: {
      equipment: items.length,
      approvable: items.filter((i) => i.can_approve).length,
      blocked: items.filter((i) => !i.can_approve).length,
    },
  });
}));

module.exports = router;
