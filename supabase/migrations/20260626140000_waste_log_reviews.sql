-- Waste photo reviews. The store owner (store_manager) reviews a waste entry's
-- photo from the manager side of the waste log and leaves a short note like
-- "This is still acceptable to sell". The note:
--   1. shows on the waste log next to the entry (both sides), and
--   2. is pushed to the store as a resolved "Waste Review" item in their
--      Requests & Issues tab ("A Manager has replied to your waste picture").
--
-- "store_manager" = the boss; "employee" = front-line worker (own store via
-- is_my_store). Reviews are written by the boss only, read by the store.

create table if not exists public.waste_log_reviews (
  waste_log_id uuid primary key references public.waste_log_entries(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  note text not null check (length(btrim(note)) > 0),
  reviewed_by text,
  reviewed_at timestamptz not null default now()
);

create index if not exists waste_log_reviews_store_idx on public.waste_log_reviews(store_id);

alter table public.waste_log_reviews enable row level security;

-- Store (and boss) can read the review.
drop policy if exists "Waste reviews: read own store" on public.waste_log_reviews;
create policy "Waste reviews: read own store" on public.waste_log_reviews
  for select
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- Only the boss writes reviews.
drop policy if exists "Waste reviews: managers write" on public.waste_log_reviews;
create policy "Waste reviews: managers write" on public.waste_log_reviews
  for all
  using (public.is_store_manager())
  with check (public.is_store_manager());

-- Realtime so the store sees the review land without a refresh (guarded).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'waste_log_reviews'
  ) then
    alter publication supabase_realtime add table public.waste_log_reviews;
  end if;
end $$;

-- Allow a "Waste Review" category on employee_requests so the manager's reply
-- can surface in the store's existing Requests & Issues tab (resolved, with the
-- note in the resolution box). The inline check from the original migration is
-- auto-named employee_requests_category_check.
alter table public.employee_requests
  drop constraint if exists employee_requests_category_check;
alter table public.employee_requests
  add constraint employee_requests_category_check
  check (category in ('Store Issue', 'Request', 'Complaint', 'Question', 'Other', 'Waste Review'));

-- These rows are manager-authored notifications TO the store, so they must not
-- fire the "new employee request" push that alerts managers. Skip that category.
create or replace function public.notify_employee_request() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_store text; v_key text;
begin
  if new.category = 'Waste Review' then
    return null; -- store-facing review reply, not a manager alert
  end if;

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
