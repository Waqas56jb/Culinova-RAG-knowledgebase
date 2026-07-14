/**
 * CATEGORY ENGINEERING PROFILE import.
 *
 * Ingests the CULINOVA Engineering Standards workbooks (one row per equipment category) LOSSLESSLY:
 * every cell is preserved verbatim as raw_value, and classified by the directive vocabulary that
 * literally appears in the files. Nothing is fabricated — a reference to a discipline rule table that
 * has not been provided yet, or an "EOS Calculation" whose formula is not in the file, is stored and
 * flagged `pending`, never resolved into an invented value.
 *
 * See db/migrations/008_category_profiles.sql for the directive semantics.
 */
const XLSX = require("xlsx");
const { supabase } = require("../config/supabase");
const dictSvc = require("./params");

const clean = (v) => (v == null ? null : String(v).trim() || null);
const nowIso = () => new Date().toISOString();

// Header → identity field. The rest of the columns become classified attributes.
const IDENTITY = {
  code: ["rule id"],
  category_name: ["equipment category"],
  family: ["equipment family"],
  engineering_group: ["engineering group"],
  classifier: ["heat source", "installation type"],
  approval: ["engineer approval required"],
  status: ["status"],
  version: ["version"],
  commissioning: ["commissioning checklist"],
  notes: ["engineering notes"],
};

/**
 * Classify ONE cell into a directive. Grounded entirely in the literal tokens the client used; order
 * matters (a sourcing chain ending in ASHRAE is a calculation, not "manufacturer").
 */
function classifyCell(value) {
  const v = clean(value);
  if (!v) return null;

  if (/^n\s*\/?\s*a$/i.test(v)) return { directive: "not_applicable", detail: null, pending: false };

  const ref = /^culinova\s+(.+?)\s+rules?$/i.exec(v);
  if (ref) return { directive: "culinova_rule", detail: ref[1].trim().toLowerCase(), pending: true };

  // calculation directive: explicit, ASHRAE-based, or a "source → source" chain
  if (/^eos\s+calculation$/i.test(v) || /ashrae/i.test(v) || v.includes("→")) {
    return { directive: "calculation", detail: v, pending: true };
  }

  if (/^manufacturer/i.test(v)) {
    const detail = /culinova/i.test(v) ? "manufacturer_or_culinova" : /depend/i.test(v) ? "dependent" : null;
    return { directive: "manufacturer", detail, pending: false };
  }

  // policy flags first, so "Yes / No" is a policy toggle rather than an options list
  if (/^(yes|no|required|recommended|optional|not\s+required)\b/i.test(v)) {
    return { directive: "policy", detail: v, pending: false };
  }

  // an allowed-values list the manufacturer chooses from
  if (v.includes(" / ")) return { directive: "options", detail: v, pending: false };

  // a concrete CULINOVA value ("1000 mm", "Type I")
  return { directive: "fixed", detail: v, pending: false };
}

function readSheet(wb, sheetName) {
  const name = sheetName || wb.SheetNames[0]; // the standards sheet is first; README is second
  const ws = wb.Sheets[name];
  if (!ws) throw Object.assign(new Error(`Sheet "${name}" not found.`), { status: 422 });
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  if (rows.length < 2) throw Object.assign(new Error("The standards sheet has no data rows."), { status: 422 });
  return { name, headers: (rows[0] || []).map((h) => clean(h) || ""), rows: rows.slice(1) };
}

/** Map header → identity key, and mark which columns are identity (not attributes). */
function planColumns(headers) {
  const identityIndex = {};
  const identityCols = new Set();
  headers.forEach((h, i) => {
    const lower = String(h).toLowerCase();
    for (const [key, names] of Object.entries(IDENTITY)) {
      if (names.includes(lower)) { identityIndex[key] = i; identityCols.add(i); }
    }
  });
  return { identityIndex, identityCols };
}

function buildProfile(row, identityIndex, domain, sourceFile) {
  const at = (k) => (identityIndex[k] != null ? clean(row[identityIndex[k]]) : null);
  const statusRaw = at("status");
  return {
    domain,
    code: at("code") || at("category_name"),
    category_name: at("category_name") || at("code"),
    family: at("family"),
    engineering_group: at("engineering_group"),
    classifier: at("classifier"),
    engineer_approval_required: /^(y|yes|true|required)$/i.test(at("approval") || ""),
    status: statusRaw && /approv/i.test(statusRaw) ? "approved" : (statusRaw || "draft").toLowerCase(),
    version: at("version"),
    commissioning_checklist: at("commissioning"),
    notes: at("notes"),
    source_file: sourceFile,
  };
}

async function buildAttributes(row, headers, identityCols, dict) {
  const attrs = [];
  for (let i = 0; i < headers.length; i++) {
    if (identityCols.has(i)) continue;
    const label = headers[i];
    if (!label) continue;
    const cls = classifyCell(row[i]);
    if (!cls) continue; // blank cell
    const param = dictSvc.resolveParameter(dict, label); // best-effort dictionary linkage; may be null
    attrs.push({
      column_index: i,
      column_label: label,
      parameter_id: param ? param.id : null,
      directive: cls.directive,
      directive_detail: cls.detail,
      pending: cls.pending,
      raw_value: clean(row[i]),
      sort_order: i,
    });
  }
  return attrs;
}

/** Show exactly what an import would create — writes nothing. */
async function preview(wb, { domain, sheet = null } = {}) {
  if (!domain) throw Object.assign(new Error("Choose the domain (e.g. cooking / refrigeration)."), { status: 422 });
  const dict = await dictSvc.load(true);
  const { headers, rows } = readSheet(wb, sheet);
  const { identityIndex, identityCols } = planColumns(headers);

  const summary = { domain, columns: headers.length, categories: rows.length, by_directive: {}, pending_examples: [], sample: [] };
  for (const row of rows) {
    const profile = buildProfile(row, identityIndex, domain, null);
    if (!profile.code && !profile.category_name) continue;
    const attrs = await buildAttributes(row, headers, identityCols, dict);
    for (const a of attrs) {
      summary.by_directive[a.directive] = (summary.by_directive[a.directive] || 0) + 1;
      if (a.pending && summary.pending_examples.length < 12) {
        summary.pending_examples.push({ category: profile.category_name, attribute: a.column_label, value: a.raw_value, kind: a.directive });
      }
    }
    if (summary.sample.length < 3) {
      summary.sample.push({ code: profile.code, category: profile.category_name, attributes: attrs.length });
    }
  }
  return summary;
}

/** Commit the import (idempotent — re-importing a category replaces its attributes). */
async function importWorkbook(wb, { domain, sheet = null, source_file = null, user = null } = {}) {
  if (!domain) throw Object.assign(new Error("Choose the domain (e.g. cooking / refrigeration)."), { status: 422 });
  const dict = await dictSvc.load(true);
  const { headers, rows } = readSheet(wb, sheet);
  const { identityIndex, identityCols } = planColumns(headers);

  const report = { domain, source_file, profiles: 0, updated: 0, attributes: 0, pending_refs: 0, pending_calcs: 0, by_directive: {}, errors: [] };

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const profile = buildProfile(row, identityIndex, domain, source_file);
    if (!profile.code && !profile.category_name) continue;

    // find-or-create by (domain, code) — idempotent, no expression-index upsert needed
    const { data: existing } = await supabase
      .from("ceks_category_profiles")
      .select("id")
      .eq("domain", domain)
      .ilike("code", profile.code)
      .maybeSingle();

    let profileId;
    if (existing) {
      const { error } = await supabase.from("ceks_category_profiles")
        .update({ ...profile, imported_by: user?.id || null, updated_at: nowIso() })
        .eq("id", existing.id);
      if (error) { report.errors.push({ row: r + 2, code: profile.code, error: error.message }); continue; }
      await supabase.from("ceks_category_profile_attributes").delete().eq("profile_id", existing.id);
      profileId = existing.id;
      report.updated++;
    } else {
      const { data: created, error } = await supabase.from("ceks_category_profiles")
        .insert({ ...profile, imported_by: user?.id || null }).select("id").single();
      if (error) { report.errors.push({ row: r + 2, code: profile.code, error: error.message }); continue; }
      profileId = created.id;
      report.profiles++;
    }

    const attrs = await buildAttributes(row, headers, identityCols, dict);
    if (attrs.length) {
      const { error } = await supabase.from("ceks_category_profile_attributes")
        .insert(attrs.map((a) => ({ ...a, profile_id: profileId })));
      if (error) { report.errors.push({ row: r + 2, code: profile.code, error: error.message }); continue; }
    }
    report.attributes += attrs.length;
    for (const a of attrs) {
      report.by_directive[a.directive] = (report.by_directive[a.directive] || 0) + 1;
      if (a.directive === "culinova_rule") report.pending_refs++;
      if (a.directive === "calculation") report.pending_calcs++;
    }
  }
  return report;
}

// ── EQUIPMENT ↔ PROFILE MATCHING (never forced; exact auto-links, the rest is engineer-confirmed) ──

const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Score one profile against an equipment's identity strings. 100 = exact; lower = fuzzy suggestion. */
function scoreProfile(entryStrings, profile) {
  const target = normName(profile.category_name);
  // "Steam Jacketed Kettle / Boiling Pan" → also try each slash-separated alias
  const aliases = [target, ...profile.category_name.split("/").map(normName).filter((x) => x && x !== target)];
  let best = 0, reason = null;
  for (const s of entryStrings) {
    const n = normName(s);
    if (!n) continue;
    for (const t of aliases) {
      if (!t) continue;
      if (n === t) { if (best < 100) { best = 100; reason = `exact match: "${s}" = "${profile.category_name}"`; } }
      else if (t.length >= 4 && n.includes(t)) { if (best < 78) { best = 78; reason = `"${s}" contains "${t}"`; } }
      else if (n.length >= 4 && t.includes(n)) { if (best < 66) { best = 66; reason = `"${profile.category_name}" contains "${s}"`; } }
      else {
        const nt = new Set(n.split(" "));
        const tt = t.split(" ").filter((w) => w.length >= 3);
        const overlap = tt.filter((w) => nt.has(w)).length;
        if (tt.length && overlap === tt.length) { const sc = 55 + overlap * 3; if (best < sc) { best = sc; reason = `all standard terms present in "${s}"`; } }
      }
    }
  }
  return { score: best, reason };
}

/** Rank category profiles for one equipment entry. Returns candidates sorted best-first. */
async function matchCandidates(entry, { domain = null } = {}) {
  let q = supabase.from("ceks_category_profiles").select("id, domain, code, category_name, family, engineering_group");
  if (domain) q = q.eq("domain", domain);
  const { data: profiles } = await q;
  const strings = [entry.equipment_type, entry.category, entry.title, entry.brand].filter(Boolean);
  return (profiles || [])
    .map((p) => ({ ...p, ...scoreProfile(strings, p) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

/**
 * Which profile governs this equipment?
 *   - an explicit engineer/auto link wins
 *   - otherwise an EXACT (score 100) name match may auto-apply
 *   - a fuzzy match is only ever a SUGGESTION; nothing is forced
 */
async function resolveForEntry(entry) {
  if (entry.category_profile_id) {
    const { data: profile } = await supabase.from("ceks_category_profiles").select("*").eq("id", entry.category_profile_id).maybeSingle();
    if (profile) return { profile, match: entry.category_profile_source === "engineer" ? "linked" : "auto", candidates: [] };
  }
  const candidates = await matchCandidates(entry);
  const exact = candidates.find((c) => c.score === 100);
  if (exact) {
    const { data: profile } = await supabase.from("ceks_category_profiles").select("*").eq("id", exact.id).maybeSingle();
    return { profile, match: "exact", candidates };
  }
  return { profile: null, match: candidates.length ? "suggested" : "none", candidates };
}

/** Structure a profile's directives into an actionable engineering view for one equipment. */
function applyProfile(attrs) {
  const out = { requirements: [], manufacturer_sourced: [], pending: [], options: [], notes: [], not_applicable: [] };
  for (const a of attrs || []) {
    const base = { attribute: a.column_label, value: a.raw_value, parameter_key: a.ceks_parameters?.key || null };
    switch (a.directive) {
      case "fixed":
        out.requirements.push({ ...base, kind: "culinova_value" });
        break;
      case "policy":
        out.requirements.push({ ...base, kind: "policy", applies: /^(yes|required|recommended)/i.test(a.raw_value) });
        break;
      case "manufacturer":
        out.manufacturer_sourced.push(base);
        break;
      case "culinova_rule":
        out.pending.push({ ...base, kind: "discipline_rule", discipline: a.directive_detail, needs: `${a.directive_detail} rule table (not yet provided)` });
        break;
      case "calculation":
        out.pending.push({ ...base, kind: "calculation", needs: a.raw_value });
        break;
      case "options":
        out.options.push(base);
        break;
      case "note":
        out.notes.push(base);
        break;
      case "not_applicable":
        out.not_applicable.push(base);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * On ingest, if the equipment's type EXACTLY matches a standard category, persist the link so it
 * shows as governed in lists (source='auto'). A fuzzy match is never auto-linked — the engineer
 * confirms those. Never overwrites an engineer's explicit link.
 */
async function autoLink(entryId) {
  const { data: entry } = await supabase
    .from("ceks_knowledge_entries")
    .select("id, title, brand, category, equipment_type, category_profile_id, category_profile_source")
    .eq("id", entryId)
    .maybeSingle();
  if (!entry || entry.category_profile_id) return null; // already linked (auto or engineer) → leave it
  const candidates = await matchCandidates(entry);
  const exact = candidates.find((c) => c.score === 100);
  if (!exact) return null;
  await supabase
    .from("ceks_knowledge_entries")
    .update({ category_profile_id: exact.id, category_profile_source: "auto" })
    .eq("id", entryId);
  return { profile_id: exact.id, category_name: exact.category_name };
}

/** The full applied view: resolve the profile for an entry and structure it. */
async function forEntry(entry) {
  const { profile, match, candidates } = await resolveForEntry(entry);
  if (!profile) return { linked: false, match, candidates, profile: null, applied: null };
  const { data: attrs } = await supabase
    .from("ceks_category_profile_attributes")
    .select("*, ceks_parameters(key,label)")
    .eq("profile_id", profile.id)
    .order("sort_order");
  return { linked: true, match, candidates, profile, applied: applyProfile(attrs || []) };
}

module.exports = {
  classifyCell, preview, importWorkbook, readSheet, planColumns,
  matchCandidates, resolveForEntry, applyProfile, forEntry, autoLink,
};
