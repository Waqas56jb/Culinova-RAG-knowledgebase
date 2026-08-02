-- ============================================================================
-- 024 · FILTER FACETS drop the "Unspecified" Family/Category option
--
-- The Library filter dropdowns are built by ceks_entry_facets. Family and Category are mandatory, so
-- they must NOT offer an "Unspecified" choice — that value only belongs to the review queue, which is
-- reached via the "Under review" status filter instead. This redefines the function so:
--   • family / category facets list only real, non-null values (no "Unspecified")
--   • brand / equipment_type / power_type facets are computed over VALID products only (family AND
--     category set), so review-queue-only values never leak into the dropdowns
-- Signature is unchanged. Idempotent.
-- ============================================================================

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
      select coalesce(json_agg(fm order by fm), '[]'::json)
      from (select distinct family fm from ceks_knowledge_entries where family is not null) t
    ),
    'category', (
      select coalesce(json_agg(c order by c), '[]'::json)
      from (
        select distinct category c from ceks_knowledge_entries
        where category is not null
          and (p_family is null or family = p_family)
      ) t
    ),
    'brand', (
      select coalesce(json_agg(b order by (b = 'Unspecified'), b), '[]'::json)
      from (
        select distinct coalesce(brand, 'Unspecified') b from ceks_knowledge_entries
        where family is not null and category is not null
          and (p_family is null or family = p_family)
          and (p_category is null or category = p_category)
      ) t
    ),
    'equipment_type', (
      select coalesce(json_agg(et order by (et = 'Unspecified'), et), '[]'::json)
      from (
        select distinct coalesce(equipment_type, 'Unspecified') et from ceks_knowledge_entries
        where family is not null and category is not null
          and (p_family is null or family = p_family)
          and (p_category is null or category = p_category)
          and (p_brand is null or coalesce(brand, 'Unspecified') = p_brand)
      ) t
    ),
    'power_type', (
      select coalesce(json_agg(pt order by (pt = 'Unspecified'), pt), '[]'::json)
      from (
        select distinct coalesce(power_type, 'Unspecified') pt from ceks_knowledge_entries
        where family is not null and category is not null
          and (p_family is null or family = p_family)
          and (p_category is null or category = p_category)
          and (p_brand is null or coalesce(brand, 'Unspecified') = p_brand)
          and (p_type is null or coalesce(equipment_type, 'Unspecified') = p_type)
      ) t
    )
  );
$$;
