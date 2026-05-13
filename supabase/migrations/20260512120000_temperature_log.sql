-- Temperature log: per-store fridges + per-fridge temperature readings.
-- First "log"-style feature in the app; sets the pattern other logs (waste,
-- box tracing, etc.) will follow: own table per log type, scoped by store_id,
-- RLS that mirrors stock_entries (store managers manage their own store,
-- HQ admins manage everything), and replication into supabase_realtime so
-- clients refetch without polling.

create table if not exists store_fridges (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);

create index if not exists store_fridges_store_idx on store_fridges(store_id);

create table if not exists temperature_log_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  fridge_id uuid not null references store_fridges(id) on delete cascade,
  temperature_c numeric(5,2) not null,
  recorded_at timestamptz not null default now(),
  recorded_by text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists temperature_log_entries_store_recorded_idx
  on temperature_log_entries(store_id, recorded_at desc);

create index if not exists temperature_log_entries_fridge_recorded_idx
  on temperature_log_entries(fridge_id, recorded_at desc);

alter table public.store_fridges enable row level security;
drop policy if exists "Store fridges: HQ can manage" on public.store_fridges;
create policy "Store fridges: HQ can manage" on public.store_fridges
  for all using (public.is_hq_admin()) with check (public.is_hq_admin());
drop policy if exists "Store fridges: store managers can view own store" on public.store_fridges;
create policy "Store fridges: store managers can view own store" on public.store_fridges
  for select using (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );
drop policy if exists "Store fridges: store managers can insert own store" on public.store_fridges;
create policy "Store fridges: store managers can insert own store" on public.store_fridges
  for insert with check (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );
drop policy if exists "Store fridges: store managers can update own store" on public.store_fridges;
create policy "Store fridges: store managers can update own store" on public.store_fridges
  for update using (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  ) with check (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );
drop policy if exists "Store fridges: store managers can delete own store" on public.store_fridges;
create policy "Store fridges: store managers can delete own store" on public.store_fridges
  for delete using (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );

alter table public.temperature_log_entries enable row level security;
drop policy if exists "Temperature log: store managers can manage own store" on public.temperature_log_entries;
create policy "Temperature log: store managers can manage own store" on public.temperature_log_entries
  for all using (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  ) with check (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );

-- Add the new tables to Supabase Realtime so the UI auto-refreshes when
-- another browser/tab writes a reading or adds a fridge.
do $$
declare
  t text;
  realtime_tables text[] := array[
    'store_fridges',
    'temperature_log_entries'
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
