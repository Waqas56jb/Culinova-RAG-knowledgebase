-- ============================================================================
-- 022 · FAMILY & CATEGORY ARE MANDATORY  (client rule)
--
-- "No product should ever exist as a valid item without a Family and a Category.
--  If EOS cannot determine them, flag for review — never show an empty valid product.
--  Use the brand to help classify (NOVA COOL is refrigeration; Metro/Cambro are racks)."
--
-- This migration adds the DATA the write-path + backfill use to satisfy that rule:
--   1. Moves the "Rack" category into Serving & Distribution (0 items use it today, so this is a
--      clean move that honours the client's Metro/Cambro instruction AND keeps one-family-per-category).
--   2. Adds a client-extensible BRAND -> Family/Category rule table, so a brand can pin the Family
--      (and optionally the Category) when a datasheet's own wording is too generic to classify.
--   3. Adds a few confident category synonyms observed in the live data.
--
-- Every seed is guarded by a JOIN onto the approved taxonomy, so a rule/synonym can NEVER introduce
-- a family or category outside the approved list.
-- ============================================================================

-- 1) Rack -> Serving & Distribution (was Stainless Steel Fabrication; 0 items affected)
update ceks_equipment_taxonomy set family = 'Serving & Distribution' where category = 'Rack';

-- 2) brand classification rules
create table if not exists ceks_brand_class_rules (
  id         uuid primary key default gen_random_uuid(),
  brand      text not null,
  family     text not null,          -- must be an approved family
  category   text,                   -- optional; if set, must be an approved category in that family
  note       text,
  created_at timestamptz default now()
);
create unique index if not exists ceks_brand_class_rules_brand_key on ceks_brand_class_rules (lower(brand));

insert into ceks_brand_class_rules (brand, family, category)
select v.brand, v.family, v.category
from (values
  ('Metro',     'Serving & Distribution', 'Rack'),
  ('Metroseal', 'Serving & Distribution', 'Rack'),
  ('Cambro',    'Serving & Distribution', 'Rack'),
  ('NOVA COOL', 'Refrigeration',          null),
  ('FAGOR',     'Cooking',                null)
) as v(brand, family, category)
where exists (select 1 from ceks_equipment_taxonomy t where t.family = v.family)                    -- family must exist
  and (v.category is null
       or exists (select 1 from ceks_equipment_taxonomy t where t.family = v.family and t.category = v.category)) -- category must be approved in that family
on conflict (lower(brand)) do nothing;

-- 3) confident category synonyms seen in the live data (guarded to approved categories only)
insert into ceks_category_aliases (alias, category)
select v.alias, v.category
from (values
  ('Refrigerated Cabinet',       'Reach-In Refrigerator'),
  ('Refrigerator',               'Reach-In Refrigerator'),
  ('Reach In Cabinet',           'Reach-In Refrigerator'),
  ('Freezer',                    'Reach-In Freezer'),
  ('Electric Deep Fat Fryer',    'Fryer'),
  ('Gas Cooker with Oven',       'Gas Range'),
  ('Gas Cooker with Open Burners','Gas Range'),
  ('Tilting Bratt Pan',          'Bratt Pan')
) as v(alias, category)
join ceks_equipment_taxonomy t on lower(t.category) = lower(v.category)
on conflict (lower(alias)) do nothing;
