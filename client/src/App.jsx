import React, { useEffect, useState } from "react";
import { api } from "./api.js";
import MEPDiagram from "./components/MEPDiagram.jsx";
import AIAssistant from "./components/AIAssistant.jsx";
import CADPreview from "./components/CADPreview.jsx";

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

// Canonical engineering checklist — every field is shown (filled or marked "—"), read-only.
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
  ventilation: ["Exhaust Airflow (CFM or m³/h)", "Fresh Air Requirement", "Heat Rejection", "Steam Exhaust Requirement", "Hood Requirement"],
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
// merge extracted rows against the canonical checklist → complete, ordered display rows
function buildSectionRows(sectionKey, rows) {
  const req = REQUIRED_FIELDS[sectionKey] || [];
  const used = new Array(rows.length).fill(false);
  const out = [];
  for (const f of req) {
    const name = REQ_LABEL(f);
    const isPhoto = typeof f === "object" && f.photo;
    const matched = rows.map((a, i) => ({ a, i })).filter(({ a, i }) => !used[i] && fieldMatch(a.name, name));
    if (matched.length) { matched.forEach(({ i }) => (used[i] = true)); matched.forEach(({ a }) => out.push({ a, photo: isPhoto })); }
    else out.push({ name, photo: isPhoto, missing: true });
  }
  rows.forEach((a, i) => { if (!used[i]) out.push({ a }); });
  return out;
}

export default function App() {
  const [view, setView] = useState({ name: "search" });
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => setView({ name: "search" })}>
          <span className="brand-main">CULINOVA EOS</span>
          <span className="brand-sub">Engineering Knowledge Portal</span>
        </div>
      </header>
      <main className="content">
        {view.name === "search" && <Search onOpen={(id) => setView({ name: "detail", id })} />}
        {view.name === "detail" && <Detail id={view.id} onBack={() => setView({ name: "search" })} />}
      </main>
      <footer className="foot">Approved engineering knowledge · read-only · single source of truth</footer>
    </div>
  );
}

function Search({ onOpen }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState([]);
  const [mode, setMode] = useState("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  function run(query, p = 1, append = false) {
    setLoading(true); setError("");
    api.search(query, p)
      .then((r) => {
        setItems((prev) => (append ? [...prev, ...r.items] : r.items));
        setTotal(r.total ?? r.items.length);
        setMode(r.mode);
        setPage(p);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { run("", 1, false); }, []);

  return (
    <div>
      <div className="hero">
        <h1>Search engineering knowledge</h1>
        <p className="muted">Find approved equipment models and their complete engineering records.</p>
        <form className="searchbar" onSubmit={(e) => { e.preventDefault(); run(q, 1, false); }}>
          <input placeholder="Search by model, brand, specification…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" type="submit">Search</button>
        </form>
        {mode === "semantic" && <div className="tag">AI semantic search</div>}
      </div>

      {error && <div className="alert">{error}</div>}
      {!loading && !items.length && <div className="muted center">No approved knowledge found.</div>}

      {items.length > 0 && (
        <div className="result-count muted">Showing {items.length} of {total} model{total === 1 ? "" : "s"}</div>
      )}

      <div className="cards">
        {items.map((it) => (
          <button key={it.id} className="card" onClick={() => onOpen(it.id)}>
            <div className="card-title">{it.title}</div>
            <div className="card-code mono">{it.code || ""}</div>
            <div className="card-go">View record →</div>
          </button>
        ))}
      </div>

      {loading && <div className="muted center">Loading…</div>}
      {!loading && items.length < total && (
        <div className="center">
          <button className="btn" onClick={() => run(q, page + 1, true)}>Load more</button>
        </div>
      )}
    </div>
  );
}

function fileUrl(u) {
  if (!u) return "";
  return /^https?:\/\//.test(u) ? u : `${api.base}${u}`;
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

const DOC_LABELS = {
  datasheet: "Datasheet", technical_data: "Technical Data", user_manual: "User Manual",
  installation_manual: "Installation Manual", service_manual: "Service Manual",
  spare_parts: "Spare Parts", document: "Document", cad: "CAD Drawing",
};

function RelatedDocs({ documents, files }) {
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

function EquipmentProfile({ d }) {
  const m = d.model || {};
  const initial = (m.equipment_type || d.entry.title || "?").trim().slice(0, 1).toUpperCase();
  return (
    <section className="profile">
      <div className="profile-img">
        {m.image_url ? <img src={m.image_url} alt={d.entry.title} /> : <div className="img-ph"><span>{initial}</span></div>}
      </div>
      <div className="profile-body">
        <div className="profile-top">
          <div>
            <div className="eyebrow">Equipment Profile</div>
            <h1>{d.entry.title}</h1>
          </div>
          <span className="badge approved">Approved</span>
        </div>
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
        {d.entry.summary && <p className="summary">{d.entry.summary}</p>}
        <RelatedDocs documents={d.documents} files={d.files} />

      </div>
    </section>
  );
}

function Detail({ id, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.detail(id).then(setD).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div><button className="btn ghost" onClick={onBack}>← Back</button><div className="alert">{error}</div></div>;
  if (!d) return <div className="muted center">Loading…</div>;

  const groups = {};
  (d.attributes || []).forEach((a) => { (groups[a.attr_group] = groups[a.attr_group] || []).push(a); });

  return (
    <div>
      <button className="btn ghost" onClick={onBack}>← Back to search</button>
      <EquipmentProfile d={d} />


      {SECTIONS.filter(([key]) => (REQUIRED_FIELDS[key] || []).length > 0 || groups[key]?.length).map(([key, label]) => {
        const outRows = buildSectionRows(key, groups[key] || []);
        return (
        <section key={key} className="rec-group">
          <h2>{label}</h2>
          <table className="spec">
            <tbody>
              {outRows.map((r, i) => (
                <tr key={r.a ? r.a.id : "m" + i} className={r.missing ? "missing" : ""}>
                  <td className="k">{r.a ? r.a.name : r.name}</td>
                  <td className="v">
                    {r.photo
                      ? (r.a && r.a.image_url
                          ? <a href={fileUrl(r.a.image_url)} target="_blank" rel="noreferrer"><img src={fileUrl(r.a.image_url)} alt="" className="attr-photo" /></a>
                          : <span className="muted">No photo</span>)
                      : (r.a ? <>{r.a.value || "—"} {r.a.unit || ""}</> : <span className="muted">—</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        );
      })}

      {d.notes?.length > 0 && (
        <section className="rec-group">
          <h2>Engineering Notes</h2>
          {d.notes.map((n) => <div key={n.id} className="note">{n.content}</div>)}
        </section>
      )}

      {(groups.electrical || groups.water_drain || groups.gas || groups.ventilation || groups.connection_point) && (
        <section className="rec-group">
          <h2>MEP Connection Layout</h2>
          <div className="mep-wrap"><MEPDiagram groups={groups} title={d.entry.title} /></div>
        </section>
      )}

      <CADPreview documents={d.documents} files={d.files} />

      <section className="rec-group">
        <h2>AI Engineering Assistant</h2>
        <AIAssistant entryId={id} />
      </section>
    </div>
  );
}
