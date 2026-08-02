-- ============================================================================
-- 027 · Client-approved taxonomy extension
--
--  • New Family "Plumbing Equipment" with categories: Sink Tap, Pre-Rinse Unit, Hose Reel
--  • "Insect Control System" (Insect Killer) -> Waste Management
--  • "Hand Sanitizer" -> Food Preparation (its own category)
--
-- Each new category belongs to exactly ONE family (one-family-per-category preserved). The insert is
-- guarded so an existing category is never duplicated. Takes the taxonomy to 13 families / 192 categories.
-- ============================================================================

insert into ceks_equipment_taxonomy (family, category, sort_order)
select v.family, v.category,
       coalesce((select max(sort_order) from ceks_equipment_taxonomy t2 where t2.family = v.family), 0) + v.rn
from (values
  ('Plumbing Equipment', 'Sink Tap',              1),
  ('Plumbing Equipment', 'Pre-Rinse Unit',        2),
  ('Plumbing Equipment', 'Hose Reel',             3),
  ('Waste Management',    'Insect Control System', 1),
  ('Food Preparation',    'Hand Sanitizer',        1)
) as v(family, category, rn)
where not exists (select 1 from ceks_equipment_taxonomy t where lower(t.category) = lower(v.category));

-- synonyms so common wordings resolve to the new categories
insert into ceks_category_aliases (alias, category)
select v.alias, v.category
from (values
  ('Insect Killer',       'Insect Control System'),
  ('Fly Killer',          'Insect Control System'),
  ('Insect Control Unit', 'Insect Control System'),
  ('Hand Sanitiser',      'Hand Sanitizer'),
  ('Hand Sanitizer Dispenser', 'Hand Sanitizer'),
  ('Pre Rinse Unit',      'Pre-Rinse Unit'),
  ('Pre-Rinse Spray Unit','Pre-Rinse Unit')
) as v(alias, category)
join ceks_equipment_taxonomy t on lower(t.category) = lower(v.category)
on conflict (lower(alias)) do nothing;
