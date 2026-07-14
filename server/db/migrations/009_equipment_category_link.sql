-- ============================================================================
-- EQUIPMENT ↔ CATEGORY PROFILE LINK
--
-- A piece of equipment is governed by ONE category profile (a Fryer datasheet → the "Fryer" profile).
-- The link is explicit and stored here so the engine applies a profile deliberately: EOS SUGGESTS a
-- profile by matching the equipment's type/category to a standard name, an exact match may auto-link,
-- but a fuzzy or absent match is never forced — the engineer binds it. This column records that bind.
--
-- Additive and idempotent.
-- ============================================================================

alter table ceks_knowledge_entries
  add column if not exists category_profile_id uuid references ceks_category_profiles(id) on delete set null,
  add column if not exists category_profile_source text;   -- 'auto' (exact match) | 'engineer' (manual)

create index if not exists idx_ceks_entry_catprofile on ceks_knowledge_entries(category_profile_id);
