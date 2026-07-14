-- ============================================================================
-- EOS PHASE 2 · ENGINE INTEGRITY
--
-- DB-level guarantees the application layer should not be the only thing enforcing:
--   1. A recommendation confidence policy for UNKNOWN/assumed inputs (data, not code).
--   2. At most ONE "current" recommendation per (version, parameter) — enforced by the database,
--      so a race between two generations can never leave two live recommendations for one field.
--   3. A rule can be ACTIVE only when it is APPROVED — the client's approval-before-active control,
--      enforced by a trigger so no code path (or manual SQL) can bypass it.
--
-- Additive and idempotent.
-- ============================================================================

-- 1) UNKNOWN-CONFIDENCE POLICY ------------------------------------------------
-- An extracted input with no confidence (or a value that had to be assumed) must NOT read as fully
-- trusted. Treat it as this value — kept below confidence_threshold so it is flagged "Verify Input".
insert into ceks_engine_settings (key, value, value_type, description) values
  ('unknown_confidence_default', '0.5', 'number',
   'When an extracted input has no confidence score, or a value was assumed (e.g. no unit stated, a bound recorded), treat it as THIS confidence rather than fully trusted. Kept below confidence_threshold so such inputs are flagged "Verify Input".')
on conflict (key) do nothing;

-- 2) ONE CURRENT RECOMMENDATION PER (VERSION, PARAMETER) ----------------------
-- First retire any pre-existing duplicates (keep the newest), so the unique index can be created.
with ranked as (
  select id,
         row_number() over (
           partition by version_id, parameter_id
           order by generated_at desc nulls last, created_at desc nulls last
         ) as rn
  from ceks_recommendations
  where is_current
)
update ceks_recommendations r
   set is_current = false
  from ranked
 where ranked.id = r.id
   and ranked.rn > 1;

create unique index if not exists uq_ceks_rec_current
  on ceks_recommendations (version_id, parameter_id)
  where is_current;

-- 3) A RULE MAY BE ACTIVE ONLY WHEN APPROVED ----------------------------------
create or replace function ceks_rule_active_guard() returns trigger
language plpgsql as $$
begin
  if NEW.is_active and NEW.status is distinct from 'approved' then
    raise exception
      'Rule % cannot be active while its status is "%": only an approved rule may be active.',
      NEW.code, NEW.status
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_ceks_rule_active_guard on ceks_rules;
create trigger trg_ceks_rule_active_guard
  before insert or update on ceks_rules
  for each row execute function ceks_rule_active_guard();

-- correct any rows that violate the invariant today (defensive; there should be none)
update ceks_rules set is_active = false where is_active and status is distinct from 'approved';
