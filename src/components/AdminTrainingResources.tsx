"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useFormDraft } from "@/lib/useFormDraft";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

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
  created_by_label: string | null;
  created_at: string;
  updated_at: string;
};

type Assignment = { resource_id: string; store_id: string };

const STORAGE_BUCKET = "training-resources";

function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function AdminTrainingResources() {
  const { session, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [stores, setStores] = useState<Store[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // Upload form
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ResourceKind>("video");
  const [sourceType, setSourceType] = useState<SourceType>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [assignToStoreIds, setAssignToStoreIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  useFormDraft({
    key: "admin-training-resource",
    values: { title, description, kind, sourceType, sourceUrl, assignToStoreIds },
    isDirty: (v) =>
      v.title.trim() !== "" || v.description.trim() !== "" || v.sourceUrl.trim() !== "",
    onRestore: (v) => {
      if (v.title) setTitle(v.title);
      if (v.description) setDescription(v.description);
      if (v.kind) setKind(v.kind);
      if (v.sourceType) setSourceType(v.sourceType);
      if (v.sourceUrl) setSourceUrl(v.sourceUrl);
      setAssignToStoreIds(v.assignToStoreIds);
    },
    onRestored: () => setMessage("Restored your unsaved entry."),
  });

  // Per-row assignment editing
  const [editingAssignmentsId, setEditingAssignmentsId] = useState<string | null>(null);
  const [assignDraft, setAssignDraft] = useState<string[]>([]);
  const [savingAssignmentsId, setSavingAssignmentsId] = useState<string | null>(null);

  // Reorder state (which row is currently being swapped)
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  // Drag-and-drop state for free reordering within a kind section. Position
  // distinguishes "drop above target" from "drop below target" so the user
  // sees exactly where the dragged row will land.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"above" | "below" | null>(null);

  useEffect(() => {
    if (!isStoreManager) return;
    const loadStores = async () => {
      const { data } = await supabase.from("stores").select("id,name").order("name");
      if (data) setStores(data as Store[]);
    };
    loadStores();
  }, [isStoreManager]);

  const loadResources = useCallback(async () => {
    if (!isStoreManager) {
      setResources([]);
      setAssignments([]);
      return;
    }
    const [resRes, asnRes] = await Promise.all([
      supabase
        .from("training_resources")
        .select(
          "id,title,description,kind,source_type,storage_path,source_url,mime_type,file_size_bytes,sort_order,created_by_label,created_at,updated_at",
        )
        .order("sort_order", { ascending: true }),
      supabase.from("training_resource_stores").select("resource_id,store_id"),
    ]);
    if (resRes.error) {
      setMessage(`Couldn't load resources: ${resRes.error.message}`);
      return;
    }
    if (asnRes.error) {
      setMessage(`Couldn't load assignments: ${asnRes.error.message}`);
      return;
    }
    setResources((resRes.data as Resource[]) ?? []);
    setAssignments((asnRes.data as Assignment[]) ?? []);
  }, [isStoreManager]);

  useEffect(() => {
    loadResources();
  }, [loadResources]);

  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "training_resources" },
          { table: "training_resource_stores" },
        ]
      : [],
    loadResources,
    "admin-training-resources",
  );

  const assignmentsByResource = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const a of assignments) {
      if (!map[a.resource_id]) map[a.resource_id] = [];
      map[a.resource_id].push(a.store_id);
    }
    return map;
  }, [assignments]);

  const storeNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of stores) map[s.id] = s.name;
    return map;
  }, [stores]);

  const videos = useMemo(
    () => resources.filter((r) => r.kind === "video"),
    [resources],
  );
  const documents = useMemo(
    () => resources.filter((r) => r.kind === "document"),
    [resources],
  );

  const toggleAssignStore = (id: string) => {
    setAssignToStoreIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleUpload = async () => {
    if (!title.trim()) {
      setMessage("Add a title.");
      return;
    }
    if (sourceType === "upload" && !file) {
      setMessage("Pick a file first.");
      return;
    }
    if (sourceType === "url" && !sourceUrl.trim()) {
      setMessage("Paste a URL first.");
      return;
    }
    if (sourceType === "url") {
      try {
        // Reject obviously bad input before round-tripping to the DB.
        new URL(sourceUrl.trim());
      } catch {
        setMessage("That URL doesn't look valid.");
        return;
      }
    }
    if (assignToStoreIds.length === 0) {
      setMessage("Assign to at least one store.");
      return;
    }
    setUploading(true);
    setMessage(null);

    // Wrap the rest in try/finally so an unexpected exception (network
    // error, supabase-js bug, RLS edge case) doesn't leave the button
    // stuck on "Saving…". The previous version reset `uploading` in
    // every explicit error branch, but a thrown promise rejection
    // bypassed all of them.
    try {

    // Append at the end of the list — `max(sort_order) + 1`. Admin can
    // re-order with up/down after the fact.
    const maxSort = resources.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);
    const nextSort = maxSort + 1;

    let resourceId: string;
    if (sourceType === "upload" && file) {
      // Upload flow: create row with placeholder, upload file, patch path.
      // If the upload fails the row is rolled back so we don't leave a
      // dangling metadata record.
      const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const tempPath = `pending/${crypto.randomUUID()}`;
      const { data: inserted, error: insErr } = await supabase
        .from("training_resources")
        .insert([
          {
            title: title.trim(),
            description: description.trim() || null,
            kind,
            source_type: "upload",
            storage_path: tempPath, // placeholder; replaced below
            mime_type: file.type || null,
            file_size_bytes: file.size,
            sort_order: nextSort,
            created_by_user_id: session?.user?.id ?? null,
            created_by_label: session?.user?.email ?? null,
          },
        ])
        .select("id")
        .single();
      if (insErr || !inserted) {
        setUploading(false);
        setMessage(insErr?.message ?? "Couldn't save metadata.");
        return;
      }
      resourceId = (inserted as { id: string }).id;
      const finalPath = `${resourceId}/${sanitized}`;
      const { error: upErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(finalPath, file, { upsert: false, contentType: file.type || undefined });
      if (upErr) {
        await supabase.from("training_resources").delete().eq("id", resourceId);
        setUploading(false);
        setMessage(`Upload failed: ${upErr.message}`);
        return;
      }
      const { error: patchErr } = await supabase
        .from("training_resources")
        .update({ storage_path: finalPath })
        .eq("id", resourceId);
      if (patchErr) {
        setUploading(false);
        setMessage(patchErr.message);
        return;
      }
    } else {
      // URL flow: just persist the URL, no storage interaction.
      const { data: inserted, error: insErr } = await supabase
        .from("training_resources")
        .insert([
          {
            title: title.trim(),
            description: description.trim() || null,
            kind,
            source_type: "url",
            source_url: sourceUrl.trim(),
            sort_order: nextSort,
            created_by_user_id: session?.user?.id ?? null,
            created_by_label: session?.user?.email ?? null,
          },
        ])
        .select("id")
        .single();
      if (insErr || !inserted) {
        setUploading(false);
        setMessage(insErr?.message ?? "Couldn't save metadata.");
        return;
      }
      resourceId = (inserted as { id: string }).id;
    }

    const asnPayload = assignToStoreIds.map((sid) => ({
      resource_id: resourceId,
      store_id: sid,
    }));
    const { error: asnErr } = await supabase
      .from("training_resource_stores")
      .insert(asnPayload);
    if (asnErr) {
      setUploading(false);
      setMessage(`Saved but failed to assign: ${asnErr.message}`);
      return;
    }

    setMessage("Saved.");
    setTitle("");
    setDescription("");
    setKind("video");
    setSourceType("upload");
    setFile(null);
    setSourceUrl("");
    setAssignToStoreIds([]);
    const input = document.getElementById("training-file") as HTMLInputElement | null;
    if (input) input.value = "";
    loadResources();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Training resource upload threw:", err);
      setMessage(
        `Something went wrong: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (resource: Resource) => {
    if (!confirm(`Delete "${resource.title}"? This removes any uploaded file and all store assignments.`)) {
      return;
    }
    setMessage(null);
    if (resource.source_type === "upload" && resource.storage_path) {
      const { error: stErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove([resource.storage_path]);
      if (stErr) {
        // Continue with metadata delete anyway; the file may already be gone.
        console.warn("Storage delete failed:", stErr.message);
      }
    }
    const { error: dbErr } = await supabase
      .from("training_resources")
      .delete()
      .eq("id", resource.id);
    if (dbErr) {
      setMessage(dbErr.message);
      return;
    }
    loadResources();
  };

  // Drag-and-drop reorder: move a dragged resource to the target's position
  // within its kind list, then rewrite sort_order for that whole kind so it
  // stays a clean 1..N sequence. Cross-kind drags (e.g. video onto document)
  // are rejected — those are separate sections.
  const handleDropReorder = async (
    dragged: Resource,
    target: Resource,
    position: "above" | "below",
  ) => {
    if (dragged.id === target.id) return;
    if (dragged.kind !== target.kind) return;
    const list = dragged.kind === "video" ? videos : documents;
    const fromIndex = list.findIndex((r) => r.id === dragged.id);
    const toIndex = list.findIndex((r) => r.id === target.id);
    if (fromIndex === -1 || toIndex === -1) return;
    // Insertion point depends on which half of the target row was dropped on.
    let insertAt = position === "below" ? toIndex + 1 : toIndex;
    const reordered = [...list];
    const [moved] = reordered.splice(fromIndex, 1);
    // After splicing the source out, indices past it shift down by one.
    if (fromIndex < insertAt) insertAt -= 1;
    reordered.splice(insertAt, 0, moved);
    // Use a base offset above the current max so the intermediate updates
    // never collide with existing sort_order values in the other kind
    // section (avoids any chance of a transient duplicate). Then renumber
    // sequentially.
    const allMax = resources.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);
    const base = allMax + 1;
    setReorderingId(dragged.id);
    setMessage(null);
    for (let i = 0; i < reordered.length; i++) {
      const { error } = await supabase
        .from("training_resources")
        .update({ sort_order: base + i })
        .eq("id", reordered[i].id);
      if (error) {
        setReorderingId(null);
        setMessage(error.message);
        loadResources();
        return;
      }
    }
    setReorderingId(null);
    loadResources();
  };

  // Swap two resources' sort_order values. Used by the up/down arrows in
  // each kind section so the admin can re-order videos and documents.
  const swapSortOrder = async (a: Resource, b: Resource) => {
    setReorderingId(a.id);
    setMessage(null);
    const { error: e1 } = await supabase
      .from("training_resources")
      .update({ sort_order: b.sort_order })
      .eq("id", a.id);
    if (e1) {
      setReorderingId(null);
      setMessage(e1.message);
      return;
    }
    const { error: e2 } = await supabase
      .from("training_resources")
      .update({ sort_order: a.sort_order })
      .eq("id", b.id);
    setReorderingId(null);
    if (e2) {
      setMessage(e2.message);
      return;
    }
    loadResources();
  };

  const openAssignmentsEditor = (resource: Resource) => {
    setEditingAssignmentsId(resource.id);
    setAssignDraft(assignmentsByResource[resource.id] ?? []);
  };

  const cancelAssignmentsEditor = () => {
    setEditingAssignmentsId(null);
    setAssignDraft([]);
  };

  const toggleDraftStore = (id: string) => {
    setAssignDraft((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSaveAssignments = async (resource: Resource) => {
    const previous = new Set(assignmentsByResource[resource.id] ?? []);
    const next = new Set(assignDraft);
    const toAdd = [...next].filter((sid) => !previous.has(sid));
    const toRemove = [...previous].filter((sid) => !next.has(sid));
    setSavingAssignmentsId(resource.id);
    setMessage(null);
    if (toAdd.length > 0) {
      const { error } = await supabase
        .from("training_resource_stores")
        .insert(toAdd.map((sid) => ({ resource_id: resource.id, store_id: sid })));
      if (error) {
        setSavingAssignmentsId(null);
        setMessage(error.message);
        return;
      }
    }
    if (toRemove.length > 0) {
      const { error } = await supabase
        .from("training_resource_stores")
        .delete()
        .eq("resource_id", resource.id)
        .in("store_id", toRemove);
      if (error) {
        setSavingAssignmentsId(null);
        setMessage(error.message);
        return;
      }
    }
    setSavingAssignmentsId(null);
    setEditingAssignmentsId(null);
    setAssignDraft([]);
    loadResources();
  };

  const formatDateTime = (iso: string) => new Date(iso).toLocaleString();

  const renderAdminRow = (resource: Resource, index: number, list: Resource[]) => {
    const assignedIds = assignmentsByResource[resource.id] ?? [];
    const editing = editingAssignmentsId === resource.id;
    const canMoveUp = index > 0;
    const canMoveDown = index < list.length - 1;
    const reordering = reorderingId === resource.id;
    const isDragging = draggingId === resource.id;
    const isDragTarget =
      dragOverId === resource.id && draggingId !== null && draggingId !== resource.id;
    return (
      <div
        key={resource.id}
        draggable
        onDragStart={(e) => {
          setDraggingId(resource.id);
          // Required for Firefox; the value isn't used.
          e.dataTransfer.setData("text/plain", resource.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          setDraggingId(null);
          setDragOverId(null);
          setDragOverPosition(null);
        }}
        onDragOver={(e) => {
          // Only accept drops within the same kind section.
          const draggedKind = resources.find((r) => r.id === draggingId)?.kind;
          if (draggedKind && draggedKind !== resource.kind) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          // Top-half vs bottom-half of the target row → drop above / below.
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const position: "above" | "below" =
            e.clientY < rect.top + rect.height / 2 ? "above" : "below";
          if (dragOverId !== resource.id) setDragOverId(resource.id);
          if (dragOverPosition !== position) setDragOverPosition(position);
        }}
        onDragLeave={(e) => {
          // Only clear if leaving the row entirely (not entering a child).
          const related = e.relatedTarget as Node | null;
          if (related && (e.currentTarget as Node).contains(related)) return;
          if (dragOverId === resource.id) {
            setDragOverId(null);
            setDragOverPosition(null);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          const dragged = resources.find((r) => r.id === draggingId);
          const position = dragOverPosition ?? "below";
          setDraggingId(null);
          setDragOverId(null);
          setDragOverPosition(null);
          if (!dragged) return;
          handleDropReorder(dragged, resource, position);
        }}
        className={`relative rounded-2xl border bg-slate-900/60 p-5 space-y-3 transition ${
          isDragging ? "opacity-40" : ""
        } border-white/10`}
      >
        {isDragTarget && dragOverPosition === "above" && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 -translate-y-1/2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgb(34,211,238)]" />
        )}
        {isDragTarget && dragOverPosition === "below" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1 translate-y-1/2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgb(34,211,238)]" />
        )}
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div className="flex items-start gap-3">
            <div
              className="flex flex-col items-center gap-1 cursor-grab active:cursor-grabbing select-none"
              title="Drag to reorder"
            >
              <span className="text-slate-500 leading-none" aria-hidden>⋮⋮</span>
              <button
                type="button"
                onClick={() => swapSortOrder(resource, list[index - 1])}
                disabled={!canMoveUp || reordering}
                className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 disabled:opacity-30"
                title="Move up"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => swapSortOrder(resource, list[index + 1])}
                disabled={!canMoveDown || reordering}
                className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 disabled:opacity-30"
                title="Move down"
              >
                ▼
              </button>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-white">{resource.title}</span>
                {resource.source_type === "url" && (
                  <span className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-700/60 px-2 py-0.5 text-xs font-semibold text-slate-300">
                    link
                  </span>
                )}
              </div>
              {resource.description && (
                <p className="mt-1 text-sm text-slate-300 whitespace-pre-wrap">{resource.description}</p>
              )}
              {resource.source_type === "url" && resource.source_url && (
                <p className="mt-1 text-xs">
                  <a
                    href={resource.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline break-all"
                  >
                    {resource.source_url}
                  </a>
                </p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                {resource.source_type === "upload"
                  ? `${formatBytes(resource.file_size_bytes)} · Uploaded`
                  : "External link · Added"}{" "}
                {formatDateTime(resource.created_at)}
                {resource.created_by_label ? ` by ${resource.created_by_label}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleDelete(resource)}
              className="rounded-full bg-rose-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-rose-400"
            >
              Delete
            </button>
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap text-xs text-slate-400">
            <span>Assigned to:</span>
            {assignedIds.length === 0 ? (
              <span className="italic">no stores</span>
            ) : (
              assignedIds.map((sid) => (
                <span
                  key={sid}
                  className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-800 px-2 py-0.5 text-slate-200"
                >
                  {storeNameById[sid] ?? sid}
                </span>
              ))
            )}
            {!editing && (
              <button
                type="button"
                onClick={() => openAssignmentsEditor(resource)}
                className="ml-auto text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
              >
                Edit stores
              </button>
            )}
          </div>
          {editing && (
            <div className="mt-2 rounded-xl bg-slate-950/60 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAssignDraft(stores.map((s) => s.id))}
                  className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
                >
                  Assign to all
                </button>
                {assignDraft.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAssignDraft([])}
                    className="text-xs text-slate-400 hover:text-slate-200"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {stores.map((s) => {
                  const selected = assignDraft.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleDraftStore(s.id)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                        selected
                          ? "bg-cyan-500 text-slate-950"
                          : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                      }`}
                    >
                      {selected ? "✓ " : ""}{s.name}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSaveAssignments(resource)}
                  disabled={savingAssignmentsId === resource.id}
                  className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                >
                  {savingAssignmentsId === resource.id ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  onClick={cancelAssignmentsEditor}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div>
        <h1 className="text-3xl font-semibold text-white">Training Resources</h1>
        <p className="mt-3 text-slate-400">
          Upload videos or documents and pick which stores see them. Employees only see what&apos;s assigned to their store.
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
        <div className="mt-8 space-y-8">
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 space-y-4">
            <h2 className="text-lg font-semibold text-white">Upload new resource</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="title" className="block text-sm font-medium text-slate-300">
                  Title
                </label>
                <input
                  id="title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                  placeholder="e.g. Empanada baking SOP"
                />
              </div>
              <div>
                <label htmlFor="kind" className="block text-sm font-medium text-slate-300">
                  Kind
                </label>
                <select
                  id="kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ResourceKind)}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                >
                  <option value="video">Video</option>
                  <option value="document">Document</option>
                </select>
              </div>
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-slate-300">
                Description (optional)
              </label>
              <textarea
                id="description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <p className="block text-sm font-medium text-slate-300">Source</p>
              <div className="mt-2 inline-flex gap-1 rounded-full bg-slate-950 p-1 border border-white/10">
                <button
                  type="button"
                  onClick={() => setSourceType("upload")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    sourceType === "upload"
                      ? "bg-cyan-500 text-slate-950"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  Upload file
                </button>
                <button
                  type="button"
                  onClick={() => setSourceType("url")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    sourceType === "url"
                      ? "bg-cyan-500 text-slate-950"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  Paste URL
                </button>
              </div>
            </div>
            {sourceType === "upload" ? (
              <div>
                <label htmlFor="training-file" className="block text-sm font-medium text-slate-300">
                  File
                </label>
                <input
                  id="training-file"
                  type="file"
                  accept={kind === "video" ? "video/*" : ".pdf,.doc,.docx,.png,.jpg,.jpeg,application/pdf,image/*"}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400 file:mr-3 file:rounded-full file:border-0 file:bg-cyan-500 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-slate-950"
                />
                {file && (
                  <p className="mt-1 text-xs text-slate-400">
                    {file.name} · {formatBytes(file.size)}
                  </p>
                )}
              </div>
            ) : (
              <div>
                <label htmlFor="training-url" className="block text-sm font-medium text-slate-300">
                  URL
                </label>
                <input
                  id="training-url"
                  type="url"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=… (or any link)"
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                />
                <p className="mt-1 text-xs text-slate-500">
                  YouTube and Vimeo links embed inline. Other links open in a new tab.
                </p>
              </div>
            )}
            <div>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-sm font-medium text-slate-300">Assign to stores</p>
                {stores.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setAssignToStoreIds(stores.map((s) => s.id))}
                      className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
                    >
                      Assign to all
                    </button>
                    {assignToStoreIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setAssignToStoreIds([])}
                        className="text-xs text-slate-400 hover:text-slate-200"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {stores.length === 0 ? (
                  <span className="text-xs text-slate-500">No stores yet — create one under Directory.</span>
                ) : (
                  stores.map((s) => {
                    const selected = assignToStoreIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleAssignStore(s.id)}
                        className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                          selected
                            ? "bg-cyan-500 text-slate-950"
                            : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                        }`}
                      >
                        {selected ? "✓ " : ""}{s.name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div>
              <button
                type="button"
                onClick={handleUpload}
                disabled={
                  uploading
                  || !title.trim()
                  || assignToStoreIds.length === 0
                  || (sourceType === "upload" && !file)
                  || (sourceType === "url" && !sourceUrl.trim())
                }
                className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
              >
                {uploading ? "Saving…" : sourceType === "upload" ? "Upload" : "Save link"}
              </button>
            </div>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-white">All resources</h2>
            {resources.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">No resources uploaded yet.</p>
            ) : (
              <>
                <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4">
                  <h3 className="text-base font-semibold text-white">
                    Videos
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      {videos.length} {videos.length === 1 ? "item" : "items"}
                    </span>
                  </h3>
                  <div className="mt-3 space-y-3">
                    {videos.length === 0 ? (
                      <p className="text-sm text-slate-500">No videos yet.</p>
                    ) : (
                      videos.map((r, i) => renderAdminRow(r, i, videos))
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4">
                  <h3 className="text-base font-semibold text-white">
                    Documents
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      {documents.length} {documents.length === 1 ? "item" : "items"}
                    </span>
                  </h3>
                  <div className="mt-3 space-y-3">
                    {documents.length === 0 ? (
                      <p className="text-sm text-slate-500">No documents yet.</p>
                    ) : (
                      documents.map((r, i) => renderAdminRow(r, i, documents))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
