/**
 * READ-ONLY database inspection — counts rows in every ceks_* table and lists
 * applied migrations. Writes NOTHING. Safe to run any time.
 *
 *   node cli/inspect-db.js
 */
require("dotenv").config();
const { Client } = require("pg");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL missing in server/.env");
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(" CULINOVA EOS — READ-ONLY DATABASE INSPECTION");
  console.log(" (ceks_* tables only — ERP tables are NOT touched)");
  console.log("═══════════════════════════════════════════════════════════\n");

  const { rows: tables } = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name like 'ceks_%'
    order by table_name
  `);

  console.log(`Found ${tables.length} ceks_* tables:\n`);
  console.log("  Rows     Table");
  console.log("  ──────── ─────────────────────────────────────");

  let totalRows = 0;
  for (const { table_name } of tables) {
    try {
      const r = await client.query(`select count(*)::int as n from "${table_name}"`);
      const n = r.rows[0].n;
      totalRows += n;
      const flag = n > 0 ? "" : " (empty)";
      console.log(`  ${String(n).padStart(8)}  ${table_name}${flag}`);
    } catch (e) {
      console.log(`     ERROR  ${table_name}  (${e.message})`);
    }
  }

  console.log(`\n  Total rows across ceks_* tables: ${totalRows}`);

  // applied migrations
  try {
    const { rows: migs } = await client.query("select name, applied_at from ceks_migrations order by name");
    console.log(`\nApplied migrations (${migs.length}):`);
    for (const m of migs) console.log(`  ✓ ${m.name}  (${new Date(m.applied_at).toISOString().slice(0, 10)})`);
  } catch {
    console.log("\n(ceks_migrations table not found — migrations may not have run yet)");
  }

  // ERP tables in same DB (read-only count, just for awareness)
  const { rows: erpTables } = await client.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name not like 'ceks_%'
      and table_name not like 'pg_%'
      and table_name not in ('schema_migrations')
    order by table_name
  `);

  console.log(`\n───────────────────────────────────────────────────────────`);
  console.log(`Other tables in same database (ERP etc.): ${erpTables.length}`);
  console.log(`(showing tables with data only — read-only)\n`);

  let erpWithData = 0;
  for (const { table_name } of erpTables) {
    try {
      const r = await client.query(`select count(*)::int as n from "${table_name}"`);
      const n = r.rows[0].n;
      if (n > 0) {
        erpWithData++;
        console.log(`  ${String(n).padStart(8)}  ${table_name}`);
      }
    } catch { /* skip views/functions */ }
  }
  console.log(`\n  ${erpWithData} non-ceks tables have data.`);

  await client.end();
  console.log("\n✔ Inspection complete — nothing was written.\n");
})().catch((e) => {
  console.error("\n✖ Inspection failed:", e.message);
  process.exit(1);
});
