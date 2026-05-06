-- Drop the unused is_high_volume label and replace with a tier system.
-- Lower tier = higher priority during manufactured-stock shortages. Stores
-- sharing a tier are equal-priority. Default tier 3 keeps new stores at the
-- bottom of the priority order until the user explicitly promotes them.

alter table public.stores drop column if exists is_high_volume;
alter table public.stores
  add column if not exists tier integer not null default 3
  check (tier >= 1);
