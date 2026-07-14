import React, { useEffect, useRef, useState } from "react";
import { api, session } from "../api.js";
import DrawingEditor from "./DrawingEditor.jsx";
import { PageLoader } from "../components/Loader.jsx";
import { PageHero, PagePanel } from "../components/PageShell.jsx";

const TABS = [
  ["equipment", "Equipment"],
  ["schedules", "Schedules"],
  ["points", "MEP Points"],
  ["drawings", "Drawings"],
  ["report", "Report"],
  ["assistant", "AI Assistant"],
];

export default function ProjectWorkspace({ id, onBack }) {
  const [project, setProject] = useState(null);
  const [tab, setTab] = useState("equipment");
  const [drawingId, setDrawingId] = useState(null);
  const [error, setError] = useState("");
  const canManage = session.can("project.manage");

  const load = () => api.project(id).then(setProject).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  if (error) return <PagePanel accent="cyan"><button className="btn small ghost" onClick={onBack}>← Back</button><div className="alert">{error}</div></PagePanel>;
  if (!project) return <PagePanel accent="cyan"><PageLoader label="Loading project…" /></PagePanel>;

  if (drawingId) {
    return <DrawingEditor drawingId={drawingId} project={project}
      onBack={() => { setDrawingId(null); load(); }} />;
  }

  return (
    <PagePanel accent="cyan" className={tab === "drawings" ? "drawing-panel" : ""}>
      <button className="btn small ghost" onClick={onBack}>← All projects</button>
      <PageHero
        accent="cyan"
        eyebrow={project.code || "Project"}
        title={project.name}
        meta={`${project.items.length} item(s) · ${project.revisions.length} revision(s)${project.client ? ` · ${project.client}` : ""}`}
        badge={<><span className={"badge big " + project.status}>{project.status}</span><span className="pill">R{project.revision ?? 1}</span></>}
        actions={canManage ? (
          <>
            <select value={project.status} onChange={async (e) => { await api.updateProject(id, { status: e.target.value }); load(); }}>
              {["draft", "under_review", "approved", "published", "archived"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn" onClick={async () => {
              await api.saveProjectRevision(id, prompt("Label for this revision?", `Revision ${project.revision ?? 1}`) || undefined);
              load();
            }}>Save equipment revision</button>
          </>
        ) : null}
      />

      <nav className="subtabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      {tab === "equipment" && <EquipmentTab project={project} canManage={canManage} reload={load} />}
      {tab === "schedules" && <SchedulesTab project={project} />}
      {tab === "points" && <PointsTab project={project} />}
      {tab === "drawings" && <DrawingsTab project={project} canManage={canManage} reload={load} onOpen={setDrawingId} />}
      {tab === "report" && <ReportTab project={project} />}
      {tab === "assistant" && <AssistantTab project={project} />}
    </PagePanel>
  );
}

// ═══════════════════════════════ EQUIPMENT ═══════════════════════════════════
function EquipmentTab({ project, canManage, reload }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  const [replacing, setReplacing] = useState(null); // itemId being replaced

  async function search() {
    try { setResults(await api.approvedEntries(query)); }
    catch (e) { setError(e.message); }
  }

  async function add(entryId) {
    setError("");
    try {
      if (replacing) {
        await api.replaceProjectItem(project.id, replacing, entryId);
        setReplacing(null);
      } else {
        await api.addProjectItem(project.id, { entry_id: entryId });
      }
      setResults(null); setQuery("");
      reload();
    } catch (e) { setError(e.message); }
  }

  async function patch(itemId, patch) {
    try { await api.updateProjectItem(project.id, itemId, patch); reload(); }
    catch (e) { setError(e.message); }
  }

  const active = project.items.filter((i) => i.status === "active");
  const replaced = project.items.filter((i) => i.status === "replaced");

  return (
    <div className="group">
      {error && <div className="alert">{error}</div>}
      {canManage && (
        <>
          {replacing && (
            <div className="warn">
              Choosing a replacement for item {project.items.find((i) => i.id === replacing)?.item_number}.
              The old line stays in the history. <button className="btn small ghost" onClick={() => setReplacing(null)}>Cancel</button>
            </div>
          )}
          <div className="add-row">
            <input placeholder="Search approved EOS equipment (brand, model, type…)" value={query}
              onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} style={{ flex: 1 }} />
            <button className="btn small primary" onClick={search}>Search approved catalog</button>
          </div>
          {results && (
            <div className="scroll-x" style={{ marginBottom: 14 }}>
              <table className="grid">
                <thead><tr><th>Equipment</th><th>Brand</th><th>Type</th><th>Model</th><th></th></tr></thead>
                <tbody>
                  {(results.items || []).map((e) => (
                    <tr key={e.id}>
                      <td>{e.title}</td><td>{e.brand || "—"}</td><td>{e.equipment_type || "—"}</td>
                      <td className="mono">{e.model_number || e.code}</td>
                      <td className="rowacts"><button className="btn small" onClick={() => add(e.id)}>{replacing ? "Use as replacement" : "+ Add"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Item No.</th><th>Equipment</th><th>Brand</th><th>Qty</th><th>Area</th><th>Section</th><th>Room</th><th>Zone</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {active.map((it) => (
              <tr key={it.id}>
                <td><Cell value={it.item_number} disabled={!canManage} onSave={(v) => patch(it.id, { item_number: v })} width={70} /></td>
                <td>{it.ceks_knowledge_entries?.title}</td>
                <td>{it.ceks_knowledge_entries?.brand || "—"}</td>
                <td><Cell value={it.qty} disabled={!canManage} onSave={(v) => patch(it.id, { qty: Number(v) })} width={50} /></td>
                <td><Cell value={it.area} disabled={!canManage} onSave={(v) => patch(it.id, { area: v })} /></td>
                <td><Cell value={it.section} disabled={!canManage} onSave={(v) => patch(it.id, { section: v })} /></td>
                <td><Cell value={it.room} disabled={!canManage} onSave={(v) => patch(it.id, { room: v })} /></td>
                <td><Cell value={it.zone} disabled={!canManage} onSave={(v) => patch(it.id, { zone: v })} /></td>
                <td><Cell value={it.notes} disabled={!canManage} onSave={(v) => patch(it.id, { notes: v })} /></td>
                <td className="rowacts">
                  {canManage && <button className="btn small ghost" onClick={() => { setReplacing(it.id); setResults(null); }}>Replace</button>}
                  {canManage && <button className="x" title="Remove from project" onClick={async () => { if (confirm("Remove this item from the project?")) { await api.removeProjectItem(project.id, it.id); reload(); } }}>×</button>}
                </td>
              </tr>
            ))}
            {!active.length && <tr><td colSpan={10} className="muted">No equipment yet — search the approved catalog above.</td></tr>}
          </tbody>
        </table>
      </div>

      {replaced.length > 0 && (
        <>
          <h2 style={{ marginTop: 16 }}>Replaced items (history)</h2>
          <div className="scroll-x">
            <table className="grid muted">
              <thead><tr><th>Item No.</th><th>Equipment</th><th>Qty</th></tr></thead>
              <tbody>
                {replaced.map((it) => (
                  <tr key={it.id}><td>{it.item_number}</td><td>{it.ceks_knowledge_entries?.title}</td><td>{it.qty}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Cell({ value, onSave, disabled, width }) {
  if (disabled) return <>{value ?? "—"}</>;
  return (
    <input defaultValue={value ?? ""} style={{ width: width || 110 }}
      onBlur={(e) => { if (e.target.value !== String(value ?? "")) onSave(e.target.value); }} />
  );
}

// ═══════════════════════════════ SCHEDULES ═══════════════════════════════════
function SchedulesTab({ project }) {
  const [types, setTypes] = useState(null);
  const [code, setCode] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const canExport = session.can("project.export");
  const printRef = useRef(null);

  useEffect(() => {
    api.scheduleTypes().then((t) => { setTypes(t); if (t.length) setCode(t[0].code); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!code) return;
    setData(null);
    api.schedule(project.id, code).then(setData).catch((e) => setError(e.message));
  }, [code, project.id]);

  function printIt() {
    const w = window.open("", "_blank");
    w.document.write(`<html><head><title>${data.project.name} — ${data.schedule.name}</title>
      <style>body{font-family:Arial,sans-serif;font-size:11px;margin:24px}h1{font-size:16px;margin:0}h2{font-size:12px;color:#555;margin:4px 0 12px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px 6px;text-align:left}th{background:#eee}
      tfoot td{font-weight:bold;background:#f6f6f6}</style></head><body>
      <h1>${data.project.name}${data.project.code ? " (" + data.project.code + ")" : ""}</h1>
      <h2>${data.schedule.name} — Revision ${data.project.revision ?? 1} — ${new Date(data.generated_at).toLocaleString()}</h2>
      ${printRef.current.outerHTML}</body></html>`);
    w.document.close(); w.print();
  }

  if (error) return <div className="alert">{error}</div>;
  if (!types) return <div className="muted">Loading…</div>;

  return (
    <div className="group">
      <div className="filter-row">
        <select value={code} onChange={(e) => setCode(e.target.value)}>
          {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
        </select>
        {canExport && data && (
          <>
            <button className="btn small" onClick={() => api.exportSchedule(project.id, code, "xlsx").catch((e) => setError(e.message))}>Excel</button>
            <button className="btn small" onClick={() => api.exportSchedule(project.id, code, "csv").catch((e) => setError(e.message))}>CSV</button>
            <button className="btn small" onClick={printIt}>Print / PDF</button>
            <span className="sep" />
            <button className="btn small" onClick={() => api.exportAllSchedules(project.id).catch((e) => setError(e.message))}>All 13 → one Excel</button>
            <button className="btn small" onClick={() => api.exportAutocad(project.id, "xlsx").catch((e) => setError(e.message))}>AutoCAD schedule</button>
            <button className="btn small" onClick={() => api.exportCoordinates(project.id, "xlsx").catch((e) => setError(e.message))}>Coordinates</button>
          </>
        )}
      </div>

      {!data ? <div className="muted">Generating…</div> : (
        <div className="scroll-x">
          <table className="grid" ref={printRef}>
            <thead><tr>{data.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>{data.columns.map((c) => <td key={c.key}>{r[c.key] ?? ""}</td>)}</tr>
              ))}
              {!data.rows.length && <tr><td colSpan={data.columns.length} className="muted">No active equipment in this project.</td></tr>}
            </tbody>
            {Object.keys(data.totals || {}).length > 0 && (
              <tfoot>
                <tr>{data.columns.map((c, i) => <td key={c.key}><b>{i === 0 ? "TOTAL" : data.totals[c.key] ?? ""}</b></td>)}</tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════ MEP POINTS ══════════════════════════════════
function PointsTab({ project }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const canExport = session.can("project.export");

  useEffect(() => { api.mepPoints(project.id).then(setData).catch((e) => setError(e.message)); }, [project.id]);

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <div className="muted">Deriving required points from equipment data…</div>;

  return (
    <div className="group">
      <div className="filter-row">
        <span className="muted">Points are derived from each item's manufacturer data and CULINOVA recommendations — nothing is invented.</span>
        {canExport && (
          <>
            <button className="btn small" onClick={() => api.exportMepPoints(project.id, "xlsx").catch((e) => setError(e.message))}>Excel</button>
            <button className="btn small" onClick={() => api.exportMepPoints(project.id, "csv").catch((e) => setError(e.message))}>CSV</button>
          </>
        )}
      </div>
      {data.items.map((it) => (
        <div key={it.item_id} style={{ marginBottom: 14 }}>
          <h2>{it.item_number} — {it.equipment} <span className="muted">×{it.qty}{it.area ? ` · ${it.area}` : ""}</span></h2>
          {!it.points.length ? <div className="muted" style={{ marginLeft: 8 }}>No utility data on this item yet.</div> : (
            <div className="scroll-x">
              <table className="grid">
                <thead><tr><th>Point ID</th><th>Utility</th><th>Value</th><th>Height</th><th>Notes</th><th>Source</th></tr></thead>
                <tbody>
                  {it.points.map((p) => (
                    <tr key={p.point_id}>
                      <td className="mono">{p.point_id}</td>
                      <td><span className="swatch" style={{ background: p.color }} /> {p.symbol} {p.label}</td>
                      <td>{p.value || "—"}</td>
                      <td>{p.height || "—"}</td>
                      <td>{p.note || "—"}</td>
                      <td><span className={"pill " + (p.source === "culinova" ? "culinova" : "")}>{p.source || "—"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      {!data.items.length && <div className="muted">No equipment in this project yet.</div>}
    </div>
  );
}

// ═══════════════════════════════ DRAWINGS ════════════════════════════════════
function DrawingsTab({ project, canManage, reload, onOpen }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function uploadFile(file) {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const d = await api.uploadDrawing(project.id, file);
      reload();
      onOpen(d.id);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="group">
      {error && <div className="alert">{error}</div>}
      {canManage && (
        <div className="add-row">
          <input ref={fileRef} type="file" accept="application/pdf,image/*" onChange={(e) => uploadFile(e.target.files?.[0])} />
          {busy && <span className="muted">Uploading…</span>}
        </div>
      )}
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Drawing</th><th>Type</th><th>Revision</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {project.drawings.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td><td>{d.kind}</td><td>R{d.revision ?? 1}</td>
                <td>{d.updated_at ? new Date(d.updated_at).toLocaleString() : "—"}</td>
                <td className="rowacts">
                  <button className="btn small ghost" onClick={() => onOpen(d.id)}>Open editor</button>
                  {canManage && <button className="x" onClick={async () => { if (confirm(`Delete drawing "${d.name}" and all its annotations?`)) { await api.deleteDrawing(d.id); reload(); } }}>×</button>}
                </td>
              </tr>
            ))}
            {!project.drawings.length && <tr><td colSpan={5} className="muted">Upload a PDF or image plan to start annotating.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════ REPORT ══════════════════════════════════════
function ReportTab({ project }) {
  const [report, setReport] = useState(null);
  const [area, setArea] = useState("");
  const [error, setError] = useState("");
  const printRef = useRef(null);

  const areas = [...new Set(project.items.map((i) => i.area).filter(Boolean))];

  useEffect(() => {
    setReport(null);
    api.projectReport(project.id, area ? { area } : {}).then(setReport).catch((e) => setError(e.message));
  }, [project.id, area]);

  function printIt() {
    const w = window.open("", "_blank");
    w.document.write(`<html><head><title>${report.project.name} — Engineering Report</title>
      <style>body{font-family:Arial,sans-serif;font-size:11px;margin:24px;color:#111}
      h1{font-size:18px;margin:0}h2{font-size:13px;margin:16px 0 4px;border-bottom:2px solid #333;padding-bottom:2px}
      h3{font-size:12px;margin:10px 0 4px;color:#333}
      table{border-collapse:collapse;width:100%;margin:4px 0}th,td{border:1px solid #999;padding:3px 6px;text-align:left;font-size:10px}
      th{background:#eee}.meta{color:#555;font-size:11px;margin-bottom:12px}.miss{color:#b00}
      .pagebreak{page-break-before:always}</style></head><body>
      <h1>Engineering Report — ${report.project.name}${report.project.code ? " (" + report.project.code + ")" : ""}</h1>
      <div class="meta">Client: ${report.project.client || "—"} · Location: ${report.project.location || "—"} ·
      Revision R${report.project.revision ?? 1} · Generated ${new Date(report.generated_at).toLocaleString()} by ${report.generated_by} · ${report.item_count} item(s)</div>
      ${printRef.current.innerHTML}</body></html>`);
    w.document.close(); w.print();
  }

  if (error) return <div className="alert">{error}</div>;
  if (!report) return <div className="muted">Building report…</div>;

  return (
    <div className="group">
      <div className="filter-row">
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">Whole project</option>
          {areas.map((a) => <option key={a} value={a}>Area: {a}</option>)}
        </select>
        <button className="btn small" onClick={printIt}>Print / PDF</button>
        <span className="muted">{report.item_count} item(s)</span>
      </div>

      <div ref={printRef}>
        {report.items.map((it) => (
          <div key={it.equipment.id + it.item_number} style={{ marginBottom: 20 }} className="report-item">
            <h2>{it.item_number} — {it.equipment.title} <span className="muted">×{it.qty}{it.area ? ` · ${it.area}` : ""}</span></h2>

            {it.missing_information.length > 0 && (
              <div className="warn">
                ⚠ Missing information: {it.missing_information.map((m) => m.message).join(" · ")}
              </div>
            )}

            <h3>Manufacturer technical data</h3>
            <table className="grid"><tbody>
              {it.manufacturer_data.slice(0, 40).map((a, i) => (
                <tr key={i}><td style={{ width: 220 }}>{a.name}</td><td>{a.value ?? ""} {a.unit ?? ""}</td><td className="muted">{a.source || ""}</td></tr>
              ))}
            </tbody></table>

            {it.culinova_recommendations.length > 0 && <h3>CULINOVA engineering recommendations</h3>}
            {it.culinova_recommendations.map((d, i) => (
              <table className="grid" key={i}>
                <thead><tr><th colSpan={4}>{d.discipline}</th></tr></thead>
                <tbody>
                  {d.rows.map((r, k) => (
                    <tr key={k}>
                      <td style={{ width: 200 }}>{r.parameter}</td>
                      <td><b>{r.culinova_value ?? "—"} {r.unit ?? ""}</b></td>
                      <td className="muted">Manufacturer: {r.manufacturer_value ?? "—"} {r.manufacturer_unit ?? ""}</td>
                      <td className="muted">{r.traceability || ""} · {r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}

            {it.mep_points.length > 0 && (
              <>
                <h3>Required MEP points</h3>
                <table className="grid"><tbody>
                  {it.mep_points.map((p, i) => (
                    <tr key={i}>
                      <td style={{ width: 140 }}><span className="swatch" style={{ background: p.color }} /> {p.symbol} {p.label}</td>
                      <td>{p.value || "—"}</td><td>{p.height || ""}</td><td className="muted">{p.note || ""}</td>
                    </tr>
                  ))}
                </tbody></table>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════ AI ASSISTANT ════════════════════════════════
function AssistantTab({ project }) {
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);

  async function ask(q) {
    const text = (q || question).trim();
    if (!text || busy) return;
    setBusy(true);
    setThread((t) => [...t, { role: "user", text }]);
    setQuestion("");
    try {
      const r = await api.askProject(project.id, text);
      setThread((t) => [...t, { role: "ai", text: r.answer }]);
    } catch (e) {
      setThread((t) => [...t, { role: "ai", text: `Error: ${e.message}` }]);
    } finally { setBusy(false); }
  }

  const quick = [
    "Summarize the MEP requirements of this project by discipline.",
    "Which items are missing information needed for engineering?",
    "Generate an installation summary grouped by area.",
    "List every item that needs a gas connection with pipe size and isolation valve.",
  ];

  return (
    <div className="group">
      <p className="hint">Answers use only this project's approved equipment data and CULINOVA recommendations, and always name the item and rule they come from.</p>
      <div className="quick-row">
        {quick.map((q) => <button key={q} className="btn small ghost" onClick={() => ask(q)}>{q}</button>)}
      </div>
      <div className="chat">
        {thread.map((m, i) => (
          <div key={i} className={"bubble " + m.role}><pre>{m.text}</pre></div>
        ))}
        {busy && <div className="bubble ai muted">Thinking…</div>}
      </div>
      <div className="add-row">
        <input placeholder="Ask about this project's engineering…" value={question} style={{ flex: 1 }}
          onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} />
        <button className="btn primary small" disabled={busy || !question.trim()} onClick={() => ask()}>Ask</button>
      </div>
    </div>
  );
}
