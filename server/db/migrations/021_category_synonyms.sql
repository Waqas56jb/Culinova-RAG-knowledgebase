-- ============================================================================
-- 021 · CATEGORY SYNONYMS  (client rule)
--
-- "EOS should normalize common equipment names before assigning the approved
--  category ... use synonyms (or a dictionary) to map common product names to
--  the approved 187 categories BEFORE asking for manual review."
--
-- A data-driven alias table: each row maps a common name -> an approved category.
-- The client extends coverage by inserting rows — no redeploy (mirrors ceks_brand_aliases).
--
-- SAFETY: the seed is inserted through a JOIN onto ceks_equipment_taxonomy, so an
-- alias can ONLY ever point at one of the approved 187 categories. A typo'd or
-- non-approved target is silently dropped — EOS can never invent a category via a synonym.
-- The resolver validates the same way at read time, so this invariant holds even for
-- rows the client adds later.
-- ============================================================================

create table if not exists ceks_category_aliases (
  id         uuid primary key default gen_random_uuid(),
  alias      text not null,
  category   text not null,           -- must be an approved ceks_equipment_taxonomy.category
  note       text,
  created_at timestamptz default now()
);
create unique index if not exists ceks_category_aliases_alias_key
  on ceks_category_aliases (lower(alias));

insert into ceks_category_aliases (alias, category)
select v.alias, v.category
from (values
  -- ── Refrigeration ────────────────────────────────────────────────────────
  ('Upright Refrigerator','Reach-In Refrigerator'),
  ('Upright Chiller','Reach-In Refrigerator'),
  ('Upright Fridge','Reach-In Refrigerator'),
  ('Single Door Refrigerator','Reach-In Refrigerator'),
  ('Double Door Refrigerator','Reach-In Refrigerator'),
  ('Two Door Refrigerator','Reach-In Refrigerator'),
  ('Three Door Refrigerator','Reach-In Refrigerator'),
  ('Single Door Chiller','Reach-In Refrigerator'),
  ('Double Door Chiller','Reach-In Refrigerator'),
  ('Reach In Fridge','Reach-In Refrigerator'),
  ('Upright Freezer','Reach-In Freezer'),
  ('Single Door Freezer','Reach-In Freezer'),
  ('Double Door Freezer','Reach-In Freezer'),
  ('Two Door Freezer','Reach-In Freezer'),
  ('Cold Room','Walk-In Cooler'),
  ('Walk In Cold Room','Walk-In Cooler'),
  ('Walk In Chiller','Walk-In Cooler'),
  ('Walk In Cold Store','Walk-In Cooler'),
  ('Under Counter Refrigerator','Undercounter Refrigerator'),
  ('Under Counter Fridge','Undercounter Refrigerator'),
  ('Under Counter Freezer','Undercounter Freezer'),
  ('Wine Fridge','Wine Cooler'),
  ('Wine Refrigerator','Wine Cooler'),
  ('Wine Chiller','Wine Cooler'),
  ('Bottle Fridge','Bottle Cooler'),
  ('Bottle Refrigerator','Bottle Cooler'),
  ('Pizza Prep Counter','Pizza Preparation Counter'),
  ('Pizza Prep Table','Pizza Preparation Counter'),
  ('Salad Prep Counter','Salad Preparation Counter'),
  ('Salad Prep Table','Salad Preparation Counter'),
  ('Saladette','Salad Preparation Counter'),
  ('Sandwich Prep Counter','Sandwich Preparation Counter'),
  ('Sandwich Prep Table','Sandwich Preparation Counter'),
  ('Sandwich Counter','Sandwich Preparation Counter'),
  ('Display Fridge','Display Refrigerator'),
  ('Display Chiller','Display Refrigerator'),
  ('Display Cooler','Display Refrigerator'),
  ('Glass Door Merchandiser','Display Refrigerator'),
  ('Glass Door Refrigerator','Display Refrigerator'),
  ('Merchandiser Refrigerator','Display Refrigerator'),
  ('Cake Showcase','Cake Display'),
  ('Cake Display Counter','Cake Display'),
  ('Patisserie Display','Cake Display'),
  ('Ice Cream Display Freezer','Ice Cream Display'),
  ('Gelato Display','Ice Cream Display'),
  -- ── Cooking ──────────────────────────────────────────────────────────────
  ('Gas Cooker','Gas Range'),
  ('Gas Stove','Gas Range'),
  ('Gas Cooking Range','Gas Range'),
  ('Deep Fryer','Fryer'),
  ('Deep Fat Fryer','Fryer'),
  ('Gas Fryer','Fryer'),
  ('Electric Fryer','Fryer'),
  ('Flat Top Grill','Griddle'),
  ('Flat Top','Griddle'),
  ('Fry Top','Griddle'),
  ('Griddle Plate','Griddle'),
  ('Char Grill','Charbroiler'),
  ('Chargrill','Charbroiler'),
  ('Charcoal Grill','Charbroiler'),
  ('Char Broiler','Charbroiler'),
  ('Lava Rock Grill','Charbroiler'),
  ('Combi Steamer','Combi Oven'),
  ('Combination Oven','Combi Oven'),
  ('Combi Steam Oven','Combi Oven'),
  ('Fan Oven','Convection Oven'),
  ('Salamander Grill','Salamander'),
  ('Boiling Pan','Steam Jacketed Kettle / Boiling Pan'),
  ('Boiling Kettle','Steam Jacketed Kettle / Boiling Pan'),
  ('Steam Kettle','Steam Jacketed Kettle / Boiling Pan'),
  ('Jacketed Kettle','Steam Jacketed Kettle / Boiling Pan'),
  ('Steam Jacketed Kettle','Steam Jacketed Kettle / Boiling Pan'),
  ('Microwave','Microwave Oven'),
  ('Steam Cooker','Steamer'),
  ('Induction Cooker','Induction Range'),
  ('Induction Hob','Induction Range'),
  ('Induction Cooktop','Induction Range'),
  ('Wok Cooker','Wok Range'),
  ('Wok Stove','Wok Range'),
  ('Chinese Range','Wok Range'),
  ('Pasta Boiler','Pasta Cooker'),
  ('Hot Holding Cabinet','Heated Holding Cabinet'),
  ('Heated Cabinet','Heated Holding Cabinet'),
  ('Warming Cabinet','Heated Holding Cabinet'),
  ('Soup Warmer','Food Warmer'),
  -- ── Food Preparation ─────────────────────────────────────────────────────
  ('Stand Mixer','Planetary Mixer'),
  ('Bowl Mixer','Planetary Mixer'),
  ('Spiral Dough Mixer','Spiral Mixer'),
  ('Meat Grinder','Meat Mincer'),
  ('Mincer','Meat Mincer'),
  ('Deli Slicer','Meat Slicer'),
  ('Gravity Slicer','Meat Slicer'),
  ('Vacuum Sealer','Vacuum Packing Machine'),
  ('Vacuum Packer','Vacuum Packing Machine'),
  ('Chamber Vacuum Sealer','Chamber Vacuum Packing Machine'),
  ('Chamber Vacuum Packer','Chamber Vacuum Packing Machine'),
  ('Veg Prep Machine','Vegetable Cutter'),
  ('Vegetable Prep Machine','Vegetable Cutter'),
  ('Sous Vide','Sous-Vide Cooking Tank'),
  ('Sous Vide Machine','Sous-Vide Cooking Tank'),
  -- ── Bakery Equipment ─────────────────────────────────────────────────────
  ('Pastry Sheeter','Dough Sheeter'),
  ('Dough Roller','Dough Sheeter'),
  ('Pastry Roller','Dough Sheeter'),
  ('Reversible Sheeter','Dough Sheeter'),
  ('Dough Molder','Dough Moulder'),
  ('Proofer','Dough Proofer'),
  ('Proving Cabinet','Dough Proofer'),
  ('Dough Prover','Dough Proofer'),
  ('Fermentation Cabinet','Dough Proofer'),
  ('Dough Portioner','Dough Divider'),
  ('Bread Slicing Machine','Bread Slicer'),
  -- ── Stainless Steel Fabrication ──────────────────────────────────────────
  ('Shelving Unit','Shelf'),
  ('Shelving','Shelf'),
  ('Wire Shelf','Shelf'),
  ('Wire Shelving','Shelf'),
  ('Storage Shelf','Shelf'),
  ('Work Bench','Work Table'),
  ('Workbench','Work Table'),
  ('Prep Table','Work Table'),
  ('Preparation Table','Work Table'),
  ('Stainless Table','Work Table'),
  ('Worktable','Work Table'),
  ('Wall Mounted Shelf','Wall Shelf'),
  ('Storage Cabinet','Cabinet'),
  ('Cupboard','Cabinet'),
  ('Hand Sink','Hand Wash Sink'),
  ('Hand Wash Basin','Hand Wash Sink'),
  ('Hand Basin','Hand Wash Sink'),
  ('Pot Sink','Pot Wash Sink'),
  ('Pot Wash','Pot Wash Sink'),
  ('Utility Cart','Trolley'),
  ('Cart','Trolley'),
  ('Storage Rack','Rack'),
  ('Extraction Hood','Exhaust Hood'),
  ('Kitchen Hood','Exhaust Hood'),
  ('Canopy Hood','Exhaust Hood'),
  ('Ventilation Hood','Exhaust Hood'),
  ('Grease Interceptor','Grease Trap'),
  ('Flour Bin','Ingredient Bin'),
  ('Storage Bin','Ingredient Bin'),
  -- ── Warewashing ──────────────────────────────────────────────────────────
  ('Hood Dishwasher','Hood Type Dishwasher'),
  ('Pass Through Dishwasher','Hood Type Dishwasher'),
  ('Passthrough Dishwasher','Hood Type Dishwasher'),
  ('Conveyor Dishwasher','Rack Conveyor Dishwasher'),
  ('Glass Washer','Glasswasher'),
  -- ── Beverage Equipment ───────────────────────────────────────────────────
  ('Coffee Maker','Coffee Machine'),
  ('Bean To Cup','Coffee Machine'),
  ('Bean To Cup Machine','Coffee Machine'),
  ('Drip Coffee Maker','Coffee Brewer'),
  ('Filter Coffee Machine','Coffee Brewer'),
  ('Espresso Maker','Espresso Machine'),
  ('Hot Water Dispenser','Hot Water Boiler'),
  -- ── Ventilation ──────────────────────────────────────────────────────────
  ('Extractor Fan','Exhaust Fan'),
  ('Type 1 Hood','Type I Hood'),
  ('Type 2 Hood','Type II Hood'),
  ('Make Up Air Unit','Make-Up Air Unit'),
  ('Makeup Air Unit','Make-Up Air Unit'),
  -- ── Ice Machines ─────────────────────────────────────────────────────────
  ('Cube Ice Maker','Cube Ice Machine'),
  ('Flake Ice Maker','Flake Ice Machine'),
  ('Nugget Ice Maker','Nugget Ice Machine'),
  ('Ice Bin','Ice Storage Bin'),
  -- ── Laundry Equipment ────────────────────────────────────────────────────
  ('Washing Machine','Washer Extractor'),
  -- ── Waste Management ─────────────────────────────────────────────────────
  ('Garbage Disposal','Food Waste Disposer'),
  ('Waste Disposal Unit','Food Waste Disposer')
) as v(alias, category)
join ceks_equipment_taxonomy t on lower(t.category) = lower(v.category)  -- guard: approved targets only
on conflict (lower(alias)) do nothing;
