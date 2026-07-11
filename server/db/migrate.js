/**
 * Applies db/schema.sql to the Postgres database in DATABASE_URL.
 * Usage:  npm run migrate
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { Client } = require("pg");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is missing in .env");
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

  try {
    console.log("Connecting to database…");
    await client.connect();
    console.log("Connected. Applying schema…");
    await client.query(sql);
    const r = await client.query(
      "select table_name from information_schema.tables where table_schema='public' order by table_name"
    );
    console.log(`\n✔ Schema applied. ${r.rows.length} tables in public:\n`);
    console.log("  " + r.rows.map((x) => x.table_name).join(", "));
    await client.end();
    process.exit(0);
  } catch (e) {
    console.error("\n✖ MIGRATION FAILED:", e.message);
    try { await client.end(); } catch {}
    process.exit(1);
  }
})();
