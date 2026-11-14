// Admin backend for the "AI Lab": manage Telnyx AI Assistants.
// Gated by the admin session token (x-admin-token) like the other admin-* fns.
// Actions: list, get, voices, create, update, delete, assign-user, assign-number, unassign-number.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
};

const TELNYX = "https://api.telnyx.com/v2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Standard fields the admin can ask the assistant to collect.
const FIELD_LABELS: Record<string, string> = {
  name: "the caller's full name",
  email: "the caller's email address",
  phone: "the caller's phone number",
  company: "the caller's company or business name",
  reason: "the reason for their call",
  address: "the caller's address",
  appointment: "their preferred appointment date and time",
  budget: "their budget",
};

function compileInstructions(characterPrompt: string, fields: string[]): string {
  const persona = (characterPrompt || "You are a helpful, professional phone assistant.").trim();
  if (!fields || fields.length === 0) return persona;
  const list = fields.map((f) => FIELD_LABELS[f] || f).filter(Boolean);
  const collect =
    "\n\nDuring the conversation, naturally and politely collect the following information from the caller, " +
    "confirming each detail back to them: " + list.join(", ") + ". " +
    "If the caller is reluctant, ask once more politely and then move on. Do not invent information.";
  return persona + collect;
}

// Availability section appended to instructions so admin edits don't wipe the
// booked-slots the user set in their calendar. Mirrors ai-availability.
function weekdayName(dateStr: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(dateStr + "T12:00:00Z"));
}
function prettyDate(dateStr: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(dateStr + "T12:00:00Z"));
}
function availabilitySection(slots: any[], tz: string): string {
  if (!slots || !slots.length) return "";
  const lines = slots.map((s) => `- ${weekdayName(s.slot_date)} ${prettyDate(s.slot_date)} at ${s.slot_time}`).join("\n");
  return (
    `\n\n## Appointment availability\n` +
    `The current date and time is {{telnyx_current_time_${tz}}}.\n` +
    `These appointment slots are ALREADY BOOKED and unavailable:\n${lines}\n\n` +
    `When a caller asks to book an appointment: work out the actual date they mean from the current date, then check it against the booked slots above. ` +
    `If the requested slot is already booked, politely tell them that time is unavailable, then either suggest another time that day which is not in the booked list, or ask them for another day and time that works. ` +
    `Never confirm a booking for a slot that appears in the booked list.`
  );
}

async function telnyx(method: string, path: string, apiKey: string, body?: unknown) {
  const res = await fetch(`${TELNYX}${path}`, {
    method,
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// The TeXML app that answers normal inbound calls (voice_url -> our telnyx-incoming-call).
// NOTE: TELNYX_CONNECTION_ID is the WebRTC *credential* connection, NOT this app — restoring a
// number to it leaves inbound calls with no webhook (silence). Discover the real app by URL,
// with TELNYX_INBOUND_TEXML_APP_ID as an explicit override.
async function inboundTexmlAppId(apiKey: string): Promise<string | null> {
  const override = Deno.env.get("TELNYX_INBOUND_TEXML_APP_ID");
  if (override) return override;
  const target = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telnyx-incoming-call`;
  const res = await telnyx("GET", "/texml_applications?page[size]=100", apiKey);
  const apps: any[] = res.data?.data || [];
  const match = apps.find((a) => a.voice_url === target && a.active !== false) || apps.find((a) => a.voice_url === target);
  return match?.id || null;
}

// Restore a number that was pointed at an assistant back to the normal inbound flow.
async function restoreNumberToInbound(apiKey: string, telnyxPhoneNumberId: string) {
  const appId = await inboundTexmlAppId(apiKey);
  if (!appId) {
    console.error("restoreNumberToInbound: no inbound TeXML app found; number left unrouted", telnyxPhoneNumberId);
    return { ok: false, data: null };
  }
  const r = await telnyx("PATCH", `/phone_numbers/${telnyxPhoneNumberId}`, apiKey, { connection_id: appId });
  if (!r.ok) console.error("restoreNumberToInbound failed", r.data);
  return r;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const telnyxKey = Deno.env.get("TELNYX_API_KEY");
    const supabase = createClient(supabaseUrl, serviceKey);

    // --- admin auth (same pattern as other admin-* functions) ---
    const adminToken = req.headers.get("x-admin-token");
    if (!adminToken) return json({ error: "Missing admin token" }, 401);
    const { data: session } = await supabase
      .from("admin_sessions")
      .select("*, admin_users!inner(*)")
      .eq("token", adminToken)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (!session) return json({ error: "Invalid or expired admin session" }, 401);

    const { action, ...params } = await req.json();

    // ---- read actions ----
    if (action === "list") {
      const { data, error } = await supabase
        .from("ai_assistants")
        .select("*, profiles:assigned_user_id(id, full_name, email)")
        .order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500);
      return json({ assistants: data || [] });
    }

    if (action === "users") {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, account_type")
        .order("full_name", { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ users: data || [] });
    }

    if (action === "voices") {
      if (!telnyxKey) return json({ error: "TELNYX_API_KEY not configured" }, 500);
      const r = await telnyx("GET", "/text-to-speech/voices", telnyxKey);
      const all: any[] = r.data?.voices || [];
      // English voices from the natural (telnyx) and AWS providers, curated for a usable dropdown.
      const voices = all
        .filter((v) => typeof v.language === "string" && v.language.toLowerCase().startsWith("en"))
        .filter((v) => v.provider === "telnyx" || v.provider === "aws")
        .map((v) => ({ id: v.id, name: v.name, provider: v.provider, gender: v.gender, language: v.language }));
      return json({ voices });
    }

    if (action === "models") {
      // Models confirmed available for Telnyx AI Assistants.
      return json({
        models: [
          { id: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5 (fast, recommended)" },
          { id: "openai/gpt-4o", label: "GPT-4o" },
          { id: "openai/gpt-4.1", label: "GPT-4.1" },
        ],
      });
    }

    // ---- write actions (need Telnyx) ----
    if (!telnyxKey) return json({ error: "TELNYX_API_KEY not configured" }, 500);

    if (action === "create") {
      const { name, description, model, character_prompt, greeting, voice, collect_fields } = params;
      if (!name) return json({ error: "name is required" }, 400);
      const fields: string[] = Array.isArray(collect_fields) ? collect_fields : [];
      const instructions = compileInstructions(character_prompt || "", fields);
      const chosenModel = model || "anthropic/claude-haiku-4-5";
      const chosenVoice = voice || "Telnyx.KokoroTTS.af_heart";

      const created = await telnyx("POST", "/ai/assistants", telnyxKey, {
        name,
        model: chosenModel,
        instructions,
        greeting: greeting || `Hello, thank you for calling. How can I help you today?`,
        voice_settings: { voice: chosenVoice },
      });
      if (!created.ok) {
        return json({ error: created.data?.errors?.[0]?.detail || "Telnyx create failed", telnyx: created.data }, 502);
      }
      const a = created.data;
      const { data: row, error } = await supabase
        .from("ai_assistants")
        .insert({
          telnyx_assistant_id: a.id,
          telnyx_texml_app_id: a.telephony_settings?.default_texml_app_id || null,
          insight_group_id: a.insight_settings?.insight_group_id || null,
          name,
          description: description || null,
          model: chosenModel,
          character_prompt: character_prompt || null,
          instructions,
          greeting: greeting || null,
          voice: chosenVoice,
          collect_fields: fields,
        })
        .select()
        .single();
      if (error) {
        // roll back the Telnyx assistant so we don't orphan it
        await telnyx("DELETE", `/ai/assistants/${a.id}`, telnyxKey);
        return json({ error: error.message }, 500);
      }
      return json({ assistant: row });
    }

    if (action === "update") {
      const { id, name, description, model, character_prompt, greeting, voice, collect_fields } = params;
      if (!id) return json({ error: "id is required" }, 400);
      const { data: existing } = await supabase.from("ai_assistants").select("*").eq("id", id).single();
      if (!existing) return json({ error: "Assistant not found" }, 404);

      const fields: string[] = Array.isArray(collect_fields) ? collect_fields : (existing.collect_fields as string[]) || [];
      const instructions = compileInstructions(
        character_prompt ?? existing.character_prompt ?? "",
        fields,
      );
      const chosenModel = model || existing.model;
      const chosenVoice = voice || existing.voice;

      if (existing.telnyx_assistant_id) {
        // Preserve the user's booked-slots availability section.
        const today = new Date().toISOString().slice(0, 10);
        const { data: slots } = await supabase
          .from("ai_booked_slots").select("slot_date, slot_time")
          .eq("assistant_id", id).gte("slot_date", today)
          .order("slot_date", { ascending: true }).order("slot_time", { ascending: true });
        const { data: oh } = await supabase
          .from("opening_hours").select("timezone").eq("user_id", existing.assigned_user_id || "").maybeSingle();
        const fullInstructions = instructions + availabilitySection(slots || [], oh?.timezone || "Europe/London");

        const upd = await telnyx("POST", `/ai/assistants/${existing.telnyx_assistant_id}`, telnyxKey, {
          name: name ?? existing.name,
          model: chosenModel,
          instructions: fullInstructions,
          greeting: greeting ?? existing.greeting ?? undefined,
          voice_settings: { voice: chosenVoice },
        });
        if (!upd.ok) return json({ error: upd.data?.errors?.[0]?.detail || "Telnyx update failed", telnyx: upd.data }, 502);
      }

      const { data: row, error } = await supabase
        .from("ai_assistants")
        .update({
          name: name ?? existing.name,
          description: description ?? existing.description,
          model: chosenModel,
          character_prompt: character_prompt ?? existing.character_prompt,
          instructions,
          greeting: greeting ?? existing.greeting,
          voice: chosenVoice,
          collect_fields: fields,
        })
        .eq("id", id)
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ assistant: row });
    }

    // List Telnyx numbers available to be turned into an AI line:
    // provider telnyx, not assigned to a user, and not already used by another assistant.
    if (action === "numbers") {
      const { id } = params; // current assistant (to include its own number)
      const { data: nums } = await supabase
        .from("phone_numbers")
        .select("id, phone_number, assigned_to")
        .eq("provider", "telnyx")
        .is("assigned_to", null);
      const { data: used } = await supabase
        .from("ai_assistants")
        .select("id, telnyx_phone_number")
        .not("telnyx_phone_number", "is", null);
      const takenByOthers = new Set(
        (used || []).filter((u) => u.id !== id).map((u) => u.telnyx_phone_number),
      );
      const available = (nums || [])
        .filter((n) => !takenByOthers.has(n.phone_number))
        .map((n) => ({ phone_number: n.phone_number }));
      return json({ numbers: available });
    }

    // Point a dedicated number at this assistant's TeXML app so Telnyx AI answers it.
    // This ONLY touches spare numbers and never the main call flow.
    if (action === "assign-number") {
      const { id, phone_number } = params;
      if (!id || !phone_number) return json({ error: "id and phone_number are required" }, 400);
      const { data: a } = await supabase.from("ai_assistants").select("*").eq("id", id).single();
      if (!a) return json({ error: "Assistant not found" }, 404);
      if (!a.telnyx_texml_app_id) return json({ error: "Assistant has no TeXML app id" }, 400);

      // Find the Telnyx phone number id for this E.164 number.
      const lookup = await telnyx("GET", `/phone_numbers?filter[phone_number]=${encodeURIComponent(phone_number)}`, telnyxKey);
      const tnum = lookup.data?.data?.[0];
      if (!tnum?.id) return json({ error: "Number not found on Telnyx account", telnyx: lookup.data }, 404);

      // Route the number's voice connection to the assistant's TeXML app.
      const patch = await telnyx("PATCH", `/phone_numbers/${tnum.id}`, telnyxKey, {
        connection_id: a.telnyx_texml_app_id,
      });
      if (!patch.ok) return json({ error: patch.data?.errors?.[0]?.detail || "Failed to route number", telnyx: patch.data }, 502);

      const { data: row, error } = await supabase
        .from("ai_assistants")
        .update({ telnyx_phone_number: phone_number, telnyx_phone_number_id: tnum.id })
        .eq("id", id)
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ assistant: row });
    }

    if (action === "unassign-number") {
      const { id } = params;
      if (!id) return json({ error: "id is required" }, 400);
      const { data: a } = await supabase.from("ai_assistants").select("*").eq("id", id).single();
      if (!a) return json({ error: "Assistant not found" }, 404);
      if (a.telnyx_phone_number_id) {
        // Restore the number to the inbound TeXML app (normal call flow).
        await restoreNumberToInbound(telnyxKey, a.telnyx_phone_number_id);
      }
      const { data: row, error } = await supabase
        .from("ai_assistants")
        .update({ telnyx_phone_number: null, telnyx_phone_number_id: null })
        .eq("id", id)
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ assistant: row });
    }

    if (action === "assign-user") {
      const { id, user_id } = params; // user_id may be null to unassign
      if (!id) return json({ error: "id is required" }, 400);
      const { data: row, error } = await supabase
        .from("ai_assistants")
        .update({ assigned_user_id: user_id || null })
        .eq("id", id)
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ assistant: row });
    }

    if (action === "delete") {
      const { id } = params;
      if (!id) return json({ error: "id is required" }, 400);
      const { data: existing } = await supabase.from("ai_assistants").select("*").eq("id", id).single();
      // Give the dedicated number back to the normal call flow BEFORE deleting the assistant,
      // otherwise the number stays pointed at the assistant's (now dead) TeXML app and callers hear silence.
      if (existing?.telnyx_phone_number_id) {
        await restoreNumberToInbound(telnyxKey, existing.telnyx_phone_number_id);
      }
      if (existing?.telnyx_assistant_id) {
        await telnyx("DELETE", `/ai/assistants/${existing.telnyx_assistant_id}`, telnyxKey);
      }
      if (existing?.telnyx_texml_app_id) {
        // Best-effort: remove the assistant's auto-provisioned TeXML app so it can't be left dangling.
        await telnyx("DELETE", `/texml_applications/${existing.telnyx_texml_app_id}`, telnyxKey);
      }
      const { error } = await supabase.from("ai_assistants").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("admin-ai-assistant error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
