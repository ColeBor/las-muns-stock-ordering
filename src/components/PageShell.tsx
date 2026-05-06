import Link from "next/link";
import type { ReactNode } from "react";
import BackButton from "./BackButton";

export default function PageShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-50">
      <div
        className={`mx-auto flex min-h-screen flex-col px-6 py-16 sm:px-10 ${
          wide ? "max-w-[100rem]" : "max-w-6xl"
        }`}
      >
        <nav className="mb-6 flex items-center gap-2">
          <BackButton />
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-900/60 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-cyan-300 hover:text-cyan-300"
          >
            <span aria-hidden>⌂</span> Home
          </Link>
        </nav>
        {children}
      </div>
    </main>
  );
}
