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
    if (cycle.status !== "allocated") {
      return NextResponse.json(
        { error: "Run allocations before finalizing the delivery" },
        { status: 400 },
      );
    }
    if (!cycle.order_date) {
      return NextResponse.json(
        { error: "Set an order date before finalizing the delivery" },
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
