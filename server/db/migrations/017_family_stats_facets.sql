-- ============================================================================
-- 017 · FAMILY in dashboard stats + filter facets
--
-- Now that equipment entries carry a `family` (migration 016), the dashboard and the Library filters
-- must lead with it: Family is the TOP level of the hierarchy Family → Category → Model.
--   • ceks_entry_stats  → adds `byFamily` (shown first on the dashboard).
--   • ceks_entry_facets → gains a `family` facet at the head of the cascade, and every downstream
--     facet (category/brand/type/power) is now also narrowed by the chosen family.
--
-- The facet function's argument list changes (a new leading p_family), so it is dropped and recreated.
-- Additive and idempotent.
-- ============================================================================

create or replace function ceks_entry_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'total', (select count(*) from ceks_knowledge_entries),
    'byStatus',    (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(current_status, 'Unspecified') k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byFamily',    (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(family, 'Unspecified')         k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byCategory',  (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(category, 'Unspecified')       k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byBrand',     (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(brand, 'Unspecified')          k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byPowerType', (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(power_type, 'Unspecified')     k, count(*) n from ceks_knowledge_entries group by 1) s)
  );
$$;

-- the signature changes (new leading p_family), so drop the 3-arg version before recreating
drop function if exists ceks_entry_facets(text, text, text);

create or replace function ceks_entry_facets(
  p_family   text default null,
  p_category text default null,
  p_brand    text default null,
  p_type     text default null
)
returns json
language sql
stable
as $$
  select json_build_object(
    'family', (
      select coalesce(json_agg(fm order by (fm = 'Unspecified'), fm), '[]'::json)
      from (select distinct coalesce(family, 'Unspecified') fm from ceks_knowledge_entries) t
    ),
    'category', (
      select coalesce(json_agg(c order by (c = 'Unspecified'), c), '[]'::json)
      from (
        select distinct coalesce(category, 'Unspecified') c from ceks_knowledge_entries
        where (p_family is null or (p_family = 'Unspecified' and family is null) or family = p_family)
      ) t
    ),
    'brand', (
      select coalesce(json_agg(b order by (b = 'Unspecified'), b), '[]'::json)
      from (
        select distinct coalesce(brand, 'Unspecified') b from ceks_knowledge_entries
        where (p_family is null or (p_family = 'Unspecified' and family is null) or family = p_family)
          and (p_category is null or (p_category = 'Unspecified' and category is null) or category = p_category)
      ) t
    ),
    'equipment_type', (
      select coalesce(json_agg(et order by (et = 'Unspecified'), et), '[]'::json)
      from (
        select distinct coalesce(equipment_type, 'Unspecified') et from ceks_knowledge_entries
        where (p_family is null or (p_family = 'Unspecified' and family is null) or family = p_family)
          and (p_category is null or (p_category = 'Unspecified' and category is null) or category = p_category)
          and (p_brand is null or (p_brand = 'Unspecified' and brand is null) or brand = p_brand)
      ) t
    ),
    'power_type', (
      select coalesce(json_agg(pt order by (pt = 'Unspecified'), pt), '[]'::json)
      from (
        select distinct coalesce(power_type, 'Unspecified') pt from ceks_knowledge_entries
        where (p_family is null or (p_family = 'Unspecified' and family is null) or family = p_family)
          and (p_category is null or (p_category = 'Unspecified' and category is null) or category = p_category)
          and (p_brand is null or (p_brand = 'Unspecified' and brand is null) or brand = p_brand)
          and (p_type is null or (p_type = 'Unspecified' and equipment_type is null) or equipment_type = p_type)
      ) t
    )
  );
$$;
