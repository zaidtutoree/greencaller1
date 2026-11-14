// Returns a short TTS audio preview for a Telnyx voice. Admin-token gated.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const telnyxKey = Deno.env.get("TELNYX_API_KEY");

    const adminToken = req.headers.get("x-admin-token");
    if (!adminToken) return new Response(JSON.stringify({ error: "Missing admin token" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const { data: session } = await supabase
      .from("admin_sessions").select("id, expires_at")
      .eq("token", adminToken).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (!session) return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { voice, text } = await req.json();
    if (!voice) return new Response(JSON.stringify({ error: "voice required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const r = await fetch("https://api.telnyx.com/v2/text-to-speech/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${telnyxKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ voice, text: text || "Hi! This is a preview of how I'll sound on your calls." }),
    });
    if (!r.ok) {
      const t = await r.text();
      return new Response(JSON.stringify({ error: "TTS failed", detail: t.slice(0, 300) }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const audio = await r.arrayBuffer();
    return new Response(audio, { headers: { ...corsHeaders, "Content-Type": "audio/mpeg" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
