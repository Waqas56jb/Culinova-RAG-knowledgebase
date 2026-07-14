-- ============================================================================
-- DEPENDENT FILTER FACETS — expose "Unspecified" consistently
--
-- ceks_entry_stats() labels NULL values "Unspecified" on the dashboard, and admin.js already treats
-- an "Unspecified" filter as IS NULL. But the FILTER DROPDOWNS (this function) excluded NULLs, so a
-- user could see an "Unspecified" bucket on the dashboard yet not select it inside the Library. This
-- closes that gap: each facet now offers "Unspecified" WHEN (and only when) that column actually has
-- NULLs under the current upstream selection, sorted last. A parent filter of "Unspecified" is
-- matched as IS NULL, exactly like admin.js. Fully consistent, end to end.
--
-- Replaces the function body only. Additive and idempotent.
-- ============================================================================

create or replace function ceks_entry_facets(
  p_category text default null,
  p_brand    text default null,
  p_type     text default null
)
returns json
language sql
stable
as $$
  select json_build_object(
    'category', (
      select coalesce(json_agg(c order by (c = 'Unspecified'), c), '[]'::json)
      from (select distinct coalesce(category, 'Unspecified') c from ceks_knowledge_entries) t
    ),
    'brand', (
      select coalesce(json_agg(b order by (b = 'Unspecified'), b), '[]'::json)
      from (
        select distinct coalesce(brand, 'Unspecified') b from ceks_knowledge_entries
        where (p_category is null or (p_category = 'Unspecified' and category is null) or category = p_category)
      ) t
    ),
    'equipment_type', (
      select coalesce(json_agg(et order by (et = 'Unspecified'), et), '[]'::json)
      from (
        select distinct coalesce(equipment_type, 'Unspecified') et from ceks_knowledge_entries
        where (p_category is null or (p_category = 'Unspecified' and category is null) or category = p_category)
          and (p_brand is null or (p_brand = 'Unspecified' and brand is null) or brand = p_brand)
      ) t
    ),
    'power_type', (
      select coalesce(json_agg(pt order by (pt = 'Unspecified'), pt), '[]'::json)
      from (
        select distinct coalesce(power_type, 'Unspecified') pt from ceks_knowledge_entries
        where (p_category is null or (p_category = 'Unspecified' and category is null) or category = p_category)
          and (p_brand is null or (p_brand = 'Unspecified' and brand is null) or brand = p_brand)
          and (p_type is null or (p_type = 'Unspecified' and equipment_type is null) or equipment_type = p_type)
      ) t
    )
  );
$$;
