-- Profiles in this app aren't individual people — each account belongs to
-- a store or factory and is shared by the employees there on a tablet. Add
-- a display_name field so the HQ admin can label accounts ("Store A iPad",
-- "Bob the manager") and pick them by friendly name in the assignment
-- center instead of by raw email.

alter table public.profiles
  add column if not exists display_name text;
