import React, { useEffect, useRef, useState, useCallback } from "react";
import { api, session } from "../api.js";

/**
 * DRAWING WORKSPACE (client items 12–15).
 * The plan (PDF page 1 or image) renders underneath; every placement, coloured MEP point and
 * annotation is an overlay positioned by NORMALISED coordinates (0..1), so the on-screen editor,
 * the PNG export and the coordinate export all share exactly the same numbers.
 */
export default function DrawingEditor({ drawingId, project, onBack }) {
  const [state, setState] = useState(null);       // { drawing, placements, annotations, revisions, point_types }
  const [error, setError] = useState("");
  const [baseSize, setBaseSize] = useState(null); // natural pixels of the plan
  const [zoom, setZoom] = useState(1);
  const [layers, setLayers] = useState({ equipment: true, notes: true }); // + one key per point-type code
  const [selected, setSelected] = useState(null); // { kind: 'placement'|'point'|'annotation', id }
  const [info, setInfo] = useState(null);         // equipment info panel content
  const [mode, setMode] = useState("select");     // select | place:<itemId> | note | label | dimension
  const [dimStart, setDimStart] = useState(null);
  const canManage = session.can("project.manage");

  const wrapRef = useRef(null);   // the scaled sheet
  const baseImgRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const drag = useRef(null);

  const load = useCallback(() => api.drawing(drawingId).then((s) => {
    setState(s);
    setLayers((l) => {
      const next = { ...l };
      for (const t of s.point_types) if (next[t.code] === undefined) next[t.code] = true;
      return next;
    });
  }).catch((e) => setError(e.message)), [drawingId]);
  useEffect(() => { load(); }, [load]);

  // ── base plan rendering ───────────────────────────────────────────────────
  useEffect(() => {
    if (!state) return;
    const d = state.drawing;
    if (d.kind !== "pdf") return; // images render via <img onLoad>
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const doc = await pdfjs.getDocument(d.storage_url).promise;
        const page = await doc.getPage(d.page || 1);
        const viewport = page.getViewport({ scale: 2 }); // crisp enough to annotate and export
        const canvas = pdfCanvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        if (!cancelled) setBaseSize({ w: viewport.width, h: viewport.height });
      } catch (e) { if (!cancelled) setError("Could not render the PDF: " + e.message); }
    })();
    return () => { cancelled = true; };
  }, [state?.drawing?.id, state?.drawing?.kind]);

  if (error) return <div className="panel"><button className="btn small ghost" onClick={onBack}>← Back</button><div className="alert">{error}</div></div>;
  if (!state) return <div className="panel"><div className="muted">Loading drawing…</div></div>;

  const { drawing, placements, annotations, point_types } = state;
  const projectItems = (project.items || []).filter((i) => i.status === "active");
  const placedIds = new Set(placements.map((p) => p.project_item_id));

  // ── coordinate helpers ────────────────────────────────────────────────────
  const toNorm = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  // ── interactions ──────────────────────────────────────────────────────────
  async function sheetClick(e) {
    if (!canManage) return;
    const { x, y } = toNorm(e);
    if (mode.startsWith("place:")) {
      const itemId = mode.slice(6);
      setMode("select");
      try { setState(await stripId(api.addPlacement(drawing.id, { project_item_id: itemId, x, y }))); }
      catch (err) { setError(err.message); }
    } else if (mode === "note" || mode === "label") {
      const text = prompt(mode === "note" ? "Engineering note:" : "Label text:");
      setMode("select");
      if (!text) return;
      await api.addAnnotation(drawing.id, { kind: mode, text, x, y });
      load();
    } else if (mode === "dimension") {
      if (!dimStart) { setDimStart({ x, y }); return; }
      const text = prompt("Dimension text (e.g. 2400 mm):");
      setDimStart(null); setMode("select");
      if (!text) return;
      await api.addAnnotation(drawing.id, { kind: "dimension", text, x: dimStart.x, y: dimStart.y, x2: x, y2: y });
      load();
    } else {
      setSelected(null); setInfo(null);
    }
  }
  const stripId = async (promise) => { const r = await promise; delete r.placement_id; return r; };

  function startDrag(e, kind, obj, placement) {
    if (!canManage || mode !== "select") return;
    e.stopPropagation(); e.preventDefault();
    drag.current = { kind, obj, placement, moved: false };
    const move = (ev) => {
      const { x, y } = toNorm(ev);
      drag.current.moved = true;
      setState((s) => {
        const next = { ...s, placements: s.placements.map((p) => ({ ...p, ceks_drawing_points: [...(p.ceks_drawing_points || [])] })) };
        if (kind === "placement") {
          const p = next.placements.find((p) => p.id === obj.id);
          if (p) { p.x = x; p.y = y; }
        } else if (kind === "point") {
          const pl = next.placements.find((p) => p.id === placement.id);
          const pt = pl?.ceks_drawing_points.find((q) => q.id === obj.id);
          if (pt) { pt.dx = x - Number(pl.x); pt.dy = y - Number(pl.y); }
        } else if (kind === "annotation") {
          next.annotations = s.annotations.map((a) => (a.id === obj.id ? { ...a, x, y } : a));
        }
        return next;
      });
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const d = drag.current; drag.current = null;
      if (!d?.moved) { select(kind, obj, placement); return; }
      // persist final position from current state
      setState((s) => {
        (async () => {
          try {
            if (kind === "placement") {
              const p = s.placements.find((p) => p.id === obj.id);
              await api.updatePlacement(drawing.id, obj.id, { x: p.x, y: p.y });
            } else if (kind === "point") {
              const pl = s.placements.find((p) => p.id === placement.id);
              const pt = pl.ceks_drawing_points.find((q) => q.id === obj.id);
              await api.updatePoint(drawing.id, obj.id, { dx: pt.dx, dy: pt.dy });
            } else if (kind === "annotation") {
              const a = s.annotations.find((a) => a.id === obj.id);
              await api.updateAnnotation(drawing.id, obj.id, { x: a.x, y: a.y });
            }
          } catch (err) { setError(err.message); }
        })();
        return s;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function select(kind, obj, placement) {
    setSelected({ kind, id: obj.id });
    if (kind === "placement") {
      const entry = obj.ceks_project_items?.ceks_knowledge_entries;
      setInfo({ loading: true, placement: obj });
      try {
        const [detail, recs] = await Promise.all([
          api.entry(entry.id),
          api.recsForEntry(entry.id).catch(() => null),
        ]);
        setInfo({ placement: obj, detail, recs });
      } catch (e) { setInfo({ placement: obj, error: e.message }); }
    } else setInfo(null);
  }

  async function rotateSelected(deg) {
    const p = placements.find((x) => x.id === selected?.id);
    if (!p) return;
    await api.updatePlacement(drawing.id, p.id, { rotation: ((Number(p.rotation) || 0) + deg + 360) % 360 });
    load();
  }

  async function removeSelected() {
    if (!selected) return;
    if (selected.kind === "placement" && confirm("Remove this equipment (and its points) from the drawing?")) {
      await api.deletePlacement(drawing.id, selected.id);
    } else if (selected.kind === "point" && confirm("Remove this utility point?")) {
      await api.deletePoint(drawing.id, selected.id);
    } else if (selected.kind === "annotation" && confirm("Remove this annotation?")) {
      await api.deleteAnnotation(drawing.id, selected.id);
    } else return;
    setSelected(null); setInfo(null);
    load();
  }

  // ── EXPORT: annotated PNG rendered from the same normalised data ──────────
  async function exportPng() {
    const base = drawing.kind === "pdf" ? pdfCanvasRef.current : baseImgRef.current;
    if (!base || !baseSize) return setError("The plan has not finished rendering yet.");
    const W = baseSize.w, H = baseSize.h;
    const legendW = 260;
    const canvas = document.createElement("canvas");
    canvas.width = W + legendW; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0, W, H);

    const px = (v) => v * W, py = (v) => v * H;

    // dimensions first (lines under markers)
    for (const a of annotations.filter((a) => a.kind === "dimension" && layers.notes)) {
      ctx.strokeStyle = a.color || "#d97706"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px(a.x), py(a.y)); ctx.lineTo(px(a.x2 ?? a.x), py(a.y2 ?? a.y)); ctx.stroke();
      ctx.fillStyle = a.color || "#d97706"; ctx.font = "bold 14px Arial";
      ctx.fillText(a.text, (px(a.x) + px(a.x2 ?? a.x)) / 2 + 4, (py(a.y) + py(a.y2 ?? a.y)) / 2 - 4);
    }

    for (const pl of placements) {
      if (layers.equipment) {
        const x = px(pl.x), y = py(pl.y);
        ctx.save();
        ctx.translate(x, y); ctx.rotate(((Number(pl.rotation) || 0) * Math.PI) / 180);
        ctx.fillStyle = "rgba(30,64,175,.92)";
        ctx.fillRect(-16, -12, 32, 24);
        ctx.restore();
        ctx.fillStyle = "#fff"; ctx.font = "bold 11px Arial"; ctx.textAlign = "center";
        ctx.fillText(pl.label || pl.ceks_project_items?.item_number || "", x, y + 4);
        ctx.textAlign = "start";
      }
      for (const pt of pl.ceks_drawing_points || []) {
        const t = pt.ceks_utility_point_types;
        if (!pt.is_visible || (t && layers[t.code] === false)) continue;
        const x = px(Number(pl.x) + Number(pt.dx)), y = py(Number(pl.y) + Number(pt.dy));
        ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fillStyle = t?.color || "#888"; ctx.fill();
        ctx.strokeStyle = "#222"; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.font = "bold 9px Arial"; ctx.textAlign = "center";
        ctx.fillText(t?.symbol || "?", x, y + 3);
        ctx.textAlign = "start";
      }
    }

    if (layers.notes) {
      for (const a of annotations.filter((a) => a.kind !== "dimension")) {
        const x = px(a.x), y = py(a.y);
        ctx.font = a.kind === "label" ? "bold 14px Arial" : "12px Arial";
        const w = ctx.measureText(a.text).width;
        ctx.fillStyle = "rgba(255,255,220,.95)"; ctx.fillRect(x - 3, y - 13, w + 8, 18);
        ctx.strokeStyle = "#a8a29e"; ctx.strokeRect(x - 3, y - 13, w + 8, 18);
        ctx.fillStyle = "#1c1917"; ctx.fillText(a.text, x, y);
      }
    }

    // legend + title block (item 14: legend, revision, project info)
    let ly = 24;
    ctx.fillStyle = "#f8fafc"; ctx.fillRect(W, 0, legendW, H);
    ctx.strokeStyle = "#94a3b8"; ctx.strokeRect(W, 0, legendW, H);
    ctx.fillStyle = "#0f172a"; ctx.font = "bold 15px Arial";
    ctx.fillText(project.name, W + 14, ly); ly += 20;
    ctx.font = "12px Arial"; ctx.fillStyle = "#334155";
    if (project.code) { ctx.fillText(`Project ${project.code}`, W + 14, ly); ly += 16; }
    ctx.fillText(`${drawing.name} — Rev R${drawing.revision ?? 1}`, W + 14, ly); ly += 16;
    ctx.fillText(new Date().toLocaleDateString(), W + 14, ly); ly += 26;
    ctx.font = "bold 13px Arial"; ctx.fillStyle = "#0f172a";
    ctx.fillText("LEGEND", W + 14, ly); ly += 18;
    for (const t of point_types) {
      ctx.beginPath(); ctx.arc(W + 22, ly - 4, 8, 0, Math.PI * 2);
      ctx.fillStyle = t.color; ctx.fill(); ctx.strokeStyle = "#222"; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.font = "bold 8px Arial"; ctx.textAlign = "center";
      ctx.fillText(t.symbol, W + 22, ly - 1); ctx.textAlign = "start";
      ctx.fillStyle = "#0f172a"; ctx.font = "12px Arial";
      ctx.fillText(t.label, W + 38, ly); ly += 20;
    }
    if (drawing.legend_note) {
      ly += 8; ctx.font = "11px Arial"; ctx.fillStyle = "#475569";
      ctx.fillText(drawing.legend_note.slice(0, 40), W + 14, ly);
    }

    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(project.code || project.name).replace(/[^\w\-]+/g, "_")}_${drawing.name.replace(/[^\w\-]+/g, "_")}_R${drawing.revision ?? 1}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  }

  // ── render ────────────────────────────────────────────────────────────────
  const sheetW = baseSize ? Math.min(1100, baseSize.w) * zoom : undefined;

  return (
    <div className="panel drawing-panel">
      <button className="btn small ghost" onClick={onBack}>← Back to project</button>
      <div className="page-head">
        <h1>{drawing.name} <span className="pill">R{drawing.revision ?? 1}</span></h1>
        <div className="actions">
          <button className="btn small" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}>−</button>
          <span className="muted">{Math.round(zoom * 100)}%</span>
          <button className="btn small" onClick={() => setZoom((z) => Math.min(3, z + 0.2))}>+</button>
          <span className="sep" />
          <button className="btn" onClick={exportPng}>Export annotated PNG</button>
          <button className="btn" onClick={() => window.print()}>Print / PDF</button>
          {canManage && (
            <button className="btn primary" onClick={async () => {
              await api.saveDrawingRevision(drawing.id, prompt("Label for this revision?", `Revision ${drawing.revision ?? 1}`) || undefined);
              load();
            }}>Save revision</button>
          )}
        </div>
      </div>

      <div className="drawing-layout">
        {/* ── left rail: tools + layers + equipment to place ── */}
        <aside className="drawing-rail">
          {canManage && (
            <>
              <h2>Tools</h2>
              <div className="tool-col">
                <button className={"btn small " + (mode === "select" ? "primary" : "")} onClick={() => setMode("select")}>Select / move</button>
                <button className={"btn small " + (mode === "note" ? "primary" : "")} onClick={() => setMode("note")}>+ Note</button>
                <button className={"btn small " + (mode === "label" ? "primary" : "")} onClick={() => setMode("label")}>+ Label</button>
                <button className={"btn small " + (mode === "dimension" ? "primary" : "")} onClick={() => { setMode("dimension"); setDimStart(null); }}>
                  + Dimension {mode === "dimension" && (dimStart ? "(click end)" : "(click start)")}
                </button>
              </div>
              {selected && (
                <>
                  <h2>Selected</h2>
                  <div className="tool-col">
                    {selected.kind === "placement" && <>
                      <button className="btn small" onClick={() => rotateSelected(90)}>Rotate 90°</button>
                      <button className="btn small" onClick={async () => { await api.regeneratePoints(drawing.id, selected.id).then(setState); }}>Regenerate points</button>
                    </>}
                    {selected.kind === "point" && (
                      <button className="btn small" onClick={async () => {
                        const p = placements.flatMap((pl) => pl.ceks_drawing_points || []).find((q) => q.id === selected.id);
                        await api.updatePoint(drawing.id, selected.id, { note: prompt("Point note:", p?.note || "") ?? p?.note });
                        load();
                      }}>Edit note</button>
                    )}
                    <button className="btn small danger" onClick={removeSelected}>Delete</button>
                  </div>
                </>
              )}
            </>
          )}

          <h2>Layers</h2>
          <label className="check"><input type="checkbox" checked={!!layers.equipment} onChange={(e) => setLayers({ ...layers, equipment: e.target.checked })} /> Equipment</label>
          {point_types.map((t) => (
            <label className="check" key={t.code}>
              <input type="checkbox" checked={layers[t.code] !== false} onChange={(e) => setLayers({ ...layers, [t.code]: e.target.checked })} />
              <span className="swatch" style={{ background: t.color }} /> {t.label}
            </label>
          ))}
          <label className="check"><input type="checkbox" checked={!!layers.notes} onChange={(e) => setLayers({ ...layers, notes: e.target.checked })} /> Notes &amp; dimensions</label>

          {canManage && (
            <>
              <h2>Place equipment</h2>
              <div className="place-list">
                {projectItems.map((it) => (
                  <button key={it.id}
                    className={"place-item " + (mode === `place:${it.id}` ? "active" : "") + (placedIds.has(it.id) ? " placed" : "")}
                    onClick={() => setMode(mode === `place:${it.id}` ? "select" : `place:${it.id}`)}
                    title={placedIds.has(it.id) ? "Already placed (can be placed again)" : "Click, then click the drawing"}>
                    <b>{it.item_number}</b> {it.ceks_knowledge_entries?.title?.slice(0, 30)}
                    {placedIds.has(it.id) && " ✓"}
                  </button>
                ))}
                {!projectItems.length && <div className="muted">Add equipment to the project first.</div>}
              </div>
            </>
          )}
        </aside>

        {/* ── the sheet ── */}
        <div className="drawing-scroll">
          <div
            ref={wrapRef}
            className={"sheet " + (mode !== "select" ? "placing" : "")}
            style={{ width: sheetW }}
            onClick={sheetClick}
          >
            {drawing.kind === "pdf"
              ? <canvas ref={pdfCanvasRef} className="sheet-base" />
              : <img ref={baseImgRef} src={drawing.storage_url} alt={drawing.name} className="sheet-base" crossOrigin="anonymous"
                  onLoad={(e) => setBaseSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })} />}

            {/* dimensions as SVG lines */}
            {layers.notes && (
              <svg className="sheet-svg" viewBox="0 0 1000 1000" preserveAspectRatio="none">
                {annotations.filter((a) => a.kind === "dimension").map((a) => (
                  <g key={a.id} onClick={(e) => { e.stopPropagation(); select("annotation", a); }}>
                    <line x1={a.x * 1000} y1={a.y * 1000} x2={(a.x2 ?? a.x) * 1000} y2={(a.y2 ?? a.y) * 1000}
                      stroke={a.color || "#d97706"} strokeWidth={selected?.id === a.id ? 6 : 3} vectorEffect="non-scaling-stroke" />
                  </g>
                ))}
              </svg>
            )}

            {/* equipment markers */}
            {layers.equipment && placements.map((pl) => {
              const item = pl.ceks_project_items;
              return (
                <div key={pl.id}
                  className={"marker" + (selected?.kind === "placement" && selected.id === pl.id ? " sel" : "")}
                  style={{ left: `${pl.x * 100}%`, top: `${pl.y * 100}%`, transform: `translate(-50%,-50%) rotate(${pl.rotation || 0}deg)` }}
                  onPointerDown={(e) => startDrag(e, "placement", pl)}
                  onClick={(e) => e.stopPropagation()}
                  title={item?.ceks_knowledge_entries?.title}
                >{pl.label || item?.item_number || "?"}</div>
              );
            })}

            {/* coloured utility points */}
            {placements.flatMap((pl) =>
              (pl.ceks_drawing_points || []).map((pt) => {
                const t = pt.ceks_utility_point_types;
                if (!pt.is_visible || (t && layers[t.code] === false)) return null;
                return (
                  <div key={pt.id}
                    className={"upoint" + (selected?.kind === "point" && selected.id === pt.id ? " sel" : "")}
                    style={{ left: `${(Number(pl.x) + Number(pt.dx)) * 100}%`, top: `${(Number(pl.y) + Number(pt.dy)) * 100}%`, background: t?.color }}
                    onPointerDown={(e) => startDrag(e, "point", pt, pl)}
                    onClick={(e) => e.stopPropagation()}
                    title={`${t?.label || ""} ${pt.value || ""} ${pt.height ? "@ " + pt.height : ""} ${pt.note || ""}`.trim()}
                  >{t?.symbol}</div>
                );
              })
            )}

            {/* notes & labels */}
            {layers.notes && annotations.filter((a) => a.kind !== "dimension").map((a) => (
              <div key={a.id}
                className={"anno " + a.kind + (selected?.kind === "annotation" && selected.id === a.id ? " sel" : "")}
                style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}
                onPointerDown={(e) => startDrag(e, "annotation", a)}
                onClick={(e) => e.stopPropagation()}
              >{a.text}</div>
            ))}
          </div>
        </div>

        {/* ── equipment info panel (item 13) ── */}
        {info && (
          <aside className="drawing-info">
            <button className="x" style={{ float: "right" }} onClick={() => setInfo(null)}>×</button>
            {info.loading && <div className="muted">Loading equipment data…</div>}
            {info.error && <div className="alert">{info.error}</div>}
            {info.detail && <EquipmentInfo detail={info.detail} recs={info.recs} placement={info.placement} />}
          </aside>
        )}
      </div>
    </div>
  );
}

function EquipmentInfo({ detail, recs, placement }) {
  const entry = detail.entry;
  const groups = {};
  for (const a of detail.attributes || []) (groups[a.attr_group] = groups[a.attr_group] || []).push(a);
  const order = ["dimensions_clearance", "electrical", "water_drain", "gas", "ventilation", "installation"];
  const labels = {
    dimensions_clearance: "Dimensions & Clearances", electrical: "Electrical", water_drain: "Water & Drain",
    gas: "Gas", ventilation: "Ventilation", installation: "Installation", other: "Other",
  };
  const currentRecs = (recs?.disciplines || [])
    .flatMap((d) => d.items || [])
    .filter((r) => !["rejected", "no_rule", "missing_input"].includes(r.status));

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>{placement?.ceks_project_items?.item_number} — {entry.title}</h2>
      <div className="muted" style={{ fontSize: 12 }}>
        {entry.brand} · {entry.equipment_type} · {entry.model_number || entry.code}
      </div>

      {currentRecs.length > 0 && (
        <>
          <h3>CULINOVA recommendations</h3>
          {currentRecs.map((r) => (
            <div key={r.id} className="rec-line">
              <b>{r.parameter_label || r.parameter_key}:</b> {r.final_value ?? r.value_text ?? r.value_num} {r.final_unit || r.unit || ""}
              {r.rule_code && <span className="muted"> — Rule {r.rule_code} v{r.rule_version}</span>}
            </div>
          ))}
        </>
      )}

      {order.filter((g) => groups[g]?.length).map((g) => (
        <div key={g}>
          <h3>{labels[g] || g}</h3>
          {groups[g].slice(0, 14).map((a) => (
            <div key={a.id} className="rec-line">{a.name}: <b>{a.value ?? "—"} {a.unit || ""}</b></div>
          ))}
        </div>
      ))}

      {(detail.documents || []).length > 0 && (
        <>
          <h3>Documents</h3>
          {detail.documents.map((d) => (
            <div key={d.id}><a href={d.storage_url} target="_blank" rel="noreferrer">{d.file_name}</a></div>
          ))}
        </>
      )}
    </div>
  );
}
