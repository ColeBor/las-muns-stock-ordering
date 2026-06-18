"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

// Announcement shapes — see migration 20260618140000_announcements.sql.
type Announcement = {
  id: string;
  kind: "manual" | "weekly" | "date";
  title: string;
  body: string | null;
  all_stores: boolean;
  starts_on: string | null;
  expires_on: string | null;
  day_of_week: number | null;
  on_date: string | null;
  is_active: boolean;
};

// Local YYYY-MM-DD. We compare date columns as strings (they're already
// YYYY-MM-DD) to dodge the UTC-midnight day-shift seen elsewhere in the app.
function todayLocalDate(): string {
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

const KIND_LABEL: Record<Announcement["kind"], { icon: string }> = {
  manual: { icon: "📣" },
  weekly: { icon: "🔁" },
  date: { icon: "📅" },
};

// Shown to all store staff. Renders nothing unless there's something for today,
// so it never takes up space on a quiet day.
export default function AnnouncementsFeed() {
  const { isSignedIn } = useAuthGate();
  const [rows, setRows] = useState<Announcement[]>([]);

  const load = useCallback(async () => {
    if (!isSignedIn) {
      setRows([]);
      return;
    }
    const { data, error } = await supabase
      .from("announcements")
      .select(
        "id,kind,title,body,all_stores,starts_on,expires_on,day_of_week,on_date,is_active",
      )
      .order("created_at", { ascending: false });
    if (error) {
      setRows([]);
      return;
    }
    setRows((data as Announcement[]) ?? []);
  }, [isSignedIn]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(
    isSignedIn ? [{ table: "announcements" }, { table: "announcement_stores" }] : [],
    load,
    "home-announcements-feed",
  );

  const todaysItems = useMemo(() => {
    const today = todayLocalDate();
    // JS getDay(): 0=Sunday … 6=Saturday, matching day_of_week in the DB.
    const dow = new Date().getDay();
    return rows.filter((a) => {
      if (!a.is_active) return false; // managers can see inactive via RLS
      if (a.kind === "weekly") return a.day_of_week === dow;
      if (a.kind === "date") return a.on_date === today;
      // manual: inside its optional [starts_on, expires_on] window.
      if (a.starts_on && today < a.starts_on) return false;
      if (a.expires_on && today > a.expires_on) return false;
      return true;
    });
  }, [rows]);

  if (todaysItems.length === 0) return null;

  return (
    <div className="rounded-2xl border border-amber-300/20 bg-amber-300/5 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200/80">
        📣 Announcements
      </p>
      <ul className="mt-3 space-y-2.5">
        {todaysItems.map((a) => (
          <li key={a.id} className="flex gap-2.5">
            <span className="mt-0.5 shrink-0" aria-hidden>
              {KIND_LABEL[a.kind].icon}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">{a.title}</p>
              {a.body && (
                <p className="mt-0.5 text-sm text-slate-300 whitespace-pre-wrap">{a.body}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
