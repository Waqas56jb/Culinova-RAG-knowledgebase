/**
 * RECOMMENDATIONS — generate, persist, compare, decide, and remember.
 *
 * The CULINOVA recommendation is stored ALONGSIDE the manufacturer's own value. The manufacturer's
 * extracted data is never overwritten, never corrected, never hidden. The engineer sees both and
 * decides — and that decision, with its reason, is recorded forever.
 *
 * Every recommendation is frozen against the RULE VERSION that produced it. When a standard later
 * changes, EOS does not rewrite history: it raises a "Recalculation Available" alert on every
 * affected item and lets an engineer decide, deliberately.
 */
const { supabase } = require("../config/supabase");
const dictSvc = require("./params");
const normalize = require("./normalize");
const ruleEngine = require("./ruleEngine");

const nowIso = () => new Date().toISOString();

/** The version + entry a recommendation hangs off. */
async function loadVersionContext(versionId) {
  const { data: version, error } = await supabase
    .from("ceks_knowledge_versions")
    .select("*")
    .eq("id", versionId)
    .maybeSingle();
  if (error || !version) throw new Error("Knowledge version not found");

  const { data: entry } = await supabase
    .from("ceks_knowledge_entries")
    .select("*")
    .eq("id", version.knowledge_entry_id)
    .maybeSingle();

  return { version, entry };
}

/**
 * What did the MANUFACTURER say about this same parameter?
 * Many of our output parameters (Cable Size, Drain Size, Gas Connection Size) are ALSO printed on the
 * datasheet — that is exactly the comparison the client wants to see.
 */
async function manufacturerValueFor(versionId, parameterId) {
  const { data } = await supabase
    .from("ceks_knowledge_attributes")
    .select("id, name, value, unit, source_page, source_document, confidence, verified")
    .eq("version_id", versionId)
    .eq("parameter_id", parameterId)
    .limit(1)
    .maybeSingle();
  return data || null;
}

/**
 * Run the engine over one knowledge version and persist the result.
 *
 * An engineer's existing DECISIONS are preserved: if they already accepted or modified a value under
 * the same rule version, we do not silently throw that away. A regeneration under a NEW rule version
 * supersedes the old recommendation and records the change in history.
 */
async function generateForVersion(versionId, { actor = null, trigger = "extraction" } = {}) {
  const { version, entry } = await loadVersionContext(versionId);

  // 1) make the raw extracted values comparable (this is what lets a rule match at all)
  const normReport = await normalize.normalizeVersion(versionId);

  // 2) build the evaluation scope and run every approved rule
  const built = await normalize.buildScope(versionId, entry);
  const { recommendations, validations, derived } = await ruleEngine.evaluate(built);

  // 3) what is already stored?
  const { data: existing } = await supabase
    .from("ceks_recommendations")
    .select("*")
    .eq("version_id", versionId)
    .eq("is_current", true);
  const prevByParam = new Map((existing || []).map((r) => [r.parameter_id, r]));

  const written = [];
  const seen = new Set();

  for (const rec of recommendations) {
    seen.add(rec.parameter_id);
    const prev = prevByParam.get(rec.parameter_id);
    const manu = await manufacturerValueFor(versionId, rec.parameter_id);

    const sameRuleVersion = prev && prev.rule_id === rec.rule_id && prev.rule_version === rec.rule_version;
    const sameValue = prev && String(prev.value_text ?? prev.value_num) === String(rec.value_text ?? rec.value_num);

    // nothing changed AND the engineer already decided → leave their decision alone
    if (prev && sameRuleVersion && sameValue && ["accepted", "modified", "rejected"].includes(prev.status)) {
      written.push(prev);
      continue;
    }

    const row = {
      version_id: versionId,
      parameter_id: rec.parameter_id,
      value_text: rec.value_text,
      value_num: rec.value_num,
      unit: rec.unit,
      manufacturer_attribute_id: manu ? manu.id : null,
      manufacturer_value: manu ? manu.value : null,
      manufacturer_unit: manu ? manu.unit : null,
      rule_id: rec.rule_id,
      rule_code: rec.rule_code,
      rule_version: rec.rule_version,
      discipline_id: rec.discipline_id,
      matched_conditions: rec.matched_conditions,
      inputs_used: rec.inputs_used,
      confidence: rec.confidence,
      status: rec.status,
      conflict_with: rec.conflict_with || null,
      generated_at: nowIso(),
      is_current: true,
    };

    if (prev) {
      // supersede — never overwrite. The old one stays, frozen against its rule version.
      await supabase.from("ceks_recommendations").update({ is_current: false }).eq("id", prev.id);
      const { data: ins } = await supabase.from("ceks_recommendations").insert(row).select().single();
      if (ins) {
        await supabase.from("ceks_recommendations").update({ superseded_by: ins.id }).eq("id", prev.id);
        await history(versionId, {
          recommendation_id: ins.id,
          parameter_id: rec.parameter_id,
          action: prev.rule_version !== rec.rule_version ? "recalculated" : "regenerated",
          previous_value: prev.final_value ?? prev.value_text ?? String(prev.value_num ?? ""),
          new_value: rec.value_text ?? String(rec.value_num ?? ""),
          previous_rule_version: prev.rule_version,
          new_rule_version: rec.rule_version,
          rule_id: rec.rule_id,
          reason: `Regenerated (${trigger})`,
          actor,
        });
        written.push(ins);
      }
    } else {
      const { data: ins } = await supabase.from("ceks_recommendations").insert(row).select().single();
      if (ins) {
        await history(versionId, {
          recommendation_id: ins.id,
          parameter_id: rec.parameter_id,
          action: "generated",
          new_value: rec.value_text ?? String(rec.value_num ?? ""),
          new_rule_version: rec.rule_version,
          rule_id: rec.rule_id,
          reason: `Generated (${trigger})`,
          actor,
        });
        written.push(ins);
      }
    }
  }

  // a parameter that USED to have a recommendation and no longer does (its rule was archived or its
  // conditions no longer match) — retire it honestly, do not leave a stale number on screen
  for (const [paramId, prev] of prevByParam) {
    if (seen.has(paramId)) continue;
    await supabase.from("ceks_recommendations").update({ is_current: false }).eq("id", prev.id);
    await history(versionId, {
      recommendation_id: prev.id,
      parameter_id: paramId,
      action: "rule_changed",
      previous_value: prev.final_value ?? prev.value_text,
      new_value: null,
      reason: "No approved rule covers this parameter any more.",
      actor,
    });
  }

  // 4) validations — replace the OPEN ones; keep anything an engineer already resolved
  await supabase.from("ceks_validations").delete().eq("version_id", versionId).eq("status", "open");
  if (validations.length) {
    const dict = await dictSvc.load();
    const rows = validations.map((v) => {
      const p = v.parameter_key ? dict.paramByKey.get(v.parameter_key) : null;
      return {
        version_id: versionId,
        discipline_id: p ? p.discipline_id : null,
        parameter_id: p ? p.id : null,
        rule_id: v.rule_id || null,
        severity: v.severity,
        code: v.code,
        message: v.message,
        reason: v.reason || null,
        required_input: v.required_input ? JSON.stringify(v.required_input) : null,
        details: v.details || null,
        status: "open",
      };
    });
    await supabase.from("ceks_validations").insert(rows);
  }

  return {
    version_id: versionId,
    normalized: normReport,
    derived,
    recommendations: written.length,
    validations: validations.length,
    blocking: validations.filter((v) => v.severity === "error").length,
  };
}

/** Append one line to the audit trail. */
async function history(versionId, row) {
  await supabase.from("ceks_recommendation_history").insert({
    version_id: versionId,
    recommendation_id: row.recommendation_id || null,
    parameter_id: row.parameter_id || null,
    action: row.action,
    previous_value: row.previous_value ?? null,
    new_value: row.new_value ?? null,
    previous_rule_version: row.previous_rule_version ?? null,
    new_rule_version: row.new_rule_version ?? null,
    rule_id: row.rule_id || null,
    reason: row.reason || null,
    actor_id: row.actor?.id || null,
    actor_name: row.actor?.full_name || row.actor?.name || null,
    details: row.details || null,
  });
}

/**
 * The engineer's decision. The client's rule: a recommendation may be accepted, modified or
 * rejected — and a modify/reject REQUIRES a reason. Nothing is decided silently.
 */
async function decide(recommendationId, { action, value, unit, note, actor }) {
  const { data: rec } = await supabase.from("ceks_recommendations").select("*").eq("id", recommendationId).maybeSingle();
  if (!rec) throw new Error("Recommendation not found");

  if (!["accept", "modify", "reject"].includes(action)) throw new Error('action must be accept, modify or reject');
  if ((action === "modify" || action === "reject") && !String(note || "").trim()) {
    throw new Error("A reason is required to modify or reject an engineering recommendation.");
  }
  if (action === "modify" && (value == null || String(value).trim() === "")) {
    throw new Error("Provide the value you are setting.");
  }

  const status = action === "accept" ? "accepted" : action === "modify" ? "modified" : "rejected";
  const finalValue =
    action === "accept" ? (rec.value_text ?? (rec.value_num != null ? String(rec.value_num) : null))
      : action === "modify" ? String(value)
        : null;

  const { data: updated, error } = await supabase
    .from("ceks_recommendations")
    .update({
      status,
      final_value: finalValue,
      final_unit: action === "modify" ? (unit || rec.unit) : rec.unit,
      decided_by: actor?.id || null,
      decided_at: nowIso(),
      decision_note: note || null,
    })
    .eq("id", recommendationId)
    .select()
    .single();
  if (error) throw new Error(error.message);

  await history(rec.version_id, {
    recommendation_id: rec.id,
    parameter_id: rec.parameter_id,
    action: status,
    previous_value: rec.value_text ?? (rec.value_num != null ? String(rec.value_num) : null),
    new_value: finalValue,
    rule_id: rec.rule_id,
    new_rule_version: rec.rule_version,
    reason: note || null,
    actor,
  });

  // a decision resolves the validations that were waiting on it
  await supabase
    .from("ceks_validations")
    .update({ status: "resolved", resolved_by: actor?.id || null, resolved_at: nowIso(), resolution_note: note || `Engineer ${status} the recommendation.` })
    .eq("version_id", rec.version_id)
    .eq("parameter_id", rec.parameter_id)
    .eq("status", "open");

  return updated;
}

/**
 * Can this entry be approved?
 * The client: "Do not allow approval until the engineer selects or overrides with a reason."
 * So: any UNDECIDED recommendation, or any open ERROR validation, blocks approval — and we say
 * exactly what and why, rather than just refusing.
 */
async function approvalBlockers(versionId) {
  const dict = await dictSvc.load();
  if (!dictSvc.settingBool(dict, "require_resolution_before_approval", true)) return [];

  const blockers = [];

  const { data: recs } = await supabase
    .from("ceks_recommendations")
    .select("id, parameter_id, status, rule_code, value_text, value_num")
    .eq("version_id", versionId)
    .eq("is_current", true);

  for (const r of recs || []) {
    if (["accepted", "modified", "rejected"].includes(r.status)) continue;
    const p = dict.paramById.get(r.parameter_id);
    blockers.push({
      type: "undecided_recommendation",
      recommendation_id: r.id,
      parameter: p?.label || r.parameter_id,
      status: r.status,
      message:
        r.status === "conflict"
          ? `${p?.label}: two rules disagree — an engineer must choose.`
          : r.status === "verify_input"
            ? `${p?.label}: the input needs verifying before this can be accepted.`
            : `${p?.label}: the CULINOVA recommendation has not been accepted, modified or rejected yet.`,
    });
  }

  const { data: vals } = await supabase
    .from("ceks_validations")
    .select("id, code, message, reason, severity")
    .eq("version_id", versionId)
    .eq("status", "open")
    .eq("severity", "error");

  for (const v of vals || []) {
    blockers.push({ type: "open_validation", validation_id: v.id, code: v.code, message: v.message, reason: v.reason });
  }

  return blockers;
}

/**
 * A rule changed → find every approved item that used it and raise a "Recalculation Available"
 * alert. NOTHING is recalculated automatically: the engineer decides, deliberately.
 */
async function raiseRecalcAlerts(ruleId, newVersion) {
  const { data: affected } = await supabase
    .from("ceks_recommendations")
    .select("version_id, rule_version")
    .eq("rule_id", ruleId)
    .eq("is_current", true);

  const seen = new Map();
  for (const r of affected || []) {
    if (r.rule_version === newVersion) continue;
    if (!seen.has(r.version_id)) seen.set(r.version_id, r.rule_version);
  }

  const rows = [...seen.entries()].map(([versionId, oldVersion]) => ({
    version_id: versionId,
    rule_id: ruleId,
    old_version: oldVersion,
    new_version: newVersion,
    status: "pending",
  }));
  if (rows.length) {
    await supabase.from("ceks_recalc_alerts").upsert(rows, { onConflict: "version_id,rule_id,new_version", ignoreDuplicates: true });
    for (const row of rows) {
      await history(row.version_id, {
        action: "recalculation_available",
        rule_id: ruleId,
        previous_rule_version: row.old_version,
        new_rule_version: newVersion,
        reason: "The rule that produced this recommendation has been updated.",
      });
    }
  }
  return { affected_items: rows.length };
}

/** Everything the Review screen and the report need, in one shape. */
async function forVersion(versionId) {
  const dict = await dictSvc.load();

  const [{ data: recs }, { data: vals }, { data: alerts }] = await Promise.all([
    supabase.from("ceks_recommendations").select("*").eq("version_id", versionId).eq("is_current", true),
    supabase.from("ceks_validations").select("*").eq("version_id", versionId).order("severity"),
    supabase.from("ceks_recalc_alerts").select("*").eq("version_id", versionId).eq("status", "pending"),
  ]);

  const byDiscipline = {};
  for (const r of recs || []) {
    const p = dict.paramById.get(r.parameter_id);
    const d = p?.discipline_id ? dict.disciplineById.get(p.discipline_id) : null;
    const key = d?.code || "general";
    if (!byDiscipline[key]) byDiscipline[key] = { discipline: d || { code: "general", name: "General" }, items: [] };
    byDiscipline[key].items.push({
      ...r,
      parameter_key: p?.key,
      parameter_label: p?.label,
      // client item 5 — traceability, printed exactly like their example
      traceability: r.rule_code
        ? `Generated from ${dict.disciplineById.get(r.discipline_id)?.name || ""} Rule ${r.rule_code} (v${r.rule_version})`
        : null,
    });
  }

  return {
    version_id: versionId,
    disciplines: Object.values(byDiscipline),
    recommendations: recs || [],
    validations: vals || [],
    recalc_alerts: alerts || [],
    blockers: await approvalBlockers(versionId),
  };
}

module.exports = {
  generateForVersion,
  decide,
  approvalBlockers,
  raiseRecalcAlerts,
  forVersion,
  history,
};
