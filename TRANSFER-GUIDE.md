# Account Transfer Guide (plain English)

**Goal:** move the three online accounts that run the app out of the previous
developer's personal logins and into the **company's own** accounts. When these
three transfers are done, the company fully owns and controls the app.

You are transferring three things:

1. **GitHub** — where the app's code is stored.
2. **Vercel** — the service that puts the app online.
3. **Supabase** — the database that holds all your data. *(The important one.)*

Set aside about an hour. You don't need to be technical — just go slowly and read
each screen. Steps are labelled **[Developer]** (the person leaving) or
**[Company]** (whoever is taking over) so it's clear who clicks what.

---

## Before you start (do this once)

1. Pick a **company email** that will own everything (e.g. `ops@yourcompany.com`).
   Not a personal email.
2. Using that email, create a free account on each site (skip any you already have):
   - github.com
   - vercel.com — sign up with **“Continue with GitHub”** using the new company GitHub
   - supabase.com
3. Put any paid plans on a **company card**.
4. Give the **[Developer]** the usernames/emails of these three new accounts — they
   need them to send each transfer.

Then do the three transfers below, **in order**.

---

## Part 1 — GitHub (the code)

A two-step “send, then accept.”

1. **[Developer]** signs in to github.com and opens the repository
   `las-muns-stock-ordering`.
2. Click **Settings** (near the top of the repo page), then scroll to the very
   bottom to the **Danger Zone**.
3. Click **Transfer**, type the repo name to confirm, and enter the **company's
   GitHub username** as the new owner. Send it.
4. **[Company]** signs in to the new GitHub account, checks email / GitHub
   notifications, and clicks **Accept** on the transfer.

✅ Done when the repo appears under the company's GitHub account.

---

## Part 2 — Vercel (what puts the app online)

Vercel is linked to GitHub, so **finish Part 1 first.** Pick one option:

### Option A — Re-import (simplest)

1. **[Company]** signs in to vercel.com with the new company account.
2. Click **Add New… → Project**, and **Import** the `las-muns-stock-ordering`
   repo (now under the company's GitHub).
3. Before deploying, open the **Environment Variables** section and paste in the
   settings from the old project. (The **[Developer]** can copy these from the old
   Vercel project under **Settings → Environment Variables** — the list of names is
   in `HANDOFF.md`, section 6.)
4. Click **Deploy**. When it finishes, the app is live under the company's Vercel.
5. The old Vercel project can then be deleted.

### Option B — Transfer the existing project

1. **[Developer]** opens the project in Vercel → **Settings → Advanced →
   Transfer Project**, and sends it to the company's Vercel team.
2. **[Company]** accepts.

✅ Done when the app loads and the project is under the company's Vercel account.

---

## Part 3 — Supabase (the database — most important)

1. **[Company]** makes sure they have a Supabase **organization** (create a free
   one at supabase.com if needed).
2. **[Developer]** opens the project in supabase.com → **Project Settings →
   General → Transfer project**.
3. Choose the **company's organization** as the destination and confirm.
4. **[Company]** accepts (check email / the Supabase dashboard).

Nothing about the data changes — it's the same database, just owned by the
company now.

✅ Done when the project shows under the company's Supabase organization.

---

## Part 4 — Final checks

1. Open the app: **https://lasmuns.vercel.app** — it should load and let you log
   in normally.
2. Make sure the company has at least one **manager login for the app itself**
   (the boss account). If not, ask the developer to set one up — `HANDOFF.md`,
   section 9.
3. Store the three new logins (GitHub, Vercel, Supabase) somewhere safe that
   **more than one** trusted person at the company can reach.

---

## If you get stuck

- On each site, the button you want is usually **“Transfer,”** found under
  **Settings**.
- The receiving (company) side almost always has to **Accept** — check email and
  the site's notifications.
- If a Transfer option looks greyed out, it's usually because the destination
  account/organization needs to be created or selected first.
- Everything more technical is in **`HANDOFF.md`** at the top of the code repository.
