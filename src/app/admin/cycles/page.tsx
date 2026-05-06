import { Suspense } from "react";
import AdminCycles from "@/components/AdminCycles";
import PageShell from "@/components/PageShell";

export default function AdminCyclesPage() {
  return (
    <PageShell>
      <Suspense fallback={<p className="text-slate-400">Loading…</p>}>
        <AdminCycles />
      </Suspense>
    </PageShell>
  );
}
