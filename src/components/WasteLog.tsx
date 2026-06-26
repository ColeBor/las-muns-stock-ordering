"use client";

// Photos here are blob previews (camera capture) and short-lived private signed
// URLs — next/image can't optimise either, so plain <img> is correct.
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = {
  id: string;
  name: string;
};

// Active + Serveable items for the current store. Pulled by joining
// store_items (is_active = true) with items (is_serveable = true).
type WasteItem = {
  item_id: string;
  name: string;
};

type WasteEntry = {
  id: string;
  store_id: string;
  item_id: string;
  quantity: number;
  reason: string;
  reason_other: string | null;
  wasted_on: string;
  recorded_by: string | null;
  created_at: string;
};

// Preset reasons as specified by HQ. "Other" must remain the only reason
// that unlocks the free-text input — the DB constraint enforces that.
const WASTE_REASONS = [
  "Influencer",
  "Friday Waste",
  "Sample",
  "Dropped",
  "Burned / Popped",
  "Over 3 Days Old",
  "Customer Comp.",
  "Promotion",
  "Kitchen Issue",
  "Owners",
  "Other",
] as const;

// Plain-English explanations shown in the "What do these mean?" disclosure
// below the Reason dropdown so workers can pick the right one. Keys mirror
// WASTE_REASONS exactly.
const WASTE_REASON_DESCRIPTIONS: Record<(typeof WASTE_REASONS)[number], string> = {
  "Influencer": "Whenever giving out free empanadas to influencers.",
  "Friday Waste":
    "Only for locations that close on Saturday & Sunday. Because by Monday, anything baked on Thursday will already be 4 days old, we pre-emptively waste it on Friday.",
  "Sample": "Empanadas given out as samples.",
  "Dropped": "Empanadas dropped on the ground or other dirty surfaces.",
  "Burned / Popped": "Empanadas that were burned or popped in the oven.",
  "Over 3 Days Old": "Any empanadas over 3 days old — we do not sell them.",
  "Customer Comp.":
    "If we made a mistake and want to compensate the customer with a free item.",
  "Promotion":
    "If we are running a promotion or campaign — for example on our anniversary, we may be giving out free empanadas to people who follow us on Instagram.",
  "Kitchen Issue":
    "Empanadas that visually or structurally are not fit to sell because of the way they were prepared in the commissary kitchen. Examples: coming apart at the seams, poorly placed or incorrect stamps, deformed, broken (missing a piece of their crown), etc.",
  "Owners": "Empanadas taken for free by the owners.",
  "Other": "For a reason not already listed — please leave your reason.",
};

function todayIso() {
  // YYYY-MM-DD in the user's local timezone — what <input type="date"> expects.
  const now = new Date();
  const tzOffsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

export default function WasteLog() {
  const { session, profile, loading: authLoading, isSignedIn, isStoreManager, isEmployee } = useAuthGate();
  const [store, setStore] = useState<Store | null>(null);
  const [allStores, setAllStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [items, setItems] = useState<WasteItem[]>([]);
  const [entries, setEntries] = useState<WasteEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [wastedOn, setWastedOn] = useState<string>(todayIso());
  const [itemId, setItemId] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("1");
  const [reason, setReason] = useState<string>("");
  const [reasonOther, setReasonOther] = useState<string>("");

  // Photos: staged client-side until the entry is saved, then uploaded. The
  // camera button opens the device camera on phones (capture="environment").
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [stagedPhotos, setStagedPhotos] = useState<Array<{ file: File; url: string }>>([]);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  // Signed thumbnail URLs for the recent-waste table, keyed by entry id.
  const [photosByEntry, setPhotosByEntry] = useState<Record<string, Array<{ id: string; url: string }>>>({});

  // Opportunistically purge photos past their 3-day expiry on page load.
  useEffect(() => {
    fetch("/api/waste-photos/cleanup", { method: "POST" }).catch(() => {});
  }, []);

  const hasAssignedStore = useMemo(() => !!profile?.store_id, [profile]);
  const effectiveStoreId = useMemo(
    () => (isStoreManager ? selectedStoreId || null : profile?.store_id ?? null),
    [isStoreManager, selectedStoreId, profile?.store_id],
  );
  const canManage = (isEmployee && hasAssignedStore) || (isStoreManager && !!effectiveStoreId);

  useEffect(() => {
    if (!isStoreManager) return;
    const loadStores = async () => {
      const { data } = await supabase.from("stores").select("id,name").order("name");
      if (data) setAllStores(data as Store[]);
    };
    loadStores();
  }, [isStoreManager]);

  useEffect(() => {
    if (!effectiveStoreId) {
      setStore(null);
      return;
    }
    const loadStore = async () => {
      const { data } = await supabase
        .from("stores")
        .select("id,name")
        .eq("id", effectiveStoreId)
        .single();
      if (data) setStore(data as Store);
    };
    loadStore();
  }, [effectiveStoreId]);

  // Active + Serveable items for the current store. We need both filters:
  // `is_active = true` from store_items, `is_serveable = true` from items.
  // Achieved by selecting from store_items with an inner join via the items
  // relation and filtering on the embedded items.is_serveable.
  const loadItems = useCallback(async () => {
    if (!effectiveStoreId) {
      setItems([]);
      return;
    }
    const { data, error } = await supabase
      .from("store_items")
      .select("item_id, items!inner(name, is_serveable)")
      .eq("store_id", effectiveStoreId)
      .eq("is_active", true)
      .eq("items.is_serveable", true)
      .order("item_id");
    if (error) {
      setMessage(`Couldn't load items: ${error.message}`);
      setItems([]);
      return;
    }
    const mapped = ((data ?? []) as unknown as Array<{
      item_id: string;
      items: { name: string };
    }>)
      .map((row) => ({ item_id: row.item_id, name: row.items?.name ?? row.item_id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setItems(mapped);
  }, [effectiveStoreId]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // Pull the last 30 days of waste — enough to spot trends without dragging
  // the full table over the wire.
  const loadEntries = useCallback(async () => {
    if (!effectiveStoreId) {
      setEntries([]);
      return;
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from("waste_log_entries")
      .select(
        "id,store_id,item_id,quantity,reason,reason_other,wasted_on,recorded_by,created_at",
      )
      .eq("store_id", effectiveStoreId)
      .gte("wasted_on", cutoffIso)
      .order("wasted_on", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      setMessage(`Couldn't load history: ${error.message}`);
      setEntries([]);
      return;
    }
    setEntries((data as WasteEntry[]) ?? []);
  }, [effectiveStoreId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  // Non-expired photos for the recent entries, with short-lived signed URLs
  // (the bucket is private). Keyed by entry id for the table to render.
  const loadPhotos = useCallback(async () => {
    if (!effectiveStoreId) {
      setPhotosByEntry({});
      return;
    }
    const { data, error } = await supabase
      .from("waste_log_photos")
      .select("id,waste_log_id,storage_path")
      .eq("store_id", effectiveStoreId)
      .gt("expires_at", new Date().toISOString());
    if (error || !data || data.length === 0) {
      setPhotosByEntry({});
      return;
    }
    const paths = data.map((p) => p.storage_path as string);
    const { data: signed } = await supabase.storage
      .from("waste-photos")
      .createSignedUrls(paths, 3600);
    const urlByPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
    const byEntry: Record<string, Array<{ id: string; url: string }>> = {};
    for (const p of data as Array<{ id: string; waste_log_id: string; storage_path: string }>) {
      const url = urlByPath.get(p.storage_path);
      if (!url) continue;
      (byEntry[p.waste_log_id] ??= []).push({ id: p.id, url });
    }
    setPhotosByEntry(byEntry);
  }, [effectiveStoreId]);

  useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  useRealtimeRefetch(
    effectiveStoreId
      ? [
          { table: "waste_log_entries", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "waste_log_photos", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "store_items", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "items" },
        ]
      : [],
    useCallback(() => {
      loadEntries();
      loadItems();
      loadPhotos();
    }, [loadEntries, loadItems, loadPhotos]),
    `waste-log-${effectiveStoreId}`,
  );

  const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

  const onPickPhotos = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const valid: Array<{ file: File; url: string }> = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > MAX_PHOTO_BYTES) {
        setMessage(`"${f.name}" is too large (max 10 MB).`);
        continue;
      }
      valid.push({ file: f, url: URL.createObjectURL(f) });
    }
    if (valid.length) setStagedPhotos((prev) => [...prev, ...valid]);
    // Reset so taking another photo (or re-picking the same file) fires onChange.
    e.target.value = "";
  };

  const removeStagedPhoto = (idx: number) => {
    setStagedPhotos((prev) => {
      const next = [...prev];
      URL.revokeObjectURL(next[idx].url);
      next.splice(idx, 1);
      return next;
    });
  };

  const itemNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const i of items) map[i.item_id] = i.name;
    return map;
  }, [items]);

  const resetForm = () => {
    setItemId("");
    setQuantity("1");
    setReason("");
    setReasonOther("");
    // Keep wastedOn as-is so consecutive entries for the same day are quick.
  };

  const handleSubmit = async () => {
    if (!effectiveStoreId) return;
    if (!itemId) {
      setMessage("Pick an item.");
      return;
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      setMessage("Quantity must be a positive whole number.");
      return;
    }
    if (!reason) {
      setMessage("Pick a reason.");
      return;
    }
    if (reason === "Other" && !reasonOther.trim()) {
      setMessage("Add a custom reason for \"Other\".");
      return;
    }
    if (!wastedOn) {
      setMessage("Pick a date.");
      return;
    }

    setSaving(true);
    setMessage(null);
    const payload = {
      store_id: effectiveStoreId,
      item_id: itemId,
      quantity: qty,
      reason,
      reason_other: reason === "Other" ? reasonOther.trim() : null,
      wasted_on: wastedOn,
      recorded_by: session?.user?.email ?? session?.user?.id ?? null,
    };
    try {
      const { data: inserted, error } = await supabase
        .from("waste_log_entries")
        .insert([payload])
        .select("id")
        .single();
      if (error) {
        setMessage(error.message);
        return;
      }

      // Upload any staged photos against the new entry. Path:
      // {store_id}/{waste_log_id}/{uuid}.{ext} — the leading store id scopes
      // worker storage access. A failed upload is reported but doesn't lose
      // the logged entry.
      let uploaded = 0;
      if (inserted?.id && stagedPhotos.length > 0) {
        setUploadingPhotos(true);
        for (const sp of stagedPhotos) {
          const ext =
            (sp.file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
          const path = `${effectiveStoreId}/${inserted.id}/${crypto.randomUUID()}.${ext}`;
          const { error: upErr } = await supabase.storage
            .from("waste-photos")
            .upload(path, sp.file, { contentType: sp.file.type || undefined, upsert: false });
          if (upErr) {
            setMessage(`Photo upload failed: ${upErr.message}`);
            continue;
          }
          const { error: rowErr } = await supabase.from("waste_log_photos").insert({
            waste_log_id: inserted.id,
            store_id: effectiveStoreId,
            storage_path: path,
          });
          if (rowErr) {
            // Roll back the orphaned file so it isn't left without a row.
            await supabase.storage.from("waste-photos").remove([path]);
            setMessage(`Photo save failed: ${rowErr.message}`);
            continue;
          }
          uploaded += 1;
        }
        setUploadingPhotos(false);
      }

      stagedPhotos.forEach((p) => URL.revokeObjectURL(p.url));
      setStagedPhotos([]);
      setMessage(uploaded > 0 ? `Waste logged with ${uploaded} photo${uploaded === 1 ? "" : "s"}.` : "Waste logged.");
      resetForm();
      loadEntries();
      loadPhotos();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't log waste: ${err.message}`
          : "Couldn't log waste (network timeout). Try again.",
      );
    } finally {
      setSaving(false);
      setUploadingPhotos(false);
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    setMessage(null);
    const { error } = await supabase.from("waste_log_entries").delete().eq("id", entryId);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Entry deleted.");
    loadEntries();
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const formatDate = (iso: string) => {
    // wasted_on is a date string (YYYY-MM-DD). Parse as local, not UTC, so
    // it doesn't shift by a day in negative timezones.
    const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString();
  };

  const displayReason = (entry: WasteEntry) =>
    entry.reason === "Other" && entry.reason_other ? `Other — ${entry.reason_other}` : entry.reason;

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Waste Log</h1>
          <p className="mt-3 text-slate-400">
            Log items you had to throw out. Only items your store carries appear here.
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
          <p>Please sign in to access this page.</p>
        </div>
      ) : !isEmployee && !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Employees and Store Managers.</p>
        </div>
      ) : isEmployee && !hasAssignedStore ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a store. Please contact an administrator.</p>
        </div>
      ) : isStoreManager && !selectedStoreId ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300 space-y-3">
          <p>Pick a store to manage:</p>
          <select
            value={selectedStoreId}
            onChange={(event) => setSelectedStoreId(event.target.value)}
            className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
          >
            <option value="">(Select a store)</option>
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <h2 className="text-xl font-semibold text-white">{store?.name || "Loading..."}</h2>
            {isStoreManager && (
              <div className="flex items-center gap-2">
                <label htmlFor="store" className="text-sm font-medium text-slate-300">
                  Store:
                </label>
                <select
                  id="store"
                  value={selectedStoreId}
                  onChange={(event) => setSelectedStoreId(event.target.value)}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                >
                  {allStores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {canManage && (
            <>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 space-y-4">
                <h3 className="text-lg font-semibold text-white">Log waste</h3>
                {items.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No items are set up for waste logging yet. Ask a Store Manager to add some.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <label htmlFor="wasted-on" className="block text-sm font-medium text-slate-300">
                          Date wasted
                        </label>
                        <input
                          id="wasted-on"
                          type="date"
                          value={wastedOn}
                          onChange={(e) => setWastedOn(e.target.value)}
                          onClick={(e) => e.currentTarget.showPicker?.()}
                          max={todayIso()}
                          className="mt-1 w-full cursor-pointer rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                        />
                      </div>
                      <div>
                        <label htmlFor="item" className="block text-sm font-medium text-slate-300">
                          Item
                        </label>
                        <select
                          id="item"
                          value={itemId}
                          onChange={(e) => setItemId(e.target.value)}
                          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                        >
                          <option value="">(Select an item)</option>
                          {items.map((i) => (
                            <option key={i.item_id} value={i.item_id}>
                              {i.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="quantity" className="block text-sm font-medium text-slate-300">
                          Quantity
                        </label>
                        <input
                          id="quantity"
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          value={quantity}
                          onChange={(e) => setQuantity(e.target.value)}
                          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                        />
                      </div>
                      <div>
                        <label htmlFor="reason" className="block text-sm font-medium text-slate-300">
                          Reason
                        </label>
                        <select
                          id="reason"
                          value={reason}
                          onChange={(e) => {
                            setReason(e.target.value);
                            if (e.target.value !== "Other") setReasonOther("");
                          }}
                          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                        >
                          <option value="">(Select a reason)</option>
                          {WASTE_REASONS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <details className="group rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm">
                      <summary className="cursor-pointer list-none text-slate-300 marker:hidden hover:text-cyan-300">
                        <span className="inline-flex items-center gap-2">
                          <span className="text-base leading-none transition group-open:rotate-90">▸</span>
                          What do these mean?
                        </span>
                      </summary>
                      <dl className="mt-3 space-y-2 text-slate-300">
                        {WASTE_REASONS.map((r) => (
                          <div key={r}>
                            <dt className="font-semibold text-white">{r}</dt>
                            <dd className="mt-0.5 text-xs text-slate-400">
                              {WASTE_REASON_DESCRIPTIONS[r]}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                    {reason === "Other" && (
                      <div>
                        <label htmlFor="reason-other" className="block text-sm font-medium text-slate-300">
                          Custom reason
                        </label>
                        <input
                          id="reason-other"
                          type="text"
                          value={reasonOther}
                          onChange={(e) => setReasonOther(e.target.value)}
                          placeholder="Why was this wasted?"
                          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                          maxLength={200}
                        />
                      </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium text-slate-300">
                        Photos <span className="text-xs text-slate-500">(optional)</span>
                      </label>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        multiple
                        onChange={onPickPhotos}
                        className="hidden"
                      />
                      <div className="mt-1 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-cyan-300 transition hover:border-cyan-400"
                        >
                          📷 Take photo
                        </button>
                        {stagedPhotos.map((p, idx) => (
                          <div key={idx} className="relative">
                            <img
                              src={p.url}
                              alt={`Staged waste photo ${idx + 1}`}
                              className="h-16 w-16 rounded-lg object-cover ring-1 ring-white/10"
                            />
                            <button
                              type="button"
                              onClick={() => removeStagedPhoto(idx)}
                              aria-label="Remove photo"
                              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-xs font-bold text-white"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Opens the camera on phones. Photos are deleted automatically after 3 days.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={saving}
                        className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
                      >
                        {uploadingPhotos
                          ? "Uploading photos..."
                          : saving
                            ? "Saving..."
                            : "Log waste"}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6">
                <h3 className="text-lg font-semibold text-white">Recent waste</h3>
                <p className="mt-1 text-sm text-slate-400">Last 30 days, most recent first.</p>
                {entries.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-500">No waste recorded in the last 30 days.</p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                          <th className="px-3 py-2">Date</th>
                          <th className="px-3 py-2">Item</th>
                          <th className="px-3 py-2">Qty</th>
                          <th className="px-3 py-2">Reason</th>
                          <th className="px-3 py-2">By</th>
                          <th className="px-3 py-2">Photos</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {entries.map((entry) => (
                          <tr key={entry.id} className="text-slate-200">
                            <td className="px-3 py-2 whitespace-nowrap">{formatDate(entry.wasted_on)}</td>
                            <td className="px-3 py-2">{itemNameById[entry.item_id] ?? entry.item_id}</td>
                            <td className="px-3 py-2">{entry.quantity}</td>
                            <td className="px-3 py-2">{displayReason(entry)}</td>
                            <td className="px-3 py-2 text-slate-400">{entry.recorded_by ?? "—"}</td>
                            <td className="px-3 py-2">
                              <div className="flex gap-1">
                                {(photosByEntry[entry.id] ?? []).map((ph) => (
                                  <a key={ph.id} href={ph.url} target="_blank" rel="noopener noreferrer">
                                    <img
                                      src={ph.url}
                                      alt="Waste photo"
                                      className="h-10 w-10 rounded object-cover ring-1 ring-white/10 transition hover:ring-cyan-400"
                                    />
                                  </a>
                                ))}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => handleDeleteEntry(entry.id)}
                                className="text-xs text-rose-300 hover:text-rose-200"
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
