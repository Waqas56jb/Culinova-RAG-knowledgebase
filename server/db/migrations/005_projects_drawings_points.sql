-- ============================================================================
-- EOS PHASE 2 · LAYERS 2 & 3 — PROJECT ENGINEERING WORKSPACE, SCHEDULES,
-- MEP POINTS, DRAWING WORKSPACE
--
-- Client items 7–15 + 20. Everything configurable (utility colours/symbols,
-- schedule columns) is DATA in these tables — editable from the Admin Portal,
-- never a code change.
--
-- Additive and idempotent. Drops nothing.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PROJECTS (item 7) — ceks_projects already exists (name/client/location).
-- Give it what a real engineering workspace needs.
-- ─────────────────────────────────────────────────────────────────────────────
alter table ceks_projects
  add column if not exists code        text,
  add column if not exists status      text not null default 'draft',
  add column if not exists description text,
  add column if not exists revision    int  not null default 1,
  add column if not exists created_by  uuid references ceks_users(id) on delete set null,
  add column if not exists updated_at  timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_ceks_projects_status') then
    alter table ceks_projects add constraint ck_ceks_projects_status
      check (status in ('draft','under_review','approved','published','archived'));
  end if;
end $$;
create unique index if not exists uq_ceks_project_code on ceks_projects(lower(code)) where code is not null;

-- PROJECT EQUIPMENT SELECTION — approved EOS equipment, quantity, item number,
-- area / kitchen section / room, department/zone grouping, alternatives.
create table if not exists ceks_project_items (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references ceks_projects(id) on delete cascade,
  entry_id      uuid not null references ceks_knowledge_entries(id) on delete restrict,
  item_number   text,                                -- the drawing item number, e.g. K-01
  qty           numeric not null default 1,
  area          text,                                -- e.g. Main Kitchen
  section       text,                                -- kitchen section / department
  room          text,
  zone          text,                                -- grouping by zone
  notes         text,
  sort_order    int not null default 0,
  status        text not null default 'active' check (status in ('active','replaced','removed')),
  replaced_by   uuid references ceks_project_items(id) on delete set null,  -- approved alternative
  created_by    uuid references ceks_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_ceks_pitem_project on ceks_project_items(project_id, status);
create index if not exists idx_ceks_pitem_entry on ceks_project_items(entry_id);

-- PROJECT REVISIONS — a frozen snapshot of the whole selection (item 7: "save
-- multiple equipment revisions").
create table if not exists ceks_project_item_revisions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references ceks_projects(id) on delete cascade,
  revision    int  not null,
  label       text,
  snapshot    jsonb not null,               -- the full item list at that moment
  created_by  uuid references ceks_users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_ceks_pitemrev on ceks_project_item_revisions(project_id, revision);

-- ─────────────────────────────────────────────────────────────────────────────
-- UTILITY POINT TYPES (item 11) — the standard colour & symbol system.
-- Editable from the Admin Portal. A discipline may have several point types
-- (plumbing → CW + HW).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_utility_point_types (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,        -- EP · CW · HW · DR · GAS · EX · FA
  label         text not null,
  discipline_id uuid references ceks_disciplines(id) on delete set null,
  color         text not null,
  symbol        text not null,
  sort_order    int not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

do $$
declare d_elec uuid; d_plumb uuid; d_drain uuid; d_gas uuid; d_vent uuid;
begin
  select id into d_elec  from ceks_disciplines where code='electrical';
  select id into d_plumb from ceks_disciplines where code='plumbing';
  select id into d_drain from ceks_disciplines where code='drainage';
  select id into d_gas   from ceks_disciplines where code='gas';
  select id into d_vent  from ceks_disciplines where code='ventilation';

  insert into ceks_utility_point_types (code, label, discipline_id, color, symbol, sort_order) values
    ('EP',  'Electrical Point', d_elec,  '#E53935', 'EP',  10),
    ('CW',  'Cold Water Point', d_plumb, '#1E88E5', 'CW',  20),
    ('HW',  'Hot Water Point',  d_plumb, '#FB8C00', 'HW',  30),
    ('DR',  'Drain Point',      d_drain, '#43A047', 'DR',  40),
    ('GAS', 'Gas Point',        d_gas,   '#FDD835', 'G',   50),
    ('EX',  'Exhaust Point',    d_vent,  '#8E24AA', 'EX',  60),
    ('FA',  'Fresh Air Point',  d_vent,  '#4FC3F7', 'FA',  70)
  on conflict (code) do nothing;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SCHEDULE TYPES (items 8 & 20) — the 13 schedules, with their COLUMNS stored as
-- data so the Admin Portal can add/remove/re-order columns without a deploy.
-- Each column: { key, label, source } where source is resolved by the schedule
-- service ("item" fields, a parameter key, or an attribute pattern).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_schedule_types (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  description text,
  columns     jsonb not null default '[]',
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into ceks_schedule_types (code, name, columns, sort_order) values
  ('equipment', 'Equipment Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"brand","label":"Brand"},
    {"key":"model","label":"Model"},
    {"key":"qty","label":"Qty"},
    {"key":"area","label":"Area"},
    {"key":"dimensions","label":"Dimensions"},
    {"key":"power_type","label":"Power Type"},
    {"key":"notes","label":"Notes"}]'::jsonb, 10),
  ('electrical_load', 'Electrical Load Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"param:electrical.power","label":"Power (kW)"},
    {"key":"param:electrical.voltage","label":"Voltage (V)"},
    {"key":"param:electrical.phase","label":"Phase"},
    {"key":"param:electrical.current","label":"Current (A)"},
    {"key":"rec:electrical.cable_size","label":"Cable"},
    {"key":"rec:electrical.breaker","label":"Breaker"},
    {"key":"rec:electrical.connection","label":"Connection"},
    {"key":"rec:electrical.socket_type","label":"Socket"},
    {"key":"rec:electrical.isolator","label":"Isolator"},
    {"key":"total_power","label":"Total Load (kW)"}]'::jsonb, 20),
  ('plumbing', 'Plumbing Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"attr:cold water","label":"Cold Water"},
    {"key":"attr:hot water","label":"Hot Water"},
    {"key":"param:plumbing.water_pressure","label":"Pressure (kPa)"},
    {"key":"rec:plumbing.water_connection_size","label":"Connection Size"},
    {"key":"rec:plumbing.connection_height","label":"Height (mm)"},
    {"key":"notes","label":"Notes"}]'::jsonb, 30),
  ('cold_water', 'Cold Water Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"attr:cold water connection","label":"Connection Type"},
    {"key":"attr:cold water diameter","label":"Diameter"},
    {"key":"attr:cold water height","label":"Height"},
    {"key":"param:plumbing.water_pressure","label":"Pressure (kPa)"},
    {"key":"notes","label":"Notes"}]'::jsonb, 40),
  ('hot_water', 'Hot Water Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"attr:hot water connection","label":"Connection Type"},
    {"key":"attr:hot water diameter","label":"Diameter"},
    {"key":"attr:hot water height","label":"Height"},
    {"key":"rec:plumbing.hot_water_required","label":"Hot Water Required"},
    {"key":"notes","label":"Notes"}]'::jsonb, 50),
  ('drainage', 'Drainage Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"param:drainage.drain_size","label":"Drain Size"},
    {"key":"param:drainage.drain_type","label":"Gravity / Pumped"},
    {"key":"rec:drainage.recommended_drain_size","label":"CULINOVA Drain Size"},
    {"key":"rec:drainage.floor_drain_required","label":"Floor Drain"},
    {"key":"notes","label":"Notes"}]'::jsonb, 60),
  ('gas', 'Gas Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"param:gas.gas_type","label":"Gas Type"},
    {"key":"param:gas.gas_power","label":"Gas Power (kW)"},
    {"key":"param:gas.gas_pressure","label":"Pressure (mbar)"},
    {"key":"param:gas.gas_connection_size","label":"Connection Size"},
    {"key":"rec:gas.recommended_pipe_size","label":"CULINOVA Pipe Size"},
    {"key":"rec:gas.isolation_valve","label":"Isolation Valve"},
    {"key":"notes","label":"Notes"}]'::jsonb, 70),
  ('ventilation', 'Ventilation Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"rec:ventilation.exhaust_airflow","label":"Exhaust (m³/h)"},
    {"key":"rec:ventilation.fresh_air","label":"Fresh Air (m³/h)"},
    {"key":"rec:ventilation.hood_required","label":"Hood"},
    {"key":"rec:ventilation.steam_extraction","label":"Steam Extraction"},
    {"key":"param:ventilation.heat_load","label":"Heat Load (kW)"},
    {"key":"notes","label":"Notes"}]'::jsonb, 80),
  ('exhaust', 'Exhaust Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"rec:ventilation.exhaust_airflow","label":"Exhaust Airflow (m³/h)"},
    {"key":"rec:ventilation.steam_extraction","label":"Steam Extraction"},
    {"key":"rec:ventilation.hood_required","label":"Hood Requirement"},
    {"key":"notes","label":"Notes"}]'::jsonb, 90),
  ('fresh_air', 'Fresh-Air Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"rec:ventilation.fresh_air","label":"Fresh Air (m³/h)"},
    {"key":"param:ventilation.heat_load","label":"Heat Load (kW)"},
    {"key":"notes","label":"Notes"}]'::jsonb, 100),
  ('installation', 'Installation Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"qty","label":"Qty"},
    {"key":"area","label":"Area"},
    {"key":"attr:indoor","label":"Indoor / Outdoor"},
    {"key":"attr:floor","label":"Floor Requirements"},
    {"key":"attr:mounting","label":"Mounting"},
    {"key":"rec:installation.notes","label":"CULINOVA Installation Notes"},
    {"key":"notes","label":"Notes"}]'::jsonb, 110),
  ('clearance', 'Clearance Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"dimensions","label":"Dimensions"},
    {"key":"attr:rear clearance","label":"Rear"},
    {"key":"attr:left clearance","label":"Left"},
    {"key":"attr:right clearance","label":"Right"},
    {"key":"attr:top clearance","label":"Top"},
    {"key":"attr:front service","label":"Front Service"},
    {"key":"rec:clearances.service_clearance","label":"CULINOVA Clearance"},
    {"key":"notes","label":"Notes"}]'::jsonb, 120),
  ('combined_mep', 'Combined MEP Schedule', '[
    {"key":"item_number","label":"Item No."},
    {"key":"description","label":"Equipment Description"},
    {"key":"brand","label":"Brand"},
    {"key":"model","label":"Model"},
    {"key":"qty","label":"Qty"},
    {"key":"dimensions","label":"Dimensions"},
    {"key":"param:electrical.power","label":"Power (kW)"},
    {"key":"param:electrical.voltage","label":"Voltage (V)"},
    {"key":"param:electrical.phase","label":"Phase"},
    {"key":"param:electrical.current","label":"Current (A)"},
    {"key":"rec:electrical.cable_size","label":"Cable"},
    {"key":"rec:electrical.breaker","label":"Breaker"},
    {"key":"attr:cold water","label":"Cold Water"},
    {"key":"attr:hot water","label":"Hot Water"},
    {"key":"param:drainage.drain_size","label":"Drain"},
    {"key":"param:gas.gas_connection_size","label":"Gas"},
    {"key":"rec:ventilation.exhaust_airflow","label":"Exhaust (m³/h)"},
    {"key":"rec:ventilation.fresh_air","label":"Fresh Air (m³/h)"},
    {"key":"rec:clearances.service_clearance","label":"Clearances"},
    {"key":"notes","label":"Engineering Notes"}]'::jsonb, 130)
on conflict (code) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- DRAWING WORKSPACE (items 12–15) — uploaded plan + equipment placements +
-- movable coloured MEP points + notes/labels, all with coordinates, revisioned.
-- Coordinates are NORMALISED (0..1 of the sheet) so every export scales.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_drawings (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references ceks_projects(id) on delete cascade,
  name         text not null,
  kind         text not null default 'image' check (kind in ('pdf','image')),
  storage_url  text not null,
  page         int  not null default 1,             -- which PDF page is the plan
  width        numeric,                             -- native pixel/point size, for exports
  height       numeric,
  revision     int  not null default 1,
  legend_note  text,
  created_by   uuid references ceks_users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_ceks_drawings_project on ceks_drawings(project_id);

create table if not exists ceks_drawing_placements (
  id              uuid primary key default gen_random_uuid(),
  drawing_id      uuid not null references ceks_drawings(id) on delete cascade,
  project_item_id uuid not null references ceks_project_items(id) on delete cascade,
  x               numeric not null default 0.5,     -- 0..1 across the sheet
  y               numeric not null default 0.5,
  rotation        numeric not null default 0,       -- degrees
  scale           numeric not null default 1,
  label           text,                             -- defaults to the item number
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_ceks_place_drawing on ceks_drawing_placements(drawing_id);

-- One coloured utility point on the sheet (item 10/11). dx/dy are offsets from
-- its placement so points follow the equipment when it moves, but stay movable.
create table if not exists ceks_drawing_points (
  id             uuid primary key default gen_random_uuid(),
  placement_id   uuid not null references ceks_drawing_placements(id) on delete cascade,
  point_type_id  uuid not null references ceks_utility_point_types(id) on delete restrict,
  point_code     text,                              -- e.g. K-01-EP
  dx             numeric not null default 0,        -- offset from the placement, 0..1 units
  dy             numeric not null default 0,
  value          text,                              -- e.g. 24 kW · DN20 · ø50
  unit           text,
  height         text,                              -- connection height note
  note           text,
  is_visible     boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_ceks_dpoint_placement on ceks_drawing_points(placement_id);

-- Free annotations: engineering notes, labels, dimensions (item 12).
create table if not exists ceks_drawing_annotations (
  id          uuid primary key default gen_random_uuid(),
  drawing_id  uuid not null references ceks_drawings(id) on delete cascade,
  kind        text not null default 'note' check (kind in ('note','label','dimension')),
  text        text not null,
  x           numeric not null default 0.5,
  y           numeric not null default 0.5,
  x2          numeric,                              -- dimensions: the second anchor
  y2          numeric,
  color       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ceks_dann_drawing on ceks_drawing_annotations(drawing_id);

-- Drawing revisions — the full annotated state, frozen (item 12: "save drawing revisions").
create table if not exists ceks_drawing_revisions (
  id          uuid primary key default gen_random_uuid(),
  drawing_id  uuid not null references ceks_drawings(id) on delete cascade,
  revision    int  not null,
  label       text,
  snapshot    jsonb not null,       -- placements + points + annotations at that moment
  created_by  uuid references ceks_users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_ceks_drawrev on ceks_drawing_revisions(drawing_id, revision);

-- ─────────────────────────────────────────────────────────────────────────────
-- PERMISSIONS for the new areas — data, like every other capability.
-- ─────────────────────────────────────────────────────────────────────────────
insert into ceks_permissions (code, name, description, area, sort_order) values
  ('project.read',   'View projects',          'See project equipment selections, schedules and drawings.', 'projects', 400),
  ('project.manage', 'Manage projects',        'Create projects, select equipment, edit drawings, save revisions.', 'projects', 410),
  ('project.export', 'Export schedules',       'Export schedules, reports, AutoCAD tables and annotated drawings.', 'projects', 420)
on conflict (code) do nothing;

do $$
declare r uuid;
begin
  for r in select id from ceks_roles where name in ('Super Admin') loop
    insert into ceks_role_permissions (role_id, permission_code)
    select r, code from ceks_permissions where area = 'projects'
    on conflict do nothing;
  end loop;
  for r in select id from ceks_roles where name in ('Engineer','Reviewer','Engineering Standards Manager') loop
    insert into ceks_role_permissions (role_id, permission_code)
    select r, code from ceks_permissions where code in ('project.read','project.manage','project.export')
    on conflict do nothing;
  end loop;
  for r in select id from ceks_roles where name in ('Department User') loop
    insert into ceks_role_permissions (role_id, permission_code)
    select r, 'project.read' on conflict do nothing;
  end loop;
end $$;
