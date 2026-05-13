-- Multi-cycle box-trace auto-decrement workflow.
--
-- Invariant: a store can be in at most one non-delivered cycle. Workers no
-- longer manually count box-traced items end-of-week — each box trace
-- decrements stock_entries.current_count for that store's open cycle. For
-- the first cycle a store joins under this model, the pre-populated count
-- starts at 0 and the store does a one-time calibration; subsequent
-- cycles auto-fill at "previous delivered cycle's current_count +
-- allocated_qty" (post-delivery on-hand).

-- ─── 1. One-open-cycle-per-store invariant ──────────────────────────────────
create or replace function public.check_one_open_cycle_per_store()
returns trigger
language plpgsql
as $$
declare
  store_name text;
  conflicting_date date;
begin
  select s.name, c.order_date into store_name, conflicting_date
  from cycle_stores cs
  join order_cycles c on c.id = cs.cycle_id
  join stores s on s.id = cs.store_id
  where cs.store_id = new.store_id
    and cs.cycle_id <> new.cycle_id
    and c.status <> 'delivered'
  limit 1;
  if found then
    raise exception
      'Store "%" is already in another open cycle (order date: %). Finalize that cycle or remove the store from it first.',
      store_name, conflicting_date
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists cycle_stores_one_open_per_store on public.cycle_stores;
create trigger cycle_stores_one_open_per_store
before insert on public.cycle_stores
for each row execute function public.check_one_open_cycle_per_store();

-- ─── 2. Pre-populate stock_entries when a store joins a cycle ───────────────
create or replace function public.prepopulate_stock_entries_on_cycle_join()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into stock_entries (cycle_id, store_id, item_id, current_count, entered_by)
  select
    new.cycle_id,
    new.store_id,
    si.item_id,
    coalesce(
      (
        select se.current_count + coalesce(a.qty, 0)
        from stock_entries se
        join order_cycles c on c.id = se.cycle_id
        left join allocations a
          on a.cycle_id = se.cycle_id
         and a.store_id = se.store_id
         and a.item_id = se.item_id
        where se.store_id = new.store_id
          and se.item_id = si.item_id
          and c.status = 'delivered'
        order by c.order_date desc nulls last, c.created_at desc
        limit 1
      ),
      0
    ),
    'system-prepopulate'
  from store_items si
  where si.store_id = new.store_id
    and si.is_active = true
  on conflict (cycle_id, store_id, item_id) do nothing;
  return new;
end;
$$;

drop trigger if exists cycle_stores_prepopulate_stock_entries on public.cycle_stores;
create trigger cycle_stores_prepopulate_stock_entries
after insert on public.cycle_stores
for each row execute function public.prepopulate_stock_entries_on_cycle_join();

-- ─── 3. Box trace auto-decrement ────────────────────────────────────────────
-- cycle_id captures WHICH cycle this trace decremented, so deletes know
-- which cycle to refund. ON DELETE SET NULL so deleting a cycle leaves the
-- trace history intact (just unlinked).
alter table public.box_trace_entries
  add column if not exists cycle_id uuid references public.order_cycles(id) on delete set null;

create or replace function public.set_box_trace_cycle_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  open_cycle_id uuid;
begin
  if new.cycle_id is null then
    select c.id into open_cycle_id
    from cycle_stores cs
    join order_cycles c on c.id = cs.cycle_id
    where cs.store_id = new.store_id
      and c.status <> 'delivered'
    limit 1;
    new.cycle_id := open_cycle_id;
  end if;
  return new;
end;
$$;

drop trigger if exists box_trace_set_cycle_id on public.box_trace_entries;
create trigger box_trace_set_cycle_id
before insert on public.box_trace_entries
for each row execute function public.set_box_trace_cycle_id();

create or replace function public.decrement_stock_entry_on_box_trace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.cycle_id is null then return new; end if;
  update stock_entries
  set current_count = greatest(0, current_count - 1)
  where cycle_id = new.cycle_id
    and store_id = new.store_id
    and item_id = new.item_id;
  return new;
end;
$$;

drop trigger if exists box_trace_decrement_stock_entry on public.box_trace_entries;
create trigger box_trace_decrement_stock_entry
after insert on public.box_trace_entries
for each row execute function public.decrement_stock_entry_on_box_trace();

create or replace function public.increment_stock_entry_on_box_trace_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.cycle_id is null then return old; end if;
  update stock_entries
  set current_count = current_count + 1
  where cycle_id = old.cycle_id
    and store_id = old.store_id
    and item_id = old.item_id;
  return old;
end;
$$;

drop trigger if exists box_trace_increment_stock_entry_on_delete on public.box_trace_entries;
create trigger box_trace_increment_stock_entry_on_delete
after delete on public.box_trace_entries
for each row execute function public.increment_stock_entry_on_box_trace_delete();
