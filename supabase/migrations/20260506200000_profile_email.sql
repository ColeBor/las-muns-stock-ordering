-- Surface auth.users.email on the profiles row so the HQ assignment center
-- can show "user@example.com" instead of an opaque UUID. Backfills existing
-- rows from auth.users and updates the auto-create trigger so new signups
-- get the email captured at row creation.

alter table public.profiles
  add column if not exists email text;

update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is null;

create or replace function public.handle_new_user() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
