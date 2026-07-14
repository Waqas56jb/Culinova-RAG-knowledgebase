import React, { useEffect, useMemo, useState } from "react";
import { api, session } from "../api.js";
import { InlineLoader, PageLoader } from "../components/Loader.jsx";
import { EmptyState, PageHero, PagePanel, StatPill } from "../components/PageShell.jsx";

const STATUS_LABEL = { draft: "Draft", under_review: "Under Review", approved: "Approved", archived: "Archived" };

// Every directive a workbook column can be classified as. `pending` marks the two
// kinds that still await the client's discipline rule tables / formulas.
const DIRECTIVES = [
  { key: "manufacturer", label: "Manufacturer", hint: "Taken directly from the equipment datasheet." },
  { key: "fixed", label: "Fixed CULINOVA value", hint: "A concrete standard value (e.g. 1000 mm)." },
  { key: "policy", label: "Policy", hint: "A Yes / No / Required decision." },
  { key: "options", label: "Options", hint: "Choose one from a “/”-separated list." },
  { key: "culinova_rule", label: "CULINOVA rule", hint: "References a discipline rule table — not yet provided.", pending: true },
  { key: "calculation", label: "Calculation", hint: "Needs an engineering formula — not yet provided.", pending: true },
  { key: "not_applicable", label: "Not applicable", hint: "Does not apply to this category." },
  { key: "note", label: "Notes", hint: "Reference notes." },
];
const DIRECTIVE_LABEL = Object.fromEntries(DIRECTIVES.map((d) => [d.key, d.label]));
const isPendingDirective = (k) => k === "culinova_rule" || k === "calculation";

const TABS = [
  ["profiles", "Category Profiles"],
  ["import", "Import"],
  ["pending", "Pending Dependencies"],
];

const titleCase = (s) => (s || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const attrCount = (p) => p?.ceks_category_profile_attributes?.[0]?.count ?? 0;

export default function CategoryStandards() {
  const [tab, setTab] = useState("profiles");
  const canImport = session.can("rule.create");

  return (
    <PagePanel accent="sky">
      <PageHero
        accent="sky"
        title="Category Engineering Standards"
        subtitle="The CULINOVA Engineering Standards Library — one profile per equipment category, one directive per requirement."
      />
      <p className="hint">
        Each profile is one equipment <b>category</b> (Gas Range, Fryer, Combi Oven…). Every requirement is a
        <b> directive</b>: sourced from the manufacturer datasheet, a fixed CULINOVA value, a policy, an options list, or
        a <b>pending</b> rule/formula still awaiting the client's discipline rule tables.
      </p>

      <nav className="subtabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      {tab === "profiles" && <Profiles />}
      {tab === "import" && <StandardsImport canImport={canImport} />}
      {tab === "pending" && <PendingDeps />}
    </PagePanel>
  );
}

// ═════════════════════════════════════ PROFILES (list + detail) ══════════════
function Profiles() {
  const [profiles, setProfiles] = useState(null);
  const [domains, setDomains] = useState([]);
  const [domain, setDomain] = useState("");
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setProfiles(null); setError("");
    api.standardsProfiles(domain)
      .then((r) => {
        if (!alive) return;
        const list = r.profiles || [];
        setProfiles(list);
        // seed the domain filter from the first (unfiltered) load
        if (!domain) setDomains([...new Set(list.map((p) => p.domain).filter(Boolean))].sort());
      })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [domain]);

  const grouped = useMemo(() => {
    const g = {};
    (profiles || []).forEach((p) => { (g[p.domain || "—"] = g[p.domain || "—"] || []).push(p); });
    return g;
  }, [profiles]);

  if (openId) return <ProfileDetail id={openId} onBack={() => setOpenId(null)} />;

  if (error) return <div className="group"><div className="alert">{error}</div></div>;
  if (!profiles) return <div className="group"><InlineLoader label="Loading category profiles…" /></div>;

  const total = profiles.length;
  const domainKeys = Object.keys(grouped).sort();

  return (
    <div className="group">
      <div className="filter-row">
        <select value={domain} onChange={(e) => setDomain(e.target.value)}>
          <option value="">All domains</option>
          {domains.map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}
        </select>
        <span className="muted">{total} profile{total === 1 ? "" : "s"}</span>
      </div>

      {!total && <EmptyState icon="📐" title="No category profiles" text="Import a Cooking or Refrigeration workbook to create category profiles." />}

      {domainKeys.map((dk) => (
        <div key={dk} className="group">
          <h2>{titleCase(dk)} <span className="sec-count">{grouped[dk].length} categor{grouped[dk].length === 1 ? "y" : "ies"}</span></h2>
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr><th>Code</th><th>Category</th><th>Family</th><th>Engineering Group</th><th>Classifier</th><th>Status</th><th>Ver.</th><th>Attrs</th><th></th></tr>
              </thead>
              <tbody>
                {grouped[dk].map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.code || "—"}</td>
                    <td>{p.category_name || "—"}</td>
                    <td>{p.family || "—"}</td>
                    <td>{p.engineering_group || "—"}</td>
                    <td>{p.classifier || "—"}</td>
                    <td><span className={"badge " + p.status}>{STATUS_LABEL[p.status] || p.status || "—"}</span></td>
                    <td>v{p.version ?? 1}</td>
                    <td>{attrCount(p)}</td>
                    <td className="rowacts"><button className="btn small ghost" onClick={() => setOpenId(p.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProfileDetail({ id, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    api.standardsProfile(id).then((r) => alive && setData(r)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [id]);

  if (error) return <div className="group"><button className="btn small ghost" onClick={onBack}>← Back to profiles</button><div className="alert">{error}</div></div>;
  if (!data) return <div className="group"><button className="btn small ghost" onClick={onBack}>← Back to profiles</button><PageLoader label="Loading category profile…" /></div>;

  const p = data.profile || {};
  const grouped = data.grouped || {};
  const pending = data.pending || [];
  const checklist = normalizeList(p.commissioning_checklist);

  return (
    <div className="group">
      <button className="btn small ghost" onClick={onBack}>← Back to profiles</button>

      <div className="page-head">
        <h1>{p.category_name || p.code || "Category profile"} {p.status && <span className={"badge big " + p.status}>{STATUS_LABEL[p.status] || p.status}</span>}</h1>
      </div>

      <section className="profile">
        <div className="profile-body">
          <div className="identity">
            <IField label="Code" value={p.code} mono />
            <IField label="Category" value={p.category_name} />
            <IField label="Domain" value={titleCase(p.domain)} />
            <IField label="Family" value={p.family} />
            <IField label="Engineering Group" value={p.engineering_group} />
            <IField label="Classifier" value={p.classifier} />
            <IField label="Version" value={p.version != null ? "v" + p.version : "—"} />
            <IField label="Engineer approval" value={p.engineer_approval_required ? "Required" : "Not required"} />
          </div>
        </div>
      </section>

      {pending.length > 0 && (
        <div className="warn">
          ⚠ {pending.length} requirement{pending.length === 1 ? "" : "s"} on this category are <b>pending</b> — they reference a
          discipline rule table or a formula the client has not provided yet, so no CULINOVA value can be produced for them.
        </div>
      )}

      {DIRECTIVES.map((dir) => {
        const rows = grouped[dir.key] || [];
        if (!rows.length) return null;
        return <DirectiveSection key={dir.key} dir={dir} rows={rows} />;
      })}

      {/* any directive returned that isn't in our known list — never hide data */}
      {Object.keys(grouped).filter((k) => !DIRECTIVE_LABEL[k]).map((k) => (
        <DirectiveSection key={k} dir={{ key: k, label: titleCase(k), pending: isPendingDirective(k) }} rows={grouped[k]} />
      ))}

      {checklist.length > 0 && (
        <div className="group">
          <h2>Commissioning Checklist <span className="sec-count">{checklist.length}</span></h2>
          <ul className="std-checklist">
            {checklist.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}

      {p.notes && (
        <div className="group">
          <h2>Engineering Notes</h2>
          <p className="std-notes">{p.notes}</p>
        </div>
      )}
    </div>
  );
}

function DirectiveSection({ dir, rows }) {
  const pending = !!dir.pending;
  return (
    <div className="group">
      <h2>
        {dir.label} <span className="sec-count">{rows.length}</span>
        {pending && <span className="badge pending" style={{ marginLeft: 8 }}>Pending</span>}
      </h2>
      {dir.hint && <p className="muted" style={{ margin: "0 0 8px" }}>{dir.hint}</p>}
      {pending && (
        <div className="warn">⚠ These await the client's discipline rule tables / formulas — the reference is recorded, but no value is computed yet.</div>
      )}
      <div className="scroll-x">
        <table className="grid">
          <thead>
            <tr><th>Attribute</th><th>Value</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {rows.map((a, i) => {
              const label = a.ceks_parameters?.label || a.column_label || a.ceks_parameters?.key || "—";
              const value = a.raw_value != null && a.raw_value !== "" ? a.raw_value : "—";
              return (
                <tr key={a.id || i} className={a.pending || pending ? "std-pending" : ""}>
                  <td>{label}{(a.pending || pending) && <span className="badge pending" style={{ marginLeft: 8 }}>Pending</span>}</td>
                  <td>{value}</td>
                  <td className="muted">{a.directive_detail || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═════════════════════════════════════ IMPORT ════════════════════════════════
function StandardsImport({ canImport }) {
  const [domain, setDomain] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!canImport) {
    return <div className="group"><EmptyState icon="🔒" title="Import not permitted" text="You need the rule.create permission to import Engineering Standards workbooks." /></div>;
  }

  async function doPreview() {
    if (!file) return setError("Choose the .xlsx workbook first.");
    setBusy(true); setError(""); setResult(null);
    try { setPreview(await api.standardsImportPreview(file, domain || null)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function doCommit() {
    setBusy(true); setError("");
    try { setResult(await api.standardsImportCommit(file, domain || null)); setPreview(null); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="group">
      <p className="hint">
        Step 1 — pick the domain (Cooking / Refrigeration, or type your own) and the standards workbook. Step 2 — preview:
        every column is classified into a directive and nothing is written until you commit. Columns that reference an
        unprovided rule table or formula are imported as <b>pending</b>.
      </p>

      <div className="filter-row">
        <input list="std-import-domains" placeholder="domain (cooking / refrigeration)" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <datalist id="std-import-domains">
          <option value="cooking" />
          <option value="refrigeration" />
        </datalist>
        <input type="file" accept=".xlsx,.xls" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setResult(null); setError(""); }} />
        <button className="btn primary" disabled={busy || !file} onClick={doPreview}>{busy ? "Reading…" : "Preview import"}</button>
      </div>
      {error && <div className="alert">{error}</div>}

      {preview && (
        <div className="group">
          <h2>Preview{preview.domain ? ` — ${titleCase(preview.domain)}` : ""}</h2>
          <div className="std-pills">
            <StatPill>{(preview.categories ?? 0)} categor{(preview.categories === 1) ? "y" : "ies"}</StatPill>
            <StatPill>{(preview.columns ?? 0)} column{preview.columns === 1 ? "" : "s"}</StatPill>
          </div>

          <ByDirective by={preview.by_directive} />

          {(preview.pending_examples || []).length > 0 && (
            <>
              <div className="warn">⚠ Examples of columns that will import as <b>pending</b> (awaiting rule tables / formulas):</div>
              <div className="scroll-x">
                <table className="grid">
                  <thead><tr><th>Category</th><th>Attribute</th><th>Value</th><th>Kind</th></tr></thead>
                  <tbody>
                    {preview.pending_examples.map((x, i) => (
                      <tr key={i} className="std-pending">
                        <td>{x.category || "—"}</td><td>{x.attribute || "—"}</td>
                        <td>{x.value || "—"}</td>
                        <td><span className="badge pending">{DIRECTIVE_LABEL[x.kind] || x.kind || "pending"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {(preview.sample || []).length > 0 && (
            <>
              <h2 style={{ marginTop: 14 }}>Sample of what will be created</h2>
              <div className="scroll-x">
                <table className="grid">
                  <thead><tr><th>Code</th><th>Category</th><th>Attributes</th></tr></thead>
                  <tbody>
                    {preview.sample.map((s, i) => (
                      <tr key={i}>
                        <td className="mono">{s.code || "—"}</td>
                        <td>{s.category || "—"}</td>
                        <td>{Array.isArray(s.attributes) ? s.attributes.length : (s.attributes ?? "—")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="decision">
            <button className="btn primary" disabled={busy} onClick={doCommit}>{busy ? "Importing…" : "Commit import"}</button>
            <span className="muted">Creates / updates category profiles and their attributes. Pending references are recorded for later.</span>
          </div>
        </div>
      )}

      {result && (
        <div className="group">
          <div className="notice">
            ✓ Imported — {result.profiles ?? 0} profile(s) created, {result.updated ?? 0} updated, {result.attributes ?? 0} attribute(s) written.
          </div>
          <div className="std-pills">
            {result.pending_refs != null && <StatPill>{result.pending_refs} pending rule reference(s)</StatPill>}
            {result.pending_calcs != null && <StatPill>{result.pending_calcs} pending calculation(s)</StatPill>}
          </div>
          <ByDirective by={result.by_directive} />
          {(result.errors || []).map((e, i) => <div key={i} className="alert">{typeof e === "string" ? e : (e.error || JSON.stringify(e))}</div>)}
        </div>
      )}
    </div>
  );
}

function ByDirective({ by }) {
  const entries = by && typeof by === "object" ? Object.entries(by) : [];
  if (!entries.length) return null;
  return (
    <div className="std-pills" style={{ marginTop: 10 }}>
      {entries.map(([k, v]) => (
        <span key={k} className={isPendingDirective(k) ? "badge pending" : "pill"} title={DIRECTIVE_LABEL[k] || k}>
          {DIRECTIVE_LABEL[k] || titleCase(k)}: {v}
        </span>
      ))}
    </div>
  );
}

// ═════════════════════════════════════ PENDING DEPENDENCIES ══════════════════
function PendingDeps() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.standardsPending().then((r) => alive && setData(r)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  if (error) return <div className="group"><div className="alert">{error}</div></div>;
  if (!data) return <div className="group"><InlineLoader label="Loading pending dependencies…" /></div>;

  const ruleTables = data.rule_tables_needed || [];
  const calcs = data.calculations_needed || [];

  return (
    <div className="group">
      <div className="warn">
        These are the discipline <b>rule tables</b> and <b>formulas</b> the client has not provided yet. Until they arrive,
        every attribute classified as a CULINOVA rule or a calculation stays <b>pending</b> — the reference is recorded, but
        no engineering value is produced. This is the honest “what's blocked” view.
      </div>

      {typeof data.summary === "string" && data.summary && <p className="hint">{data.summary}</p>}
      <div className="std-pills">
        <StatPill>{ruleTables.length} rule table(s) needed</StatPill>
        <StatPill>{calcs.length} calculation(s) needed</StatPill>
      </div>

      <div className="group">
        <h2>Discipline rule tables needed <span className="sec-count">{ruleTables.length}</span></h2>
        {!ruleTables.length && <p className="muted">None — no attribute references a discipline rule table.</p>}
        {ruleTables.length > 0 && (
          <div className="scroll-x">
            <table className="grid">
              <thead><tr><th>Discipline</th><th>References</th><th>Columns</th></tr></thead>
              <tbody>
                {ruleTables.map((r, i) => (
                  <tr key={i}>
                    <td>{r.discipline || "—"}</td>
                    <td>{r.references ?? 0}</td>
                    <td>{(r.columns || []).length ? r.columns.join(" · ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="group">
        <h2>Calculations / formulas needed <span className="sec-count">{calcs.length}</span></h2>
        {!calcs.length && <p className="muted">None — no attribute needs a formula.</p>}
        {calcs.length > 0 && (
          <div className="scroll-x">
            <table className="grid">
              <thead><tr><th>Formula</th><th>Occurrences</th></tr></thead>
              <tbody>
                {calcs.map((c, i) => (
                  <tr key={i}>
                    <td>{c.formula || "—"}</td>
                    <td>{c.occurrences ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── small helpers ─────────────────────────────────────────────────────────────
function IField({ label, value, mono }) {
  return (
    <div className="ifield">
      <span className="ilabel">{label}</span>
      <span className={"ival" + (mono ? " mono" : "")}>{value || "—"}</span>
    </div>
  );
}

// commissioning_checklist may arrive as an array, a JSON string, or newline text —
// normalise to a clean list of strings without inventing structure.
function normalizeList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : (x?.text || x?.item || JSON.stringify(x)))).filter(Boolean);
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) { try { return normalizeList(JSON.parse(s)); } catch { /* fall through */ } }
    return s.split(/\r?\n/).map((x) => x.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean);
  }
  return [];
}
