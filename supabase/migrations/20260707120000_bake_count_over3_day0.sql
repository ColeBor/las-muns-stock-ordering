-- Fix the "Over 3 Days Old" bake-day attribution to treat the BAKE DAY as day 0.
--
-- An empanada is "over 3 days old" only once it is >= 4 calendar days past
-- baking: day 0 = baked, days 1-3 are still sellable, day 4 is the first day it
-- is over 3 days old and gets wasted. So a unit logged as "Over 3 Days Old" on
-- wasted_on was baked on wasted_on - 4, NOT wasted_on - 3. (Matches the Friday
-- Waste rule: baked Thursday -> 4 days old by Monday.)
--
-- Net effect: the weekday we recommend LOWERING shifts back by one day. The
-- under-bake side (bake_more_signals) already records on the bake day itself
-- (day 0), so it is unchanged.
create or replace view public.bake_count_recommendations
with (security_invoker = true) as
with over_bakes as (
  select
    w.store_id,
    w.item_id,
    extract(dow from (w.wasted_on - 4))::int as day_of_week,
    count(distinct (w.wasted_on - 4)) as occurrences
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
