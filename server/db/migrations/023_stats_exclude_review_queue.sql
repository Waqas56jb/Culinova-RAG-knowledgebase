-- ============================================================================
-- 023 · DASHBOARD STATS reflect VALID products only
--
-- Client rule: a product with an empty Family/Category is NOT a valid product. It follows that the
-- dashboard's Family/Category/Brand breakdowns must NOT show an "Unspecified" bucket — those items
-- are the review queue, not part of the classified catalogue. This redefines ceks_entry_stats so:
--   • byFamily / byCategory / byBrand / byPowerType count only VALID products (family AND category set)
--   • adds `valid` and `needsReview` counts so the UI can show a dedicated "Needs Review" figure
--   • byStatus + total still cover ALL entries (a status breakdown must include under_review)
-- Additive and idempotent.
-- ============================================================================

create or replace function ceks_entry_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'total',       (select count(*) from ceks_knowledge_entries),
    'valid',       (select count(*) from ceks_knowledge_entries where family is not null and category is not null),
    'needsReview', (select count(*) from ceks_knowledge_entries where family is null or category is null),
    'byStatus',    (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(current_status, 'Unspecified') k, count(*) n from ceks_knowledge_entries group by 1) s),
    'byFamily',    (select coalesce(json_object_agg(k, n), '{}'::json) from (select family    k, count(*) n from ceks_knowledge_entries where family is not null and category is not null group by 1) s),
    'byCategory',  (select coalesce(json_object_agg(k, n), '{}'::json) from (select category  k, count(*) n from ceks_knowledge_entries where family is not null and category is not null group by 1) s),
    'byBrand',     (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(brand, 'Unspecified') k, count(*) n from ceks_knowledge_entries where family is not null and category is not null group by 1) s),
    'byPowerType', (select coalesce(json_object_agg(k, n), '{}'::json) from (select coalesce(power_type, 'Unspecified') k, count(*) n from ceks_knowledge_entries where family is not null and category is not null group by 1) s)
  );
$$;
