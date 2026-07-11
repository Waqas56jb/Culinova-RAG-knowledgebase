const API = import.meta.env.VITE_API_BASE || "http://localhost:4400";

async function j(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  base: API,
  health: () => fetch(`${API}/api/health`).then(j),
  uploadPdf: (files, docTypes) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("doc_types", JSON.stringify(docTypes));
    return fetch(`${API}/api/ingest/pdf`, { method: "POST", body: fd }).then(j);
  },
  uploadFolder: (list) => {
    // list: File[] (from folder picker, with webkitRelativePath) OR {file, path}[] (from drag & drop)
    const fd = new FormData();
    const paths = [];
    list.forEach((e) => { const file = e.file || e; fd.append("files", file); paths.push(e.path || file.webkitRelativePath || file.name); });
    fd.append("paths", JSON.stringify(paths));
    return fetch(`${API}/api/ingest/folder`, { method: "POST", body: fd }).then(j);
  },
  uploadExcel: (file) => { const fd = new FormData(); fd.append("file", file); return fetch(`${API}/api/ingest/excel`, { method: "POST", body: fd }).then(j); },
  excelTemplateUrl: `${API}/api/ingest/excel-template`,
  uploadManual: (payload) => fetch(`${API}/api/ingest/manual`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(j),
  uploadImage: (entryId, file) => { const fd = new FormData(); fd.append("image", file); return fetch(`${API}/api/ingest/image/${entryId}`, { method: "POST", body: fd }).then(j); },
  findDocuments: (id) => fetch(`${API}/api/entries/${id}/find-documents`).then(j),
  drafts: (status = "pending") => fetch(`${API}/api/drafts?status=${status}`).then(j),
  entry: (id) => fetch(`${API}/api/entries/${id}`).then(j),
  patchAttr: (id, patch) =>
    fetch(`${API}/api/attributes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(j),
  createAttr: (entryId, body) => fetch(`${API}/api/entries/${entryId}/attributes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(j),
  attrPhoto: (attrId, file) => { const fd = new FormData(); fd.append("image", file); return fetch(`${API}/api/attributes/${attrId}/photo`, { method: "POST", body: fd }).then(j); },
  deleteAttr: (id) => fetch(`${API}/api/attributes/${id}`, { method: "DELETE" }).then(j),
  deleteEntry: (id) => fetch(`${API}/api/entries/${id}`, { method: "DELETE" }).then(j),
  // admin portal
  adminEntries: (params) => fetch(`${API}/api/admin/entries?${new URLSearchParams(params)}`).then(j),
  adminFilters: (params) => fetch(`${API}/api/admin/filters?${new URLSearchParams(params || {})}`).then(j),
  updateIdentity: (id, body) => fetch(`${API}/api/entries/${id}/identity`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(j),
  adminStats: () => fetch(`${API}/api/admin/stats`).then(j),
  bulkApprove: (ids) => fetch(`${API}/api/admin/bulk-approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }).then(j),
  history: (id) => fetch(`${API}/api/entries/${id}/history`).then(j),
  // AI assistant
  ask: (id, question) => fetch(`${API}/api/entries/${id}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) }).then(j),
  aiSummary: (id) => fetch(`${API}/api/entries/${id}/summary`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(j),
  aiNotes: (id) => fetch(`${API}/api/entries/${id}/engineering-notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(j),
  approve: (id, comment) => act(id, "approve", comment),
  reject: (id, comment) => act(id, "reject", comment),
  submit: (id, comment) => act(id, "submit", comment),
};

function act(id, action, comment) {
  return fetch(`${API}/api/entries/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comment }),
  }).then(j);
}
