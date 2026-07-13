/**
 * AUTHENTICATION & AUTHORIZATION.
 *
 * Until now EOS had NONE: all thirty routes — including DELETE /api/entries/:id and
 * POST /api/admin/bulk-approve — were open to the public internet, and `created_by` / `approved_by`
 * were NULL on every record ever made. The client requires "user who approved it" on every
 * engineering recommendation, so identity is not a feature — it is a precondition.
 *
 * Capabilities are DATA (ceks_permissions + ceks_role_permissions), never `if (role === 'admin')`.
 * The Admin Portal can move a capability between roles without a deploy.
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { supabase } = require("../config/supabase");
const { env } = require("../config/env");

const ACCESS_TTL = env.authAccessTtl || "12h";
const REFRESH_DAYS = env.authRefreshDays || 30;

function secret() {
  if (!env.jwtSecret) {
    // Refusing to run with a default secret is deliberate: a guessable signing key is the same as
    // having no authentication at all, and this system now gates engineering approvals.
    throw new Error(
      "JWT_SECRET is not set. EOS will not issue tokens with a default key — set JWT_SECRET in the environment."
    );
  }
  return env.jwtSecret;
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Everything a request needs to know about the caller, in one shape. */
async function loadUser(userId) {
  const { data: user } = await supabase
    .from("ceks_users")
    .select("id, full_name, email, is_active, department_id")
    .eq("id", userId)
    .maybeSingle();
  if (!user || !user.is_active) return null;

  const { data: links } = await supabase
    .from("ceks_user_roles")
    .select("role_id, ceks_roles(id, name)")
    .eq("user_id", userId);

  const roles = (links || []).map((l) => l.ceks_roles).filter(Boolean);
  const roleIds = roles.map((r) => r.id);

  let permissions = [];
  if (roleIds.length) {
    const { data: perms } = await supabase
      .from("ceks_role_permissions")
      .select("permission_code")
      .in("role_id", roleIds);
    permissions = [...new Set((perms || []).map((p) => p.permission_code))];
  }

  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    roles: roles.map((r) => r.name),
    permissions,
  };
}

async function login(email, password, meta = {}) {
  const { data: row } = await supabase
    .from("ceks_users")
    .select("id, email, password_hash, is_active")
    .ilike("email", String(email || "").trim())
    .maybeSingle();

  // Same message and roughly the same cost whether the user exists or not — otherwise the endpoint
  // becomes a user-enumeration oracle.
  const dummy = "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const okPass = await bcrypt.compare(String(password || ""), row?.password_hash || dummy);

  if (!row || !row.is_active || !row.password_hash || !okPass) {
    const e = new Error("Invalid email or password");
    e.status = 401;
    throw e;
  }

  const user = await loadUser(row.id);
  const access = jwt.sign(
    { sub: user.id, email: user.email, roles: user.roles, perms: user.permissions },
    secret(),
    { expiresIn: ACCESS_TTL }
  );

  // refresh token: random, stored HASHED — a database leak must not hand out live sessions
  const refresh = crypto.randomBytes(48).toString("base64url");
  const expires = new Date(Date.now() + REFRESH_DAYS * 86400000).toISOString();
  await supabase.from("ceks_sessions").insert({
    user_id: user.id,
    token_hash: sha256(refresh),
    user_agent: (meta.userAgent || "").slice(0, 300),
    ip: meta.ip || null,
    expires_at: expires,
  });

  await supabase.from("ceks_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
  return { user, access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL };
}

async function refresh(refreshToken) {
  const { data: session } = await supabase
    .from("ceks_sessions")
    .select("*")
    .eq("token_hash", sha256(String(refreshToken || "")))
    .is("revoked_at", null)
    .maybeSingle();

  if (!session || new Date(session.expires_at) < new Date()) {
    const e = new Error("Session expired — sign in again");
    e.status = 401;
    throw e;
  }
  const user = await loadUser(session.user_id);
  if (!user) {
    const e = new Error("Account is disabled");
    e.status = 401;
    throw e;
  }
  const access = jwt.sign(
    { sub: user.id, email: user.email, roles: user.roles, perms: user.permissions },
    secret(),
    { expiresIn: ACCESS_TTL }
  );
  return { user, access_token: access, expires_in: ACCESS_TTL };
}

async function logout(refreshToken) {
  if (!refreshToken) return;
  await supabase
    .from("ceks_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", sha256(String(refreshToken)));
}

async function createUser({ full_name, email, password, roles = [], department_id = null }) {
  if (!email || !password) throw Object.assign(new Error("Email and password are required"), { status: 422 });
  if (String(password).length < 10) {
    throw Object.assign(new Error("Password must be at least 10 characters"), { status: 422 });
  }
  const { data: exists } = await supabase.from("ceks_users").select("id").ilike("email", email).maybeSingle();
  if (exists) throw Object.assign(new Error("A user with that email already exists"), { status: 409 });

  const hash = await bcrypt.hash(String(password), 12);
  const { data: user, error } = await supabase
    .from("ceks_users")
    .insert({ full_name, email: String(email).trim(), password_hash: hash, department_id, is_active: true })
    .select()
    .single();
  if (error) throw new Error(error.message);

  if (roles.length) {
    const { data: roleRows } = await supabase.from("ceks_roles").select("id, name").in("name", roles);
    const links = (roleRows || []).map((r) => ({ user_id: user.id, role_id: r.id }));
    if (links.length) await supabase.from("ceks_user_roles").insert(links);
  }
  return loadUser(user.id);
}

// ── express middleware ───────────────────────────────────────────────────────

/** Reads the bearer token. Populates req.user. Does NOT reject — use authRequired for that. */
function attachUser(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  try {
    const claims = jwt.verify(token, secret());
    req.user = {
      id: claims.sub,
      email: claims.email,
      roles: claims.roles || [],
      permissions: claims.perms || [],
    };
  } catch {
    /* an invalid or expired token is simply an anonymous request */
  }
  next();
}

function authRequired(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  next();
}

/**
 * Guard a route by CAPABILITY, never by role name. Which roles hold a capability is a database
 * question, answered in the Admin Portal.
 */
function requirePermission(...codes) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
    const have = new Set(req.user.permissions || []);
    const missing = codes.filter((c) => !have.has(c));
    if (missing.length) {
      return res.status(403).json({
        error: `You do not have permission to do this.`,
        required: codes,
        missing,
      });
    }
    next();
  };
}

/**
 * The public knowledge portal stays open BY DESIGN — the ERP and the client's own portal read
 * approved knowledge without a login (the client asked for no separate EOS client login). This
 * marks that intent explicitly, so "no guard here" is a decision and not an oversight.
 */
const publicByDesign = (_req, _res, next) => next();

module.exports = {
  login,
  refresh,
  logout,
  createUser,
  loadUser,
  attachUser,
  authRequired,
  requirePermission,
  publicByDesign,
};
