-- Auto-create a profile row whenever a Supabase auth user is created.
-- Without this, new sign-ups have no profile, RLS blocks them from everything,
-- and the HQ assignment center can't even see them to assign a role.
--
-- New users default to 'store_manager' (per profiles.role default).
--
-- BOOTSTRAP: After the first user signs up, promote them to HQ admin via SQL:
--   update public.profiles set role = 'hq_admin' where id = '<auth-user-uuid>';
-- Subsequent admins can be promoted through the HQ assignment center in the UI.

create or replace function public.handle_new_user() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any auth users that pre-date this trigger.
insert into public.profiles (id)
select id from auth.users
on conflict do nothing;
