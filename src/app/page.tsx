import SupabaseAuthClient from "@/components/SupabaseAuthClient";

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-6 py-16 sm:px-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-10 shadow-2xl shadow-slate-950/40 backdrop-blur-xl">
            <div className="flex flex-col gap-6">
              <div className="space-y-3">
                <p className="inline-flex rounded-full bg-cyan-500/10 px-4 py-1 text-sm font-semibold uppercase tracking-[0.24em] text-cyan-300 ring-1 ring-cyan-300/20">
                  Stock ordering platform
                </p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  Multi-store stock ordering, allocation, and cycle management.
                </h1>
                <p className="max-w-3xl text-lg leading-8 text-slate-300">
                  A Next.js + Supabase + AG Grid app for retail order cycles, factory stock allocation, purchase order generation, and store inventory planning.
                </p>
              </div>

              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <a
                    href="#roadmap"
                    className="inline-flex items-center justify-center rounded-full border border-white/10 px-4 py-2 text-xs font-medium text-slate-300 transition hover:border-cyan-300 hover:text-cyan-300"
                  >
                    View roadmap
                  </a>
                  <a
                    href="https://github.com/ColeBor/las-muns-stock-ordering"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center rounded-full border border-white/10 px-4 py-2 text-xs font-medium text-slate-300 transition hover:border-cyan-300 hover:text-cyan-300"
                  >
                    GitHub
                  </a>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Daily workflow</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href="/store-stock-entry"
                      className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
                    >
                      Store stock entry
                    </a>
                    <a
                      href="/factory-stock"
                      className="inline-flex items-center justify-center rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
                    >
                      Factory stock
                    </a>
                    <a
                      href="/delivery-orders"
                      className="inline-flex items-center justify-center rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
                    >
                      Delivery orders
                    </a>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">HQ admin</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href="/admin/stores"
                      className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
                    >
                      Stores
                    </a>
                    <a
                      href="/admin/factories"
                      className="inline-flex items-center justify-center rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
                    >
                      Factories
                    </a>
                    <a
                      href="/admin/suppliers"
                      className="inline-flex items-center justify-center rounded-full bg-green-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-green-400"
                    >
                      Suppliers
                    </a>
                    <a
                      href="/admin/items"
                      className="inline-flex items-center justify-center rounded-full bg-purple-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-purple-400"
                    >
                      Items
                    </a>
                    <a
                      href="/admin/cycles"
                      className="inline-flex items-center justify-center rounded-full bg-yellow-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-yellow-400"
                    >
                      Cycles
                    </a>
                  </div>
                </div>
              </div>
            </div>

            <section id="roadmap" className="mt-12 rounded-3xl bg-slate-950/90 p-8 ring-1 ring-white/10">
              <h2 className="text-2xl font-semibold text-white">Build order</h2>
              <p className="mt-3 max-w-2xl text-slate-400">
                The first milestone is complete: scaffold the app, push it to GitHub, and deploy it to Vercel. Next, we’ll add the database schema, authentication, and inventory workflows.
              </p>

              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
                  <h3 className="text-lg font-semibold text-white">1. Scaffold</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    Next.js + TypeScript + Tailwind app deployed on Vercel with the initial project setup.
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
                  <h3 className="text-lg font-semibold text-white">2. Database schema</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    Supabase schema for stores, factories, items, order cycles, allocations, and purchase orders.
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
                  <h3 className="text-lg font-semibold text-white">3. Auth + roles</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    Supabase Auth with role-based access for HQ, factory users, and store managers.
                  </p>
                </div>
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <SupabaseAuthClient />
          </div>
        </div>
      </main>
    </div>
  );
}
