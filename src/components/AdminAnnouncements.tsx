"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = { id: string; name: string };
type Kind = "manual" | "weekly" | "date";

type Announcement = {
  id: string;
  kind: Kind;
  title: string;
  body: string | null;
  all_stores: boolean;
  starts_on: string | null;
  expires_on: string | null;
  day_of_week: number | null;
  on_date: string | null;
  is_active: boolean;
  created_by_label: string | null;
  created_at: string;
};

type Assignment = { announcement_id: string; store_id: string };

// Monday-first for display; values match JS Date.getDay() (0=Sun … 6=Sat).
const DAYS: { value: number; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

const KIND_ICON: Record<Kind, string> = { manual: "📣", weekly: "🔁", date: "📅" };

function formatDate(iso: string): string {
  // Parse YYYY-MM-DD as local so it doesn't shift a day in DD/MM locales.
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString();
}

export default function AdminAnnouncements() {
  const { session, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [stores, setStores] = useState<Store[]>([]);
  const [rows, setRows] = useState<Announcement[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // Create form.
  const [kind, setKind] = useState<Kind>("manual");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [dayOfWeek, setDayOfWeek] = useState<number>(5); // default Friday
  const [onDate, setOnDate] = useState("");
  const [allStores, setAllStores] = useState(true);
  const [targetStoreIds, setTargetStoreIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isStoreManager) return;
    (async () => {
      const { data } = await supabase.from("stores").select("id,name").order("name");
      if (data) setStores(data as Store[]);
    })();
  }, [isStoreManager]);

  const load = useCallback(async () => {
    if (!isStoreManager) {
      setRows([]);
      setAssignments([]);
      return;
    }
    const [annRes, asnRes] = await Promise.all([
      supabase
        .from("announcements")
        .select(
          "id,kind,title,body,all_stores,starts_on,expires_on,day_of_week,on_date,is_active,created_by_label,created_at",
        )
        .order("created_at", { ascending: false }),
      supabase.from("announcement_stores").select("announcement_id,store_id"),
    ]);
    if (annRes.error) {
      setMessage(`Couldn't load announcements: ${annRes.error.message}`);
      return;
    }
    setRows((annRes.data as Announcement[]) ?? []);
    setAssignments((asnRes.data as Assignment[]) ?? []);
  }, [isStoreManager]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(
    isStoreManager
      ? [{ table: "announcements" }, { table: "announcement_stores" }]
      : [],
    load,
    "admin-announcements",
  );

  const storeNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of stores) map[s.id] = s.name;
    return map;
  }, [stores]);

  const assignmentsByAnnouncement = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const a of assignments) {
      (map[a.announcement_id] ??= []).push(a.store_id);
    }
    return map;
  }, [assignments]);

  const toggleTargetStore = (id: string) => {
    setTargetStoreIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const resetForm = () => {
    setKind("manual");
    setTitle("");
    setBody("");
    setStartsOn("");
    setExpiresOn("");
    setDayOfWeek(5);
    setOnDate("");
    setAllStores(true);
    setTargetStoreIds([]);
  };

  const handleCreate = async () => {
    if (!title.trim()) {
      setMessage("Add a title.");
      return;
    }
    if (kind === "date" && !onDate) {
      setMessage("Pick a date for this reminder.");
      return;
    }
    if (startsOn && expiresOn && expiresOn < startsOn) {
      setMessage("The end date can't be before the start date.");
      return;
    }
    if (!allStores && targetStoreIds.length === 0) {
      setMessage("Pick at least one store, or switch to All stores.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        kind,
        title: title.trim(),
        body: body.trim() || null,
        all_stores: allStores,
        starts_on: kind === "manual" && startsOn ? startsOn : null,
        expires_on: kind === "manual" && expiresOn ? expiresOn : null,
        day_of_week: kind === "weekly" ? dayOfWeek : null,
        on_date: kind === "date" ? onDate : null,
        is_active: true,
        created_by_user_id: session?.user?.id ?? null,
        created_by_label: session?.user?.email ?? null,
      };
      const { data: inserted, error: insErr } = await supabase
        .from("announcements")
        .insert([payload])
        .select("id")
        .single();
      if (insErr || !inserted) {
        setMessage(insErr?.message ?? "Couldn't save.");
        return;
      }
      if (!allStores) {
        const annId = (inserted as { id: string }).id;
        const { error: asnErr } = await supabase
          .from("announcement_stores")
          .insert(targetStoreIds.map((sid) => ({ announcement_id: annId, store_id: sid })));
        if (asnErr) {
          setMessage(`Saved, but failed to set stores: ${asnErr.message}`);
          return;
        }
      }
      setMessage("Posted.");
      resetForm();
      load();
    } catch (err) {
      setMessage(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (a: Announcement) => {
    setMessage(null);
    const { error } = await supabase
      .from("announcements")
      .update({ is_active: !a.is_active })
      .eq("id", a.id);
    if (error) setMessage(error.message);
    else load();
  };

  const handleDelete = async (a: Announcement) => {
    if (!confirm(`Delete "${a.title}"?`)) return;
    setMessage(null);
    const { error } = await supabase.from("announcements").delete().eq("id", a.id);
    if (error) setMessage(error.message);
    else load();
  };

  const scheduleSummary = (a: Announcement): string => {
    if (a.kind === "weekly") {
      return `Every ${DAYS.find((d) => d.value === a.day_of_week)?.label ?? "—"}`;
    }
    if (a.kind === "date") {
      return a.on_date ? `On ${formatDate(a.on_date)}` : "On a date";
    }
    if (a.starts_on && a.expires_on) return `${formatDate(a.starts_on)} – ${formatDate(a.expires_on)}`;
    if (a.expires_on) return `Until ${formatDate(a.expires_on)}`;
    if (a.starts_on) return `From ${formatDate(a.starts_on)}`;
    return "Always showing";
  };

  const targetSummary = (a: Announcement): string => {
    if (a.all_stores) return "All stores";
    const ids = assignmentsByAnnouncement[a.id] ?? [];
    if (ids.length === 0) return "No stores";
    return ids.map((sid) => storeNameById[sid] ?? sid).join(", ");
  };

  const inputClass =
    "mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400";

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div>
        <h1 className="text-3xl font-semibold text-white">Announcements</h1>
        <p className="mt-3 text-slate-400">
          Post messages and recurring reminders for store staff. Weekly and dated
          reminders appear automatically on their day; manual posts show until they
          expire.
        </p>
      </div>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">Loading…</div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">Please sign in.</div>
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          This page is only available to Store Managers.
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {/* Create form */}
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 space-y-4">
            <h2 className="text-lg font-semibold text-white">New announcement</h2>

            {/* Kind selector */}
            <div>
              <p className="block text-sm font-medium text-slate-300">Type</p>
              <div className="mt-2 inline-flex flex-wrap gap-1 rounded-full bg-slate-950 p-1 border border-white/10">
                {(
                  [
                    { v: "manual", l: "📣 Message" },
                    { v: "weekly", l: "🔁 Weekly reminder" },
                    { v: "date", l: "📅 On a date" },
                  ] as { v: Kind; l: string }[]
                ).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setKind(opt.v)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                      kind === opt.v ? "bg-cyan-500 text-slate-950" : "text-slate-300 hover:text-white"
                    }`}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="ann-title" className="block text-sm font-medium text-slate-300">
                Title
              </label>
              <input
                id="ann-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={inputClass}
                placeholder={
                  kind === "weekly" ? "e.g. Oven cleaning day" : "e.g. Large scheduled order Tuesday"
                }
              />
            </div>

            <div>
              <label htmlFor="ann-body" className="block text-sm font-medium text-slate-300">
                Details (optional)
              </label>
              <textarea
                id="ann-body"
                rows={3}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className={inputClass}
                placeholder="Anything staff should know…"
              />
            </div>

            {/* Schedule fields by kind */}
            {kind === "weekly" && (
              <div>
                <label htmlFor="ann-dow" className="block text-sm font-medium text-slate-300">
                  Day of week
                </label>
                <select
                  id="ann-dow"
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(parseInt(e.target.value, 10))}
                  className={inputClass}
                >
                  {DAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {kind === "date" && (
              <div>
                <label htmlFor="ann-date" className="block text-sm font-medium text-slate-300">
                  Date
                </label>
                <input
                  id="ann-date"
                  type="date"
                  value={onDate}
                  onChange={(e) => setOnDate(e.target.value)}
                  className={inputClass}
                />
              </div>
            )}

            {kind === "manual" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="ann-start" className="block text-sm font-medium text-slate-300">
                    Show from (optional)
                  </label>
                  <input
                    id="ann-start"
                    type="date"
                    value={startsOn}
                    onChange={(e) => setStartsOn(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="ann-expire" className="block text-sm font-medium text-slate-300">
                    Hide after (optional)
                  </label>
                  <input
                    id="ann-expire"
                    type="date"
                    value={expiresOn}
                    onChange={(e) => setExpiresOn(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
            )}

            {/* Targeting */}
            <div>
              <p className="block text-sm font-medium text-slate-300">Who sees it</p>
              <div className="mt-2 inline-flex gap-1 rounded-full bg-slate-950 p-1 border border-white/10">
                <button
                  type="button"
                  onClick={() => setAllStores(true)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    allStores ? "bg-cyan-500 text-slate-950" : "text-slate-300 hover:text-white"
                  }`}
                >
                  All stores
                </button>
                <button
                  type="button"
                  onClick={() => setAllStores(false)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    !allStores ? "bg-cyan-500 text-slate-950" : "text-slate-300 hover:text-white"
                  }`}
                >
                  Specific stores
                </button>
              </div>
              {!allStores && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {stores.length === 0 ? (
                    <span className="text-xs text-slate-500">
                      No stores yet — create one under Directory.
                    </span>
                  ) : (
                    stores.map((s) => {
                      const selected = targetStoreIds.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => toggleTargetStore(s.id)}
                          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                            selected
                              ? "bg-cyan-500 text-slate-950"
                              : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                          }`}
                        >
                          {selected ? "✓ " : ""}
                          {s.name}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            <div>
              <button
                type="button"
                onClick={handleCreate}
                disabled={saving || !title.trim() || (kind === "date" && !onDate)}
                className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
              >
                {saving ? "Posting…" : "Post announcement"}
              </button>
            </div>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {/* List */}
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-white">All announcements</h2>
            {rows.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing posted yet.</p>
            ) : (
              rows.map((a) => (
                <div
                  key={a.id}
                  className={`rounded-2xl border bg-slate-900/60 p-5 ${
                    a.is_active ? "border-white/10" : "border-white/5 opacity-60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span aria-hidden>{KIND_ICON[a.kind]}</span>
                        <span className="text-sm font-semibold text-white">{a.title}</span>
                        {!a.is_active && (
                          <span className="rounded-full bg-slate-700/60 px-2 py-0.5 text-xs font-semibold text-slate-300">
                            paused
                          </span>
                        )}
                      </div>
                      {a.body && (
                        <p className="mt-1 text-sm text-slate-300 whitespace-pre-wrap">{a.body}</p>
                      )}
                      <p className="mt-1 text-xs text-slate-500">
                        {scheduleSummary(a)} · {targetSummary(a)}
                        {a.created_by_label ? ` · by ${a.created_by_label}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleActive(a)}
                        className="rounded-full bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
                      >
                        {a.is_active ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(a)}
                        className="rounded-full bg-rose-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-rose-400"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
