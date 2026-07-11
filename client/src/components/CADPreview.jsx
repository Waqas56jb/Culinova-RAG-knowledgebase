import React, { useState } from "react";
import { api } from "../api.js";

const DOC_LABELS = {
  datasheet: "Datasheet", technical_data: "Technical Data", user_manual: "User Manual",
  installation_manual: "Installation Manual", service_manual: "Service Manual",
  spare_parts: "Spare Parts", document: "Document", cad: "CAD Drawing",
};
const fileUrl = (u) => (!u ? "" : /^https?:\/\//.test(u) ? u : `${api.base}${u}`);

export default function CADPreview({ documents, files }) {
  const [open, setOpen] = useState(null);
  const docs = documents || [];
  const cads = (files || []).filter((f) => f.asset_type === "cad");
  const preview = open || docs.find((d) => d.doc_type === "datasheet") || docs[0];
  if (!preview && !cads.length) return null;
  return (
    <section className="rec-group">
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
          <iframe title="document preview" className="pdf-frame" src={fileUrl(preview.storage_url)} />
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
    </section>
  );
}
