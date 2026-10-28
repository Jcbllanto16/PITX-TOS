// Gate hardware endpoint for PITX TOS.
//
// Cameras / RFID readers (or the vendor's controller) POST each read here and
// get back what the barrier should do. The decision itself is made by the
// public.gate_read() database function, so the same rules apply to real
// hardware and to the "Test a vehicle" buttons in the web app.
//
// Deploy:   supabase functions deploy gate-read --no-verify-jwt
// Secret:   supabase secrets set DEVICE_API_KEY=<long random string>
//
// Request:  POST /functions/v1/gate-read
//           header  x-device-key: <DEVICE_API_KEY>
//           body    { "gate": "G1", "plate": "NBC 4821", "confidence": 0.94, "device_id": "G1-LPR" }
// Response: { "action": "OPEN" | "KEEP_CLOSED" | "DIRECT_TO_STAGING" | "WAIT_FOR_ADMIN",
//             "decision": "ALLOW", "reason": "On schedule", "event_id": 123 }
//
// When the action is WAIT_FOR_ADMIN, the barrier controller should wait for the
// admin decision: subscribe to Supabase Realtime on public.gate_events (UPDATE
// where id = event_id) and open when barrier_opened becomes true, or poll
// GET /functions/v1/gate-read?event_id=123 every few seconds.

import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function actionFor(ev: { decision: string; barrier_opened: boolean; pending: boolean; resolution: string | null }) {
  if (ev.barrier_opened) return "OPEN";
  if (ev.pending) return "WAIT_FOR_ADMIN";
  if (ev.decision === "HOLD") return "DIRECT_TO_STAGING";
  return "KEEP_CLOSED";
}

Deno.serve(async (req) => {
  const key = Deno.env.get("DEVICE_API_KEY");
  if (!key || req.headers.get("x-device-key") !== key) return json({ error: "Unknown device" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Barrier controllers waiting on an admin decision.
  if (req.method === "GET") {
    const id = Number(new URL(req.url).searchParams.get("event_id"));
    if (!id) return json({ error: "event_id is required" }, 400);
    const { data, error } = await sb.from("gate_events").select("*").eq("id", id).single();
    if (error) return json({ error: error.message }, 404);
    return json({ action: actionFor(data), decision: data.decision, resolution: data.resolution, reason: data.reason, event_id: data.id });
  }

  if (req.method !== "POST") return json({ error: "Use POST for reads, GET to check a decision" }, 405);

  let body: { gate?: string; plate?: string; confidence?: number; device_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  const { gate, plate, confidence = 0.95, device_id } = body;
  if (!gate || !plate) return json({ error: "gate and plate are required" }, 400);

  if (device_id) {
    await sb.from("devices").update({ last_heartbeat: new Date().toISOString(), status: "online" }).eq("id", device_id);
  }

  const { data, error } = await sb.rpc("gate_read", { p_gate: gate, p_plate: plate, p_confidence: confidence });
  if (error) return json({ error: error.message }, 400);

  return json({ action: actionFor(data), decision: data.decision, reason: data.reason, event_id: data.id });
});
