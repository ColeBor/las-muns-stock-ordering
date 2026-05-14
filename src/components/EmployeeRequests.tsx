"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = { id: string; name: string };

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

type RequestCategory = "Store Issue" | "Request" | "Complaint" | "Question" | "Other";
type RequestStatus = "open" | "in_progress" | "need_info" | "resolved" | "dismissed";

const CATEGORIES: RequestCategory[] = [
  "Store Issue",
  "Request",
  "Complaint",
  "Question",
  "Other",
];

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

const REQUESTS_LAST_SEEN_KEY = "lm-requests-last-seen";

export default function EmployeeRequests() {
  const { session, profile, loading: authLoading, isSignedIn, isEmployee } = useAuthGate();
  const [store, setStore] = useState<Store | null>(null);
  const [requests, setRequests] = useState<EmployeeRequest[]>([]);
  const [commentsByRequest, setCommentsByRequest] = useState<Record<string, RequestComment[]>>({});
  const [message, setMessage] = useState<string | null>(null);

  // Submit form state
  const [category, setCategory] = useState<RequestCategory | "">("");
  const [complaintAgainst, setComplaintAgainst] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reply state per request (for Need Info replies)
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [replySaving, setReplySaving] = useState<string | null>(null);

  const hasAssignedStore = useMemo(() => !!profile?.store_id, [profile]);

  // Mark the requests log as "seen now" on mount and on unmount so the
  // home-page ⚠ icon clears after visiting and only re-appears if HQ does
  // something new afterwards. Compared to `employee_requests.updated_at`,
  // which is bumped by status changes and new comments.
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(REQUESTS_LAST_SEEN_KEY, new Date().toISOString());
    return () => {
      localStorage.setItem(REQUESTS_LAST_SEEN_KEY, new Date().toISOString());
    };
  }, []);

  useEffect(() => {
    if (!profile?.store_id) {
      setStore(null);
      return;
    }
    const loadStore = async () => {
      const { data } = await supabase
        .from("stores")
        .select("id,name")
        .eq("id", profile.store_id!)
        .single();
      if (data) setStore(data as Store);
    };
    loadStore();
  }, [profile?.store_id]);

  // Load this employee's store's non-Complaint requests. RLS enforces it
  // (the employee can't read complaints even if they tried), but we also
  // filter client-side to be explicit.
  const loadRequests = useCallback(async () => {
    if (!profile?.store_id) {
      setRequests([]);
      return;
    }
    const { data, error } = await supabase
      .from("employee_requests")
      .select(
        "id,store_id,submitted_by_user_id,submitted_by_label,category,complaint_against,description,status,resolution_note,created_at,updated_at",
      )
      .eq("store_id", profile.store_id)
      .neq("category", "Complaint")
      .order("created_at", { ascending: false });
    if (error) {
      setMessage(`Couldn't load requests: ${error.message}`);
      setRequests([]);
      return;
    }
    setRequests((data as EmployeeRequest[]) ?? []);
  }, [profile?.store_id]);

  const loadComments = useCallback(async () => {
    if (!profile?.store_id) {
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
  }, [profile?.store_id, requests]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  useRealtimeRefetch(
    profile?.store_id
      ? [
          { table: "employee_requests", filter: `store_id=eq.${profile.store_id}` },
          { table: "employee_request_comments" },
        ]
      : [],
    useCallback(() => {
      loadRequests();
      loadComments();
    }, [loadRequests, loadComments]),
    `employee-requests-${profile?.store_id ?? "none"}`,
  );

  const handleSubmit = async () => {
    if (!profile?.store_id) return;
    if (!category) {
      setMessage("Pick a category.");
      return;
    }
    if (!description.trim()) {
      setMessage("Add a description.");
      return;
    }
    if (category === "Complaint" && !complaintAgainst.trim()) {
      setMessage("Who is the complaint against?");
      return;
    }
    setSubmitting(true);
    setMessage(null);
    const payload = {
      store_id: profile.store_id,
      submitted_by_user_id: session?.user?.id ?? null,
      submitted_by_label: session?.user?.email ?? null,
      category,
      complaint_against: category === "Complaint" ? complaintAgainst.trim() : null,
      description: description.trim(),
    };
    const { error } = await supabase.from("employee_requests").insert([payload]);
    setSubmitting(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setCategory("");
    setComplaintAgainst("");
    setDescription("");
    if (payload.category === "Complaint") {
      // The submitter can't see complaints in their log per design. Surface
      // an explicit confirmation so they know it actually went through.
      setMessage("Complaint sent to Store Managers. For privacy, it won't show in your list below.");
    } else {
      setMessage("Sent. A Store Manager will review it.");
    }
    loadRequests();
  };

  const handleReply = async (requestId: string) => {
    const body = (replyDraft[requestId] ?? "").trim();
    if (!body) {
      setMessage("Reply can't be empty.");
      return;
    }
    setReplySaving(requestId);
    setMessage(null);
    const { error } = await supabase.from("employee_request_comments").insert([
      {
        request_id: requestId,
        author_user_id: session?.user?.id ?? null,
        author_label: session?.user?.email ?? null,
        author_role: "employee",
        body,
      },
    ]);
    setReplySaving(null);
    if (error) {
      setMessage(error.message);
      return;
    }
    setReplyDraft((prev) => ({ ...prev, [requestId]: "" }));
    loadComments();
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const formatDateTime = (iso: string) => new Date(iso).toLocaleString();

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Requests &amp; Issues</h1>
          <p className="mt-3 text-slate-400">
            Submit a store issue, request, complaint, or question. A Store Manager will get back to you.
          </p>
        </div>
        {isSignedIn && (
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
          >
            Sign out
          </button>
        )}
      </div>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in.</p>
        </div>
      ) : !isEmployee ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is for Employees. Store Managers review requests under the admin section.</p>
        </div>
      ) : !hasAssignedStore ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a store. Please contact an administrator.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <h2 className="text-xl font-semibold text-white">{store?.name ?? "Loading..."}</h2>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 space-y-4">
            <h3 className="text-lg font-semibold text-white">New submission</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="category" className="block text-sm font-medium text-slate-300">
                  Category
                </label>
                <select
                  id="category"
                  value={category}
                  onChange={(e) => {
                    const v = e.target.value as RequestCategory | "";
                    setCategory(v);
                    if (v !== "Complaint") setComplaintAgainst("");
                  }}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                >
                  <option value="">(Select a category)</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              {category === "Complaint" && (
                <div>
                  <label htmlFor="complaint-against" className="block text-sm font-medium text-slate-300">
                    Who is the complaint against?
                  </label>
                  <input
                    id="complaint-against"
                    type="text"
                    value={complaintAgainst}
                    onChange={(e) => setComplaintAgainst(e.target.value)}
                    placeholder="Name or role"
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                  />
                </div>
              )}
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-slate-300">
                Description
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                placeholder="Describe the issue, request, or question in detail."
                className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
              />
            </div>
            {category === "Complaint" && (
              <p className="text-xs text-amber-300">
                Complaints go straight to Store Managers and stay private — they won't appear in your list.
              </p>
            )}
            <div>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
              >
                {submitting ? "Submitting..." : "Submit"}
              </button>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white">Your store's requests</h3>
            <p className="mt-1 text-sm text-slate-400">
              Your past requests. Complaints aren&apos;t shown here. If a Store Manager needs more info, reply right in the conversation.
            </p>
            {requests.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">No requests submitted yet.</p>
            ) : (
              <div className="mt-4 space-y-4">
                {requests.map((req) => {
                  const comments = commentsByRequest[req.id] ?? [];
                  const replyValue = replyDraft[req.id] ?? "";
                  return (
                    <div
                      key={req.id}
                      className="rounded-2xl border border-white/10 bg-slate-900/60 p-5 space-y-3"
                    >
                      <div className="flex items-start justify-between flex-wrap gap-2">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-white">{req.category}</span>
                            <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[req.status]}`}>
                              {STATUS_LABEL[req.status]}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {formatDateTime(req.created_at)} · by {req.submitted_by_label ?? "—"}
                          </p>
                        </div>
                      </div>
                      <p className="whitespace-pre-wrap text-sm text-slate-200">{req.description}</p>

                      {req.resolution_note && (
                        <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">
                          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-300">Resolution</p>
                          <p className="mt-1 whitespace-pre-wrap">{req.resolution_note}</p>
                        </div>
                      )}

                      {comments.length > 0 && (
                        <div className="space-y-2 rounded-xl bg-slate-950/50 p-3">
                          {comments.map((c) => (
                            <div key={c.id} className="text-sm">
                              <div className="flex items-baseline gap-2">
                                <span className={`text-xs font-semibold uppercase tracking-wider ${c.author_role === "hq" ? "text-purple-300" : "text-cyan-300"}`}>
                                  {c.author_role === "hq" ? "Manager" : "You / store"}
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

                      {req.status === "need_info" && (
                        <div className="space-y-2">
                          <textarea
                            value={replyValue}
                            onChange={(e) =>
                              setReplyDraft((prev) => ({ ...prev, [req.id]: e.target.value }))
                            }
                            rows={3}
                            placeholder="Reply with the details requested…"
                            className="w-full rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                          />
                          <button
                            type="button"
                            onClick={() => handleReply(req.id)}
                            disabled={replySaving === req.id || !replyValue.trim()}
                            className="rounded-full bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
                          >
                            {replySaving === req.id ? "Sending..." : "Send reply"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
