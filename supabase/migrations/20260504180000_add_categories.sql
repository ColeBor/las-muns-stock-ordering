-- Add categories system for items

-- Create meta_category and sub_category enums
create type if not exists meta_category as enum ('Manufactured', 'Purchased');
create type if not exists sub_category as enum ('Empanada', 'Dessert', 'Drink', 'Cleaning Supplies', 'General Supplies', 'Sauce');

-- Add category columns to items table
alter table if exists items
add column if not exists meta_category meta_category,
add column if not exists sub_category sub_category;

-- Create a dedicated categories table for easier management
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  meta_category meta_category not null,
  sub_category sub_category not null,
  created_at timestamptz not null default now(),
  unique (meta_category, sub_category)
);

-- Insert default categories
insert into categories (meta_category, sub_category) values
  ('Manufactured', 'Empanada'),
  ('Manufactured', 'Dessert'),
  ('Manufactured', 'Sauce'),
  ('Purchased', 'Drink'),
  ('Purchased', 'Cleaning Supplies'),
  ('Purchased', 'General Supplies')
on conflict do nothing;

-- Update RLS policies for categories table
alter table categories enable row level security;

create policy "Anyone can read categories" on categories
  for select using (true);

create policy "Only HQ admins can manage categories" on categories
  for all using (is_hq_admin());
