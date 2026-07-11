-- Run once in Supabase SQL Editor to support the Equipment Profile header.
-- Adds power type + product image to the model identity.
alter table ceks_models
  add column if not exists power_type text,   -- Electric | Gas | Neutral
  add column if not exists image_url  text;   -- product image URL (optional)
