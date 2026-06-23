-- Phase 3 of the Factory Bake Schedule: the plan + confirm/deduct.
--
-- factory_bake_lines is the current plan: per item, planned boxes to bake and
-- boxes confirmed baked so far. confirm_bake() bumps baked_qty and deducts the
-- batch's ingredients from the shared ingredient stock — rounding UP to whole
-- batches, deducting only when a confirm crosses a new batch boundary so
-- incremental confirms don't over-deduct.

create table if not exists public.factory_bake_lines (
  item_id uuid primary key references public.items(id) on delete cascade,
  planned_qty integer not null default 0 check (planned_qty >= 0), -- boxes
  baked_qty integer not null default 0 check (baked_qty >= 0),     -- boxes
  updated_at timestamptz not null default now()
);

alter table public.factory_bake_lines enable row level security;
drop policy if exists "Bake lines: factory + managers manage" on public.factory_bake_lines;
create policy "Bake lines: factory + managers manage" on public.factory_bake_lines
  for all
  using (public.is_factory_worker() or public.is_store_manager())
  with check (public.is_factory_worker() or public.is_store_manager());

create or replace function public.touch_factory_bake_line() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists factory_bake_lines_touch on public.factory_bake_lines;
create trigger factory_bake_lines_touch
  before update on public.factory_bake_lines
  for each row execute function public.touch_factory_bake_line();

alter table public.factory_bake_lines replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'factory_bake_lines'
  ) then
    alter publication supabase_realtime add table public.factory_bake_lines;
  end if;
end
$$;

-- Confirm baking p_qty boxes of an item: add to baked_qty and deduct the
-- newly-crossed whole batches' ingredients from stock.
create or replace function public.confirm_bake(p_item_id uuid, p_qty integer)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_batch integer;
  v_old integer;
  v_new integer;
  v_delta_batches integer;
begin
  if not (public.is_factory_worker() or public.is_store_manager()) then
    raise exception 'Not allowed';
  end if;
  if p_qty is null or p_qty <= 0 then
    return;
  end if;

  select batch_size into v_batch from public.item_recipes where item_id = p_item_id;
  if v_batch is null then
    raise exception 'No recipe / batch size set for this item';
  end if;

  select baked_qty into v_old from public.factory_bake_lines where item_id = p_item_id;
  v_old := coalesce(v_old, 0);
  v_new := v_old + p_qty;

  insert into public.factory_bake_lines (item_id, planned_qty, baked_qty)
    values (p_item_id, 0, v_new)
  on conflict (item_id) do update set baked_qty = v_new, updated_at = now();

  v_delta_batches := (ceil(v_new::numeric / v_batch) - ceil(v_old::numeric / v_batch))::int;
  if v_delta_batches > 0 then
    update public.ingredients i
    set on_hand_qty = greatest(0, i.on_hand_qty - ri.qty_per_batch * v_delta_batches)
    from public.recipe_ingredients ri
    where ri.item_id = p_item_id and ri.ingredient_id = i.id;
  end if;
end;
$$;

grant execute on function public.confirm_bake(uuid, integer) to authenticated;
