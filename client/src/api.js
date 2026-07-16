import { j } from "@shared/lib/http.js";
import { eosApiBase } from "@shared/lib/deploy.js";

const API = eosApiBase();

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
