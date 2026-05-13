-- Severe single-reading spike alerts.
--
-- Adds `severe_deviation_c` per fridge: a magnitude beyond the target range
-- that, if exceeded by any single reading in the last 7 readings, flags the
-- fridge as a "spike" (vs. the existing 3-of-7 "drift" flag). This catches
-- one-off severe excursions like a door left open or a unit failing, where
-- the existing consistency rule would otherwise wait for repeat readings.
--
-- The fridge_alerts view gains `severe_excursion_count` so the dashboard
-- and UI can render the two flag types side-by-side.

alter table public.store_fridges
  add column if not exists severe_deviation_c numeric(5,2);

alter table public.store_fridges
  drop constraint if exists store_fridges_severe_deviation_chk;
alter table public.store_fridges
  add constraint store_fridges_severe_deviation_chk
  check (severe_deviation_c is null or severe_deviation_c > 0);

-- CREATE OR REPLACE VIEW can only APPEND columns, never insert them in the
-- middle (Postgres reads it as renaming). The new columns from this
-- migration (`severe_deviation_c`, `severe_excursion_count`) therefore go at
-- the end of the SELECT list, preserving every existing column position.
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
  f.id               as fridge_id,
  f.name             as fridge_name,
  f.store_id         as store_id,
  s.name             as store_name,
  f.target_min_c     as target_min_c,
  f.target_max_c     as target_max_c,
  count(ls.fridge_id) as readings_count,
  count(*) filter (
    where (f.target_min_c is not null and ls.temperature_c < f.target_min_c)
       or (f.target_max_c is not null and ls.temperature_c > f.target_max_c)
  ) as out_of_range_count,
  max(ls.recorded_at) as latest_reading_at,
  f.severe_deviation_c as severe_deviation_c,
  count(*) filter (
    where f.severe_deviation_c is not null and (
      (f.target_min_c is not null and (f.target_min_c - ls.temperature_c) > f.severe_deviation_c)
      or (f.target_max_c is not null and (ls.temperature_c - f.target_max_c) > f.severe_deviation_c)
    )
  ) as severe_excursion_count
from public.store_fridges f
join public.stores s on s.id = f.store_id
left join last_seven ls on ls.fridge_id = f.id
where f.target_min_c is not null or f.target_max_c is not null
group by f.id, f.name, f.store_id, s.name, f.target_min_c, f.target_max_c, f.severe_deviation_c;
