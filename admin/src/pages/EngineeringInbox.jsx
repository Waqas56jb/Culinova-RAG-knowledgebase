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

          {(detail.attachments || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p className="muted" style={{ marginBottom: 6 }}><b>Attachments from Sales</b> — BOQ, drawings, client specs, site photos, layouts</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {detail.attachments.map((a, i) => (
                  <a key={i} href={a.url || undefined} target="_blank" rel="noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "#fff", fontSize: 12, textDecoration: "none", color: a.url ? "var(--ink)" : "var(--steel)", pointerEvents: a.url ? "auto" : "none" }}>
                    <span style={{ background: "var(--brand-soft, #e6f8f6)", color: "var(--brand-deep, #0f5f5a)", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>{a.category || "File"}</span>
                    <span>{a.name}</span>
                    {a.url ? <span style={{ color: "var(--brand, #0d9488)" }}>↗</span> : <span className="muted" style={{ fontSize: 10 }}>(link expired — reopen)</span>}
                  </a>
                ))}
              </div>
            </div>
          )}

          <p className="muted" style={{ marginBottom: 8 }}><b>Approved equipment lines</b> — pick from the EOS Library; brand, name and model are filled from the approved record (no manual entry).</p>
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Equipment (from Library)</th><th>Brand</th><th>Model</th><th>Qty</th><th>Area</th>
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {form.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ minWidth: 240 }}>
                      {canManage
                        ? <EquipmentPicker line={l} onPick={(eq) => setLine(i, eq)} />
                        : <span>{l.item_name || l.item_code || "—"}</span>}
                    </td>
                    <td>{l.brand || "—"}</td>
                    <td>{l.model || "—"}</td>
                    <td>
                      <input type="number" min={1} value={l.qty} disabled={!canManage}
                        onChange={(e) => setLine(i, { qty: e.target.value })} style={{ width: 64 }} />
                    </td>
                    <td>
                      <input value={l.area} disabled={!canManage}
                        onChange={(e) => setLine(i, { area: e.target.value })} style={{ minWidth: 90 }} placeholder="e.g. Main kitchen" />
                    </td>
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
            <Btn className="small" style={{ marginTop: 8 }} onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}>+ Add equipment line</Btn>
          )}

          {detail.sales_notes && (
            <p className="muted" style={{ marginTop: 12 }}><b>Sales notes:</b> {detail.sales_notes}</p>
          )}
        </SectionCard>
      )}
    </PagePanel>
  );
}

/**
 * Approved-equipment picker for an engineering-request line.
 *
 * The engineer selects equipment from the EOS Library (approved records only) instead of typing
 * brand / name / model — which is what the client asked for: "Equipment should be selected from the
 * EOS Library Approved Equipment… Selecting an existing equipment should automatically populate all
 * related information." On select we fill item_id (the entry id), item_code, item_name, brand and
 * model from the approved record, so the identity can never be mistyped.
 */
function EquipmentPicker({ line, onPick }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.approvedEquipment(q)
        .then((r) => { if (alive) setRows(Array.isArray(r?.items) ? r.items : []); })
        .catch(() => { if (alive) setRows([]); })
        .finally(() => { if (alive) setLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open]);

  const pick = (e) => {
    onPick({
      item_id: e.id,
      item_code: e.code || e.model_number || "",
      item_name: e.title || e.display_name || "",
      brand: e.brand || "",
      model: e.model_number || e.code || "",
    });
    setOpen(false);
    setQ("");
  };

  if (line.item_id || line.item_name) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span><b>{line.item_name || line.item_code}</b></span>
        <button type="button" className="linkish" style={{ fontSize: 11 }} onClick={() => onPick({ item_id: "", item_code: "", item_name: "", brand: "", model: "" })}>change</button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        value={q}
        placeholder="Search approved equipment…"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        style={{ minWidth: 220 }}
      />
      {open && (
        <div style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, right: 0, maxHeight: 260, overflowY: "auto", background: "#fff", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "var(--shadow-md)", marginTop: 4 }}>
          {loading && <div className="muted" style={{ padding: 10, fontSize: 12 }}>Searching…</div>}
          {!loading && rows.length === 0 && <div className="muted" style={{ padding: 10, fontSize: 12 }}>No approved equipment matches. Only approved Library items can be selected.</div>}
          {rows.map((e) => (
            <button type="button" key={e.id} onClick={() => pick(e)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: 0, borderBottom: "1px solid #f1f5f9", background: "transparent", cursor: "pointer" }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{e.title || e.display_name}</div>
              <div className="muted" style={{ fontSize: 11 }}>{[e.brand, e.model_number || e.code, e.category].filter(Boolean).join(" · ")}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
