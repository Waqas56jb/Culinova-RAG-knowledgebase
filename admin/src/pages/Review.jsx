import React, { useEffect, useRef, useState } from "react";
import { api, session } from "../api.js";
import MEPDiagram from "@shared/components/MEPDiagram.jsx";
import AIAssistant from "@shared/components/AIAssistant.jsx";
import Recommendations from "../components/Recommendations.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import { Btn, PageLoader } from "../components/Loader.jsx";
import { PagePanel } from "../components/PageShell.jsx";
import { normName, fieldMatch, buildSectionRows, planSections } from "@shared/lib/sections.js";
import { resolveStorageUrl, isFramableStorageUrl } from "@shared/lib/storageUrl.js";

export default function Review({ id, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");         // fatal load error (blocks the page)
  const [actionErr, setActionErr] = useState(""); // recoverable mutation error (shown in context)
  const [busy, setBusy] = useState(false);
  const [docMap, setDocMap] = useState({});
  const [history, setHistory] = useState([]);
  const [modal, setModal] = useState(null);       // { type: "approve" | "reject" | "delete-attr", attr? }

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

  // Save an attribute edit. The change is applied only after the API confirms it,
  // so a failure leaves the stored data untouched and surfaces a visible error.
  async function saveAttr(a, patch) {
    setActionErr("");
    try {
      await api.patchAttr(a.id, patch);
      setD((prev) => ({
        ...prev,
        attributes: prev.attributes.map((x) => (x.id === a.id ? { ...x, ...patch } : x)),
      }));
    } catch (e) { setActionErr(`Could not save "${a.name}": ${e.message}`); }
  }

  // fill a blank required field → create the attribute. Throws on failure so the
  // calling row can keep the typed value and re-enable itself.
  async function addAttr(attr_group, name, value, unit) {
    const r = await api.createAttr(id, { attr_group, name, value: value || null, unit: unit || null });
    setD((prev) => ({ ...prev, attributes: [...(prev.attributes || []), r.attribute] }));
    return r.attribute;
  }

  // attach a component photo to a field (create the field first if it doesn't exist yet)
  async function uploadPhoto(attr_group, name, existing, file) {
    setBusy(true); setActionErr("");
    try {
      let attr = existing;
      if (!attr) attr = (await api.createAttr(id, { attr_group, name })).attribute;
      await api.attrPhoto(attr.id, file);
      load();
    } catch (e) { setActionErr(e.message); } finally { setBusy(false); }
  }

  // delete an attribute — confirmed through the in-app modal
  async function deleteAttrConfirmed(a) {
    setBusy(true); setActionErr("");
    try {
      await api.deleteAttr(a.id);
      setD((prev) => ({ ...prev, attributes: prev.attributes.filter((x) => x.id !== a.id) }));
      setModal(null);
    } catch (e) { setActionErr(`Could not delete "${a.name}": ${e.message}`); } finally { setBusy(false); }
  }

  // approve / reject / submit — approve & reject are confirmed through the modal first
  async function runAction(action, comment) {
    setBusy(true); setActionErr("");
    try {
      await api[action](id, comment || "");
      setModal(null);
      load();
    } catch (e) { setActionErr(e.message); } finally { setBusy(false); }
  }

  const fileUrl = (storageUrl) => resolveStorageUrl(storageUrl, api.base);

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

  if (error) return <PagePanel accent="teal"><button className="btn small" onClick={onBack}>← Back</button><div className="alert">{error}</div></PagePanel>;
  if (!d) return <PagePanel accent="teal"><PageLoader label="Loading equipment profile…" /></PagePanel>;

  const groups = {};
  (d.attributes || []).forEach((a) => { (groups[a.attr_group] = groups[a.attr_group] || []).push(a); });
  const status = d.entry.current_status;
  const canDecide = status === "draft" || status === "under_review";

  return (
    <PagePanel accent="teal">
      <button className="btn small ghost" onClick={onBack}>← Back to queue</button>

      <EquipmentProfile d={d} status={status} fileUrl={fileUrl} entryId={id} onSaved={load} />

      <p className="hint">Every engineering field is listed below — filled from the source, or left blank for you to complete. Blank fields show <span className="missing-pill">Missing</span>; type a value (or upload a photo) to add it. Click a source to open that page and verify, then approve.</p>

      {actionErr && <div className="alert" role="alert">{actionErr}</div>}

      {planSections(groups).map(({ key, label, rows }) => (
        <SectionTable
          key={key} sectionKey={key} label={label} rows={rows}
          saveAttr={saveAttr} removeAttr={(a) => setModal({ type: "delete-attr", attr: a })} addAttr={addAttr} uploadPhoto={uploadPhoto}
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

      <Recommendations entryId={id} />

      <CategoryStandardPanel initial={d.category_standard} entryId={id} />

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
        <AIAssistant entryId={id} api={api} />
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
          <Btn className="primary" disabled={busy} onClick={() => { setActionErr(""); setModal({ type: "approve" }); }}>Approve</Btn>
          {status === "draft" && <Btn loading={busy && !modal} disabled={busy} onClick={() => runAction("submit")}>Submit for review</Btn>}
          <Btn className="danger" disabled={busy} onClick={() => { setActionErr(""); setModal({ type: "reject" }); }}>Reject</Btn>
        </div>
      )}

      {modal?.type === "approve" && (
        <ConfirmModal
          title="Approve & publish to ERP?"
          message="Approving publishes this equipment model to the ERP as approved engineering knowledge and makes it visible in the public portal. Continue?"
          confirmLabel="Approve & publish"
          busy={busy}
          error={actionErr}
          onConfirm={() => runAction("approve")}
          onCancel={() => { if (!busy) { setModal(null); setActionErr(""); } }}
        />
      )}
      {modal?.type === "reject" && (
        <ConfirmModal
          title="Reject this model?"
          message="The submitter will see this model was rejected. Add a reason to explain why."
          confirmLabel="Reject"
          danger
          requireReason
          reasonLabel="Reason for rejection"
          reasonPlaceholder="e.g. Missing electrical datasheet; resubmit with the isolator spec."
          busy={busy}
          error={actionErr}
          onConfirm={(reason) => runAction("reject", reason)}
          onCancel={() => { if (!busy) { setModal(null); setActionErr(""); } }}
        />
      )}
      {modal?.type === "delete-attr" && (
        <ConfirmModal
          title="Delete field?"
          message={`Delete "${modal.attr.name}"? This removes the field from this equipment record.`}
          confirmLabel="Delete field"
          danger
          busy={busy}
          error={actionErr}
          onConfirm={() => deleteAttrConfirmed(modal.attr)}
          onCancel={() => { if (!busy) { setModal(null); setActionErr(""); } }}
        />
      )}
    </PagePanel>
  );
}

function ConfBadge({ c }) {
  const cls = c >= 0.8 ? "hi" : c >= 0.5 ? "mid" : "lo";
  return <span className={"conf " + cls}>{Math.round(c * 100)}%</span>;
}

// ── CULINOVA Category Standard ────────────────────────────────────────────────
// Surfaces detail.category_standard (same shape as /for-equipment/:id): the matched
// category profile and its applied requirements, or the suggested candidates to link.
const MATCH_META = {
  linked: { cls: "approved", label: "Linked" },
  exact: { cls: "approved", label: "Exact match" },
  auto: { cls: "published", label: "Auto-matched" },
  suggested: { cls: "under_review", label: "Suggested" },
  none: { cls: "draft", label: "No match" },
};
const fmtScore = (s) => (s == null ? "" : s <= 1 ? `${Math.round(s * 100)}%` : `${s}`);

function CategoryStandardPanel({ initial, entryId }) {
  const [cs, setCs] = useState(initial || null);
  const [busy, setBusy] = useState("");   // holds the id being linked, or "unlink"
  const [err, setErr] = useState("");
  const canLink = session.can("knowledge.edit");

  // keep in sync if the parent reloads the entry with a fresh category_standard
  useEffect(() => { setCs(initial || null); }, [initial]);

  if (!cs) return null;

  async function link(profile_id, key) {
    setBusy(key); setErr("");
    try { setCs(await api.linkCategoryProfile(entryId, profile_id)); }
    catch (e) { setErr(e.message); } finally { setBusy(""); }
  }

  const match = MATCH_META[cs.match] || { cls: "draft", label: cs.match || "—" };
  const applied = cs.applied || {};
  const requirements = applied.requirements || [];
  const manufacturer = applied.manufacturer_sourced || [];
  const pending = applied.pending || [];
  const options = applied.options || [];
  const candidates = cs.candidates || [];

  return (
    <div className="group">
      <h2>CULINOVA Category Standard <span className={"badge " + match.cls} style={{ marginLeft: 8 }}>{match.label}</span></h2>

      {err && <div className="alert" role="alert">{err}</div>}

      {cs.profile ? (
        <>
          <div className="std-head">
            <span className="pill culinova">{cs.profile.category_name || "Category"}</span>
            {cs.profile.code && <span className="mono">{cs.profile.code}</span>}
            {cs.linked && canLink && (
              <button className="btn small ghost" disabled={busy === "unlink"} onClick={() => link(null, "unlink")}>
                {busy === "unlink" ? "Unlinking…" : "Unlink"}
              </button>
            )}
          </div>

          {requirements.length > 0 && (
            <div className="scroll-x">
              <table className="grid">
                <thead><tr><th>Requirement</th><th>Value</th></tr></thead>
                <tbody>
                  {requirements.map((r, i) => (
                    <tr key={i}>
                      <td>{r.attribute || "—"}</td>
                      <td>{r.kind === "policy" ? (r.applies ? "Yes" : "No") : (r.value || "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {options.length > 0 && (
            <p className="muted" style={{ marginTop: 8 }}>
              <b>Options:</b> {options.map((o) => `${o.attribute}: ${o.value}`).join(" · ")}
            </p>
          )}

          <p className="muted" style={{ marginTop: 8 }}>
            {manufacturer.length} value{manufacturer.length === 1 ? "" : "s"} sourced from the manufacturer datasheet.
          </p>

          {pending.length > 0 && (
            <>
              <div className="warn">⚠ {pending.length} requirement{pending.length === 1 ? "" : "s"} awaiting the client's discipline rule tables — no value can be applied yet.</div>
              <div className="scroll-x">
                <table className="grid">
                  <thead><tr><th>Requirement</th><th>Needs</th><th>Discipline</th></tr></thead>
                  <tbody>
                    {pending.map((p, i) => (
                      <tr key={i} className="std-pending">
                        <td>{p.attribute || "—"}<span className="badge pending" style={{ marginLeft: 8 }}>Pending</span></td>
                        <td>{p.needs || "—"}</td>
                        <td>{p.discipline || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <p className="muted">No category standard is linked to this model yet.{candidates.length ? " Pick the best match below:" : ""}</p>
          {candidates.length > 0 ? (
            <div className="scroll-x">
              <table className="grid">
                <thead><tr><th>Suggested category</th><th>Match</th><th>Why</th>{canLink && <th></th>}</tr></thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id}>
                      <td>{c.category_name || "—"} {c.code && <span className="mono">{c.code}</span>}</td>
                      <td>{fmtScore(c.score) || "—"}</td>
                      <td className="muted">{c.reason || "—"}</td>
                      {canLink && (
                        <td className="rowacts">
                          <button className="btn small primary" disabled={!!busy} onClick={() => link(c.id, c.id)}>
                            {busy === c.id ? "Linking…" : "Link"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No matching category profile was found for this equipment.</p>
          )}
        </>
      )}
    </div>
  );
}

// Renders a full section: canonical required fields (filled or blank) + any extra extracted fields.
function SectionTable({ sectionKey, label, rows, saveAttr, removeAttr, addAttr, uploadPhoto, sourceLink, fileUrl }) {
  const out = buildSectionRows(sectionKey, rows);
  const existingNames = rows.map((a) => a.name);
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
                if (r.photo) {
                  return (
                    <tr key={"m" + idx} className="missing">
                      <td><span className="field-name">{r.name}</span></td>
                      <td><PhotoCell attr={null} name={r.name} onPick={(file) => uploadPhoto(sectionKey, r.name, null, file)} fileUrl={fileUrl} /></td>
                      <td className="narrow"></td>
                      <td>—</td>
                      <td className="narrow"><span className="missing-pill">Missing</span></td>
                      <td></td>
                    </tr>
                  );
                }
                return (
                  <MissingFieldRow
                    key={"m" + idx} sectionKey={sectionKey} name={r.name}
                    addAttr={addAttr} existingNames={existingNames}
                  />
                );
              }
              const a = r.a;
              return (
                <tr key={a.id} className={a.verified ? "verified" : ""}>
                  <td><input aria-label={`Field name for ${a.name}`} defaultValue={a.name} onBlur={(e) => e.target.value !== a.name && saveAttr(a, { name: e.target.value })} /></td>
                  <td>
                    {r.photo
                      ? <PhotoCell attr={a} name={a.name} onPick={(file) => uploadPhoto(sectionKey, a.name, a, file)} fileUrl={fileUrl} />
                      : <input aria-label={`Value for ${a.name}`} defaultValue={a.value || ""} onBlur={(e) => e.target.value !== (a.value || "") && saveAttr(a, { value: e.target.value })} />}
                  </td>
                  <td className="narrow"><input aria-label={`Unit for ${a.name}`} defaultValue={a.unit || ""} onBlur={(e) => e.target.value !== (a.unit || "") && saveAttr(a, { unit: e.target.value })} /></td>
                  <td>{sourceLink(a)}</td>
                  <td className="narrow">{a.confidence != null ? <ConfBadge c={a.confidence} /> : "—"}</td>
                  <td className="rowacts">
                    <button className={"tick " + (a.verified ? "on" : "")} title="Mark verified" aria-label={`Mark "${a.name}" verified`} onClick={() => saveAttr(a, { verified: !a.verified })}>✓</button>
                    <button className="x" title="Delete" aria-label={`Delete "${a.name}"`} onClick={() => removeAttr(a)}>×</button>
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

// A single blank required field. Commits on Enter or when focus leaves the row —
// not when tabbing between its own value/unit inputs — so the unit isn't dropped.
// The inputs disable while the create is in flight (no double-add), the value is
// deduped against existing fields, and on failure the typed text is preserved and
// the row re-enables so the engineer never loses what they typed.
function MissingFieldRow({ sectionKey, name, addAttr, existingNames }) {
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  const doneRef = useRef(false);

  async function commit() {
    const v = value.trim();
    if (!v || pending || doneRef.current) return;
    if ((existingNames || []).some((n) => fieldMatch(n, name) || normName(n) === normName(name))) {
      setErr("This field already exists in this section.");
      return;
    }
    setPending(true); setErr(""); doneRef.current = true;
    try {
      await addAttr(sectionKey, name, v, unit.trim() || null);
      // success: the new attribute re-renders as a real row and replaces this one
    } catch (e) {
      doneRef.current = false;   // allow another attempt
      setPending(false);         // re-enable the inputs
      setErr(e.message);         // keep the typed value & unit — nothing is lost
    }
  }

  return (
    <tr className="missing" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) commit(); }}>
      <td><span className="field-name">{name}</span></td>
      <td>
        <input
          aria-label={`Value for ${name}`}
          placeholder="Not specified — type to add"
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        />
        {err && <div className="alert small" role="alert">{err}</div>}
      </td>
      <td className="narrow">
        <input
          aria-label={`Unit for ${name}`}
          placeholder="Unit"
          value={unit}
          disabled={pending}
          onChange={(e) => setUnit(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        />
      </td>
      <td>—</td>
      <td className="narrow">{pending ? <span className="muted">Adding…</span> : <span className="missing-pill">Missing</span>}</td>
      <td></td>
    </tr>
  );
}

function PhotoCell({ attr, name, onPick, fileUrl }) {
  const url = attr && attr.image_url;
  const label = name || (attr && attr.name) || "field";
  return (
    <div className="photo-cell">
      {url
        ? <a href={fileUrl(url)} target="_blank" rel="noreferrer"><img src={fileUrl(url)} alt={`Photo for ${label}`} className="attr-photo" /></a>
        : <span className="muted">No photo</span>}
      <label className="btn small ghost photo-btn">
        {url ? "Replace" : "Upload photo"}
        <input type="file" accept="image/*" hidden aria-label={`${url ? "Replace" : "Upload"} photo for ${label}`} onChange={(e) => { const f = (e.target.files || [])[0]; if (f) onPick(f); e.target.value = ""; }} />
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

// A framed document only needs to render (scripts for the built-in PDF viewer),
// stay in its own origin, and open links / downloads. Top-navigation, forms and
// modals stay blocked so a hostile document can't drive the parent page.
const PDF_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads";

export function CADPreview({ documents, files, fileUrl }) {
  const [open, setOpen] = useState(null);
  const docs = documents || [];
  const cads = (files || []).filter((f) => f.asset_type === "cad");
  const preview = open || docs.find((d) => d.doc_type === "datasheet") || docs[0];
  if (!preview && !cads.length) return null;
  const previewUrl = preview ? fileUrl(preview.storage_url) : "";
  const framable = preview ? isFramableStorageUrl(preview.storage_url, api.base) : false;
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
          {framable ? (
            <iframe
              title="document preview"
              className="pdf-frame"
              src={previewUrl}
              sandbox={PDF_SANDBOX}
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="preview-fallback muted">
              <p>This document is hosted on an external source and can't be previewed securely inline.</p>
              {previewUrl && <a className="btn small" href={previewUrl} target="_blank" rel="noreferrer">Open document ↗</a>}
            </div>
          )}
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
