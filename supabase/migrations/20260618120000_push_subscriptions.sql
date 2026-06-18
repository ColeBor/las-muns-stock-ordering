-- Web Push — device subscriptions + a notification de-dup ledger.
--
-- This is the standalone half of the push-notifications feature. It has NO
-- dependency on the waste-cap / fridge / cycle tables, so it's safe to apply
-- regardless of whether those later migrations are live yet. The event
-- triggers that actually fire notifications live in a SEPARATE migration
-- (20260618130000_push_triggers.sql) that DOES depend on those tables and
-- should only be applied once they're confirmed on the remote DB.

-- ---------------------------------------------------------------------------
-- 1. push_subscriptions — one row per (manager, device/browser).
-- ---------------------------------------------------------------------------
-- A manager who installs the PWA on both their phone and a desktop gets two
-- rows. `endpoint` is the unique URL the browser's push service hands us; it
-- is the natural key (re-subscribing on the same device returns the same
-- endpoint, so we upsert on it). p256dh + auth are the encryption keys the
-- Web Push spec requires to deliver an encrypted payload to that endpoint.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

-- A signed-in user manages only their own device rows. The dispatcher reads
-- every manager's subscriptions via the service-role key, which bypasses RLS,
-- so no broad SELECT policy is needed here.
drop policy if exists "Push subs: owner manages own" on public.push_subscriptions;
create policy "Push subs: owner manages own" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. notification_events — idempotency ledger.
-- ---------------------------------------------------------------------------
-- Each real alert instance claims a unique `event_key` here BEFORE a push is
-- sent. The trigger functions insert with ON CONFLICT DO NOTHING and only
-- dispatch when the insert actually took a row — so N waste entries on an
-- already-breaching store-day produce exactly one notification, not N.
--
-- For re-armable alerts (waste / fridge), resolving the alert deletes the
-- matching row so a fresh breach can notify again — mirroring the dashboards'
-- auto-re-arm semantics.
create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists notification_events_kind_idx
  on public.notification_events(kind, created_at desc);

alter table public.notification_events enable row level security;
-- No policies on purpose: only SECURITY DEFINER triggers and the service-role
-- dispatcher touch this table. Regular clients have no business reading it.
