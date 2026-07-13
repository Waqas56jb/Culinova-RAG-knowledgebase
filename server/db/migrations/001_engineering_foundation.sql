-- ============================================================================
-- EOS PHASE 2 · LAYER 0 — FOUNDATION
--   (a) Auth + roles          → nothing can be traceable until we know WHO acted
--   (b) Engine settings       → every policy is DATA, never hardcoded
--   (c) Disciplines           → Electrical, Plumbing, … Fire & Safety, and any future one
--   (d) PARAMETER DICTIONARY  → the canonical vocabulary. A rule cannot match a fact it
--                               cannot name, and today the same fact arrives as
--                               "Power Load" / "Connected Load", "380...415", "3N".
--   (e) Value normalisation   → text values become comparable numbers/ranges/enums
--
-- Additive and idempotent. Drops nothing. Safe to re-run.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) AUTH — the seeded ceks_users / ceks_roles tables were never wired up, so
--     created_by / approved_by are NULL on every record in the system. The client
--     requires "user who approved it" on every recommendation, so identity is a
--     hard prerequisite, not a nice-to-have.
-- ─────────────────────────────────────────────────────────────────────────────
alter table ceks_users
  add column if not exists password_hash text,
  add column if not exists last_login_at  timestamptz,
  add column if not exists updated_at     timestamptz not null default now();

-- The client asked for a dedicated Engineering Standards Manager. Roles stay DATA.
insert into ceks_roles (name, description)
select 'Engineering Standards Manager',
       'Authors, versions and approves CULINOVA Engineering Rules and the Parameter Dictionary'
where not exists (select 1 from ceks_roles where name = 'Engineering Standards Manager');

create index if not exists idx_ceks_users_email on ceks_users(lower(email));

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) ENGINE SETTINGS — every policy decision the client made, stored as data so
--     it can be changed from the Admin Portal without touching code.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_engine_settings (
  key         text primary key,
  value       text not null,
  value_type  text not null default 'text' check (value_type in ('text','number','boolean','json')),
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references ceks_users(id) on delete set null
);

insert into ceks_engine_settings (key, value, value_type, description) values
  ('confidence_threshold', '0.80', 'number',
   'Below this AI-extraction confidence an input is flagged "Verify Input" rather than trusted silently. (Client: 0.80)'),
  ('overwrite_manufacturer_value', 'never', 'text',
   'never = the manufacturer''s extracted value is NEVER overwritten; the CULINOVA recommendation is stored alongside it. (Client decision)'),
  ('require_resolution_before_approval', 'true', 'boolean',
   'An entry cannot be approved while a recommendation is unresolved (engineer must accept, modify or reject with a reason). (Client decision)'),
  ('extrapolation', 'never', 'text',
   'never = when no rule covers a value, EOS leaves the output blank and flags it. It will NOT extrapolate or guess an engineering value. (Client decision)'),
  ('conflict_policy', 'priority_then_engineer', 'text',
   'Highest rule priority wins. Equal-priority rules that disagree raise an engineer conflict — EOS never guesses. (Client decision)'),
  ('auto_apply_on_extract', 'true', 'boolean',
   'Run the rules engine automatically as soon as a datasheet is extracted.'),
  ('rules_require_approval', 'true', 'boolean',
   'A rule must be approved before it becomes active. Rule changes are versioned. (Client decision)')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- (c) DISCIPLINES — rule categories. Adding a new engineering discipline is ONE ROW,
--     never a code change. `attr_groups` links a discipline to the extraction groups
--     the AI already produces, so the mapping is data too.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_disciplines (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  description text,
  attr_groups text[] not null default '{}',   -- extraction groups that feed this discipline
  color       text,                            -- MEP point colour (admin-editable, Phase-2 item 11)
  symbol      text,                            -- MEP point symbol
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into ceks_disciplines (code, name, attr_groups, color, symbol, sort_order) values
  ('electrical',   'Electrical',    '{electrical}',                         '#E53935', 'E',  10),
  ('plumbing',     'Plumbing',      '{water_drain,connection_point}',       '#1E88E5', 'CW', 20),
  ('drainage',     'Drainage',      '{water_drain}',                        '#43A047', 'D',  30),
  ('gas',          'Gas',           '{gas}',                                '#FDD835', 'G',  40),
  ('ventilation',  'Ventilation',   '{ventilation}',                        '#8E24AA', 'V',  50),
  ('installation', 'Installation',  '{installation,connection_point}',      '#6D4C41', 'I',  60),
  ('clearances',   'Clearances',    '{dimensions_clearance}',               '#00897B', 'C',  70),
  ('fire_safety',  'Fire & Safety', '{other,technical_specification}',      '#F4511E', 'FS', 80)
on conflict (code) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- (d) PARAMETER DICTIONARY — THE canonical vocabulary of the whole platform.
--
--     Today the only vocabulary is a JS array hardcoded (and duplicated) in two
--     frontend files, matched by fuzzy prefix. That cannot back a rule engine.
--
--     `role` says whether a parameter is something a rule MATCHES ON (input),
--     something a rule PRODUCES (output), or both.
--     `data_type` is what makes "Current between 16 and 20 A" evaluable at all.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_parameters (
  id             uuid primary key default gen_random_uuid(),
  key            text unique not null,                  -- e.g. electrical.current
  label          text not null,                         -- e.g. Current
  discipline_id  uuid references ceks_disciplines(id) on delete set null,
  data_type      text not null default 'text'
                 check (data_type in ('number','text','enum','boolean')),
  canonical_unit text,                                  -- the unit every value is converted TO
  allowed_values jsonb,                                 -- for enum, e.g. ["1-Phase","3-Phase"]
  role           text not null default 'input'
                 check (role in ('input','output','both')),
  description    text,
  sort_order     int not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_ceks_param_discipline on ceks_parameters(discipline_id);

-- ALIASES — how a real-world attribute name maps onto a canonical parameter.
-- This is what turns "Power Load", "Connected Load", "Rated Power", "Total Load"
-- into one parameter a rule can reference. Fully admin-editable.
create table if not exists ceks_parameter_aliases (
  id           uuid primary key default gen_random_uuid(),
  parameter_id uuid not null references ceks_parameters(id) on delete cascade,
  alias        text not null,
  match_type   text not null default 'exact' check (match_type in ('exact','contains','regex')),
  created_at   timestamptz not null default now()
);
create unique index if not exists uq_ceks_alias on ceks_parameter_aliases(lower(alias), match_type);
create index if not exists idx_ceks_alias_param on ceks_parameter_aliases(parameter_id);

-- UNIT CONVERSIONS — data, not code. value_canonical = value * factor + offset
create table if not exists ceks_unit_conversions (
  id         uuid primary key default gen_random_uuid(),
  from_unit  text not null,
  to_unit    text not null,
  factor     numeric not null default 1,
  "offset"   numeric not null default 0,
  note       text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_ceks_unit_conv on ceks_unit_conversions(lower(from_unit), lower(to_unit));

-- VALUE NORMALISATION — how a raw string becomes a canonical enum value.
-- Real data holds Phase = "3N", "3PH+N+PE", "3~", "3 Phase". A rule matches ONE of them.
create table if not exists ceks_value_normalizations (
  id              uuid primary key default gen_random_uuid(),
  parameter_id    uuid not null references ceks_parameters(id) on delete cascade,
  raw_pattern     text not null,
  match_type      text not null default 'exact' check (match_type in ('exact','contains','regex')),
  canonical_value text not null,
  created_at      timestamptz not null default now()
);
create index if not exists idx_ceks_valnorm_param on ceks_value_normalizations(parameter_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- (e) NORMALISED VALUES on the extracted attributes.
--     The raw value/unit the AI read are NEVER touched — the manufacturer's data is
--     sacred. These columns sit BESIDE them and hold the comparable form.
-- ─────────────────────────────────────────────────────────────────────────────
alter table ceks_knowledge_attributes
  add column if not exists parameter_id     uuid references ceks_parameters(id) on delete set null,
  add column if not exists value_num        numeric,      -- a single number
  add column if not exists value_min        numeric,      -- "380-415" → min
  add column if not exists value_max        numeric,      -- "380-415" → max
  add column if not exists value_canonical  text,         -- "3N" → "3-Phase"
  add column if not exists unit_canonical   text,
  add column if not exists normalized_at    timestamptz,
  add column if not exists normalize_note   text;         -- why it could NOT be normalised, if so

create index if not exists idx_ceks_attr_param on ceks_knowledge_attributes(parameter_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT — the table exists but nothing has ever written to it. Give it what it
-- needs so every rule/recommendation action leaves a trace.
-- ─────────────────────────────────────────────────────────────────────────────
alter table ceks_audit_log
  add column if not exists actor_name text,
  add column if not exists reason     text;
create index if not exists idx_ceks_audit_entity on ceks_audit_log(entity_type, entity_id);
