-- Training resources (videos + documents) assignable per-store.
--
-- HQ (Store Managers) upload a file with a title + description + kind
-- (video|document) and choose which stores get to see it. Employees only
-- see resources their assigned store has been granted.
--
-- Files live in a private Supabase Storage bucket `training-resources`.
-- The metadata tables (training_resources + training_resource_stores) gate
-- which resources an Employee can list; for actual playback / download the
-- app generates a signed URL via supabase.storage.createSignedUrl(). Storage
-- RLS additionally restricts writes to Store Managers.

create table if not exists training_resources (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) > 0),
  description text,
  kind text not null check (kind in ('video', 'document')),
  storage_path text not null,
  mime_type text,
  file_size_bytes bigint,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists training_resource_stores (
  resource_id uuid not null references training_resources(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (resource_id, store_id)
);

create index if not exists training_resource_stores_store_idx
  on training_resource_stores(store_id);

alter table public.training_resources enable row level security;
alter table public.training_resource_stores enable row level security;

drop policy if exists "Training: Store Managers can manage resources" on public.training_resources;
create policy "Training: Store Managers can manage resources" on public.training_resources
  for all using (public.is_store_manager()) with check (public.is_store_manager());

drop policy if exists "Training: Employees can view assigned resources" on public.training_resources;
create policy "Training: Employees can view assigned resources" on public.training_resources
  for select using (
    public.is_employee()
    and exists (
      select 1 from public.training_resource_stores trs
      where trs.resource_id = training_resources.id
        and trs.store_id = public.current_store_id()
    )
  );

drop policy if exists "Training assignments: Store Managers can manage" on public.training_resource_stores;
create policy "Training assignments: Store Managers can manage" on public.training_resource_stores
  for all using (public.is_store_manager()) with check (public.is_store_manager());

drop policy if exists "Training assignments: Employees can view own store" on public.training_resource_stores;
create policy "Training assignments: Employees can view own store" on public.training_resource_stores
  for select using (
    public.is_employee() and store_id = public.current_store_id()
  );

-- Storage bucket (private). Storage RLS below restricts uploads to Store
-- Managers; reads are allowed for any authenticated user, but since path
-- segments are UUIDs and Employees only learn about assigned UUIDs through
-- the metadata RLS above, they can't enumerate other stores' content.
insert into storage.buckets (id, name, public)
values ('training-resources', 'training-resources', false)
on conflict (id) do nothing;

drop policy if exists "Training storage: Store Managers can manage" on storage.objects;
create policy "Training storage: Store Managers can manage" on storage.objects
  for all using (bucket_id = 'training-resources' and public.is_store_manager())
  with check (bucket_id = 'training-resources' and public.is_store_manager());

drop policy if exists "Training storage: authenticated can read" on storage.objects;
create policy "Training storage: authenticated can read" on storage.objects
  for select using (bucket_id = 'training-resources' and auth.role() = 'authenticated');

-- Keep updated_at fresh on metadata edits.
create or replace function public.touch_training_resource() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists training_resources_touch on public.training_resources;
create trigger training_resources_touch
  before update on public.training_resources
  for each row execute function public.touch_training_resource();

-- Realtime so the Employee library refreshes when HQ adds / removes.
do $$
declare
  t text;
  realtime_tables text[] := array['training_resources', 'training_resource_stores'];
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
