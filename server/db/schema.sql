-- =====================================================================
-- CULINOVA EOS — Engineering Knowledge Module
-- Supabase (PostgreSQL) schema — Phase 1 pilot
-- ALL tables are prefixed  ceks_  so they never collide with the
-- existing ERP tables in the same database.
-- Run in Supabase SQL Editor, or:  npm run migrate
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 0. SAFE CLEANUP of the earlier (unprefixed) pilot run.
--    (a) remove any seed rows we may have inserted into a pre-existing
--        generic ERP table — targeted + exception-safe.
--    (b) drop the CEKS-specific unprefixed tables (an accounting ERP
--        has none of these). Generic names (users/roles/departments/
--        categories/projects/audit_log) are LEFT UNTOUCHED for safety.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select from information_schema.tables where table_schema='public' and table_name='roles') then
    begin delete from public.roles where name in ('Super Admin','Engineer','Reviewer','Department User'); exception when others then null; end;
  end if;
  if exists (select from information_schema.tables where table_schema='public' and table_name='departments') then
    begin delete from public.departments where code in ('DESIGN','SALES','INSTALL','COMMISSION','MAINTAIN'); exception when others then null; end;
  end if;
end $$;

drop table if exists
  knowledge_references, knowledge_standards, knowledge_links, knowledge_status_history,
  knowledge_versions, knowledge_attributes, knowledge_entries, knowledge_types,
  import_documents, engineering_notes, procedure_steps, procedures,
  checklist_items, checklists, file_revisions, file_assets,
  project_references, equipment_types, brands, models, standards, user_roles
cascade;

-- make this migration re-runnable: drop our prefixed tables first
drop table if exists
  ceks_project_references, ceks_projects, ceks_knowledge_standards, ceks_standards,
  ceks_knowledge_references, ceks_knowledge_links, ceks_file_revisions, ceks_file_assets,
  ceks_engineering_notes, ceks_checklist_items, ceks_checklists, ceks_procedure_steps,
  ceks_procedures, ceks_knowledge_attributes, ceks_import_documents,
  ceks_knowledge_status_history, ceks_knowledge_versions, ceks_knowledge_entries,
  ceks_knowledge_types, ceks_models, ceks_brands, ceks_equipment_types, ceks_categories,
  ceks_user_roles, ceks_users, ceks_roles, ceks_departments, ceks_audit_log
cascade;

-- ---------------------------------------------------------------------
-- 1. ACCESS
-- ---------------------------------------------------------------------
create table ceks_departments (
  id uuid primary key default gen_random_uuid(),
  name text not null, code text unique not null, description text,
  created_at timestamptz not null default now()
);

create table ceks_roles (
  id uuid primary key default gen_random_uuid(),
  name text unique not null, description text
);

create table ceks_users (
  id uuid primary key default gen_random_uuid(),
  full_name text not null, email text unique not null,
  department_id uuid references ceks_departments(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table ceks_user_roles (
  user_id uuid not null references ceks_users(id) on delete cascade,
  role_id uuid not null references ceks_roles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

-- ---------------------------------------------------------------------
-- 2. HIERARCHY (equipment context)
-- ---------------------------------------------------------------------
create table ceks_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null, code text unique not null, description text,
  sort_order int not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table ceks_equipment_types (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references ceks_categories(id) on delete restrict,
  name text not null, code text not null, description text,
  sort_order int not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table ceks_brands (
  id uuid primary key default gen_random_uuid(),
  equipment_type_id uuid not null references ceks_equipment_types(id) on delete restrict,
  name text not null, code text not null, country text, website text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table ceks_models (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references ceks_brands(id) on delete restrict,
  model_number text not null, display_name text, series text, description text,
  power_type text,          -- Electric | Gas | Neutral
  image_url text,           -- product image URL (optional)
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_ceks_models_brand on ceks_models(brand_id);

-- ---------------------------------------------------------------------
-- 3. KNOWLEDGE CORE
-- ---------------------------------------------------------------------
create table ceks_knowledge_types (
  id uuid primary key default gen_random_uuid(),
  name text unique not null, data_shape text, description text
);

create table ceks_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  knowledge_type_id uuid references ceks_knowledge_types(id) on delete set null,
  title text not null, code text, summary text,
  current_status text not null default 'draft'
    check (current_status in ('draft','under_review','approved','rejected')),
  origin text not null default 'manual' check (origin in ('ai_pdf','excel','manual')),
  current_version_id uuid,
  created_by uuid references ceks_users(id) on delete set null,
  reviewed_by uuid references ceks_users(id) on delete set null,
  approved_by uuid references ceks_users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_ceks_ke_status on ceks_knowledge_entries(current_status);

create table ceks_knowledge_versions (
  id uuid primary key default gen_random_uuid(),
  knowledge_entry_id uuid not null references ceks_knowledge_entries(id) on delete cascade,
  version_number int not null default 1,
  status text not null default 'draft' check (status in ('draft','under_review','approved','rejected')),
  change_note text,
  created_by uuid references ceks_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_ceks_kv_entry on ceks_knowledge_versions(knowledge_entry_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_ceks_ke_current_version') then
    alter table ceks_knowledge_entries
      add constraint fk_ceks_ke_current_version
      foreign key (current_version_id) references ceks_knowledge_versions(id) on delete set null;
  end if;
end $$;

create table ceks_knowledge_status_history (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references ceks_knowledge_versions(id) on delete cascade,
  from_status text, to_status text not null,
  changed_by uuid references ceks_users(id) on delete set null,
  comment text, changed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. SOURCE DOCUMENTS (traceability)
-- ---------------------------------------------------------------------
create table ceks_import_documents (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  doc_type text not null default 'datasheet'
    check (doc_type in ('datasheet','installation_manual','maintenance_manual','other')),
  storage_url text, page_count int,
  uploaded_by uuid references ceks_users(id) on delete set null,
  status text not null default 'uploaded'
    check (status in ('uploaded','extracting','extracted','failed')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 5. STRUCTURED CONTENT (per-field source traceability)
-- ---------------------------------------------------------------------
create table ceks_knowledge_attributes (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references ceks_knowledge_versions(id) on delete cascade,
  attr_group text not null, name text not null, value text, unit text,
  sort_order int not null default 0,
  origin text not null default 'manual' check (origin in ('ai_extracted','manual','excel')),
  source_document_id uuid references ceks_import_documents(id) on delete set null,
  source_document text, source_page int, confidence numeric(4,3),
  image_url text,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_ceks_attr_version on ceks_knowledge_attributes(version_id);

create table ceks_procedures (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references ceks_knowledge_versions(id) on delete cascade,
  procedure_type text not null check (procedure_type in ('installation','commissioning','maintenance')),
  title text not null, description text, frequency text,
  origin text not null default 'manual', source_document text, source_page int,
  sort_order int not null default 0
);

create table ceks_procedure_steps (
  id uuid primary key default gen_random_uuid(),
  procedure_id uuid not null references ceks_procedures(id) on delete cascade,
  step_number int not null, instruction text not null,
  warning text, expected_result text, source_page int
);

create table ceks_checklists (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references ceks_knowledge_versions(id) on delete cascade,
  procedure_id uuid references ceks_procedures(id) on delete set null,
  title text not null,
  checklist_type text check (checklist_type in ('installation','commissioning','maintenance','general')),
  description text
);

create table ceks_checklist_items (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references ceks_checklists(id) on delete cascade,
  item_number int not null, description text not null,
  is_mandatory boolean not null default false, expected_value text
);

create table ceks_engineering_notes (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references ceks_knowledge_versions(id) on delete cascade,
  note_type text, content text not null,
  source_document text, source_page int,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 6. FILES & MEDIA
-- ---------------------------------------------------------------------
create table ceks_file_assets (
  id uuid primary key default gen_random_uuid(),
  knowledge_entry_id uuid not null references ceks_knowledge_entries(id) on delete cascade,
  asset_type text not null check (asset_type in ('cad','photo','video','document')),
  file_name text not null, storage_url text not null, mime_type text, file_size bigint,
  drawing_number text, current_revision text, category_tag text, description text,
  uploaded_by uuid references ceks_users(id) on delete set null,
  uploaded_at timestamptz not null default now()
);

create table ceks_file_revisions (
  id uuid primary key default gen_random_uuid(),
  file_asset_id uuid not null references ceks_file_assets(id) on delete cascade,
  revision_number text not null, storage_url text not null, change_note text,
  uploaded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 7. LINKS, REFERENCES, STANDARDS, PROJECTS
-- ---------------------------------------------------------------------
create table ceks_knowledge_links (
  id uuid primary key default gen_random_uuid(),
  knowledge_entry_id uuid not null references ceks_knowledge_entries(id) on delete cascade,
  scope_type text not null check (scope_type in ('category','equipment_type','brand','model')),
  scope_id uuid not null, note text
);
create index idx_ceks_klink_entry on ceks_knowledge_links(knowledge_entry_id);
create index idx_ceks_klink_scope on ceks_knowledge_links(scope_type, scope_id);

create table ceks_knowledge_references (
  id uuid primary key default gen_random_uuid(),
  source_entry_id uuid not null references ceks_knowledge_entries(id) on delete cascade,
  target_entry_id uuid not null references ceks_knowledge_entries(id) on delete cascade,
  relation_type text not null default 'related'
    check (relation_type in ('related','depends_on','supersedes','references'))
);

create table ceks_standards (
  id uuid primary key default gen_random_uuid(),
  code text not null, title text, issuing_body text,
  created_at timestamptz not null default now()
);

create table ceks_knowledge_standards (
  id uuid primary key default gen_random_uuid(),
  knowledge_entry_id uuid not null references ceks_knowledge_entries(id) on delete cascade,
  standard_id uuid not null references ceks_standards(id) on delete cascade,
  clause text
);

create table ceks_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null, client text, location text,
  created_at timestamptz not null default now()
);

create table ceks_project_references (
  id uuid primary key default gen_random_uuid(),
  knowledge_entry_id uuid not null references ceks_knowledge_entries(id) on delete cascade,
  project_id uuid not null references ceks_projects(id) on delete cascade,
  usage_context text
);

create table ceks_audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references ceks_users(id) on delete set null,
  entity_type text not null, entity_id uuid, action text not null,
  changes jsonb, created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 8. SEED
-- ---------------------------------------------------------------------
insert into ceks_roles (name, description) values
  ('Super Admin','Full access; can approve records'),
  ('Engineer','Create and edit records; submit for review'),
  ('Reviewer','Review and approve or reject'),
  ('Department User','Read-only access to approved knowledge')
on conflict (name) do nothing;

insert into ceks_departments (name, code) values
  ('Design','DESIGN'),('Sales','SALES'),('Installation','INSTALL'),
  ('Commissioning','COMMISSION'),('Maintenance','MAINTAIN')
on conflict (code) do nothing;

insert into ceks_knowledge_types (name, data_shape, description) values
  ('specification','attribute','Technical specification value'),
  ('utility','attribute','Electrical/water/gas/drainage requirement'),
  ('connection_point','attribute','Inlet/outlet connection detail'),
  ('clearance','attribute','Minimum service clearance'),
  ('procedure','procedure','Installation/commissioning/maintenance procedure'),
  ('checklist','checklist','Verification checklist'),
  ('note','note','Engineering note / lesson learned'),
  ('standard','link','Applicable engineering standard'),
  ('document','file','Datasheet/manual/certificate'),
  ('drawing','file','CAD drawing'),
  ('photo','file','Equipment photo'),
  ('video','file','Reference video')
on conflict (name) do nothing;

-- Done.
