import React, { useState, useEffect } from "react";
import { api, session, setAuthListener } from "./api.js";
import Login from "./pages/Login.jsx";
import Upload from "./pages/Upload.jsx";
import Drafts from "./pages/Drafts.jsx";
import Review from "./pages/Review.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Rules from "./pages/Rules.jsx";
import Dictionary from "./pages/Dictionary.jsx";
import Projects from "./pages/Projects.jsx";
import ProjectWorkspace from "./pages/ProjectWorkspace.jsx";
import Users from "./pages/Users.jsx";

const TABS = [
  { key: "dashboard", label: "Dashboard", accent: "indigo" },
  { key: "drafts", label: "Library", perm: "knowledge.read", accent: "indigo" },
  { key: "upload", label: "Import", perm: "knowledge.ingest", accent: "emerald" },
  { key: "rules", label: "Rules", perm: "rule.read", accent: "amber" },
  { key: "dictionary", label: "Dictionary", perm: "rule.read", accent: "violet" },
  { key: "projects", label: "Projects", perm: "project.read", accent: "cyan" },
  { key: "users", label: "Users", perm: "user.manage", accent: "rose" },
];

function tabActive(view, key) {
  if (view.name === key) return true;
  if (view.name === "review" && key === "drafts") return true;
  if (view.name === "project" && key === "projects") return true;
  return false;
}

export default function App() {
  const [view, setView] = useState({ name: "dashboard" });
  const [online, setOnline] = useState(null);
  const [, force] = useState(0);

  useEffect(() => {
    setAuthListener(() => force((n) => n + 1));
    api.health().then(() => setOnline(true)).catch(() => setOnline(false));
    if (session.signedIn) api.me().catch(() => {});
  }, []);

  if (!session.signedIn) return <Login />;

  const user = session.user || {};
  const tabs = TABS.filter((t) => !t.perm || session.can(t.perm));
  const firstName = (user.full_name || user.email || "").split(" ")[0];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden />
            <div>
              <span className="brand-main">CULINOVA EOS</span>
              <span className="brand-sub">Engineering admin</span>
            </div>
          </div>

          <nav className="tabs" aria-label="Main">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                className={"tab tab-" + t.accent + (tabActive(view, t.key) ? " active" : "")}
                onClick={() => setView({ name: t.key })}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="topbar-right">
            <span className={"status-dot " + (online ? "ok" : online === false ? "bad" : "")} title={online ? "API online" : "API offline"} />
            <span className="who-name">{firstName}</span>
            <button type="button" className="btn-signout" onClick={() => api.logout()}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="content">
        {view.name === "dashboard" && <Dashboard onOpen={(filter) => setView({ name: "drafts", filter })} />}
        {view.name === "upload" && <Upload onDone={(id) => setView({ name: "review", id })} />}
        {view.name === "drafts" && (
          <Drafts key={JSON.stringify(view.filter || {})} initialFilter={view.filter} onOpen={(id) => setView({ name: "review", id })} />
        )}
        {view.name === "review" && <Review id={view.id} onBack={() => setView({ name: "drafts" })} />}
        {view.name === "rules" && <Rules />}
        {view.name === "dictionary" && <Dictionary />}
        {view.name === "projects" && <Projects onOpen={(id) => setView({ name: "project", id })} />}
        {view.name === "project" && <ProjectWorkspace id={view.id} onBack={() => setView({ name: "projects" })} />}
        {view.name === "users" && <Users />}
      </main>
    </div>
  );
}
