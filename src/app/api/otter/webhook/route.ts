import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Otter's webhook signature is HMAC-SHA256 over the RAW request body, so we
// must read the body as text (not request.json()) and run on the Node runtime
// for the crypto module. Never let Next pre-parse/cache the body.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNATURE_HEADER = "x-hmac-sha256";

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------
// Per Otter docs: base64( HMAC_SHA256( utf8(rawBody), utf8(secret) ) ),
// delivered in the X-HMAC-SHA256 header on EVERY webhook.
function verifySignature(rawBody: string, headerValue: string | null, secret: string): boolean {
  if (!headerValue) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(headerValue, "utf8");
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length
  // signature fails cleanly instead of 500-ing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------
// The exact Otter order schema is pinned against a real captured payload (see
// the `raw` column). Until then these helpers probe the likely field paths
// and fall back gracefully. Every column can be re-derived from `raw` later,
// so a wrong guess here never loses data.
type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function firstString(obj: Json | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

// Find the order object inside the webhook envelope, trying common nestings.
function locateOrder(payload: Json): Json | null {
  return (
    asObj(payload.order) ??
    asObj((asObj(payload.data) ?? {}).order) ??
    asObj((asObj(payload.metadata) ?? {}).order) ??
    asObj(payload.data) ??
    // Some POS consumer events put order fields at the top level.
    (firstString(payload, ["id", "orderId", "orderToken"]) ? payload : null)
  );
}

function locateItems(order: Json): Json[] {
  const candidates = [order.items, order.lineItems, order.cartItems, asObj(order.cart)?.items];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.filter((x): x is Json => !!asObj(x));
  }
  return [];
}

function extractCustomerName(order: Json): string | null {
  const c = asObj(order.customer) ?? asObj(order.eater);
  if (c) {
    const direct = firstString(c, ["name", "displayName", "fullName"]);
    if (direct) return direct;
    const first = firstString(c, ["firstName", "givenName"]);
    const last = firstString(c, ["lastName", "familyName"]);
    const joined = [first, last].filter(Boolean).join(" ").trim();
    if (joined) return joined;
  }
  return firstString(order, ["customerName"]);
}

function extractScheduledFor(order: Json): string | null {
  const fulfillment = asObj(order.fulfillment) ?? asObj(order.fulfillmentInfo) ?? order;
  return firstString(fulfillment, [
    "scheduledTime",
    "scheduledFor",
    "estimatedPickupTime",
    "pickupTime",
    "fulfillmentTime",
    "requestedTime",
  ]);
}

function isScheduledOrder(order: Json, scheduledFor: string | null): boolean {
  const flag = order.isScheduled ?? order.scheduled;
  if (typeof flag === "boolean") return flag;
  const timing = firstString(order, ["timing", "orderTiming", "fulfillmentTiming"]);
  if (timing) return /schedul/i.test(timing);
  return scheduledFor !== null;
}

export async function POST(request: NextRequest) {
  const secret = process.env.OTTER_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfiguration — fail loudly rather than accepting unverified data.
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get(SIGNATURE_HEADER), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Json;
  try {
    payload = JSON.parse(rawBody) as Json;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = firstString(payload, ["eventType", "type", "event"]) ?? "";
  const order = locateOrder(payload);

  // Not an order event (status pings, menu events, etc.) — acknowledge so
  // Otter doesn't retry. We can widen handling later.
  if (!order) {
    return NextResponse.json({ ok: true, ignored: eventType || "unknown" });
  }

  const otterOrderId = firstString(order, ["id", "orderId", "orderToken", "token"]);
  if (!otterOrderId) {
    // Can't key it idempotently; keep the raw payload for inspection but don't
    // pretend we processed an order.
    return NextResponse.json({ ok: true, ignored: "order-without-id" });
  }

  const otterStoreId = firstString(order, ["storeId", "locationId"]) ??
    firstString(asObj(order.store), ["id"]) ??
    firstString(asObj(order.location), ["id"]) ??
    firstString(payload, ["storeId", "locationId"]);

  // Resolve our store_id from the mapping (service role bypasses RLS).
  let storeId: string | null = null;
  if (otterStoreId) {
    const { data: link } = await supabaseAdmin
      .from("otter_store_links")
      .select("store_id")
      .eq("otter_store_id", otterStoreId)
      .maybeSingle();
    storeId = (link?.store_id as string | undefined) ?? null;
  }

  const isCancel = /cancel/i.test(eventType);
  const scheduledFor = extractScheduledFor(order);
  const items = locateItems(order);

  const row = {
    otter_order_id: otterOrderId,
    otter_store_id: otterStoreId,
    store_id: storeId,
    display_id: firstString(order, ["displayId", "friendlyId", "externalId", "number"]),
    customer_name: extractCustomerName(order),
    fulfillment_mode: firstString(order, ["fulfillmentMode", "orderType", "type"]) ??
      firstString(asObj(order.fulfillment), ["type", "mode"]),
    status: firstString(order, ["status", "state"]) ?? (isCancel ? "canceled" : null),
    is_scheduled: isScheduledOrder(order, scheduledFor),
    scheduled_for: scheduledFor,
    placed_at: firstString(order, ["createdAt", "placedAt", "orderedAt"]) ??
      firstString(payload, ["eventTime"]),
    canceled_at: isCancel ? new Date().toISOString() : null,
    item_count: items.length || null,
    raw: payload,
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await supabaseAdmin
    .from("otter_orders")
    .upsert(row, { onConflict: "otter_order_id" });
  if (upsertErr) {
    // Return 500 so Otter retries — better than silently dropping an order.
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  // Replace line items for this order (idempotent on re-delivery / updates).
  if (items.length > 0) {
    await supabaseAdmin.from("otter_order_items").delete().eq("otter_order_id", otterOrderId);
    const itemRows = items.map((it) => ({
      otter_order_id: otterOrderId,
      otter_item_id: firstString(it, ["id", "itemId", "menuItemId", "plu", "sku"]),
      name: firstString(it, ["name", "title", "itemName"]),
      quantity: Number(firstString(it, ["quantity", "qty", "count"]) ?? "1") || 1,
      raw: it,
    }));
    const { error: itemsErr } = await supabaseAdmin.from("otter_order_items").insert(itemRows);
    if (itemsErr) {
      return NextResponse.json({ error: itemsErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, otter_order_id: otterOrderId, store_mapped: !!storeId });
}
