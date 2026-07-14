/**
 * THE ENGINEERING RULES ENGINE.
 *
 *   Extract equipment data → match the Conditions → apply the Rule → populate the Outputs.
 *
 * Every rule is DATA. This file contains no engineering knowledge whatsoever — no cable table, no
 * pipe size, no formula. It only knows how to COMPARE and APPLY what CULINOVA's engineers authored.
 * That is the client's requirement: new disciplines and standards arrive as rows, never as code.
 *
 * The policies it obeys (all read from ceks_engine_settings, all changeable from the Admin Portal):
 *   • the manufacturer's value is NEVER overwritten — the recommendation sits beside it
 *   • highest rule priority wins; equal-priority rules that disagree raise an ENGINEER CONFLICT
 *   • when no rule covers a value, the output is left BLANK and flagged — never extrapolated
 *   • when an input is missing, EOS says which one, and why the calculation could not complete
 *   • below the confidence threshold an input is flagged "Verify Input", not silently trusted
 */
const { supabase } = require("../config/supabase");
const dictSvc = require("./params");
const expr = require("./expression");

const n0 = (v) => (v == null ? null : Number(v));

// A DB-authored regex runs against attacker-influenceable attribute text. We cannot make an arbitrary
// pattern linear-time without a RE2 engine, but we CAN bound the work: cap the tested string length
// so catastrophic backtracking has little to chew on. Patterns are also validated when authored.
const REGEX_INPUT_CAP = 512;
function safeRegexTest(pattern, input) {
  try {
    return new RegExp(pattern, "i").test(String(input).slice(0, REGEX_INPUT_CAP));
  } catch {
    return null; // invalid pattern → caller decides; never throws into evaluation
  }
}

// The effective confidence of an input. An UNKNOWN confidence is NOT 1.0 — a value we cannot vouch
// for must not read as fully trusted. An ASSUMED value (unit assumed, bound recorded) is capped low.
function effectiveConfidence(source, unknownDefault) {
  let c = source && source.confidence != null ? Number(source.confidence) : unknownDefault;
  if (!Number.isFinite(c)) c = unknownDefault;
  if (source && source.assumed) c = Math.min(c, unknownDefault);
  return c;
}

// ── CONDITION EVALUATION ─────────────────────────────────────────────────────
/**
 * Does one condition hold for the equipment?
 * Returns { matched, reason, using } — `using` is the fact it was tested against, so the
 * recommendation can show EXACTLY what it matched on.
 */
function evalCondition(dict, cond, scope) {
  const param = dict.paramById.get(cond.parameter_id);
  if (!param) return { matched: false, reason: "condition references an unknown parameter" };

  const fact = scope[param.key];

  if (cond.operator === "exists") {
    return { matched: !!fact, reason: fact ? null : `${param.label} is not present`, using: fact || null, param };
  }
  if (cond.operator === "not_exists") {
    return { matched: !fact, reason: fact ? `${param.label} is present` : null, using: fact || null, param };
  }

  // every other operator needs the fact to be there at all
  if (!fact) {
    return {
      matched: false,
      missing: param.key,
      reason: `${param.label} is missing`,
      param,
    };
  }

  // a fact with conflicting values on the same datasheet is UNUSABLE until an engineer chooses; a
  // rule referencing it simply does not fire (the ambiguity itself is reported once, globally).
  if (fact.ambiguous) {
    return { matched: false, multiValue: true, reason: `${param.label} has conflicting values on this datasheet`, param, using: fact };
  }

  // ── numeric comparison ────────────────────────────────────────────────────
  if (param.data_type === "number") {
    // convert the RULE's value into the parameter's canonical unit, so an author can write "20 A"
    // or "20000 mA" and both mean the same thing
    const toCanon = (v) => {
      if (v == null) return null;
      if (!cond.unit || !param.canonical_unit || cond.unit === param.canonical_unit) return Number(v);
      const c = dictSvc.convert(dict, v, cond.unit, param.canonical_unit);
      return c;
    };
    const cv = toCanon(cond.value_num);
    const cmin = toCanon(cond.value_min);
    const cmax = toCanon(cond.value_max);

    if ((cond.value_num != null && cv === null) || (cond.value_min != null && cmin === null) || (cond.value_max != null && cmax === null)) {
      return { matched: false, reason: `cannot convert the rule's unit "${cond.unit}" to ${param.canonical_unit}`, param, using: fact };
    }

    // The equipment's fact may itself be a RANGE ("380-415 V"). A range satisfies a comparison only
    // if it does so unambiguously; a partial overlap is NOT a match — it is an engineering judgement
    // the engine must not make.
    const isRange = fact.num == null && fact.min != null && fact.max != null;
    const lo = isRange ? Number(fact.min) : Number(fact.num);
    const hi = isRange ? Number(fact.max) : Number(fact.num);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      return { matched: false, reason: `${param.label} could not be read as a number`, param, using: fact };
    }

    const ambiguous = (ok, notOk) => (ok && notOk ? { matched: false, ambiguous: true, reason: `${param.label} is a range (${lo}–${hi}) that only partly satisfies this condition`, param, using: fact } : null);

    switch (cond.operator) {
      case "eq": {
        const all = lo === cv && hi === cv;
        const some = lo <= cv && cv <= hi;
        const amb = ambiguous(some, !all);
        if (amb) return amb;
        return { matched: all, reason: all ? null : `${param.label} is ${fmt(fact)} ≠ ${cv}`, param, using: fact };
      }
      case "neq": {
        const all = !(lo <= cv && cv <= hi);
        return { matched: all, reason: all ? null : `${param.label} equals ${cv}`, param, using: fact };
      }
      case "gt": {
        const all = lo > cv;
        const amb = ambiguous(hi > cv, !all);
        if (amb) return amb;
        return { matched: all, reason: all ? null : `${param.label} ${fmt(fact)} is not > ${cv}`, param, using: fact };
      }
      case "gte": {
        const all = lo >= cv;
        const amb = ambiguous(hi >= cv, !all);
        if (amb) return amb;
        return { matched: all, reason: all ? null : `${param.label} ${fmt(fact)} is not ≥ ${cv}`, param, using: fact };
      }
      case "lt": {
        const all = hi < cv;
        const amb = ambiguous(lo < cv, !all);
        if (amb) return amb;
        return { matched: all, reason: all ? null : `${param.label} ${fmt(fact)} is not < ${cv}`, param, using: fact };
      }
      case "lte": {
        const all = hi <= cv;
        const amb = ambiguous(lo <= cv, !all);
        if (amb) return amb;
        return { matched: all, reason: all ? null : `${param.label} ${fmt(fact)} is not ≤ ${cv}`, param, using: fact };
      }
      case "between": {
        // the electrical tables are range tables: CURRENT FROM … CURRENT TO (inclusive)
        const all = lo >= cmin && hi <= cmax;
        const some = hi >= cmin && lo <= cmax;
        const amb = ambiguous(some, !all);
        if (amb) return amb;
        return { matched: all, reason: all ? null : `${param.label} ${fmt(fact)} is outside ${cmin}–${cmax}`, param, using: fact };
      }
      default:
        return { matched: false, reason: `operator "${cond.operator}" is not valid for a number`, param, using: fact };
    }
  }

  // ── enum / text / boolean comparison ──────────────────────────────────────
  const factVal = String(fact.value ?? "").trim();
  const lowerFact = factVal.toLowerCase();
  const list = Array.isArray(cond.value_list) ? cond.value_list.map((x) => String(x).toLowerCase()) : [];
  const target = cond.value_text == null ? "" : String(cond.value_text).trim();

  switch (cond.operator) {
    case "eq":
      return { matched: lowerFact === target.toLowerCase(), reason: `${param.label} is "${factVal}", not "${target}"`, param, using: fact };
    case "neq":
      return { matched: lowerFact !== target.toLowerCase(), reason: `${param.label} is "${target}"`, param, using: fact };
    case "in":
      return { matched: list.includes(lowerFact), reason: `${param.label} "${factVal}" is not one of ${list.join(", ")}`, param, using: fact };
    case "not_in":
      return { matched: !list.includes(lowerFact), reason: `${param.label} "${factVal}" is excluded`, param, using: fact };
    case "contains":
      return { matched: lowerFact.includes(target.toLowerCase()), reason: `${param.label} does not contain "${target}"`, param, using: fact };
    case "matches": {
      const hit = safeRegexTest(target, factVal);
      if (hit === null) return { matched: false, reason: `the rule's pattern "${target}" is not a valid expression`, param, using: fact };
      return { matched: hit, reason: `${param.label} does not match /${target}/`, param, using: fact };
    }
    default:
      return { matched: false, reason: `operator "${cond.operator}" is not valid for ${param.data_type}`, param, using: fact };
  }
}

const fmt = (fact) => {
  if (!fact) return "—";
  if (fact.num != null) return `${fact.num}${fact.unit ? " " + fact.unit : ""}`;
  if (fact.min != null) return `${fact.min}–${fact.max}${fact.unit ? " " + fact.unit : ""}`;
  return String(fact.value ?? "—");
};

// ── LOADING ACTIVE RULES ─────────────────────────────────────────────────────
/** Only APPROVED + ACTIVE rules, in effect today, ever run. A draft rule never touches equipment. */
async function loadActiveRules({ disciplineId = null, ruleType = null } = {}) {
  let q = supabase
    .from("ceks_rules")
    .select("*, ceks_rule_conditions(*), ceks_rule_outputs(*)")
    .eq("status", "approved")
    .eq("is_active", true);
  if (disciplineId) q = q.eq("discipline_id", disciplineId);
  if (ruleType) q = q.eq("rule_type", ruleType);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const today = new Date().toISOString().slice(0, 10);
  return (data || [])
    .filter((r) => (!r.effective_from || r.effective_from <= today) && (!r.effective_to || r.effective_to >= today))
    .sort((a, b) => b.priority - a.priority);
}

// ── DERIVATION ───────────────────────────────────────────────────────────────
/**
 * Fill in inputs the datasheet did not give us — but ONLY with a formula CULINOVA authored and
 * approved. The client was explicit: "formulas, PF, efficiency and assumptions must be stored as
 * editable engineering rules and reviewed separately." So a derivation is just a rule whose output
 * happens to be an input.
 *
 * Mutates `scope`, marking every derived fact with origin "derived" and the rule that produced it.
 */
async function applyDerivations(dict, scope, constants) {
  const rules = await loadActiveRules({ ruleType: "derivation" });
  const unknownConf = dictSvc.settingNum(dict, "unknown_confidence_default", 0.5);
  const derived = [];
  const failures = [];
  const conflicts = [];

  // The variables a formula may read: constants + every UNAMBIGUOUS scope fact. An ambiguous fact is
  // deliberately withheld so a derivation can never silently compute off a guessed value.
  const buildVars = () => {
    const vars = { ...constants };
    for (const [k, f] of Object.entries(scope)) {
      if (f.ambiguous) continue;
      if (f.num != null) vars[k] = f.num;
      else if (f.min != null && f.max != null) vars[k] = (Number(f.min) + Number(f.max)) / 2;
    }
    return vars;
  };
  const same = (a, b) => Number(a).toFixed(6) === Number(b).toFixed(6);

  // a derivation may depend on another derivation — iterate until nothing new appears
  let progress = true;
  let pass = 0;
  while (progress && pass < 5) {
    progress = false;
    pass++;

    // 1) gather EVERY derivation candidate that fires this pass, grouped by the parameter it produces
    const candidatesByParam = new Map();
    for (const rule of rules) {
      const conds = rule.ceks_rule_conditions || [];
      const results = conds.map((c) => evalCondition(dict, c, scope));
      if (!results.every((r) => r.matched)) continue;

      for (const out of rule.ceks_rule_outputs || []) {
        const p = dict.paramById.get(out.parameter_id);
        if (!p || scope[p.key] || !out.expression) continue; // manufacturer/derived value already wins

        const vars = buildVars();
        const res = expr.evaluate(out.expression, vars);
        if (!res.ok) {
          failures.push({
            parameter: p.key, label: p.label, rule_id: rule.id, rule_code: rule.code,
            expression: out.expression, error: res.error, missing: res.missing,
          });
          continue;
        }
        if (!candidatesByParam.has(p.key)) candidatesByParam.set(p.key, []);
        candidatesByParam.get(p.key).push({ rule, out, p, res, vars });
      }
    }

    // 2) resolve each parameter: highest priority wins; equal priority + different answer = CONFLICT
    for (const [key, cands] of candidatesByParam) {
      if (scope[key]) continue;
      cands.sort((a, b) => b.rule.priority - a.rule.priority);
      const top = cands[0];
      const disagreeing = cands.filter(
        (c) => c.rule.priority === top.rule.priority && c.rule.id !== top.rule.id && !same(c.res.value, top.res.value)
      );
      if (disagreeing.length) {
        // two derivation rules of equal priority compute DIFFERENT values → EOS does not choose.
        conflicts.push({
          parameter: key,
          label: top.p.label,
          candidates: [top, ...disagreeing].map((c) => ({
            rule_id: c.rule.id, rule_code: c.rule.code, rule_version: c.rule.version,
            priority: c.rule.priority, value: c.res.value, unit: c.out.unit || c.p.canonical_unit,
          })),
        });
        continue; // leave it underived — the engineer resolves it
      }

      const { rule, out, p, res } = top;
      const inputs = res.used.map((k) => {
        const f = scope[k];
        return f
          ? { key: k, label: f.label, value: f.num ?? f.value, unit: f.unit, page: f.source?.page, confidence: effectiveConfidence(f.source, unknownConf), assumed: !!f.source?.assumed }
          : { key: k, value: top.vars[k], constant: true };
      });
      const inputConfs = inputs.filter((i) => !i.constant).map((i) => i.confidence);

      scope[p.key] = {
        parameter_id: p.id,
        key: p.key,
        label: p.label,
        data_type: p.data_type,
        value: String(res.value),
        num: res.value,
        min: null,
        max: null,
        unit: out.unit || p.canonical_unit,
        source: {
          origin: "derived",
          rule_id: rule.id,
          rule_code: rule.code,
          rule_version: rule.version,
          expression: out.expression,
          inputs,
          // a derived value is only as trustworthy as its weakest input (unknown inputs count as low)
          confidence: inputConfs.length ? Math.min(...inputConfs) : unknownConf,
          verified: false,
          assumed: inputs.some((i) => i.assumed),
        },
      };
      derived.push({ parameter: p.key, label: p.label, value: res.value, unit: out.unit || p.canonical_unit, rule: rule.code });
      progress = true;
    }
  }

  return { derived, failures, conflicts };
}

// ── THE MAIN PASS ────────────────────────────────────────────────────────────
/**
 * Run every approved rule against one piece of equipment.
 * Returns recommendations + validations. Persists NOTHING — the caller decides.
 */
async function evaluate({ scope, constants, dict }) {
  const threshold = dictSvc.settingNum(dict, "confidence_threshold", 0.8);
  const unknownConf = dictSvc.settingNum(dict, "unknown_confidence_default", 0.5);
  const recommendations = [];
  const validations = [];

  // 0) surface any input the datasheet stated more than one way — ONCE, before any rule runs. The
  //    engine will not pick between "230 V" and "400 V"; an engineer must select the correct value.
  for (const [key, fact] of Object.entries(scope)) {
    if (!fact.ambiguous) continue;
    validations.push({
      code: "ambiguous_input",
      severity: "error",
      parameter_key: key,
      message: `${fact.label}: conflicting values found on this datasheet.`,
      reason: `Found ${fact.candidates.length} different values — ${fact.candidates.join(", ")}. EOS will not choose between them; an engineer must select the correct one.`,
      required_input: [key],
      details: { candidates: fact.candidates },
    });
  }

  // 1) derive whatever we can (Current from Power/Voltage/Phase, etc.)
  const { derived, failures, conflicts } = await applyDerivations(dict, scope, constants);
  for (const c of conflicts) {
    validations.push({
      code: "conflict",
      severity: "error",
      parameter_key: c.parameter,
      message: `${c.label}: two derivation rules of equal priority disagree.`,
      reason: `${c.candidates.map((x) => `${x.rule_code} → ${x.value}${x.unit ? " " + x.unit : ""}`).join("; ")}. EOS will not choose — an engineer must decide.`,
      details: { candidates: c.candidates },
    });
  }
  for (const f of failures) {
    validations.push({
      code: "missing_input",
      severity: "error",
      parameter_key: f.parameter,
      rule_id: f.rule_id,
      message: `${f.label} could not be calculated.`,
      reason: f.missing
        ? `The formula in rule ${f.rule_code} needs "${f.missing}", which this datasheet does not provide.`
        : `Rule ${f.rule_code}: ${f.error}`,
      required_input: f.missing ? [f.missing] : [],
      details: { expression: f.expression, error: f.error },
    });
  }

  // 2) apply the recommendation rules
  const rules = await loadActiveRules({ ruleType: "recommendation" });

  // parameter → every rule that fired for it (so we can resolve priority and spot conflicts)
  const hits = new Map();

  for (const rule of rules) {
    const conds = rule.ceks_rule_conditions || [];
    if (!conds.length) continue; // a rule with no conditions would match everything — refuse it

    const results = conds.map((c) => evalCondition(dict, c, scope));
    const matched = results.every((r) => r.matched);

    if (!matched) {
      // was it only missing an input? that is worth telling the engineer about
      const missing = results.filter((r) => r.missing).map((r) => r.missing);
      const ambiguous = results.filter((r) => r.ambiguous);
      if (missing.length) {
        for (const out of rule.ceks_rule_outputs || []) {
          const p = dict.paramById.get(out.parameter_id);
          if (!p) continue;
          validations.push({
            code: "missing_input",
            severity: "error",
            parameter_key: p.key,
            rule_id: rule.id,
            message: `${p.label} could not be recommended.`,
            reason: `Rule ${rule.code} needs ${missing.map((m) => dict.paramByKey.get(m)?.label || m).join(", ")}, which this datasheet does not provide.`,
            required_input: missing,
            details: { rule_code: rule.code },
          });
        }
      }
      if (ambiguous.length) {
        validations.push({
          code: "ambiguous_input",
          severity: "warning",
          parameter_key: ambiguous[0].param?.key || null,
          rule_id: rule.id,
          message: `Rule ${rule.code} was not applied.`,
          reason: ambiguous[0].reason,
          details: { rule_code: rule.code },
        });
      }
      continue;
    }

    // the rule fired → build its outputs
    const matchedConditions = results.map((r, i) => ({
      parameter: r.param?.key,
      label: r.param?.label,
      operator: conds[i].operator,
      expected:
        conds[i].operator === "between"
          ? `${conds[i].value_min}–${conds[i].value_max} ${conds[i].unit || ""}`.trim()
          : conds[i].value_text ?? conds[i].value_num ?? (conds[i].value_list || []).join(", "),
      actual: fmt(r.using),
    }));

    const inputsUsed = results
      .filter((r) => r.using)
      .map((r) => ({
        key: r.param.key,
        label: r.param.label,
        value: r.using.num ?? r.using.value,
        unit: r.using.unit,
        origin: r.using.source?.origin,
        document: r.using.source?.document,
        page: r.using.source?.page,
        // an UNKNOWN or ASSUMED input confidence is treated as LOW, never as fully trusted
        confidence: effectiveConfidence(r.using.source, unknownConf),
        assumed: !!r.using.source?.assumed,
        rule_code: r.using.source?.rule_code,   // set when the input was itself derived
      }));

    const confidences = inputsUsed.map((i) => Number(i.confidence));
    const confidence = confidences.length ? Math.min(...confidences) : null;

    for (const out of rule.ceks_rule_outputs || []) {
      const p = dict.paramById.get(out.parameter_id);
      if (!p) continue;

      let value = out.value_text;
      let valueNum = n0(out.value_num);

      if (out.expression) {
        const vars = { ...constants };
        for (const [k, f] of Object.entries(scope)) {
          if (f.num != null) vars[k] = f.num;
        }
        const res = expr.evaluate(out.expression, vars);
        if (!res.ok) {
          validations.push({
            code: "missing_input",
            severity: "error",
            parameter_key: p.key,
            rule_id: rule.id,
            message: `${p.label} could not be calculated.`,
            reason: res.missing
              ? `Rule ${rule.code} needs "${res.missing}", which is not available.`
              : `Rule ${rule.code}: ${res.error}`,
            required_input: res.missing ? [res.missing] : [],
            details: { expression: out.expression },
          });
          continue;
        }
        valueNum = res.value;
        value = String(res.value);
      }

      if (value == null && valueNum == null) continue; // an output with nothing in it is not an output

      const rec = {
        parameter_id: p.id,
        parameter_key: p.key,
        parameter_label: p.label,
        discipline_id: rule.discipline_id,
        value_text: value == null ? null : String(value),
        value_num: valueNum,
        unit: out.unit || p.canonical_unit || null,
        rule_id: rule.id,
        rule_code: rule.code,
        rule_version: rule.version,
        rule_priority: rule.priority,
        engineer_approval_required: !!rule.engineer_approval_required,
        matched_conditions: matchedConditions,
        inputs_used: inputsUsed,
        confidence,
        note: out.note || null,
        // below the client's 0.80 threshold the engineer must eyeball the input before trusting it
        status: confidence != null && confidence < threshold ? "verify_input" : "proposed",
      };

      if (!hits.has(p.id)) hits.set(p.id, []);
      hits.get(p.id).push(rec);
    }
  }

  // 3) resolve priority + detect conflicts
  for (const [, candidates] of hits) {
    candidates.sort((a, b) => b.rule_priority - a.rule_priority);
    const top = candidates[0];
    const rivals = candidates.filter(
      (c) => c.rule_priority === top.rule_priority && c.rule_id !== top.rule_id
    );
    const disagreeing = rivals.filter(
      (c) => String(c.value_text ?? c.value_num) !== String(top.value_text ?? top.value_num)
    );

    if (disagreeing.length) {
      // EQUAL priority, DIFFERENT answers → the engine does not choose. The engineer does.
      top.status = "conflict";
      top.conflict_with = [top, ...disagreeing].map((c) => ({
        rule_id: c.rule_id,
        rule_code: c.rule_code,
        rule_version: c.rule_version,
        priority: c.rule_priority,
        value: c.value_text ?? c.value_num,
        unit: c.unit,
      }));
      validations.push({
        code: "conflict",
        severity: "error",
        parameter_key: top.parameter_key,
        rule_id: top.rule_id,
        message: `${top.parameter_label}: two rules of equal priority disagree.`,
        reason: `${[top, ...disagreeing].map((c) => `${c.rule_code} says "${c.value_text ?? c.value_num}"`).join("; ")}. EOS will not choose between them — an engineer must decide.`,
        details: { candidates: top.conflict_with },
      });
    }

    if (top.status === "verify_input") {
      validations.push({
        code: "low_confidence",
        severity: "warning",
        parameter_key: top.parameter_key,
        rule_id: top.rule_id,
        message: `${top.parameter_label}: verify the input.`,
        reason: `This recommendation was calculated from data extracted with ${Math.round((top.confidence || 0) * 100)}% confidence, below the ${Math.round(threshold * 100)}% threshold.`,
        details: { inputs: top.inputs_used },
      });
    }

    if (top.engineer_approval_required) {
      validations.push({
        code: "engineer_approval_required",
        severity: "error",
        parameter_key: top.parameter_key,
        rule_id: top.rule_id,
        message: `${top.parameter_label} requires engineer approval.`,
        reason: `Rule ${top.rule_code} is marked "Engineer Approval Required".`,
        details: {},
      });
    }

    recommendations.push(top);
  }

  // 4) an output no rule covered at all → blank + flagged. NEVER extrapolated.
  const outputParams = dict.parameters.filter((p) => (p.role === "output" || p.role === "both") && p.is_active);
  const covered = new Set(recommendations.map((r) => r.parameter_id));
  const flaggedMissing = new Set(validations.filter((v) => v.code === "missing_input").map((v) => v.parameter_key));

  for (const p of outputParams) {
    if (covered.has(p.id)) continue;
    if (flaggedMissing.has(p.key)) continue; // already explained: we lack an input
    // only complain about disciplines that actually have rules — otherwise every fresh install
    // would scream about everything
    const hasRules = rules.some((r) => (r.ceks_rule_outputs || []).some((o) => o.parameter_id === p.id));
    if (!hasRules) continue;

    validations.push({
      code: "no_rule_match",
      severity: "warning",
      parameter_key: p.key,
      message: `${p.label}: no rule covers this equipment.`,
      reason: `Rules exist for ${p.label}, but none of their conditions match this equipment's values. EOS will not extrapolate — an engineer must supply the value.`,
      required_input: [p.key],
      details: {},
    });
  }

  return { recommendations, validations, derived, scope };
}

module.exports = { evaluate, evalCondition, loadActiveRules, applyDerivations };
