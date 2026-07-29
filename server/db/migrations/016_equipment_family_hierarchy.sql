-- ============================================================================
-- 016 · EQUIPMENT FAMILY HIERARCHY  (Family → Category → Model)
--
-- EOS has three equipment levels that must never be mixed:
--   Equipment Family (Cooking) → Equipment Category (Gas Range) → Equipment Model (UNOX XEVC-0711).
-- Until now the Family level did not exist on equipment entries — only Category / equipment_type /
-- brand. This migration adds it:
--   1. ceks_equipment_taxonomy — the authoritative Family → Category map (seeded from the client's
--      catagory.xlsx). This is the single source of truth that derives an item's Family from its
--      Category, so the two levels can never drift apart.
--   2. a denormalized ceks_knowledge_entries.family column (same pattern as category/brand), backfilled
--      from the taxonomy.
--
-- Seeded families: Cooking (19), Warewashing (6), Food Preparation (26), Refrigeration (20).  (71 categories)
-- Additive and idempotent.
-- ============================================================================

create table if not exists ceks_equipment_taxonomy (
  id         uuid primary key default gen_random_uuid(),
  family     text not null,
  category   text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now(),
  unique (family, category)
);
create index if not exists idx_ceks_taxo_category on ceks_equipment_taxonomy (lower(category));
create index if not exists idx_ceks_taxo_family   on ceks_equipment_taxonomy (family);

-- ── seed the Family → Category map (idempotent) ──────────────────────────────
insert into ceks_equipment_taxonomy (family, category, sort_order) values
  ('Cooking', 'Gas Range', 1),
  ('Cooking', 'Wok Range', 2),
  ('Cooking', 'Fryer', 3),
  ('Cooking', 'Griddle', 4),
  ('Cooking', 'Charbroiler', 5),
  ('Cooking', 'Pasta Cooker', 6),
  ('Cooking', 'Bratt Pan', 7),
  ('Cooking', 'Tilting Pan', 8),
  ('Cooking', 'Stock Pot Range', 9),
  ('Cooking', 'Steam Jacketed Kettle / Boiling Pan', 10),
  ('Cooking', 'Combi Oven', 11),
  ('Cooking', 'Convection Oven', 12),
  ('Cooking', 'Deck Oven', 13),
  ('Cooking', 'Pizza Oven', 14),
  ('Cooking', 'Steamer', 15),
  ('Cooking', 'Bain Marie', 16),
  ('Cooking', 'Holding Cabinet', 17),
  ('Cooking', 'Hot Cupboard', 18),
  ('Cooking', 'Salamander', 19),
  ('Warewashing', 'Undercounter Dishwasher', 1),
  ('Warewashing', 'Hood Type Dishwasher', 2),
  ('Warewashing', 'Utensil Washer', 3),
  ('Warewashing', 'Rack Conveyor Dishwasher', 4),
  ('Warewashing', 'Flight Type Dishwasher', 5),
  ('Warewashing', 'Glasswasher', 6),
  ('Food Preparation', 'Vegetable Cutter', 1),
  ('Food Preparation', 'Food Processor', 2),
  ('Food Preparation', 'Combination Cutter & Mixer', 3),
  ('Food Preparation', 'Planetary Mixer', 4),
  ('Food Preparation', 'Spiral Mixer', 5),
  ('Food Preparation', 'Dough Kneader', 6),
  ('Food Preparation', 'Meat Mincer', 7),
  ('Food Preparation', 'Bone Saw', 8),
  ('Food Preparation', 'Meat Slicer', 9),
  ('Food Preparation', 'Meat Tenderizer', 10),
  ('Food Preparation', 'Sausage Filler', 11),
  ('Food Preparation', 'Potato Peeler', 12),
  ('Food Preparation', 'Vegetable Washer', 13),
  ('Food Preparation', 'Salad Spinner', 14),
  ('Food Preparation', 'Immersion Blender', 15),
  ('Food Preparation', 'Stick Blender', 16),
  ('Food Preparation', 'Bench Blender', 17),
  ('Food Preparation', 'Citrus Juicer', 18),
  ('Food Preparation', 'Juice Extractor', 19),
  ('Food Preparation', 'Can Opener', 20),
  ('Food Preparation', 'Vacuum Packing Machine', 21),
  ('Food Preparation', 'Chamber Vacuum Packing Machine', 22),
  ('Food Preparation', 'Sous-Vide Cooking Tank', 23),
  ('Food Preparation', 'Food Dehydrator', 24),
  ('Food Preparation', 'Cheese Grater', 25),
  ('Food Preparation', 'Bread Slicer', 26),
  ('Refrigeration', 'Reach-In Refrigerator', 1),
  ('Refrigeration', 'Reach-In Freezer', 2),
  ('Refrigeration', 'Undercounter Refrigerator', 3),
  ('Refrigeration', 'Undercounter Freezer', 4),
  ('Refrigeration', 'Worktop Refrigerator', 5),
  ('Refrigeration', 'Worktop Freezer', 6),
  ('Refrigeration', 'Pizza Preparation Counter', 7),
  ('Refrigeration', 'Salad Preparation Counter', 8),
  ('Refrigeration', 'Blast Chiller', 9),
  ('Refrigeration', 'Blast Freezer', 10),
  ('Refrigeration', 'Walk-In Cooler', 11),
  ('Refrigeration', 'Walk-In Freezer', 12),
  ('Refrigeration', 'Display Refrigerator', 13),
  ('Refrigeration', 'Display Freezer', 14),
  ('Refrigeration', 'Cake Display', 15),
  ('Refrigeration', 'Ice Cream Display', 16),
  ('Refrigeration', 'Milk Refrigerator', 17),
  ('Refrigeration', 'Fish Refrigerator', 18),
  ('Refrigeration', 'Meat Aging Cabinet', 19),
  ('Refrigeration', 'Wine Cooler', 20)
on conflict (family, category) do nothing;

-- ── denormalized Family on equipment entries (mirrors category/brand/equipment_type) ─────────
alter table ceks_knowledge_entries add column if not exists family text;

-- backfill: derive each entry's Family from its Category via the taxonomy (case-insensitive)
update ceks_knowledge_entries e
set    family = t.family
from   ceks_equipment_taxonomy t
where  e.family is null
  and  e.category is not null
  and  lower(e.category) = lower(t.category);
