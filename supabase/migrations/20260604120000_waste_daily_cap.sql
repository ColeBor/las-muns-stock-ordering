-- Daily waste soft-cap + cross-store alerts dashboard.
--
-- HQ wants to be warned when a location's daily waste meets or exceeds a
-- soft cap. The cap is a "global default + per-store override":
--
--   * app_config.default_daily_waste_cap — one number that applies to every
--     store that doesn't set its own. Lives in a singleton config table so
--     future global settings have a home.
--   * stores.daily_waste_cap — optional per-store override. NULL means
--     "use the global default". The effective cap is COALESCE(store, default).
--
-- A breach is evaluated per (store, day) over the last 30 days — the same
-- window the Waste Log shows. Only "real" loss counts toward the cap:
-- deliberate give-aways (Influencer, Sample, Promotion, Owners) are
-- EXCLUDED, mirroring the reason set HQ chose. All other reasons count.
--
-- Resolution mirrors the fridge_alerts pattern: a row in
-- waste_cap_resolutions marks a (store, day) breach as handled, and the
-- view's is_active_alert re-arms automatically if a NEW waste entry lands
-- after the resolution timestamp (see fridge_alert_resolution migration for
-- the same semantics).
--
-- The waste_cap_alerts view runs with security_invoker so RLS on the
-- underlying tables filters per caller — HQ admins (schema role
-- `store_manager`) see every store via their existing all-access policies.

-- ---------------------------------------------------------------------------
-- 1. Global config singleton.
-- ---------------------------------------------------------------------------
-- One-row table guarded by `id boolean primary key default true check (id)`:
-- only `true` is ever a legal id, so there can be at most one row. New global
-- settings get added as additional columns here over time.
create table if not exists public.app_config (
  id boolean primary key default true check (id),
  default_daily_waste_cap integer
    check (default_daily_waste_cap is null or default_daily_waste_cap > 0),
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.app_config (id) values (true) on conflict (id) do nothing;

alter table public.app_config enable row level security;

-- Readable by any signed-in user (the default cap isn't sensitive and the
-- security_invoker view needs to read it for whoever queries the view).
drop policy if exists "App config: readable by authenticated" on public.app_config;
create policy "App config: readable by authenticated" on public.app_config
  for select using (auth.uid() is not null);

-- Only HQ admins (schema role `store_manager`) can change it. No insert /
-- delete policies → the singleton row can't be added to or removed via the API.
drop policy if exists "App config: store managers can update" on public.app_config;
create policy "App config: store managers can update" on public.app_config
  for update using (public.is_store_manager()) with check (public.is_store_manager());

-- ---------------------------------------------------------------------------
-- 2. Per-store override.
-- ---------------------------------------------------------------------------
alter table public.stores
  add column if not exists daily_waste_cap integer;

alter table public.stores
  drop constraint if exists stores_daily_waste_cap_chk;
alter table public.stores
  add constraint stores_daily_waste_cap_chk
  check (daily_waste_cap is null or daily_waste_cap > 0);

-- Existing stores RLS already lets HQ admins update stores, so no new policy
-- is needed for the override column.

-- ---------------------------------------------------------------------------
-- 3. Per-(store, day) resolution log.
-- ---------------------------------------------------------------------------
create table if not exists public.waste_cap_resolutions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  wasted_on date not null,
  resolved_at timestamptz not null default now(),
  resolved_by text,
  note text,
  unique (store_id, wasted_on)
);

create index if not exists waste_cap_resolutions_store_day_idx
  on public.waste_cap_resolutions(store_id, wasted_on);

alter table public.waste_cap_resolutions enable row level security;

-- Resolving a waste-cap breach is an HQ action; employees never touch it.
drop policy if exists "Waste cap resolutions: store managers manage all" on public.waste_cap_resolutions;
create policy "Waste cap resolutions: store managers manage all" on public.waste_cap_resolutions
  for all using (public.is_store_manager()) with check (public.is_store_manager());

-- ---------------------------------------------------------------------------
-- 4. Alerts view.
-- ---------------------------------------------------------------------------
create or replace view public.waste_cap_alerts with (security_invoker = on) as
with counted as (
  select
    w.store_id,
    w.wasted_on,
    sum(w.quantity)::int as counted_qty,
    max(w.created_at)    as last_entry_at
  from public.waste_log_entries w
  -- Exclude deliberate give-aways — only operational loss counts toward the cap.
  where w.reason not in ('Influencer', 'Sample', 'Promotion', 'Owners')
    and w.wasted_on >= current_date - 30
  group by w.store_id, w.wasted_on
)
select
  c.store_id,
  s.name                          as store_name,
  c.wasted_on,
  c.counted_qty,
  s.daily_waste_cap               as store_cap,
  cfg.default_daily_waste_cap     as default_cap,
  coalesce(s.daily_waste_cap, cfg.default_daily_waste_cap) as effective_cap,
  c.last_entry_at,
  r.resolved_at,
  r.resolved_by,
  r.note                          as resolved_note,
  (
    coalesce(s.daily_waste_cap, cfg.default_daily_waste_cap) is not null
    and c.counted_qty >= coalesce(s.daily_waste_cap, cfg.default_daily_waste_cap)
    and (r.resolved_at is null or c.last_entry_at > r.resolved_at)
  ) as is_active_alert
from counted c
join public.stores s on s.id = c.store_id
-- Single-row config; left join keeps the view working even before it's seeded.
left join public.app_config cfg on cfg.id = true
left join public.waste_cap_resolutions r
  on r.store_id = c.store_id and r.wasted_on = c.wasted_on;

-- ---------------------------------------------------------------------------
-- 5. Realtime: broadcast the new tables so dashboard badges live-update.
-- waste_log_entries is already in the publication (see waste_log migration).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  realtime_tables text[] := array['app_config', 'waste_cap_resolutions'];
begin
  foreach t in array realtime_tables loop
    execute format('alter table public.%I replica identity full', t);
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
