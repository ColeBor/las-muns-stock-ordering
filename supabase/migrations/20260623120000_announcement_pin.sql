-- Let managers pin an announcement to the top of the staff feed until a date.
-- While today <= pinned_until, the announcement always shows (on top of its
-- normal schedule) and sorts first. NULL = not pinned.
alter table public.announcements
  add column if not exists pinned_until date;
