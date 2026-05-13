-- Role terminology rename.
--
-- The original schema named the three roles `hq_admin`, `store_manager`,
-- and `factory_user`. That's been a constant source of confusion — the
-- user's vocabulary treats the BOSS as "Store Manager", not the front-line
-- worker, while the schema used `store_manager` for the worker. This
-- migration realigns the database to match the user's vocabulary:
--
--   Old schema → New schema (== user's vocabulary)
--   hq_admin    → store_manager   ("the boss")
--   store_manager → employee      ("front-line store worker")
--   factory_user → factory_worker ("front-line factory worker")
--
-- Enum value renames happen in dependency order so the intermediate state
-- has no collisions. Helper-function BODIES are updated to reference the
-- new enum literals (their original literals would dangle otherwise), and
-- then the helper-function NAMES are renamed to match the new semantics.
-- RLS policies reference helper functions by OID, so renaming the function
-- doesn't break them — they continue to call the same underlying function.
--
-- Policy names with "store managers" / "HQ" in them are also renamed for
-- readability. Old names that referenced "store_manager" pointed at what
-- we now call employees; "HQ" pointed at what we now call store managers.

begin;

-- 1. Rename enum values. Order matters: free up `store_manager` for reuse
-- before renaming hq_admin onto it.
alter type user_role rename value 'store_manager' to 'employee';
alter type user_role rename value 'hq_admin'      to 'store_manager';
alter type user_role rename value 'factory_user'  to 'factory_worker';

-- 2. Update helper function BODIES to use the new enum literals. After the
-- enum rename above, the old literals no longer exist, so these functions
-- would fail to execute until updated. Function names stay temporarily so
-- the RLS policies remain valid through the transaction.
create or replace function public.is_hq_admin() returns boolean
  language sql stable security definer set search_path = public
as $$
  -- "is_hq_admin" semantically meant "boss". Boss is now `store_manager`.
  select exists (
    select 1 from public.profiles
    where id = auth.uid()::uuid and role = 'store_manager'
  );
$$;

create or replace function public.is_store_manager() returns boolean
  language sql stable security definer set search_path = public
as $$
  -- "is_store_manager" semantically meant "worker". Worker is now `employee`.
  select exists (
    select 1 from public.profiles
    where id = auth.uid()::uuid and role = 'employee'
  );
$$;

create or replace function public.is_factory_user() returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()::uuid and role = 'factory_worker'
  );
$$;

-- 3. Rename the functions themselves to match the new semantics. Postgres
-- stores RLS policy references by function OID, so renames transparently
-- carry through to the policies (policy execution still resolves the
-- same function, just under its new name).
--
-- Order matters: free up the `is_store_manager` name (currently the
-- worker check) before reusing it for the boss check.
alter function public.is_store_manager() rename to is_employee;
alter function public.is_hq_admin()      rename to is_store_manager;
alter function public.is_factory_user()  rename to is_factory_worker;

-- 4. Rename RLS policies that hard-coded "store managers" or "HQ" into
-- their names. Behaviour is unchanged — these are display-only renames so
-- future readers aren't confused by the old terminology.
-- Profiles
alter policy "Profiles: HQ can select all profiles"  on public.profiles rename to "Profiles: Store Managers can select all profiles";
alter policy "Profiles: HQ can insert profiles"      on public.profiles rename to "Profiles: Store Managers can insert profiles";
alter policy "Profiles: HQ can update profiles"      on public.profiles rename to "Profiles: Store Managers can update profiles";

-- Generic "HQ can manage" pattern across most tables.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname like '%HQ can manage%'
  loop
    execute format(
      'alter policy %I on %I.%I rename to %I',
      r.policyname, r.schemaname, r.tablename,
      replace(r.policyname, 'HQ can manage', 'Store Managers can manage')
    );
  end loop;
end;
$$;

-- "store managers can …" → "employees can …" pattern.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname like '%store managers can%'
  loop
    execute format(
      'alter policy %I on %I.%I rename to %I',
      r.policyname, r.schemaname, r.tablename,
      replace(r.policyname, 'store managers can', 'employees can')
    );
  end loop;
end;
$$;

-- Factory-users wording.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname like '%factory users can%'
  loop
    execute format(
      'alter policy %I on %I.%I rename to %I',
      r.policyname, r.schemaname, r.tablename,
      replace(r.policyname, 'factory users can', 'factory workers can')
    );
  end loop;
end;
$$;

-- 5. The profiles.role default used to be 'store_manager' (worker). Under
-- the new vocabulary the safest default for fresh sign-ups is 'employee'.
-- Postgres normally rewrites the default expression when the enum value is
-- renamed, but be explicit so a fresh sign-up never gets unintended
-- Store-Manager (boss) privileges.
alter table public.profiles
  alter column role set default 'employee'::user_role;

commit;
