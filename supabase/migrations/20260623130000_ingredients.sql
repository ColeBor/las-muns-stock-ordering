-- Phase 1 of the Factory Bake Schedule: a shared ingredient stock.
-- One pool for the whole operation (not per-factory). Factory workers and
-- managers manage it; recipes (phase 2) and bake confirmation (phase 3) will
-- read/deduct from it.

create table if not exists public.ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  unit text not null default 'unit',                 -- g, kg, mL, L, each, …
  on_hand_qty numeric not null default 0 check (on_hand_qty >= 0),
  low_stock_threshold numeric check (low_stock_threshold is null or low_stock_threshold >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ingredients enable row level security;

drop policy if exists "Ingredients: factory + managers manage" on public.ingredients;
create policy "Ingredients: factory + managers manage" on public.ingredients
  for all
  using (public.is_factory_worker() or public.is_store_manager())
  with check (public.is_factory_worker() or public.is_store_manager());

create or replace function public.touch_ingredient() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists ingredients_touch on public.ingredients;
create trigger ingredients_touch
  before update on public.ingredients
  for each row execute function public.touch_ingredient();

-- Realtime so the stock + grocery list refresh live.
alter table public.ingredients replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ingredients'
  ) then
    alter publication supabase_realtime add table public.ingredients;
  end if;
end
$$;
