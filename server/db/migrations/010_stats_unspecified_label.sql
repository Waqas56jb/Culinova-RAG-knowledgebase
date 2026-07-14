-- ============================================================================
-- DASHBOARD STATS — clearer empty label
--
-- The stats breakdown bucketed records with a NULL category/brand/status/power_type under "—",
-- which reads as a mystery row on the dashboard. Label it "Unspecified" so it is self-explanatory:
-- it means the field has no value for those items (a data-completeness signal), not a broken row.
--
-- Replaces the function body only. Additive and idempotent.
-- ============================================================================

create or replace function ceks_entry_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'total', (select count(*) from ceks_knowledge_entries),
    'byStatus',    (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(current_status, 'Unspecified') k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byCategory',  (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(category, 'Unspecified')       k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byBrand',     (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(brand, 'Unspecified')          k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byPowerType', (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(power_type, 'Unspecified')     k, count(*) n from ceks_knowledge_entries group by 1) s)
  );
$$;
