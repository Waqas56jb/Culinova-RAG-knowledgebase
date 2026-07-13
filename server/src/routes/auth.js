const express = require("express");
const { supabase } = require("../config/supabase");
const auth = require("../services/auth");

const router = express.Router();
router.use(express.json({ limit: "256kb" }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[auth]", e.message);
    res.status(status).json({ error: status >= 500 ? "Something went wrong." : e.message });
  });

// A brute-force guard that needs no Redis: a short in-memory window per IP+email. It is not a
// distributed rate limiter — on serverless it resets per instance — so it is a speed bump, not a
// wall. A real deployment should put a rate limiter at the edge; this at least stops a naive script.
const attempts = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, until: 0 };
  if (rec.until > now) {
    const e = new Error(`Too many attempts. Try again in ${Math.ceil((rec.until - now) / 60000)} minute(s).`);
    e.status = 429;
    throw e;
  }
  rec.n++;
  if (rec.n >= MAX_ATTEMPTS) {
    rec.until = now + WINDOW_MS;
    rec.n = 0;
  }
  attempts.set(key, rec);
}
const clearThrottle = (key) => attempts.delete(key);

router.post(
  "/login",
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const key = `${req.ip}|${String(email || "").toLowerCase()}`;
    throttle(key);
    const out = await auth.login(email, password, { userAgent: req.headers["user-agent"], ip: req.ip });
    clearThrottle(key);
    res.json(out);
  })
);

router.post(
  "/refresh",
  wrap(async (req, res) => {
    res.json(await auth.refresh(req.body?.refresh_token));
  })
);

router.post(
  "/logout",
  wrap(async (req, res) => {
    await auth.logout(req.body?.refresh_token);
    res.json({ ok: true });
  })
);

/** Who am I, and what am I allowed to do? The admin UI hides what you cannot do. */
router.get(
  "/me",
  auth.authRequired,
  wrap(async (req, res) => {
    const user = await auth.loadUser(req.user.id);
    if (!user) return res.status(401).json({ error: "Account is disabled" });
    res.json(user);
  })
);

// ── user administration ──────────────────────────────────────────────────────
router.get(
  "/users",
  auth.authRequired,
  auth.requirePermission("user.manage"),
  wrap(async (_req, res) => {
    const { data } = await supabase
      .from("ceks_users")
      .select("id, full_name, email, is_active, last_login_at, created_at, ceks_user_roles(ceks_roles(name))")
      .order("created_at", { ascending: false });
    res.json(
      (data || []).map((u) => ({
        id: u.id,
        full_name: u.full_name,
        email: u.email,
        is_active: u.is_active,
        last_login_at: u.last_login_at,
        roles: (u.ceks_user_roles || []).map((r) => r.ceks_roles?.name).filter(Boolean),
      }))
    );
  })
);

router.post(
  "/users",
  auth.authRequired,
  auth.requirePermission("user.manage"),
  wrap(async (req, res) => {
    res.status(201).json(await auth.createUser(req.body || {}));
  })
);

router.patch(
  "/users/:id",
  auth.authRequired,
  auth.requirePermission("user.manage"),
  wrap(async (req, res) => {
    const { full_name, is_active, roles } = req.body || {};
    const patch = {};
    if (full_name !== undefined) patch.full_name = full_name;
    if (is_active !== undefined) patch.is_active = !!is_active;
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      await supabase.from("ceks_users").update(patch).eq("id", req.params.id);
    }
    if (Array.isArray(roles)) {
      await supabase.from("ceks_user_roles").delete().eq("user_id", req.params.id);
      const { data: roleRows } = await supabase.from("ceks_roles").select("id, name").in("name", roles);
      const links = (roleRows || []).map((r) => ({ user_id: req.params.id, role_id: r.id }));
      if (links.length) await supabase.from("ceks_user_roles").insert(links);
    }
    res.json(await auth.loadUser(req.params.id));
  })
);

// ── roles & permissions (the client asked for approval permissions to be manageable) ─────────
router.get(
  "/roles",
  auth.authRequired,
  auth.requirePermission("user.manage"),
  wrap(async (_req, res) => {
    const [{ data: roles }, { data: perms }, { data: links }] = await Promise.all([
      supabase.from("ceks_roles").select("*").order("name"),
      supabase.from("ceks_permissions").select("*").order("sort_order"),
      supabase.from("ceks_role_permissions").select("*"),
    ]);
    const byRole = {};
    for (const l of links || []) {
      if (!byRole[l.role_id]) byRole[l.role_id] = [];
      byRole[l.role_id].push(l.permission_code);
    }
    res.json({
      roles: (roles || []).map((r) => ({ ...r, permissions: byRole[r.id] || [] })),
      permissions: perms || [],
    });
  })
);

router.put(
  "/roles/:id/permissions",
  auth.authRequired,
  auth.requirePermission("user.manage"),
  wrap(async (req, res) => {
    const codes = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    await supabase.from("ceks_role_permissions").delete().eq("role_id", req.params.id);
    if (codes.length) {
      await supabase
        .from("ceks_role_permissions")
        .insert(codes.map((c) => ({ role_id: req.params.id, permission_code: c })));
    }
    res.json({ ok: true, role_id: req.params.id, permissions: codes });
  })
);

module.exports = router;
