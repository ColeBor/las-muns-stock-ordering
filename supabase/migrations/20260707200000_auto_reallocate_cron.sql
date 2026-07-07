-- Server-auto reallocation, part 2: a pg_cron job that re-runs allocations for
-- any cycle flagged dirty by part 1. Mirrors the waste-photo cleanup cron —
-- Supabase is always on (the Vercel app sleeps when idle), and the HTTP call
-- wakes the serverless run endpoint, which already guards against
-- finalized/delivered cycles. App origin comes from push_config.dispatch_url so
-- there's no hardcoded domain to keep in sync.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.auto_reallocate_http() returns void
  language plpgsql security definer set search_path = public, net as $$
declare
  v_base text;
  v_origin text;
  r record;
begin
  -- Nothing to do unless a cycle is flagged.
  if not exists (
    select 1 from order_cycles where reallocate_requested_at is not null and status = 'allocated'
  ) then
    return;
  end if;

  select dispatch_url into v_base from public.push_config where id = true;
  if v_base is null or v_base = '' then return; end if;
  v_origin := (regexp_match(v_base, '^(https?://[^/]+)'))[1];
  if v_origin is null then return; end if;

  -- Atomically claim each dirty allocated cycle (clear its flag) and dispatch a
  -- re-run. Clearing on claim means overlapping ticks can't double-dispatch the
  -- same dirty episode; a change during a run simply re-flags it for next tick.
  for r in
    with claimed as (
      update public.order_cycles set reallocate_requested_at = null
      where reallocate_requested_at is not null and status = 'allocated'
      returning id
    )
    select id from claimed
  loop
    perform net.http_post(
      url := v_origin || '/api/allocations/run',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('cycle_id', r.id)
    );
  end loop;
end;
$$;

-- (Re)schedule idempotently — unschedule first so re-running doesn't stack jobs.
do $$
begin
  perform cron.unschedule('auto-reallocate');
exception
  when others then null;
end $$;

select cron.schedule(
  'auto-reallocate',
  '* * * * *', -- every minute (UTC); the function no-ops when nothing is dirty
  $cron$select public.auto_reallocate_http();$cron$
);
