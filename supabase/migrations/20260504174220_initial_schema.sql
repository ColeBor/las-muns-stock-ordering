-- Initial Supabase database schema for Las Muns Stock Ordering

create extension if not exists pgcrypto;

do $$ begin
  create type user_role as enum ('hq_admin', 'factory_user', 'store_manager');
exception
  when duplicate_object then null;
end $$;

create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_high_volume boolean not null default false,
  location text,
  created_at timestamptz not null default now()
);

create table if not exists factories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  location text,
  created_at timestamptz not null default now()
);

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact_info text,
  created_at timestamptz not null default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  type text not null check (type in ('manufactured','purchased')),
  supplier_id uuid references suppliers(id),
  unit text,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'store_manager',
  store_id uuid references stores(id),
  factory_id uuid references factories(id),
  created_at timestamptz not null default now()
);

create table if not exists store_items (
  store_id uuid not null references stores(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  is_active boolean not null default false,
  capacity integer not null default 0,
  activated_at timestamptz,
  deactivated_at timestamptz,
  primary key (store_id, item_id)
);

create table if not exists store_factories (
  store_id uuid not null references stores(id) on delete cascade,
  factory_id uuid not null references factories(id) on delete cascade,
  priority smallint not null,
  primary key (store_id, factory_id),
  unique (store_id, priority)
);

create table if not exists order_cycles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  started_at timestamptz not null default now(),
  status text not null default 'draft',
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists cycle_stores (
  cycle_id uuid not null references order_cycles(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  primary key (cycle_id, store_id)
);

create table if not exists factory_counts (
  cycle_id uuid not null references order_cycles(id) on delete cascade,
  factory_id uuid not null references factories(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  available_qty integer not null default 0,
  counted_by text,
  counted_at timestamptz not null default now(),
  primary key (cycle_id, factory_id, item_id)
);

create table if not exists stock_entries (
  cycle_id uuid not null references order_cycles(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  current_count integer not null default 0,
  order_date date,
  entered_by text,
  entered_at timestamptz not null default now(),
  primary key (cycle_id, store_id, item_id)
);

create table if not exists allocations (
  cycle_id uuid not null references order_cycles(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  qty integer not null default 0,
  source text not null check (source in ('factory','purchase','manual_override')),
  factory_id uuid references factories(id),
  shortfall integer not null default 0,
  primary key (cycle_id, store_id, item_id)
);

create table if not exists allocation_overrides (
  cycle_id uuid not null references order_cycles(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  qty integer not null default 0,
  reason text,
  set_by text,
  set_at timestamptz not null default now(),
  primary key (cycle_id, store_id, item_id)
);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references order_cycles(id) on delete cascade,
  supplier_id uuid not null references suppliers(id),
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists po_lines (
  po_id uuid not null references purchase_orders(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  qty integer not null default 0,
  primary key (po_id, item_id)
);

create table if not exists sales_history (
  store_id uuid not null references stores(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  week_starting date not null,
  units_sold integer not null default 0,
  primary key (store_id, item_id, week_starting)
);

create or replace function public.is_hq_admin() returns boolean as $$
  select exists (
    select 1 from public.profiles where id = auth.uid()::uuid and role = 'hq_admin'
  );
$$ language sql stable security invoker;

create or replace function public.is_factory_user() returns boolean as $$
  select exists (
    select 1 from public.profiles where id = auth.uid()::uuid and role = 'factory_user'
  );
$$ language sql stable security invoker;

create or replace function public.is_store_manager() returns boolean as $$
  select exists (
    select 1 from public.profiles where id = auth.uid()::uuid and role = 'store_manager'
  );
$$ language sql stable security invoker;

create or replace function public.current_store_id() returns uuid as $$
  select store_id from public.profiles where id = auth.uid()::uuid;
$$ language sql stable security invoker;

create or replace function public.current_factory_id() returns uuid as $$
  select factory_id from public.profiles where id = auth.uid()::uuid;
$$ language sql stable security invoker;

alter table public.profiles enable row level security;
drop policy if exists "Profiles: HQ can select all profiles" on public.profiles;
create policy "Profiles: HQ can select all profiles" on public.profiles for select using (
  public.is_hq_admin() or id = auth.uid()::uuid
);
drop policy if exists "Profiles: can select own profile" on public.profiles;
create policy "Profiles: can select own profile" on public.profiles for select using (
  id = auth.uid()::uuid
);
drop policy if exists "Profiles: HQ can insert profiles" on public.profiles;
create policy "Profiles: HQ can insert profiles" on public.profiles for insert with check (
  auth.role() = 'authenticated' and (id = auth.uid()::uuid or public.is_hq_admin())
);
drop policy if exists "Profiles: can insert own profile" on public.profiles;
create policy "Profiles: can insert own profile" on public.profiles for insert with check (
  id = auth.uid()::uuid
);
drop policy if exists "Profiles: HQ can update profiles" on public.profiles;
create policy "Profiles: HQ can update profiles" on public.profiles for update using (
  public.is_hq_admin()
) with check (
  public.is_hq_admin()
);
drop policy if exists "Profiles: can update own profile" on public.profiles;
create policy "Profiles: can update own profile" on public.profiles for update using (
  id = auth.uid()::uuid
) with check (
  id = auth.uid()::uuid
);

alter table public.stores enable row level security;
drop policy if exists "Stores: authenticated can view" on public.stores;
create policy "Stores: authenticated can view" on public.stores for select using (auth.role() = 'authenticated');
drop policy if exists "Stores: HQ can manage" on public.stores;
create policy "Stores: HQ can manage" on public.stores for all using (public.is_hq_admin()) with check (public.is_hq_admin());

alter table public.factories enable row level security;
drop policy if exists "Factories: authenticated can view" on public.factories;
create policy "Factories: authenticated can view" on public.factories for select using (auth.role() = 'authenticated');
drop policy if exists "Factories: HQ can manage" on public.factories;
create policy "Factories: HQ can manage" on public.factories for all using (public.is_hq_admin()) with check (public.is_hq_admin());

alter table public.suppliers enable row level security;
drop policy if exists "Suppliers: authenticated can view" on public.suppliers;
create policy "Suppliers: authenticated can view" on public.suppliers for select using (auth.role() = 'authenticated');
drop policy if exists "Suppliers: HQ can manage" on public.suppliers;
create policy "Suppliers: HQ can manage" on public.suppliers for all using (public.is_hq_admin()) with check (public.is_hq_admin());

alter table public.items enable row level security;
drop policy if exists "Items: authenticated can view" on public.items;
create policy "Items: authenticated can view" on public.items for select using (auth.role() = 'authenticated');
drop policy if exists "Items: HQ can manage" on public.items;
create policy "Items: HQ can manage" on public.items for all using (public.is_hq_admin()) with check (public.is_hq_admin());

alter table public.store_items enable row level security;
drop policy if exists "Store items: HQ can manage" on public.store_items;
create policy "Store items: HQ can manage" on public.store_items for all using (public.is_hq_admin()) with check (public.is_hq_admin());
drop policy if exists "Store items: store managers can view own store" on public.store_items;
create policy "Store items: store managers can view own store" on public.store_items for select using (
  public.is_store_manager() and store_id = public.current_store_id()
);

alter table public.store_factories enable row level security;
drop policy if exists "Store factories: HQ can manage" on public.store_factories;
create policy "Store factories: HQ can manage" on public.store_factories for all using (public.is_hq_admin()) with check (public.is_hq_admin());
drop policy if exists "Store factories: store managers can view own store" on public.store_factories;
create policy "Store factories: store managers can view own store" on public.store_factories for select using (
  public.is_store_manager() and store_id = public.current_store_id()
);

alter table public.order_cycles enable row level security;
drop policy if exists "Order cycles: authenticated can view" on public.order_cycles;
create policy "Order cycles: authenticated can view" on public.order_cycles for select using (auth.role() = 'authenticated');
drop policy if exists "Order cycles: HQ can manage" on public.order_cycles;
create policy "Order cycles: HQ can manage" on public.order_cycles for all using (public.is_hq_admin()) with check (public.is_hq_admin());

alter table public.cycle_stores enable row level security;
drop policy if exists "Cycle stores: HQ can manage" on public.cycle_stores;
create policy "Cycle stores: HQ can manage" on public.cycle_stores for all using (public.is_hq_admin()) with check (public.is_hq_admin());
drop policy if exists "Cycle stores: store managers can view own store" on public.cycle_stores;
create policy "Cycle stores: store managers can view own store" on public.cycle_stores for select using (
  public.is_store_manager() and store_id = public.current_store_id()
);

alter table public.factory_counts enable row level security;
drop policy if exists "Factory counts: HQ can manage" on public.factory_counts;
create policy "Factory counts: HQ can manage" on public.factory_counts for all using (public.is_hq_admin()) with check (public.is_hq_admin());
drop policy if exists "Factory counts: factory users can manage own factory" on public.factory_counts;
create policy "Factory counts: factory users can manage own factory" on public.factory_counts for all using (
  public.is_factory_user() and factory_id = public.current_factory_id()
) with check (
  public.is_factory_user() and factory_id = public.current_factory_id()
);
drop policy if exists "Factory counts: authenticated can view" on public.factory_counts;
create policy "Factory counts: authenticated can view" on public.factory_counts for select using (auth.role() = 'authenticated');

alter table public.stock_entries enable row level security;
drop policy if exists "Stock entries: store managers can manage own store" on public.stock_entries;
create policy "Stock entries: store managers can manage own store" on public.stock_entries for all using (
  public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
) with check (
  public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
);
drop policy if exists "Stock entries: store managers can view own store" on public.stock_entries;
create policy "Stock entries: store managers can view own store" on public.stock_entries for select using (
  public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
);

alter table public.allocations enable row level security;
drop policy if exists "Allocations: HQ can manage" on public.allocations;
create policy "Allocations: HQ can manage" on public.allocations for all using (public.is_hq_admin()) with check (public.is_hq_admin());
drop policy if exists "Allocations: store managers can view own store" on public.allocations;
create policy "Allocations: store managers can view own store" on public.allocations for select using (
  public.is_store_manager() and store_id = public.current_store_id()
);

alter table public.allocation_overrides enable row level security;
drop policy if exists "Allocation overrides: HQ can manage" on public.allocation_overrides;
create policy "Allocation overrides: HQ can manage" on public.allocation_overrides for all using (public.is_hq_admin()) with check (public.is_hq_admin());
drop policy if exists "Allocation overrides: store managers can view own store" on public.allocation_overrides;
create policy "Allocation overrides: store managers can view own store" on public.allocation_overrides for select using (
  public.is_store_manager() and store_id = public.current_store_id()
);

alter table public.purchase_orders enable row level security;
drop policy if exists "Purchase orders: authenticated can view" on public.purchase_orders;
create policy "Purchase orders: authenticated can view" on public.purchase_orders for select using (auth.role() = 'authenticated');
drop policy if exists "Purchase orders: HQ can manage" on public.purchase_orders;
create policy "Purchase orders: HQ can manage" on public.purchase_orders for all using (public.is_hq_admin()) with check (public.is_hq_admin());

alter table public.po_lines enable row level security;
drop policy if exists "PO lines: authenticated can view" on public.po_lines;
create policy "PO lines: authenticated can view" on public.po_lines for select using (auth.role() = 'authenticated');
drop policy if exists "PO lines: HQ can manage" on public.po_lines;
create policy "PO lines: HQ can manage" on public.po_lines for all using (public.is_hq_admin()) with check (public.is_hq_admin());

alter table public.sales_history enable row level security;
drop policy if exists "Sales history: authenticated can view" on public.sales_history;
create policy "Sales history: authenticated can view" on public.sales_history for select using (auth.role() = 'authenticated');
drop policy if exists "Sales history: HQ can manage" on public.sales_history;
create policy "Sales history: HQ can manage" on public.sales_history for all using (public.is_hq_admin()) with check (public.is_hq_admin());
