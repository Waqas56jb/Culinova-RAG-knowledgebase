import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Btn } from "./Loader.jsx";

/**
 * BATCHED EXCEL IMPORT — a sheet of any size, imported without a timeout, with honest live progress.
 *
 * The browser drives the run: /prepare parses the workbook once and parks the rows, then the client
 * asks for one small batch at a time. No single request is long enough to hit a serverless limit, and
 * every number on screen (percent, ETA, rate) is MEASURED from the batches already finished — nothing
 * is estimated up front or invented.
 *
 * It also never dies mid-run: a failed batch is retried with backoff, and if the retries are exhausted
 * the job pauses with a Resume button instead of losing the rows already imported.
 */

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 6000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export default function BatchImport() {
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [plan, setPlan] = useState(null);        // result of /prepare — shown BEFORE anything is written
  const [phase, setPhase] = useState("idle");    // idle | preparing | ready | running | paused | done | cancelled
  const [progress, setProgress] = useState(null); // {processed,total,imported,failed,percent,eta_seconds,rate_per_second}
  const [feed, setFeed] = useState([]);          // live per-item log
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");    // recoverable — the run continues
  const [preview, setPreview] = useState(null);  // preview modal payload
  const [previewBusy, setPreviewBusy] = useState(false);
  const [tplBusy, setTplBusy] = useState(false);

  const cancelled = useRef(false);
  const feedEnd = useRef(null);
  const jobId = plan?.job_id;

  useEffect(() => { feedEnd.current?.scrollIntoView({ block: "nearest" }); }, [feed]);

  const reset = () => {
    cancelled.current = false;
    setPlan(null); setPhase("idle"); setProgress(null); setFeed([]);
    setError(""); setWarning(""); setPreview(null);
  };

  function take(f) {
    if (!f) return;
    if (!/\.xlsx?$/i.test(f.name)) { setError("Choose an .xlsx or .xls file."); return; }
    reset();
    setFile(f);
  }

  /** The template download needs the bearer header, so it cannot be a plain <a href>. */
  async function downloadTemplate() {
    setTplBusy(true);
    try { await api.downloadExcelTemplate(); }
    catch (e) { setError(e.message || "The template could not be downloaded."); }
    finally { setTplBusy(false); }
  }

  /** Step 1 — parse and classify. Writes nothing, so the user can check the mapping first. */
  async function doPrepare() {
    if (!file) return;
    setPhase("preparing"); setError(""); setWarning("");
    try {
      const p = await api.importPrepare(file);
      setPlan(p);
      setProgress({ processed: 0, total: p.total, imported: 0, failed: 0, percent: 0, eta_seconds: null, rate_per_second: null });
      setPhase("ready");
      if (!p.total) setWarning("No importable rows found — every row is missing both a product code and a name.");
    } catch (e) {
      setError(e.message || "The file could not be read.");
      setPhase("idle");
    }
  }

  /** Step 2 — drive the batches. Retries a failing batch instead of losing the whole run. */
  const runBatches = useCallback(async (id, batchSize) => {
    cancelled.current = false;
    setPhase("running"); setError(""); setWarning("");

    for (;;) {
      if (cancelled.current) { setPhase("cancelled"); return; }

      let res = null;
      let lastErr = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try { res = await api.importBatch(id, batchSize); break; }
        catch (e) {
          lastErr = e;
          if (attempt === MAX_RETRIES) break;
          setWarning(`Network hiccup — retrying (${attempt + 1}/${MAX_RETRIES})…`);
          await sleep(RETRY_BACKOFF_MS[attempt] ?? 6000);
          if (cancelled.current) { setPhase("cancelled"); return; }
        }
      }

      if (!res) {
        // Out of retries: pause rather than crash. Everything imported so far is already saved.
        setError(`${lastErr?.message || "The server could not be reached."} — nothing was lost; press Resume to continue.`);
        setWarning("");
        setPhase("paused");
        return;
      }
      setWarning("");

      setProgress({
        processed: res.processed, total: res.total, imported: res.imported, failed: res.failed,
        percent: res.percent, eta_seconds: res.eta_seconds, rate_per_second: res.rate_per_second,
      });

      // the live "what was just extracted" feed
      const items = res.batch?.items || [];
      if (items.length) {
        setFeed((prev) => [
          ...prev,
          ...items.map((it) => ({
            kind: (it.version || 1) > 1 ? "rev" : "ok",
            code: it.code,
            title: (it.version || 1) > 1 ? `${it.title} — updated (version ${it.version})` : it.title,
          })),
        ].slice(-400)); // keep the DOM bounded on very large sheets
      }
      for (const err of res.batch?.errors || []) {
        setFeed((prev) => [...prev, { kind: "err", code: err.code || err.row || "row", title: err.error }].slice(-400));
      }

      if (res.done) { setPhase("done"); return; }
    }
  }, []);

  async function cancel() {
    cancelled.current = true;
    setPhase("cancelled");
    if (jobId) { try { await api.importCancel(jobId); } catch { /* the local stop already took effect */ } }
  }

  async function openPreview() {
    if (!jobId) return;
    setPreviewBusy(true);
    try { setPreview(await api.importPreview(jobId, 25)); }
    catch (e) { setError(e.message || "The preview could not be loaded."); }
    finally { setPreviewBusy(false); }
  }

  const batchSize = plan?.recommended_batch_size || 25;
  const running = phase === "running";
  const finished = phase === "done" || phase === "cancelled";
  const pct = progress?.percent ?? 0;

  return (
    <div>
      <p className="muted">
        Upload a product sheet (one product per row). EOS reads your columns, maps them to Equipment Profiles and
        creates a <strong>Draft per row</strong>. Large files are imported in <strong>batches</strong>, so the run can
        never time out — and you can watch every item as it is extracted.
      </p>

      <div className="template-banner">
        <div>
          <strong>Use the standardized EOS template</strong>
          <div className="muted">
            All required fields and engineering sections, plus <em>Image URL</em>, <em>Drawing / CAD Link</em> and{" "}
            <em>PDF Link</em> columns — pre-filled with one example row.
          </div>
        </div>
        <Btn className="" loading={tplBusy} onClick={downloadTemplate}>⬇ Download Template</Btn>
      </div>

      {/* ── file picker ─────────────────────────────────────────────────────── */}
      {phase === "idle" || phase === "preparing" ? (
        <label className={"dropzone" + (drag ? " drag" : "")}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); take((e.dataTransfer.files || [])[0]); }}>
          <input type="file" accept=".xlsx,.xls" hidden onChange={(e) => take((e.target.files || [])[0])} />
          <div>
            <strong>{file ? file.name : "Drag & drop an .xlsx file, or click to choose"}</strong>
            <div className="muted">{file ? `${Math.round(file.size / 1024)} KB — ready to analyse` : "Bulk product / equipment sheet."}</div>
          </div>
        </label>
      ) : (
        <div className="import-file-chip">
          <span className="import-file-name">📄 {plan?.source_file || file?.name}</span>
          <span className="muted">{plan?.total} rows · {plan?.columns} columns · sheet “{plan?.sheet}”</span>
          {!running && <button className="btn small ghost" onClick={() => { reset(); setFile(null); }}>Choose another file</button>}
        </div>
      )}

      {/* ── what the parser understood, BEFORE writing anything ─────────────── */}
      {plan && (
        <div className="import-plan">
          <h2>What EOS read from your file</h2>
          <div className="import-plan-grid">
            <div>
              <div className="ilabel">Identity columns</div>
              <ul className="import-map">{(plan.identity_columns || []).map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
            <div>
              <div className="ilabel">Mapped to an engineering discipline</div>
              {plan.mapped_to_discipline?.length
                ? <ul className="import-map">{plan.mapped_to_discipline.map((s) => <li key={s}>{s}</li>)}</ul>
                : <p className="muted">None — every other column is stored as a specification field.</p>}
            </div>
            <div>
              <div className="ilabel">Marked “not applicable”</div>
              {Object.keys(plan.not_applicable || {}).length ? (
                <ul className="import-map">
                  {Object.entries(plan.not_applicable).map(([d, n]) => (
                    <li key={d}><strong>{d}</strong> — {n} item{n === 1 ? "" : "s"} (these sections stay hidden)</li>
                  ))}
                </ul>
              ) : <p className="muted">None.</p>}
            </div>
          </div>
          {!!plan.skipped_rows && (
            <p className="muted">{plan.skipped_rows} row(s) will be skipped — no product code and no name.</p>
          )}
          {!!plan.preview?.length && (
            <div className="scroll-x">
              <table className="grid">
                <thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Type</th><th>Fields</th><th>Hidden sections</th></tr></thead>
                <tbody>
                  {plan.preview.map((p, i) => (
                    <tr key={i}>
                      <td><strong>{p.code || "—"}</strong></td><td>{p.name || "—"}</td>
                      <td>{p.category || "—"}</td><td>{p.type || "—"}</td>
                      <td>{p.attributes}</td>
                      <td className="muted">{(p.not_applicable || []).join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── progress ────────────────────────────────────────────────────────── */}
      {progress && phase !== "ready" && (
        <div className="import-progress">
          <div className="import-progress-head">
            <strong>
              {running && "Importing…"}
              {phase === "paused" && "Paused"}
              {phase === "done" && "Import complete"}
              {phase === "cancelled" && "Import stopped"}
            </strong>
            <span className="muted">
              {progress.processed} / {progress.total} rows
              {running && progress.eta_seconds != null && <> · about <strong>{fmtDuration(progress.eta_seconds)}</strong> left</>}
              {progress.rate_per_second ? <> · {progress.rate_per_second}/sec</> : null}
            </span>
          </div>

          <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={"progress-fill" + (running ? " active" : "") + (phase === "paused" ? " paused" : "")} style={{ width: `${pct}%` }} />
          </div>

          <div className="import-progress-stats">
            <span className="pct">{pct}%</span>
            <span className="stat ok">{progress.imported} imported</span>
            {!!progress.failed && <span className="stat bad">{progress.failed} failed</span>}
          </div>
        </div>
      )}

      {/* ── live extraction feed ────────────────────────────────────────────── */}
      {!!feed.length && (
        <div className="import-feed">
          <div className="import-feed-head">
            <span>Live extraction</span>
            <span className="muted">{feed.length} shown{feed.length >= 400 ? " (latest)" : ""}</span>
          </div>
          <div className="import-feed-body">
            {feed.map((f, i) => (
              <div key={i} className={"feed-line" + (f.kind === "err" ? " err" : f.kind === "rev" ? " rev" : "")}>
                <span className="feed-mark">{f.kind === "err" ? "✖" : f.kind === "rev" ? "↻" : "✔"}</span>
                <span className="feed-code">{f.code}</span>
                <span className="feed-title">{f.title}</span>
              </div>
            ))}
            <div ref={feedEnd} />
          </div>
        </div>
      )}

      {warning && <div className="alert warn">{warning}</div>}
      {error && <div className="alert">{error}</div>}

      {phase === "done" && (
        <div className="results">
          <h2>
            Imported {progress?.imported} of {progress?.total} row(s)
            {progress?.failed ? ` — ${progress.failed} failed` : ""}
          </h2>
          <p className="muted">Every item was created as a <strong>Draft</strong>. Review and approve them in Drafts.</p>
        </div>
      )}

      {/* ── actions ─────────────────────────────────────────────────────────── */}
      <div className="actions">
        {(phase === "idle" || phase === "preparing") && (
          <Btn className="primary" loading={phase === "preparing"} disabled={!file} onClick={doPrepare}>
            Analyse file
          </Btn>
        )}
        {phase === "ready" && (
          <Btn className="primary" disabled={!plan?.total} onClick={() => runBatches(jobId, batchSize)}>
            Start import — {plan?.total} row(s)
          </Btn>
        )}
        {running && <Btn className="ghost" onClick={cancel}>Stop</Btn>}
        {phase === "paused" && <Btn className="primary" onClick={() => runBatches(jobId, batchSize)}>Resume</Btn>}
        {(finished || phase === "paused") && !!progress?.imported && (
          <Btn className="ghost" loading={previewBusy} onClick={openPreview} title="Preview what was imported">
            👁 Preview imported data
          </Btn>
        )}
        {finished && <Btn className="ghost" onClick={() => { reset(); setFile(null); }}>Import another file</Btn>}
      </div>

      {preview && <PreviewModal data={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** What was actually written to the knowledge base — read back from the server, not from memory. */
function PreviewModal({ data, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide">
        <div className="preview-head">
          <div>
            <h2>Imported data — {data.source_file}</h2>
            <div className="muted">{data.imported} of {data.total} row(s) imported · showing the first {data.items?.length || 0}</div>
          </div>
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div>
          {!data.items?.length && <p className="muted">Nothing has been imported yet.</p>}
          {(data.items || []).map((it) => (
            <div key={it.id} className="preview-item">
              <div className="preview-item-head">
                <span className="badge draft">{it.status}</span>
                <strong>{it.code}</strong>
                <span>{it.title}</span>
                <span className="muted">{[it.category, it.type, it.brand].filter(Boolean).join(" › ")}</span>
              </div>
              {it.attributes?.length ? (
                <div className="scroll-x">
                  <table className="grid compact">
                    <thead><tr><th>Section</th><th>Field</th><th>Value</th><th>Unit</th></tr></thead>
                    <tbody>
                      {it.attributes.map((a, i) => (
                        <tr key={i}>
                          <td className="muted">{a.attr_group}</td>
                          <td>{a.name}</td>
                          <td><strong>{a.value ?? "—"}</strong></td>
                          <td className="muted">{a.unit || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="muted">No fields captured for this item.</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
