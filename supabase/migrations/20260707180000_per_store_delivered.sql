-- Per-store delivery. A truck visits stores one at a time, so "delivered" moves
-- from a cycle-level flag to a per-(cycle,store) signal: cycle_stores.delivered_at.
-- A store can roll into its next cycle the moment ITS delivery lands, and the
-- cycle as a whole flips to 'delivered' once every store is done.
--
-- The perpetual-inventory triggers (carry-forward + one-open-cycle invariant +
-- box-trace cycle resolution) all previously keyed on the CYCLE being
-- 'delivered'. They now key on the store's own delivered_at.

alter table public.cycle_stores add column if not exists delivered_at timestamptz;

-- BACKFILL (critical): existing delivered cycles have no delivered_at yet, so
-- without this the carry-forward would find no prior delivery and reset stores'
-- opening counts to 0. Stamp already-delivered cycles with the cycle's
-- created_at as a proxy for when it shipped.
update public.cycle_stores cs
set delivered_at = c.created_at
from public.order_cycles c
where c.id = cs.cycle_id and c.status = 'delivered' and cs.delivered_at is null;

-- ─── 1. One-open-cycle-per-store: "open" is now delivered_at IS NULL ─────────
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
    and cs.delivered_at is null
  limit 1;
  if found then
    raise exception
      'Store "%" is already in another open cycle (order date: %). Deliver that cycle or remove the store from it first.',
      store_name, conflicting_date
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

-- ─── 2. Carry-forward: from the store's last per-store delivered cycle ───────
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
        join cycle_stores cs
          on cs.cycle_id = se.cycle_id and cs.store_id = se.store_id
        left join allocations a
          on a.cycle_id = se.cycle_id
         and a.store_id = se.store_id
         and a.item_id = se.item_id
        where se.store_id = new.store_id
          and se.item_id = si.item_id
          and cs.delivered_at is not null
        order by cs.delivered_at desc
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

-- ─── 3. Box trace resolves the store's OPEN cycle (delivered_at IS NULL) ─────
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
    select cs.cycle_id into open_cycle_id
    from cycle_stores cs
    where cs.store_id = new.store_id
      and cs.delivered_at is null
    limit 1;
    new.cycle_id := open_cycle_id;
  end if;
  return new;
end;
$$;

-- ─── 4. Flip the cycle to 'delivered' once every store is delivered ─────────
create or replace function public.mark_cycle_delivered_when_all_stores_done()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivered_at is not null and not exists (
    select 1 from cycle_stores
    where cycle_id = new.cycle_id and delivered_at is null
  ) then
    update order_cycles
    set status = 'delivered'
    where id = new.cycle_id and status <> 'delivered';
  end if;
  return new;
end;
$$;

drop trigger if exists cycle_stores_mark_cycle_delivered on public.cycle_stores;
create trigger cycle_stores_mark_cycle_delivered
after update of delivered_at on public.cycle_stores
for each row execute function public.mark_cycle_delivered_when_all_stores_done();
