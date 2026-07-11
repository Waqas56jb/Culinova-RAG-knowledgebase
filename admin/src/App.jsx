import React, { useState, useEffect } from "react";
import { api } from "./api.js";
import Upload from "./pages/Upload.jsx";
import Drafts from "./pages/Drafts.jsx";
import Review from "./pages/Review.jsx";
import Dashboard from "./pages/Dashboard.jsx";

export default function App() {
  const [view, setView] = useState({ name: "dashboard" });
  const [online, setOnline] = useState(null);

  useEffect(() => {
    api.health().then(() => setOnline(true)).catch(() => setOnline(false));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-main">CULINOVA EOS</span>
          <span className="brand-sub">Engineering Knowledge — Admin</span>
        </div>
        <nav className="tabs">
          <button className={view.name === "dashboard" ? "tab active" : "tab"} onClick={() => setView({ name: "dashboard" })}>
            Dashboard
          </button>
          <button className={view.name === "drafts" ? "tab active" : "tab"} onClick={() => setView({ name: "drafts" })}>
            Knowledge Library
          </button>
          <button className={view.name === "upload" ? "tab active" : "tab"} onClick={() => setView({ name: "upload" })}>
            AI Import
          </button>
        </nav>
        <div className={"status " + (online ? "ok" : online === false ? "bad" : "")}>
          {online == null ? "…" : online ? "API online" : "API offline"}
        </div>
      </header>

      <main className="content">
        {view.name === "dashboard" && <Dashboard onOpen={(filter) => setView({ name: "drafts", filter })} />}
        {view.name === "upload" && <Upload onDone={(id) => setView({ name: "review", id })} />}
        {view.name === "drafts" && <Drafts key={JSON.stringify(view.filter || {})} initialFilter={view.filter} onOpen={(id) => setView({ name: "review", id })} />}
        {view.name === "review" && (
          <Review id={view.id} onBack={() => setView({ name: "drafts" })} />
        )}
      </main>
    </div>
  );
}
