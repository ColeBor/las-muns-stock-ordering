-- Otter POS ingestion foundation.
--
-- We are the "Order Consumer" in Otter's model: Otter sends us a webhook for
-- every order. A Vercel route handler (src/app/api/otter/webhook/route.ts)
-- verifies the HMAC-SHA256 signature, then writes here using the service-role
-- client (so these tables don't need INSERT/UPDATE policies for app users —
-- the service role bypasses RLS).
--
-- Design note: the raw webhook payload is stored verbatim in `raw jsonb` and
-- is the source of truth. The flat columns are a convenience projection we
-- extract on the way in; if Otter's field names differ from our first guess
-- we can re-derive every column from `raw` without losing data.
--
-- This is the shared foundation for three features (scheduled-orders list,
-- bake-quantity forecasting, inventory tracking). Only the scheduled-orders
-- list reads it for now.

-- ---------------------------------------------------------------------------
-- 1. Otter location <-> our store mapping.
-- ---------------------------------------------------------------------------
create table if not exists public.otter_store_links (
  otter_store_id text primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  label text,
  created_at timestamptz not null default now()
);

create index if not exists otter_store_links_store_idx
  on public.otter_store_links(store_id);

alter table public.otter_store_links enable row level security;

-- HQ admins manage the mapping. The webhook receiver resolves it via the
-- service role, so employees never need to read this table directly.
drop policy if exists "Otter store links: store managers manage all" on public.otter_store_links;
create policy "Otter store links: store managers manage all" on public.otter_store_links
  for all using (public.is_store_manager()) with check (public.is_store_manager());

-- ---------------------------------------------------------------------------
-- 2. Orders.
-- ---------------------------------------------------------------------------
create table if not exists public.otter_orders (
  id uuid primary key default gen_random_uuid(),
  -- Otter's id for the order — unique so webhook retries / status updates
  -- upsert onto the same row instead of duplicating.
  otter_order_id text not null unique,
  otter_store_id text,
  -- Resolved from otter_store_links at write time. NULL when the Otter
  -- location hasn't been mapped yet; the row is still kept (raw payload
  -- preserved) and can be backfilled once the mapping exists.
  store_id uuid references public.stores(id) on delete set null,
  display_id text,          -- human-facing order number, if present
  customer_name text,
  fulfillment_mode text,    -- pickup | delivery | dine_in | ... (raw string)
  status text,
  -- Scheduled (future-fulfillment) orders: is_scheduled = true and
  -- scheduled_for holds the requested time. ASAP orders leave both unset.
  is_scheduled boolean not null default false,
  scheduled_for timestamptz,
  placed_at timestamptz,    -- when the order was created on Otter
  canceled_at timestamptz,  -- set when a cancellation event arrives
  item_count integer,
  raw jsonb not null,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists otter_orders_store_scheduled_idx
  on public.otter_orders(store_id, scheduled_for);
create index if not exists otter_orders_scheduled_idx
  on public.otter_orders(is_scheduled, scheduled_for)
  where is_scheduled;

alter table public.otter_orders enable row level security;

-- Read access mirrors the logs: HQ sees everything, employees see orders for
-- a store they're assigned to (is_my_store covers multi-store workers).
drop policy if exists "Otter orders: readable by store" on public.otter_orders;
create policy "Otter orders: readable by store" on public.otter_orders
  for select using (
    public.is_store_manager()
    or (public.is_employee() and public.is_my_store(store_id))
  );

-- ---------------------------------------------------------------------------
-- 3. Order line items.
-- ---------------------------------------------------------------------------
create table if not exists public.otter_order_items (
  id uuid primary key default gen_random_uuid(),
  otter_order_id text not null
    references public.otter_orders(otter_order_id) on delete cascade,
  otter_item_id text,
  name text,
  quantity integer not null default 1 check (quantity >= 0),
  -- Our items.id once the Otter menu item is mapped (bake qty / inventory
  -- phases). NULL until that mapping exists.
  item_id uuid references public.items(id) on delete set null,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists otter_order_items_order_idx
  on public.otter_order_items(otter_order_id);
create index if not exists otter_order_items_item_idx
  on public.otter_order_items(item_id);

alter table public.otter_order_items enable row level security;

-- Line items inherit their parent order's visibility.
drop policy if exists "Otter order items: follow parent order" on public.otter_order_items;
create policy "Otter order items: follow parent order" on public.otter_order_items
  for select using (
    public.is_store_manager()
    or exists (
      select 1 from public.otter_orders o
      where o.otter_order_id = otter_order_items.otter_order_id
        and public.is_employee()
        and public.is_my_store(o.store_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Realtime so the per-location list updates the moment an order lands.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  realtime_tables text[] := array['otter_orders', 'otter_order_items'];
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
