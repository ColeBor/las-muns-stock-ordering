-- Initial Supabase database schema for Las Muns Stock Ordering

create extension if not exists pgcrypto;

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
