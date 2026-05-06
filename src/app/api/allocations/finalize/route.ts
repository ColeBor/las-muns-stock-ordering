import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest, NextResponse } from "next/server";

// Mark a cycle as delivered. Sums each (factory, item) pair across
// allocation_factories and decrements the matching factory_counts row by
// that sum, so a finalized cycle's factory_counts reflects post-delivery
// stock. Sets order_cycles.status = 'finalized' as the gate — re-running
// the same cycle errors out.
//
// available_qty is allowed to go negative on purpose. The factory can
// fulfill side orders directly, so the pre-delivery count can drift; if a
// decrement crosses zero, that's a real signal the count was off, not
// something to silently hide by clamping.

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
    .select("status")
    .eq("id", cycle_id)
    .single();
  if (cycleErr || !cycle) {
    return NextResponse.json(
      { error: cycleErr?.message ?? "Cycle not found" },
      { status: 404 },
    );
  }
  if (cycle.status === "finalized") {
    return NextResponse.json({ error: "Cycle already finalized" }, { status: 400 });
  }

  const { data: splits, error: splitsErr } = await supabaseAdmin
    .from("allocation_factories")
    .select("factory_id,item_id,qty")
    .eq("cycle_id", cycle_id);
  if (splitsErr) {
    return NextResponse.json({ error: splitsErr.message }, { status: 500 });
  }

  const sumByKey = new Map<
    string,
    { factory_id: string; item_id: string; sum: number }
  >();
  for (const s of splits ?? []) {
    const k = `${s.factory_id}|${s.item_id}`;
    const existing = sumByKey.get(k);
    if (existing) {
      existing.sum += s.qty;
    } else {
      sumByKey.set(k, { factory_id: s.factory_id, item_id: s.item_id, sum: s.qty });
    }
  }

  let decrements = 0;
  for (const { factory_id, item_id, sum } of sumByKey.values()) {
    const { data: count, error: countErr } = await supabaseAdmin
      .from("factory_counts")
      .select("available_qty")
      .eq("cycle_id", cycle_id)
      .eq("factory_id", factory_id)
      .eq("item_id", item_id)
      .maybeSingle();
    if (countErr) {
      return NextResponse.json({ error: countErr.message }, { status: 500 });
    }
    if (!count) continue;

    const { error: updErr } = await supabaseAdmin
      .from("factory_counts")
      .update({ available_qty: count.available_qty - sum })
      .eq("cycle_id", cycle_id)
      .eq("factory_id", factory_id)
      .eq("item_id", item_id);
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
    decrements += 1;
  }

  const { error: statusErr } = await supabaseAdmin
    .from("order_cycles")
    .update({ status: "finalized" })
    .eq("id", cycle_id);
  if (statusErr) {
    return NextResponse.json({ error: statusErr.message }, { status: 500 });
  }

  return NextResponse.json({
    message: "Cycle finalized",
    decrements_applied: decrements,
    cycle_status: "finalized",
  });
}
