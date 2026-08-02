-- ============================================================================
-- 028 · SELF-LEARNING generalises to SIMILAR products (client requirement)
--
-- The reviewer classifies a product type once; the NEXT similar product must classify automatically,
-- even if the datasheet wording differs ("Knife Sterilizer" vs "Sterilizing Cabinet"). Exact-string
-- learning (ceks_category_aliases) can't do that, so we add a KEYWORD rule table: the distinctive
-- stemmed keyword of a manually-classified type -> approved category. Classification consults it after
-- exact/synonym/phrase. Every rule is validated against the approved list at read time (never invents).
--
-- Also adds a "Sterilizer" category (under Food Preparation) so sterilizers can be classified at all —
-- the client can move it to another family later; one-family-per-category is preserved.
-- ============================================================================

create table if not exists ceks_category_keyword_rules (
  id          uuid primary key default gen_random_uuid(),
  keyword     text not null,          -- distinctive stemmed token (e.g. "steriliz")
  category    text not null,          -- must be an approved category
  source_type text,                   -- the type the client classified, for traceability
  created_at  timestamptz default now()
);
create unique index if not exists ceks_category_keyword_rules_keyword_key on ceks_category_keyword_rules (keyword);

insert into ceks_equipment_taxonomy (family, category, sort_order)
select 'Food Preparation', 'Sterilizer',
       coalesce((select max(sort_order) from ceks_equipment_taxonomy where family = 'Food Preparation'), 0) + 1
where not exists (select 1 from ceks_equipment_taxonomy where lower(category) = 'sterilizer');
