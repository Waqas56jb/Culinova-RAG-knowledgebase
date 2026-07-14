import React, { useState } from "react";
import { api } from "../api.js";
import { Btn } from "../components/Loader.jsx";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api.login(email.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 24 }}>
          <span className="brand-mark" aria-hidden />
          <div>
            <span className="brand-main">CULINOVA EOS</span>
            <span className="brand-sub">Engineering admin</span>
          </div>
        </div>
        <label className="ilabel">Email</label>
        <input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@culinova.com" />
        <label className="ilabel" style={{ marginTop: 10 }}>Password</label>
        <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" />
        {error && <div className="alert" style={{ marginTop: 12 }}>{error}</div>}
        <Btn type="submit" className="primary" loading={busy} style={{ marginTop: 16, width: "100%" }}>
          Sign in
        </Btn>
        <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
          No account yet? An administrator creates accounts in Users &amp; Roles.
          First-time setup: <code>node cli/seed-admin.js</code> on the server.
        </p>
      </form>
    </div>
  );
}
