import React, { useEffect, useState } from "react";
import { api, session } from "../api.js";
import { Btn, PageLoader } from "../components/Loader.jsx";
import { PageHero, PagePanel, SectionCard, StatPill } from "../components/PageShell.jsx";

const STATUSES = [
  "Pending Engineering Review",
  "Under Design",
  "Awaiting Information",
  "Equipment Selection Completed",
  "Ready for Quotation",
];

const emptyLine = () => ({ item_id: "", item_code: "", item_name: "", brand: "", model: "", qty: 1, area: "" });

export default function EngineeringInbox() {
  const [list, setList] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ status: "", boq_text: "", sales_notes: "", lines: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canManage = session.can("project.manage");

  const load = () => api.engineeringRequests().then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const open = async (id) => {
    setError("");
    try {
      const row = await api.engineeringRequest(id);
      setDetail(row);
      setForm({
        status: row.status || STATUSES[0],
        boq_text: row.boq_text || "",
        sales_notes: row.sales_notes || "",
        lines: (row.approved_items || []).length
          ? row.approved_items.map((l) => ({
            item_id: l.item_id || "",
            item_code: l.item_code || "",
            item_name: l.item_name || l.name || "",
            brand: l.brand || "",
            model: l.model || "",
            qty: l.qty || l.quantity || 1,
            area: l.area || l.pos || "",
          }))
          : [emptyLine()],
      });
    } catch (e) { setError(e.message); }
  };

  const setLine = (i, patch) => setForm((f) => ({
    ...f,
    lines: f.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
  }));

  const save = async () => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const approved_items = form.lines
        .filter((l) => l.item_id || l.item_code || l.item_name || (l.brand && l.model))
        .map((l) => ({
          item_id: l.item_id || undefined,
          item_code: l.item_code || undefined,
          item_name: l.item_name || undefined,
          brand: l.brand || undefined,
          model: l.model || undefined,
          qty: Number(l.qty) || 1,
          area: l.area || undefined,
        }));
      const updated = await api.updateEngineeringRequest(detail.id, {
        status: form.status,
        boq_text: form.boq_text,
        sales_notes: form.sales_notes,
        approved_items,
      });
      setDetail(updated);
      await load();
      if (updated._erp_sync && !updated._erp_sync.synced) {
        setError(`Saved on EOS but ERP sync failed: ${updated._erp_sync.error || updated._erp_sync.reason}`);
      }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!list) {
    return (
      <PagePanel accent="teal">
        {error ? <div className="alert">{error}</div> : <PageLoader label="Loading engineering requests…" />}
      </PagePanel>
    );
  }

  return (
    <PagePanel accent="teal">
      <PageHero
        accent="teal"
        title="Engineering Requests Inbox"
        subtitle="Sales handoffs from Custom ERP — select equipment, complete BOQ, push back to quotation."
        badge={<StatPill>{list.length} request{list.length === 1 ? "" : "s"}</StatPill>}
      />
      {error && <div className="alert">{error}</div>}

      <div className="scroll-x">
        <table className="grid">
          <thead>
            <tr>
              <th>ERP Ref</th><th>Customer</th><th>Project</th><th>Location</th><th>Status</th><th>Required</th><th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.erp_number || r.erp_request_id?.slice(0, 8)}</strong></td>
                <td>{r.customer || "—"}</td>
                <td>{r.project_name || "—"}</td>
                <td className="muted">{r.project_location || "—"}</td>
                <td><span className="pill">{r.status}</span></td>
                <td className="muted">{r.required_date || "—"}</td>
                <td><Btn className="small" onClick={() => open(r.id)}>Open</Btn></td>
              </tr>
            ))}
            {!list.length && (
              <tr><td colSpan={7}><div className="empty-state"><strong>No requests yet</strong><p className="muted">Sales creates these from Opportunities in the Custom ERP.</p></div></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && (
        <SectionCard title={`${detail.erp_number || "Request"} — ${detail.customer || ""}`} icon="📋">
          <div className="add-row" style={{ flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
            <label>
              <span className="ilabel">Status</span>
              <select value={form.status} disabled={!canManage} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <Btn className="small" onClick={() => setDetail(null)}>Close</Btn>
            {canManage && <Btn className="small primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save & push to ERP"}</Btn>}
          </div>

          <p className="muted" style={{ marginBottom: 8 }}><b>BOQ text</b> (free-form requirements from sales)</p>
          <textarea rows={3} value={form.boq_text} disabled={!canManage} onChange={(e) => setForm({ ...form, boq_text: e.target.value })} style={{ width: "100%", marginBottom: 12 }} />

          <p className="muted" style={{ marginBottom: 8 }}><b>Approved equipment lines</b> — match by item_id, item_code, or brand+model (resolved on ERP)</p>
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Item ID</th><th>Code</th><th>Name</th><th>Brand</th><th>Model</th><th>Qty</th><th>Area</th>
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {form.lines.map((l, i) => (
                  <tr key={i}>
                    {["item_id", "item_code", "item_name", "brand", "model", "qty", "area"].map((k) => (
                      <td key={k}>
                        <input
                          value={l[k]}
                          disabled={!canManage}
                          onChange={(e) => setLine(i, { [k]: e.target.value })}
                          style={{ minWidth: k === "item_name" ? 140 : 80 }}
                        />
                      </td>
                    ))}
                    {canManage && (
                      <td>
                        <button type="button" className="x" onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>×</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canManage && (
            <Btn className="small" style={{ marginTop: 8 }} onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}>+ Add line</Btn>
          )}

          {detail.sales_notes && (
            <p className="muted" style={{ marginTop: 12 }}><b>Sales notes:</b> {detail.sales_notes}</p>
          )}
        </SectionCard>
      )}
    </PagePanel>
  );
}
