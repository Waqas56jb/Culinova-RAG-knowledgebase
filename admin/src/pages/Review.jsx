import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import MEPDiagram from "../components/MEPDiagram.jsx";
import AIAssistant from "../components/AIAssistant.jsx";

const SECTIONS = [
  ["technical_specification", "Technical Specifications"],
  ["electrical", "Electrical Design"],
  ["water_drain", "Water / Drain Requirements"],
  ["gas", "Gas Requirements"],
  ["ventilation", "Ventilation Requirements"],
  ["dimensions_clearance", "Dimensions & Clearances"],
  ["connection_point", "MEP Connection Points"],
  ["installation", "Installation Requirements"],
  ["other", "Other"],
];

// Canonical engineering checklist (from the engineering requirements). Every field below
// is ALWAYS shown for its section — filled from extracted data, or left blank for the
// engineer to complete. { photo:true } fields accept a component photo upload.
const REQUIRED_FIELDS = {
  technical_specification: ["Capacity", "Material", "Operating Temperature"],
  electrical: [
    "Voltage", "Frequency", "Total Power",
    "Socket Type", "Socket Rating", "Socket Installation Height (from finished floor)", { name: "Socket Photo", photo: true },
    "Isolator Switch Type", "Isolator Switch Rating", "Isolator Installation Height (from finished floor)", { name: "Isolator Switch Photo", photo: true },
    "Recommended Cable Size", "Recommended Circuit Breaker",
    "Cable Entry Location (Bottom / Rear / Top)", "Electrical Connection Position",
  ],
  water_drain: [
    "Cold Water Connection Type", "Cold Water Diameter", "Cold Water Height (from finished floor)",
    "Hot Water Connection Type", "Hot Water Diameter", "Hot Water Height (from finished floor)",
    "Drain Connection Type", "Drain Diameter", "Drain Height (from finished floor)", "Drain Method (Gravity / Pumped)",
  ],
  gas: [
    "Gas Connection Diameter", "Gas Connection Height (from finished floor)",
    "Gas Type (NG / LPG)", "Required Gas Pressure", "Gas Consumption",
  ],
  ventilation: [
    "Exhaust Airflow (CFM or m³/h)", "Fresh Air Requirement", "Heat Rejection", "Steam Exhaust Requirement", "Hood Requirement",
  ],
  dimensions_clearance: [
    "Overall Dimensions", "Machine Weight",
    "Rear Clearance", "Left Clearance", "Right Clearance", "Top Clearance", "Front Service Clearance", "Floor Fixing Requirements",
  ],
  connection_point: [],
  installation: ["Indoor / Outdoor", "Floor Requirements", "Mounting"],
  other: [],
};
const REQ_LABEL = (f) => (typeof f === "string" ? f : f.name);
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const fieldMatch = (attrName, canonical) => {
  const a = normName(attrName), c = normName(canonical);
  if (!a || !c) return false;
  return a === c || a.startsWith(c) || c.startsWith(a);
};

export default function Review({ id, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [docMap, setDocMap] = useState({});
  const [history, setHistory] = useState([]);

  function load() {
    setError("");
    api.entry(id)
      .then((data) => {
        setD(data);
        const m = {};
        (data.documents || []).forEach((doc) => (m[doc.id] = doc));
        setDocMap(m);
      })
      .catch((e) => setError(e.message));
    api.history(id).then((r) => setHistory(r.history || [])).catch(() => {});
  }
  useEffect(load, [id]);

  async function saveAttr(a, patch) {
    try {
      await api.patchAttr(a.id, patch);
      setD((prev) => ({
        ...prev,
        attributes: prev.attributes.map((x) => (x.id === a.id ? { ...x, ...patch } : x)),
      }));
    } catch (e) { setError(e.message); }
  }

  async function removeAttr(a) {
    if (!confirm(`Delete "${a.name}"?`)) return;
    await api.deleteAttr(a.id);
    setD((prev) => ({ ...prev, attributes: prev.attributes.filter((x) => x.id !== a.id) }));
  }

  // fill a blank required field → create the attribute
  async function addAttr(attr_group, name, value, unit) {
    try {
      const r = await api.createAttr(id, { attr_group, name, value: value || null, unit: unit || null });
      setD((prev) => ({ ...prev, attributes: [...(prev.attributes || []), r.attribute] }));
    } catch (e) { setError(e.message); }
  }

  // attach a component photo to a field (create the field first if it doesn't exist yet)
  async function uploadPhoto(attr_group, name, existing, file) {
    setBusy(true); setError("");
    try {
      let attr = existing;
      if (!attr) attr = (await api.createAttr(id, { attr_group, name })).attribute;
      await api.attrPhoto(attr.id, file);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function doAction(action) {
    let comment = "";
    if (action === "reject") { comment = prompt("Reason for rejection:") || ""; }
    setBusy(true); setError("");
    try {
      await api[action](id, comment);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  function fileUrl(storageUrl) {
    if (!storageUrl) return "";
    return /^https?:\/\//.test(storageUrl) ? storageUrl : `${api.base}${storageUrl}`;
  }

  function sourceLink(a) {
    const doc = a.source_document_id && docMap[a.source_document_id];
    const label = a.source_document || (doc && doc.file_name) || "—";
    if (!doc || !a.source_page) return <span className="src none">{label}{a.source_page ? `, p.${a.source_page}` : ""}</span>;
    const href = `${fileUrl(doc.storage_url)}#page=${a.source_page}`;
    return (
      <a className="src" href={href} target="_blank" rel="noreferrer" title="Open source page">
        {label}, p.{a.source_page}
      </a>
    );
  }

  if (error) return <div className="panel"><button className="btn small" onClick={onBack}>← Back</button><div className="alert">{error}</div></div>;
  if (!d) return <div className="panel"><div className="muted">Loading…</div></div>;

  const groups = {};
  (d.attributes || []).forEach((a) => { (groups[a.attr_group] = groups[a.attr_group] || []).push(a); });
  const status = d.entry.current_status;
  const canDecide = status === "draft" || status === "under_review";

  return (
    <div className="panel">
      <button className="btn small ghost" onClick={onBack}>← Back to queue</button>

      <EquipmentProfile d={d} status={status} fileUrl={fileUrl} entryId={id} onSaved={load} />

      <p className="hint">Every engineering field is listed below — filled from the source, or left blank for you to complete. Blank fields show <span className="missing-pill">Missing</span>; type a value (or upload a photo) to add it. Click a source to open that page and verify, then approve.</p>

      {SECTIONS.filter(([key]) => (REQUIRED_FIELDS[key] || []).length > 0 || groups[key]?.length).map(([key, label]) => (
        <SectionTable
          key={key} sectionKey={key} label={label} rows={groups[key] || []}
          saveAttr={saveAttr} removeAttr={removeAttr} addAttr={addAttr} uploadPhoto={uploadPhoto}
          sourceLink={sourceLink} fileUrl={fileUrl}
        />
      ))}

      {d.notes?.length > 0 && (
        <div className="group">
          <h2>Engineering Notes</h2>
          {d.notes.map((n) => (
            <div key={n.id} className="note">
              {n.note_type && <span className="pill">{n.note_type}</span>}
              <span>{n.content}</span>
              {n.source_page && <span className="src none"> — {n.source_document}, p.{n.source_page}</span>}
            </div>
          ))}
        </div>
      )}

      {groups.electrical || groups.water_drain || groups.gas || groups.ventilation || groups.connection_point ? (
        <div className="group">
          <h2>MEP Connection Layout</h2>
          <div className="mep-wrap"><MEPDiagram groups={groups} title={d.entry.title} /></div>
        </div>
      ) : null}

      <CADPreview documents={d.documents} files={d.files} fileUrl={fileUrl} />

      <FindDocuments entryId={id} />

      <div className="group">
        <h2>AI Engineering Assistant</h2>
        <AIAssistant entryId={id} />
      </div>

      {history.length > 0 && (
        <div className="group">
          <h2>Approval History</h2>
          <div className="history">
            {history.map((h) => (
              <div key={h.id} className="hist-row">
                <span className={"badge " + h.to_status}>{(h.to_status || "").replace("_", " ")}</span>
                <span className="muted">{h.from_status ? `from ${h.from_status}` : "created"}</span>
                {h.comment && <span>· {h.comment}</span>}
                <span className="muted hist-time">{new Date(h.changed_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {canDecide && (
        <div className="decision">
          <button className="btn primary" disabled={busy} onClick={() => doAction("approve")}>Approve</button>
          {status === "draft" && <button className="btn" disabled={busy} onClick={() => doAction("submit")}>Submit for review</button>}
          <button className="btn danger" disabled={busy} onClick={() => doAction("reject")}>Reject</button>
        </div>
      )}
    </div>
  );
}

function ConfBadge({ c }) {
  const cls = c >= 0.8 ? "hi" : c >= 0.5 ? "mid" : "lo";
  return <span className={"conf " + cls}>{Math.round(c * 100)}%</span>;
}

// Renders a full section: canonical required fields (filled or blank) + any extra extracted fields.
function SectionTable({ sectionKey, label, rows, saveAttr, removeAttr, addAttr, uploadPhoto, sourceLink, fileUrl }) {
  const req = REQUIRED_FIELDS[sectionKey] || [];
  const used = new Array(rows.length).fill(false);
  const out = [];
  for (const f of req) {
    const name = REQ_LABEL(f);
    const isPhoto = typeof f === "object" && f.photo;
    const matched = rows.map((a, i) => ({ a, i })).filter(({ a, i }) => !used[i] && fieldMatch(a.name, name));
    if (matched.length) { matched.forEach(({ i }) => (used[i] = true)); matched.forEach(({ a }) => out.push({ kind: "attr", a, photo: isPhoto })); }
    else out.push({ kind: "missing", name, photo: isPhoto });
  }
  rows.forEach((a, i) => { if (!used[i]) out.push({ kind: "attr", a, extra: true }); });

  const filled = out.filter((r) => r.kind === "attr" && (r.photo ? r.a.image_url : r.a.value)).length;

  return (
    <div className="group">
      <h2>{label} <span className="sec-count">{filled}/{out.length} filled</span></h2>
      <div className="scroll-x">
        <table className="grid attr">
          <thead>
            <tr><th>Field</th><th>Value</th><th>Unit</th><th>Source</th><th>Conf.</th><th></th></tr>
          </thead>
          <tbody>
            {out.map((r, idx) => {
              if (r.kind === "missing") {
                return (
                  <tr key={"m" + idx} className="missing">
                    <td><span className="field-name">{r.name}</span></td>
                    <td>
                      {r.photo
                        ? <PhotoCell attr={null} onPick={(file) => uploadPhoto(sectionKey, r.name, null, file)} fileUrl={fileUrl} />
                        : <input placeholder="Not specified — type to add" onBlur={(e) => { const v = e.target.value.trim(); if (v) addAttr(sectionKey, r.name, v); }} />}
                    </td>
                    <td className="narrow"></td>
                    <td>—</td>
                    <td className="narrow"><span className="missing-pill">Missing</span></td>
                    <td></td>
                  </tr>
                );
              }
              const a = r.a;
              return (
                <tr key={a.id} className={a.verified ? "verified" : ""}>
                  <td><input defaultValue={a.name} onBlur={(e) => e.target.value !== a.name && saveAttr(a, { name: e.target.value })} /></td>
                  <td>
                    {r.photo
                      ? <PhotoCell attr={a} onPick={(file) => uploadPhoto(sectionKey, a.name, a, file)} fileUrl={fileUrl} />
                      : <input defaultValue={a.value || ""} onBlur={(e) => e.target.value !== (a.value || "") && saveAttr(a, { value: e.target.value })} />}
                  </td>
                  <td className="narrow"><input defaultValue={a.unit || ""} onBlur={(e) => e.target.value !== (a.unit || "") && saveAttr(a, { unit: e.target.value })} /></td>
                  <td>{sourceLink(a)}</td>
                  <td className="narrow">{a.confidence != null ? <ConfBadge c={a.confidence} /> : "—"}</td>
                  <td className="rowacts">
                    <button className={"tick " + (a.verified ? "on" : "")} title="Mark verified" onClick={() => saveAttr(a, { verified: !a.verified })}>✓</button>
                    <button className="x" title="Delete" onClick={() => removeAttr(a)}>×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PhotoCell({ attr, onPick, fileUrl }) {
  const url = attr && attr.image_url;
  return (
    <div className="photo-cell">
      {url
        ? <a href={fileUrl(url)} target="_blank" rel="noreferrer"><img src={fileUrl(url)} alt="" className="attr-photo" /></a>
        : <span className="muted">No photo</span>}
      <label className="btn small ghost photo-btn">
        {url ? "Replace" : "Upload photo"}
        <input type="file" accept="image/*" hidden onChange={(e) => { const f = (e.target.files || [])[0]; if (f) onPick(f); e.target.value = ""; }} />
      </label>
    </div>
  );
}

const DOC_LABELS = {
  datasheet: "Datasheet", technical_data: "Technical Data", user_manual: "User Manual",
  installation_manual: "Installation Manual", service_manual: "Service Manual",
  spare_parts: "Spare Parts", document: "Document", cad: "CAD Drawing",
};

export function RelatedDocs({ documents, files, fileUrl }) {
  const all = [
    ...(documents || []).map((d) => ({ id: d.id, type: d.doc_type, name: d.file_name, url: d.storage_url })),
    ...(files || []).filter((f) => f.asset_type === "cad").map((f) => ({ id: f.id, type: "cad", name: f.file_name, url: f.storage_url, view: f.category_tag })),
  ];
  if (!all.length) return null;
  const order = ["datasheet", "technical_data", "user_manual", "installation_manual", "service_manual", "spare_parts", "cad", "document"];
  all.sort((a, b) => (order.indexOf(a.type) + 1 || 99) - (order.indexOf(b.type) + 1 || 99));
  return (
    <div className="profile-docs">
      <span className="ilabel">Related Documents ({all.length})</span>
      <div className="docs-list">
        {all.map((d) => (
          <a key={d.id} className="doc-chip" href={fileUrl(d.url)} target="_blank" rel="noreferrer">
            <span className={"doc-type t-" + d.type}>{d.type === "cad" ? (d.view || "CAD") : (DOC_LABELS[d.type] || d.type)}</span>
            <span className="doc-name">{d.name}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

export function CADPreview({ documents, files, fileUrl }) {
  const [open, setOpen] = useState(null);
  const docs = documents || [];
  const cads = (files || []).filter((f) => f.asset_type === "cad");
  const preview = open || docs.find((d) => d.doc_type === "datasheet") || docs[0];
  if (!preview && !cads.length) return null;
  return (
    <div className="group">
      <h2>Document Preview</h2>
      {preview && (
        <div className="preview">
          <div className="preview-tabs">
            {docs.map((doc) => (
              <button key={doc.id} className={"ptab " + (preview.id === doc.id ? "active" : "")} onClick={() => setOpen(doc)}>
                {DOC_LABELS[doc.doc_type] || doc.doc_type}
              </button>
            ))}
          </div>
          <iframe title="document preview" className="pdf-frame" src={fileUrl(preview.storage_url)} />
        </div>
      )}
      {cads.length > 0 && (
        <div className="cad-list">
          <span className="ilabel">Drawings & CAD Views</span>
          <div className="docs-list">
            {cads.map((c) => (
              <a key={c.id} className="doc-chip" href={fileUrl(c.storage_url)} target="_blank" rel="noreferrer">
                <span className="doc-type t-cad">{c.category_tag || "CAD"}</span><span className="doc-name">{c.file_name}</span>
              </a>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>DWG/STEP files open in your CAD software (AutoCAD, etc.).</div>
        </div>
      )}
    </div>
  );
}

function FindDocuments({ entryId }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run() { setBusy(true); try { setData(await api.findDocuments(entryId)); } catch {} finally { setBusy(false); } }
  return (
    <div className="group">
      <h2>Find Missing Documents</h2>
      <p className="muted">If manufacturer documents (datasheet, manuals, spare parts…) are missing, search trusted sources for this exact model.</p>
      <button className="btn small" disabled={busy} onClick={run}>{busy ? "Searching…" : "Find documents for this model"}</button>
      {data && (data.suggestions.length ? (
        <div className="docs-list" style={{ marginTop: 10 }}>
          {data.suggestions.map((s) => (
            <a key={s.doc_type} className="doc-chip" href={s.search_url} target="_blank" rel="noreferrer">
              <span className="doc-type t-cad">Search</span><span className="doc-name">{s.label}</span>
            </a>
          ))}
        </div>
      ) : <div className="muted" style={{ marginTop: 8 }}>All standard documents are already attached. ✓</div>)}
    </div>
  );
}

function IField({ label, value, mono }) {
  return (
    <div className="ifield">
      <span className="ilabel">{label}</span>
      <span className={"ival" + (mono ? " mono" : "")}>{value || "—"}</span>
    </div>
  );
}

function PowerPill({ value }) {
  if (!value) return <span className="ival">—</span>;
  return <span className={"power " + value.toLowerCase()}>{value}</span>;
}

const EDIT_FIELDS = [
  ["brand", "Brand"], ["category", "Category"], ["equipment_type", "Equipment Type"],
  ["series", "Series / Line"], ["model_number", "Model"],
];

export function EquipmentProfile({ d, status, fileUrl, entryId, onSaved }) {
  const m = d.model || {};
  const initial = (m.equipment_type || d.entry.title || "?").trim().slice(0, 1).toUpperCase();
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function startEdit() {
    setForm({ brand: m.brand || "", category: m.category || "", equipment_type: m.equipment_type || "", series: m.series || "", model_number: m.model_number || "", power_type: m.power_type || "", description: d.entry.summary || "" });
    setErr(""); setEdit(true);
  }
  async function save() {
    setSaving(true); setErr("");
    try { await api.updateIdentity(entryId, form); setEdit(false); onSaved && onSaved(); }
    catch (e) { setErr(e.message); } finally { setSaving(false); }
  }
  async function onImage(e) {
    const file = e.target.files?.[0]; if (!file || !entryId) return;
    try { await api.uploadImage(entryId, file); onSaved && onSaved(); } catch (er) { setErr(er.message); }
  }

  return (
    <section className="profile">
      <div className="profile-img">
        {m.image_url ? <img src={m.image_url} alt={d.entry.title} /> : <div className="img-ph"><span>{initial}</span></div>}
        {entryId && (
          <label className="img-replace" title="Replace product image">
            Replace<input type="file" accept="image/*" hidden onChange={onImage} />
          </label>
        )}
      </div>
      <div className="profile-body">
        <div className="profile-top">
          <div>
            <div className="eyebrow">Equipment Profile</div>
            <h1>{d.entry.title}</h1>
          </div>
          <div className="profile-top-right">
            {status && <span className={"badge big " + status}>{status.replace("_", " ")}</span>}
            {entryId && !edit && <button className="btn small ghost" onClick={startEdit}>Edit identity</button>}
          </div>
        </div>

        {edit ? (
          <div className="identity-edit">
            <div className="identity">
              {EDIT_FIELDS.map(([k, label]) => (
                <div key={k} className="ifield">
                  <span className="ilabel">{label}</span>
                  <input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
                </div>
              ))}
              <div className="ifield">
                <span className="ilabel">Power Type</span>
                <select value={form.power_type} onChange={(e) => setForm((f) => ({ ...f, power_type: e.target.value }))}>
                  <option value="">—</option><option>Electric</option><option>Gas</option><option>Neutral</option>
                </select>
              </div>
            </div>
            {err && <div className="alert">{err}</div>}
            <div className="actions">
              <button className="btn primary small" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save identity"}</button>
              <button className="btn small ghost" onClick={() => setEdit(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="identity">
            <IField label="Brand" value={m.brand} />
            <IField label="Category" value={m.category} />
            <IField label="Equipment Type" value={m.equipment_type} />
            <IField label="Series / Line" value={m.series} />
            <IField label="Model" value={m.model_number} mono />
            <div className="ifield">
              <span className="ilabel">Power Type</span>
              <PowerPill value={m.power_type} />
            </div>
          </div>
        )}
        <RelatedDocs documents={d.documents} files={d.files} fileUrl={fileUrl} />
      </div>
    </section>
  );
}
