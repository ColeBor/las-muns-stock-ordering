-- Bake-count feedback loop --------------------------------------------------
-- Two signals drive manager recommendations to adjust bake_expected_sales:
--   * OVER-baking: waste logged as "Over 3 Days Old". Those empanadas were
--     baked ~3 days before they're logged, so we attribute each to the bake
--     day = wasted_on - 3 and recommend LOWERING that weekday's count.
--   * UNDER-baking: the closing shift ticks "had to bake extra today" per
--     flavour (no amounts) → bake_more_signals. A repeat pattern recommends
--     RAISING that weekday's count.
-- A pattern must repeat >= 2 times in the last 4 weeks for a store/flavour/
-- weekday to surface.

create table if not exists public.bake_more_signals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  signal_date date not null,
  recorded_by text,
  created_at timestamptz not null default now(),
  unique (store_id, item_id, signal_date)
);

alter table public.bake_more_signals enable row level security;

drop policy if exists "bake_more: store staff manage" on public.bake_more_signals;
create policy "bake_more: store staff manage" on public.bake_more_signals
  for all
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)))
  with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

alter table public.bake_more_signals replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bake_more_signals'
  ) then
    alter publication supabase_realtime add table public.bake_more_signals;
  end if;
end $$;

-- Recommendation view: one row per (store, item, weekday) that needs attention,
-- with a direction. day_of_week matches JS getDay() / the DAYS table (0=Sun).
create or replace view public.bake_count_recommendations
with (security_invoker = true) as
with over_bakes as (
  select
    w.store_id,
    w.item_id,
    extract(dow from (w.wasted_on - 3))::int as day_of_week,
    count(distinct (w.wasted_on - 3)) as occurrences
  from public.waste_log_entries w
  join public.items i on i.id = w.item_id
  where w.reason = 'Over 3 Days Old'
    and w.wasted_on >= (current_date - 28)
    and i.sub_category = 'Empanada'
  group by 1, 2, 3
),
under_bakes as (
  select
    s.store_id,
    s.item_id,
    extract(dow from s.signal_date)::int as day_of_week,
    count(distinct s.signal_date) as occurrences
  from public.bake_more_signals s
  where s.signal_date >= (current_date - 28)
  group by 1, 2, 3
)
select store_id, item_id, day_of_week, 'lower'::text as direction, occurrences
from over_bakes
where occurrences >= 2
union all
select store_id, item_id, day_of_week, 'raise'::text as direction, occurrences
from under_bakes
where occurrences >= 2;

grant select on public.bake_count_recommendations to authenticated;
