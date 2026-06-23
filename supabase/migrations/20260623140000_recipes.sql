-- Phase 2 of the Factory Bake Schedule: recipes.
--
-- Each manufactured item gets a recipe: a batch size (how many BOXES one batch
-- yields — recall 1 box = 30 empanadas) plus the amount of each ingredient one
-- batch consumes. Phase 3 uses these to compute the grocery list and to deduct
-- ingredients when a bake is confirmed.

create table if not exists public.item_recipes (
  item_id uuid primary key references public.items(id) on delete cascade,
  batch_size integer not null check (batch_size > 0),   -- boxes produced per batch
  updated_at timestamptz not null default now()
);

create table if not exists public.recipe_ingredients (
  item_id uuid not null references public.item_recipes(item_id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  qty_per_batch numeric not null check (qty_per_batch >= 0),
  primary key (item_id, ingredient_id)
);

create index if not exists recipe_ingredients_ingredient_idx
  on public.recipe_ingredients(ingredient_id);

alter table public.item_recipes enable row level security;
alter table public.recipe_ingredients enable row level security;

drop policy if exists "Recipes: factory + managers manage" on public.item_recipes;
create policy "Recipes: factory + managers manage" on public.item_recipes
  for all
  using (public.is_factory_worker() or public.is_store_manager())
  with check (public.is_factory_worker() or public.is_store_manager());

drop policy if exists "Recipe ingredients: factory + managers manage" on public.recipe_ingredients;
create policy "Recipe ingredients: factory + managers manage" on public.recipe_ingredients
  for all
  using (public.is_factory_worker() or public.is_store_manager())
  with check (public.is_factory_worker() or public.is_store_manager());

create or replace function public.touch_item_recipe() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists item_recipes_touch on public.item_recipes;
create trigger item_recipes_touch
  before update on public.item_recipes
  for each row execute function public.touch_item_recipe();

do $$
declare
  t text;
  tbls text[] := array['item_recipes', 'recipe_ingredients'];
begin
  foreach t in array tbls loop
    execute format('alter table public.%I replica identity full', t);
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
