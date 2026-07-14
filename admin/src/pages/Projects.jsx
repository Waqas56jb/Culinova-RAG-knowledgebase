import React, { useEffect, useState } from "react";
import { api, session } from "../api.js";
import { Btn, PageLoader } from "../components/Loader.jsx";
import { PageHero, PagePanel, SectionCard, StatPill } from "../components/PageShell.jsx";

const STATUS = { draft: "Draft", under_review: "Under Review", approved: "Approved", published: "Published", archived: "Archived" };

export default function Projects({ onOpen }) {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ name: "", code: "", client: "", location: "" });
  const [error, setError] = useState("");
  const canManage = session.can("project.manage");

  const load = () => api.projects().then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function create() {
    setError("");
    try {
      const p = await api.createProject(form);
      onOpen(p.id);
    } catch (e) { setError(e.message); }
  }

  if (!list) return <PagePanel accent="cyan">{error ? <div className="alert">{error}</div> : <PageLoader label="Loading projects…" />}</PagePanel>;

  return (
    <PagePanel accent="cyan">
      <PageHero
        accent="cyan"
        title="Project Engineering Workspace"
        subtitle="Select approved EOS equipment and generate schedules, MEP points, drawings and reports."
        badge={<StatPill>{list.length} project{list.length === 1 ? "" : "s"}</StatPill>}
      />
      {error && <div className="alert">{error}</div>}

      {canManage && (
        <SectionCard title="New project" icon="➕">
          <div className="add-row">
            <input placeholder="Project name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="Code (RUH-052)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} style={{ width: 120 }} />
            <input placeholder="Client" value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} />
            <input placeholder="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            <Btn className="small primary" disabled={!form.name.trim()} onClick={create}>Create</Btn>
          </div>
        </SectionCard>
      )}

      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>Code</th><th>Name</th><th>Client</th><th>Location</th><th>Status</th><th>Rev</th><th>Items</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.code || "—"}</td>
                <td>{p.name}</td>
                <td>{p.client || "—"}</td>
                <td>{p.location || "—"}</td>
                <td><span className={"badge " + p.status}>{STATUS[p.status] || p.status}</span></td>
                <td>R{p.revision ?? 1}</td>
                <td>{p.ceks_project_items?.[0]?.count ?? 0}</td>
                <td>{new Date(p.created_at).toLocaleDateString()}</td>
                <td className="rowacts"><button className="btn small ghost" onClick={() => onOpen(p.id)}>Open</button></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={9}><div className="empty-state" style={{ margin: 8 }}><div className="empty-icon">🏗️</div><strong>No projects yet</strong><p className="muted">Create your first engineering project above.</p></div></td></tr>}
          </tbody>
        </table>
      </div>
    </PagePanel>
  );
}
