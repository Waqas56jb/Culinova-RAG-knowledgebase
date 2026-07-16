-- ERP → EOS engineering request inbox
create table if not exists ceks_engineering_requests (
  id uuid primary key default gen_random_uuid(),
  erp_request_id uuid not null,
  erp_number text,
  customer text,
  project_name text,
  project_type text,
  project_location text,
  drawings jsonb default '[]'::jsonb,
  boq_text text,
  sales_notes text,
  required_date date,
  status text not null default 'Pending Engineering Review',
  ceks_project_id uuid,
  approved_items jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists uq_ceks_eng_erp_id on ceks_engineering_requests(erp_request_id);
create index if not exists idx_ceks_eng_status on ceks_engineering_requests(status);
