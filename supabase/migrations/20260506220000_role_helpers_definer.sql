-- Fix infinite recursion in profiles RLS. The is_hq_admin() / is_factory_user()
-- / is_store_manager() / current_store_id() / current_factory_id() helpers
-- were declared SECURITY INVOKER, so their inner SELECT against the profiles
-- table re-evaluated the same RLS policy that just called them. As soon as
-- the row count grew, that recursion blew through Postgres's stack-depth
-- limit and SELECT * FROM profiles returned 500: "stack depth limit exceeded".
--
-- Switch them to SECURITY DEFINER (with a fixed search_path so the function
-- always resolves public.profiles regardless of caller search_path). The
-- function then runs with the owner's privileges, bypasses RLS on its inner
-- query, and the policies don't recurse.

create or replace function public.is_hq_admin() returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid()::uuid and role = 'hq_admin'
  );
$$;

create or replace function public.is_factory_user() returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid()::uuid and role = 'factory_user'
  );
$$;

create or replace function public.is_store_manager() returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid()::uuid and role = 'store_manager'
  );
$$;

create or replace function public.current_store_id() returns uuid
  language sql stable security definer set search_path = public
as $$
  select store_id from public.profiles where id = auth.uid()::uuid;
$$;

create or replace function public.current_factory_id() returns uuid
  language sql stable security definer set search_path = public
as $$
  select factory_id from public.profiles where id = auth.uid()::uuid;
$$;
