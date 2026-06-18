-- Web Push — the event triggers that actually fire notifications.
--
-- DEPENDS ON (must already exist on the DB when this runs):
--   * push_subscriptions / notification_events  (20260618120000)
--   * app_config, stores.daily_waste_cap, waste_cap_resolutions  (20260604120000)
--   * store_fridges target/severe/resolution columns  (20260512140000 / 160000 / 170000)
--   * cycle_stores.finished_at  (20260506160000)
--   * order_cycles, employee_requests
-- `supabase db push` applies pending migrations in order, so a behind remote
-- catches up automatically. Listed here so the dependency is explicit.
--
-- HOW IT WORKS
--   Each AFTER trigger re-evaluates the SAME condition the matching dashboard
--   uses, then claims a unique key in notification_events (insert ... on
--   conflict do nothing). It only POSTs to the dispatcher when it actually
--   claimed the row — so repeat writes for an already-alerting thing don't
--   re-notify. Resolving a waste/fridge alert clears its ledger row so a fresh
--   breach can notify again (mirrors the dashboards' auto-re-arm).
--
-- DISPATCH HOP
--   The helper POSTs via pg_net to /api/push/dispatch. The target URL + shared
--   secret live in the public.push_config singleton table (NOT in database
--   settings — Supabase's SQL-editor role can't ALTER DATABASE). SET THESE ONCE
--   with your real deployed URL and the SAME secret as PUSH_DISPATCH_SECRET in
--   the app env:
--
--     update public.push_config set
--       dispatch_url = 'https://YOUR-APP-DOMAIN/api/push/dispatch',
--       dispatch_secret = 'YOUR-PUSH-DISPATCH-SECRET',
--       updated_at = now()
--     where id = true;
--
--   Until the URL is set, the helper is a safe no-op (the ledger still records
--   the event).

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Dispatch config — a one-row table holding the endpoint URL + shared secret.
-- RLS on with no policies: only the SECURITY DEFINER helper (table owner) and
-- the service role can read it, so the secret never reaches app clients.
-- ---------------------------------------------------------------------------
create table if not exists public.push_config (
  id boolean primary key default true check (id),
  dispatch_url text,
  dispatch_secret text,
  updated_at timestamptz not null default now()
);
insert into public.push_config (id) values (true) on conflict (id) do nothing;
alter table public.push_config enable row level security;

-- ---------------------------------------------------------------------------
-- Shared dispatch helper.
-- ---------------------------------------------------------------------------
create or replace function public._push_dispatch(
  p_kind text, p_event_key text, p_title text, p_body text, p_url text
) returns void
  language plpgsql security definer set search_path = public, net
as $$
declare
  v_url text;
  v_secret text;
begin
  select dispatch_url, dispatch_secret into v_url, v_secret
  from public.push_config where id = true;
  if v_url is null or v_url = '' then
    return;  -- dispatcher not configured yet; event is already in the ledger
  end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', coalesce(v_secret, '')
    ),
    body := jsonb_build_object(
      'kind', p_kind,
      'event_key', p_event_key,
      'title', p_title,
      'body', p_body,
      'url', p_url,
      'tag', p_event_key
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Waste over cap.
-- ---------------------------------------------------------------------------
create or replace function public.notify_waste_breach() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_cap int; v_qty int; v_store text; v_key text;
begin
  select coalesce(s.daily_waste_cap, c.default_daily_waste_cap), s.name
    into v_cap, v_store
  from public.stores s
  left join public.app_config c on c.id = true
  where s.id = new.store_id;

  if v_cap is null then return null; end if;

  -- Countable waste for this store-day — same exclusions as waste_cap_alerts.
  select sum(quantity)::int into v_qty
  from public.waste_log_entries
  where store_id = new.store_id and wasted_on = new.wasted_on
    and reason not in ('Influencer', 'Sample', 'Promotion', 'Owners');

  if v_qty is null or v_qty < v_cap then return null; end if;

  -- Respect an existing resolution that post-dates this entry.
  if exists (
    select 1 from public.waste_cap_resolutions r
    where r.store_id = new.store_id and r.wasted_on = new.wasted_on
      and r.resolved_at >= new.created_at
  ) then
    return null;
  end if;

  v_key := 'waste:' || new.store_id || ':' || new.wasted_on;
  insert into public.notification_events(event_key, kind, payload)
  values (v_key, 'waste', jsonb_build_object('store', v_store, 'qty', v_qty, 'cap', v_cap))
  on conflict (event_key) do nothing;
  if not found then return null; end if;

  perform public._push_dispatch(
    'waste', v_key,
    '⚠ Waste over cap — ' || coalesce(v_store, 'store'),
    coalesce(v_store, 'A store') || ' hit ' || v_qty || '/' || v_cap || ' items today.',
    '/admin/waste-alerts'
  );
  return null;
end $$;

drop trigger if exists waste_breach_notify on public.waste_log_entries;
create trigger waste_breach_notify
  after insert on public.waste_log_entries
  for each row execute function public.notify_waste_breach();

-- Clear the ledger when a breach is resolved, so a later re-breach re-notifies.
create or replace function public.clear_waste_notification() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  delete from public.notification_events
  where event_key = 'waste:' || new.store_id || ':' || new.wasted_on;
  return null;
end $$;

drop trigger if exists waste_resolution_clear on public.waste_cap_resolutions;
create trigger waste_resolution_clear
  after insert or update on public.waste_cap_resolutions
  for each row execute function public.clear_waste_notification();

-- ---------------------------------------------------------------------------
-- 2. Fridge temperature alert.
-- ---------------------------------------------------------------------------
create or replace function public.notify_fridge_alert() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_min numeric; v_max numeric; v_sev numeric; v_resolved timestamptz;
  v_fridge text; v_store text; v_oor int; v_severe int; v_key text;
begin
  select f.target_min_c, f.target_max_c, f.severe_deviation_c,
         f.alert_resolved_at, f.name, s.name
    into v_min, v_max, v_sev, v_resolved, v_fridge, v_store
  from public.store_fridges f
  join public.stores s on s.id = f.store_id
  where f.id = new.fridge_id;

  if v_min is null and v_max is null then return null; end if;

  -- Same window + rules as the fridge_alerts view: last 7 readings, flag on
  -- >= 3 out of range OR >= 1 severe excursion.
  with last7 as (
    select temperature_c
    from public.temperature_log_entries
    where fridge_id = new.fridge_id
    order by recorded_at desc
    limit 7
  )
  select
    count(*) filter (
      where (v_min is not null and temperature_c < v_min)
         or (v_max is not null and temperature_c > v_max)
    ),
    count(*) filter (
      where v_sev is not null and (
        (v_min is not null and (v_min - temperature_c) > v_sev)
        or (v_max is not null and (temperature_c - v_max) > v_sev)
      )
    )
  into v_oor, v_severe
  from last7;

  if not (v_oor >= 3 or (v_sev is not null and v_severe >= 1)) then
    return null;
  end if;

  if v_resolved is not null and new.recorded_at <= v_resolved then
    return null;
  end if;

  v_key := 'fridge:' || new.fridge_id;
  insert into public.notification_events(event_key, kind, payload)
  values (v_key, 'fridge', jsonb_build_object('fridge', v_fridge, 'store', v_store))
  on conflict (event_key) do nothing;
  if not found then return null; end if;

  perform public._push_dispatch(
    'fridge', v_key,
    '🌡 Fridge alert — ' || coalesce(v_store, 'store'),
    coalesce(v_fridge, 'A fridge') || ' is out of range.',
    '/admin/temperature-alerts'
  );
  return null;
end $$;

drop trigger if exists fridge_alert_notify on public.temperature_log_entries;
create trigger fridge_alert_notify
  after insert on public.temperature_log_entries
  for each row execute function public.notify_fridge_alert();

-- Clear the ledger when HQ resolves a fridge, so a fresh excursion re-notifies.
create or replace function public.clear_fridge_notification() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.alert_resolved_at is distinct from old.alert_resolved_at
     and new.alert_resolved_at is not null then
    delete from public.notification_events where event_key = 'fridge:' || new.id;
  end if;
  return null;
end $$;

drop trigger if exists fridge_resolution_clear on public.store_fridges;
create trigger fridge_resolution_clear
  after update on public.store_fridges
  for each row execute function public.clear_fridge_notification();

-- ---------------------------------------------------------------------------
-- 3. New employee request.
-- ---------------------------------------------------------------------------
create or replace function public.notify_employee_request() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_store text; v_key text;
begin
  select name into v_store from public.stores where id = new.store_id;
  v_key := 'request:' || new.id;
  insert into public.notification_events(event_key, kind, payload)
  values (v_key, 'request', jsonb_build_object('store', v_store, 'category', new.category))
  on conflict (event_key) do nothing;
  if not found then return null; end if;

  perform public._push_dispatch(
    'request', v_key,
    '📝 New ' || new.category || ' — ' || coalesce(v_store, 'store'),
    left(new.description, 120),
    '/admin/requests'
  );
  return null;
end $$;

drop trigger if exists employee_request_notify on public.employee_requests;
create trigger employee_request_notify
  after insert on public.employee_requests
  for each row execute function public.notify_employee_request();

-- ---------------------------------------------------------------------------
-- 4. All stores finished the cycle.
-- ---------------------------------------------------------------------------
create or replace function public.notify_cycle_complete() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_name text; v_key text;
begin
  if new.finished_at is null then return null; end if;
  -- Still waiting on any store in this cycle? Then it's not complete.
  if exists (
    select 1 from public.cycle_stores
    where cycle_id = new.cycle_id and finished_at is null
  ) then
    return null;
  end if;

  select name into v_name from public.order_cycles where id = new.cycle_id;
  v_key := 'cycle_done:' || new.cycle_id;
  insert into public.notification_events(event_key, kind, payload)
  values (v_key, 'cycle_done', jsonb_build_object('cycle', v_name))
  on conflict (event_key) do nothing;
  if not found then return null; end if;

  perform public._push_dispatch(
    'cycle_done', v_key,
    '✅ All stores finished ordering',
    coalesce(v_name, 'The current cycle') || ' is ready to allocate.',
    '/admin/cycles'
  );
  return null;
end $$;

drop trigger if exists cycle_complete_notify on public.cycle_stores;
create trigger cycle_complete_notify
  after update of finished_at on public.cycle_stores
  for each row execute function public.notify_cycle_complete();
