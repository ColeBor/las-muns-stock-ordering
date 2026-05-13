# Stock Ordering Application — Project Spec

A multi-store stock ordering web application, built in Next.js + Supabase + AG Grid, deployed on Vercel. This spec captures every design decision made during planning so a Claude Code session can start building without re-deciding.

---

## Owner & Accounts

- **GitHub username:** ColeBor
- **Supabase project:** provisioned, free tier
- **Vercel:** Hobby plan, signed in via GitHub
- **Local dev environment:** Windows, Node.js + Git + VS Code + Claude Code installed

---

## Stack

- **Frontend:** Next.js (App Router) + React + TypeScript
- **Styling:** Tailwind CSS, shadcn/ui components
- **Spreadsheet grid:** AG Grid Community edition
- **Backend:** Supabase (Postgres, Auth, Row-Level Security, Storage)
- **Hosting:** Vercel (frontend), Supabase (backend)
- **Deploy flow:** push to GitHub → Vercel auto-deploys

---

## Business Context

A retail company operating 4 stores (expanding), with one factory currently and a future possibility of multiple factories. Two stock types are tracked:

- **Manufactured stock** — produced in-house, counted manually at the factory, finite supply per cycle.
- **Purchased stock** — bought from external suppliers, effectively unlimited; orders close the gap between what stores have and what they need.

Sales data is pulled from a POS system (API or weekly CSV export) and used in shortage allocation calculations.

---

## Order Cycle Workflow

1. A cycle is opened, with a defined set of participating stores.
2. Each store enters their current stock count for every active item.
3. Factory team enters the available manufactured stock for the cycle (per factory, per item).
4. The allocation engine runs:
   - For each item, computes `needed = capacity − current_count` per store.
   - **Purchased items** → generates purchase orders to suppliers covering the gap.
   - **Manufactured items** → cascades through each store's factory priority order:
     - **Pass 1** (primary factory): aggregate demand for that factory; if it has enough, fully fulfill; if short, allocate by 4-week sales share with a floor of 1 per store.
     - **Pass 2+** (secondary, tertiary factories): route any unmet demand through the next factory in priority order.
     - Anything still short after all passes is logged on the cycle for HQ visibility.
5. HQ reviews allocations and can apply manual overrides per (store, item).
6. Cycle is finalized; purchase orders are sent.

### Cycle Frequency

- Low-volume stores: weekly
- High-volume stores: twice weekly
- Each cycle is independent: its own factory snapshot, its own allocation run.

---

## Data Model

```
stores
  id, name, tier, location, created_at

factories
  id, name, location, created_at

store_factories
  store_id, factory_id, priority   -- 1 = primary, 2 = backup, ...

suppliers
  id, name, contact_info

items
  id, sku, name, type ('manufactured'|'purchased'),
  supplier_id (nullable; only used when type='purchased'),
  unit, created_at

store_items
  store_id, item_id,
  is_active (bool, default FALSE),
  capacity (integer),
  activated_at, deactivated_at

order_cycles
  id, name, order_date, status, created_by, created_at

cycle_stores
  cycle_id, store_id

factory_counts
  cycle_id, factory_id, item_id, available_qty,
  counted_by, counted_at

stock_entries
  cycle_id, store_id, item_id,
  current_count, entered_by, entered_at

allocations
  cycle_id, store_id, item_id, qty,
  source ('factory'|'purchase'|'manual_override'),
  factory_id (nullable; only when source='factory'),
  shortfall   -- qty unfulfilled, if any

allocation_overrides
  cycle_id, store_id, item_id, qty, reason, set_by, set_at

purchase_orders
  id, cycle_id, supplier_id, status, created_at

po_lines
  po_id, item_id, qty

sales_history
  store_id, item_id, week_starting, units_sold
```

---

## Business Rules

- **New items default to inactive at all stores.** Must be explicitly activated per store. (Supports the test-launch workflow: launch a new flavour at one store before others.)
- **Capacity is manually set per (store, item).** The setup UI offers a "set for all stores" bulk action and CSV import.
- **Floor of 1 per store** during manufactured shortages, when stock permits.
- **Edge case:** if factory stock is below the number of stores, fewer than all stores can get 1. Tiebreaker rule TBD — suggested default: allocate by sales% rank, round-robin any remainder.
- **New stores** have no sales history. Use manual override for their share during the first few cycles.
- **Manual overrides** are a general feature, not just for new stores. HQ pins a quantity for any (store, item) on any cycle; the engine allocates remaining stock to the others using normal sales% logic. Tracked as `allocation_overrides` for audit.

---

## Roles & Permissions (V1)

- **Store Manager** (`store_manager`) — the boss; full access; manages back-end config.
- **Employee** (`employee`) — front-line store worker; enters their own store's stock counts, fills daily logs.
- **Factory Worker** (`factory_worker`) — front-line factory worker; enters manufactured stock counts for their factory.

Enforce with Supabase Row Level Security.

---

## Build Order

1. **Scaffold** — Next.js + TypeScript project; push to GitHub; deploy empty app to Vercel; verify live URL.
2. **Database schema** — Supabase migrations for every table above.
3. **Auth + roles** — Supabase Auth with role-based RLS.
4. **Admin CRUD** — stores, factories, items, suppliers.
5. **Setup screens** — store-factory priority assignment; store-item activation + capacity (with bulk actions and CSV import).
6. **Cycle creation** — open a cycle, pick participating stores.
7. **Stock entry** — Employee view (their store only) and Factory Worker view (manufactured stock counts) using AG Grid.
8. **Allocation engine** — cascading priority logic with sales% and override support.
9. **Cycle review** — allocations, shortfalls, override UI, rerun.
10. **Purchase order generation** — group purchased allocations by supplier; generate POs.
11. **POS integration** — start with manual CSV import; API integration in a later pass.
12. **Reporting & history** — past cycles, audit trail.

---

## Deploying to a fresh environment

When the app is deployed to a brand-new Supabase project, the first user account needs to be promoted to Store Manager manually — there's no admin user yet to assign roles via the UI.

1. **Apply migrations.** Run every SQL migration in `supabase/migrations/` in chronological order through the Supabase SQL editor.
2. **Sign up your account** via the regular auth UI on the homepage (email + password). The `handle_new_user` trigger creates a profile row with the default role of `employee`.
3. **Look up your auth user UUID** in the SQL editor:
   ```sql
   select id, email from auth.users where email = 'you@example.com';
   ```
4. **Promote the profile to store_manager:**
   ```sql
   update public.profiles set role = 'store_manager' where id = '<auth-user-uuid>';
   ```
5. **Sign out and back in** so the new role takes effect on the client.

From that point on, all subsequent role changes happen through the Role & Assignment Center on the home page. You only need this manual step on the very first install.

---

## Deferred / Future

- **Days-of-cover capacity calculation** as alternative to manual capacity (discussed, deferred for V1)
- **Mobile-friendly stock entry** for tablet/phone use in back rooms
- **Email or print output** for purchase orders
- **Item-to-factory restrictions** (currently all factories produce all items; revisit if specialization happens)
