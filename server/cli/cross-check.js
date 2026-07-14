/** READ-ONLY — check if ERP tables exist in the EOS postgres connection */
require("dotenv").config();
const { Client } = require("pg");

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log("\nCross-check via EOS DATABASE_URL:\n");
  for (const t of ["items", "quotations", "sales_orders", "ceks_knowledge_entries", "ceks_projects", "projects"]) {
    try {
      const r = await c.query(`select count(*)::int as n from "${t}"`);
      console.log(`  ${String(r.rows[0].n).padStart(6)}  ${t}`);
    } catch {
      console.log(`  MISSING  ${t}`);
    }
  }
  await c.end();
})();
