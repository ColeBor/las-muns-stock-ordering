-- Alert resolution by HQ.
--
-- Adds `alert_resolved_at` / `_by` / `_note` to store_fridges so HQ can mark
-- a flagged fridge as addressed. The fridge_alerts view gains
-- `is_active_alert`: true only when a flag rule fires AND either no
-- resolution exists, or a new reading came in after the resolution
-- timestamp. That mirrors the chosen semantics — resolve hides the row
-- until a fresh bad reading happens, at which point the dashboard
-- auto-flags it again.
--
-- Write access to these columns is already restricted to HQ admins by the
-- existing store_fridges RLS (HQ-only on update). No new policies needed.
--
-- View columns are appended at the end (CREATE OR REPLACE VIEW cannot
-- reorder or rename existing columns — Postgres reads that as renaming).

alter table public.store_fridges
  add column if not exists alert_resolved_at timestamptz,
  add column if not exists alert_resolved_by text,
  add column if not exists alert_resolved_note text;

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
    f.target_min_c        as target_min_c,
    f.target_max_c        as target_max_c,
    f.severe_deviation_c  as severe_deviation_c,
    f.alert_resolved_at   as alert_resolved_at,
    f.alert_resolved_by   as alert_resolved_by,
    f.alert_resolved_note as alert_resolved_note,
    count(ls.fridge_id) as readings_count,
    count(*) filter (
      where (f.target_min_c is not null and ls.temperature_c < f.target_min_c)
         or (f.target_max_c is not null and ls.temperature_c > f.target_max_c)
    ) as out_of_range_count,
    count(*) filter (
      where f.severe_deviation_c is not null and (
        (f.target_min_c is not null and (f.target_min_c - ls.temperature_c) > f.severe_deviation_c)
        or (f.target_max_c is not null and (ls.temperature_c - f.target_max_c) > f.severe_deviation_c)
      )
    ) as severe_excursion_count,
    max(ls.recorded_at) as latest_reading_at
  from public.store_fridges f
  join public.stores s on s.id = f.store_id
  left join last_seven ls on ls.fridge_id = f.id
  where f.target_min_c is not null or f.target_max_c is not null
  group by
    f.id, f.name, f.store_id, s.name,
    f.target_min_c, f.target_max_c, f.severe_deviation_c,
    f.alert_resolved_at, f.alert_resolved_by, f.alert_resolved_note
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
  ) as is_active_alert
from agg;
