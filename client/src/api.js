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
  search: (query, page = 1) =>
    fetch(`${API}/api/knowledge?query=${encodeURIComponent(query || "")}&page=${page}`).then(j),
  detail: (id) => fetch(`${API}/api/knowledge/${id}`).then(j),
  ask: (id, question) => fetch(`${API}/api/entries/${id}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) }).then(j),
  aiSummary: (id) => fetch(`${API}/api/entries/${id}/summary`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(j),
  aiNotes: (id) => fetch(`${API}/api/entries/${id}/engineering-notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(j),
};
