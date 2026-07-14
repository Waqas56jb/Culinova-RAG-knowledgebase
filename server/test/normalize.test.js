/**
 * Value normalisation — turning free-text datasheet values into comparable numbers WITHOUT ever
 * changing what the manufacturer meant. These tests pin the edge cases the live data actually holds.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const norm = require("../src/services/normalize");

test("parseNumeric — ranges", () => {
  assert.deepEqual(pick(norm.parseNumeric("380...415")), { num: null, min: 380, max: 415 });
  assert.deepEqual(pick(norm.parseNumeric("380-415")), { num: null, min: 380, max: 415 });
  assert.deepEqual(pick(norm.parseNumeric("50/60")), { num: null, min: 50, max: 60 });
  assert.deepEqual(pick(norm.parseNumeric("150 to 600")), { num: null, min: 150, max: 600 });
});

test("parseNumeric — bounds are NOT read as exact values", () => {
  // the whole point: "≤ 1000" must NOT become num=1000
  const le = norm.parseNumeric("≤ 1000");
  assert.equal(le.num, null);
  assert.equal(le.max, 1000);
  assert.equal(le.min, null);
  assert.equal(le.bound, "lte");

  const ge = norm.parseNumeric("≥ 200");
  assert.equal(ge.num, null);
  assert.equal(ge.min, 200);
  assert.equal(ge.max, null);
  assert.equal(ge.bound, "gte");

  assert.equal(norm.parseNumeric("< 50").bound, "lt");
  assert.equal(norm.parseNumeric("> 50").bound, "gt");
});

test("parseNumeric — tolerance band", () => {
  const t = norm.parseNumeric("230 ± 10");
  assert.equal(t.min, 220);
  assert.equal(t.max, 240);
  assert.equal(t.bound, "tolerance");
});

test("parseNumeric — plain numbers, comma decimal, unit tail, approx", () => {
  assert.equal(norm.parseNumeric("24.0 kW").num, 24);
  assert.equal(norm.parseNumeric("24.0 kW").tail, "kW");
  assert.equal(norm.parseNumeric("2,5").num, 2.5);
  assert.equal(norm.parseNumeric("~50").num, 50);
  assert.equal(norm.parseNumeric("~50").bound, "approx");
  assert.equal(norm.parseNumeric("nonsense").num, null);
});

test("normalizeAttribute — an upper bound is stored as a max, with an honest note", () => {
  const p = { id: "p1", key: "hydraulic.pressure", label: "Pressure", data_type: "number", canonical_unit: "kPa" };
  const dict = fakeDict(p, { "w|kw": { factor: 0.001, offset: 0 } });
  const out = norm.normalizeAttribute(dict, { name: "Pressure", value: "≤ 1000", unit: "kPa" });
  assert.equal(out.parameter_id, "p1");
  assert.equal(out.value_max, 1000);
  assert.equal(out.value_num, null);        // NOT an exact 1000
  assert.match(out.normalize_note, /upper bound/i);
});

test("normalizeAttribute — a one-sided bound does not trip the unit-conversion check", () => {
  const p = { id: "p1", key: "electrical.power", label: "Power", data_type: "number", canonical_unit: "kW" };
  const dict = fakeDict(p, { "w|kw": { factor: 0.001, offset: 0 } });
  // "≥ 5000 W" → lower bound 5000 W → 5 kW min, no spurious "no conversion" error
  const out = norm.normalizeAttribute(dict, { name: "Power", value: "≥ 5000", unit: "W" });
  assert.equal(out.value_min, 5);
  assert.equal(out.value_max, null);
  assert.equal(out.unit_canonical, "kW");
});

test("reprOf distinguishes different values (drives ambiguity detection)", () => {
  assert.notEqual(norm.reprOf({ value_num: 230 }), norm.reprOf({ value_num: 400 }));
  assert.equal(norm.reprOf({ value_num: 230 }), norm.reprOf({ value_num: 230 }));
  assert.notEqual(norm.reprOf({ value_canonical: "1-Phase" }), norm.reprOf({ value_canonical: "3-Phase" }));
});

// ── helpers ──────────────────────────────────────────────────────────────────
const pick = (r) => ({ num: r.num, min: r.min, max: r.max });
function fakeDict(param, conversions = {}) {
  return {
    aliasExact: new Map([[param.label.toLowerCase(), param]]),
    aliasFuzzy: [],
    paramById: new Map([[param.id, param]]),
    paramByKey: new Map([[param.key, param]]),
    conversions: new Map(Object.entries(conversions)),
    valueNorms: new Map(),
    constants: {},
    settings: {},
  };
}
