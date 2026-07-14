import React, { useEffect, useState } from "react";
import { api, session } from "../api.js";

const STATUS_LABEL = {
  proposed: "Proposed", accepted: "Accepted", modified: "Modified", rejected: "Rejected",
  conflict: "Conflict", missing_input: "Missing input", superseded: "Superseded",
};

/**
 * CULINOVA ENGINEERING RECOMMENDATIONS on the Review screen (client items 2–6).
 * Manufacturer data and CULINOVA values sit side by side; the engineer accepts / modifies /
 * rejects each one (modification and rejection need a reason); every value shows its rule
 * traceability; missing inputs and rule conflicts appear as validations; a rule change shows a
 * "Recalculation available" banner.
 */
export default function Recommendations({ entryId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState(null);
  const [deciding, setDeciding] = useState(null); // { rec, action }
  const canDecide = session.can("recommendation.decide");
  const canGenerate = session.can("recommendation.generate");

  const load = () => api.recsForEntry(entryId).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [entryId]);

  async function run(fn) {
    setBusy(true); setError("");
    try { await fn(); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (error && !data) return <div className="group"><h2>CULINOVA Engineering Recommendations</h2><div className="alert">{error}</div></div>;
  if (!data) return <div className="group"><h2>CULINOVA Engineering Recommendations</h2><div className="muted">Loading…</div></div>;

  const hasAny = (data.disciplines || []).some((d) => (d.items || []).length);
  const openValidations = (data.validations || []).filter((v) => v.status === "open");
  const alerts = data.recalc_alerts || [];

  return (
    <div className="group">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>CULINOVA Engineering Recommendations</h2>
        {canGenerate && (
          <button className="btn small" disabled={busy}
            onClick={() => run(() => api.recsGenerate(entryId))}>
            {busy ? "Running…" : hasAny ? "Re-run rules engine" : "Run rules engine"}
          </button>
        )}
      </div>

      {error && <div className="alert">{error}</div>}

      {alerts.length > 0 && (
        <div className="warn">
          ⚠ <b>Recalculation available</b> — {alerts.length} rule change(s) affect this equipment
          {alerts[0]?.reason ? `: ${alerts[0].reason}` : "."}{" "}
          {canGenerate && <button className="btn small" disabled={busy} onClick={() => run(() => api.recsGenerate(entryId))}>Recalculate now</button>}
        </div>
      )}

      {openValidations.length > 0 && (
        <div className="vals">
          {openValidations.map((v) => (
            <div key={v.id} className={"alert " + (v.severity === "warning" ? "soft" : "")}>
              <b>{v.severity === "warning" ? "⚠" : "✖"} {v.message}</b>
              {v.reason && <div className="muted">{v.reason}</div>}
              {v.required_input && <div className="muted">Required manual input: {v.required_input}</div>}
              {canDecide && (
                <button className="btn small ghost" onClick={() => run(async () => {
                  const note = prompt("How was this resolved?");
                  if (note != null) await api.resolveValidation(v.id, note);
                })}>Mark resolved</button>
              )}
            </div>
          ))}
        </div>
      )}

      {!hasAny && !openValidations.length && (
        <p className="muted">
          No recommendations yet. {canGenerate ? "Run the rules engine, or approve engineering rules first — with no approved rules there is nothing to apply." : "No approved rules matched this equipment yet."}
        </p>
      )}

      {(data.disciplines || []).map((d) => (
        <div key={d.discipline.code} style={{ marginBottom: 10 }}>
          <h3 style={{ margin: "10px 0 4px" }}>
            {d.discipline.color && <span className="swatch" style={{ background: d.discipline.color }} />} {d.discipline.name}
          </h3>
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Manufacturer data</th>
                  <th>CULINOVA recommendation</th>
                  <th>Status</th>
                  <th>Traceability</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(d.items || []).map((r) => {
                  const value = r.final_value ?? r.value_text ?? (r.value_num != null ? String(r.value_num) : null);
                  const unit = r.final_unit || r.unit || "";
                  return (
                    <tr key={r.id} className={r.status === "rejected" ? "muted" : ""}>
                      <td><b>{r.parameter_label || r.parameter_key}</b></td>
                      <td>{r.manufacturer_value != null ? `${r.manufacturer_value} ${r.manufacturer_unit || ""}` : <span className="muted">—</span>}</td>
                      <td>
                        {r.status === "missing_input"
                          ? <span className="missing-pill">Cannot be generated</span>
                          : <b>{value} {unit}</b>}
                        {r.status === "modified" && r.value_text && r.final_value !== r.value_text && (
                          <div className="muted" style={{ fontSize: 11 }}>rule proposed: {r.value_text} {r.unit || ""}</div>
                        )}
                        {r.note && <div className="muted" style={{ fontSize: 11 }}>{r.note}</div>}
                      </td>
                      <td>
                        <span className={"badge " + r.status}>{STATUS_LABEL[r.status] || r.status}</span>
                        {r.decision_reason && <div className="muted" style={{ fontSize: 11 }}>{r.decision_reason}</div>}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {r.traceability || <span className="muted">—</span>}
                        <button className="btn small ghost" style={{ marginLeft: 4 }} onClick={async () => {
                          try { setTrace(await api.recTrace(r.id)); } catch (e) { setError(e.message); }
                        }}>Trace</button>
                      </td>
                      <td className="rowacts">
                        {canDecide && !["superseded", "missing_input"].includes(r.status) && (
                          <>
                            {r.status !== "accepted" && <button className="btn small" disabled={busy}
                              onClick={() => run(() => api.recDecide(r.id, { action: "accept" }))}>Accept</button>}
                            <button className="btn small ghost" disabled={busy} onClick={() => setDeciding({ rec: r, action: "modify" })}>Modify</button>
                            {r.status !== "rejected" && <button className="btn small ghost" disabled={busy} onClick={() => setDeciding({ rec: r, action: "reject" })}>Reject</button>}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {deciding && (
        <DecideModal deciding={deciding} busy={busy}
          onCancel={() => setDeciding(null)}
          onSubmit={(body) => { setDeciding(null); run(() => api.recDecide(deciding.rec.id, body)); }} />
      )}

      {trace && <TraceModal trace={trace} onClose={() => setTrace(null)} />}
    </div>
  );
}

function DecideModal({ deciding, busy, onCancel, onSubmit }) {
  const { rec, action } = deciding;
  const [value, setValue] = useState(rec.final_value ?? rec.value_text ?? rec.value_num ?? "");
  const [unit, setUnit] = useState(rec.final_unit || rec.unit || "");
  const [reason, setReason] = useState("");

  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{action === "modify" ? "Modify recommendation" : "Reject recommendation"} — {rec.parameter_label || rec.parameter_key}</h2>
        <p className="muted">Rule proposed: <b>{rec.value_text ?? rec.value_num} {rec.unit || ""}</b>{rec.traceability ? ` · ${rec.traceability}` : ""}</p>
        {action === "modify" && (
          <div className="form-grid">
            <label>Final value<input value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></label>
            <label>Unit<input value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
          </div>
        )}
        <label className="wide">Reason (required)
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder={action === "modify" ? "Why the engineer's value differs from the rule…" : "Why this recommendation does not apply…"} autoFocus={action === "reject"} />
        </label>
        <div className="decision">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={busy || !reason.trim() || (action === "modify" && String(value).trim() === "")}
            onClick={() => onSubmit(action === "modify"
              ? { action: "modify", value: String(value), unit: unit || null, reason: reason.trim() }
              : { action: "reject", reason: reason.trim() })}>
            {action === "modify" ? "Save engineer's value" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TraceModal({ trace, onClose }) {
  const r = trace.recommendation || {};
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Traceability — {r.parameter_label || r.parameter_key}</h2>
        <div className="notice">{trace.statement}</div>

        <h3>Value</h3>
        <div className="rec-line">
          CULINOVA: <b>{r.final_value ?? r.value_text ?? r.value_num} {r.final_unit || r.unit || ""}</b>
          {" · "}status: <span className={"badge " + r.status}>{r.status}</span>
          {r.generated_at && <> · generated {new Date(r.generated_at).toLocaleString()}</>}
        </div>
        {trace.manufacturer && (
          <div className="rec-line">Manufacturer: {trace.manufacturer.value} {trace.manufacturer.unit || ""}</div>
        )}

        {(trace.inputs_used || []).length > 0 && (
          <>
            <h3>Source inputs used</h3>
            {trace.inputs_used.map((x, i) => (
              <div key={i} className="rec-line mono" style={{ fontSize: 12 }}>
                {x.key || x.parameter || JSON.stringify(x)}: {x.value ?? ""} {x.unit || ""}
              </div>
            ))}
          </>
        )}

        {(trace.matched_conditions || []).length > 0 && (
          <>
            <h3>Conditions that matched</h3>
            {trace.matched_conditions.map((c, i) => (
              <div key={i} className="rec-line" style={{ fontSize: 12 }}>{c.summary || JSON.stringify(c)}</div>
            ))}
          </>
        )}

        {(trace.history || []).length > 0 && (
          <>
            <h3>Decision history</h3>
            {trace.history.map((h) => (
              <div key={h.id} className="hist-row">
                <span className="pill">{h.event || h.action}</span>
                <span>{h.note || h.reason || ""}</span>
                <span className="muted hist-time">{new Date(h.created_at).toLocaleString()}</span>
              </div>
            ))}
          </>
        )}

        <div className="decision"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
