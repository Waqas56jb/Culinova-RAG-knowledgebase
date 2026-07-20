import { j } from "@shared/lib/http.js";
import { eosApiBase } from "@shared/lib/deploy.js";

const API = eosApiBase();

// ── auth/session ──────────────────────────────────────────────────────────────
const store = {
  get access() { return localStorage.getItem("eos_access") || ""; },
  set access(v) { v ? localStorage.setItem("eos_access", v) : localStorage.removeItem("eos_access"); },
  get refresh() { return localStorage.getItem("eos_refresh") || ""; },
  set refresh(v) { v ? localStorage.setItem("eos_refresh", v) : localStorage.removeItem("eos_refresh"); },
  get user() { try { return JSON.parse(localStorage.getItem("eos_user") || "null"); } catch { return null; } },
  set user(v) { v ? localStorage.setItem("eos_user", JSON.stringify(v)) : localStorage.removeItem("eos_user"); },
};

let onAuthChange = () => {};
export const setAuthListener = (fn) => { onAuthChange = fn || (() => {}); };
export const session = {
  get user() { return store.user; },
  get signedIn() { return !!store.access; },
  can: (perm) => !!(store.user && (store.user.permissions || []).includes(perm)),
};

const authHeaders = () => (store.access ? { Authorization: `Bearer ${store.access}` } : {});

/** fetch with bearer token; on 401 tries ONE refresh, then surfaces the sign-in screen */
async function f(path, opts = {}, retry = true) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), ...authHeaders() },
  });
  if (res.status === 401 && retry && store.refresh) {
    const ok = await tryRefresh();
    if (ok) return f(path, opts, false);
  }
  if (res.status === 401) { signOutLocal(); }
  return j(res);
}

async function tryRefresh() {
  try {
    const r = await fetch(`${API}/api/auth/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: store.refresh }),
    });
    if (!r.ok) return false;
    const data = await r.json();
    store.access = data.access_token;
    store.user = data.user;
    onAuthChange();
    return true;
  } catch { return false; }
}

function signOutLocal() {
  store.access = ""; store.refresh = ""; store.user = null;
  onAuthChange();
}

const jf = (path, body, method = "POST") =>
  f(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

/** authenticated file download (the API needs the bearer header, so plain <a href> can't be used) */
async function download(path) {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).error || m; } catch {} throw new Error(m); }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] || "export";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const api = {
  base: API,
  health: () => fetch(`${API}/api/health`).then(j),
  download,

  // ── auth ───────────────────────────────────────────────────────────────────
  login: async (email, password) => {
    const res = await fetch(`${API}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch {
        msg = `Cannot reach EOS API at ${API} (${res.status} ${res.statusText}). Is the server running on port 4400?`;
      }
      throw new Error(msg);
    }
    const data = await res.json();
    store.access = data.access_token; store.refresh = data.refresh_token; store.user = data.user;
    onAuthChange();
    return data.user;
  },
  logout: async () => {
    try { await jf("/api/auth/logout", { refresh_token: store.refresh }); } catch {}
    signOutLocal();
  },
  me: () => f("/api/auth/me").then((u) => { store.user = u; onAuthChange(); return u; }),
  users: () => f("/api/auth/users"),
  createUser: (body) => jf("/api/auth/users", body),
  updateUser: (id, body) => jf(`/api/auth/users/${id}`, body, "PATCH"),
  roles: () => f("/api/auth/roles"),
  setRolePermissions: (roleId, permissions) => jf(`/api/auth/roles/${roleId}/permissions`, { permissions }, "PUT"),

  // ── knowledge (existing screens) ───────────────────────────────────────────
  uploadPdf: (files, docTypes) => {
    const fd = new FormData();
    files.forEach((x) => fd.append("files", x));
    fd.append("doc_types", JSON.stringify(docTypes));
    return f(`/api/ingest/pdf`, { method: "POST", body: fd });
  },
  uploadFolder: (list) => {
    const fd = new FormData();
    const paths = [];
    list.forEach((e) => { const file = e.file || e; fd.append("files", file); paths.push(e.path || file.webkitRelativePath || file.name); });
    fd.append("paths", JSON.stringify(paths));
    return f(`/api/ingest/folder`, { method: "POST", body: fd });
  },
  uploadExcel: (file) => { const fd = new FormData(); fd.append("file", file); return f(`/api/ingest/excel`, { method: "POST", body: fd }); },

  // ── batched import jobs — a large sheet that can never time out ─────────────
  // The client drives the run one small batch at a time, so no single request is
  // ever long enough to hit a serverless limit, and progress is real, not faked.
  importPrepare: (file, sheet) => {
    const fd = new FormData();
    fd.append("file", file);
    if (sheet) fd.append("sheet", sheet);
    return f(`/api/import-jobs/prepare`, { method: "POST", body: fd });
  },
  importBatch: (jobId, size) => jf(`/api/import-jobs/${jobId}/batch`, { size }),
  importStatus: (jobId) => f(`/api/import-jobs/${jobId}`),
  importPreview: (jobId, limit = 25) => f(`/api/import-jobs/${jobId}/preview?limit=${limit}`),
  importCancel: (jobId) => jf(`/api/import-jobs/${jobId}/cancel`),
  downloadExcelTemplate: () => download(`/api/ingest/excel-template`),
  uploadManual: (payload) => jf(`/api/ingest/manual`, payload),
  uploadImage: (entryId, file) => { const fd = new FormData(); fd.append("image", file); return f(`/api/ingest/image/${entryId}`, { method: "POST", body: fd }); },
  findDocuments: (id) => f(`/api/entries/${id}/find-documents`),
  drafts: (status = "pending") => f(`/api/drafts?status=${status}`),
  entry: (id) => f(`/api/entries/${id}`),
  patchAttr: (id, patch) => jf(`/api/attributes/${id}`, patch, "PATCH"),
  createAttr: (entryId, body) => jf(`/api/entries/${entryId}/attributes`, body),
  attrPhoto: (attrId, file) => { const fd = new FormData(); fd.append("image", file); return f(`/api/attributes/${attrId}/photo`, { method: "POST", body: fd }); },
  deleteAttr: (id) => f(`/api/attributes/${id}`, { method: "DELETE" }),
  deleteEntry: (id) => f(`/api/entries/${id}`, { method: "DELETE" }),
  adminEntries: (params) => f(`/api/admin/entries?${new URLSearchParams(params)}`),
  adminFilters: (params) => f(`/api/admin/filters?${new URLSearchParams(params || {})}`),
  updateIdentity: (id, body) => jf(`/api/entries/${id}/identity`, body, "PATCH"),
  adminStats: () => f(`/api/admin/stats`),
  bulkApprove: (ids) => jf(`/api/admin/bulk-approve`, { ids }),
  history: (id) => f(`/api/entries/${id}/history`),
  ask: (id, question) => jf(`/api/entries/${id}/ask`, { question }),
  aiSummary: (id) => jf(`/api/entries/${id}/summary`, {}),
  aiNotes: (id) => jf(`/api/entries/${id}/engineering-notes`, {}),
  aiChecklist: (id, type) => jf(`/api/entries/${id}/checklist`, { type }),
  approve: (id, comment) => jf(`/api/entries/${id}/approve`, { comment }),
  reject: (id, comment) => jf(`/api/entries/${id}/reject`, { comment }),
  submit: (id, comment) => jf(`/api/entries/${id}/submit`, { comment }),

  // ── engineering rules ─────────────────────────────────────────────────────
  rulesMeta: () => f(`/api/rules/meta`),
  rules: (params) => f(`/api/rules?${new URLSearchParams(params || {})}`),
  rule: (id) => f(`/api/rules/${id}`),
  validateRule: (body) => jf(`/api/rules/validate`, body),
  createRule: (body) => jf(`/api/rules`, body),
  updateRule: (id, body) => jf(`/api/rules/${id}`, body, "PATCH"),
  duplicateRule: (id, body) => jf(`/api/rules/${id}/duplicate`, body),
  approveRule: (id, body) => jf(`/api/rules/${id}/approve`, body),
  activateRule: (id, active) => jf(`/api/rules/${id}/activate`, { active }),
  archiveRule: (id, reason) => jf(`/api/rules/${id}/archive`, { reason }),
  downloadRuleTemplate: (discipline) => download(`/api/rules/import/template${discipline ? `?discipline=${discipline}` : ""}`),
  ruleImportPreview: (file, discipline_id) => {
    const fd = new FormData(); fd.append("file", file);
    if (discipline_id) fd.append("discipline_id", discipline_id);
    return f(`/api/rules/import/preview`, { method: "POST", body: fd });
  },
  ruleImportCommit: (file, discipline_id) => {
    const fd = new FormData(); fd.append("file", file);
    if (discipline_id) fd.append("discipline_id", discipline_id);
    return f(`/api/rules/import/commit`, { method: "POST", body: fd });
  },

  // ── parameter dictionary ──────────────────────────────────────────────────
  dictionary: () => f(`/api/dictionary`),
  dictParameters: (params) => f(`/api/dictionary/parameters?${new URLSearchParams(params || {})}`),
  dictCreateParameter: (body) => jf(`/api/dictionary/parameters`, body),
  dictUpdateParameter: (id, body) => jf(`/api/dictionary/parameters/${id}`, body, "PATCH"),
  dictDeleteParameter: (id) => f(`/api/dictionary/parameters/${id}`, { method: "DELETE" }),
  dictAliases: (params) => f(`/api/dictionary/aliases?${new URLSearchParams(params || {})}`),
  dictCreateAlias: (body) => jf(`/api/dictionary/aliases`, body),
  dictDeleteAlias: (id) => f(`/api/dictionary/aliases/${id}`, { method: "DELETE" }),
  dictUnits: () => f(`/api/dictionary/units`),
  dictCreateUnit: (body) => jf(`/api/dictionary/units`, body),
  dictDeleteUnit: (id) => f(`/api/dictionary/units/${id}`, { method: "DELETE" }),
  dictValueNorms: (params) => f(`/api/dictionary/value-normalizations?${new URLSearchParams(params || {})}`),
  dictCreateValueNorm: (body) => jf(`/api/dictionary/value-normalizations`, body),
  dictDeleteValueNorm: (id) => f(`/api/dictionary/value-normalizations/${id}`, { method: "DELETE" }),
  dictConstants: () => f(`/api/dictionary/constants`),
  dictCreateConstant: (body) => jf(`/api/dictionary/constants`, body),
  dictUpdateConstant: (id, body) => jf(`/api/dictionary/constants/${id}`, body, "PATCH"),
  dictDeleteConstant: (id) => f(`/api/dictionary/constants/${id}`, { method: "DELETE" }),
  dictSettings: () => f(`/api/dictionary/settings`),
  dictSetSetting: (key, value) => jf(`/api/dictionary/settings/${key}`, { value }, "PUT"),
  dictUnmapped: () => f(`/api/dictionary/unmapped`),
  dictDisciplines: () => f(`/api/dictionary/disciplines`),
  dictUpdateDiscipline: (id, body) => jf(`/api/dictionary/disciplines/${id}`, body, "PATCH"),

  // ── recommendations (Review screen) ───────────────────────────────────────
  recsForEntry: (entryId) => f(`/api/recommendations/entry/${entryId}`),
  recsGenerate: (entryId) => jf(`/api/recommendations/entry/${entryId}/generate`, {}),
  recsRecalculate: (versionId) => jf(`/api/recommendations/version/${versionId}/recalculate`, {}),
  recDecide: (recId, body) => jf(`/api/recommendations/${recId}/decide`, body),
  recTrace: (recId) => f(`/api/recommendations/${recId}/trace`),
  recsHistory: (versionId) => f(`/api/recommendations/version/${versionId}/history`),
  recsBlockers: (versionId) => f(`/api/recommendations/version/${versionId}/blockers`),
  resolveValidation: (id, note) => jf(`/api/recommendations/validations/${id}/resolve`, { note }),
  entryReport: (entryId) => f(`/api/recommendations/entry/${entryId}/report`),

  // ── projects / schedules / drawings ───────────────────────────────────────
  projects: () => f(`/api/projects`),
  createProject: (body) => jf(`/api/projects`, body),
  project: (id) => f(`/api/projects/${id}`),
  updateProject: (id, body) => jf(`/api/projects/${id}`, body, "PATCH"),
  addProjectItem: (id, body) => jf(`/api/projects/${id}/items`, body),
  updateProjectItem: (id, itemId, body) => jf(`/api/projects/${id}/items/${itemId}`, body, "PATCH"),
  replaceProjectItem: (id, itemId, entry_id) => jf(`/api/projects/${id}/items/${itemId}/replace`, { entry_id }),
  removeProjectItem: (id, itemId) => f(`/api/projects/${id}/items/${itemId}`, { method: "DELETE" }),
  saveProjectRevision: (id, label) => jf(`/api/projects/${id}/revisions`, { label }),
  projectRevision: (id, rev) => f(`/api/projects/${id}/revisions/${rev}`),
  scheduleTypes: () => f(`/api/projects/meta/schedule-types`),
  pointTypes: () => f(`/api/projects/meta/point-types`),
  schedule: (id, code) => f(`/api/projects/${id}/schedules/${code}`),
  allSchedules: (id) => f(`/api/projects/${id}/schedules`),
  exportSchedule: (id, code, format) => download(`/api/projects/${id}/schedules/${code}/export?format=${format || "xlsx"}`),
  exportAllSchedules: (id) => download(`/api/projects/${id}/schedules-export/all`),
  autocadSchedule: (id) => f(`/api/projects/${id}/autocad-schedule?format=json`),
  exportAutocad: (id, format) => download(`/api/projects/${id}/autocad-schedule?format=${format || "xlsx"}`),
  mepPoints: (id) => f(`/api/projects/${id}/mep-points`),
  exportMepPoints: (id, format) => download(`/api/projects/${id}/mep-points/export?format=${format || "xlsx"}`),
  exportCoordinates: (id, format) => download(`/api/projects/${id}/coordinates/export?format=${format || "xlsx"}`),
  projectReport: (id, params) => f(`/api/projects/${id}/report?${new URLSearchParams(params || {})}`),
  askProject: (id, question) => jf(`/api/projects/${id}/ask`, { question }),
  approvedEntries: (query, page = 1) => f(`/api/knowledge?${new URLSearchParams({ query: query || "", page, limit: 30 })}`),

  // drawings
  uploadDrawing: (project_id, file, name) => {
    const fd = new FormData();
    fd.append("file", file); fd.append("project_id", project_id);
    if (name) fd.append("name", name);
    return f(`/api/drawings`, { method: "POST", body: fd });
  },
  drawing: (id) => f(`/api/drawings/${id}`),
  updateDrawing: (id, body) => jf(`/api/drawings/${id}`, body, "PATCH"),
  deleteDrawing: (id) => f(`/api/drawings/${id}`, { method: "DELETE" }),
  addPlacement: (id, body) => jf(`/api/drawings/${id}/placements`, body),
  updatePlacement: (id, pid, body) => jf(`/api/drawings/${id}/placements/${pid}`, body, "PATCH"),
  deletePlacement: (id, pid) => f(`/api/drawings/${id}/placements/${pid}`, { method: "DELETE" }),
  regeneratePoints: (id, pid) => jf(`/api/drawings/${id}/placements/${pid}/regenerate-points`, {}),
  addPoint: (id, body) => jf(`/api/drawings/${id}/points`, body),
  updatePoint: (id, pointId, body) => jf(`/api/drawings/${id}/points/${pointId}`, body, "PATCH"),
  deletePoint: (id, pointId) => f(`/api/drawings/${id}/points/${pointId}`, { method: "DELETE" }),
  addAnnotation: (id, body) => jf(`/api/drawings/${id}/annotations`, body),
  updateAnnotation: (id, aid, body) => jf(`/api/drawings/${id}/annotations/${aid}`, body, "PATCH"),
  deleteAnnotation: (id, aid) => f(`/api/drawings/${id}/annotations/${aid}`, { method: "DELETE" }),
  saveDrawingRevision: (id, label) => jf(`/api/drawings/${id}/revisions`, { label }),

  // ── category engineering standards ─────────────────────────────────────────
  standardsProfiles: (domain) => f(`/api/standards/category-profiles?${new URLSearchParams(domain ? { domain } : {})}`),
  standardsProfile: (id) => f(`/api/standards/category-profiles/${id}`),
  standardsPending: () => f(`/api/standards/pending`),
  standardsImportPreview: (file, domain) => {
    const fd = new FormData(); fd.append("file", file);
    if (domain) fd.append("domain", domain);
    return f(`/api/standards/import/preview`, { method: "POST", body: fd });
  },
  standardsImportCommit: (file, domain) => {
    const fd = new FormData(); fd.append("file", file);
    if (domain) fd.append("domain", domain);
    return f(`/api/standards/import/commit`, { method: "POST", body: fd });
  },
  standardsForEquipment: (entryId) => f(`/api/standards/for-equipment/${entryId}`),
  linkCategoryProfile: (entryId, profile_id) => jf(`/api/standards/for-equipment/${entryId}/link`, { profile_id }),

  // ── engineering requests inbox (sales handoffs from Custom ERP) ─────────────
  engineeringRequests: () => f("/api/engineering-requests"),
  engineeringRequest: (id) => f(`/api/engineering-requests/${id}`),
  updateEngineeringRequest: (id, body) => jf(`/api/engineering-requests/${id}`, body, "PATCH"),
};
