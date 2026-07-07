import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest, NextResponse } from "next/server";

// Mark ONE store's delivery within a finalized cycle. The truck drops stores one
// at a time, so each is marked as it's delivered. Setting cycle_stores.delivered_at
// lets that store roll into its next cycle immediately, and a DB trigger flips the
// whole cycle to 'delivered' once every store is done.
//
// Requires the cycle to be 'finalized' first (finalize = locked + PDF printed).

export async function POST(request: NextRequest) {
  let cycle_id: string | undefined;
  let store_id: string | undefined;
  try {
    ({ cycle_id, store_id } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!cycle_id || !store_id) {
    return NextResponse.json({ error: "cycle_id and store_id are required" }, { status: 400 });
  }

  const { data: cycle, error: cycleErr } = await supabaseAdmin
    .from("order_cycles")
    .select("status")
    .eq("id", cycle_id)
    .single();
  if (cycleErr || !cycle) {
    return NextResponse.json(
      { error: cycleErr?.message ?? "Cycle not found" },
      { status: 404 },
    );
  }
  if (cycle.status === "delivered") {
    return NextResponse.json({ error: "Cycle is already delivered" }, { status: 400 });
  }
  if (cycle.status !== "finalized") {
    return NextResponse.json(
      { error: "Finalize the delivery before marking stores delivered" },
      { status: 400 },
    );
  }

  // Only stamp if not already delivered, so we don't reset an existing timestamp
  // (and so the "all done" trigger only fires on a real transition).
  const { data: row, error: rowErr } = await supabaseAdmin
    .from("cycle_stores")
    .select("delivered_at")
    .eq("cycle_id", cycle_id)
    .eq("store_id", store_id)
    .single();
  if (rowErr || !row) {
    return NextResponse.json(
      { error: rowErr?.message ?? "Store is not part of this cycle" },
      { status: 404 },
    );
  }
  if (row.delivered_at) {
    return NextResponse.json({ message: "Store already delivered", already: true });
  }

  const { error: updErr } = await supabaseAdmin
    .from("cycle_stores")
    .update({ delivered_at: new Date().toISOString() })
    .eq("cycle_id", cycle_id)
    .eq("store_id", store_id);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  return NextResponse.json({ message: "Store marked delivered" });
}
