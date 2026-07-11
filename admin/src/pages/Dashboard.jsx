import React, { useEffect, useState } from "react";
import { api } from "../api.js";

export default function Dashboard({ onOpen }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminStats().then(setS).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="panel"><div className="alert">{error}</div></div>;
  if (!s) return <div className="panel"><div className="muted">Loading…</div></div>;

  const st = s.byStatus || {};
  const cards = [
    { label: "Total Models", value: s.total, cls: "navy", filter: { status: "all" } },
    { label: "Draft", value: st.draft || 0, cls: "grey", filter: { status: "draft" } },
    { label: "Under Review", value: st.under_review || 0, cls: "gold", filter: { status: "under_review" } },
    { label: "Approved", value: st.approved || 0, cls: "green", filter: { status: "approved" } },
    { label: "Rejected", value: st.rejected || 0, cls: "red", filter: { status: "rejected" } },
  ];

  return (
    <div className="panel">
      <h1>Dashboard</h1>
      <p className="muted">Click any card or chart item to open that list in the Knowledge Library.</p>
      <div className="stat-cards">
        {cards.map((c) => (
          <button key={c.label} className={"stat-card " + c.cls} onClick={() => onOpen({ status: "all", ...c.filter })}>
            <div className="stat-value">{c.value}</div>
            <div className="stat-label">{c.label}</div>
          </button>
        ))}
      </div>

      <div className="breakdowns">
        <Breakdown title="By Category" data={s.byCategory} field="category" onOpen={onOpen} />
        <Breakdown title="By Brand" data={s.byBrand} field="brand" onOpen={onOpen} />
        <Breakdown title="By Power Type" data={s.byPowerType} field="power_type" onOpen={onOpen} />
      </div>
    </div>
  );
}

function Breakdown({ title, data, field, onOpen }) {
  const entries = Object.entries(data || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="breakdown">
      <h2>{title}</h2>
      {entries.map(([k, v]) => (
        <button key={k} className="bar-row clickable" onClick={() => onOpen({ status: "all", [field]: k })}>
          <span className="bar-label">{k}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(v / max) * 100}%` }} /></div>
          <span className="bar-value">{v}</span>
        </button>
      ))}
    </div>
  );
}
