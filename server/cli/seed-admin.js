/**
 * Create (or reset) the EOS Super Admin account. Safe to re-run.
 *
 *   node cli/seed-admin.js
 *   node cli/seed-admin.js admin@gmail.com "admin@123!"
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { supabase } = require("../src/config/supabase");
const auth = require("../src/services/auth");

const EMAIL = process.argv[2] || "admin@gmail.com";
const PASSWORD = process.argv[3] || "admin@123!";
const FULL_NAME = "EOS Super Admin";
const ROLES = ["Super Admin"];

(async () => {
  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is missing in server/.env — login will not work without it.");
    process.exit(1);
  }
  if (String(PASSWORD).length < 10) {
    console.error("Password must be at least 10 characters.");
    process.exit(1);
  }

  const email = String(EMAIL).trim().toLowerCase();
  const { data: existing } = await supabase.from("ceks_users").select("id, email").ilike("email", email).maybeSingle();

  let userId;
  if (existing) {
    const hash = await bcrypt.hash(String(PASSWORD), 12);
    const { error } = await supabase
      .from("ceks_users")
      .update({ password_hash: hash, full_name: FULL_NAME, is_active: true, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    userId = existing.id;
    console.log(`✓ Updated existing user: ${email}`);
  } else {
    const user = await auth.createUser({ full_name: FULL_NAME, email, password: PASSWORD, roles: ROLES });
    userId = user.id;
    console.log(`✓ Created user: ${email}`);
  }

  // ensure Super Admin role is linked (createUser skips if user already existed)
  const { data: roleRows } = await supabase.from("ceks_roles").select("id, name").in("name", ROLES);
  await supabase.from("ceks_user_roles").delete().eq("user_id", userId);
  const links = (roleRows || []).map((r) => ({ user_id: userId, role_id: r.id }));
  if (links.length) await supabase.from("ceks_user_roles").insert(links);

  const profile = await auth.loadUser(userId);
  console.log(`  Roles: ${(profile.roles || []).join(", ") || "(none)"}`);
  console.log(`  Permissions: ${(profile.permissions || []).length} capabilities`);

  const session = await auth.login(email, PASSWORD, { userAgent: "cli/seed-admin", ip: "127.0.0.1" });
  console.log(`✓ Login verified — access token issued (${session.expires_in})`);
  console.log(`\n  Sign in at EOS Admin with:\n    Email:    ${email}\n    Password: ${PASSWORD}\n`);
})().catch((e) => {
  console.error("\n✖ seed-admin failed:", e.message);
  process.exit(1);
});
