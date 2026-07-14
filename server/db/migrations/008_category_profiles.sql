-- ============================================================================
-- CATEGORY ENGINEERING PROFILES
--
-- The CULINOVA Engineering Standards workbooks (Cooking v1.0, Refrigeration v1.0) are the CATEGORY
-- layer of the standards library: ONE row per equipment category (Gas Range, Reach-In Freezer, …),
-- and each column is a DIRECTIVE describing how that attribute is sourced for the category — not a
-- value and not a numeric condition. The directive vocabulary is taken verbatim from the files:
--
--   'manufacturer'    → value comes from the datasheet (e.g. "Manufacturer", "Manufacturer Dependent")
--   'culinova_rule'   → apply a referenced discipline rule table (e.g. "CULINOVA Electrical Rules")
--                        — those tables are provided SEPARATELY; until then the reference is PENDING
--   'calculation'     → EOS derives it (e.g. "EOS Calculation", "Manufacturer → ASHRAE") — the formula
--                        is provided SEPARATELY; until then it is PENDING
--   'policy'          → an applicability flag (Yes / No / Required / Recommended / Optional / …)
--   'options'         → an allowed-values list the manufacturer selects from ("Solid / Glass")
--   'fixed'           → a concrete CULINOVA value ("1000 mm", "Type I", "Class K / Wet Chemical")
--   'not_applicable'  → "N/A"
--   'note'            → free text (Commissioning Checklist, Engineering Notes)
--
-- This is the DISTINCT, upper layer above ceks_rules (which holds the discipline condition→output
-- tables). Nothing here fabricates a value; unresolved references are stored and flagged, not guessed.
--
-- Additive and idempotent.
-- ============================================================================

create table if not exists ceks_category_profiles (
  id            uuid primary key default gen_random_uuid(),
  domain        text not null,                 -- 'cooking' | 'refrigeration' | future
  code          text not null,                 -- the file's "Rule ID": CAT-001, REF-001
  category_name text not null,                 -- "Gas Range"
  family        text,                          -- "Cooking"
  engineering_group text,                      -- "Dry Cooking"
  classifier    text,                          -- Heat Source (cooking) / Installation Type (refrigeration)
  engineer_approval_required boolean not null default false,
  status        text not null default 'draft', -- the file's Status column ("Approved")
  version       text,                          -- the file's Version column ("v1.0")
  commissioning_checklist text,
  notes         text,                          -- Engineering Notes column
  source_file   text,
  imported_by   uuid references ceks_users(id) on delete set null,
  imported_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_ceks_catprofile on ceks_category_profiles(domain, lower(code));
create index if not exists idx_ceks_catprofile_cat on ceks_category_profiles(lower(category_name));

create table if not exists ceks_category_profile_attributes (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references ceks_category_profiles(id) on delete cascade,
  column_index  int not null,
  column_label  text not null,                 -- "Cold Water", "Hood Type"
  parameter_id  uuid references ceks_parameters(id) on delete set null,  -- resolved via the dictionary when the column maps
  directive     text not null
                check (directive in ('manufacturer','culinova_rule','calculation','policy','options','fixed','not_applicable','note')),
  directive_detail text,                        -- discipline for culinova_rule; policy token; calc chain; the fixed value
  pending       boolean not null default false, -- true when directive references something not yet provided
  raw_value     text not null,                  -- the exact cell content, never altered
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create unique index if not exists uq_ceks_catprofile_attr on ceks_category_profile_attributes(profile_id, column_index);
create index if not exists idx_ceks_catprofile_attr_profile on ceks_category_profile_attributes(profile_id);
create index if not exists idx_ceks_catprofile_attr_directive on ceks_category_profile_attributes(directive);
create index if not exists idx_ceks_catprofile_attr_pending on ceks_category_profile_attributes(pending) where pending;

-- Register the two disciplines these profiles reference but don't yet contain, so the Admin Portal
-- can show them as "awaiting rule tables" rather than silently missing. (Idempotent.)
insert into ceks_disciplines (code, name, sort_order)
select 'gas', 'Gas', 40
where not exists (select 1 from ceks_disciplines where code = 'gas');
