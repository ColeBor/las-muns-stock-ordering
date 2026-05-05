"use client";

import { useRouter } from "next/navigation";

export default function BackButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.back()}
      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-900/60 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-cyan-300 hover:text-cyan-300"
    >
      <span aria-hidden>←</span> Back
    </button>
  );
}
