import React, { useEffect, useMemo, useState } from "react";
import { api, session } from "../api.js";
import { PageLoader } from "../components/Loader.jsx";
import { PageHero, PagePanel, StatPill } from "../components/PageShell.jsx";

const STATUS_LABEL = { draft: "Draft", under_review: "Under Review", approved: "Approved", archived: "Archived" };

export default function Rules() {
  const [meta, setMeta] = useState(null);
  const [list, setList] = useState({ rules: [], total: 0 });
  const [filter, setFilter] = useState({ discipline: "", status: "", q: "" });
  const [view, setView] = useState({ name: "list" }); // list | edit | import
  const [error, setError] = useState("");

  const canCreate = session.can("rule.create");
  const canApprove = session.can("rule.approve");

  async function load() {
    setError("");
    try {
      const params = {};
      if (filter.discipline) params.discipline = filter.discipline;
      if (filter.status) params.status = filter.status;
      if (filter.q) params.q = filter.q;
      params.limit = 200;
      const [m, l] = await Promise.all([meta ? Promise.resolve(meta) : api.rulesMeta(), api.rules(params)]);
      setMeta(m); setList(l);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [filter.discipline, filter.status, filter.q]);

  if (error) return <PagePanel accent="amber"><div className="alert">{error}</div></PagePanel>;
  if (!meta) return <PagePanel accent="amber"><PageLoader label="Loading rules…" /></PagePanel>;

  if (view.name === "edit") {
    return <RuleEditor meta={meta} ruleId={view.id} duplicateOf={view.duplicateOf}
      onBack={() => { setView({ name: "list" }); load(); }} />;
  }
  if (view.name === "import") {
    return <RuleImport meta={meta} onBack={() => { setView({ name: "list" }); load(); }} />;
  }

  const discName = (id) => meta.disciplines.find((d) => d.id === id)?.name || "—";

  return (
    <PagePanel accent="amber">
      <PageHero
        accent="amber"
        title="CULINOVA Engineering Rules"
        subtitle="Conditions and outputs that drive automatic engineering recommendations."
        badge={<StatPill>{list.total} rule{list.total === 1 ? "" : "s"}</StatPill>}
        actions={
          <>
            {canCreate && <button className="btn" onClick={() => setView({ name: "import" })}>Excel Rule Import</button>}
            {canCreate && <button className="btn primary" onClick={() => setView({ name: "edit" })}>+ New Rule</button>}
          </>
        }
      />
      <p className="hint">
        A rule is data: <b>conditions</b> it matches (Phase = 3-Phase · Current 16–20 A) and <b>outputs</b> it produces
        (Cable Size, Breaker…). Rules start as Draft; only an <b>approved</b> rule changes engineering answers.
        Editing a live rule creates a new version and flags affected equipment for recalculation.
      </p>

      <div className="filter-row">
        <select value={filter.discipline} onChange={(e) => setFilter((f) => ({ ...f, discipline: e.target.value }))}>
          <option value="">All disciplines</option>
          {meta.disciplines.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="Search rule ID or name…" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />
        <span className="muted">{list.total} rule(s)</span>
      </div>

      <div className="scroll-x">
        <table className="grid">
          <thead>
            <tr><th>Rule ID</th><th>Name</th><th>Discipline</th><th>Type</th><th>Priority</th><th>Version</th><th>Status</th><th>Active</th><th>Conditions</th><th>Outputs</th><th></th></tr>
          </thead>
          <tbody>
            {list.rules.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.code}</td>
                <td>{r.name || "—"}</td>
                <td>{r.ceks_disciplines?.name || discName(r.discipline_id)}</td>
                <td>{r.rule_type === "derivation" ? <span className="pill">derivation</span> : "recommendation"}</td>
                <td>{r.priority}</td>
                <td>v{r.version}</td>
                <td><span className={"badge " + r.status}>{STATUS_LABEL[r.status] || r.status}</span></td>
                <td>{r.is_active ? "✓" : "—"}</td>
                <td>{r.ceks_rule_conditions?.[0]?.count ?? 0}</td>
                <td>{r.ceks_rule_outputs?.[0]?.count ?? 0}</td>
                <td className="rowacts">
                  <button className="btn small ghost" onClick={() => setView({ name: "edit", id: r.id })}>Open</button>
                </td>
              </tr>
            ))}
            {!list.rules.length && <tr><td colSpan={11} className="muted">No rules yet — create one or import the standards Excel.</td></tr>}
          </tbody>
        </table>
      </div>
    </PagePanel>
  );
}
const emptyCondition = () => ({ parameter_id: "", operator: "eq", value_text: "", value_num: null, value_min: null, value_max: null, value_list: null, unit: "" });
const emptyOutput = () => ({ parameter_id: "", value_text: "", value_num: null, unit: "", expression: "", note: "" });

function RuleEditor({ meta, ruleId, duplicateOf, onBack }) {
  const [rule, setRule] = useState(null);
  const [form, setForm] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const canCreate = session.can("rule.create");
  const canApprove = session.can("rule.approve");
  const canArchive = session.can("rule.archive");

  useEffect(() => {
    if (!ruleId) {
      setForm({
        code: "", name: "", description: "", discipline_id: meta.disciplines[0]?.id || "",
        rule_type: "recommendation", priority: 100, engineer_approval_required: false,
        effective_from: "", effective_to: "", notes: "", clause: "", reference_url: "",
        conditions: [emptyCondition()], outputs: [emptyOutput()],
      });
      return;
    }
    api.rule(ruleId).then((r) => {
      setRule(r);
      setForm({
        code: r.code, name: r.name || "", description: r.description || "",
        discipline_id: r.discipline_id, rule_type: r.rule_type, priority: r.priority,
        engineer_approval_required: r.engineer_approval_required,
        effective_from: r.effective_from || "", effective_to: r.effective_to || "",
        notes: r.notes || "", clause: r.clause || "", reference_url: r.reference_url || "",
        conditions: (r.ceks_rule_conditions || []).sort((a, b) => a.sort_order - b.sort_order),
        outputs: (r.ceks_rule_outputs || []).sort((a, b) => a.sort_order - b.sort_order),
      });
    }).catch((e) => setError(e.message));
  }, [ruleId]);

  const paramsFor = (roles) => meta.parameters.filter((p) => roles.includes(p.role) || p.role === "both");
  const paramById = useMemo(() => new Map(meta.parameters.map((p) => [p.id, p])), [meta]);

  async function validate() {
    if (!form) return;
    try { setCheck(await api.validateRule({ ...form, id: ruleId || null })); }
    catch (e) { setCheck({ ok: false, errors: [e.message], overlaps: [] }); }
  }

  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      const body = { ...form };
      if (ruleId) {
        const r = await api.updateRule(ruleId, body);
        setMessage(r.message || "Saved.");
      } else {
        const r = await api.createRule(body);
        setMessage(r.overlaps?.length ? `Created — but it overlaps ${r.overlaps.length} existing rule(s), review before approving.` : "Created as Draft.");
        onBack();
        return;
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function act(fn, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true); setError(""); setMessage("");
    try { await fn(); onBack(); }
    catch (e) { setError(e.message); setBusy(false); }
  }

  if (error && !form) return <PagePanel accent="amber"><button className="btn small ghost" onClick={onBack}>← Back</button><div className="alert">{error}</div></PagePanel>;
  if (!form) return <PagePanel accent="amber"><PageLoader label="Loading rule…" /></PagePanel>;

  const status = rule?.status || "draft";
  const editable = canCreate;

  return (
    <PagePanel accent="amber">
      <button className="btn small ghost" onClick={onBack}>← Back to rules</button>
      <div className="page-head">
        <h1>{ruleId ? `Rule ${form.code}` : "New Engineering Rule"} {rule && <span className={"badge big " + status}>{STATUS_LABEL[status]}{rule.is_active ? " · active" : ""}</span>}</h1>
        <div className="actions">
          {ruleId && canCreate && <button className="btn" disabled={busy} onClick={() => act(() => api.duplicateRule(ruleId, {}), null)}>Duplicate</button>}
          {ruleId && canApprove && status !== "approved" && (
            <button className="btn primary" disabled={busy}
              onClick={() => act(() => api.approveRule(ruleId, {}), "Approve and ACTIVATE this rule? It will start generating CULINOVA recommendations.")}>
              Approve & Activate
            </button>
          )}
          {ruleId && canApprove && status === "approved" && (
            <button className="btn" disabled={busy}
              onClick={() => act(() => api.activateRule(ruleId, !rule.is_active))}>
              {rule.is_active ? "Deactivate" : "Activate"}
            </button>
          )}
          {ruleId && canArchive && status !== "archived" && (
            <button className="btn danger" disabled={busy}
              onClick={() => act(() => api.archiveRule(ruleId, prompt("Reason for archiving?") || ""), null)}>
              Archive
            </button>
          )}
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <div className="alert">{error}</div>}

      <div className="group">
        <h2>Identity</h2>
        <div className="form-grid">
          <label>Rule ID<input value={form.code} disabled={!!ruleId} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="E-006" /></label>
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="3-phase 400 V, 16–20 A" /></label>
          <label>Rule Category (discipline)
            <select value={form.discipline_id} onChange={(e) => setForm({ ...form, discipline_id: e.target.value })}>
              {meta.disciplines.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label>Type
            <select value={form.rule_type} disabled={!!ruleId} onChange={(e) => setForm({ ...form, rule_type: e.target.value })}>
              <option value="recommendation">Recommendation (produces engineering outputs)</option>
              <option value="derivation">Derivation (computes a missing input, e.g. Current)</option>
            </select>
          </label>
          <label>Priority<input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></label>
          <label>Effective from<input type="date" value={form.effective_from || ""} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} /></label>
          <label>Effective to<input type="date" value={form.effective_to || ""} onChange={(e) => setForm({ ...form, effective_to: e.target.value })} /></label>
          <label className="check">
            <input type="checkbox" checked={!!form.engineer_approval_required} onChange={(e) => setForm({ ...form, engineer_approval_required: e.target.checked })} />
            Engineer approval required on every value this rule produces
          </label>
        </div>
        <label className="wide">Description<textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <div className="form-grid">
          <label>Standard clause<input value={form.clause} onChange={(e) => setForm({ ...form, clause: e.target.value })} placeholder="CULINOVA Electrical Standard v1.0 §4.2" /></label>
          <label>Reference URL<input value={form.reference_url} onChange={(e) => setForm({ ...form, reference_url: e.target.value })} /></label>
        </div>
        <label className="wide">Notes<textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
      </div>

      <ConditionsEditor
        conditions={form.conditions} editable={editable}
        parameters={paramsFor(["input"])} paramById={paramById} operators={meta.operators}
        onChange={(conditions) => setForm({ ...form, conditions })}
      />

      <OutputsEditor
        outputs={form.outputs} editable={editable}
        parameters={paramsFor(["output"])} paramById={paramById}
        constants={meta.constants} functions={meta.functions}
        onChange={(outputs) => setForm({ ...form, outputs })}
      />

      {check && (
        <div className="group">
          <h2>Validation</h2>
          {check.errors?.length
            ? check.errors.map((e, i) => <div key={i} className="alert">{e}</div>)
            : <div className="notice">✓ The rule is valid.</div>}
          {check.overlaps?.length > 0 && (
            <div className="warn">
              ⚠ Overlaps {check.overlaps.length} existing rule(s):{" "}
              {check.overlaps.map((o) => `${o.code}${o.same_priority ? " (SAME priority — will conflict)" : ""}`).join(" · ")}
            </div>
          )}
        </div>
      )}

      {rule?.versions?.length > 0 && (
        <div className="group">
          <h2>Version history</h2>
          {rule.versions.map((v) => (
            <div key={v.version} className="hist-row">
              <span className="pill">v{v.version}</span>
              <span>{v.change_note || "Approved"}</span>
              <span className="muted hist-time">{new Date(v.approved_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {editable && (
        <div className="decision">
          <button className="btn" disabled={busy} onClick={validate}>Validate & check overlaps</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {ruleId ? (status === "approved" ? "Save as new version (v" + ((rule?.version || 1) + 1) + " draft)" : "Save changes") : "Create rule (Draft)"}
          </button>
        </div>
      )}
    </PagePanel>
  );
}

function ConditionsEditor({ conditions, editable, parameters, paramById, operators, onChange }) {
  const set = (i, patch) => onChange(conditions.map((c, x) => (x === i ? { ...c, ...patch } : c)));
  return (
    <div className="group">
      <h2>Conditions <span className="sec-count">match ALL of these</span></h2>
      {conditions.map((c, i) => {
        const p = paramById.get(c.parameter_id);
        const type = p?.data_type || "text";
        const ops = operators.filter((o) => o.types.includes(type === "enum" ? "enum" : type));
        return (
          <div key={i} className="rule-row">
            <select value={c.parameter_id} disabled={!editable} onChange={(e) => set(i, { parameter_id: e.target.value })}>
              <option value="">— parameter —</option>
              {parameters.map((x) => <option key={x.id} value={x.id}>{x.label} ({x.key})</option>)}
            </select>
            <select value={c.operator} disabled={!editable} onChange={(e) => set(i, { operator: e.target.value })}>
              {ops.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </select>
            {c.operator === "between" ? (
              <>
                <input type="number" placeholder="from" value={c.value_min ?? ""} disabled={!editable} onChange={(e) => set(i, { value_min: e.target.value === "" ? null : Number(e.target.value) })} />
                <input type="number" placeholder="to" value={c.value_max ?? ""} disabled={!editable} onChange={(e) => set(i, { value_max: e.target.value === "" ? null : Number(e.target.value) })} />
              </>
            ) : ["in", "not_in"].includes(c.operator) ? (
              <input placeholder="comma-separated values" value={(c.value_list || []).join(", ")} disabled={!editable}
                onChange={(e) => set(i, { value_list: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} style={{ gridColumn: "span 2" }} />
            ) : ["exists", "not_exists"].includes(c.operator) ? (
              <span className="muted" style={{ gridColumn: "span 2" }}>—</span>
            ) : type === "number" ? (
              <input type="number" placeholder="value" value={c.value_num ?? ""} disabled={!editable} onChange={(e) => set(i, { value_num: e.target.value === "" ? null : Number(e.target.value) })} style={{ gridColumn: "span 2" }} />
            ) : type === "enum" && p?.allowed_values ? (
              <select value={c.value_text || ""} disabled={!editable} onChange={(e) => set(i, { value_text: e.target.value })} style={{ gridColumn: "span 2" }}>
                <option value="">— value —</option>
                {p.allowed_values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : (
              <input placeholder="value" value={c.value_text || ""} disabled={!editable} onChange={(e) => set(i, { value_text: e.target.value })} style={{ gridColumn: "span 2" }} />
            )}
            <input placeholder="unit" title="Unit the value is written in (converted automatically)" value={c.unit || ""} disabled={!editable || type !== "number"} onChange={(e) => set(i, { unit: e.target.value })} />
            {editable && <button className="x" title="Remove condition" onClick={() => onChange(conditions.filter((_, x) => x !== i))}>×</button>}
          </div>
        );
      })}
      {editable && <button className="btn small" onClick={() => onChange([...conditions, emptyCondition()])}>+ Add condition</button>}
    </div>
  );
}

function OutputsEditor({ outputs, editable, parameters, paramById, constants, functions, onChange }) {
  const set = (i, patch) => onChange(outputs.map((o, x) => (x === i ? { ...o, ...patch } : o)));
  return (
    <div className="group">
      <h2>Outputs <span className="sec-count">the CULINOVA recommendation this rule produces</span></h2>
      {outputs.map((o, i) => (
        <div key={i} className="rule-row out">
          <select value={o.parameter_id} disabled={!editable} onChange={(e) => set(i, { parameter_id: e.target.value })}>
            <option value="">— output parameter —</option>
            {parameters.map((x) => <option key={x.id} value={x.id}>{x.label} ({x.key})</option>)}
          </select>
          <input placeholder='value (e.g. "5×6 mm² Cu")' value={o.value_text || ""} disabled={!editable} onChange={(e) => set(i, { value_text: e.target.value })} />
          <input placeholder="unit" value={o.unit || ""} disabled={!editable} onChange={(e) => set(i, { unit: e.target.value })} />
          <input className="mono" placeholder="or formula: electrical.power * 1000 / (sqrt(3) * electrical.voltage * pf)"
            title={`Available constants: ${Object.keys(constants || {}).join(", ") || "(none yet — add in Dictionary)"}\nFunctions: ${(functions || []).map((f) => f.name || f).join(", ")}`}
            value={o.expression || ""} disabled={!editable} onChange={(e) => set(i, { expression: e.target.value })} style={{ gridColumn: "span 2" }} />
          <input placeholder="engineering note" value={o.note || ""} disabled={!editable} onChange={(e) => set(i, { note: e.target.value })} />
          {editable && <button className="x" title="Remove output" onClick={() => onChange(outputs.filter((_, x) => x !== i))}>×</button>}
        </div>
      ))}
      {editable && <button className="btn small" onClick={() => onChange([...outputs, emptyOutput()])}>+ Add output</button>}
    </div>
  );
}

// ═════════════════════════════════════ EXCEL RULE IMPORT ═════════════════════
function RuleImport({ meta, onBack }) {
  const [discipline, setDiscipline] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function doPreview() {
    if (!file) return setError("Choose the .xlsx file first.");
    setBusy(true); setError(""); setResult(null);
    try { setPreview(await api.ruleImportPreview(file, discipline || null)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function doCommit() {
    setBusy(true); setError("");
    try { setResult(await api.ruleImportCommit(file, discipline || null)); setPreview(null); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <PagePanel accent="amber">
      <button className="btn small ghost" onClick={onBack}>← Back to rules</button>
      <PageHero accent="amber" title="Excel Rule Import" subtitle="Preview and commit engineering rules from Excel." />
      <p className="hint">
        Step 1 — download the template and fill it (or use your standards sheet). Step 2 — preview:
        nothing is written until you commit. Imported rules land as <b>Draft</b>; they still need approval.
      </p>

      <div className="group">
        <div className="filter-row">
          <select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
            <option value="">— choose the discipline —</option>
            {meta.disciplines.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn" onClick={() => {
            const code = meta.disciplines.find((d) => d.id === discipline)?.code;
            api.downloadRuleTemplate(code || null);
          }}>Download template</button>
          <input type="file" accept=".xlsx,.xls" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setResult(null); }} />
          <button className="btn primary" disabled={busy || !file} onClick={doPreview}>{busy ? "Reading…" : "Preview import"}</button>
        </div>
        {error && <div className="alert">{error}</div>}
      </div>

      {preview && (
        <div className="group">
          <h2>Preview — sheet "{preview.sheet}": {preview.ready} ready, {preview.with_problems} with problems, {preview.total_rows} rows</h2>

          {(preview.unmapped || []).length > 0 && (
            <div className="warn">
              ⚠ Unrecognised columns (they will be IGNORED, never guessed):{" "}
              {preview.unmapped.map((c) => `"${c.header}"`).join(", ")}.
              Add aliases in the Parameter Dictionary and re-upload if they matter.
            </div>
          )}
          {(preview.existing_codes || []).length > 0 && (
            <div className="warn">⚠ These Rule IDs already exist and will fail: {preview.existing_codes.join(", ")}</div>
          )}
          {(preview.problems || []).map((r, i) => (
            <div key={i} className="alert">{r.code}: {(r.issues || []).join(" · ")}</div>
          ))}

          <h2 style={{ marginTop: 14 }}>Sample of what will be created</h2>
          <div className="scroll-x">
            <table className="grid">
              <thead><tr><th>Rule ID</th><th>Description</th><th>Conditions</th><th>Outputs</th></tr></thead>
              <tbody>
                {(preview.sample || []).map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.code}</td>
                    <td>{r.description || "—"}</td>
                    <td>{(r.conditions || []).join(" · ")}</td>
                    <td>{(r.outputs || []).join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.ready > 0 && (
            <div className="decision">
              <button className="btn primary" disabled={busy || !discipline} title={!discipline ? "Choose the discipline first" : ""} onClick={doCommit}>
                {busy ? "Importing…" : `Commit ${preview.ready} rule(s) as Draft`}
              </button>
              {!discipline && <span className="muted">Choose the discipline these rules belong to before committing.</span>}
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="group">
          <div className="notice">✓ Imported {result.created} rule(s) as Draft{result.failed ? ` — ${result.failed} failed` : ""}.</div>
          {(result.errors || []).map((e, i) => <div key={i} className="alert">{e.code || e.row}: {e.error}</div>)}
        </div>
      )}
    </PagePanel>
  );
}
