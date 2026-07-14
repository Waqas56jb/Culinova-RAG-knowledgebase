-- ============================================================================
-- ADMIN DASHBOARD AGGREGATION
--
-- /admin/stats and /admin/filters used to SELECT the whole ceks_knowledge_entries table into Node
-- and count/uniq it in JavaScript. PostgREST silently caps every such select at 1000 rows, so past
-- 1000 entries the dashboard numbers and filter facets were simply WRONG. These functions push the
-- aggregation into Postgres, where a GROUP BY / DISTINCT is exact and cheap, and return one JSON row.
--
-- Additive and idempotent.
-- ============================================================================

-- Dashboard statistics: exact totals and per-column breakdowns, computed in the database.
create or replace function ceks_entry_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'total', (select count(*) from ceks_knowledge_entries),
    'byStatus',    (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(current_status, '—') k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byCategory',  (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(category, '—')       k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byBrand',     (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(brand, '—')          k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byPowerType', (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(power_type, '—')     k, count(*) n from ceks_knowledge_entries group by 1) s)
  );
$$;

-- Dependent (faceted) filters: each facet narrowed by the selections above it, computed with DISTINCT
-- in the database rather than by pulling rows into Node.
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
      select coalesce(json_agg(c order by c), '[]'::json)
      from (select distinct category c from ceks_knowledge_entries where category is not null) t
    ),
    'brand', (
      select coalesce(json_agg(b order by b), '[]'::json)
      from (select distinct brand b from ceks_knowledge_entries
            where brand is not null and (p_category is null or category = p_category)) t
    ),
    'equipment_type', (
      select coalesce(json_agg(et order by et), '[]'::json)
      from (select distinct equipment_type et from ceks_knowledge_entries
            where equipment_type is not null
              and (p_category is null or category = p_category)
              and (p_brand is null or brand = p_brand)) t
    ),
    'power_type', (
      select coalesce(json_agg(pt order by pt), '[]'::json)
      from (select distinct power_type pt from ceks_knowledge_entries
            where power_type is not null
              and (p_category is null or category = p_category)
              and (p_brand is null or brand = p_brand)
              and (p_type is null or equipment_type = p_type)) t
    )
  );
$$;
