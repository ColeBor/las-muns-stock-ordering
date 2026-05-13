import type { ReactNode } from "react";
import PageShellNav from "./PageShellNav";

export default function PageShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <div
        className={`mx-auto flex min-h-screen flex-col px-6 py-16 sm:px-10 ${
          wide ? "max-w-[100rem]" : "max-w-6xl"
        }`}
      >
        <PageShellNav />
        {children}
      </div>
    </main>
  );
}
