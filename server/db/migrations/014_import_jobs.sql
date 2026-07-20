-- ============================================================================
-- IMPORT JOBS — batched, resumable, timeout-proof bulk import
--
-- A 144-row catalogue took ~10 minutes when every row was inserted one at a time. That is fatal on
-- serverless (Vercel kills a function long before then), so a UI upload of a real file could never
-- succeed. The fix is two-part:
--   1. the rows are parsed ONCE and parked here, so the upload request returns immediately
--   2. the client then asks the server to process one BATCH at a time — each call is small, finishes
--      well inside any function limit, and reports progress, so the UI can show a live bar and ETA
--
-- Because the state lives in the database (not in process memory), a batch can run on any instance,
-- an interrupted import can be resumed, and nothing is lost if a request fails.
--
-- Additive and idempotent.
-- ============================================================================

create table if not exists ceks_import_jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null default 'product_catalogue',   -- product_catalogue | eos_template | standards
  source_file  text,
  sheet        text,
  format       text,

  status       text not null default 'pending'
               check (status in ('pending','running','completed','failed','cancelled')),

  total        int  not null default 0,   -- rows to process
  processed    int  not null default 0,   -- rows attempted so far
  imported     int  not null default 0,
  skipped      int  not null default 0,
  failed       int  not null default 0,

  rows         jsonb not null default '[]'::jsonb,   -- the parsed rows, parked for batching
  plan         jsonb,                                -- how each column was interpreted
  entry_ids    jsonb not null default '[]'::jsonb,   -- what was created (drives the preview)
  errors       jsonb not null default '[]'::jsonb,
  summary      jsonb,                                -- not-applicable tallies etc.

  ms_elapsed   int not null default 0,   -- real processing time, so the ETA is measured not guessed
  created_by   uuid references ceks_users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_ceks_import_jobs_status on ceks_import_jobs(status, created_at desc);
create index if not exists idx_ceks_import_jobs_creator on ceks_import_jobs(created_by);

comment on table ceks_import_jobs is
  'One bulk import. Rows are parsed once and processed in batches so a large upload can never time out, shows live progress, and can be resumed.';
