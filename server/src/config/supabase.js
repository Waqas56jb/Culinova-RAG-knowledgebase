const { createClient } = require("@supabase/supabase-js");
const { env } = require("./env");

// Service-role client (server-side only). Never expose this key to the browser.
const supabase = createClient(env.supabaseUrl || "http://placeholder", env.supabaseKey || "placeholder", {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = { supabase };
