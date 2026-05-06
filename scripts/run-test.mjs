// Generic test driver. Reads ./scripts/test-spec.json for setup actions, runs
// allocations, then prints the result. Used to automate Tier 5 tests.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
);

const action = process.argv[2];

const { data: cycle } = await sb
  .from("order_cycles")
  .select("id")
  .eq("name", "TEST: Allocation scenario")
  .single();
const cycleId = cycle.id;

async function getStore(name) {
  const { data } = await sb.from("stores").select("id").eq("name", name).single();
  return data.id;
}
async function getItem(sku) {
  const { data } = await sb.from("items").select("id").eq("sku", sku).single();
  return data.id;
}

async function runAllocations() {
  // Hit the local dev API. Service role isn't passed; the route uses
  // supabaseAdmin internally so it bypasses auth.
  const res = await fetch("http://localhost:3000/api/allocations/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cycle_id: cycleId }),
  });
  const json = await res.json();
  console.log("Allocator response:", JSON.stringify(json, null, 2));
}

async function printResult() {
  const { data: allocs } = await sb
    .from("allocations")
    .select(
      "qty,shortfall,source,factory_id,stores(name),items(sku),factories!allocations_factory_id_fkey(name)",
    )
    .eq("cycle_id", cycleId);

  const { data: splits } = await sb
    .from("allocation_factories")
    .select("qty,store_id,item_id,factory_id,factories(name)")
    .eq("cycle_id", cycleId);

  const { data: pos } = await sb
    .from("po_lines")
    .select("qty,items(sku),purchase_orders!inner(suppliers(name),cycle_id)")
    .eq("purchase_orders.cycle_id", cycleId);

  console.log("\n=== allocations ===");
  for (const a of allocs ?? []) {
    console.log(
      `${a.stores.name} / ${a.items.sku}: qty=${a.qty}, shortfall=${a.shortfall}, source=${a.source}, factory=${a.factories?.name ?? "—"}`,
    );
  }
  console.log("\n=== splits ===");
  for (const s of splits ?? []) {
    console.log(
      `store=${s.store_id.slice(0, 8)} / item=${s.item_id.slice(0, 8)} from ${s.factories?.name}: ${s.qty}`,
    );
  }
  console.log("\n=== po_lines ===");
  for (const p of pos ?? []) {
    console.log(`${p.purchase_orders.suppliers.name} / ${p.items.sku}: ${p.qty}`);
  }
}

async function printFactoryCounts() {
  const { data } = await sb
    .from("factory_counts")
    .select("available_qty,factories(name),items(sku)")
    .eq("cycle_id", cycleId);
  console.log("\n=== factory_counts (post-finalize) ===");
  for (const c of data ?? []) {
    console.log(`${c.factories.name} / ${c.items.sku}: ${c.available_qty}`);
  }
}

if (action === "finalize") {
  // Run allocations first so there's something to decrement, then finalize.
  await runAllocations();
  const res = await fetch("http://localhost:3000/api/allocations/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cycle_id: cycleId }),
  });
  const json = await res.json();
  console.log("\nFinalize response:", JSON.stringify(json, null, 2));
  await printFactoryCounts();
} else if (action === "test14") {
  const storeA = await getStore("TEST: Store A");
  const itemM1 = await getItem("TEST-M1");
  await sb.from("allocation_overrides").upsert(
    [
      {
        cycle_id: cycleId,
        store_id: storeA,
        item_id: itemM1,
        qty: 999,
        reason: "test 14",
        set_by: "script",
      },
    ],
    { onConflict: "cycle_id,store_id,item_id" },
  );
  await runAllocations();
  await printResult();
} else if (action === "test15") {
  await sb.from("factory_counts").delete().eq("cycle_id", cycleId);
  await runAllocations();
  await printResult();
} else if (action === "result") {
  await printResult();
} else {
  console.error("usage: node scripts/run-test.mjs <test14|test15|finalize|result>");
  process.exit(1);
}
