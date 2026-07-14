/**
 * Condition evaluation — the heart of "does this rule apply to this equipment?".
 * These pin the boundary semantics the client's range tables depend on, and the safety rules:
 * a partial range overlap is NOT a match, and a value stated two different ways is NOT usable.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { evalCondition } = require("../src/services/ruleEngine");

// a minimal dict + scope, the shape buildScope produces
function ctx(param, fact) {
  const dict = {
    paramById: new Map([[param.id, param]]),
    paramByKey: new Map([[param.key, param]]),
    conversions: new Map(),
  };
  const scope = fact ? { [param.key]: { key: param.key, label: param.label, data_type: param.data_type, ...fact } } : {};
  return { dict, scope };
}
const CURRENT = { id: "c1", key: "electrical.current", label: "Current", data_type: "number", canonical_unit: "A" };
const cond = (o) => ({ parameter_id: "c1", ...o });

test("between is INCLUSIVE on both ends (16–20 A range table)", () => {
  const at = (n) => {
    const { dict, scope } = ctx(CURRENT, { num: n, min: null, max: null });
    return evalCondition(dict, cond({ operator: "between", value_min: 16, value_max: 20 }), scope).matched;
  };
  assert.equal(at(16), true);   // lower bound included
  assert.equal(at(20), true);   // upper bound included
  assert.equal(at(18), true);
  assert.equal(at(15.9), false);
  assert.equal(at(20.1), false);
});

test("a range fact only PARTLY inside the condition is ambiguous, not a match", () => {
  const { dict, scope } = ctx(CURRENT, { num: null, min: 18, max: 25 }); // straddles 20
  const r = evalCondition(dict, cond({ operator: "between", value_min: 16, value_max: 20 }), scope);
  assert.equal(r.matched, false);
  assert.equal(r.ambiguous, true);
});

test("a range fact fully inside the condition matches", () => {
  const { dict, scope } = ctx(CURRENT, { num: null, min: 17, max: 19 });
  const r = evalCondition(dict, cond({ operator: "between", value_min: 16, value_max: 20 }), scope);
  assert.equal(r.matched, true);
});

test("gte / lte boundaries", () => {
  const check = (op, v, factNum) => {
    const { dict, scope } = ctx(CURRENT, { num: factNum, min: null, max: null });
    return evalCondition(dict, cond({ operator: op, value_num: v }), scope).matched;
  };
  assert.equal(check("gte", 16, 16), true);
  assert.equal(check("gte", 16, 15), false);
  assert.equal(check("lte", 20, 20), true);
  assert.equal(check("lte", 20, 21), false);
  assert.equal(check("gt", 16, 16), false);
});

test("a missing fact is reported as missing, never matched", () => {
  const { dict, scope } = ctx(CURRENT, null);
  const r = evalCondition(dict, cond({ operator: "eq", value_num: 16 }), scope);
  assert.equal(r.matched, false);
  assert.equal(r.missing, "electrical.current");
});

test("an ambiguous (multi-valued) fact does not match — engineer must choose", () => {
  const { dict, scope } = ctx(CURRENT, { num: 16, ambiguous: true, candidates: ["16 A", "20 A"] });
  const r = evalCondition(dict, cond({ operator: "eq", value_num: 16 }), scope);
  assert.equal(r.matched, false);
  assert.equal(r.multiValue, true);
});

test("enum equality is case-insensitive on the canonical value", () => {
  const PHASE = { id: "ph", key: "electrical.phase", label: "Phase", data_type: "enum" };
  const dict = { paramById: new Map([["ph", PHASE]]), paramByKey: new Map([["electrical.phase", PHASE]]), conversions: new Map() };
  const scope = { "electrical.phase": { key: "electrical.phase", label: "Phase", data_type: "enum", value: "3-Phase" } };
  const r = evalCondition(dict, { parameter_id: "ph", operator: "eq", value_text: "3-phase" }, scope);
  assert.equal(r.matched, true);
});
