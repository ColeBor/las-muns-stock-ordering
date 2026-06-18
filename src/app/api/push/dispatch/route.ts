import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";

// Fan a single alert out to every manager's installed devices as a Web Push
// notification. Called server-to-server by the Postgres event triggers (via
// pg_net), NOT by browsers — it's gated by a shared secret and uses the
// service-role Supabase client to read across all managers' subscriptions.
//
// "Manager" == the boss == profiles.role = 'store_manager' AFTER the role
// terminology rename (migration 20260513140000): the enum value 'store_manager'
// now means the boss; front-line workers are 'employee'. Do not change this to
// 'hq_admin' — that value no longer exists.

// web-push relies on Node crypto, so force the Node runtime (not Edge).
export const runtime = "nodejs";

const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT;
const dispatchSecret = process.env.PUSH_DISPATCH_SECRET;

let vapidConfigured = false;
function ensureVapid(): boolean {
  if (vapidConfigured) return true;
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) return false;
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  vapidConfigured = true;
  return true;
}

type DispatchBody = {
  kind?: string;
  event_key?: string;
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
};

type SubRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export async function POST(request: NextRequest) {
  // 1. Authenticate the caller (our own database, via pg_net).
  if (!dispatchSecret) {
    return NextResponse.json(
      { error: "Push dispatch not configured (missing PUSH_DISPATCH_SECRET)" },
      { status: 503 },
    );
  }
  if (request.headers.get("x-dispatch-secret") !== dispatchSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ensureVapid()) {
    return NextResponse.json(
      { error: "Push dispatch not configured (missing VAPID keys)" },
      { status: 503 },
    );
  }

  let payload: DispatchBody;
  try {
    payload = (await request.json()) as DispatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const title = payload.title?.trim();
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  // 2. Find the managers (the boss role) and their devices.
  const { data: managers, error: mgrErr } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("role", "store_manager");
  if (mgrErr) {
    return NextResponse.json({ error: mgrErr.message }, { status: 500 });
  }
  const managerIds = (managers ?? []).map((m) => m.id);
  if (managerIds.length === 0) {
    return NextResponse.json({ sent: 0, pruned: 0, note: "no managers" });
  }

  const { data: subs, error: subErr } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id,endpoint,p256dh,auth")
    .in("user_id", managerIds);
  if (subErr) {
    return NextResponse.json({ error: subErr.message }, { status: 500 });
  }
  if (!subs || subs.length === 0) {
    return NextResponse.json({ sent: 0, pruned: 0, note: "no subscriptions" });
  }

  // 3. Send. The browser only needs title/body/url/tag — keep the payload small.
  const notification = JSON.stringify({
    title,
    body: payload.body ?? "",
    url: payload.url ?? "/",
    tag: payload.tag ?? payload.event_key ?? payload.kind,
  });

  const deadSubIds: string[] = [];
  let sent = 0;

  await Promise.all(
    (subs as SubRow[]).map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          notification,
        );
        sent += 1;
      } catch (err: unknown) {
        // 404 = endpoint gone, 410 = subscription expired/unsubscribed. Either
        // way the device will never receive again — prune it so the table
        // doesn't accumulate dead rows and we stop wasting sends.
        const statusCode =
          typeof err === "object" && err !== null && "statusCode" in err
            ? (err as { statusCode?: number }).statusCode
            : undefined;
        if (statusCode === 404 || statusCode === 410) {
          deadSubIds.push(sub.id);
        } else {
          // eslint-disable-next-line no-console
          console.error("web-push send failed:", statusCode, err);
        }
      }
    }),
  );

  if (deadSubIds.length > 0) {
    await supabaseAdmin.from("push_subscriptions").delete().in("id", deadSubIds);
  }

  return NextResponse.json({ sent, pruned: deadSubIds.length });
}
