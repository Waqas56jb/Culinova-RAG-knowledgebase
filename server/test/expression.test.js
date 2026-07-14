/**
 * Expression evaluator — the language rule authors write derivation formulas in.
 * These tests pin the SEMANTICS: precedence, the derivation formula the client's example needs,
 * and every failure mode that must fail LOUDLY rather than return a wrong engineering number.
 *
 *   node --test        (or: npm test)
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const expr = require("../src/services/expression");

const val = (s, scope) => expr.evaluate(s, scope);

test("arithmetic precedence and parentheses", () => {
  assert.equal(val("2 + 3 * 4").value, 14);
  assert.equal(val("(2 + 3) * 4").value, 20);
  assert.equal(val("2 ^ 3 ^ 2").value, 512); // right-associative
  assert.equal(val("10 % 3").value, 1);
  assert.equal(val("-5 + 2").value, -3);
});

test("functions", () => {
  assert.equal(val("sqrt(16)").value, 4);
  assert.equal(val("min(3, 7, 2)").value, 2);
  assert.equal(val("max(3, 7, 2)").value, 7);
  assert.equal(val("round(3.14159, 2)").value, 3.14);
  assert.equal(val("pow(2, 10)").value, 1024);
  assert.equal(val("abs(-9)").value, 9);
});

test("THE client derivation: Current = P·1000 / (√3 · V · pf)", () => {
  // 12 kW, 400 V, pf 0.9  →  ~19.245 A  (the example the whole engine exists to prove)
  const r = val("power * 1000 / (sqrt(3) * voltage * pf)", { power: 12, voltage: 400, pf: 0.9 });
  assert.ok(r.ok);
  assert.ok(Math.abs(r.value - 19.245) < 0.01, `got ${r.value}`);
  assert.deepEqual(r.used.sort(), ["pf", "power", "voltage"]);
});

test("ternary and single comparisons", () => {
  assert.equal(val("voltage >= 380 ? 1 : 0", { voltage: 400 }).value, 1);
  assert.equal(val("voltage >= 380 ? 1 : 0", { voltage: 230 }).value, 0);
  assert.equal(val("x == 3 ? 10 : 20", { x: 3 }).value, 10);
});

test("and / or / not keywords are operators (aliases for && || !)", () => {
  assert.equal(val("x > 0 and x < 10", { x: 5 }).value, 1);
  assert.equal(val("x > 0 and x < 10", { x: 50 }).value, 0);
  assert.equal(val("x < 0 or x > 100", { x: 200 }).value, 1);
  assert.equal(val("not (x > 0)", { x: 5 }).value, 0);
});

// ── the CRITICAL fixes: these MUST fail, not return a wrong number ────────────

test("chained comparison is REJECTED (would otherwise always be true)", () => {
  // 16 <= x <= 20 as (16<=x)<=20 is always true → a range check matching everything.
  const r = val("16 <= x <= 20", { x: 999 });
  assert.equal(r.ok, false);
  assert.match(r.error, /chained comparison/i);
  // the correct, explicit form works:
  assert.equal(val("16 <= x && x <= 20", { x: 18 }).value, 1);
  assert.equal(val("16 <= x && x <= 20", { x: 25 }).value, 0);
});

test("non-finite results fail loudly (never persist Infinity/NaN)", () => {
  assert.equal(val("1e308 * 1e308").ok, false);        // overflow → Infinity
  assert.equal(val("pow(10, 1000)").ok, false);         // Infinity from a function
  assert.equal(val("sqrt(-1)").ok, false);              // NaN
  assert.equal(val("1 / 0", {}).ok, false);             // division by zero
});

test("prototype-chain identifiers are UNKNOWN functions, not silent hits", () => {
  assert.equal(val("constructor(1)").ok, false);
  assert.equal(val("hasOwnProperty(1)").ok, false);
  assert.equal(val("toString(1)").ok, false);
  assert.match(val("constructor(1)").error, /unknown function/i);
});

test("missing input is reported, never guessed", () => {
  const r = val("power / voltage", { power: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.missing, "voltage");
});

test("validate() catches bad formulas at author time", () => {
  assert.equal(expr.validate("power * 2").ok, true);
  assert.equal(expr.validate("power * ").ok, false);
  assert.equal(expr.validate("1 < 2 < 3").ok, false);      // chained
  assert.equal(expr.validate("nope(1)").ok, false);        // unknown fn
});

test("dependencies() lists real identifiers only (not keywords)", () => {
  assert.deepEqual(expr.dependencies("a + b * sqrt(c)").sort(), ["a", "b", "c"]);
  // 'and'/'or' must NOT show up as variables
  assert.deepEqual(expr.dependencies("x > 0 and y < 1").sort(), ["x", "y"]);
});
