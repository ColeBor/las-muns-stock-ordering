"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = { id: string; name: string };

type RequestCategory = "Store Issue" | "Request" | "Complaint" | "Question" | "Other" | "Shortages";
type RequestStatus = "open" | "in_progress" | "need_info" | "resolved" | "dismissed";

type EmployeeRequest = {
  id: string;
  store_id: string;
  submitted_by_user_id: string | null;
  submitted_by_label: string | null;
  category: RequestCategory;
  complaint_against: string | null;
  description: string;
  status: RequestStatus;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
};

type RequestComment = {
  id: string;
  request_id: string;
  author_user_id: string | null;
  author_label: string | null;
  author_role: "hq" | "employee";
  body: string;
  created_at: string;
};

const CATEGORIES: RequestCategory[] = [
  "Store Issue",
  "Request",
  "Complaint",
  "Question",
  "Other",
];

const STATUS_ORDER: RequestStatus[] = ["open", "need_info", "in_progress", "resolved", "dismissed"];

const STATUS_LABEL: Record<RequestStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  need_info: "Need Info",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

const STATUS_CLASS: Record<RequestStatus, string> = {
  open: "bg-amber-500/20 text-amber-200",
  in_progress: "bg-cyan-500/20 text-cyan-200",
  need_info: "bg-purple-500/20 text-purple-200",
  resolved: "bg-emerald-500/20 text-emerald-200",
  dismissed: "bg-slate-500/20 text-slate-300",
};

export default function AdminEmployeeRequests() {
  const { session, profile, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [stores, setStores] = useState<Store[]>([]);
  const [requests, setRequests] = useState<EmployeeRequest[]>([]);
  const [commentsByRequest, setCommentsByRequest] = useState<Record<string, RequestComment[]>>({});
  const [message, setMessage] = useState<string | null>(null);

  // Shortages (stock running low, requested outside the delivery cycle) get
  // their own tab, split out from general requests.
  const [tab, setTab] = useState<"requests" | "shortages">("requests");

  // Filters
  const [filterStatus, setFilterStatus] = useState<"" | RequestStatus | "open_set">("open_set");
  const [filterCategory, setFilterCategory] = useState<"" | RequestCategory>("");
  const [filterStore, setFilterStore] = useState<string>("");

  // Per-request UI state
  const [needInfoDraft, setNeedInfoDraft] = useState<Record<string, string>>({});
  const [resolveDraft, setResolveDraft] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [needInfoSavingId, setNeedInfoSavingId] = useState<string | null>(null);
  const [statusSavingId, setStatusSavingId] = useState<string | null>(null);

  // Mark the admin requests log as "seen now" on mount and on unmount so
  // the home-page ⚠ icon clears after visiting and only re-appears if a
  // new submission or comment lands afterwards. Mirrors the employee-side
  // lm-requests-last-seen behavior.
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("lm-admin-requests-last-seen", new Date().toISOString());
    return () => {
      localStorage.setItem("lm-admin-requests-last-seen", new Date().toISOString());
    };
  }, []);

  useEffect(() => {
    if (!isStoreManager) return;
    const loadStores = async () => {
      const { data } = await supabase.from("stores").select("id,name").order("name");
      if (data) setStores(data as Store[]);
    };
    loadStores();
  }, [isStoreManager]);

  const loadRequests = useCallback(async () => {
    if (!isStoreManager) {
      setRequests([]);
      return;
    }
    let q = supabase
      .from("employee_requests")
      .select(
        "id,store_id,submitted_by_user_id,submitted_by_label,category,complaint_against,description,status,resolution_note,created_at,updated_at",
      )
      .order("updated_at", { ascending: false });
    // The two tabs partition by category: Shortages in its own tab, everything
    // else in Requests. The category filter only applies within the Requests tab.
    if (tab === "shortages") {
      q = q.eq("category", "Shortages");
    } else {
      q = q.neq("category", "Shortages");
      if (filterCategory) q = q.eq("category", filterCategory);
    }
    if (filterStore) q = q.eq("store_id", filterStore);
    if (filterStatus === "open_set") {
      q = q.in("status", ["open", "need_info", "in_progress"]);
    } else if (filterStatus) {
      q = q.eq("status", filterStatus);
    }
    const { data, error } = await q;
    if (error) {
      setMessage(`Couldn't load requests: ${error.message}`);
      setRequests([]);
      return;
    }
    setRequests((data as EmployeeRequest[]) ?? []);
  }, [isStoreManager, tab, filterStore, filterCategory, filterStatus]);

  const loadComments = useCallback(async () => {
    if (!isStoreManager) {
      setCommentsByRequest({});
      return;
    }
    const ids = requests.map((r) => r.id);
    if (ids.length === 0) {
      setCommentsByRequest({});
      return;
    }
    const { data, error } = await supabase
      .from("employee_request_comments")
      .select("id,request_id,author_user_id,author_label,author_role,body,created_at")
      .in("request_id", ids)
      .order("created_at", { ascending: true });
    if (error) {
      setMessage(`Couldn't load comments: ${error.message}`);
      return;
    }
    const grouped: Record<string, RequestComment[]> = {};
    for (const c of (data as RequestComment[]) ?? []) {
      if (!grouped[c.request_id]) grouped[c.request_id] = [];
      grouped[c.request_id].push(c);
    }
    setCommentsByRequest(grouped);
  }, [isStoreManager, requests]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "employee_requests" },
          { table: "employee_request_comments" },
        ]
      : [],
    useCallback(() => {
      loadRequests();
      loadComments();
    }, [loadRequests, loadComments]),
    "admin-employee-requests",
  );

  const storeNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of stores) map[s.id] = s.name;
    return map;
  }, [stores]);

  const setStatus = async (req: EmployeeRequest, next: RequestStatus, opts?: { resolutionNote?: string }) => {
    setStatusSavingId(req.id);
    setMessage(null);
    const update: Record<string, unknown> = { status: next };
    if (next === "resolved") {
      update.resolution_note = opts?.resolutionNote ?? null;
    } else if (req.status === "resolved") {
      // Re-opening a resolved request clears the resolution note so it
      // doesn't dangle on a non-resolved status.
      update.resolution_note = null;
    }
    try {
      const { error } = await supabase
        .from("employee_requests")
        .update(update)
        .eq("id", req.id);
      if (error) {
        setMessage(error.message);
        return false;
      }
      loadRequests();
      return true;
    } catch (err) {
      setMessage(`Couldn't update status: ${err instanceof Error ? err.message : "network timeout"}. Try again.`);
      return false;
    } finally {
      setStatusSavingId(null);
    }
  };

  const handleMarkInProgress = (req: EmployeeRequest) => setStatus(req, "in_progress");
  const handleMarkDismissed = (req: EmployeeRequest) => setStatus(req, "dismissed");
  const handleReopen = (req: EmployeeRequest) => setStatus(req, "open");

  const handleRequestNeedInfo = async (req: EmployeeRequest) => {
    const body = (needInfoDraft[req.id] ?? "").trim();
    if (!body) {
      setMessage("Add a Need-Info question for the worker.");
      return;
    }
    setNeedInfoSavingId(req.id);
    setMessage(null);
    try {
      const { error: cErr } = await supabase.from("employee_request_comments").insert([
        {
          request_id: req.id,
          author_user_id: session?.user?.id ?? null,
          author_label: session?.user?.email ?? null,
          author_role: "hq",
          body,
        },
      ]);
      if (cErr) {
        setMessage(cErr.message);
        return;
      }
      const { error: sErr } = await supabase
        .from("employee_requests")
        .update({ status: "need_info" })
        .eq("id", req.id);
      if (sErr) {
        setMessage(sErr.message);
        return;
      }
      setNeedInfoDraft((prev) => ({ ...prev, [req.id]: "" }));
      loadRequests();
      loadComments();
    } catch (err) {
      setMessage(`Couldn't request info: ${err instanceof Error ? err.message : "network timeout"}. Try again.`);
    } finally {
      setNeedInfoSavingId(null);
    }
  };


  const openResolveForm = (req: EmployeeRequest) => {
    setResolvingId(req.id);
    setResolveDraft((prev) => ({ ...prev, [req.id]: req.resolution_note ?? "" }));
  };

  const cancelResolve = () => {
    setResolvingId(null);
  };

  const handleConfirmResolve = async (req: EmployeeRequest) => {
    const note = (resolveDraft[req.id] ?? "").trim();
    if (!note) {
      setMessage("Add a resolution note describing how it was resolved.");
      return;
    }
    const ok = await setStatus(req, "resolved", { resolutionNote: note });
    if (ok) setResolvingId(null);
  };

  const formatDateTime = (iso: string) => new Date(iso).toLocaleString();

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div>
        <h1 className="text-3xl font-semibold text-white">Employee Requests</h1>
        <p className="mt-3 text-slate-400">
          Every request, issue, and complaint from your team. Employees can&apos;t see each other&apos;s complaints — only you can.
        </p>
      </div>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in.</p>
        </div>
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Store Managers.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex gap-2 border-b border-white/10">
            {(["requests", "shortages"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium transition border-b-2 ${
                  tab === t
                    ? "border-cyan-400 text-cyan-300"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                {t === "requests" ? "Requests" : "Shortages"}
              </button>
            ))}
          </div>

          <div className="flex items-end gap-3 flex-wrap rounded-2xl border border-white/10 bg-slate-900/60 p-4">
            <div>
              <label className="block text-xs font-medium text-slate-400">Status</label>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as typeof filterStatus)}
                className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
              >
                <option value="open_set">Active (Open · Need Info · In Progress)</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
                <option value="">All</option>
              </select>
            </div>
            {tab !== "shortages" && (
              <div>
                <label className="block text-xs font-medium text-slate-400">Category</label>
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value as typeof filterCategory)}
                  className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                >
                  <option value="">All categories</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-400">Store</label>
              <select
                value={filterStore}
                onChange={(e) => setFilterStore(e.target.value)}
                className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
              >
                <option value="">All stores</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="text-sm text-slate-300 ml-auto">
              {requests.length} {requests.length === 1 ? "request" : "requests"}
            </div>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {requests.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing matches these filters.</p>
          ) : (
            <div className="space-y-4">
              {requests.map((req) => {
                const comments = commentsByRequest[req.id] ?? [];
                const resolving = resolvingId === req.id;
                return (
                  <div
                    key={req.id}
                    className="rounded-2xl border border-white/10 bg-slate-900/60 p-5 space-y-3"
                  >
                    <div className="flex items-start justify-between flex-wrap gap-2">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-white">{req.category}</span>
                          {req.category === "Complaint" && req.complaint_against && (
                            <span className="text-xs text-rose-300">against {req.complaint_against}</span>
                          )}
                          <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[req.status]}`}>
                            {STATUS_LABEL[req.status]}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {storeNameById[req.store_id] ?? req.store_id} · {formatDateTime(req.created_at)} · by {req.submitted_by_label ?? "—"}
                        </p>
                      </div>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-slate-200">{req.description}</p>

                    {comments.length > 0 && (
                      <div className="space-y-2 rounded-xl bg-slate-950/50 p-3">
                        {comments.map((c) => (
                          <div key={c.id} className="text-sm">
                            <div className="flex items-baseline gap-2">
                              <span className={`text-xs font-semibold uppercase tracking-wider ${c.author_role === "hq" ? "text-purple-300" : "text-cyan-300"}`}>
                                {c.author_role === "hq" ? "Manager" : "Store"}
                              </span>
                              <span className="text-xs text-slate-500">
                                {c.author_label ? `${c.author_label} · ` : ""}{formatDateTime(c.created_at)}
                              </span>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-slate-200">{c.body}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {req.resolution_note && (
                      <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">
                        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-300">Resolution</p>
                        <p className="mt-1 whitespace-pre-wrap">{req.resolution_note}</p>
                      </div>
                    )}

                    {/* Actions */}
                    {req.status !== "resolved" && req.status !== "dismissed" && !resolving && (
                      <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-white/5">
                        {req.status !== "in_progress" && (
                          <button
                            type="button"
                            onClick={() => handleMarkInProgress(req)}
                            disabled={statusSavingId === req.id}
                            className="rounded-full bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
                          >
                            Mark In Progress
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openResolveForm(req)}
                          className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400"
                        >
                          Resolve…
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMarkDismissed(req)}
                          disabled={statusSavingId === req.id}
                          className="rounded-full bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-600 disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}

                    {/* Need Info */}
                    {req.status !== "resolved" && req.status !== "dismissed" && !resolving && (
                      <div className="space-y-2 pt-2 border-t border-white/5">
                        <p className="text-xs font-semibold uppercase tracking-wider text-purple-300">Ask the worker for more info</p>
                        <textarea
                          value={needInfoDraft[req.id] ?? ""}
                          onChange={(e) =>
                            setNeedInfoDraft((prev) => ({ ...prev, [req.id]: e.target.value }))
                          }
                          rows={2}
                          placeholder="What additional info do you need?"
                          className="w-full rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                        />
                        <button
                          type="button"
                          onClick={() => handleRequestNeedInfo(req)}
                          disabled={needInfoSavingId === req.id || !(needInfoDraft[req.id] ?? "").trim()}
                          className="rounded-full bg-purple-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-purple-400 disabled:opacity-50"
                        >
                          {needInfoSavingId === req.id ? "Sending..." : "Request Info"}
                        </button>
                      </div>
                    )}

                    {resolving && (
                      <div className="space-y-2 rounded-xl bg-slate-950/60 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-300">Resolution note (required)</p>
                        <textarea
                          value={resolveDraft[req.id] ?? ""}
                          onChange={(e) =>
                            setResolveDraft((prev) => ({ ...prev, [req.id]: e.target.value }))
                          }
                          rows={3}
                          placeholder="How was this resolved? (visible to the submitter)"
                          className="w-full rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleConfirmResolve(req)}
                            disabled={statusSavingId === req.id || !(resolveDraft[req.id] ?? "").trim()}
                            className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                          >
                            {statusSavingId === req.id ? "Saving..." : "Confirm Resolve"}
                          </button>
                          <button
                            type="button"
                            onClick={cancelResolve}
                            className="text-xs text-slate-400 hover:text-slate-200"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Resolved/Dismissed actions */}
                    {(req.status === "resolved" || req.status === "dismissed") && (
                      <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-white/5">
                        <button
                          type="button"
                          onClick={() => handleReopen(req)}
                          disabled={statusSavingId === req.id}
                          className="rounded-full bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-600 disabled:opacity-50"
                        >
                          Re-open
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
