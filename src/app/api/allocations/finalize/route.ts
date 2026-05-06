import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest, NextResponse } from "next/server";

// Mark a cycle as delivered. Requires status = 'allocated' (allocations have
// run) and a non-null order_date; flips status to 'delivered' on success.
// factory_counts rows are NOT modified — they're the pre-delivery snapshot
// for that cycle and stay static so a delivered cycle's history shows what
// the factory had at counting time, not what's left after delivery.

export async function POST(request: NextRequest) {
  let cycle_id: string | undefined;
  try {
    ({ cycle_id } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!cycle_id) {
    return NextResponse.json({ error: "cycle_id is required" }, { status: 400 });
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
    return NextResponse.json({ error: "Cycle already delivered" }, { status: 400 });
  }
  if (cycle.status !== "allocated") {
    return NextResponse.json(
      { error: "Run allocations before marking delivered" },
      { status: 400 },
    );
  }
  if (!cycle.order_date) {
    return NextResponse.json(
      { error: "Cycle must have an order_date set before marking delivered" },
      { status: 400 },
    );
  }

  const { error: statusErr } = await supabaseAdmin
    .from("order_cycles")
    .update({ status: "delivered" })
    .eq("id", cycle_id);
  if (statusErr) {
    return NextResponse.json({ error: statusErr.message }, { status: 500 });
  }

  return NextResponse.json({
    message: "Cycle delivered",
    cycle_status: "delivered",
  });
}
