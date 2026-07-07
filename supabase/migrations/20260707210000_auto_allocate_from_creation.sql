-- Allocations auto-begin at cycle creation. Previously the first allocation was
-- a manual "Run" once all stores finished. Now the auto-reallocator also picks
-- up freshly-created 'draft' cycles, so the delivery plan is live from the
-- moment stores are attached (Preview/Delivery always have numbers). The first
-- run flips draft → allocated; the human's only checkpoint is Finalize, which
-- now enforces "all stores finished" itself.

-- Flag a cycle for its first allocation as soon as a store is attached to it.
create or replace function public.flag_reallocation_on_cycle_store_join()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update order_cycles set reallocate_requested_at = now()
  where id = new.cycle_id and status in ('draft', 'allocated');
  return null;
end;
$$;

drop trigger if exists cycle_stores_flag_reallocation on public.cycle_stores;
create trigger cycle_stores_flag_reallocation
after insert on public.cycle_stores
for each row execute function public.flag_reallocation_on_cycle_store_join();

-- Redefine the cron worker to also claim 'draft' cycles (the /run endpoint
-- flips them to 'allocated'). The 'auto-reallocate' schedule from the previous
-- migration calls this by name, so no re-scheduling is needed.
create or replace function public.auto_reallocate_http() returns void
  language plpgsql security definer set search_path = public, net as $$
declare
  v_base text;
  v_origin text;
  r record;
begin
  if not exists (
    select 1 from order_cycles
    where reallocate_requested_at is not null and status in ('draft', 'allocated')
  ) then
    return;
  end if;

  select dispatch_url into v_base from public.push_config where id = true;
  if v_base is null or v_base = '' then return; end if;
  v_origin := (regexp_match(v_base, '^(https?://[^/]+)'))[1];
  if v_origin is null then return; end if;

  for r in
    with claimed as (
      update public.order_cycles set reallocate_requested_at = null
      where reallocate_requested_at is not null and status in ('draft', 'allocated')
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
