-- Per-resource sort_order so HQ (Store Managers) can re-order training
-- resources independently of upload time. Default is 0 just so the column
-- is non-null; the admin UI assigns sequential values on upload and via
-- up/down swap actions.
--
-- Backfill: existing rows get sort_order = 1..N in created_at order so
-- the initial display order doesn't change visibly.

alter table public.training_resources
  add column if not exists sort_order integer not null default 0;

with ranked as (
  select id, row_number() over (order by created_at, id) as rn
  from public.training_resources
)
update public.training_resources r
set sort_order = ranked.rn
from ranked
where r.id = ranked.id
  and r.sort_order = 0;

create index if not exists training_resources_sort_idx
  on public.training_resources(kind, sort_order);
