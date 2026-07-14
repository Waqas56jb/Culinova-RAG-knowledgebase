import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Btn, PageLoader } from "../components/Loader.jsx";
import { PageHero, PagePanel, SectionCard, StatPill } from "../components/PageShell.jsx";

export default function Users() {
  const [users, setUsers] = useState(null);
  const [rolesData, setRolesData] = useState(null);
  const [form, setForm] = useState({ full_name: "", email: "", password: "", roles: [] });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = () => Promise.all([api.users(), api.roles()])
    .then(([u, r]) => { setUsers(u); setRolesData(r); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error && !users) return <PagePanel accent="rose"><div className="alert">{error}</div></PagePanel>;
  if (!users || !rolesData) return <PagePanel accent="rose"><PageLoader label="Loading users…" /></PagePanel>;

  async function createUser() {
    setError(""); setMessage("");
    try {
      await api.createUser(form);
      setForm({ full_name: "", email: "", password: "", roles: [] });
      setMessage("User created.");
      load();
    } catch (e) { setError(e.message); }
  }

  async function setRoles(user, roles) {
    try { await api.updateUser(user.id, { roles }); load(); }
    catch (e) { setError(e.message); }
  }

  async function togglePermission(role, code) {
    const has = role.permissions.includes(code);
    const next = has ? role.permissions.filter((p) => p !== code) : [...role.permissions, code];
    try { await api.setRolePermissions(role.id, next); load(); }
    catch (e) { setError(e.message); }
  }

  const roleNames = rolesData.roles.map((r) => r.name);

  return (
    <PagePanel accent="rose">
      <PageHero
        accent="rose"
        title="Users & Roles"
        subtitle="Manage team access, roles and permissions."
        badge={<StatPill>{users.length} user{users.length === 1 ? "" : "s"}</StatPill>}
      />
      {error && <div className="alert">{error}</div>}
      {message && <div className="notice">{message}</div>}

      <SectionCard title="Create user" icon="👤">
        <div className="add-row">
          <input placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <input placeholder="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input placeholder="password (min 10 chars)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select multiple value={form.roles} size={1} style={{ minWidth: 170, height: 34 }}
            onChange={(e) => setForm({ ...form, roles: [...e.target.selectedOptions].map((o) => o.value) })}>
            {roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <Btn className="small primary" disabled={!form.email || !form.password} onClick={createUser}>Create</Btn>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>Hold Ctrl to select several roles.</p>
      </SectionCard>

      <SectionCard title={`Users (${users.length})`} icon="👥">
        <div className="scroll-x">
          <table className="grid">
            <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Last login</th><th>Active</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.is_active ? "" : "muted"}>
                  <td>{u.full_name || "—"}</td>
                  <td>{u.email}</td>
                  <td>
                    <select multiple value={u.roles} size={1} style={{ minWidth: 170, height: 30 }}
                      onChange={(e) => setRoles(u, [...e.target.selectedOptions].map((o) => o.value))}>
                      {roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "never"}</td>
                  <td>
                    <button className={"tick " + (u.is_active ? "on" : "")}
                      onClick={() => api.updateUser(u.id, { is_active: !u.is_active }).then(load).catch((e) => setError(e.message))}>✓</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Role permissions" icon="🔐">
        <p className="hint">A column per role; tick what each role may do. Changes apply on the user's next request.</p>
        <div className="scroll-x">
          <table className="grid perm-matrix">
            <thead>
              <tr>
                <th>Permission</th>
                {rolesData.roles.map((r) => <th key={r.id}>{r.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rolesData.permissions.map((p) => (
                <tr key={p.code}>
                  <td title={p.description}><span className="mono">{p.code}</span><br /><span className="muted" style={{ fontSize: 11 }}>{p.description}</span></td>
                  {rolesData.roles.map((r) => (
                    <td key={r.id} style={{ textAlign: "center" }}>
                      <button className={"tick " + (r.permissions.includes(p.code) ? "on" : "")}
                        onClick={() => togglePermission(r, p.code)}>✓</button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </PagePanel>
  );
}
