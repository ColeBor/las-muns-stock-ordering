import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest, NextResponse } from "next/server";

// Server-side waste-photo upload. The tablet POSTs the (already-compressed)
// image here as multipart form data — a plain request that does NOT touch the
// client's Supabase auth/token/lock, which is what kept stalling the direct
// client→storage upload on flaky in-store wifi. The server then puts it in the
// private bucket and records the row with the service role (bypassing RLS).
//
// Path convention matches the client's old one: {store_id}/{waste_log_id}/{uuid}.{ext}.

export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = form.get("file");
  const wasteLogId = form.get("waste_log_id");
  const storeId = form.get("store_id");
  if (!(file instanceof File) || typeof wasteLogId !== "string" || typeof storeId !== "string") {
    return NextResponse.json(
      { error: "file, waste_log_id and store_id are required" },
      { status: 400 },
    );
  }

  const ext =
    (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${storeId}/${wasteLogId}/${crypto.randomUUID()}.${ext}`;

  // Read into a Buffer — the most portable payload for storage-js on the server.
  const bytes = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await supabaseAdmin.storage
    .from("waste-photos")
    .upload(path, bytes, { contentType: file.type || "image/jpeg", upsert: false });
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  const { error: rowErr } = await supabaseAdmin.from("waste_log_photos").insert({
    waste_log_id: wasteLogId,
    store_id: storeId,
    storage_path: path,
  });
  if (rowErr) {
    // Don't leave an orphaned file if the row insert fails (e.g. bad waste_log_id).
    await supabaseAdmin.storage.from("waste-photos").remove([path]).catch(() => {});
    return NextResponse.json({ error: rowErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, path });
}
