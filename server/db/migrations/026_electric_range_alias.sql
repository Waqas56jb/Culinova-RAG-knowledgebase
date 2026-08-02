-- ============================================================================
-- 026 · Electric range/cooker synonyms -> Hot Plate
--
-- The approved Cooking list has Gas Range, Induction Range, Solid Top Range, Wok Range, Stock Pot
-- Range — but no generic "Electric Range". Electric hot-plate cookers/ranges are therefore mapped to
-- their closest approved category, "Hot Plate", so they classify under Cooking instead of sitting
-- Unspecified. (If the client wants a dedicated "Electric Range" category we add it and reclassify.)
-- Guarded to approved categories only.
-- ============================================================================

insert into ceks_category_aliases (alias, category)
select v.alias, v.category
from (values
  ('Electric Range',            'Hot Plate'),
  ('Electric Cooker with Oven', 'Hot Plate')
) as v(alias, category)
join ceks_equipment_taxonomy t on lower(t.category) = lower(v.category)
on conflict (lower(alias)) do nothing;
