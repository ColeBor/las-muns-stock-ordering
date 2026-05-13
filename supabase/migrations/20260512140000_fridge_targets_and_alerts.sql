-- Fridge target temperature ranges + cross-store alerts dashboard support.
--
-- Adds target_min_c / target_max_c columns on store_fridges so HQ can set
-- the acceptable range for each fridge or freezer. Tightens RLS on
-- store_fridges so only HQ admins can create/update/delete fridges (the
-- daily-entry workers, schema-named `store_manager`, retain SELECT so they
-- can pick a fridge when recording, but they no longer manage the fridge
-- list or targets). Creates a `fridge_alerts` view that summarises each
-- fridge's last 7 readings against its targets — drives the HQ alerts
-- dashboard. View runs with security_invoker so RLS on the underlying
-- tables filters per-caller (HQ admin sees all stores, employees only see
-- their own).

alter table public.store_fridges
  add column if not exists target_min_c numeric(5,2),
  add column if not exists target_max_c numeric(5,2);

alter table public.store_fridges
  drop constraint if exists store_fridges_target_range_chk;
alter table public.store_fridges
  add constraint store_fridges_target_range_chk
  check (
    target_min_c is null
    or target_max_c is null
    or target_min_c <= target_max_c
  );

drop policy if exists "Store fridges: store managers can insert own store" on public.store_fridges;
drop policy if exists "Store fridges: store managers can update own store" on public.store_fridges;
drop policy if exists "Store fridges: store managers can delete own store" on public.store_fridges;

-- SELECT policy already covers HQ + employees for their own store; leave it.

create or replace view public.fridge_alerts with (security_invoker = on) as
with ranked as (
  select
    e.fridge_id,
    e.store_id,
    e.temperature_c,
    e.recorded_at,
    row_number() over (
      partition by e.fridge_id
      order by e.recorded_at desc
    ) as rn
  from public.temperature_log_entries e
),
last_seven as (
  select fridge_id, temperature_c, recorded_at
  from ranked
  where rn <= 7
)
select
  f.id           as fridge_id,
  f.name         as fridge_name,
  f.store_id     as store_id,
  s.name         as store_name,
  f.target_min_c as target_min_c,
  f.target_max_c as target_max_c,
  count(ls.fridge_id) as readings_count,
  count(*) filter (
    where (f.target_min_c is not null and ls.temperature_c < f.target_min_c)
       or (f.target_max_c is not null and ls.temperature_c > f.target_max_c)
  ) as out_of_range_count,
  max(ls.recorded_at) as latest_reading_at
from public.store_fridges f
join public.stores s on s.id = f.store_id
left join last_seven ls on ls.fridge_id = f.id
where f.target_min_c is not null or f.target_max_c is not null
group by f.id, f.name, f.store_id, s.name, f.target_min_c, f.target_max_c;
