/**
 * ENGINEERING RULES — the API behind the Rule Management Panel.
 *
 * Everything the client listed is here: Excel rule import, manual creation, editing, duplication,
 * activation/deactivation, version history, an approval workflow, and duplicate/overlapping-rule
 * detection. A rule is data; this router never contains an engineering value.
 */
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const { supabase } = require("../config/supabase");
const { env } = require("../config/env");
const auth = require("../services/auth");
const dictSvc = require("../services/params");
const expr = require("../services/expression");
const recs = require("../services/recommendations");
const ruleImport = require("../services/ruleImport");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploadMaxFileMb * 1024 * 1024, files: 1 },
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[rules]", e.stack || e.message);
    res.status(status).json({ error: status >= 500 ? "Something went wrong." : e.message });
  });

const bad = (msg, status = 422) => Object.assign(new Error(msg), { status });
const audit = async (user, entity, id, action, changes) =>
  supabase.from("ceks_audit_log").insert({
    user_id: user?.id || null,
    actor_name: user?.full_name || user?.email || null,
    entity_type: entity,
    entity_id: id,
    action,
    changes: changes || null,
  });

router.use(express.json({ limit: "4mb" }));
router.use(auth.authRequired);

// ── the vocabulary a rule author picks from ──────────────────────────────────
router.get(
  "/meta",
  auth.requirePermission("rule.read"),
  wrap(async (_req, res) => {
    const dict = await dictSvc.load(true);
    res.json({
      disciplines: dict.disciplines,
      parameters: dict.parameters.map((p) => ({
        id: p.id,
        key: p.key,
        label: p.label,
        discipline_id: p.discipline_id,
        data_type: p.data_type,
        canonical_unit: p.canonical_unit,
        allowed_values: p.allowed_values,
        role: p.role,
      })),
      constants: dict.constants,
      operators: [
        { code: "eq", label: "equals", types: ["number", "text", "enum", "boolean"] },
        { code: "neq", label: "does not equal", types: ["number", "text", "enum", "boolean"] },
        { code: "gt", label: "greater than", types: ["number"] },
        { code: "gte", label: "greater than or equal", types: ["number"] },
        { code: "lt", label: "less than", types: ["number"] },
        { code: "lte", label: "less than or equal", types: ["number"] },
        { code: "between", label: "between (inclusive)", types: ["number"] },
        { code: "in", label: "is one of", types: ["text", "enum"] },
        { code: "not_in", label: "is not one of", types: ["text", "enum"] },
        { code: "contains", label: "contains", types: ["text"] },
        { code: "matches", label: "matches pattern", types: ["text"] },
        { code: "exists", label: "is present", types: ["number", "text", "enum", "boolean"] },
        { code: "not_exists", label: "is not present", types: ["number", "text", "enum", "boolean"] },
      ],
      functions: expr.FUNCTIONS,
      settings: dict.settings,
    });
  })
);

// ── list / read ──────────────────────────────────────────────────────────────
router.get(
  "/",
  auth.requirePermission("rule.read"),
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || env.pageSizeDefault, env.pageSizeMax);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    let q = supabase
      .from("ceks_rules")
      .select("*, ceks_disciplines(code,name), ceks_rule_conditions(count), ceks_rule_outputs(count)", { count: "exact" })
      .order("priority", { ascending: false })
      .order("code")
      .range(offset, offset + limit - 1);

    if (req.query.discipline) q = q.eq("discipline_id", req.query.discipline);
    if (req.query.status) q = q.eq("status", req.query.status);
    if (req.query.type) q = q.eq("rule_type", req.query.type);
    if (req.query.active === "1") q = q.eq("is_active", true);
    if (req.query.q) q = q.or(`code.ilike.%${String(req.query.q).replace(/[%,()]/g, "")}%,name.ilike.%${String(req.query.q).replace(/[%,()]/g, "")}%`);

    const { data, count, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ rules: data || [], total: count || 0, limit, offset });
  })
);

router.get(
  "/:id",
  auth.requirePermission("rule.read"),
  wrap(async (req, res) => {
    const { data, error } = await supabase
      .from("ceks_rules")
      .select("*, ceks_disciplines(*), ceks_rule_conditions(*), ceks_rule_outputs(*)")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error || !data) return res.status(404).json({ error: "Rule not found" });

    const { data: versions } = await supabase
      .from("ceks_rule_versions")
      .select("version, change_note, approved_at, approved_by")
      .eq("rule_id", req.params.id)
      .order("version", { ascending: false });

    res.json({ ...data, versions: versions || [] });
  })
);

// ── validate a rule before it is saved (the panel calls this as the author types) ────────────
async function validateRule(dict, body) {
  const errors = [];
  if (!body.code || !String(body.code).trim()) errors.push("A Rule ID is required.");
  if (!body.discipline_id) errors.push("A Rule Category (discipline) is required.");
  const conditions = Array.isArray(body.conditions) ? body.conditions : [];
  const outputs = Array.isArray(body.outputs) ? body.outputs : [];

  // A rule with no conditions would match EVERY piece of equipment. That is never what an engineer
  // means, and it would silently rewrite the whole catalogue.
  if (!conditions.length) errors.push("A rule must have at least one condition — otherwise it would apply to every piece of equipment.");
  if (!outputs.length) errors.push("A rule must produce at least one output.");

  for (const c of conditions) {
    const p = dict.paramById.get(c.parameter_id);
    if (!p) { errors.push("A condition refers to a parameter that does not exist."); continue; }
    if (c.operator === "between") {
      if (c.value_min == null || c.value_max == null) errors.push(`${p.label}: "between" needs both a from and a to value.`);
      else if (Number(c.value_min) > Number(c.value_max)) errors.push(`${p.label}: the from value is greater than the to value.`);
    } else if (["in", "not_in"].includes(c.operator)) {
      if (!Array.isArray(c.value_list) || !c.value_list.length) errors.push(`${p.label}: give at least one value for "${c.operator}".`);
    } else if (!["exists", "not_exists"].includes(c.operator)) {
      if (c.value_text == null && c.value_num == null) errors.push(`${p.label}: a value is required.`);
    }
    if (c.operator === "matches" && c.value_text) {
      try { new RegExp(c.value_text); } catch { errors.push(`${p.label}: "${c.value_text}" is not a valid pattern.`); }
    }
  }

  for (const o of outputs) {
    const p = dict.paramById.get(o.parameter_id);
    if (!p) { errors.push("An output refers to a parameter that does not exist."); continue; }
    if (!o.expression && o.value_text == null && o.value_num == null) {
      errors.push(`${p.label}: give a value or a formula.`);
    }
    if (o.expression) {
      const v = expr.validate(o.expression);
      if (!v.ok) errors.push(`${p.label}: the formula is invalid — ${v.error}`);
      else {
        // every identifier must be a real parameter or a declared constant, or the rule will fail
        // silently at run time on someone's equipment
        const deps = expr.dependencies(o.expression);
        for (const d of deps) {
          const known = dict.paramByKey.has(d) || Object.prototype.hasOwnProperty.call(dict.constants, d);
          if (!known) errors.push(`${p.label}: the formula uses "${d}", which is neither a parameter nor a declared constant.`);
        }
      }
    }
  }
  return errors;
}

/**
 * DUPLICATE / OVERLAP DETECTION — the client asked for it explicitly.
 * Two rules overlap when they belong to the same discipline, produce the SAME output parameter, and
 * their condition sets can both be true for the same equipment. We do not need to enumerate all of
 * reality: two rules overlap unless SOME condition proves them mutually exclusive.
 */
async function findOverlaps(dict, ruleId, body) {
  const outputs = (body.outputs || []).map((o) => o.parameter_id);
  if (!outputs.length) return [];

  const { data: peers } = await supabase
    .from("ceks_rules")
    .select("id, code, name, priority, status, is_active, ceks_rule_conditions(*), ceks_rule_outputs(*)")
    .eq("discipline_id", body.discipline_id)
    .neq("status", "archived");

  const mine = body.conditions || [];
  const out = [];

  for (const peer of peers || []) {
    if (peer.id === ruleId) continue;
    const sharedOutputs = (peer.ceks_rule_outputs || []).filter((o) => outputs.includes(o.parameter_id));
    if (!sharedOutputs.length) continue;

    if (mutuallyExclusive(dict, mine, peer.ceks_rule_conditions || [])) continue;

    out.push({
      rule_id: peer.id,
      code: peer.code,
      name: peer.name,
      priority: peer.priority,
      status: peer.status,
      is_active: peer.is_active,
      same_priority: peer.priority === Number(body.priority ?? 100),
      shared_outputs: sharedOutputs
        .map((o) => dict.paramById.get(o.parameter_id)?.label)
        .filter(Boolean),
    });
  }
  return out;
}

/** Can we PROVE these two condition sets can never both hold? If yes, there is no overlap. */
function mutuallyExclusive(dict, a, b) {
  for (const ca of a) {
    for (const cb of b) {
      if (ca.parameter_id !== cb.parameter_id) continue;
      const p = dict.paramById.get(ca.parameter_id);
      if (!p) continue;

      if (p.data_type === "number") {
        const ra = rangeOf(ca);
        const rb = rangeOf(cb);
        if (ra && rb && (ra.max < rb.min || rb.max < ra.min)) return true; // disjoint ranges
      } else if (ca.operator === "eq" && cb.operator === "eq") {
        if (String(ca.value_text ?? "").toLowerCase() !== String(cb.value_text ?? "").toLowerCase()) return true;
      } else if (ca.operator === "in" && cb.operator === "in") {
        const la = (ca.value_list || []).map((x) => String(x).toLowerCase());
        const lb = (cb.value_list || []).map((x) => String(x).toLowerCase());
        if (!la.some((x) => lb.includes(x))) return true;
      }
    }
  }
  return false;
}

function rangeOf(c) {
  const n = (v) => (v == null ? null : Number(v));
  switch (c.operator) {
    case "between": return { min: n(c.value_min), max: n(c.value_max) };
    case "eq": return { min: n(c.value_num), max: n(c.value_num) };
    case "gt": return { min: n(c.value_num) + 1e-9, max: Infinity };
    case "gte": return { min: n(c.value_num), max: Infinity };
    case "lt": return { min: -Infinity, max: n(c.value_num) - 1e-9 };
    case "lte": return { min: -Infinity, max: n(c.value_num) };
    default: return null;
  }
}

router.post(
  "/validate",
  auth.requirePermission("rule.read"),
  wrap(async (req, res) => {
    const dict = await dictSvc.load();
    const errors = await validateRule(dict, req.body || {});
    const overlaps = errors.length ? [] : await findOverlaps(dict, req.body?.id || null, req.body || {});
    res.json({ ok: !errors.length, errors, overlaps });
  })
);

// ── create ───────────────────────────────────────────────────────────────────
async function writeRule(ruleId, body) {
  await supabase.from("ceks_rule_conditions").delete().eq("rule_id", ruleId);
  await supabase.from("ceks_rule_outputs").delete().eq("rule_id", ruleId);

  const conds = (body.conditions || []).map((c, i) => ({
    rule_id: ruleId,
    parameter_id: c.parameter_id,
    operator: c.operator,
    value_text: c.value_text ?? null,
    value_num: c.value_num ?? null,
    value_min: c.value_min ?? null,
    value_max: c.value_max ?? null,
    value_list: c.value_list ?? null,
    unit: c.unit || null,
    sort_order: i,
  }));
  if (conds.length) {
    const { error } = await supabase.from("ceks_rule_conditions").insert(conds);
    if (error) throw new Error(error.message);
  }

  const outs = (body.outputs || []).map((o, i) => ({
    rule_id: ruleId,
    parameter_id: o.parameter_id,
    value_text: o.value_text ?? null,
    value_num: o.value_num ?? null,
    unit: o.unit || null,
    expression: o.expression || null,
    note: o.note || null,
    sort_order: i,
  }));
  if (outs.length) {
    const { error } = await supabase.from("ceks_rule_outputs").insert(outs);
    if (error) throw new Error(error.message);
  }
}

router.post(
  "/",
  auth.requirePermission("rule.create"),
  wrap(async (req, res) => {
    const dict = await dictSvc.load(true);
    const body = req.body || {};
    const errors = await validateRule(dict, body);
    if (errors.length) throw bad(errors.join(" "));

    const { data: rule, error } = await supabase
      .from("ceks_rules")
      .insert({
        code: String(body.code).trim(),
        name: body.name || null,
        description: body.description || null,
        discipline_id: body.discipline_id,
        rule_type: body.rule_type === "derivation" ? "derivation" : "recommendation",
        priority: Number(body.priority) || 100,
        version: 1,
        status: "draft",                      // a new rule is NEVER live
        is_active: false,
        effective_from: body.effective_from || null,
        effective_to: body.effective_to || null,
        engineer_approval_required: !!body.engineer_approval_required,
        standard_id: body.standard_id || null,
        clause: body.clause || null,
        notes: body.notes || null,
        reference_url: body.reference_url || null,
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw bad(error.code === "23505" ? `Rule ID "${body.code}" already exists.` : error.message);

    await writeRule(rule.id, body);
    await audit(req.user, "rule", rule.id, "created", { code: rule.code });
    dictSvc.invalidate();

    const overlaps = await findOverlaps(dict, rule.id, body);
    res.status(201).json({ ...rule, overlaps });
  })
);

// ── edit (only while it is not live) ─────────────────────────────────────────
router.patch(
  "/:id",
  auth.requirePermission("rule.create"),
  wrap(async (req, res) => {
    const { data: rule } = await supabase.from("ceks_rules").select("*").eq("id", req.params.id).maybeSingle();
    if (!rule) return res.status(404).json({ error: "Rule not found" });

    // An APPROVED rule is a controlled document. Editing it in place would silently change every
    // recommendation it ever produced. Instead: bump the version, drop back to draft, and let the
    // approval flow raise "Recalculation Available" on the affected equipment.
    const wasApproved = rule.status === "approved";
    const dict = await dictSvc.load(true);
    const body = { ...rule, ...req.body };
    const errors = await validateRule(dict, body);
    if (errors.length) throw bad(errors.join(" "));

    const patch = {
      name: body.name ?? rule.name,
      description: body.description ?? rule.description,
      priority: Number(body.priority ?? rule.priority),
      effective_from: body.effective_from ?? rule.effective_from,
      effective_to: body.effective_to ?? rule.effective_to,
      engineer_approval_required: body.engineer_approval_required ?? rule.engineer_approval_required,
      standard_id: body.standard_id ?? rule.standard_id,
      clause: body.clause ?? rule.clause,
      notes: body.notes ?? rule.notes,
      reference_url: body.reference_url ?? rule.reference_url,
      updated_at: new Date().toISOString(),
    };
    if (wasApproved) {
      patch.version = rule.version + 1;
      patch.status = "draft";
      patch.is_active = false;
      patch.approved_by = null;
      patch.approved_at = null;
    }

    const { data: updated, error } = await supabase.from("ceks_rules").update(patch).eq("id", rule.id).select().single();
    if (error) throw new Error(error.message);

    if (Array.isArray(req.body?.conditions) || Array.isArray(req.body?.outputs)) {
      await writeRule(rule.id, { conditions: body.conditions, outputs: body.outputs });
    }
    await audit(req.user, "rule", rule.id, wasApproved ? "revised" : "edited", { version: patch.version || rule.version });
    dictSvc.invalidate();

    res.json({
      ...updated,
      revised: wasApproved,
      message: wasApproved
        ? `This rule was live. It is now draft v${patch.version} — approve it to publish the change. Equipment approved under v${rule.version} will be flagged for recalculation.`
        : undefined,
    });
  })
);

// ── duplicate ────────────────────────────────────────────────────────────────
router.post(
  "/:id/duplicate",
  auth.requirePermission("rule.create"),
  wrap(async (req, res) => {
    const { data: src } = await supabase
      .from("ceks_rules")
      .select("*, ceks_rule_conditions(*), ceks_rule_outputs(*)")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!src) return res.status(404).json({ error: "Rule not found" });

    const code = String(req.body?.code || `${src.code}-COPY`).trim();
    const { data: rule, error } = await supabase
      .from("ceks_rules")
      .insert({
        code,
        name: req.body?.name || `${src.name || src.code} (copy)`,
        description: src.description,
        discipline_id: src.discipline_id,
        rule_type: src.rule_type,
        priority: src.priority,
        version: 1,
        status: "draft",
        is_active: false,
        engineer_approval_required: src.engineer_approval_required,
        standard_id: src.standard_id,
        clause: src.clause,
        notes: src.notes,
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw bad(error.code === "23505" ? `Rule ID "${code}" already exists.` : error.message);

    await writeRule(rule.id, {
      conditions: src.ceks_rule_conditions || [],
      outputs: src.ceks_rule_outputs || [],
    });
    await audit(req.user, "rule", rule.id, "duplicated", { from: src.code });
    res.status(201).json(rule);
  })
);

// ── approve → activate. THIS is the moment a rule starts changing engineering answers. ────────
router.post(
  "/:id/approve",
  auth.requirePermission("rule.approve"),
  wrap(async (req, res) => {
    const { data: rule } = await supabase
      .from("ceks_rules")
      .select("*, ceks_rule_conditions(*), ceks_rule_outputs(*)")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    if (rule.status === "approved") throw bad("This rule is already approved.");

    const dict = await dictSvc.load(true);
    const errors = await validateRule(dict, {
      ...rule,
      conditions: rule.ceks_rule_conditions,
      outputs: rule.ceks_rule_outputs,
    });
    if (errors.length) throw bad(`This rule cannot be approved: ${errors.join(" ")}`);

    // freeze a snapshot — every recommendation is traceable to exactly this text, forever
    await supabase.from("ceks_rule_versions").insert({
      rule_id: rule.id,
      version: rule.version,
      snapshot: {
        code: rule.code,
        name: rule.name,
        description: rule.description,
        priority: rule.priority,
        rule_type: rule.rule_type,
        engineer_approval_required: rule.engineer_approval_required,
        clause: rule.clause,
        conditions: rule.ceks_rule_conditions,
        outputs: rule.ceks_rule_outputs,
      },
      change_note: req.body?.note || null,
      approved_by: req.user.id,
    });

    const { data: approved } = await supabase
      .from("ceks_rules")
      .update({
        status: "approved",
        is_active: req.body?.activate !== false,
        approved_by: req.user.id,
        approved_at: new Date().toISOString(),
      })
      .eq("id", rule.id)
      .select()
      .single();

    // every item that used an earlier version of this rule is flagged — nothing is auto-rewritten
    const alerts = await recs.raiseRecalcAlerts(rule.id, rule.version);
    await audit(req.user, "rule", rule.id, "approved", { version: rule.version, affected: alerts.affected_items });
    dictSvc.invalidate();

    res.json({ ...approved, recalculation_alerts: alerts.affected_items });
  })
);

router.post(
  "/:id/activate",
  auth.requirePermission("rule.approve"),
  wrap(async (req, res) => {
    const active = req.body?.active !== false;
    const { data: rule } = await supabase.from("ceks_rules").select("status").eq("id", req.params.id).maybeSingle();
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    if (active && rule.status !== "approved") throw bad("Only an approved rule can be activated.");

    const { data } = await supabase.from("ceks_rules").update({ is_active: active }).eq("id", req.params.id).select().single();
    await audit(req.user, "rule", req.params.id, active ? "activated" : "deactivated", null);
    dictSvc.invalidate();
    res.json(data);
  })
);

router.post(
  "/:id/archive",
  auth.requirePermission("rule.archive"),
  wrap(async (req, res) => {
    const { data } = await supabase
      .from("ceks_rules")
      .update({ status: "archived", is_active: false })
      .eq("id", req.params.id)
      .select()
      .single();
    await audit(req.user, "rule", req.params.id, "archived", { reason: req.body?.reason || null });
    dictSvc.invalidate();
    res.json(data);
  })
);

// ── EXCEL RULE IMPORT — the client will deliver the standards as spreadsheets ────────────────
router.get(
  "/import/template",
  auth.requirePermission("rule.read"),
  wrap(async (req, res) => {
    const buf = await ruleImport.buildTemplate(req.query.discipline || null);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="CULINOVA_Rule_Import_Template.xlsx"');
    res.send(buf);
  })
);

/** Step 1 — upload the sheet and see EXACTLY what would be created. Nothing is written. */
router.post(
  "/import/preview",
  auth.requirePermission("rule.create"),
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw bad("Attach an .xlsx file.");
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const preview = await ruleImport.preview(wb, {
      discipline_id: req.body.discipline_id || null,
      sheet: req.body.sheet || null,
    });
    res.json(preview);
  })
);

/** Step 2 — commit it. Rules land as DRAFT; a human still has to approve them. */
router.post(
  "/import/commit",
  auth.requirePermission("rule.create"),
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw bad("Attach an .xlsx file.");
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const out = await ruleImport.commit(wb, {
      discipline_id: req.body.discipline_id || null,
      sheet: req.body.sheet || null,
      mapping: req.body.mapping ? JSON.parse(req.body.mapping) : null,
      user: req.user,
    });
    await audit(req.user, "rule", null, "imported", { created: out.created, failed: out.failed });
    dictSvc.invalidate();
    res.json(out);
  })
);

module.exports = router;
