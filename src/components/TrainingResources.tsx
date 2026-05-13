"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Profile = {
  id: string;
  role: string | null;
  store_id: string | null;
};

type Store = { id: string; name: string };

type ResourceKind = "video" | "document";
type SourceType = "upload" | "url";

type Resource = {
  id: string;
  title: string;
  description: string | null;
  kind: ResourceKind;
  source_type: SourceType;
  storage_path: string | null;
  source_url: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

// Detect known hosts and return an embeddable URL. Returns null for anything
// we don't recognize — those fall back to an "Open link" button.
//
// Supported transformations:
//   YouTube → /embed/<id>
//   Vimeo → player.vimeo.com/video/<id>
//   Google Docs / Sheets / Slides → /preview (allows iframe)
//   Google Drive file → /preview
//   Direct .pdf URLs → as-is (browsers render PDFs inline in iframes)
function toEmbedUrl(raw: string): string | null {
  // YouTube: youtu.be/<id>, youtube.com/watch?v=<id>, youtube.com/embed/<id>
  const yt = raw.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})/,
  );
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  // Vimeo: vimeo.com/<id> or player.vimeo.com/video/<id>
  const vm = raw.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  // Google Docs / Sheets / Slides — swap /edit (or anything) for /preview.
  const gdoc = raw.match(
    /docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/,
  );
  if (gdoc) return `https://docs.google.com/${gdoc[1]}/d/${gdoc[2]}/preview`;
  // Google Drive file (PDFs, images, etc.)
  const gdrive = raw.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (gdrive) return `https://drive.google.com/file/d/${gdrive[1]}/preview`;
  // Dropbox: www.dropbox.com sets X-Frame-Options that block iframes, but
  // dl.dropboxusercontent.com serves the file body raw and can be embedded.
  // Also flip `dl=0` (preview mode) to `raw=1` so the file streams directly.
  if (/(?:^|\/\/)(?:www\.)?dropbox\.com\/(?:s|scl\/fi)\//i.test(raw)) {
    return raw
      .replace(/^(https?:\/\/)(?:www\.)?dropbox\.com/i, "https://dl.dropboxusercontent.com")
      .replace(/([?&])dl=0\b/, "$1raw=1");
  }
  // Direct PDF URL — browsers can embed application/pdf in an iframe.
  if (/\.pdf(\?|#|$)/i.test(raw)) return raw;
  return null;
}

const STORAGE_BUCKET = "training-resources";
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function TrainingResources() {
  const [session, setSession] = useState<
    Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null
  >(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [openResourceId, setOpenResourceId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isEmployee = useMemo(() => profile?.role === "employee", [profile]);
  const isStoreManager = useMemo(() => profile?.role === "store_manager", [profile]);
  const hasAssignedStore = useMemo(() => !!profile?.store_id, [profile]);
  const canViewLibrary = (isEmployee && hasAssignedStore) || isStoreManager;

  useEffect(() => {
    const loadSession = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
    };
    loadSession();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sessionData) => {
      setSession(sessionData ?? null);
    });
    return () => {
      listener?.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const loadProfile = async () => {
      if (!session?.user) {
        setProfile(null);
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("id,role,store_id")
        .eq("id", session.user.id)
        .single();
      setProfile((data as Profile) ?? null);
    };
    loadProfile();
  }, [session]);

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

  // Library = resources visible to this user. RLS does the gatekeeping:
  // - Employees only get rows assigned to their store
  // - Store Managers see everything; in their case we restrict client-side
  //   to the store they have assigned (if any) for parity with the
  //   Employee view. They can see the full catalogue on the admin page.
  const loadResources = useCallback(async () => {
    if (!canViewLibrary) {
      setResources([]);
      return;
    }
    if (isStoreManager && !profile?.store_id) {
      // Store Manager without an assigned store sees nothing here — they
      // browse via the admin page. Avoid dumping the full catalogue.
      setResources([]);
      return;
    }
    if (isStoreManager && profile?.store_id) {
      // Filter the catalogue down to the manager's own store assignment so
      // they see the same library their employees would.
      const { data, error } = await supabase
        .from("training_resource_stores")
        .select(
          "training_resources!inner(id,title,description,kind,source_type,storage_path,source_url,mime_type,file_size_bytes,sort_order,created_at,updated_at)",
        )
        .eq("store_id", profile.store_id)
        .order("sort_order", {
          ascending: true,
          referencedTable: "training_resources",
        });
      if (error) {
        setMessage(`Couldn't load library: ${error.message}`);
        setResources([]);
        return;
      }
      type JoinRow = { training_resources: Resource | Resource[] | null };
      const mapped = ((data ?? []) as unknown as JoinRow[])
        .map((row) =>
          Array.isArray(row.training_resources) ? row.training_resources[0] : row.training_resources,
        )
        .filter((r): r is Resource => !!r);
      setResources(mapped);
      return;
    }
    // Employee path — RLS already filters to their store.
    const { data, error } = await supabase
      .from("training_resources")
      .select(
        "id,title,description,kind,source_type,storage_path,source_url,mime_type,file_size_bytes,sort_order,created_at,updated_at",
      )
      .order("sort_order", { ascending: true });
    if (error) {
      setMessage(`Couldn't load library: ${error.message}`);
      return;
    }
    setResources((data as Resource[]) ?? []);
  }, [canViewLibrary, isStoreManager, profile?.store_id]);

  useEffect(() => {
    loadResources();
  }, [loadResources]);

  useRealtimeRefetch(
    canViewLibrary
      ? [
          { table: "training_resources" },
          { table: "training_resource_stores" },
        ]
      : [],
    loadResources,
    `training-library-${profile?.store_id ?? "none"}`,
  );

  const videos = useMemo(
    () => resources.filter((r) => r.kind === "video"),
    [resources],
  );
  const documents = useMemo(
    () => resources.filter((r) => r.kind === "document"),
    [resources],
  );

  // Lazy-fetch a signed URL the first time an UPLOADED resource is opened.
  // URLs cache for the page life so re-opening doesn't re-roundtrip; they
  // auto-expire on the server side after SIGNED_URL_TTL_SECONDS. URL-sourced
  // resources don't need this — the external URL is used directly.
  const openResource = async (resource: Resource) => {
    // Clear any stale error from a previous click — even when we're just
    // collapsing this row or opening a URL-source resource that doesn't
    // touch storage.
    setMessage(null);
    if (openResourceId === resource.id) {
      setOpenResourceId(null);
      return;
    }
    setOpenResourceId(resource.id);
    if (resource.source_type === "url") return; // no signed URL needed
    if (signedUrls[resource.id]) return;
    if (!resource.storage_path) {
      setMessage("This resource is missing a file.");
      return;
    }
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(resource.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      const raw = error?.message ?? "";
      const friendly =
        /not found/i.test(raw)
          ? "This file is no longer available. Ask a Store Manager to re-upload it."
          : raw || "Couldn't open this file. Try again or ask a Store Manager.";
      setMessage(friendly);
      return;
    }
    setSignedUrls((prev) => ({ ...prev, [resource.id]: data.signedUrl }));
  };

  const formatDateTime = (iso: string) => new Date(iso).toLocaleString();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const renderResourceCard = (r: Resource) => {
    const isOpen = openResourceId === r.id;
    const signed = signedUrls[r.id];
    const embedUrl =
      r.source_type === "url" && r.source_url ? toEmbedUrl(r.source_url) : null;
    return (
      <div
        key={r.id}
        className="rounded-2xl border border-white/10 bg-slate-900/60 p-5 space-y-3"
      >
        <button
          type="button"
          onClick={() => openResource(r)}
          className="w-full text-left"
        >
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-base font-semibold text-white">{r.title}</span>
                {r.source_type === "url" && (
                  <span className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-700/60 px-2 py-0.5 text-xs font-semibold text-slate-300">
                    link
                  </span>
                )}
              </div>
              {r.description && (
                <p className="mt-1 text-sm text-slate-300 whitespace-pre-wrap">{r.description}</p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                {r.source_type === "upload"
                  ? formatBytes(r.file_size_bytes)
                  : "External link"}
                {" "}· Updated {formatDateTime(r.updated_at)}
              </p>
            </div>
            <span className="text-xs text-cyan-300">{isOpen ? "Hide" : "Open"}</span>
          </div>
        </button>
        {isOpen && (
          <div className="rounded-xl bg-slate-950/60 p-3">
            {r.source_type === "url" && r.source_url ? (
              embedUrl ? (
                <iframe
                  src={embedUrl}
                  title={r.title}
                  className="w-full rounded-lg"
                  // Videos get a 16:9 box; documents get a taller pane so
                  // they're actually readable inline without scrolling the
                  // outer page.
                  style={
                    r.kind === "video"
                      ? { aspectRatio: "16 / 9", minHeight: 300 }
                      : { minHeight: 700 }
                  }
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              ) : (
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="text-sm text-slate-300">
                    Can't show this here. Open it in a new tab:
                  </p>
                  <a
                    href={r.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400"
                  >
                    Open link
                  </a>
                </div>
              )
            ) : !signed ? (
              <p className="text-sm text-slate-400">Loading…</p>
            ) : r.kind === "video" ? (
              <video
                controls
                src={signed}
                className="w-full rounded-lg"
                preload="metadata"
              >
                <track kind="captions" />
              </video>
            ) : (
              <>
                <iframe
                  src={signed}
                  title={r.title}
                  className="w-full rounded-lg"
                  style={{ minHeight: 600 }}
                />
                <a
                  href={signed}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
                >
                  Open in new tab / download
                </a>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Training &amp; Documentation</h1>
          <p className="mt-3 text-slate-400">
            Training videos and documents for your store. Click to watch or read.
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

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in.</p>
        </div>
      ) : !canViewLibrary ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You don't have access to a training library yet.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          {store && (
            <h2 className="text-xl font-semibold text-white">{store.name}</h2>
          )}

          {message && <p className="text-sm text-rose-300">{message}</p>}

          {resources.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nothing assigned to your store yet. A Store Manager will add resources here.
            </p>
          ) : (
            <div className="space-y-4">
              <details
                open
                className="group rounded-2xl border border-white/10 bg-slate-900/40 p-4"
              >
                <summary className="flex cursor-pointer items-center justify-between text-base font-semibold text-white">
                  <span>
                    Videos
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      {videos.length} {videos.length === 1 ? "item" : "items"}
                    </span>
                  </span>
                  <span className="text-xs text-slate-400 transition group-open:rotate-180">▾</span>
                </summary>
                <div className="mt-3 space-y-3">
                  {videos.length === 0 ? (
                    <p className="text-sm text-slate-500">No videos yet.</p>
                  ) : (
                    videos.map(renderResourceCard)
                  )}
                </div>
              </details>

              <details
                open
                className="group rounded-2xl border border-white/10 bg-slate-900/40 p-4"
              >
                <summary className="flex cursor-pointer items-center justify-between text-base font-semibold text-white">
                  <span>
                    Documents
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      {documents.length} {documents.length === 1 ? "item" : "items"}
                    </span>
                  </span>
                  <span className="text-xs text-slate-400 transition group-open:rotate-180">▾</span>
                </summary>
                <div className="mt-3 space-y-3">
                  {documents.length === 0 ? (
                    <p className="text-sm text-slate-500">No documents yet.</p>
                  ) : (
                    documents.map(renderResourceCard)
                  )}
                </div>
              </details>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
