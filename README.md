# Las Muns Operations App

Internal operations app for the store chain and factory: stock ordering,
delivery allocation, baking/production forecasts, temperature & waste logging,
and staff requests. Runs on Android tablets as an installable PWA.

- **Live:** https://lasmuns.vercel.app
- **Stack:** Next.js 16 (React, TypeScript) · Supabase (Postgres, Auth, Storage,
  Realtime, pg_cron) · AG Grid · deployed on Vercel

## 📋 New owner or maintainer? Start here → [HANDOFF.md](HANDOFF.md)

`HANDOFF.md` is the full ownership-transfer and operations runbook: the accounts
the app depends on, how to transfer them, how to run and deploy, the database
migrations, scheduled jobs, and known quirks. **Read it before doing anything
else.**

Just need to move the accounts into the company's name? **[TRANSFER-GUIDE.md](TRANSFER-GUIDE.md)**
is a plain-English, click-by-click walkthrough for that part.

## Quick start (developer)

```bash
npm install
cp .env.example .env.local     # fill in real values from Vercel (see HANDOFF.md §6)
npm run dev                    # http://localhost:3000
```

Deploy = push to `master`; Vercel auto-builds. Apply any database migration
**before** deploying code that needs it. See [HANDOFF.md](HANDOFF.md) for detail.

> This runs on **Next.js 16**, whose conventions differ from older versions —
> see [AGENTS.md](AGENTS.md).
