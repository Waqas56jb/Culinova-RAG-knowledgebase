-- ============================================================================
-- 020 · ONE FAMILY PER CATEGORY  (client rule)
--
-- Seven categories were listed under two families. The client's decision: each belongs to ONE family.
--   Deck Oven · Rack Oven · Rotary Oven                   → Bakery Equipment ONLY (remove from Cooking)
--   Dough Divider · Dough Rounder · Dough Sheeter · Bread Slicer → Bakery Equipment ONLY (remove from Food Preparation)
-- (The seven Waste Management items were already moved out of Laundry in migration 019.)
--
-- Result: 194 → 187 categories, each in exactly one family — matching the approved master list.
-- ============================================================================

delete from ceks_equipment_taxonomy
where family = 'Cooking'
  and category in ('Deck Oven', 'Rack Oven', 'Rotary Oven');

delete from ceks_equipment_taxonomy
where family = 'Food Preparation'
  and category in ('Dough Divider', 'Dough Rounder', 'Dough Sheeter', 'Bread Slicer');

-- safety: ensure no Waste-Management category is still duplicated under Laundry Equipment
delete from ceks_equipment_taxonomy
where family = 'Laundry Equipment'
  and category in ('Food Waste Disposer', 'Waste Compactor', 'Garbage Chute', 'Linen Chute', 'Waste Bin', 'Recycling Station', 'Oil Collection Tank');
