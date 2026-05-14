-- Convert items.packaging_type from enum to plain text so values can be
-- managed via the new packaging_types table instead of hard-coded in
-- the enum. The cast keeps every existing value.
alter table public.items
  alter column packaging_type type text using packaging_type::text;

-- Drop the now-unused enum.
drop type if exists packaging_type;

-- Managed list, mirrors the suppliers/stores pattern.
create table if not exists public.packaging_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- Seed with the legacy enum values so existing items keep matching.
insert into public.packaging_types (name) values
  ('Single'), ('Stack'), ('Box'), ('Case'),
  ('Dozen'), ('Crate'), ('Bundle'), ('Bulk')
on conflict (name) do nothing;

alter table public.packaging_types enable row level security;

drop policy if exists "Packaging types: anyone can read" on public.packaging_types;
create policy "Packaging types: anyone can read"
  on public.packaging_types for select using (true);

drop policy if exists "Packaging types: store managers can manage" on public.packaging_types;
create policy "Packaging types: store managers can manage"
  on public.packaging_types for all
  using (public.is_store_manager())
  with check (public.is_store_manager());
