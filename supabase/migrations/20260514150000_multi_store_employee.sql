-- Multi-store employee assignment. profile_stores is the source of truth
-- for which stores a worker can access. profiles.store_id stays as their
-- "currently selected" store and is what UI queries scope on; the new
-- is_my_store() helper enforces access in RLS independent of which
-- store they happen to have picked at the moment.

-- 1. Join table -------------------------------------------------------------
create table if not exists public.profile_stores (
  user_id uuid not null references public.profiles(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (user_id, store_id)
);

-- Backfill from existing single-store assignments so nobody loses access.
insert into public.profile_stores (user_id, store_id)
select id, store_id from public.profiles where store_id is not null
on conflict (user_id, store_id) do nothing;

alter table public.profile_stores enable row level security;

drop policy if exists "Profile stores: Store Managers can manage" on public.profile_stores;
create policy "Profile stores: Store Managers can manage"
  on public.profile_stores for all
  using (public.is_store_manager()) with check (public.is_store_manager());

drop policy if exists "Profile stores: users can read own" on public.profile_stores;
create policy "Profile stores: users can read own"
  on public.profile_stores for select
  using (user_id = auth.uid()::uuid);

-- 2. Access helper ---------------------------------------------------------
create or replace function public.is_my_store(check_store_id uuid) returns boolean
  language sql stable security definer set search_path = public
as $$
  select check_store_id is not null and exists (
    select 1 from public.profile_stores
    where user_id = auth.uid()::uuid and store_id = check_store_id
  );
$$;

-- 3. Allow workers to update their own profile (to switch active store).
drop policy if exists "Profiles: users can update own profile" on public.profiles;
create policy "Profiles: users can update own profile"
  on public.profiles for update
  using (id = auth.uid()::uuid)
  with check (id = auth.uid()::uuid);

create or replace function public.profiles_self_update_guard() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if public.is_store_manager() then return new; end if;
  if new.id <> auth.uid()::uuid then
    raise exception 'Cannot modify another user''s profile';
  end if;
  if new.email is distinct from old.email then
    raise exception 'Cannot change your own email';
  end if;
  if new.role is distinct from old.role then
    raise exception 'Cannot change your own role';
  end if;
  if new.factory_id is distinct from old.factory_id then
    raise exception 'Cannot change your own factory assignment';
  end if;
  if new.store_id is distinct from old.store_id
     and new.store_id is not null
     and not public.is_my_store(new.store_id) then
    raise exception 'Selected store is not assigned to you';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_self_update_guard on public.profiles;
create trigger profiles_self_update_guard
  before update on public.profiles
  for each row execute function public.profiles_self_update_guard();

-- 4. Rewrite every store-scoped RLS policy to use is_my_store(store_id).
-- DROP IF EXISTS on both possible names (legacy "store managers" and the
-- post-rename "employees") + CREATE makes this idempotent regardless of
-- which state the live DB is currently in.

-- store_items
drop policy if exists "Store items: employees can view own store" on public.store_items;
drop policy if exists "Store items: store managers can view own store" on public.store_items;
create policy "Store items: employees can view own store" on public.store_items
  for select using (public.is_employee() and public.is_my_store(store_id));

-- store_factories
drop policy if exists "Store factories: employees can view own store" on public.store_factories;
drop policy if exists "Store factories: store managers can view own store" on public.store_factories;
create policy "Store factories: employees can view own store" on public.store_factories
  for select using (public.is_employee() and public.is_my_store(store_id));

-- cycle_stores (two policies)
drop policy if exists "Cycle stores: employees can view own store" on public.cycle_stores;
drop policy if exists "Cycle stores: store managers can view own store" on public.cycle_stores;
create policy "Cycle stores: employees can view own store" on public.cycle_stores
  for select using (public.is_employee() and public.is_my_store(store_id));

drop policy if exists "Cycle stores: employees can mark own store finished" on public.cycle_stores;
create policy "Cycle stores: employees can mark own store finished" on public.cycle_stores
  for update
  using (public.is_employee() and public.is_my_store(store_id))
  with check (public.is_employee() and public.is_my_store(store_id));

-- stock_entries (two policies)
drop policy if exists "Stock entries: employees can manage own store" on public.stock_entries;
drop policy if exists "Stock entries: store managers can manage own store" on public.stock_entries;
create policy "Stock entries: employees can manage own store" on public.stock_entries
  for all
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)))
  with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

drop policy if exists "Stock entries: employees can view own store" on public.stock_entries;
drop policy if exists "Stock entries: store managers can view own store" on public.stock_entries;
create policy "Stock entries: employees can view own store" on public.stock_entries
  for select
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- allocations
drop policy if exists "Allocations: employees can view own store" on public.allocations;
drop policy if exists "Allocations: store managers can view own store" on public.allocations;
create policy "Allocations: employees can view own store" on public.allocations
  for select using (public.is_employee() and public.is_my_store(store_id));

-- allocation_overrides
drop policy if exists "Allocation overrides: employees can view own store" on public.allocation_overrides;
drop policy if exists "Allocation overrides: store managers can view own store" on public.allocation_overrides;
create policy "Allocation overrides: employees can view own store" on public.allocation_overrides
  for select using (public.is_employee() and public.is_my_store(store_id));

-- allocation_factories
drop policy if exists "Allocation factories: employees can view own store" on public.allocation_factories;
drop policy if exists "Allocation factories: store managers can view own store" on public.allocation_factories;
create policy "Allocation factories: employees can view own store" on public.allocation_factories
  for select using (public.is_employee() and public.is_my_store(store_id));

-- store_fridges (4 policies)
drop policy if exists "Store fridges: employees can view own store" on public.store_fridges;
drop policy if exists "Store fridges: store managers can view own store" on public.store_fridges;
create policy "Store fridges: employees can view own store" on public.store_fridges
  for select using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

drop policy if exists "Store fridges: employees can insert own store" on public.store_fridges;
drop policy if exists "Store fridges: store managers can insert own store" on public.store_fridges;
create policy "Store fridges: employees can insert own store" on public.store_fridges
  for insert with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

drop policy if exists "Store fridges: employees can update own store" on public.store_fridges;
drop policy if exists "Store fridges: store managers can update own store" on public.store_fridges;
create policy "Store fridges: employees can update own store" on public.store_fridges
  for update
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)))
  with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

drop policy if exists "Store fridges: employees can delete own store" on public.store_fridges;
drop policy if exists "Store fridges: store managers can delete own store" on public.store_fridges;
create policy "Store fridges: employees can delete own store" on public.store_fridges
  for delete using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- temperature_log_entries
drop policy if exists "Temperature log: employees can manage own store" on public.temperature_log_entries;
drop policy if exists "Temperature log: store managers can manage own store" on public.temperature_log_entries;
create policy "Temperature log: employees can manage own store" on public.temperature_log_entries
  for all
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)))
  with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- waste_log_entries
drop policy if exists "Waste log: employees can manage own store" on public.waste_log_entries;
drop policy if exists "Waste log: store managers can manage own store" on public.waste_log_entries;
create policy "Waste log: employees can manage own store" on public.waste_log_entries
  for all
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)))
  with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- box_trace_entries
drop policy if exists "Box trace: employees can manage own store" on public.box_trace_entries;
drop policy if exists "Box trace: store managers can manage own store" on public.box_trace_entries;
create policy "Box trace: employees can manage own store" on public.box_trace_entries
  for all
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)))
  with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- bake_expected_sales
drop policy if exists "Bake expected: employees can view own store" on public.bake_expected_sales;
drop policy if exists "Bake expected: store managers can view own store" on public.bake_expected_sales;
create policy "Bake expected: employees can view own store" on public.bake_expected_sales
  for select using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- bake_sheets
drop policy if exists "Bake sheets: employees can manage own store" on public.bake_sheets;
drop policy if exists "Bake sheets: store managers can manage own store" on public.bake_sheets;
create policy "Bake sheets: employees can manage own store" on public.bake_sheets
  for all
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)))
  with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- bake_sheet_lines
drop policy if exists "Bake sheet lines: follow parent sheet" on public.bake_sheet_lines;
create policy "Bake sheet lines: follow parent sheet" on public.bake_sheet_lines
  for all
  using (
    public.is_store_manager()
    or exists (
      select 1 from public.bake_sheets s
      where s.id = bake_sheet_lines.bake_sheet_id
        and public.is_employee()
        and public.is_my_store(s.store_id)
    )
  )
  with check (
    public.is_store_manager()
    or exists (
      select 1 from public.bake_sheets s
      where s.id = bake_sheet_lines.bake_sheet_id
        and public.is_employee()
        and public.is_my_store(s.store_id)
    )
  );

-- employee_requests (two policies)
drop policy if exists "Requests: employees can insert own store" on public.employee_requests;
create policy "Requests: employees can insert own store" on public.employee_requests
  for insert with check (public.is_employee() and public.is_my_store(store_id));

drop policy if exists "Requests: employees can view own store non-complaints" on public.employee_requests;
create policy "Requests: employees can view own store non-complaints" on public.employee_requests
  for select using (public.is_employee() and public.is_my_store(store_id) and category <> 'Complaint');

-- employee_request_comments (two policies)
drop policy if exists "Request comments: employees can view own store non-complaints" on public.employee_request_comments;
create policy "Request comments: employees can view own store non-complaints" on public.employee_request_comments
  for select using (
    public.is_employee()
    and exists (
      select 1 from public.employee_requests r
      where r.id = employee_request_comments.request_id
        and public.is_my_store(r.store_id)
        and r.category <> 'Complaint'
    )
  );

drop policy if exists "Request comments: employees can insert on own store non-complaints" on public.employee_request_comments;
create policy "Request comments: employees can insert on own store non-complaints" on public.employee_request_comments
  for insert with check (
    public.is_employee()
    and author_role = 'employee'
    and exists (
      select 1 from public.employee_requests r
      where r.id = employee_request_comments.request_id
        and public.is_my_store(r.store_id)
        and r.category <> 'Complaint'
    )
  );

-- training_resources
drop policy if exists "Training: Employees can view assigned resources" on public.training_resources;
create policy "Training: Employees can view assigned resources" on public.training_resources
  for select using (
    public.is_employee()
    and exists (
      select 1 from public.training_resource_stores trs
      where trs.resource_id = training_resources.id
        and public.is_my_store(trs.store_id)
    )
  );

-- training_resource_stores
drop policy if exists "Training assignments: Employees can view own store" on public.training_resource_stores;
create policy "Training assignments: Employees can view own store" on public.training_resource_stores
  for select using (public.is_employee() and public.is_my_store(store_id));
