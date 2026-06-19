-- Standardize temperature thresholds by unit TYPE instead of per-unit.
--
-- All fridges share one set of targets; all freezers share another. Each
-- store_fridge is classified as 'fridge' or 'freezer', and the fridge_alerts
-- view reads the standard thresholds for that type from temperature_targets
-- (a 2-row global table managers edit in one place). The per-unit
-- target_min_c/target_max_c/severe_deviation_c columns on store_fridges are
-- left in place but no longer used by the view or UI.

-- 1. Classify each unit.
alter table public.store_fridges
  add column if not exists kind text not null default 'fridge'
  check (kind in ('fridge', 'freezer'));

-- 2. Global standard thresholds per type. Seeded blank — managers set them in
--    the Standard Thresholds screen; until set, that type produces no alerts.
create table if not exists public.temperature_targets (
  kind text primary key check (kind in ('fridge', 'freezer')),
  target_min_c numeric(5,2),
  target_max_c numeric(5,2),
  severe_deviation_c numeric(5,2)
    check (severe_deviation_c is null or severe_deviation_c > 0),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.temperature_targets (kind)
  values ('fridge'), ('freezer')
  on conflict (kind) do nothing;

alter table public.temperature_targets enable row level security;

-- Readable by any signed-in user (the log page + the security_invoker view
-- need it); only managers edit.
drop policy if exists "Temp targets: readable by authenticated" on public.temperature_targets;
create policy "Temp targets: readable by authenticated" on public.temperature_targets
  for select using (auth.uid() is not null);

drop policy if exists "Temp targets: store managers manage" on public.temperature_targets;
create policy "Temp targets: store managers manage" on public.temperature_targets
  for all using (public.is_store_manager()) with check (public.is_store_manager());

-- 3. Rewrite fridge_alerts to source thresholds from temperature_targets via
--    the unit's kind. Existing columns keep their name/order/type (required by
--    CREATE OR REPLACE); `kind` is appended at the end.
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
),
agg as (
  select
    f.id                  as fridge_id,
    f.name                as fridge_name,
    f.store_id            as store_id,
    s.name                as store_name,
    tt.target_min_c       as target_min_c,
    tt.target_max_c       as target_max_c,
    tt.severe_deviation_c as severe_deviation_c,
    f.alert_resolved_at   as alert_resolved_at,
    f.alert_resolved_by   as alert_resolved_by,
    f.alert_resolved_note as alert_resolved_note,
    count(ls.fridge_id) as readings_count,
    count(*) filter (
      where (tt.target_min_c is not null and ls.temperature_c < tt.target_min_c)
         or (tt.target_max_c is not null and ls.temperature_c > tt.target_max_c)
    ) as out_of_range_count,
    count(*) filter (
      where tt.severe_deviation_c is not null and (
        (tt.target_min_c is not null and (tt.target_min_c - ls.temperature_c) > tt.severe_deviation_c)
        or (tt.target_max_c is not null and (ls.temperature_c - tt.target_max_c) > tt.severe_deviation_c)
      )
    ) as severe_excursion_count,
    max(ls.recorded_at) as latest_reading_at,
    f.kind as kind
  from public.store_fridges f
  join public.stores s on s.id = f.store_id
  left join public.temperature_targets tt on tt.kind = f.kind
  left join last_seven ls on ls.fridge_id = f.id
  -- Only units whose TYPE has thresholds set are monitored.
  where tt.target_min_c is not null or tt.target_max_c is not null
  group by
    f.id, f.name, f.store_id, s.name,
    tt.target_min_c, tt.target_max_c, tt.severe_deviation_c,
    f.alert_resolved_at, f.alert_resolved_by, f.alert_resolved_note, f.kind
)
select
  fridge_id,
  fridge_name,
  store_id,
  store_name,
  target_min_c,
  target_max_c,
  readings_count,
  out_of_range_count,
  latest_reading_at,
  severe_deviation_c,
  severe_excursion_count,
  alert_resolved_at,
  alert_resolved_by,
  alert_resolved_note,
  (
    (
      out_of_range_count >= 3
      or (severe_deviation_c is not null and severe_excursion_count >= 1)
    )
    and (
      alert_resolved_at is null
      or (latest_reading_at is not null and latest_reading_at > alert_resolved_at)
    )
  ) as is_active_alert,
  kind
from agg;

-- 4. Realtime so the config + log pages refresh when thresholds/kind change.
do $$
begin
  execute 'alter table public.temperature_targets replica identity full';
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'temperature_targets'
  ) then
    execute 'alter publication supabase_realtime add table public.temperature_targets';
  end if;
end
$$;
