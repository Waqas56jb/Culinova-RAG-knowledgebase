-- ============================================================================
-- PER-VERSION APPLICABILITY
--
-- Not every machine needs every utility. A stainless-steel work table has no electrical, water or
-- gas connection at all — so EOS must HIDE those sections entirely, not render them empty or, worse,
-- flag them as "Missing". Missing means "we should have this and we don't"; not-applicable means
-- "this will never exist for this item". Conflating the two produces a noisy, dishonest UI.
--
-- When a source explicitly declares a utility as not applicable (e.g. the CULINOVA SS product sheet
-- writes "N/A" in Electrical / Water / Drain / Gas Requirement), we record that DECLARATION here.
-- It is evidence, not a guess: the column said N/A, so the discipline is switched off for this item.
--
-- Disciplines are referenced by their code from ceks_disciplines (electrical, plumbing, gas, …) so
-- this stays data-driven — adding a discipline never requires touching this schema.
--
-- Additive and idempotent.
-- ============================================================================

alter table ceks_knowledge_versions
  add column if not exists not_applicable_disciplines text[] not null default '{}';

comment on column ceks_knowledge_versions.not_applicable_disciplines is
  'Discipline codes the SOURCE explicitly declared as not applicable for this item (e.g. {electrical,gas}). Drives section hiding in the UI. Empty = nothing declared; applicability is then derived from the category standard and the item''s own data.';

create index if not exists idx_ceks_kv_not_applicable
  on ceks_knowledge_versions using gin (not_applicable_disciplines);
