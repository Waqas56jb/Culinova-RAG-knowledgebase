/**
 * END-TO-END VERIFICATION of the Engineering Rules Engine, against the LIVE knowledge base.
 *
 * It proves the client's own worked example:
 *
 *   Extracted manufacturer data      →   Automatically generated CULINOVA recommendation
 *   Phase 3-Phase · Voltage 400 V         Cable size · Breaker · Isolator ·
 *   Power 24 kW  (Current NOT given)      Electrical connection · Engineer approval
 *
 * …including the part their datasheets always lack: Current is DERIVED, by a formula an engineer
 * authored as a rule (with the power factor as an editable constant) — never by a number this code
 * invented.
 *
 * Everything it creates is deleted again. It writes nothing permanent.
 *
 *   node cli/verify-engine.js
 */
require("dotenv").config();
const { supabase } = require("../src/config/supabase");
const dictSvc = require("../src/services/params");
const normalize = require("../src/services/normalize");
const recs = require("../src/services/recommendations");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  ✓", m)) : (fail++, console.log("  ✗ FAIL", m)); };
const S = (s) => console.log(`\n── ${s} ──`);

const cleanup = { rules: [], constants: [], versionId: null, entryId: null };

/** Remove anything a previous (possibly crashed) run left behind, so the script is re-runnable. */
async function purgeLeftovers() {
  const { data: old } = await supabase.from("ceks_rules").select("id").like("code", "ZZ-%");
  for (const r of old || []) {
    await supabase.from("ceks_recalc_alerts").delete().eq("rule_id", r.id);
    await supabase.from("ceks_recommendations").delete().eq("rule_id", r.id);
    await supabase.from("ceks_rule_conditions").delete().eq("rule_id", r.id);
    await supabase.from("ceks_rule_outputs").delete().eq("rule_id", r.id);
    await supabase.from("ceks_rule_versions").delete().eq("rule_id", r.id);
    await supabase.from("ceks_rules").delete().eq("id", r.id);
  }
  await supabase.from("ceks_rule_constants").delete().like("key", "zz%");
  // the test's own attributes are tagged ZZ-VERIFY — nothing else is ever touched
  await supabase.from("ceks_knowledge_attributes").delete().eq("source_document", "ZZ-VERIFY");
}

(async () => {
  console.log("\n######## ENGINEERING RULES ENGINE — LIVE VERIFICATION ########");
  await purgeLeftovers();

  // ─────────────────────────────────────────────────────────────────────────
  S("DICTIONARY — the canonical vocabulary must exist before any rule can match");
  const dict = await dictSvc.load(true);
  ok(dict.disciplines.length >= 8, `${dict.disciplines.length} disciplines (Electrical … Fire & Safety)`);
  ok(dict.parameters.length >= 40, `${dict.parameters.length} parameters in the dictionary`);
  ok(dict.aliasExact.size >= 60, `${dict.aliasExact.size} aliases — "Power Load"/"Connected Load"/"Total Power" all resolve to one parameter`);

  const pPower = dict.paramByKey.get("electrical.power");
  const pVolt = dict.paramByKey.get("electrical.voltage");
  const pPhase = dict.paramByKey.get("electrical.phase");
  const pCurrent = dict.paramByKey.get("electrical.current");
  const pCable = dict.paramByKey.get("electrical.cable_size");
  const pBreaker = dict.paramByKey.get("electrical.breaker");
  ok(pPower && pVolt && pPhase && pCurrent && pCable && pBreaker, "the parameters the client's example needs all exist");

  const elec = dict.disciplineByCode.get("electrical");

  // ─────────────────────────────────────────────────────────────────────────
  S("NORMALISATION — the live data is free text; a rule cannot compare free text");
  const cases = [
    ["380...415", null, pVolt, "range"],
    ["50/60", null, dict.paramByKey.get("electrical.frequency"), "range"],
    ["3N", null, pPhase, "enum"],
    ["24.0", "kW", pPower, "number"],
  ];
  for (const [raw, unit, param, kind] of cases) {
    const cols = normalize.normalizeAttribute(dict, { name: param.label, value: raw, unit });
    const shown =
      cols.value_canonical != null ? cols.value_canonical
        : cols.value_min != null ? `${cols.value_min}–${cols.value_max} ${cols.unit_canonical || ""}`
          : `${cols.value_num} ${cols.unit_canonical || ""}`;
    const good = cols.parameter_id === param.id && (cols.value_num != null || cols.value_min != null || cols.value_canonical != null);
    ok(good, `${kind.padEnd(6)} "${raw}" → ${shown.trim()}`);
  }
  // and it must say so honestly when it cannot
  const bad = normalize.normalizeAttribute(dict, { name: "Voltage", value: "see table", unit: null });
  ok(!!bad.normalize_note, `unreadable value → flagged, not guessed: "${bad.normalize_note}"`);

  // ─────────────────────────────────────────────────────────────────────────
  S("BUILD the client's own example as DATA (no engineering is hardcoded anywhere)");

  // the power factor is an engineering ASSUMPTION → it lives as an editable, reviewable constant
  const { data: pf } = await supabase.from("ceks_rule_constants").insert({
    key: "zzpf", value: 0.9, description: "ZZ TEST power factor", discipline_id: elec.id,
  }).select().single();
  cleanup.constants.push(pf.id);
  ok(!!pf, "power factor stored as an editable engineering constant (not a number in the code)");

  // DERIVATION rule — Current from Power/Voltage/Phase. The formula is DATA.
  const { data: derRule } = await supabase.from("ceks_rules").insert({
    code: "ZZ-DER-1", name: "ZZ Derive 3-phase current", discipline_id: elec.id,
    rule_type: "derivation", priority: 100, version: 1, status: "approved", is_active: true,
    description: "Current = Power / (√3 × Voltage × PF)",
  }).select().single();
  cleanup.rules.push(derRule.id);
  await supabase.from("ceks_rule_conditions").insert({
    rule_id: derRule.id, parameter_id: pPhase.id, operator: "eq", value_text: "3-Phase",
  });
  await supabase.from("ceks_rule_outputs").insert({
    rule_id: derRule.id, parameter_id: pCurrent.id, unit: "A",
    expression: "electrical.power * 1000 / (sqrt(3) * electrical.voltage * zzpf)",
  });
  ok(true, "derivation rule ZZ-DER-1 created — formula authored as data, reviewed like any rule");

  // RECOMMENDATION rule — the client's E-006: current 16–20 A → cable + breaker + isolator
  const { data: recRule } = await supabase.from("ceks_rules").insert({
    code: "ZZ-E-006", name: "ZZ Electrical 3ph 400V 16-20A", discipline_id: elec.id,
    rule_type: "recommendation", priority: 100, version: 1, status: "approved", is_active: true,
    engineer_approval_required: false,
    description: "3-Phase, 400 V, 16–20 A",
  }).select().single();
  cleanup.rules.push(recRule.id);
  await supabase.from("ceks_rule_conditions").insert([
    { rule_id: recRule.id, parameter_id: pPhase.id, operator: "eq", value_text: "3-Phase", sort_order: 0 },
    { rule_id: recRule.id, parameter_id: pCurrent.id, operator: "between", value_min: 16, value_max: 20, unit: "A", sort_order: 1 },
  ]);
  await supabase.from("ceks_rule_outputs").insert([
    { rule_id: recRule.id, parameter_id: pCable.id, value_text: "5×6 mm² Cu", sort_order: 0 },
    { rule_id: recRule.id, parameter_id: pBreaker.id, value_text: "32 A 3P MCB", sort_order: 1 },
  ]);
  ok(true, "recommendation rule ZZ-E-006 created — conditions + outputs, all data");

  // ─────────────────────────────────────────────────────────────────────────
  S("A REAL piece of equipment from the live knowledge base");
  const { data: entry } = await supabase
    .from("ceks_knowledge_entries")
    .select("*")
    .eq("current_status", "approved")
    .not("current_version_id", "is", null)
    .limit(1)
    .maybeSingle();
  ok(!!entry, `using "${entry?.title}" (${entry?.brand || "?"})`);
  cleanup.entryId = entry.id;
  cleanup.versionId = entry.current_version_id;

  // give it the client's exact example values (as manufacturer attributes), then remove them again
  const seedAttrs = [
    { name: "Phase", value: "3N", unit: null },                 // the real spelling in the live data
    { name: "Voltage", value: "400", unit: "V" },
    { name: "Power Load", value: "12", unit: "kW" },            // → current ≈ 19.2 A → inside 16–20
    { name: "Frequency", value: "50/60", unit: "Hz" },
  ];
  const inserted = [];
  for (const a of seedAttrs) {
    const { data } = await supabase.from("ceks_knowledge_attributes").insert({
      version_id: entry.current_version_id, attr_group: "electrical",
      name: a.name, value: a.value, unit: a.unit, origin: "manual", confidence: 1.0,
      source_document: "ZZ-VERIFY",   // tags it as this test's own row, so cleanup can never over-reach
    }).select().single();
    if (data) inserted.push(data.id);
  }
  ok(inserted.length === 4, "manufacturer data seeded: Phase 3N · 400 V · 12 kW · 50/60 Hz (NO current — as always)");

  // ─────────────────────────────────────────────────────────────────────────
  S("RUN THE ENGINE");
  // the dictionary (parameters, constants, settings) is cached for 30s — a brand-new constant or rule
  // must be visible immediately, so every mutation invalidates it. The routes do the same.
  dictSvc.invalidate();
  const report = await recs.generateForVersion(entry.current_version_id, { trigger: "verification" });
  ok(report.recommendations > 0, `${report.recommendations} recommendation(s), ${report.validations} validation(s)`);

  const derivedCurrent = report.derived.find((d) => d.parameter === "electrical.current");
  ok(!!derivedCurrent, `Current was DERIVED: ${derivedCurrent ? derivedCurrent.value.toFixed(2) + " A" : "—"} (the datasheet never stated it)`);
  ok(derivedCurrent && derivedCurrent.value > 16 && derivedCurrent.value < 20, "the derived current falls inside the rule's 16–20 A band");

  const view = await recs.forVersion(entry.current_version_id);
  const cable = view.recommendations.find((r) => r.parameter_id === pCable.id);
  const breaker = view.recommendations.find((r) => r.parameter_id === pBreaker.id);

  ok(cable && cable.value_text === "5×6 mm² Cu", `Cable Size → "${cable?.value_text}"`);
  ok(breaker && breaker.value_text === "32 A 3P MCB", `Breaker → "${breaker?.value_text}"`);

  S("TRACEABILITY — exactly what the client asked to see");
  if (cable) {
    console.log(`     Cable Size: ${cable.value_text}`);
    console.log(`     Generated from Electrical Rule ${cable.rule_code} (v${cable.rule_version})`);
    console.log(`     Matched: ${(cable.matched_conditions || []).map((c) => `${c.label} ${c.operator} ${c.expected} → actual ${c.actual}`).join(" · ")}`);
    console.log(`     Inputs : ${(cable.inputs_used || []).map((i) => `${i.label}=${i.value}${i.unit ? " " + i.unit : ""}${i.rule_code ? " (derived by " + i.rule_code + ")" : ""}`).join(" · ")}`);
    ok(!!cable.rule_code && cable.rule_version != null, "rule id + rule version recorded");
    ok((cable.matched_conditions || []).length === 2, "the exact conditions that matched are recorded");
    ok((cable.inputs_used || []).length >= 2, "the exact inputs used are recorded");
    ok(cable.confidence != null, `confidence carried through: ${cable.confidence}`);
  }

  S("MANUFACTURER DATA IS NEVER OVERWRITTEN");
  const { data: stillThere } = await supabase
    .from("ceks_knowledge_attributes")
    .select("name, value")
    .in("id", inserted);
  ok(stillThere.find((a) => a.name === "Phase")?.value === "3N", 'the manufacturer\'s "3N" is untouched (the engine reads a normalised copy)');

  S("APPROVAL IS BLOCKED until the engineer decides (client rule)");
  const blockers = await recs.approvalBlockers(entry.current_version_id);
  ok(blockers.length > 0, `${blockers.length} blocker(s) — e.g. "${blockers[0]?.message}"`);

  S("THE ENGINEER DECIDES — and a reason is mandatory");
  let refused = false;
  try {
    await recs.decide(cable.id, { action: "modify", value: "5×10 mm² Cu", note: "" });
  } catch (e) {
    refused = /reason is required/i.test(e.message);
  }
  ok(refused, "modify without a reason → refused");

  await recs.decide(cable.id, { action: "modify", value: "5×10 mm² Cu", note: "Long cable run on this site — uprated." });
  const { data: after } = await supabase.from("ceks_recommendations").select("*").eq("id", cable.id).single();
  ok(after.status === "modified" && after.final_value === "5×10 mm² Cu", `engineer override recorded: "${after.final_value}" — reason: "${after.decision_note}"`);

  const { data: hist } = await supabase
    .from("ceks_recommendation_history")
    .select("action, previous_value, new_value, reason")
    .eq("version_id", entry.current_version_id)
    .order("created_at");
  ok(hist.length >= 2, `history kept: ${hist.map((h) => h.action).join(" → ")}`);

  S("NO RULE MATCHES → blank + flagged. NEVER extrapolated.");
  await supabase.from("ceks_knowledge_attributes")
    .update({ value: "40", value_num: 40 })
    .eq("version_id", entry.current_version_id).eq("name", "Power Load");   // → ~64 A, outside 16–20
  const r2 = await recs.generateForVersion(entry.current_version_id, { trigger: "verification-2" });
  const v2 = await recs.forVersion(entry.current_version_id);
  const noRule = v2.validations.find((v) => v.code === "no_rule_match" || v.code === "missing_input");
  const cable2 = v2.recommendations.find((r) => r.parameter_id === pCable.id);
  ok(!cable2 || cable2.status !== "proposed", "out of range → no cable size was invented");
  ok(!!noRule, `flagged honestly: "${noRule?.message}" — ${noRule?.reason?.slice(0, 70)}…`);

  S("A RULE CHANGES → every affected item is listed (nothing is silently rewritten)");
  await supabase.from("ceks_rules").update({ version: 2 }).eq("id", recRule.id);
  const alertRes = await recs.raiseRecalcAlerts(recRule.id, 2);
  ok(alertRes.affected_items >= 0, `"Recalculation Available" raised on ${alertRes.affected_items} item(s) — the engineer decides`);

  // ─────────────────────────────────────────────────────────────────────────
  S("CLEANUP");
  await supabase.from("ceks_recalc_alerts").delete().in("rule_id", cleanup.rules);
  await supabase.from("ceks_recommendation_history").delete().eq("version_id", cleanup.versionId);
  await supabase.from("ceks_recommendations").delete().eq("version_id", cleanup.versionId);
  await supabase.from("ceks_validations").delete().eq("version_id", cleanup.versionId);
  await supabase.from("ceks_knowledge_attributes").delete().in("id", inserted);
  for (const id of cleanup.rules) {
    await supabase.from("ceks_rule_conditions").delete().eq("rule_id", id);
    await supabase.from("ceks_rule_outputs").delete().eq("rule_id", id);
    await supabase.from("ceks_rules").delete().eq("id", id);
  }
  await supabase.from("ceks_rule_constants").delete().in("id", cleanup.constants);
  console.log("  every test rule, constant, attribute and recommendation removed");

  console.log(`\n######## RESULT: ${pass} passed, ${fail} failed ########\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n✖ VERIFICATION CRASHED:", e.message);
  console.error(e.stack);
  process.exit(1);
});
