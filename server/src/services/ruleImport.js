/**
 * EXCEL RULE IMPORT.
 *
 * The client will deliver the CULINOVA Engineering Standards as spreadsheets — one table per
 * discipline, with condition columns on the left and output columns on the right:
 *
 *   RULE ID | DESCRIPTION | PHASE | VOLTAGE | FREQUENCY | CURRENT FROM (A) | CURRENT TO (A) | CABLE SIZE | BREAKER
 *
 * This service turns such a sheet into rules WITHOUT anyone writing code, and without guessing:
 *   • each header is resolved to a canonical PARAMETER through the dictionary's aliases
 *   • a "X FROM" / "X TO" pair becomes ONE `between` condition on X   ← the electrical tables are range tables
 *   • a parameter whose role is `input` becomes a CONDITION; `output` becomes an OUTPUT
 *   • a header we cannot resolve is reported, NOT silently dropped — the importer refuses to guess
 *   • the user can override every column's mapping before committing
 *
 * Imported rules land as DRAFT. A human still approves them. Nothing goes live by uploading a file.
 */
const XLSX = require("xlsx");
const { supabase } = require("../config/supabase");
const dictSvc = require("./params");

const clean = (s) => String(s ?? "").trim();
const norm = (s) => clean(s).toLowerCase().replace(/\s+/g, " ");

// A header like "CURRENT FROM (A)" → { base: "current", bound: "from", unit: "A" }
const BOUND_RE = /^(.*?)\s*(from|to|min|max|minimum|maximum)\s*(?:\(([^)]*)\))?\s*$/i;
const UNIT_RE = /\(([^)]+)\)\s*$/;

function splitHeader(header) {
  const raw = clean(header);
  const unitM = UNIT_RE.exec(raw);
  const unit = unitM ? clean(unitM[1]) : null;
  const withoutUnit = unitM ? clean(raw.slice(0, unitM.index)) : raw;

  const m = BOUND_RE.exec(withoutUnit);
  if (m) {
    const bound = m[2].toLowerCase();
    return {
      raw,
      base: clean(m[1]),
      bound: ["from", "min", "minimum"].includes(bound) ? "min" : "max",
      unit,
    };
  }
  return { raw, base: withoutUnit, bound: null, unit };
}

/** Meta columns — they describe the RULE, not the equipment. */
const META = {
  code: ["rule id", "rule no", "rule", "rule code", "id", "code"],
  description: ["description", "discription", "rule description", "notes", "remark", "remarks"],
  priority: ["priority"],
  clause: ["clause", "reference", "standard clause"],
  engineer_approval_required: ["engineer approval", "engineer approval required", "approval required"],
};
function metaKeyFor(header) {
  const h = norm(header);
  for (const [key, names] of Object.entries(META)) if (names.includes(h)) return key;
  return null;
}

/**
 * Work out what every column MEANS. Returns a mapping the user can review and override.
 */
async function planColumns(headers, dict) {
  const plan = [];
  const pending = new Map(); // base name → the FROM/TO halves seen so far

  for (let i = 0; i < headers.length; i++) {
    const header = clean(headers[i]);
    if (!header) continue;

    const meta = metaKeyFor(header);
    if (meta) {
      plan.push({ index: i, header, kind: "meta", meta_key: meta });
      continue;
    }

    const { base, bound, unit } = splitHeader(header);
    const param = dictSvc.resolveParameter(dict, base) || dictSvc.resolveParameter(dict, header);

    if (!param) {
      // We do NOT guess. An unmapped column is surfaced so an engineer either adds an alias to the
      // dictionary or tells us to ignore the column.
      plan.push({
        index: i,
        header,
        kind: "unmapped",
        suggestion: "Add an alias in the Parameter Dictionary, or mark this column as ignored.",
      });
      continue;
    }

    if (bound) {
      const key = param.id;
      if (!pending.has(key)) pending.set(key, { param, unit, min: null, max: null, headers: [] });
      const slot = pending.get(key);
      slot[bound] = i;
      slot.headers.push(header);
      slot.unit = slot.unit || unit;
      continue;
    }

    plan.push({
      index: i,
      header,
      kind: param.role === "output" ? "output" : "condition",
      parameter_id: param.id,
      parameter_key: param.key,
      parameter_label: param.label,
      data_type: param.data_type,
      unit: unit || param.canonical_unit,
      operator: param.data_type === "number" ? "eq" : "eq",
    });
  }

  // FROM/TO pairs become ONE `between` condition
  for (const [, slot] of pending) {
    if (slot.min != null && slot.max != null) {
      plan.push({
        index: slot.min,
        header: slot.headers.join(" … "),
        kind: "condition",
        operator: "between",
        parameter_id: slot.param.id,
        parameter_key: slot.param.key,
        parameter_label: slot.param.label,
        data_type: slot.param.data_type,
        unit: slot.unit || slot.param.canonical_unit,
        min_index: slot.min,
        max_index: slot.max,
      });
    } else {
      // half a range is not a range — say so rather than inventing the other end
      const only = slot.min != null ? slot.min : slot.max;
      plan.push({
        index: only,
        header: slot.headers.join(""),
        kind: "unmapped",
        suggestion: `Only one half of a range was found for ${slot.param.label}. A "between" condition needs both a FROM and a TO column.`,
      });
    }
  }

  plan.sort((a, b) => a.index - b.index);
  return plan;
}

const numOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** Turn ONE spreadsheet row into a rule definition, using the column plan. */
function rowToRule(row, plan, dict, disciplineId, index) {
  const rule = {
    code: null,
    description: null,
    priority: 100,
    clause: null,
    engineer_approval_required: false,
    discipline_id: disciplineId,
    conditions: [],
    outputs: [],
    _issues: [],
  };

  for (const col of plan) {
    if (col.kind === "meta") {
      const v = clean(row[col.index]);
      if (!v) continue;
      if (col.meta_key === "priority") rule.priority = numOrNull(v) ?? 100;
      else if (col.meta_key === "engineer_approval_required") rule.engineer_approval_required = /^(y|yes|true|1|required)$/i.test(v);
      else rule[col.meta_key] = v;
      continue;
    }
    if (col.kind === "ignore" || col.kind === "unmapped") continue;

    if (col.kind === "condition") {
      if (col.operator === "between") {
        const min = numOrNull(row[col.min_index]);
        const max = numOrNull(row[col.max_index]);
        if (min == null && max == null) continue;   // a blank range cell simply means "any"
        if (min == null || max == null) {
          rule._issues.push(`${col.parameter_label}: only one end of the range is filled in.`);
          continue;
        }
        rule.conditions.push({
          parameter_id: col.parameter_id,
          operator: "between",
          value_min: min,
          value_max: max,
          unit: col.unit || null,
        });
        continue;
      }

      const raw = clean(row[col.index]);
      if (!raw) continue;   // blank = the rule does not care about this parameter

      const param = dict.paramById.get(col.parameter_id);
      if (param?.data_type === "number") {
        const n = numOrNull(raw);
        if (n == null) {
          rule._issues.push(`${col.parameter_label}: "${raw}" is not a number.`);
          continue;
        }
        rule.conditions.push({ parameter_id: col.parameter_id, operator: "eq", value_num: n, unit: col.unit || null });
      } else if (param?.data_type === "enum") {
        // map the sheet's spelling onto the canonical value ("3N" → "3-Phase") using the dictionary
        const canon = dictSvc.normalizeEnum(dict, param, raw);
        if (!canon) {
          rule._issues.push(`${col.parameter_label}: "${raw}" is not a recognised value. Add a value mapping in the Parameter Dictionary.`);
          continue;
        }
        rule.conditions.push({ parameter_id: col.parameter_id, operator: "eq", value_text: canon });
      } else {
        // several values in one cell ("G20, G25") → an "is one of" condition
        const parts = raw.split(/\s*[,;/]\s*/).filter(Boolean);
        if (parts.length > 1) {
          rule.conditions.push({ parameter_id: col.parameter_id, operator: "in", value_list: parts });
        } else {
          rule.conditions.push({ parameter_id: col.parameter_id, operator: "eq", value_text: raw });
        }
      }
      continue;
    }

    if (col.kind === "output") {
      const raw = clean(row[col.index]);
      if (!raw) continue;
      const param = dict.paramById.get(col.parameter_id);
      const n = param?.data_type === "number" ? numOrNull(raw) : null;
      rule.outputs.push({
        parameter_id: col.parameter_id,
        value_text: n == null ? raw : null,
        value_num: n,
        unit: col.unit || null,
      });
    }
  }

  if (!rule.code) rule.code = `R-${String(index + 1).padStart(4, "0")}`;
  if (!rule.conditions.length) rule._issues.push("No conditions — this rule would apply to every piece of equipment, so it will not be imported.");
  if (!rule.outputs.length) rule._issues.push("No outputs — there is nothing for this rule to recommend.");
  return rule;
}

function readSheet(wb, sheetName) {
  const name = sheetName || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) throw Object.assign(new Error(`Sheet "${name}" not found. Sheets: ${wb.SheetNames.join(", ")}`), { status: 422 });
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  if (!rows.length) throw Object.assign(new Error("The sheet is empty."), { status: 422 });
  return { name, headers: rows[0].map((h) => clean(h)), rows: rows.slice(1), sheets: wb.SheetNames };
}

/** Show the user EXACTLY what will happen. Writes nothing. */
async function preview(wb, { discipline_id = null, sheet = null } = {}) {
  const dict = await dictSvc.load(true);
  const { name, headers, rows, sheets } = readSheet(wb, sheet);
  const plan = await planColumns(headers, dict);

  const parsed = rows.map((r, i) => rowToRule(r, plan, dict, discipline_id, i));
  const ready = parsed.filter((r) => !r._issues.length);
  const problems = parsed.filter((r) => r._issues.length);

  // are any of these rule codes already in use?
  const codes = ready.map((r) => r.code).filter(Boolean);
  let clashes = [];
  if (codes.length) {
    const { data } = await supabase.from("ceks_rules").select("code").in("code", codes);
    clashes = (data || []).map((d) => d.code);
  }

  return {
    sheet: name,
    sheets,
    columns: plan,
    unmapped: plan.filter((c) => c.kind === "unmapped"),
    total_rows: rows.length,
    ready: ready.length,
    with_problems: problems.length,
    existing_codes: clashes,
    sample: ready.slice(0, 5).map((r) => ({
      code: r.code,
      description: r.description,
      conditions: r.conditions.map((c) => describeCondition(dict, c)),
      outputs: r.outputs.map((o) => describeOutput(dict, o)),
    })),
    problems: problems.slice(0, 20).map((r) => ({ code: r.code, issues: r._issues })),
  };
}

const describeCondition = (dict, c) => {
  const p = dict.paramById.get(c.parameter_id);
  if (c.operator === "between") return `${p?.label} between ${c.value_min} and ${c.value_max}${c.unit ? " " + c.unit : ""}`;
  if (c.operator === "in") return `${p?.label} is one of ${(c.value_list || []).join(", ")}`;
  return `${p?.label} = ${c.value_text ?? c.value_num}${c.unit ? " " + c.unit : ""}`;
};
const describeOutput = (dict, o) => {
  const p = dict.paramById.get(o.parameter_id);
  return `${p?.label} → ${o.value_text ?? o.value_num}${o.unit ? " " + o.unit : ""}`;
};

/** Commit. Rules are created as DRAFT — a human still approves them. */
async function commit(wb, { discipline_id = null, sheet = null, mapping = null, user = null } = {}) {
  if (!discipline_id) throw Object.assign(new Error("Choose the discipline these rules belong to."), { status: 422 });

  const dict = await dictSvc.load(true);
  const { headers, rows } = readSheet(wb, sheet);
  let plan = await planColumns(headers, dict);

  // the user may override any column's meaning in the preview screen
  if (Array.isArray(mapping) && mapping.length) {
    const byIndex = new Map(mapping.map((m) => [m.index, m]));
    plan = plan.map((c) => (byIndex.has(c.index) ? { ...c, ...byIndex.get(c.index) } : c));
  }

  const out = { created: 0, skipped: 0, failed: 0, errors: [], rules: [] };

  for (let i = 0; i < rows.length; i++) {
    const def = rowToRule(rows[i], plan, dict, discipline_id, i);
    if (def._issues.length) {
      out.skipped++;
      out.errors.push({ row: i + 2, code: def.code, issues: def._issues });
      continue;
    }

    const { data: rule, error } = await supabase
      .from("ceks_rules")
      .insert({
        code: def.code,
        name: def.description ? def.description.slice(0, 120) : def.code,
        description: def.description,
        discipline_id,
        rule_type: "recommendation",
        priority: def.priority,
        version: 1,
        status: "draft",          // NEVER live on import
        is_active: false,
        engineer_approval_required: def.engineer_approval_required,
        clause: def.clause,
        notes: `Imported from a rule spreadsheet (row ${i + 2}).`,
        created_by: user?.id || null,
      })
      .select()
      .single();

    if (error) {
      out.failed++;
      out.errors.push({ row: i + 2, code: def.code, issues: [error.code === "23505" ? `Rule ID "${def.code}" already exists.` : error.message] });
      continue;
    }

    const conds = def.conditions.map((c, k) => ({ ...c, rule_id: rule.id, sort_order: k }));
    const outs = def.outputs.map((o, k) => ({ ...o, rule_id: rule.id, sort_order: k }));
    if (conds.length) await supabase.from("ceks_rule_conditions").insert(conds);
    if (outs.length) await supabase.from("ceks_rule_outputs").insert(outs);

    out.created++;
    out.rules.push({ id: rule.id, code: rule.code });
  }

  return out;
}

/** A template shaped exactly like the tables the client already keeps. */
async function buildTemplate(disciplineCode = null) {
  const dict = await dictSvc.load(true);
  const disc = disciplineCode ? dict.disciplineByCode.get(disciplineCode) : null;

  const inputs = dict.parameters.filter(
    (p) => (p.role === "input" || p.role === "both") && (!disc || p.discipline_id === disc.id || !p.discipline_id)
  );
  const outputs = dict.parameters.filter(
    (p) => (p.role === "output" || p.role === "both") && (!disc || p.discipline_id === disc.id)
  );

  const headers = ["RULE ID", "DESCRIPTION", "PRIORITY"];
  for (const p of inputs) {
    if (p.data_type === "number") {
      headers.push(`${p.label.toUpperCase()} FROM${p.canonical_unit ? ` (${p.canonical_unit})` : ""}`);
      headers.push(`${p.label.toUpperCase()} TO${p.canonical_unit ? ` (${p.canonical_unit})` : ""}`);
    } else {
      headers.push(p.label.toUpperCase());
    }
  }
  for (const p of outputs) headers.push(p.label.toUpperCase());
  headers.push("ENGINEER APPROVAL", "CLAUSE");

  const guide = [
    ["HOW TO USE THIS TEMPLATE"],
    [""],
    ["1. One row = one rule."],
    ["2. RULE ID is your own reference, e.g. E-006. It must be unique."],
    ["3. Condition columns (left): leave a cell BLANK if the rule does not care about that value."],
    ["4. A pair of FROM / TO columns becomes one inclusive range condition."],
    ["5. Output columns (right): the value EOS will recommend when the conditions match."],
    ["6. PRIORITY: higher wins. Two rules with the same priority that disagree raise an engineer conflict."],
    ["7. ENGINEER APPROVAL: put YES to force an engineer to sign the value off."],
    [""],
    ["Imported rules arrive as DRAFT. Nothing goes live until an Engineering Standards Manager approves it."],
    [""],
    ["If a column header is not recognised, EOS will TELL you rather than guess — add the alias in the"],
    ["Parameter Dictionary, then re-upload."],
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guide), "Read Me");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers]), disc ? disc.name : "Rules");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

module.exports = { preview, commit, buildTemplate, planColumns, rowToRule, splitHeader };
