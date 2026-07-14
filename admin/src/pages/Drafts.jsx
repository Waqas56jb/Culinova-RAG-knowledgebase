import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { PageLoader } from "../components/Loader.jsx";
<<<<<<< HEAD
import ConfirmModal from "../components/ConfirmModal.jsx";
=======
>>>>>>> bc87eb820bc0f636a95c3d98dfef902ce9843d54
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
  const [searchText, setSearchText] = useState(f.search || ""); // immediate input value, debounced into f.search
  const [modal, setModal] = useState(null);   // { type: "bulk-approve" } | { type: "delete", item }
  const [busy, setBusy] = useState(false);     // modal action in flight
  const [notice, setNotice] = useState(null);  // bulk-approve result: { approved, total }
  const reqId = useRef(0);                      // guards against out-of-order responses

  // dependent filters: narrow options by the current category → brand → type selection
  useEffect(() => {
    api.adminFilters({ category: f.category, brand: f.brand, equipment_type: f.equipment_type }).then(setFilters).catch(() => {});
  }, [f.category, f.brand, f.equipment_type]);

  // debounce the search box ~300ms before it feeds the load effect, so typing
  // doesn't fire a request on every keystroke
  useEffect(() => {
    const t = setTimeout(() => {
      setF((x) => (x.search === searchText ? x : { ...x, search: searchText }));
    }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  function load(p = 1, append = false) {
    const myId = ++reqId.current;
    setLoading(true); setError("");
    const params = { ...f, page: p, limit: 25 };
    Object.keys(params).forEach((k) => params[k] === "" && delete params[k]);
    api.adminEntries(params)
      .then((r) => {
        if (myId !== reqId.current) return;   // a newer request superseded this one — drop the stale response
        setItems((prev) => (append ? [...prev, ...r.items] : r.items));
        setTotal(r.total); setPage(p);
      })
      .catch((e) => { if (myId === reqId.current) setError(e.message); })
      .finally(() => { if (myId === reqId.current) setLoading(false); });
  }
  useEffect(() => { setSel(new Set()); setNotice(null); load(1, false); /* eslint-disable-next-line */ }, [JSON.stringify(f)]);

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

  // approve every selected model, then surface the server's { approved, total }
  async function bulkApproveConfirmed() {
    const ids = [...sel];
    if (!ids.length) return;
    setBusy(true); setError("");
    try {
      const r = await api.bulkApprove(ids);
      setModal(null);
      setSel(new Set());
      setNotice({ approved: r.approved ?? 0, total: r.total ?? ids.length });
      load(1, false);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function removeConfirmed(it) {
    setBusy(true); setError("");
    try {
      await api.deleteEntry(it.id);
      setItems((xs) => xs.filter((x) => x.id !== it.id));
      setTotal((t) => Math.max(0, t - 1));
      setModal(null);
    } catch (e) { setError(`Could not delete "${it.title}": ${e.message}`); } finally { setBusy(false); }
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
        <input className="search-input" placeholder="Search model, brand, code…" aria-label="Search models" value={searchText}
          onChange={(e) => setSearchText(e.target.value)} />
        <select value={f.status} onChange={(e) => setField("status", e.target.value)} aria-label="Filter by status">
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
          <button className="btn small primary" onClick={() => { setNotice(null); setError(""); setModal({ type: "bulk-approve" }); }}>Approve selected</button>
          <button className="btn small ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

<<<<<<< HEAD
      {notice && (
        <div className={notice.approved >= notice.total ? "notice" : "alert soft"} role="status">
          {notice.approved} of {notice.total} approved
          {notice.approved < notice.total && <> — <strong>{notice.total - notice.approved} failed</strong>. Failed models remain in the list to retry.</>}
        </div>
      )}

      {error && <div className="alert" role="alert">{error}</div>}
=======
      {error && <div className="alert">{error}</div>}
>>>>>>> bc87eb820bc0f636a95c3d98dfef902ce9843d54
      {!loading && !items.length && (
        <EmptyState icon="📦" title="No models found" text="Try changing your filters or import new equipment." />
      )}

      {items.length > 0 && (
        <div className="scroll-x">
          <table className="grid lib">
            <thead>
              <tr>
                <th className="narrow"><input type="checkbox" aria-label="Select all models" checked={sel.size === items.length && items.length > 0} onChange={toggleAll} /></th>
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
                  <td className="narrow"><input type="checkbox" aria-label={`Select ${it.model_number || it.title}`} checked={sel.has(it.id)} onChange={() => toggle(it.id)} /></td>
                  <td>{it.brand || "—"}</td>
                  <td><button className="model-link" onClick={() => onOpen(it.id)}>{it.model_number || it.title}</button></td>
                  <td>{it.category || "—"}</td>
                  <td>{it.equipment_type || "—"}</td>
                  <td>{it.power_type ? <span className={"power " + it.power_type.toLowerCase()}>{it.power_type}</span> : "—"}</td>
                  <td><span className={"badge " + it.current_status}>{STATUS_LABEL[it.current_status] || it.current_status}</span></td>
                  <td className="narrow"><button className="x" title="Delete" aria-label={`Delete ${it.model_number || it.title}`} onClick={() => { setError(""); setModal({ type: "delete", item: it }); }}>×</button></td>
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
<<<<<<< HEAD

      {modal?.type === "bulk-approve" && (
        <ConfirmModal
          title={`Approve ${sel.size} selected model${sel.size === 1 ? "" : "s"}?`}
          message="Approving publishes each selected model to the ERP as approved engineering knowledge and makes it visible in the public portal."
          confirmLabel="Approve selected"
          busy={busy}
          error={error}
          onConfirm={bulkApproveConfirmed}
          onCancel={() => { if (!busy) { setModal(null); setError(""); } }}
        />
      )}
      {modal?.type === "delete" && (
        <ConfirmModal
          title="Delete model?"
          message={`Delete "${modal.item.title}"? This permanently removes the model and its extracted data.`}
          confirmLabel="Delete model"
          danger
          busy={busy}
          error={error}
          onConfirm={() => removeConfirmed(modal.item)}
          onCancel={() => { if (!busy) { setModal(null); setError(""); } }}
        />
      )}
=======
>>>>>>> bc87eb820bc0f636a95c3d98dfef902ce9843d54
    </PagePanel>
  );
}
