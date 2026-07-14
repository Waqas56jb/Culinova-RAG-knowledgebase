/**
 * Bootstrap (or reset) the first Super Admin account.
 *
 * The API routes are permission-guarded, but ceks_users is empty on a fresh system — so nobody can
 * sign in to create users. This CLI is the one safe way in. It only INSERTS/UPDATES the single
 * account you name; it touches nothing else.
 *
 *   node cli/create-admin.js admin@culinova.com "StrongPassword123!" "Admin Name"
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { supabase } = require("../src/config/supabase");

(async () => {
  const [email, password, fullName] = process.argv.slice(2);
  if (!email || !password) {
    console.log('Usage: node cli/create-admin.js <email> <password> ["Full Name"]');
    process.exit(1);
  }
  if (String(password).length < 10) {
    console.error("Password must be at least 10 characters.");
    process.exit(1);
  }

  const hash = await bcrypt.hash(String(password), 12);

  const { data: existing } = await supabase.from("ceks_users").select("id").ilike("email", email).maybeSingle();
  let userId;
  if (existing) {
    await supabase
      .from("ceks_users")
      .update({ password_hash: hash, is_active: true, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    userId = existing.id;
    console.log(`✔ Existing user ${email} — password reset, account active.`);
  } else {
    const { data, error } = await supabase
      .from("ceks_users")
      .insert({ full_name: fullName || "Administrator", email: String(email).trim(), password_hash: hash, is_active: true })
      .select()
      .single();
    if (error) { console.error("Could not create user:", error.message); process.exit(1); }
    userId = data.id;
    console.log(`✔ Created user ${email}.`);
  }

  const { data: role } = await supabase.from("ceks_roles").select("id").eq("name", "Super Admin").single();
  if (!role) { console.error('The "Super Admin" role does not exist — run npm run migrate first.'); process.exit(1); }

  await supabase.from("ceks_user_roles").upsert({ user_id: userId, role_id: role.id }, { onConflict: "user_id,role_id" });
  console.log("✔ Super Admin role assigned. You can sign in now.");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
