/**
 * THE PARAMETER DICTIONARY — the API behind the Parameter Dictionary admin page.
 *
 * The dictionary is the canonical vocabulary of the platform: parameters, the aliases that map raw
 * datasheet wording onto them ("Power Load" → electrical.power), unit conversions, value
 * normalisations ("3N" → "3-Phase"), the engineering constants a formula may use (PF, efficiency),
 * and the engine's policy settings (confidence threshold, conflict handling).
 *
 * EVERY mutation calls params.invalidate() — otherwise the 30-second dictionary cache would keep
 * serving the old vocabulary and a freshly-added alias would appear not to work.
 */
const express = require("express");
const { supabase } = require("../config/supabase");
const auth = require("../services/auth");
const dictSvc = require("../services/params");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use(auth.authRequired);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[dictionary]", e.stack || e.message);
    res.status(status).json({ error: status >= 500 ? "Something went wrong." : e.message });
  });
const bad = (m, s = 422) => Object.assign(new Error(m), { status: s });

// dictionary read is available to anyone who can see rules — the Rule Panel needs the vocabulary
const canRead = auth.requirePermission("rule.read");
const canManage = auth.requirePermission("dictionary.manage");

const touched = (res, payload) => {
  dictSvc.invalidate(); // the cache is now stale — drop it so the next read is fresh
  return res.json(payload);
};

// ── the whole dictionary, in one call (the admin page loads this) ────────────
router.get(
  "/",
  canRead,
  wrap(async (_req, res) => {
    const dict = await dictSvc.load(true);
    res.json({
      disciplines: dict.disciplines,
      parameters: dict.parameters,
      constants: Object.entries(dict.constants).map(([key, value]) => ({ key, value })),
      settings: dict.settings,
      counts: {
        parameters: dict.parameters.length,
        aliases: dict.aliasExact.size + dict.aliasFuzzy.length,
        conversions: dict.conversions.size,
      },
    });
  })
);

// ── DISCIPLINES (Rule Categories) ────────────────────────────────────────────
router.get("/disciplines", canRead, wrap(async (_req, res) => {
  const { data } = await supabase.from("ceks_disciplines").select("*").order("sort_order");
  res.json(data || []);
}));

router.post("/disciplines", canManage, wrap(async (req, res) => {
  const { code, name, color, symbol, description, sort_order } = req.body || {};
  if (!code || !name) throw bad("A code and a name are required.");
  const { data, error } = await supabase
    .from("ceks_disciplines")
    .insert({ code: String(code).trim(), name, color: color || null, symbol: symbol || null, description: description || null, sort_order: sort_order ?? 100 })
    .select().single();
  if (error) throw bad(error.code === "23505" ? `Discipline "${code}" already exists.` : error.message);
  touched(res, data);
}));

router.patch("/disciplines/:id", canManage, wrap(async (req, res) => {
  const patch = {};
  for (const k of ["name", "color", "symbol", "description", "sort_order", "is_active"]) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const { data, error } = await supabase.from("ceks_disciplines").update(patch).eq("id", req.params.id).select().single();
  if (error) throw new Error(error.message);
  touched(res, data);
}));

// ── PARAMETERS ───────────────────────────────────────────────────────────────
router.get("/parameters", canRead, wrap(async (req, res) => {
  let q = supabase.from("ceks_parameters").select("*, ceks_disciplines(code,name)").order("sort_order");
  if (req.query.discipline) q = q.eq("discipline_id", req.query.discipline);
  const { data } = await q;
  res.json(data || []);
}));

const PARAM_FIELDS = ["key", "label", "discipline_id", "data_type", "canonical_unit", "allowed_values", "role", "description", "sort_order", "is_active"];
const DATA_TYPES = ["number", "text", "enum", "boolean"];
const ROLES = ["input", "output", "both"];

router.post("/parameters", canManage, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.key || !b.label) throw bad("A key and a label are required.");
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(b.key)) {
    throw bad('The key must be a dotted lower-case identifier, e.g. "electrical.power".');
  }
  if (b.data_type && !DATA_TYPES.includes(b.data_type)) throw bad(`data_type must be one of ${DATA_TYPES.join(", ")}.`);
  if (b.role && !ROLES.includes(b.role)) throw bad(`role must be one of ${ROLES.join(", ")}.`);

  const row = {};
  for (const f of PARAM_FIELDS) if (b[f] !== undefined) row[f] = b[f];
  row.data_type = row.data_type || "text";
  row.role = row.role || "input";

  const { data, error } = await supabase.from("ceks_parameters").insert(row).select().single();
  if (error) throw bad(error.code === "23505" ? `Parameter "${b.key}" already exists.` : error.message);
  touched(res, data);
}));

router.patch("/parameters/:id", canManage, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.data_type && !DATA_TYPES.includes(b.data_type)) throw bad(`data_type must be one of ${DATA_TYPES.join(", ")}.`);
  if (b.role && !ROLES.includes(b.role)) throw bad(`role must be one of ${ROLES.join(", ")}.`);
  const patch = {};
  for (const f of PARAM_FIELDS) if (b[f] !== undefined) patch[f] = b[f];
  const { data, error } = await supabase.from("ceks_parameters").update(patch).eq("id", req.params.id).select().single();
  if (error) throw new Error(error.message);
  touched(res, data);
}));

router.delete("/parameters/:id", canManage, wrap(async (req, res) => {
  // a parameter a rule still points at must not vanish under it
  const [{ count: condCount }, { count: outCount }] = await Promise.all([
    supabase.from("ceks_rule_conditions").select("id", { count: "exact", head: true }).eq("parameter_id", req.params.id),
    supabase.from("ceks_rule_outputs").select("id", { count: "exact", head: true }).eq("parameter_id", req.params.id),
  ]);
  if ((condCount || 0) + (outCount || 0) > 0) {
    throw bad(`This parameter is used by ${(condCount || 0) + (outCount || 0)} rule(s). Deactivate it instead of deleting.`, 409);
  }
  const { error } = await supabase.from("ceks_parameters").delete().eq("id", req.params.id);
  if (error) throw new Error(error.message);
  touched(res, { ok: true });
}));

// ── ALIASES — the raw-name → parameter mappings ──────────────────────────────
router.get("/aliases", canRead, wrap(async (req, res) => {
  let q = supabase.from("ceks_parameter_aliases").select("*, ceks_parameters(key,label)").order("alias");
  if (req.query.parameter_id) q = q.eq("parameter_id", req.query.parameter_id);
  const { data } = await q;
  res.json(data || []);
}));

router.post("/aliases", canManage, wrap(async (req, res) => {
  const { parameter_id, alias, match_type } = req.body || {};
  if (!parameter_id || !alias) throw bad("A parameter and an alias are required.");
  const mt = match_type || "exact";
  if (!["exact", "contains", "regex"].includes(mt)) throw bad("match_type must be exact, contains or regex.");
  if (mt === "regex") { try { new RegExp(alias); } catch { throw bad(`"${alias}" is not a valid pattern.`); } }
  const { data, error } = await supabase
    .from("ceks_parameter_aliases")
    .insert({ parameter_id, alias: String(alias).trim(), match_type: mt })
    .select().single();
  if (error) throw bad(error.code === "23505" ? `Alias "${alias}" already exists.` : error.message);
  touched(res, data);
}));

router.delete("/aliases/:id", canManage, wrap(async (req, res) => {
  const { error } = await supabase.from("ceks_parameter_aliases").delete().eq("id", req.params.id);
  if (error) throw new Error(error.message);
  touched(res, { ok: true });
}));

/**
 * "Which parameter would THIS raw name resolve to?" — the panel calls this so an engineer can test a
 * datasheet header before adding an alias, and see the currently-unmapped names.
 */
router.get("/resolve", canRead, wrap(async (req, res) => {
  const dict = await dictSvc.load();
  const name = String(req.query.name || "");
  const p = dictSvc.resolveParameter(dict, name);
  res.json({ name, resolved: p ? { id: p.id, key: p.key, label: p.label } : null });
}));

/** The live attribute names that DON'T yet resolve — the work list for improving coverage. */
router.get("/unmapped", canRead, wrap(async (req, res) => {
  const dict = await dictSvc.load();
  const { data } = await supabase
    .from("ceks_knowledge_attributes")
    .select("name")
    .not("name", "is", null)
    .limit(5000);
  const counts = new Map();
  for (const a of data || []) {
    if (dictSvc.resolveParameter(dict, a.name)) continue;
    const key = a.name.trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const rows = [...counts.entries()].map(([name, n]) => ({ name, occurrences: n })).sort((a, b) => b.occurrences - a.occurrences);
  res.json({ total_unmapped_names: rows.length, names: rows.slice(0, Number(req.query.limit) || 200) });
}));

// ── UNIT CONVERSIONS ─────────────────────────────────────────────────────────
router.get("/units", canRead, wrap(async (_req, res) => {
  const { data } = await supabase.from("ceks_unit_conversions").select("*").order("from_unit");
  res.json(data || []);
}));

router.post("/units", canManage, wrap(async (req, res) => {
  const { from_unit, to_unit, factor, offset } = req.body || {};
  if (!from_unit || !to_unit || factor == null) throw bad("from_unit, to_unit and factor are required.");
  const { data, error } = await supabase
    .from("ceks_unit_conversions")
    .insert({ from_unit: String(from_unit).trim(), to_unit: String(to_unit).trim(), factor: Number(factor), offset: Number(offset) || 0 })
    .select().single();
  if (error) throw bad(error.code === "23505" ? "That conversion already exists." : error.message);
  touched(res, data);
}));

router.delete("/units/:id", canManage, wrap(async (req, res) => {
  const { error } = await supabase.from("ceks_unit_conversions").delete().eq("id", req.params.id);
  if (error) throw new Error(error.message);
  touched(res, { ok: true });
}));

// ── VALUE NORMALISATIONS ("3N" → "3-Phase") ──────────────────────────────────
router.get("/value-normalizations", canRead, wrap(async (req, res) => {
  let q = supabase.from("ceks_value_normalizations").select("*, ceks_parameters(key,label)").order("raw_pattern");
  if (req.query.parameter_id) q = q.eq("parameter_id", req.query.parameter_id);
  const { data } = await q;
  res.json(data || []);
}));

router.post("/value-normalizations", canManage, wrap(async (req, res) => {
  const { parameter_id, raw_pattern, canonical_value, match_type } = req.body || {};
  if (!parameter_id || !raw_pattern || canonical_value == null) throw bad("A parameter, a raw pattern and a canonical value are required.");
  const mt = match_type || "exact";
  if (!["exact", "contains", "regex"].includes(mt)) throw bad("match_type must be exact, contains or regex.");
  if (mt === "regex") { try { new RegExp(raw_pattern); } catch { throw bad(`"${raw_pattern}" is not a valid pattern.`); } }
  const { data, error } = await supabase
    .from("ceks_value_normalizations")
    .insert({ parameter_id, raw_pattern: String(raw_pattern).trim(), canonical_value: String(canonical_value).trim(), match_type: mt })
    .select().single();
  if (error) throw new Error(error.message);
  touched(res, data);
}));

router.delete("/value-normalizations/:id", canManage, wrap(async (req, res) => {
  const { error } = await supabase.from("ceks_value_normalizations").delete().eq("id", req.params.id);
  if (error) throw new Error(error.message);
  touched(res, { ok: true });
}));

// ── CONSTANTS (PF, efficiency, √3 …) — editable engineering data ─────────────
router.get("/constants", canRead, wrap(async (_req, res) => {
  const { data } = await supabase.from("ceks_rule_constants").select("*, ceks_disciplines(code,name)").order("key");
  res.json(data || []);
}));

router.post("/constants", canManage, wrap(async (req, res) => {
  const { key, value, unit, description, discipline_id } = req.body || {};
  if (!key || value == null) throw bad("A key and a value are required.");
  if (!Number.isFinite(Number(value))) throw bad("The value must be a number.");
  const { data, error } = await supabase
    .from("ceks_rule_constants")
    .insert({ key: String(key).trim(), value: Number(value), unit: unit || null, description: description || null, discipline_id: discipline_id || null, updated_by: req.user.id })
    .select().single();
  if (error) throw bad(error.code === "23505" ? `Constant "${key}" already exists.` : error.message);
  touched(res, data);
}));

router.patch("/constants/:id", canManage, wrap(async (req, res) => {
  const patch = { updated_by: req.user.id, updated_at: new Date().toISOString() };
  if (req.body.value != null) {
    if (!Number.isFinite(Number(req.body.value))) throw bad("The value must be a number.");
    patch.value = Number(req.body.value);
  }
  for (const k of ["unit", "description", "discipline_id"]) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const { data, error } = await supabase.from("ceks_rule_constants").update(patch).eq("id", req.params.id).select().single();
  if (error) throw new Error(error.message);
  // changing PF or efficiency changes future derivations — say so, the caller may want to recalc
  touched(res, { ...data, note: "Constant updated. New recommendations will use it; existing ones are unchanged until recalculated." });
}));

router.delete("/constants/:id", canManage, wrap(async (req, res) => {
  const { error } = await supabase.from("ceks_rule_constants").delete().eq("id", req.params.id);
  if (error) throw new Error(error.message);
  touched(res, { ok: true });
}));

// ── ENGINE SETTINGS — the policy the client set (0.80 threshold, never extrapolate …) ────────
router.get("/settings", canRead, wrap(async (_req, res) => {
  const { data } = await supabase.from("ceks_engine_settings").select("*").order("key");
  res.json(data || []);
}));

router.put("/settings/:key", auth.requirePermission("settings.manage"), wrap(async (req, res) => {
  if (req.body?.value === undefined) throw bad("A value is required.");
  const { data: existing } = await supabase.from("ceks_engine_settings").select("key").eq("key", req.params.key).maybeSingle();
  if (!existing) throw bad(`Unknown setting "${req.params.key}".`, 404);
  const { data, error } = await supabase
    .from("ceks_engine_settings")
    .update({ value: String(req.body.value), updated_by: req.user.id, updated_at: new Date().toISOString() })
    .eq("key", req.params.key).select().single();
  if (error) throw new Error(error.message);
  touched(res, data);
}));

module.exports = router;
