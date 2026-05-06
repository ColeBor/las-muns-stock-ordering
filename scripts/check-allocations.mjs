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

const { data: cycles } = await sb
  .from("order_cycles")
  .select("id,name")
  .eq("created_by", "seed-script")
  .single();

const cycleId = cycles.id;

const { data: allocs } = await sb
  .from("allocations")
  .select(
    "qty,shortfall,source,factory_id,stores(name),items(name),factories!allocations_factory_id_fkey(name)",
  )
  .eq("cycle_id", cycleId);

const { data: splits, error: splitsError } = await sb
  .from("allocation_factories")
  .select("qty,store_id,item_id,factory_id,factories(name)")
  .eq("cycle_id", cycleId);
if (splitsError) console.error("splits query error:", splitsError);

const { data: pos } = await sb
  .from("po_lines")
  .select("qty,items(name),purchase_orders!inner(suppliers(name),cycle_id)")
  .eq("purchase_orders.cycle_id", cycleId);

const { data: counts } = await sb
  .from("factory_counts")
  .select("available_qty,factories(name),items(name)")
  .eq("cycle_id", cycleId);

const { data: cs } = await sb
  .from("cycle_stores")
  .select("stores(name)")
  .eq("cycle_id", cycleId);

console.log("=== cycle_stores ===");
console.log(cs?.map((c) => c.stores.name).join(", ") || "(empty)");

console.log("\n=== factory_counts ===");
for (const c of counts ?? []) {
  console.log(`${c.factories.name} / ${c.items.name}: ${c.available_qty}`);
}

console.log("\n=== allocations ===");
for (const a of allocs ?? []) {
  console.log(
    `${a.stores.name} / ${a.items.name}: qty=${a.qty}, shortfall=${a.shortfall}, source=${a.source}, factory=${a.factories?.name ?? "—"}`,
  );
}

console.log("\n=== allocation_factories (splits) ===");
for (const s of splits ?? []) {
  console.log(
    `store=${s.store_id.slice(0, 8)} / item=${s.item_id.slice(0, 8)} from ${s.factories?.name ?? s.factory_id}: ${s.qty}`,
  );
}

console.log("\n=== po_lines ===");
for (const p of pos ?? []) {
  console.log(`${p.purchase_orders.suppliers.name} / ${p.items.name}: ${p.qty}`);
}
