import React, { useState, useMemo } from "react";
import { api } from "../api.js";
import { Btn } from "../components/Loader.jsx";
import { PageHero, PagePanel } from "../components/PageShell.jsx";
import BatchImport from "../components/BatchImport.jsx";

const DOC_TYPES = [
  ["datasheet", "Datasheet"],
  ["installation_manual", "Installation Manual"],
  ["maintenance_manual", "Maintenance Manual"],
  ["other", "Other Document"],
];

/* ---- read a drag&drop DataTransfer into [{file, path}], traversing folders ---- */
async function readDropped(dt) {
  const items = Array.from(dt.items || []).map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  const out = [];
  async function readAll(reader) {
    const all = []; let batch;
    do { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); all.push(...batch); } while (batch.length);
    return all;
  }
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const entries = await readAll(entry.createReader());
      for (const e of entries) await walk(e, prefix + entry.name + "/");
    }
  }
  for (const e of items) await walk(e, "");
  if (!out.length && dt.files) Array.from(dt.files).forEach((f) => out.push({ file: f, path: f.name }));
  return out;
}

export default function Upload({ onDone }) {
  const [mode, setMode] = useState("folder");
  return (
    <PagePanel accent="emerald">
      <PageHero
        accent="emerald"
        title="Import Knowledge"
        subtitle="Add equipment from folders, Excel, PDFs, or manual entry."
      />
      <div className="mode-tabs">
        <button className={mode === "folder" ? "mtab active" : "mtab"} onClick={() => setMode("folder")}>Folder / PDF (auto-organize)</button>
        <button className={mode === "excel" ? "mtab active" : "mtab"} onClick={() => setMode("excel")}>Excel Bulk Import</button>
        <button className={mode === "files" ? "mtab active" : "mtab"} onClick={() => setMode("files")}>Single PDF(s)</button>
        <button className={mode === "manual" ? "mtab active" : "mtab"} onClick={() => setMode("manual")}>Manual Entry</button>
      </div>
      {mode === "folder" && <FolderUpload onDone={onDone} />}
      {mode === "excel" && <BatchImport />}
      {mode === "files" && <SingleUpload onDone={onDone} />}
      {mode === "manual" && <ManualUpload onDone={onDone} />}
    </PagePanel>
  );
}

/* ---------------- Manual entry (typed profile) ---------------- */
const M_SECTIONS = [
  ["technical_specification", "Technical Specifications"],
  ["electrical", "Electrical Design"],
  ["water_drain", "Water / Drain"],
  ["gas", "Gas"],
  ["ventilation", "Ventilation"],
  ["dimensions_clearance", "Dimensions & Clearances"],
  ["connection_point", "MEP Connection Points"],
  ["installation", "Installation"],
];
const M_IDENTITY = [
  ["brand", "Brand *"], ["category", "Category *"], ["equipment_type", "Equipment Type *"],
  ["series", "Series / Line"], ["model_number", "Model *"],
];

function ManualUpload({ onDone }) {
  const [m, setM] = useState({ brand: "", category: "", equipment_type: "", series: "", model_number: "", power_type: "", description: "" });
  const [rows, setRows] = useState([{ attr_group: "technical_specification", name: "", value: "", unit: "" }]);
  const [notes, setNotes] = useState("");
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function setField(k, v) { setM((x) => ({ ...x, [k]: v })); }
  function setRow(i, k, v) { setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r))); }
  function addRow() { setRows((rs) => [...rs, { attr_group: rs[rs.length - 1]?.attr_group || "technical_specification", name: "", value: "", unit: "" }]); }
  function delRow(i) { setRows((rs) => rs.filter((_, idx) => idx !== i)); }

  async function submit() {
    if (!m.model_number.trim() || !m.brand.trim() || !m.category.trim() || !m.equipment_type.trim()) {
      setError("Brand, Category, Equipment Type and Model are required."); return;
    }
    setBusy(true); setError("");
    try {
      const attributes = rows.filter((r) => r.name.trim()).map((r) => ({ attr_group: r.attr_group, name: r.name.trim(), value: r.value.trim() || null, unit: r.unit.trim() || null }));
      const noteList = notes.split("\n").map((s) => s.trim()).filter(Boolean).map((content) => ({ content }));
      const r = await api.uploadManual({ model: m, attributes, notes: noteList });
      if (image) { try { await api.uploadImage(r.draft.entry_id, image); } catch {} }
      onDone(r.draft.entry_id);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <p className="muted">Enter an equipment profile by hand — for internal knowledge, standards, or items without a datasheet. Creates a Draft for review.</p>

      <div className="manual-top">
        <div className="manual-top-fields">
          <h2>Identity</h2>
      <div className="manual-identity">
        {M_IDENTITY.map(([k, label]) => (
          <div key={k} className="ifield"><span className="ilabel">{label}</span>
            <input value={m[k]} onChange={(e) => setField(k, e.target.value)} /></div>
        ))}
        <div className="ifield"><span className="ilabel">Power Type</span>
          <select value={m.power_type} onChange={(e) => setField("power_type", e.target.value)}>
            <option value="">—</option><option>Electric</option><option>Gas</option><option>Neutral</option>
          </select></div>
      </div>
      <div className="ifield" style={{ marginTop: 8 }}><span className="ilabel">Description</span>
        <input value={m.description} onChange={(e) => setField("description", e.target.value)} placeholder="Short description" /></div>
        </div>
        <div className="manual-image">
          <h2>Product Image</h2>
          <label className="img-picker">
            {image ? <img src={URL.createObjectURL(image)} alt="preview" />
              : <div className="img-picker-ph"><strong>Click to add image</strong><div className="muted">optional</div></div>}
            <input type="file" accept="image/*" hidden onChange={(e) => setImage((e.target.files || [])[0] || null)} />
          </label>
          {image && <button className="btn small ghost" onClick={() => setImage(null)}>Remove image</button>}
        </div>
      </div>

      <h2>Engineering Fields</h2>
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Section</th><th>Field</th><th>Value</th><th>Unit</th><th></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><select value={r.attr_group} onChange={(e) => setRow(i, "attr_group", e.target.value)}>
                  {M_SECTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                <td><input value={r.name} onChange={(e) => setRow(i, "name", e.target.value)} placeholder="e.g. Voltage" /></td>
                <td><input value={r.value} onChange={(e) => setRow(i, "value", e.target.value)} placeholder="e.g. 230" /></td>
                <td className="narrow"><input value={r.unit} onChange={(e) => setRow(i, "unit", e.target.value)} placeholder="V" /></td>
                <td className="narrow"><button className="x" onClick={() => delRow(i)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn small" onClick={addRow}>+ Add field</button>

      <h2>Engineering Notes</h2>
      <textarea className="manual-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="One note per line…" />

      {error && <div className="alert">{error}</div>}
      <div className="actions">
        <Btn className="primary" loading={busy} onClick={submit}>Create Draft</Btn>
      </div>
    </div>
  );
}

/* ---------------- Folder upload (drag & drop + picker) ---------------- */
function FolderUpload({ onDone }) {
  const [entries, setEntries] = useState([]); // {file, path}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState(null);
  const [drag, setDrag] = useState(false);

  const models = useMemo(() => {
    const groups = {};
    entries.forEach((e) => {
      const dir = e.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/") || "(root)";
      (groups[dir] = groups[dir] || []).push(e);
    });
    return Object.entries(groups)
      .filter(([, es]) => es.some((x) => x.file.name.toLowerCase().endsWith(".pdf")))
      .map(([dir, es]) => ({ dir, name: dir.split("/").slice(-2).join(" › "), files: es }));
  }, [entries]);

  function pick(e) { setEntries(Array.from(e.target.files || []).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); setResults(null); setError(""); }
  async function onDrop(e) {
    e.preventDefault(); setDrag(false);
    const dropped = await readDropped(e.dataTransfer);
    setEntries(dropped); setResults(null); setError("");
  }
  async function submit() {
    if (!entries.length) return;
    setBusy(true); setError(""); setResults(null);
    try { const r = await api.uploadFolder(entries); setResults(r.models || []); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <p className="muted">Drag & drop an equipment folder (a model, a brand, or the whole library) or click to choose. The system
        auto-identifies Category / Brand / Model, auto-classifies each document, extracts the <strong>product image from the PDF</strong>,
        and detects duplicates — no manual sorting.</p>

      <label className={"dropzone" + (drag ? " drag" : "")}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}>
        <input type="file" multiple hidden ref={(el) => { if (el) { el.webkitdirectory = true; el.directory = true; } }} onChange={pick} />
        <div><strong>Drag & drop a folder here, or click to choose</strong>
          <div className="muted">Whole EQUIPMENTS library, a brand folder, or a single model folder.</div></div>
      </label>

      {models.length > 0 && (
        <div className="scroll-x"><table className="grid"><thead><tr><th>Model folder</th><th>Files</th></tr></thead>
          <tbody>{models.map((m) => <tr key={m.dir}><td><strong>{m.name}</strong></td><td>{m.files.map((f) => f.file.name).join(", ")}</td></tr>)}</tbody></table></div>
      )}
      {error && <div className="alert">{error}</div>}
      {results && (
        <div className="results">
          <h2>Result — {results.filter((r) => r.ok).length}/{results.length} model(s)</h2>
          {results.map((r, i) => (
            <div key={i} className="result-row">
              {r.ok ? (<>
                <span className={"badge " + (r.versioned ? "under_review" : "approved")}>{r.versioned ? "Updated (duplicate)" : "New"}</span>
                <button className="linkish" onClick={() => onDone(r.entry_id)}>{r.title}</button>
                <span className="muted"> — {r.counts.attributes} fields · {r.counts.documents} docs · {r.counts.cad} CAD · {r.counts.image ? "image" : "no image"}</span>
              </>) : <span className="muted">✖ {r.folder}: {r.error}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="actions">
        <Btn className="primary" loading={busy} disabled={!models.length} onClick={submit}>
          {models.length ? `Extract & organize ${models.length} model(s)` : "Extract & organize"}
        </Btn>
      </div>
      {busy && <p className="muted">AI is reading each document, extracting the product image, and building the profiles…</p>}
    </div>
  );
}

/* ---------------- Single PDF upload ---------------- */
function SingleUpload({ onDone }) {
  const [files, setFiles] = useState([]);
  const [types, setTypes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);

  function take(list) { setFiles(list); setTypes(list.map(() => "datasheet")); setError(""); }
  function setType(i, val) { setTypes((t) => t.map((x, idx) => (idx === i ? val : x))); }
  function removeFile(i) { setFiles((fs) => fs.filter((_, idx) => idx !== i)); setTypes((t) => t.filter((_, idx) => idx !== i)); }
  async function submit() {
    if (!files.length) return;
    setBusy(true); setError("");
    try { const r = await api.uploadPdf(files, types); onDone(r.draft.entry_id); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <p className="muted">Upload one model's PDF(s) and choose the document type for each. Creates a Draft for review.</p>
      <label className={"dropzone" + (drag ? " drag" : "")}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); take(Array.from(e.dataTransfer.files || []).filter((f) => f.name.toLowerCase().endsWith(".pdf"))); }}>
        <input type="file" accept="application/pdf" multiple hidden onChange={(e) => take(Array.from(e.target.files || []))} />
        <div><strong>Drag & drop PDF(s), or click to choose</strong><div className="muted">One equipment model per upload.</div></div>
      </label>
      {files.length > 0 && (
        <div className="scroll-x"><table className="grid"><thead><tr><th>File</th><th>Document type</th><th></th></tr></thead>
          <tbody>{files.map((f, i) => (
            <tr key={i}><td>{f.name} <span className="muted">({Math.round(f.size / 1024)} KB)</span></td>
              <td><select value={types[i]} onChange={(e) => setType(i, e.target.value)}>{DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
              <td className="narrow"><button className="x" onClick={() => removeFile(i)}>×</button></td></tr>))}</tbody></table></div>
      )}
      {error && <div className="alert">{error}</div>}
      <div className="actions"><Btn className="primary" loading={busy} disabled={!files.length} onClick={submit}>Extract & create Draft</Btn></div>
    </div>
  );
}
