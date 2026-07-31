# Las Muns Operations App — Handoff & Operations Runbook

This document is everything the company needs to **own, run, and maintain** this
application without the original developer. Read the first two sections even if
you are not technical; the rest is for whoever will maintain the app going
forward (an employee or a contract developer).

> **The single most important thing to understand:** the code in this repository
> is only about 10% of what makes the app work. The other 90% is a set of
> **cloud accounts and secret keys** that are currently registered to the
> departing developer. Handing over the code without transferring those accounts
> and rotating the secrets means the app will keep running **on the developer's
> personal accounts** — which is not a safe place for the business to be. Follow
> the transfer and rotation checklists below.

---

## 1. What this app is

An internal web app that runs day-to-day operations for the store chain and the
factory: stock ordering, delivery allocation, baking/production forecasts,
temperature and waste logging, and staff requests. Staff use it on **Android
tablets**, where it is installed as an app (a "PWA" — an installable website).

- **Live URL:** `https://lasmuns.vercel.app`
- **Code:** `https://github.com/ColeBor/las-muns-stock-ordering`

It was built with AI-assisted development. Maintaining it does **not** require
building from scratch, but it does require someone comfortable with basic web
development (Git, a code editor, and reading the two dashboards below). If the
business does not have that person, budget for a part-time contract developer;
this document is written so that person can get up to speed in a day.

---

## 2. The accounts the app depends on

The app is stitched together from five services. Each must end up owned and paid
for by the **company**, not an individual.

| # | Service | What it does | Where it lives today | Plan |
|---|---------|--------------|----------------------|------|
| 1 | **GitHub** | Stores the source code | `github.com/ColeBor/las-muns-stock-ordering` | Free |
| 2 | **Vercel** | Hosts the app; auto-deploys on every code push; holds the production secret keys | Signed in via GitHub; deploys to `lasmuns.vercel.app` | Hobby (free) |
| 3 | **Supabase** | **The database — this holds ALL live business data**, plus logins, file storage, live updates, and scheduled jobs | The project at the URL in `NEXT_PUBLIC_SUPABASE_URL` | Free tier |
| 4 | **Web Push (VAPID keys)** | Sends phone/tablet notifications to managers | A keypair generated on the developer's machine, stored in Vercel | n/a |
| 5 | **Otter (POS)** | *Optional/inactive.* A built-but-paused integration to pull sales data | Not yet activated | n/a |

**Losing access to #3 (Supabase) means losing the business's data.** Treat that
account as the crown jewels: make sure it is owned by a company email that more
than one trusted person can access, and that billing is on a company card.

---

## 3. Choose a handoff model

There are two ways to do this. Pick one before starting.

### Model A — Transfer the existing projects (recommended)

Keep the live app exactly as-is; just move ownership. Nothing breaks, no data is
migrated, the URL stays the same. Best for continuity.

- Transfer the GitHub repo, the Vercel project, and the Supabase project into
  company-owned accounts, then rotate all secrets and remove the developer's
  access. **Follow §4 then §5.**

### Model B — Rebuild on fresh company accounts

The company creates brand-new GitHub/Vercel/Supabase accounts and stands the app
up from scratch, migrating the data over. More work and more risk, but gives a
completely clean slate. Only choose this if you specifically want new accounts.

- **Follow §7 (fresh environment bring-up)**, and export/import the Supabase data
  (Supabase dashboard → Database → Backups, or `pg_dump`/restore).

Most businesses should choose **Model A**.

---

## 4. Transfer checklist (Model A)

> **Non-technical? Use [`TRANSFER-GUIDE.md`](TRANSFER-GUIDE.md)** — the same
> transfers written out click-by-click in plain English, with who-does-what
> labelled. The checklist below is the condensed version.

Do these in order. Each is done in that service's website (dashboard), by
someone logged in as the current owner.

- [ ] **Create company-owned logins first.** A company Google/email account that
      owns the GitHub, Vercel, and Supabase accounts. Put billing on a company card.
- [ ] **GitHub:** Repo → *Settings → General → Transfer ownership* → transfer to
      the company's GitHub account or organization.
- [ ] **Vercel:** Either transfer the project to the company's Vercel team
      (*Project → Settings → Advanced → Transfer*), **or** have the company's
      Vercel account import the now-company-owned GitHub repo as a new project.
      Re-enter the environment variables (§6) if you re-import.
- [ ] **Supabase:** *Project → Settings → General → Transfer project* into the
      company's Supabase organization. (Both sides must be in an organization; a
      free org is fine.)
- [ ] **Domain:** The app currently uses the free `lasmuns.vercel.app` address,
      which follows the Vercel project. If a custom domain is ever added, transfer
      it too (Vercel → *Project → Settings → Domains*).
- [ ] **Confirm the app still loads** at its URL after each transfer.
- [ ] *(Optional)* Tidy up keys and access — see §5.

---

## 5. (Optional) Tidying up keys and access

**This step is optional and can be skipped** — the app runs fine on the existing
keys after an ownership transfer. The only reason to do any of it is a fully clean
break, so the previous developer no longer holds live values or logins. Do as much
or as little as the company is comfortable with. To change a key, update its new
value in **Vercel → Project → Settings → Environment Variables** and redeploy (§8).

| Secret | Where to rotate it | Then update |
|--------|--------------------|-------------|
| **Supabase service-role key & anon key** | Supabase → *Settings → API Keys* → roll the keys (on legacy projects, rolling the JWT secret rotates both and signs everyone out) | `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel |
| **Supabase database password** | Supabase → *Settings → Database → Reset password* | Anywhere the direct DB connection string is used (e.g. local `supabase link`) |
| **Push dispatch secret** | Generate a new random string (`openssl rand -hex 32`). Also update the database setting: run `alter database postgres set app.settings.push_dispatch_secret = '<new value>';` in the Supabase SQL editor | `PUSH_DISPATCH_SECRET` in Vercel — **must match** the DB setting |
| **Web Push (VAPID) keys** | Generate a new pair: `npx web-push generate-vapid-keys` (regenerating makes tablets re-subscribe to notifications once — harmless) | `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` in Vercel |
| **VAPID subject** | Change to a company email | `VAPID_SUBJECT` (e.g. `mailto:ops@yourcompany.com`) |

- [ ] *(Recommended)* Remove the developer as a member of the GitHub repo, Vercel
      team, and Supabase org, so only the company can reach the dashboards.
- [ ] Make sure at least one **company-owned** account has the `store_manager`
      role (see §9) — this one matters regardless.
- [ ] *(Optional)* Delete or archive the developer's local copy of `.env.local`.

---

## 6. Environment variables (what they are — never commit the real values)

The real values live only in **Vercel** (for production) and in a local
`.env.local` file (for development). A template with the variable names is in
[`.env.example`](.env.example). **Never commit real values to Git.**

| Variable | Public? | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Address of the Supabase project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes (safe to expose) | Public key the app uses; the database's row-level security keeps it safe |
| `SUPABASE_SERVICE_ROLE_KEY` | **SECRET** | Full-access key used only by server code; bypasses security rules. Never send to a browser |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | yes | Lets tablets subscribe to push notifications |
| `VAPID_PRIVATE_KEY` | **SECRET** | Signs push notifications |
| `VAPID_SUBJECT` | yes | Contact email required by the push standard |
| `PUSH_DISPATCH_SECRET` | **SECRET** | Shared password so only our database can trigger push sends |

---

## 7. Running and maintaining the app

### Run it locally (for a developer)

Requires **Node.js** (v20+), **Git**, and a code editor.

```bash
git clone https://github.com/ColeBor/las-muns-stock-ordering.git
cd las-muns-stock-ordering
npm install
cp .env.example .env.local        # then fill in the real values from Vercel
npm run dev                        # opens http://localhost:3000
```

> **Note:** this project runs on **Next.js 16** and its conventions differ from
> older Next.js. See `AGENTS.md` — read the docs bundled in
> `node_modules/next/dist/docs/` before making framework-level changes.

### Deploy a change

1. Commit and push to the **`master`** branch on GitHub.
2. Vercel automatically builds and deploys it (usually 1–2 minutes).
3. **Tablets must be fully closed and reopened** to pick up new code — a
   backgrounded PWA keeps running the old version.

> **Idle pause:** on the free plan, the deployment can go dormant after long
> inactivity; pushing any change (or redeploying in Vercel) wakes it.

> **Rollback:** in Vercel → *Deployments*, you can instantly promote a previous
> working deployment if a release breaks something.

---

## 8. Database & migrations

The database is **PostgreSQL**, managed by Supabase. Its structure is defined by
**72 migration files** in [`supabase/migrations/`](supabase/migrations/),
applied in filename (chronological) order. This is the schema's full history.

- **Golden rule:** apply a database migration **before** deploying code that
  depends on it, or the live app will error.
- **Apply migrations** with the Supabase CLI against the linked project:
  ```bash
  npx supabase link --project-ref <your-project-ref>   # ref is in the Supabase URL
  npx supabase db push
  ```
  (Or paste each new migration's SQL into the Supabase SQL editor, in order.)
- **Backups:** Supabase takes automatic backups (retention depends on the plan —
  the free tier keeps only a short window; a paid tier is strongly recommended
  once this is the company's system of record). Find them under
  *Database → Backups*.

### Scheduled jobs (cron) running inside the database

These run automatically via the `pg_cron` / `pg_net` extensions. If you ever
rebuild the database, these come from their migrations and need the settings noted:

| Job | Defined in | What it does |
|-----|-----------|--------------|
| Waste-photo cleanup | `..._waste_photos_cleanup_cron.sql` | Deletes expired waste photos on a schedule |
| Auto-reallocation | `..._auto_reallocate_cron.sql` | Recomputes delivery allocations when stock changes |
| Push notifications | `..._push_triggers.sql` | Sends manager alerts; **requires** the `app.settings.push_dispatch_secret` DB setting to match Vercel's `PUSH_DISPATCH_SECRET` |

---

## 9. Who can do what (roles)

Access is enforced by **Row-Level Security** inside the database, based on each
user's role. Roles are managed in-app via the **Role & Assignment Center** on the
home page (visible to a Store Manager).

| Role | Value | Access |
|------|-------|--------|
| The boss / admin | `store_manager` | Everything, all stores, all admin screens |
| Store staff | `employee` | Their own store's stock counts, logs, requests |
| Factory staff | `factory_worker` | Factory stock, production, deliveries |

**First-admin bootstrap (only needed on a brand-new database):** the very first
account has no admin to promote it. Sign up normally, then in the Supabase SQL
editor:

```sql
-- find your user id
select id, email from auth.users where email = 'you@yourcompany.com';
-- promote it
update public.profiles set role = 'store_manager' where id = '<that-id>';
```

Sign out and back in. After that, all role changes happen in the app.

---

## 10. Standing up a brand-new environment (Model B / disaster recovery)

If you ever rebuild from scratch on new accounts:

1. Create a new Supabase project; note its URL and keys.
2. Apply all migrations (`supabase db push`) — §8.
3. Set the push secret in the DB: `alter database postgres set app.settings.push_dispatch_secret = '<value>';`
4. Import the data (from a Supabase backup / `pg_dump` of the old project).
5. Create a Vercel project from the GitHub repo; set all environment variables (§6).
6. Generate VAPID keys; set them in Vercel.
7. Deploy, then bootstrap the first `store_manager` (§9).
8. Re-install the app on the tablets (open the URL, "Add to Home screen").

---

## 11. Known quirks & operational notes

- **"Please sign in" / stuck loading after a tablet has been idle or asleep:**
  a long-standing class of issue with long-lived tablet sessions. Much of it is
  fixed in the code; the reliable recovery is to **fully close and reopen the
  app**. Keeping tablets on Wi-Fi and not letting them sit dead-idle helps.
- **After any deploy, reopen the app on every tablet** or they run old code.
- **Empanadas are counted in boxes**, not pieces, throughout the app.
- **Dates can display one day early** in day/month locales — a known,
  low-severity display quirk.
- **The Otter (POS) integration is built but inactive** — it does nothing until
  someone activates an Otter developer app and wires the credentials. Safe to
  ignore until the company wants automated sales import.
- **The factory stock-entry screen** shares an older data-entry pattern that the
  store order sheet has since had hardened against lost input; consider applying
  the same fix there if staff report the factory counts not saving.

---

## 12. Offboarding checklist (final)

- [ ] All five accounts (§2) owned by company logins with company billing.
- [ ] GitHub repo transferred; developer removed as a collaborator.
- [ ] Vercel project owned by the company; developer removed.
- [ ] Supabase project owned by the company; developer removed.
- [ ] A company-owned `store_manager` account exists (see §9).
- [ ] *(Optional)* Keys/access tidied up per §5.
- [ ] Someone at the company (or a contractor) has this document and can log in
      to all three dashboards.
- [ ] Consider upgrading Supabase to a paid tier for proper backups now that this
      is the business's system of record.
