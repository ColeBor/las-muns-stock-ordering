import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextResponse } from "next/server";

// Hard-delete waste log photos that are past their 3-day expiry: remove the
// files from the private `waste-photos` bucket, then drop the rows. Uses the
// service-role client so it cleans EVERY store in one pass (not just the
// caller's). The waste log page pings this on load (fire-and-forget), and it
// can also be wired to a cron. It only ever removes already-expired rows, so
// it's safe to call from anywhere and idempotent.

export const runtime = "nodejs";

async function cleanup() {
  // Batch-cap so one call can't run unbounded; opportunistic calls catch up.
  const { data: expired, error } = await supabaseAdmin
    .from("waste_log_photos")
    .select("id,storage_path")
    .lt("expires_at", new Date().toISOString())
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!expired || expired.length === 0) {
    return NextResponse.json({ deleted: 0 });
  }

  const paths = expired.map((p) => p.storage_path as string);
  const { error: rmErr } = await supabaseAdmin.storage.from("waste-photos").remove(paths);
  if (rmErr) {
    // Leave the rows so a later run retries the file removal rather than
    // orphaning storage objects with no DB record pointing at them.
    return NextResponse.json({ error: rmErr.message }, { status: 500 });
  }

  const ids = expired.map((p) => p.id as string);
  const { error: delErr } = await supabaseAdmin.from("waste_log_photos").delete().in("id", ids);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: ids.length });
}

export async function POST() {
  return cleanup();
}

export async function GET() {
  return cleanup();
}
