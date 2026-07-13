-- ============================================================================
-- EOS PHASE 2 · LAYER 1 — THE ENGINEERING RULES ENGINE
--
-- A rule is DATA. Adding Electrical, Plumbing, Gas, Ventilation, Installation or any
-- future discipline is rows in these tables — never a code change. That is the client's
-- stated objective: "once we provide the rule tables, we should only need to upload,
-- review and validate them."
--
-- Rule = Category + Conditions + Outputs, plus everything the client listed:
--   Rule ID · Category · Description · Conditions · Outputs · Priority · Version ·
--   Effective Date · Active/Inactive · Engineer Approval Required · Notes & references
--
-- TWO KINDS OF RULE, one table:
--   'recommendation' — matches extracted data and PRODUCES an engineering output
--                      (Cable Size, Breaker, Drain Size, Exhaust Airflow, …)
--   'derivation'     — computes a MISSING INPUT from other inputs, e.g. Current from
--                      Power + Voltage + Phase. The client requires that the formula,
--                      power factor, efficiency and assumptions live here as an
--                      EDITABLE, SEPARATELY-REVIEWED rule — never hardcoded.
--
-- Additive and idempotent. Drops nothing.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- RULES
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_rules (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,                        -- the client's "Rule ID", e.g. E-006
  name          text,
  description   text,
  discipline_id uuid not null references ceks_disciplines(id) on delete restrict,
  rule_type     text not null default 'recommendation'
                check (rule_type in ('recommendation','derivation')),

  priority      int  not null default 100,            -- higher wins; equal + disagreeing = engineer conflict
  version       int  not null default 1,
  status        text not null default 'draft'
                check (status in ('draft','under_review','approved','archived')),
  is_active     boolean not null default false,       -- only an APPROVED rule may be activated
  effective_from date,
  effective_to   date,

  engineer_approval_required boolean not null default false,  -- client field: forces engineer sign-off

  -- provenance: which published standard does this rule come from, and which clause
  standard_id   uuid references ceks_standards(id) on delete set null,
  clause        text,
  notes         text,
  reference_url text,

  created_by    uuid references ceks_users(id) on delete set null,
  approved_by   uuid references ceks_users(id) on delete set null,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists uq_ceks_rule_code_version on ceks_rules(lower(code), version);
create index if not exists idx_ceks_rules_discipline on ceks_rules(discipline_id);
create index if not exists idx_ceks_rules_active on ceks_rules(is_active, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- CONDITIONS — "the criteria that must be matched before the rule is applied"
--   Phase = 3-Phase · Voltage = 400V · Frequency = 60Hz · Current between 16 and 20 A
--   Equipment Category = Combi Oven · Gas Type = LPG
--
-- A condition names a PARAMETER (never a free-text attribute name), so it can always
-- be evaluated. Ranges are first-class — the electrical tables are range tables.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_rule_conditions (
  id           uuid primary key default gen_random_uuid(),
  rule_id      uuid not null references ceks_rules(id) on delete cascade,
  parameter_id uuid not null references ceks_parameters(id) on delete restrict,
  operator     text not null
               check (operator in ('eq','neq','gt','gte','lt','lte','between','in','not_in',
                                   'exists','not_exists','contains','matches')),
  value_text   text,
  value_num    numeric,
  value_min    numeric,     -- between: CURRENT FROM
  value_max    numeric,     -- between: CURRENT TO
  value_list   jsonb,       -- in / not_in
  unit         text,        -- the unit the author wrote it in; normalised on evaluation
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ceks_rulecond_rule on ceks_rule_conditions(rule_id);
create index if not exists idx_ceks_rulecond_param on ceks_rule_conditions(parameter_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- OUTPUTS — "the engineering recommendations EOS will automatically populate"
--
-- Either a LITERAL value (Cable Size = "5×6 mm² Cu"), or an EXPRESSION evaluated
-- against the equipment's parameters. The expression is DATA — this is how the
-- client's derivation formulas (with PF / efficiency / assumptions) enter the system
-- without a developer, and how they get reviewed like any other rule.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_rule_outputs (
  id           uuid primary key default gen_random_uuid(),
  rule_id      uuid not null references ceks_rules(id) on delete cascade,
  parameter_id uuid not null references ceks_parameters(id) on delete restrict,
  value_text   text,
  value_num    numeric,
  unit         text,
  expression   text,        -- e.g.  power_kw * 1000 / (sqrt(3) * voltage * pf)
  note         text,        -- engineering note attached to this output
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ceks_ruleout_rule on ceks_rule_outputs(rule_id);

-- Named constants a rule expression may use (PF, efficiency, diversity, √3 …).
-- The client insisted these are editable engineering data, reviewed separately.
create table if not exists ceks_rule_constants (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,        -- e.g. pf, efficiency, diversity_factor
  value       numeric not null,
  unit        text,
  description text,
  discipline_id uuid references ceks_disciplines(id) on delete set null,
  updated_by  uuid references ceks_users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RULE VERSIONS — a frozen snapshot taken at APPROVAL.
-- The client requires that every recommendation stays frozen against the rule version
-- that produced it, so a later standards change can never silently rewrite history.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_rule_versions (
  id          uuid primary key default gen_random_uuid(),
  rule_id     uuid not null references ceks_rules(id) on delete cascade,
  version     int  not null,
  snapshot    jsonb not null,            -- the whole rule: conditions + outputs + metadata
  change_note text,
  approved_by uuid references ceks_users(id) on delete set null,
  approved_at timestamptz not null default now()
);
create unique index if not exists uq_ceks_ruleversion on ceks_rule_versions(rule_id, version);

-- ─────────────────────────────────────────────────────────────────────────────
-- RECOMMENDATIONS — the CULINOVA engineering value, stored ALONGSIDE the
-- manufacturer's own extracted value. The manufacturer's data is never overwritten.
--
-- Carries full traceability (client item 5): rule id, rule category, rule version,
-- the exact inputs used, when it was generated, and who approved it.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_recommendations (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references ceks_knowledge_versions(id) on delete cascade,
  parameter_id  uuid not null references ceks_parameters(id) on delete restrict,

  -- the CULINOVA value
  value_text    text,
  value_num     numeric,
  unit          text,

  -- what the manufacturer said about the same parameter (may be null — often is)
  manufacturer_attribute_id uuid references ceks_knowledge_attributes(id) on delete set null,
  manufacturer_value        text,
  manufacturer_unit         text,

  -- TRACEABILITY
  rule_id       uuid references ceks_rules(id) on delete set null,
  rule_code     text,                     -- kept even if the rule is later archived
  rule_version  int,
  discipline_id uuid references ceks_disciplines(id) on delete set null,
  matched_conditions jsonb,               -- exactly which conditions matched, and on what values
  inputs_used   jsonb,                    -- the input parameters + values + their source page/doc
  confidence    numeric(4,3),             -- the weakest input confidence that fed this
  generated_at  timestamptz not null default now(),

  -- ENGINEER DECISION (client item 3): accept · modify · reject · comment · approve
  status        text not null default 'proposed'
                check (status in ('proposed','verify_input','accepted','modified','rejected',
                                  'conflict','no_rule','missing_input')),
  final_value   text,                     -- what the engineer actually approved
  final_unit    text,
  decided_by    uuid references ceks_users(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,                     -- the client requires a REASON on modify/reject

  conflict_with jsonb,                    -- equal-priority rules that disagreed
  superseded_by uuid references ceks_recommendations(id) on delete set null,
  is_current    boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists idx_ceks_rec_version on ceks_recommendations(version_id, is_current);
create index if not exists idx_ceks_rec_rule on ceks_recommendations(rule_id);
create index if not exists idx_ceks_rec_status on ceks_recommendations(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDATIONS — client item 4. Why a recommendation could NOT be produced, and
-- what the engineer must supply. Never a silent blank.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_validations (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references ceks_knowledge_versions(id) on delete cascade,
  discipline_id uuid references ceks_disciplines(id) on delete set null,
  parameter_id  uuid references ceks_parameters(id) on delete set null,
  rule_id       uuid references ceks_rules(id) on delete set null,

  severity      text not null default 'warning' check (severity in ('info','warning','error')),
  code          text not null,            -- missing_input · no_rule_match · out_of_range ·
                                          -- conflict · low_confidence · unit_unknown
  message       text not null,            -- human sentence: "Current is missing"
  reason        text,                     -- why the calculation could not complete
  required_input jsonb,                   -- exactly what the engineer must provide
  details       jsonb,

  status        text not null default 'open' check (status in ('open','acknowledged','resolved')),
  resolved_by   uuid references ceks_users(id) on delete set null,
  resolved_at   timestamptz,
  resolution_note text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_ceks_val_version on ceks_validations(version_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- RECOMMENDATION HISTORY — client item 6. Previous value, new value, why it changed,
-- which rule version, and the "Recalculation Available" trail.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_recommendation_history (
  id                uuid primary key default gen_random_uuid(),
  version_id        uuid not null references ceks_knowledge_versions(id) on delete cascade,
  recommendation_id uuid references ceks_recommendations(id) on delete set null,
  parameter_id      uuid references ceks_parameters(id) on delete set null,

  action            text not null
                    check (action in ('generated','regenerated','accepted','modified','rejected',
                                      'recalculation_available','recalculated','rule_changed')),
  previous_value    text,
  new_value         text,
  previous_rule_version int,
  new_rule_version  int,
  rule_id           uuid references ceks_rules(id) on delete set null,
  reason            text,
  actor_id          uuid references ceks_users(id) on delete set null,
  actor_name        text,
  details           jsonb,
  created_at        timestamptz not null default now()
);
create index if not exists idx_ceks_rechist_version on ceks_recommendation_history(version_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- RECALCULATION QUEUE — when a rule changes, the client wants EOS to DETECT every
-- affected item and let the engineer decide, deliberately. Nothing auto-rewrites.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ceks_recalc_alerts (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references ceks_knowledge_versions(id) on delete cascade,
  rule_id       uuid not null references ceks_rules(id) on delete cascade,
  old_version   int,
  new_version   int,
  status        text not null default 'pending' check (status in ('pending','recalculated','dismissed')),
  handled_by    uuid references ceks_users(id) on delete set null,
  handled_at    timestamptz,
  note          text,
  created_at    timestamptz not null default now()
);
create unique index if not exists uq_ceks_recalc on ceks_recalc_alerts(version_id, rule_id, new_version);
create index if not exists idx_ceks_recalc_status on ceks_recalc_alerts(status);
