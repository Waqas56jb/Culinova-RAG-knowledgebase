import React, { useState } from "react";
import Markdown from "./Markdown.jsx";

const SUGGESTIONS = [
  "What breaker size and cable do I need?",
  "What are the water and drain requirements?",
  "What clearances are required for installation?",
  "Summarize the electrical connection.",
];

// `api` is injected by each app so this single component works against either the
// admin or the public-portal api client (both expose aiSummary/aiNotes/ask).
export default function AIAssistant({ entryId, api }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(fn, question) {
    setBusy(true); setError(""); setAnswer("");
    try {
      const r = await fn();
      setAnswer(r.answer || "");
      if (question) setQ(question);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="assistant">
      <div className="assistant-head">
        <span className="ai-badge">AI</span>
        <div>
          <div className="assistant-title">Engineering Assistant</div>
          <div className="muted">Answers only from this equipment's approved documents.</div>
        </div>
      </div>

      <div className="assistant-actions">
        <button className="btn small" disabled={busy} onClick={() => run(() => api.aiSummary(entryId), "Installation summary")}>Installation Summary</button>
        <button className="btn small" disabled={busy} onClick={() => run(() => api.aiNotes(entryId), "Engineering notes")}>Engineering Notes</button>
      </div>

      <form className="assistant-bar" onSubmit={(e) => { e.preventDefault(); if (q.trim()) run(() => api.ask(entryId, q), q); }}>
        <input placeholder="Ask about this equipment…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary small" type="submit" disabled={busy || !q.trim()}>Ask</button>
      </form>

      {!answer && !busy && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => run(() => api.ask(entryId, s), s)}>{s}</button>
          ))}
        </div>
      )}

      {busy && <div className="muted">Thinking…</div>}
      {error && <div className="alert">{error}</div>}
      {answer && <div className="assistant-answer"><Markdown text={answer} /></div>}
    </div>
  );
}
