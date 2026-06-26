-- Fix: marking the LAST store finished in a cycle errored with
-- 'column "name" does not exist', rolling back the finish so that store could
-- never complete its order.
--
-- notify_cycle_complete() fires after cycle_stores.finished_at updates and,
-- once every store is finished, looked up order_cycles.name for the push
-- message. But order_cycles.name was dropped back in
-- 20260506180000_cycle_name_is_date.sql (the cycle is identified by its
-- order_date now). The push_triggers migration was written against the old
-- column, so the lookup only blew up for whichever store happened to finish
-- last (every earlier store short-circuits out before reaching that line).
--
-- Use order_date instead. CREATE OR REPLACE keeps the existing trigger wired
-- to this function — no trigger change needed.
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

  select order_date::text into v_name from public.order_cycles where id = new.cycle_id;
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
