-- ============================================================================
-- 025 · CLASSIFICATION COVERAGE  (client: "products still end up Unspecified — fix the logic")
--
-- Root-cause fix, not a dashboard hide: map the real equipment types found in the live data to their
-- correct APPROVED category, so standard items classify automatically. Every alias is guarded by a
-- JOIN onto the approved taxonomy, so nothing here can invent a category.
--   • CULINOVA OS/COS items are OVERSHELVES  -> Shelf Over Table
--   • NOVA COOL 3-door refrigerated/freezer counters -> Undercounter Refrigerator/Freezer
--   • FAGOR boiling tops / hot-plate cookers -> Hot Plate; grill tops -> Griddle; etc.
-- ============================================================================

insert into ceks_category_aliases (alias, category)
select v.alias, v.category
from (values
  -- Stainless Steel Fabrication — overshelves
  ('Overshelf',                                       'Shelf Over Table'),
  ('Over Shelf',                                      'Shelf Over Table'),
  ('Single Layer Overshelf',                          'Shelf Over Table'),
  ('Double Layer Overshelf',                          'Shelf Over Table'),
  -- Refrigeration — refrigerated / freezer counters
  ('Three Door Refrigerated Counter with Back Splash','Undercounter Refrigerator'),
  ('Three Door Refrigerated Counter',                 'Undercounter Refrigerator'),
  ('Refrigerated Counter',                            'Undercounter Refrigerator'),
  ('Three Door Freezer Counter with Back Splash',     'Undercounter Freezer'),
  ('Three Door Freezer Counter',                      'Undercounter Freezer'),
  ('Freezer Counter',                                 'Undercounter Freezer'),
  -- Food Preparation
  ('Vegetable Preparation Machine',                   'Vegetable Cutter'),
  ('Slicer',                                          'Meat Slicer'),
  ('Vertical Slicer',                                 'Meat Slicer'),
  ('Bowl Cutter',                                     'Combination Cutter & Mixer'),
  ('Blender',                                         'Bench Blender'),
  -- Cooking
  ('Electric Cooker',                                 'Hot Plate'),
  ('Boiling Top',                                     'Hot Plate'),
  ('Gas Boiling Top',                                 'Hot Plate'),
  ('Electric Boiling Top',                            'Hot Plate'),
  ('Grill Top',                                       'Griddle'),
  ('Gas Grill Top',                                   'Griddle'),
  ('Electric Grill Top',                              'Griddle'),
  ('Gas Grill',                                       'Griddle'),
  ('Electric Grill',                                  'Griddle'),
  ('Chip Scuttle',                                    'Food Warmer'),
  ('Mixed Cooker',                                    'Gas Range'),
  ('Oven',                                            'Convection Oven'),
  -- Bakery Equipment
  ('Electric Fermenter',                             'Dough Proofer'),
  ('Fermenter',                                       'Dough Proofer')
) as v(alias, category)
join ceks_equipment_taxonomy t on lower(t.category) = lower(v.category)
on conflict (lower(alias)) do nothing;
