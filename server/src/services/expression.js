/**
 * SAFE EXPRESSION EVALUATOR.
 *
 * CULINOVA's derivation formulas (Current from Power/Voltage/Phase, with power factor and
 * efficiency) are DATA — an engineer types them into the Rule Management Panel, and they are
 * reviewed like any other rule. Nothing is hardcoded here. This file only knows how to
 * EVALUATE a formula; it never contains one.
 *
 * It is a hand-written parser, NOT `eval` / `new Function`. A rule is authored by a user, so
 * running it through the JS engine would be remote code execution against our own server.
 *
 * Supported:
 *   numbers, + - * / % ^, parentheses, unary minus
 *   identifiers  → parameter keys (electrical.power) or constants (pf, efficiency)
 *   functions    → sqrt min max abs round ceil floor pow log ln exp
 *   comparisons  → < <= > >= == != and a ternary  cond ? a : b   (for "if 3-phase then … else …")
 *   booleans     → true / false, and / or / not
 *
 * Anything else is a syntax error, reported with the position — the Rule Panel shows it to the
 * author immediately, so a bad formula can never reach an approved rule.
 */

// Null-prototype: a formula that names an inherited property ("constructor", "hasOwnProperty")
// must be an UNKNOWN function, not a silent hit on Object.prototype that only fails at run time.
const FUNCTIONS = Object.assign(Object.create(null), {
  sqrt: (x) => Math.sqrt(x),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  abs: (x) => Math.abs(x),
  round: (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f },
  ceil: (x) => Math.ceil(x),
  floor: (x) => Math.floor(x),
  pow: (x, y) => x ** y,
  log: (x) => Math.log10(x),
  ln: (x) => Math.log(x),
  exp: (x) => Math.exp(x),
});
const hasFn = (name) => Object.prototype.hasOwnProperty.call(FUNCTIONS, name);

// Every arithmetic result must be a finite number. An engineering value of Infinity or NaN
// (overflow, 1e308*1e308, a bad input) must fail LOUDLY, never persist as a recommendation.
function finite(v, opLabel) {
  if (!Number.isFinite(v)) throw new ExprError(`the result of ${opLabel} is not a finite number`);
  return v;
}

// The keywords the language reserves. Used so `and`/`or`/`not` are operators, never identifiers.
const isKeyword = (tok, kw) => tok.t === "ident" && tok.v.toLowerCase() === kw;

// ── tokenizer ────────────────────────────────────────────────────────────────
function tokenize(src) {
  const toks = [];
  let i = 0;
  const isDigit = (c) => c >= "0" && c <= "9";
  const isIdentStart = (c) => /[A-Za-z_]/.test(c);
  const isIdentChar = (c) => /[A-Za-z0-9_.]/.test(c); // parameter keys carry a dot

  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      let j = i;
      while (j < src.length && (isDigit(src[j]) || src[j] === ".")) j++;
      const raw = src.slice(i, j);
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ExprError(`"${raw}" is not a number`, i);
      toks.push({ t: "num", v: n, i });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdentChar(src[j])) j++;
      toks.push({ t: "ident", v: src.slice(i, j), i });
      i = j;
      continue;
    }

    // two-character operators first
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) {
      toks.push({ t: "op", v: two, i });
      i += 2;
      continue;
    }
    if ("+-*/%^()<>?:,".includes(c)) {
      toks.push({ t: "op", v: c, i });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}"`, i);
  }
  toks.push({ t: "eof", i: src.length });
  return toks;
}

class ExprError extends Error {
  constructor(message, pos) {
    super(pos != null ? `${message} (at position ${pos})` : message);
    this.name = "ExpressionError";
    this.position = pos;
  }
}

// ── parser (precedence climbing) → AST ───────────────────────────────────────
function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (v) => {
    const t = toks[p];
    if (t.t !== "op" || t.v !== v) throw new ExprError(`Expected "${v}"`, t.i);
    p++;
  };

  // ternary  cond ? a : b   (lowest precedence)
  function parseTernary() {
    const cond = parseOr();
    if (peek().t === "op" && peek().v === "?") {
      next();
      const a = parseTernary();
      expect(":");
      const b = parseTernary();
      return { k: "cond", cond, a, b };
    }
    return cond;
  }
  function parseOr() {
    let left = parseAnd();
    // `||` and the `or` keyword are the same operator
    while ((peek().t === "op" && peek().v === "||") || isKeyword(peek(), "or")) { next(); left = { k: "bin", op: "||", l: left, r: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseCmp();
    while ((peek().t === "op" && peek().v === "&&") || isKeyword(peek(), "and")) { next(); left = { k: "bin", op: "&&", l: left, r: parseCmp() }; }
    return left;
  }
  const CMP_OPS = ["<", "<=", ">", ">=", "==", "!="];
  function parseCmp() {
    const left = parseAdd();
    if (peek().t === "op" && CMP_OPS.includes(peek().v)) {
      const op = next().v;
      const node = { k: "bin", op, l: left, r: parseAdd() };
      // REJECT chained comparisons. `16 <= x <= 20` is left-associative in this grammar, so it would
      // evaluate as `(16 <= x) <= 20` — a 0/1 compared to 20 — which is ALWAYS true, silently making a
      // range check match every value. An author almost always means a conjunction, so demand it:
      if (peek().t === "op" && CMP_OPS.includes(peek().v)) {
        throw new ExprError('Chained comparison is not allowed. Write it with "&&", e.g. "16 <= x && x <= 20"', peek().i);
      }
      return node;
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = next().v;
      left = { k: "bin", op, l: left, r: parseMul() };
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek().t === "op" && ["*", "/", "%"].includes(peek().v)) {
      const op = next().v;
      left = { k: "bin", op, l: left, r: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    const t = peek();
    if (t.t === "op" && (t.v === "-" || t.v === "+")) { next(); return { k: "un", op: t.v, e: parseUnary() }; }
    if (t.t === "ident" && t.v.toLowerCase() === "not") { next(); return { k: "un", op: "!", e: parseUnary() }; }
    return parsePow();
  }
  function parsePow() {
    const base = parseAtom();
    if (peek().t === "op" && peek().v === "^") { next(); return { k: "bin", op: "^", l: base, r: parseUnary() }; }
    return base;
  }
  function parseAtom() {
    const t = next();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "op" && t.v === "(") { const e = parseTernary(); expect(")"); return e; }
    if (t.t === "ident") {
      const lower = t.v.toLowerCase();
      if (lower === "true") return { k: "num", v: 1 };
      if (lower === "false") return { k: "num", v: 0 };
      // and/or/not are operators; reaching them here means they were used where a value was expected
      if (lower === "and" || lower === "or" || lower === "not") {
        throw new ExprError(`"${t.v}" is an operator and needs a value on each side`, t.i);
      }
      // function call?
      if (peek().t === "op" && peek().v === "(") {
        next();
        const args = [];
        if (!(peek().t === "op" && peek().v === ")")) {
          args.push(parseTernary());
          while (peek().t === "op" && peek().v === ",") { next(); args.push(parseTernary()); }
        }
        expect(")");
        if (!hasFn(lower)) throw new ExprError(`Unknown function "${t.v}". Available: ${Object.keys(FUNCTIONS).join(", ")}`, t.i);
        return { k: "call", fn: lower, args };
      }
      return { k: "var", name: t.v };
    }
    throw new ExprError("Unexpected end of expression", t.i);
  }

  const ast = parseTernary();
  if (peek().t !== "eof") throw new ExprError(`Unexpected "${peek().v}"`, peek().i);
  return ast;
}

// ── evaluation ───────────────────────────────────────────────────────────────
function evalAst(node, scope, used) {
  switch (node.k) {
    case "num":
      return node.v;
    case "var": {
      const key = node.name;
      // exact key, then a case-insensitive fallback (authors type "PF" or "pf")
      let v = Object.prototype.hasOwnProperty.call(scope, key) ? scope[key] : undefined;
      if (v === undefined) {
        const hit = Object.keys(scope).find((k) => k.toLowerCase() === key.toLowerCase());
        if (hit) v = scope[hit];
      }
      if (v === undefined || v === null) {
        const e = new ExprError(`"${key}" has no value`);
        e.missing = key; // the caller turns this into a "missing input" validation, never a guess
        throw e;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) {
        const e = new ExprError(`"${key}" is "${v}", which is not a number`);
        e.missing = key;
        throw e;
      }
      if (used) used.add(key);
      return n;
    }
    case "un": {
      const v = evalAst(node.e, scope, used);
      if (node.op === "-") return -v;
      if (node.op === "+") return v;
      if (node.op === "!") return v ? 0 : 1;
      throw new ExprError(`Unknown unary operator ${node.op}`);
    }
    case "bin": {
      const l = evalAst(node.l, scope, used);
      const r = evalAst(node.r, scope, used);
      switch (node.op) {
        case "+": return finite(l + r, '"+"');
        case "-": return finite(l - r, '"-"');
        case "*": return finite(l * r, '"*"');
        case "/":
          if (r === 0) throw new ExprError("Division by zero");
          return finite(l / r, '"/"');
        case "%":
          if (r === 0) throw new ExprError("Division by zero");
          return finite(l % r, '"%"');
        case "^": return finite(l ** r, '"^"');
        case "<": return l < r ? 1 : 0;
        case "<=": return l <= r ? 1 : 0;
        case ">": return l > r ? 1 : 0;
        case ">=": return l >= r ? 1 : 0;
        case "==": return l === r ? 1 : 0;
        case "!=": return l !== r ? 1 : 0;
        case "&&": return l && r ? 1 : 0;
        case "||": return l || r ? 1 : 0;
        default: throw new ExprError(`Unknown operator ${node.op}`);
      }
    }
    case "cond":
      return evalAst(node.cond, scope, used) ? evalAst(node.a, scope, used) : evalAst(node.b, scope, used);
    case "call": {
      if (!hasFn(node.fn)) throw new ExprError(`Unknown function "${node.fn}"`);
      const args = node.args.map((a) => evalAst(a, scope, used));
      const out = FUNCTIONS[node.fn](...args);
      if (!Number.isFinite(out)) throw new ExprError(`${node.fn}() produced a non-finite result`);
      return out;
    }
    default:
      throw new ExprError(`Unknown node ${node.k}`);
  }
}

/**
 * Evaluate a formula.
 *   evaluate("electrical.power * 1000 / (sqrt(3) * electrical.voltage * pf)", scope)
 *
 * scope = { 'electrical.power': 24, 'electrical.voltage': 400, pf: 0.9 }
 *
 * Returns { ok, value, used, error, missing }.
 * NEVER throws for a missing input — it reports it, so the caller can raise a
 * "missing information" validation instead of guessing a number.
 */
function evaluate(expression, scope = {}) {
  const used = new Set();
  try {
    const ast = parse(String(expression));
    const value = evalAst(ast, scope, used);
    return { ok: true, value, used: [...used] };
  } catch (e) {
    return {
      ok: false,
      value: null,
      used: [...used],
      error: e.message,
      missing: e.missing || null,
    };
  }
}

/** Parse-only check, for the Rule Panel: is this formula even valid? */
function validate(expression) {
  try {
    parse(String(expression));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message, position: e.position ?? null };
  }
}

/** Every identifier a formula depends on — the Rule Panel shows the author what it needs. */
function dependencies(expression) {
  const out = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.k === "var") out.add(n.name);
    for (const k of ["l", "r", "e", "cond", "a", "b"]) if (n[k]) walk(n[k]);
    if (n.args) n.args.forEach(walk);
  };
  try {
    walk(parse(String(expression)));
    return [...out];
  } catch {
    return [];
  }
}

module.exports = { evaluate, validate, dependencies, FUNCTIONS: Object.keys(FUNCTIONS) };
