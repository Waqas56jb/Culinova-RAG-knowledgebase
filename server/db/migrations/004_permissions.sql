-- ============================================================================
-- EOS PHASE 2 · LAYER 0 — PERMISSIONS
--
-- The client asked for "Approval permissions" to be manageable from the Admin Portal (item 20).
-- So a permission is a ROW, and a role's capabilities are ROWS — never an `if (role === 'admin')`
-- somewhere in the code. Adding a capability, or moving it between roles, is a database change.
--
-- Today EOS has ZERO authentication: all 30 routes are open to the public internet, including
-- DELETE /api/entries/:id and POST /api/admin/bulk-approve. This migration is the schema half of
-- fixing that.
-- ============================================================================

create table if not exists ceks_permissions (
  code        text primary key,
  name        text not null,
  description text,
  area        text not null default 'general',
  sort_order  int not null default 0
);

create table if not exists ceks_role_permissions (
  role_id         uuid not null references ceks_roles(id) on delete cascade,
  permission_code text not null references ceks_permissions(code) on delete cascade,
  granted_at      timestamptz not null default now(),
  primary key (role_id, permission_code)
);
create index if not exists idx_ceks_roleperm_role on ceks_role_permissions(role_id);

-- refresh tokens, so a stolen access token has a short life
create table if not exists ceks_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references ceks_users(id) on delete cascade,
  token_hash text not null,
  user_agent text,
  ip         text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_ceks_sessions_user on ceks_sessions(user_id);
create unique index if not exists uq_ceks_session_token on ceks_sessions(token_hash);

-- ─────────────────────────────────────────────────────────────────────────────
-- The capability catalogue. Every guarded action in the system appears here.
-- ─────────────────────────────────────────────────────────────────────────────
insert into ceks_permissions (code, name, description, area, sort_order) values
  -- knowledge
  ('knowledge.read',        'View knowledge',            'See equipment entries in any status.',                 'knowledge', 10),
  ('knowledge.ingest',      'Import equipment',          'Upload PDFs, folders, Excel, or enter equipment manually.', 'knowledge', 20),
  ('knowledge.edit',        'Edit equipment data',       'Correct identity and attribute values.',               'knowledge', 30),
  ('knowledge.delete',      'Delete equipment',          'Permanently remove an entry and its documents.',       'knowledge', 40),
  ('knowledge.submit',      'Submit for review',         'Move a draft into review.',                            'knowledge', 50),
  ('knowledge.approve',     'Approve equipment',         'Approve or reject an entry. Approved entries are published to the ERP.', 'knowledge', 60),
  -- engineering rules
  ('rule.read',             'View rules',                'See the CULINOVA Engineering Rules.',                  'rules', 100),
  ('rule.create',           'Author rules',              'Create, import, duplicate and edit engineering rules.', 'rules', 110),
  ('rule.approve',          'Approve rules',             'Approve a rule and activate it. An approved rule starts changing recommendations.', 'rules', 120),
  ('rule.archive',          'Archive rules',             'Deactivate or archive a rule.',                        'rules', 130),
  ('dictionary.manage',     'Manage the dictionary',     'Edit parameters, aliases, units and value mappings.',   'rules', 140),
  ('settings.manage',       'Manage engine settings',    'Change engine policy (thresholds, conflict handling).', 'rules', 150),
  -- recommendations
  ('recommendation.read',   'View recommendations',      'See the CULINOVA recommendations on an entry.',         'recommendations', 200),
  ('recommendation.decide', 'Decide recommendations',    'Accept, modify or reject an engineering recommendation.', 'recommendations', 210),
  ('recommendation.run',    'Run the rules engine',      'Generate or recalculate recommendations.',             'recommendations', 220),
  -- admin
  ('user.manage',           'Manage users',              'Create users, assign roles and permissions.',           'admin', 300),
  ('audit.read',            'View the audit trail',      'See who did what.',                                    'admin', 310)
on conflict (code) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sensible defaults. Every one of these is editable in the Admin Portal — they are a starting
-- point, not a law.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  r_super uuid; r_eng uuid; r_rev uuid; r_dept uuid; r_esm uuid;
begin
  select id into r_super from ceks_roles where name = 'Super Admin';
  select id into r_eng   from ceks_roles where name = 'Engineer';
  select id into r_rev   from ceks_roles where name = 'Reviewer';
  select id into r_dept  from ceks_roles where name = 'Department User';
  select id into r_esm   from ceks_roles where name = 'Engineering Standards Manager';

  -- Super Admin: everything
  insert into ceks_role_permissions (role_id, permission_code)
  select r_super, code from ceks_permissions
  on conflict do nothing;

  -- Engineer: works the equipment, decides recommendations, but does NOT author standards
  insert into ceks_role_permissions (role_id, permission_code)
  select r_eng, code from ceks_permissions where code in (
    'knowledge.read','knowledge.ingest','knowledge.edit','knowledge.submit',
    'rule.read','recommendation.read','recommendation.decide','recommendation.run'
  ) on conflict do nothing;

  -- Reviewer: approves equipment, decides recommendations. Cannot ingest or delete.
  insert into ceks_role_permissions (role_id, permission_code)
  select r_rev, code from ceks_permissions where code in (
    'knowledge.read','knowledge.edit','knowledge.approve',
    'rule.read','recommendation.read','recommendation.decide','recommendation.run','audit.read'
  ) on conflict do nothing;

  -- Engineering Standards Manager: OWNS the standards. This is the role the client asked for.
  insert into ceks_role_permissions (role_id, permission_code)
  select r_esm, code from ceks_permissions where code in (
    'knowledge.read',
    'rule.read','rule.create','rule.approve','rule.archive',
    'dictionary.manage','settings.manage',
    'recommendation.read','recommendation.run','audit.read'
  ) on conflict do nothing;

  -- Department User: read-only
  insert into ceks_role_permissions (role_id, permission_code)
  select r_dept, code from ceks_permissions where code in (
    'knowledge.read','rule.read','recommendation.read'
  ) on conflict do nothing;
end $$;
