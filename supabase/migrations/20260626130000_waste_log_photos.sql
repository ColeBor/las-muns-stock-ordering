-- Photo capture for waste log entries. Staff snap one or more photos when they
-- log waste (camera button on phones). Photos hard-expire after 3 days: the
-- /api/waste-photos/cleanup endpoint deletes the storage files + rows, and the
-- waste log page hits it opportunistically on load (it can also be cron-driven).
--
-- "store manager" = the boss (sees all stores); "employee" = front-line worker
-- (scoped to their assigned store(s) via is_my_store / profile_stores). Mirrors
-- the waste_log_entries policy exactly so photo access == entry access.

create table if not exists public.waste_log_photos (
  id uuid primary key default gen_random_uuid(),
  waste_log_id uuid not null references public.waste_log_entries(id) on delete cascade,
  -- Denormalised so RLS and the cleanup job don't need to join back to the entry.
  store_id uuid not null references public.stores(id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '3 days')
);

create index if not exists waste_log_photos_entry_idx on public.waste_log_photos(waste_log_id);
create index if not exists waste_log_photos_expiry_idx on public.waste_log_photos(expires_at);

alter table public.waste_log_photos enable row level security;

drop policy if exists "Waste photos: employees can manage own store" on public.waste_log_photos;
create policy "Waste photos: employees can manage own store" on public.waste_log_photos
  for all
  using (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)))
  with check (public.is_store_manager() or (public.is_employee() and public.is_my_store(store_id)));

-- Realtime so thumbnails appear without a manual refresh (guarded — re-running
-- the migration must not fail with "table already in publication").
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'waste_log_photos'
  ) then
    alter publication supabase_realtime add table public.waste_log_photos;
  end if;
end $$;

-- Private bucket for the image files.
insert into storage.buckets (id, name, public)
values ('waste-photos', 'waste-photos', false)
on conflict (id) do nothing;

-- Path convention: {store_id}/{waste_log_id}/{uuid}.{ext}. The first folder is
-- the store id, so worker access is scoped to their store(s); the boss manages
-- all. nullif guards an empty first segment before the uuid cast.
drop policy if exists "Waste photos storage: staff manage own store" on storage.objects;
create policy "Waste photos storage: staff manage own store" on storage.objects
  for all
  using (
    bucket_id = 'waste-photos' and (
      public.is_store_manager()
      or (public.is_employee() and public.is_my_store(nullif((storage.foldername(name))[1], '')::uuid))
    )
  )
  with check (
    bucket_id = 'waste-photos' and (
      public.is_store_manager()
      or (public.is_employee() and public.is_my_store(nullif((storage.foldername(name))[1], '')::uuid))
    )
  );
