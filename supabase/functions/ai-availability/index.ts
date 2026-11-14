// Manages an AI assistant's booked appointment slots for the assigned user.
// On every change it rebuilds the Telnyx assistant's instructions so the AI
// knows which slots are taken and won't double-book. JWT-authed + owner-checked.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function weekdayName(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(d);
}
function prettyDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

function availabilitySection(slots: any[], tz: string): string {
  if (!slots.length) return "";
  const lines = slots
    .map((s) => `- ${weekdayName(s.slot_date)} ${prettyDate(s.slot_date)} at ${s.slot_time}`)
    .join("\n");
  return (
    `\n\n## Appointment availability\n` +
    `The current date and time is {{telnyx_current_time_${tz}}}.\n` +
    `These appointment slots are ALREADY BOOKED and unavailable:\n${lines}\n\n` +
    `When a caller asks to book an appointment: work out the actual date they mean from the current date, then check it against the booked slots above. ` +
    `If the requested slot is already booked, politely tell them that time is unavailable, then either suggest another time that day which is not in the booked list, or ask them for another day and time that works. ` +
    `Never confirm a booking for a slot that appears in the booked list.`
  );
}

async function rebuildInstructions(supabase: any, telnyxKey: string, assistant: any, tz: string) {
  if (!assistant.telnyx_assistant_id) return;
  // Upcoming booked slots only.
  const today = new Date().toISOString().slice(0, 10);
  const { data: slots } = await supabase
    .from("ai_booked_slots")
    .select("slot_date, slot_time")
    .eq("assistant_id", assistant.id)
    .gte("slot_date", today)
    .order("slot_date", { ascending: true })
    .order("slot_time", { ascending: true });
  const base = assistant.instructions || "";
  const full = base + availabilitySection(slots || [], tz);
  await fetch(`https://api.telnyx.com/v2/ai/assistants/${assistant.telnyx_assistant_id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${telnyxKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ instructions: full }),
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const telnyxKey = Deno.env.get("TELNYX_API_KEY")!;

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(url, service);
    const { data: assistant } = await admin
      .from("ai_assistants").select("*").eq("assigned_user_id", user.id).maybeSingle();
    if (!assistant) return json({ error: "No assistant assigned" }, 404);

    // Timezone for resolving "Monday" etc — reuse the user's opening hours tz.
    const { data: oh } = await admin.from("opening_hours").select("timezone").eq("user_id", user.id).maybeSingle();
    const tz = oh?.timezone || "Europe/London";

    const { action, slot_date, slot_time, title, id } = await req.json();

    if (action === "list") {
      const { data: slots } = await admin
        .from("ai_booked_slots").select("*").eq("assistant_id", assistant.id)
        .order("slot_date", { ascending: true }).order("slot_time", { ascending: true });
      return json({ slots: slots || [] });
    }

    if (action === "add") {
      if (!slot_date || !slot_time) return json({ error: "slot_date and slot_time required" }, 400);
      const { error } = await admin.from("ai_booked_slots").upsert(
        { assistant_id: assistant.id, user_id: user.id, slot_date, slot_time, title: title || null },
        { onConflict: "assistant_id,slot_date,slot_time" },
      );
      if (error) return json({ error: error.message }, 500);
      await rebuildInstructions(admin, telnyxKey, assistant, tz);
      return json({ ok: true });
    }

    if (action === "remove") {
      if (!id) return json({ error: "id required" }, 400);
      const { error } = await admin.from("ai_booked_slots").delete().eq("id", id).eq("assistant_id", assistant.id);
      if (error) return json({ error: error.message }, 500);
      await rebuildInstructions(admin, telnyxKey, assistant, tz);
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("ai-availability error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
