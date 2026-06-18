-- Announcements + automated reminders.
--
-- One feed shown to all store staff (employees + managers); only managers
-- (store_manager — the boss) create/edit. Three kinds in one table:
--   * 'manual'  — an ad-hoc post ("big order landing Tuesday"), optionally
--                 bounded by a starts_on..expires_on window.
--   * 'weekly'  — a recurring reminder tied to a day of week ("every Friday =
--                 oven cleaning day"). day_of_week matches JS Date.getDay():
--                 0=Sunday … 6=Saturday.
--   * 'date'    — a one-off reminder on a specific calendar date.
--
-- There is NO scheduler: the feed is evaluated against "today" on the client
-- when it renders, so a weekly/date reminder simply lights up on its day. No
-- push is sent (by product choice) — this is in-app only.
--
-- Targeting mirrors training_resources: all_stores=true is the shortcut for
-- "every store"; otherwise rows in announcement_stores name the targets, and
-- employees see them via is_my_store(). See 20260513150000_training_resources
-- and 20260514150000_multi_store_employee for the same pattern.

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('manual', 'weekly', 'date')),
  title text not null check (length(btrim(title)) > 0),
  body text,
  all_stores boolean not null default true,
  -- manual: optional visibility window (null = no bound on that side).
  starts_on date,
  expires_on date,
  -- weekly: 0=Sunday … 6=Saturday (JS getDay()).
  day_of_week smallint check (day_of_week is null or day_of_week between 0 and 6),
  -- date: the specific calendar day it should appear.
  on_date date,
  is_active boolean not null default true,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Each kind only carries its own scheduling columns.
  constraint announcements_kind_fields_chk check (
    (kind = 'manual' and day_of_week is null and on_date is null)
    or (kind = 'weekly' and day_of_week is not null and on_date is null)
    or (kind = 'date' and on_date is not null and day_of_week is null)
  ),
  constraint announcements_window_chk check (
    starts_on is null or expires_on is null or expires_on >= starts_on
  )
);

create index if not exists announcements_active_idx
  on public.announcements(is_active, kind);

create table if not exists public.announcement_stores (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  primary key (announcement_id, store_id)
);

create index if not exists announcement_stores_store_idx
  on public.announcement_stores(store_id);

alter table public.announcements enable row level security;
alter table public.announcement_stores enable row level security;

-- Managers (the boss) manage everything — this also grants them SELECT on all
-- rows so their own feed + the admin list see every announcement.
drop policy if exists "Announcements: Store Managers can manage" on public.announcements;
create policy "Announcements: Store Managers can manage" on public.announcements
  for all using (public.is_store_manager()) with check (public.is_store_manager());

-- Employees see only ACTIVE announcements that are all-stores or aimed at a
-- store they're assigned to. (Date-window / day-of-week filtering happens on
-- the client; RLS just scopes *which* announcements they may read at all.)
drop policy if exists "Announcements: Employees can view relevant" on public.announcements;
create policy "Announcements: Employees can view relevant" on public.announcements
  for select using (
    public.is_employee()
    and is_active
    and (
      all_stores
      or exists (
        select 1 from public.announcement_stores a
        where a.announcement_id = announcements.id
          and public.is_my_store(a.store_id)
      )
    )
  );

drop policy if exists "Announcement stores: Store Managers can manage" on public.announcement_stores;
create policy "Announcement stores: Store Managers can manage" on public.announcement_stores
  for all using (public.is_store_manager()) with check (public.is_store_manager());

drop policy if exists "Announcement stores: Employees can view own store" on public.announcement_stores;
create policy "Announcement stores: Employees can view own store" on public.announcement_stores
  for select using (public.is_employee() and public.is_my_store(store_id));

-- Keep updated_at fresh on edits.
create or replace function public.touch_announcement() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists announcements_touch on public.announcements;
create trigger announcements_touch
  before update on public.announcements
  for each row execute function public.touch_announcement();

-- Realtime so the feed + admin list refresh without reloading.
do $$
declare
  t text;
  realtime_tables text[] := array['announcements', 'announcement_stores'];
begin
  foreach t in array realtime_tables loop
    execute format('alter table public.%I replica identity full', t);
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
