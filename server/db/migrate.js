/**
 * Migration runner.
 *
 * ⚠ SAFETY — WHY THIS FILE CHANGED.
 * db/schema.sql begins with `drop table … cascade` on every ceks_ table. It is a BOOTSTRAP file for an
 * EMPTY database, not a migration. Running it against the live knowledge base WIPES IT — and it also
 * rebuilds an OLDER schema than the app needs (the live DB carries columns schema.sql never declared).
 * `npm run migrate` used to do exactly that, unconditionally, with no guard.
 *
 * So this runner now:
 *   • applies the ADDITIVE migrations in db/migrations/*.sql, in filename order — each is recorded in
 *     ceks_migrations, runs inside a transaction, and is applied exactly once
 *   • REFUSES to run the destructive schema.sql against a database that holds data, unless you pass
 *     --bootstrap --i-understand-this-deletes-everything
 *
 * Usage:
 *   npm run migrate      → apply additive migrations (safe; the normal case)
 *   node db/migrate.js --bootstrap --i-understand-this-deletes-everything   → recreate from scratch
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { Client } = require("pg");

const argv = process.argv.slice(2);
const BOOTSTRAP = argv.includes("--bootstrap");
const CONFIRMED = argv.includes("--i-understand-this-deletes-everything");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is missing in .env");
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

  // Only ONE migrator may run at a time. Under concurrent deploys the others block here, then find
  // every migration already applied and do nothing — instead of racing to run the same SQL twice.
  const MIGRATE_LOCK_KEY = 778201;

  try {
    console.log("Connecting to database…");
    await client.connect();
    await client.query("select pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);

    // how much real data is in here?
    let entries = 0;
    try {
      const r = await client.query("select count(*)::int n from ceks_knowledge_entries");
      entries = r.rows[0].n;
    } catch {
      entries = -1; // table does not exist → brand-new database
    }

    if (BOOTSTRAP) {
      if (entries > 0 && !CONFIRMED) {
        console.error(
          `\n✖ REFUSED. --bootstrap runs db/schema.sql, which DROPS every ceks_ table.\n` +
            `  This database holds ${entries} knowledge entries. They would be destroyed.\n` +
            `  If you truly mean it:\n` +
            `    node db/migrate.js --bootstrap --i-understand-this-deletes-everything\n`
        );
        process.exit(1);
      }
      console.log("Applying db/schema.sql (bootstrap — DROPS and recreates every ceks_ table)…");
      await client.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
      console.log("✔ Bootstrap schema applied.");
    } else if (entries === -1) {
      console.log("No ceks_ tables found — empty database. Bootstrapping from db/schema.sql…");
      await client.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
      console.log("✔ Bootstrap schema applied.");
    } else {
      console.log(`Database holds ${entries} knowledge entries — schema.sql is destructive and will NOT be run.`);
    }

    // ── additive migrations: safe, idempotent, applied once, in order ──────
    const dir = path.join(__dirname, "migrations");
    if (fs.existsSync(dir)) {
      await client.query(`
        create table if not exists ceks_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        );
      `);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      const { rows: done } = await client.query("select name from ceks_migrations");
      const applied = new Set(done.map((r) => r.name));

      let ran = 0;
      for (const f of files) {
        if (applied.has(f)) {
          console.log(`  · ${f} (already applied)`);
          continue;
        }
        console.log(`  → applying ${f}…`);
        const sql = fs.readFileSync(path.join(dir, f), "utf8");
        await client.query("begin");
        try {
          await client.query(sql);
          await client.query("insert into ceks_migrations(name) values ($1)", [f]);
          await client.query("commit");
          console.log(`    ✔ ${f}`);
          ran++;
        } catch (e) {
          await client.query("rollback");
          throw new Error(`${f} failed — rolled back, nothing was changed: ${e.message}`);
        }
      }
      console.log(ran ? `\n✔ ${ran} migration(s) applied.` : "\n✔ Nothing to apply — already up to date.");
    }

    const r = await client.query(
      "select table_name from information_schema.tables where table_schema='public' and table_name like 'ceks_%' order by table_name"
    );
    console.log(`\n${r.rows.length} ceks_ tables in public.\n`);
    try { await client.query("select pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]); } catch {}
    await client.end();
    process.exit(0);
  } catch (e) {
    console.error("\n✖ MIGRATION FAILED:", e.message);
    // the advisory lock is session-scoped — disconnecting releases it, so a failure never wedges it
    try { await client.end(); } catch {}
    process.exit(1);
  }
})();
