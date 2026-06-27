-- Scheduled hard-delete of expired waste photos. Belt-and-suspenders alongside
-- the opportunistic cleanup the waste log page fires on load: the Vercel app
-- sleeps when idle, so we drive it from Supabase (always on) via pg_cron +
-- pg_net. The HTTP call also wakes the serverless function to do the actual
-- storage removal (which can't be done from SQL alone).
--
-- The app origin is derived from push_config.dispatch_url (already set for web
-- push), so there's no hardcoded domain to keep in sync.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.cleanup_waste_photos_http() returns void
  language plpgsql security definer set search_path = public, net
as $$
declare
  v_base text;
  v_origin text;
begin
  select dispatch_url into v_base from public.push_config where id = true;
  if v_base is null or v_base = '' then
    return; -- app URL not configured; the on-load opportunistic cleanup still runs
  end if;
  -- Scheme + host from the configured dispatch URL, then the cleanup route.
  v_origin := (regexp_match(v_base, '^(https?://[^/]+)'))[1];
  if v_origin is null then
    return;
  end if;
  perform net.http_post(
    url := v_origin || '/api/waste-photos/cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

-- (Re)schedule the job idempotently — unschedule first so re-running this
-- migration doesn't stack duplicate jobs.
do $$
begin
  perform cron.unschedule('waste-photos-cleanup');
exception
  when others then null; -- not scheduled yet
end $$;

select cron.schedule(
  'waste-photos-cleanup',
  '0 */6 * * *', -- every 6 hours, on the hour (UTC)
  $cron$select public.cleanup_waste_photos_http();$cron$
);
