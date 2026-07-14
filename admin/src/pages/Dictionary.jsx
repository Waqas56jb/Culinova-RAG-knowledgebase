import React, { useEffect, useState } from "react";
import { api, session } from "../api.js";
import { InlineLoader, PageLoader } from "../components/Loader.jsx";
import { PageHero, PagePanel } from "../components/PageShell.jsx";

const TABS = [
  ["parameters", "Parameters"],
  ["aliases", "Aliases"],
  ["values", "Value Mappings"],
  ["units", "Unit Conversions"],
  ["constants", "Constants"],
  ["disciplines", "Disciplines & Colors"],
  ["settings", "Engine Settings"],
  ["unmapped", "Unmapped Names"],
];

export default function Dictionary() {
  const [tab, setTab] = useState("parameters");
  const [dict, setDict] = useState(null);
  const [error, setError] = useState("");
  const canManage = session.can("dictionary.manage");
  const canSettings = session.can("settings.manage");

  const load = () => api.dictionary().then(setDict).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <PagePanel accent="violet"><div className="alert">{error}</div></PagePanel>;
  if (!dict) return <PagePanel accent="violet"><PageLoader label="Loading dictionary…" /></PagePanel>;

  return (
    <PagePanel accent="violet">
      <PageHero
        accent="violet"
        title="Parameter Dictionary"
        subtitle="Canonical vocabulary, aliases, units and engineering constants."
        meta={`${dict.counts.parameters} parameters · ${dict.counts.aliases} aliases · ${dict.counts.conversions} unit conversions`}
      />
      <p className="hint">
        The dictionary is the platform's vocabulary. Aliases map real datasheet wording ("Power Load",
        "Connected Load") onto one canonical parameter; value mappings turn spellings like "3N" into
        "3-Phase"; constants (PF, efficiency…) are the editable numbers formulas may use.
      </p>
      <nav className="subtabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      {tab === "parameters" && <Parameters dict={dict} canManage={canManage} onChanged={load} />}
      {tab === "aliases" && <Aliases dict={dict} canManage={canManage} />}
      {tab === "values" && <ValueMappings dict={dict} canManage={canManage} />}
      {tab === "units" && <Units canManage={canManage} />}
      {tab === "constants" && <Constants dict={dict} canManage={canManage} />}
      {tab === "disciplines" && <Disciplines dict={dict} canManage={canManage} onChanged={load} />}
      {tab === "settings" && <Settings canSettings={canSettings} />}
      {tab === "unmapped" && <Unmapped dict={dict} canManage={canManage} />}
    </PagePanel>
  );
}

function useList(loader, deps = []) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const reload = () => loader().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { reload(); }, deps);
  return { rows, error, reload, setError };
}

const Err = ({ msg }) => (msg ? <div className="alert">{msg}</div> : null);

// ── Parameters ────────────────────────────────────────────────────────────────
function Parameters({ dict, canManage, onChanged }) {
  const { rows, error, reload, setError } = useList(() => api.dictParameters());
  const [form, setForm] = useState({ key: "", label: "", discipline_id: "", data_type: "number", canonical_unit: "", role: "input" });
  if (!rows) return <InlineLoader label="Loading parameters…" />;

  async function add() {
    try {
      await api.dictCreateParameter({ ...form, discipline_id: form.discipline_id || null, canonical_unit: form.canonical_unit || null });
      setForm({ ...form, key: "", label: "", canonical_unit: "" });
      reload(); onChanged();
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="group">
      <Err msg={error} />
      {canManage && (
        <div className="add-row">
          <input placeholder="key (electrical.power)" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
          <input placeholder="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <select value={form.discipline_id} onChange={(e) => setForm({ ...form, discipline_id: e.target.value })}>
            <option value="">(no discipline)</option>
            {dict.disciplines.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={form.data_type} onChange={(e) => setForm({ ...form, data_type: e.target.value })}>
            <option>number</option><option>text</option><option>enum</option><option>boolean</option>
          </select>
          <input placeholder="unit (kW)" value={form.canonical_unit} onChange={(e) => setForm({ ...form, canonical_unit: e.target.value })} style={{ width: 90 }} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="input">input</option><option value="output">output</option><option value="both">both</option>
          </select>
          <button className="btn small primary" onClick={add}>Add</button>
        </div>
      )}
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Key</th><th>Label</th><th>Discipline</th><th>Type</th><th>Unit</th><th>Role</th><th>Active</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={p.is_active ? "" : "muted"}>
                <td className="mono">{p.key}</td><td>{p.label}</td>
                <td>{p.ceks_disciplines?.name || "—"}</td><td>{p.data_type}</td>
                <td>{p.canonical_unit || "—"}</td><td>{p.role}</td>
                <td>
                  {canManage
                    ? <button className={"tick " + (p.is_active ? "on" : "")} onClick={async () => { await api.dictUpdateParameter(p.id, { is_active: !p.is_active }); reload(); }}>✓</button>
                    : p.is_active ? "✓" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Aliases ───────────────────────────────────────────────────────────────────
function Aliases({ dict, canManage }) {
  const { rows, error, reload, setError } = useList(() => api.dictAliases());
  const [form, setForm] = useState({ parameter_id: "", alias: "", match_type: "exact" });
  if (!rows) return <InlineLoader label="Loading parameters…" />;

  async function add() {
    try { await api.dictCreateAlias(form); setForm({ ...form, alias: "" }); reload(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div className="group">
      <Err msg={error} />
      {canManage && (
        <div className="add-row">
          <select value={form.parameter_id} onChange={(e) => setForm({ ...form, parameter_id: e.target.value })}>
            <option value="">— parameter —</option>
            {dict.parameters.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.key})</option>)}
          </select>
          <input placeholder='raw name, e.g. "Connected Load"' value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} />
          <select value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value })}>
            <option>exact</option><option>contains</option><option>regex</option>
          </select>
          <button className="btn small primary" onClick={add}>Add alias</button>
        </div>
      )}
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Alias</th><th>Match</th><th>→ Parameter</th><th></th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{a.alias}</td><td>{a.match_type}</td>
                <td className="mono">{a.ceks_parameters?.key}</td>
                <td className="rowacts">{canManage && <button className="x" onClick={async () => { await api.dictDeleteAlias(a.id); reload(); }}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Value mappings ("3N" → "3-Phase") ────────────────────────────────────────
function ValueMappings({ dict, canManage }) {
  const { rows, error, reload, setError } = useList(() => api.dictValueNorms());
  const [form, setForm] = useState({ parameter_id: "", raw_pattern: "", canonical_value: "", match_type: "exact" });
  if (!rows) return <InlineLoader label="Loading parameters…" />;

  async function add() {
    try { await api.dictCreateValueNorm(form); setForm({ ...form, raw_pattern: "", canonical_value: "" }); reload(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div className="group">
      <Err msg={error} />
      {canManage && (
        <div className="add-row">
          <select value={form.parameter_id} onChange={(e) => setForm({ ...form, parameter_id: e.target.value })}>
            <option value="">— parameter —</option>
            {dict.parameters.filter((p) => p.data_type === "enum").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <input placeholder='raw spelling ("3N")' value={form.raw_pattern} onChange={(e) => setForm({ ...form, raw_pattern: e.target.value })} />
          <input placeholder='canonical ("3-Phase")' value={form.canonical_value} onChange={(e) => setForm({ ...form, canonical_value: e.target.value })} />
          <select value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value })}>
            <option>exact</option><option>contains</option><option>regex</option>
          </select>
          <button className="btn small primary" onClick={add}>Add mapping</button>
        </div>
      )}
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Raw</th><th>Match</th><th>→ Canonical</th><th>Parameter</th><th></th></tr></thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <td>{v.raw_pattern}</td><td>{v.match_type}</td><td>{v.canonical_value}</td>
                <td className="mono">{v.ceks_parameters?.key}</td>
                <td className="rowacts">{canManage && <button className="x" onClick={async () => { await api.dictDeleteValueNorm(v.id); reload(); }}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Unit conversions ──────────────────────────────────────────────────────────
function Units({ canManage }) {
  const { rows, error, reload, setError } = useList(() => api.dictUnits());
  const [form, setForm] = useState({ from_unit: "", to_unit: "", factor: "", offset: "0" });
  if (!rows) return <InlineLoader label="Loading parameters…" />;

  async function add() {
    try { await api.dictCreateUnit({ ...form, factor: Number(form.factor), offset: Number(form.offset) || 0 }); setForm({ from_unit: "", to_unit: "", factor: "", offset: "0" }); reload(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div className="group">
      <Err msg={error} />
      {canManage && (
        <div className="add-row">
          <input placeholder="from (W)" value={form.from_unit} onChange={(e) => setForm({ ...form, from_unit: e.target.value })} style={{ width: 100 }} />
          <input placeholder="to (kW)" value={form.to_unit} onChange={(e) => setForm({ ...form, to_unit: e.target.value })} style={{ width: 100 }} />
          <input placeholder="factor (0.001)" value={form.factor} onChange={(e) => setForm({ ...form, factor: e.target.value })} style={{ width: 120 }} />
          <input placeholder="offset" value={form.offset} onChange={(e) => setForm({ ...form, offset: e.target.value })} style={{ width: 80 }} />
          <button className="btn small primary" onClick={add}>Add conversion</button>
        </div>
      )}
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>From</th><th>To</th><th>Factor</th><th>Offset</th><th></th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>{u.from_unit}</td><td>{u.to_unit}</td><td>{u.factor}</td><td>{u.offset}</td>
                <td className="rowacts">{canManage && <button className="x" onClick={async () => { await api.dictDeleteUnit(u.id); reload(); }}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Constants (PF, efficiency…) ───────────────────────────────────────────────
function Constants({ dict, canManage }) {
  const { rows, error, reload, setError } = useList(() => api.dictConstants());
  const [form, setForm] = useState({ key: "", value: "", unit: "", description: "", discipline_id: "" });
  if (!rows) return <InlineLoader label="Loading parameters…" />;

  async function add() {
    try {
      await api.dictCreateConstant({ ...form, value: Number(form.value), discipline_id: form.discipline_id || null });
      setForm({ key: "", value: "", unit: "", description: "", discipline_id: "" });
      reload();
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="group">
      <p className="hint">A constant is an engineering assumption a formula may use — e.g. <code>pf</code> (power factor). Changing it affects NEW derivations; existing recommendations stay frozen until recalculated.</p>
      <Err msg={error} />
      {canManage && (
        <div className="add-row">
          <input placeholder="key (pf)" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} style={{ width: 110 }} />
          <input placeholder="value (0.9)" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} style={{ width: 100 }} />
          <input placeholder="unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} style={{ width: 80 }} />
          <input placeholder="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <select value={form.discipline_id} onChange={(e) => setForm({ ...form, discipline_id: e.target.value })}>
            <option value="">(any discipline)</option>
            {dict.disciplines.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn small primary" onClick={add}>Add constant</button>
        </div>
      )}
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Key</th><th>Value</th><th>Unit</th><th>Description</th><th>Discipline</th><th></th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.key}</td>
                <td>
                  {canManage
                    ? <input defaultValue={c.value} style={{ width: 90 }} onBlur={async (e) => { if (Number(e.target.value) !== Number(c.value)) { await api.dictUpdateConstant(c.id, { value: Number(e.target.value) }); reload(); } }} />
                    : c.value}
                </td>
                <td>{c.unit || "—"}</td><td>{c.description || "—"}</td>
                <td>{c.ceks_disciplines?.name || "any"}</td>
                <td className="rowacts">{canManage && <button className="x" onClick={async () => { if (confirm(`Delete constant "${c.key}"? Formulas that use it will fail validation.`)) { await api.dictDeleteConstant(c.id); reload(); } }}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Disciplines: rule categories + MEP colours/symbols (client items 11, 20) ─
function Disciplines({ dict, canManage, onChanged }) {
  const [pointTypes, setPointTypes] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api.pointTypes().then(setPointTypes).catch((e) => setError(e.message)); }, []);

  return (
    <div className="group">
      <Err msg={error} />
      <h2>Disciplines (rule categories)</h2>
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Code</th><th>Name</th><th>Color</th><th>Symbol</th><th>Active</th></tr></thead>
          <tbody>
            {dict.disciplines.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.code}</td><td>{d.name}</td>
                <td>
                  {canManage
                    ? <input type="color" defaultValue={d.color || "#888888"} onBlur={async (e) => { await api.dictUpdateDiscipline(d.id, { color: e.target.value }); onChanged(); }} />
                    : <span className="swatch" style={{ background: d.color }} />}
                  <span className="mono" style={{ marginLeft: 6 }}>{d.color}</span>
                </td>
                <td>
                  {canManage
                    ? <input defaultValue={d.symbol || ""} style={{ width: 60 }} onBlur={async (e) => { if (e.target.value !== d.symbol) { await api.dictUpdateDiscipline(d.id, { symbol: e.target.value }); onChanged(); } }} />
                    : d.symbol}
                </td>
                <td>{d.is_active ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 18 }}>MEP point types (drawing colours)</h2>
      {!pointTypes ? <div className="muted">Loading…</div> : (
        <div className="scroll-x">
          <table className="grid">
            <thead><tr><th>Code</th><th>Label</th><th>Color</th><th>Symbol</th></tr></thead>
            <tbody>
              {pointTypes.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.code}</td><td>{t.label}</td>
                  <td><span className="swatch" style={{ background: t.color }} /> <span className="mono">{t.color}</span></td>
                  <td>{t.symbol}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12 }}>Point colours/symbols are stored in <code>ceks_utility_point_types</code> — every drawing and export reads them live.</p>
    </div>
  );
}

// ── Engine settings ───────────────────────────────────────────────────────────
function Settings({ canSettings }) {
  const { rows, error, reload, setError } = useList(() => api.dictSettings());
  if (!rows) return <InlineLoader label="Loading parameters…" />;

  return (
    <div className="group">
      <Err msg={error} />
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Setting</th><th>Value</th><th>What it does</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.key}>
                <td className="mono">{s.key}</td>
                <td>
                  {canSettings
                    ? <input defaultValue={s.value} style={{ width: 130 }} onBlur={async (e) => { if (e.target.value !== s.value) { try { await api.dictSetSetting(s.key, e.target.value); reload(); } catch (er) { setError(er.message); } } }} />
                    : <b>{s.value}</b>}
                </td>
                <td className="muted">{s.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Unmapped attribute names — the work list ─────────────────────────────────
function Unmapped({ dict, canManage }) {
  const { rows, error, reload, setError } = useList(() => api.dictUnmapped());
  const [target, setTarget] = useState({});
  if (!rows) return <InlineLoader label="Loading parameters…" />;

  async function map(name) {
    const parameter_id = target[name];
    if (!parameter_id) return;
    try { await api.dictCreateAlias({ parameter_id, alias: name, match_type: "exact" }); reload(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div className="group">
      <p className="hint">{rows.total_unmapped_names} live attribute name(s) don't resolve to any parameter yet. Mapping them lets rules match that data.</p>
      <Err msg={error} />
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Raw name</th><th>Occurrences</th><th>Map to parameter</th><th></th></tr></thead>
          <tbody>
            {rows.names.map((n) => (
              <tr key={n.name}>
                <td>{n.name}</td><td>{n.occurrences}</td>
                <td>
                  <select value={target[n.name] || ""} onChange={(e) => setTarget({ ...target, [n.name]: e.target.value })}>
                    <option value="">—</option>
                    {dict.parameters.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.key})</option>)}
                  </select>
                </td>
                <td className="rowacts">{canManage && <button className="btn small" disabled={!target[n.name]} onClick={() => map(n.name)}>Add alias</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
