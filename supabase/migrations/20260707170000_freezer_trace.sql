-- Freezer box trace: the factory's version of the store box trace. Each logged
-- box that leaves the freezer decrements factory_inventory.on_hand_qty by 1
-- (deleting the log refunds it) — exactly mirroring how a store box trace
-- decrements that store's on-hand. This is how factory stock draws down as
-- product is used/shipped, without a manual recount.

create table if not exists public.freezer_trace_entries (
  id uuid primary key default gen_random_uuid(),
  factory_id uuid not null references public.factories(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  finished_on date not null default current_date,   -- date the box left the freezer
  box_prepared_on date not null,                    -- date stamped on the box
  recorded_by text,
  created_at timestamptz not null default now(),
  constraint freezer_trace_entries_dates_chk check (box_prepared_on <= finished_on)
);

create index if not exists freezer_trace_entries_factory_idx
  on public.freezer_trace_entries(factory_id, finished_on desc);

alter table public.freezer_trace_entries enable row level security;

-- "store manager" = the boss (all factories); "factory worker" = own factory.
drop policy if exists "Freezer trace: store managers manage" on public.freezer_trace_entries;
create policy "Freezer trace: store managers manage" on public.freezer_trace_entries
  for all using (public.is_store_manager()) with check (public.is_store_manager());

drop policy if exists "Freezer trace: factory workers manage own factory" on public.freezer_trace_entries;
create policy "Freezer trace: factory workers manage own factory" on public.freezer_trace_entries
  for all
  using (public.is_factory_worker() and factory_id = public.current_factory_id())
  with check (public.is_factory_worker() and factory_id = public.current_factory_id());

-- Decrement factory stock as a box leaves the freezer; greatest(0,…) respects
-- the on_hand_qty >= 0 check. No-op if that (factory,item) isn't tracked yet.
create or replace function public.decrement_factory_inventory_on_freezer_trace()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update factory_inventory
  set on_hand_qty = greatest(0, on_hand_qty - 1)
  where factory_id = new.factory_id and item_id = new.item_id;
  return new;
end;
$$;

drop trigger if exists freezer_trace_decrement on public.freezer_trace_entries;
create trigger freezer_trace_decrement
after insert on public.freezer_trace_entries
for each row execute function public.decrement_factory_inventory_on_freezer_trace();

-- Deleting a trace refunds the box (mirror of the store box-trace delete refund).
create or replace function public.increment_factory_inventory_on_freezer_trace_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update factory_inventory
  set on_hand_qty = on_hand_qty + 1
  where factory_id = old.factory_id and item_id = old.item_id;
  return old;
end;
$$;

drop trigger if exists freezer_trace_increment_on_delete on public.freezer_trace_entries;
create trigger freezer_trace_increment_on_delete
after delete on public.freezer_trace_entries
for each row execute function public.increment_factory_inventory_on_freezer_trace_delete();

-- Realtime so the log + factory stock refresh as boxes are logged.
alter table public.freezer_trace_entries replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'freezer_trace_entries'
  ) then
    alter publication supabase_realtime add table public.freezer_trace_entries;
  end if;
end
$$;
