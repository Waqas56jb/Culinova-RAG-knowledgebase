import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { PageLoader } from "../components/Loader.jsx";
import { EmptyState, PageHero, PagePanel, StatPill } from "../components/PageShell.jsx";

const STATUS_LABEL = { draft: "Draft", under_review: "Under Review", approved: "Approved", rejected: "Rejected" };
const STATUS_OPTS = [["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["all", "All"]];

export default function Drafts({ onOpen, initialFilter }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ brand: [], category: [], equipment_type: [], power_type: [] });
  const [sel, setSel] = useState(new Set());
  const [f, setF] = useState({ search: "", status: "pending", brand: "", category: "", equipment_type: "", power_type: "", sort: "updated_at", order: "desc", ...(initialFilter || {}) });

  // dependent filters: narrow options by the current category → brand → type selection
  useEffect(() => {
    api.adminFilters({ category: f.category, brand: f.brand, equipment_type: f.equipment_type }).then(setFilters).catch(() => {});
  }, [f.category, f.brand, f.equipment_type]);

  function load(p = 1, append = false) {
    setLoading(true); setError("");
    const params = { ...f, page: p, limit: 25 };
    Object.keys(params).forEach((k) => params[k] === "" && delete params[k]);
    api.adminEntries(params)
      .then((r) => {
        setItems((prev) => (append ? [...prev, ...r.items] : r.items));
        setTotal(r.total); setPage(p);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { setSel(new Set()); load(1, false); /* eslint-disable-next-line */ }, [JSON.stringify(f)]);

  function setField(k, v) {
    setF((x) => {
      const n = { ...x, [k]: v };
      if (k === "category") { n.brand = ""; n.equipment_type = ""; n.power_type = ""; }
      if (k === "brand") { n.equipment_type = ""; n.power_type = ""; }
      if (k === "equipment_type") { n.power_type = ""; }
      return n;
    });
  }
  function sortBy(col) { setF((x) => ({ ...x, sort: col, order: x.sort === col && x.order === "desc" ? "asc" : "desc" })); }
  const sortArrow = (col) => (f.sort === col ? (f.order === "desc" ? " ↓" : " ↑") : "");

  function toggle(id) { setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleAll() { setSel((s) => (s.size === items.length ? new Set() : new Set(items.map((i) => i.id)))); }

  async function bulkApprove() {
    const ids = [...sel];
    if (!ids.length || !confirm(`Approve ${ids.length} selected model(s)?`)) return;
    await api.bulkApprove(ids);
    setSel(new Set()); load(1, false);
  }
  async function remove(it) {
    if (!confirm(`Delete "${it.title}"?`)) return;
    await api.deleteEntry(it.id);
    setItems((xs) => xs.filter((x) => x.id !== it.id));
  }

  const Dropdown = ({ k, label }) => (
    <select value={f[k]} onChange={(e) => setField(k, e.target.value)}>
      <option value="">{label}: All</option>
      {(filters[k] || []).map((v) => <option key={v} value={v}>{v}</option>)}
    </select>
  );

  return (
    <PagePanel accent="indigo">
      <PageHero
        accent="indigo"
        title="Knowledge Library"
        subtitle="Browse, filter and approve engineering equipment models."
        badge={<StatPill>{total} model{total === 1 ? "" : "s"}</StatPill>}
      />

      <div className="lib-toolbar">
        <input className="search-input" placeholder="Search model, brand, code…" value={f.search}
          onChange={(e) => setField("search", e.target.value)} />
        <select value={f.status} onChange={(e) => setField("status", e.target.value)}>
          {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <Dropdown k="category" label="Category" />
        <Dropdown k="brand" label="Brand" />
        <Dropdown k="equipment_type" label="Type" />
        <Dropdown k="power_type" label="Power" />
      </div>

      {sel.size > 0 && (
        <div className="bulkbar">
          <span>{sel.size} selected</span>
          <button className="btn small primary" onClick={bulkApprove}>Approve selected</button>
          <button className="btn small ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {error && <div className="alert">{error}</div>}
      {!loading && !items.length && (
        <EmptyState icon="📦" title="No models found" text="Try changing your filters or import new equipment." />
      )}

      {items.length > 0 && (
        <div className="scroll-x">
          <table className="grid lib">
            <thead>
              <tr>
                <th className="narrow"><input type="checkbox" checked={sel.size === items.length && items.length > 0} onChange={toggleAll} /></th>
                <th className="click" onClick={() => sortBy("brand")}>Brand{sortArrow("brand")}</th>
                <th className="click" onClick={() => sortBy("model_number")}>Model{sortArrow("model_number")}</th>
                <th className="click" onClick={() => sortBy("category")}>Category{sortArrow("category")}</th>
                <th>Type</th>
                <th>Power</th>
                <th className="click" onClick={() => sortBy("current_status")}>Status{sortArrow("current_status")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className={sel.has(it.id) ? "selrow" : ""}>
                  <td className="narrow"><input type="checkbox" checked={sel.has(it.id)} onChange={() => toggle(it.id)} /></td>
                  <td>{it.brand || "—"}</td>
                  <td><button className="model-link" onClick={() => onOpen(it.id)}>{it.model_number || it.title}</button></td>
                  <td>{it.category || "—"}</td>
                  <td>{it.equipment_type || "—"}</td>
                  <td>{it.power_type ? <span className={"power " + it.power_type.toLowerCase()}>{it.power_type}</span> : "—"}</td>
                  <td><span className={"badge " + it.current_status}>{STATUS_LABEL[it.current_status] || it.current_status}</span></td>
                  <td className="narrow"><button className="x" title="Delete" onClick={() => remove(it)}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && <PageLoader label="Loading library…" />}
      {!loading && items.length < total && (
        <div className="center"><button className="btn" onClick={() => load(page + 1, true)}>Load more</button></div>
      )}
    </PagePanel>
  );
}
