-- Employee request log (Store Issue / Request / Complaint / Question / Other).
--
-- Three tables:
--   employee_requests          — one row per submission
--   employee_request_comments  — back-and-forth thread (HQ "Need Info"
--                                exchanges, plus general replies)
--   request_kb_entries         — HQ-curated knowledge-base entries that the
--                                future AI pre-filter will reference
--
-- Visibility rules (enforced via RLS):
--   - HQ admins see and manage everything across all stores.
--   - Store employees can submit and view requests for their own store —
--     EXCEPT category = 'Complaint', which is hidden from employees entirely
--     (they can still file one, they just can't browse the complaints list).
--   - Comments inherit visibility from their parent request.
--
-- Resolution requires a note (CHECK constraint). Complaints require a
-- `complaint_against` value; everything else must leave it null.

create table if not exists employee_requests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  submitted_by_user_id uuid references auth.users(id) on delete set null,
  submitted_by_label text,
  category text not null check (
    category in ('Store Issue', 'Request', 'Complaint', 'Question', 'Other')
  ),
  complaint_against text,
  description text not null check (length(btrim(description)) > 0),
  status text not null default 'open' check (
    status in ('open', 'in_progress', 'need_info', 'resolved', 'dismissed')
  ),
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employee_requests
  drop constraint if exists employee_requests_complaint_against_chk;
alter table public.employee_requests
  add constraint employee_requests_complaint_against_chk
  check (
    (category = 'Complaint' and complaint_against is not null and length(btrim(complaint_against)) > 0)
    or (category <> 'Complaint' and complaint_against is null)
  );

alter table public.employee_requests
  drop constraint if exists employee_requests_resolution_note_chk;
alter table public.employee_requests
  add constraint employee_requests_resolution_note_chk
  check (
    status <> 'resolved'
    or (resolution_note is not null and length(btrim(resolution_note)) > 0)
  );

create index if not exists employee_requests_store_idx
  on employee_requests(store_id, created_at desc);
create index if not exists employee_requests_status_idx
  on employee_requests(status, created_at desc);

create table if not exists employee_request_comments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references employee_requests(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  author_label text,
  author_role text not null check (author_role in ('hq', 'employee')),
  body text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists employee_request_comments_request_idx
  on employee_request_comments(request_id, created_at);

create table if not exists request_kb_entries (
  id uuid primary key default gen_random_uuid(),
  category text not null check (
    category in ('Store Issue', 'Request', 'Complaint', 'Question', 'Other')
  ),
  title text not null check (length(btrim(title)) > 0),
  body text not null check (length(btrim(body)) > 0),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists request_kb_entries_category_idx
  on request_kb_entries(category);

-- Trigger to keep employee_requests.updated_at fresh on comment activity
-- so the HQ list sorts naturally by recent action.
create or replace function public.touch_employee_request() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  update public.employee_requests
    set updated_at = now()
    where id = coalesce(new.request_id, old.request_id);
  return null;
end;
$$;

drop trigger if exists employee_request_comments_touch on public.employee_request_comments;
create trigger employee_request_comments_touch
  after insert or update or delete on public.employee_request_comments
  for each row execute function public.touch_employee_request();

alter table public.employee_requests enable row level security;

drop policy if exists "Requests: HQ can manage" on public.employee_requests;
create policy "Requests: HQ can manage" on public.employee_requests
  for all using (public.is_hq_admin()) with check (public.is_hq_admin());

drop policy if exists "Requests: employees can insert own store" on public.employee_requests;
create policy "Requests: employees can insert own store" on public.employee_requests
  for insert with check (
    public.is_store_manager()
    and store_id = public.current_store_id()
  );

-- Employees see their own store's NON-complaint requests. Complaints stay
-- HQ-only — the policy below intentionally excludes them.
drop policy if exists "Requests: employees can view own store non-complaints" on public.employee_requests;
create policy "Requests: employees can view own store non-complaints" on public.employee_requests
  for select using (
    public.is_store_manager()
    and store_id = public.current_store_id()
    and category <> 'Complaint'
  );

alter table public.employee_request_comments enable row level security;

drop policy if exists "Request comments: HQ can manage" on public.employee_request_comments;
create policy "Request comments: HQ can manage" on public.employee_request_comments
  for all using (public.is_hq_admin()) with check (public.is_hq_admin());

drop policy if exists "Request comments: employees can view own store non-complaints" on public.employee_request_comments;
create policy "Request comments: employees can view own store non-complaints" on public.employee_request_comments
  for select using (
    public.is_store_manager()
    and exists (
      select 1 from public.employee_requests r
      where r.id = employee_request_comments.request_id
        and r.store_id = public.current_store_id()
        and r.category <> 'Complaint'
    )
  );

drop policy if exists "Request comments: employees can insert on own store non-complaints" on public.employee_request_comments;
create policy "Request comments: employees can insert on own store non-complaints" on public.employee_request_comments
  for insert with check (
    public.is_store_manager()
    and author_role = 'employee'
    and exists (
      select 1 from public.employee_requests r
      where r.id = employee_request_comments.request_id
        and r.store_id = public.current_store_id()
        and r.category <> 'Complaint'
    )
  );

alter table public.request_kb_entries enable row level security;
drop policy if exists "KB: HQ can manage" on public.request_kb_entries;
create policy "KB: HQ can manage" on public.request_kb_entries
  for all using (public.is_hq_admin()) with check (public.is_hq_admin());

-- Realtime so HQ dashboards refresh when new submissions/comments arrive
-- and employees see status / Need-Info replies without reloading.
do $$
declare
  t text;
  realtime_tables text[] := array[
    'employee_requests',
    'employee_request_comments',
    'request_kb_entries'
  ];
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
