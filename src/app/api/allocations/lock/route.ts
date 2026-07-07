import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest, NextResponse } from "next/server";

// Lock ('finalized') or unlock ('allocated') a cycle's delivery.
//
// Finalizing freezes the allocation numbers: the run engine and the auto
// reallocator both refuse to touch a 'finalized' cycle, so the printed delivery
// PDF and the loaded truck can't diverge from the digital plan. Delivery numbers
// can still be hand-corrected, but nothing recomputes underneath the crew.
// Delivered can only be marked from 'finalized'. Unlocking reverts to
// 'allocated' so the plan can be re-run again.
//
//   POST { cycle_id, locked: true }  → allocated  → finalized
//   POST { cycle_id, locked: false } → finalized  → allocated

export async function POST(request: NextRequest) {
  let cycle_id: string | undefined;
  let locked: boolean | undefined;
  try {
    ({ cycle_id, locked } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!cycle_id) {
    return NextResponse.json({ error: "cycle_id is required" }, { status: 400 });
  }
  if (typeof locked !== "boolean") {
    return NextResponse.json({ error: "locked (boolean) is required" }, { status: 400 });
  }

  const { data: cycle, error: cycleErr } = await supabaseAdmin
    .from("order_cycles")
    .select("status,order_date")
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

  if (locked) {
    // Allocations run automatically from creation, so a cycle is 'draft' (very
    // briefly, before the first auto-run) or 'allocated'. Finalize is the
    // checkpoint: every store must have marked its stock finished first.
    if (cycle.status !== "allocated" && cycle.status !== "draft") {
      return NextResponse.json(
        { error: "This delivery can't be finalized in its current state" },
        { status: 400 },
      );
    }
    if (!cycle.order_date) {
      return NextResponse.json(
        { error: "Set an order date before finalizing the delivery" },
        { status: 400 },
      );
    }
    const { data: csRows, error: csErr } = await supabaseAdmin
      .from("cycle_stores")
      .select("finished_at, stores(name)")
      .eq("cycle_id", cycle_id);
    if (csErr) {
      return NextResponse.json({ error: csErr.message }, { status: 500 });
    }
    const unfinished = ((csRows ?? []) as unknown as Array<{
      finished_at: string | null;
      stores: { name: string } | null;
    }>).filter((cs) => !cs.finished_at);
    if (unfinished.length > 0) {
      const names = unfinished.map((cs) => cs.stores?.name ?? "a store").sort();
      return NextResponse.json(
        {
          error: `Waiting on ${names.length} store${names.length === 1 ? "" : "s"} to finish their stock entry: ${names.join(", ")}`,
        },
        { status: 400 },
      );
    }
  } else if (cycle.status !== "finalized") {
    return NextResponse.json(
      { error: "Only a finalized delivery can be unlocked" },
      { status: 400 },
    );
  }

  const nextStatus = locked ? "finalized" : "allocated";
  const { error: updErr } = await supabaseAdmin
    .from("order_cycles")
    .update({ status: nextStatus })
    .eq("id", cycle_id);
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  return NextResponse.json({
    message: locked ? "Delivery finalized" : "Delivery unlocked",
    cycle_status: nextStatus,
  });
}
