// User-facing stats for the AI assistant assigned to the caller.
// JWT-authed: returns the assistant only if it is assigned to the calling user,
// or — when an assistantId is supplied — if the caller is the company admin
// (profiles.is_company_admin) of the user that assistant is assigned to. That
// second path is what the /control dashboard uses.
// Pulls conversations from Telnyx, and for each derives the collected fields +
// a short summary from the transcript (cached in ai_conversation_data).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const TELNYX = "https://api.telnyx.com/v2";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function tGet(path: string, key: string, timeoutMs = 12000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${TELNYX}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal });
    const t = await r.text();
    let d: any; try { d = JSON.parse(t); } catch { d = t; }
    return { ok: r.ok, status: r.status, data: d };
  } catch (e) {
    return { ok: false, status: 0, data: String(e) };
  } finally { clearTimeout(to); }
}

const FIELD_LABELS: Record<string, string> = {
  name: "Name", email: "Email", phone: "Phone number", company: "Company",
  reason: "Reason for call", address: "Address", appointment: "Appointment time", budget: "Budget",
};

// Build a transcript string from a Telnyx messages payload (shape-tolerant).
function buildTranscript(messagesData: any): string {
  let arr = messagesData?.data || messagesData?.messages || (Array.isArray(messagesData) ? messagesData : []);
  if (!Array.isArray(arr)) return "";
  // Telnyx returns newest-first; sort chronologically for a readable transcript.
  arr = [...arr].sort((a: any, b: any) =>
    new Date(a.sent_at || a.created_at || 0).getTime() - new Date(b.sent_at || b.created_at || 0).getTime());
  return arr
    .map((m: any) => {
      const role = m.role || m.sender || m.type || "";
      const content = typeof m.content === "string" ? m.content
        : (m.text || m.message || (Array.isArray(m.content) ? m.content.map((c: any) => c.text || "").join(" ") : ""));
      if (!content) return "";
      const who = /assist|agent|bot/i.test(role) ? "Assistant" : "Caller";
      return `${who}: ${content}`;
    })
    .filter(Boolean)
    .join("\n");
}

async function extractWithLLM(transcript: string, fields: string[], openAIKey: string) {
  const wanted = fields.map((f) => `"${f}": ${FIELD_LABELS[f] || f}`).join(", ");
  const sys = "You extract structured data from a phone call transcript. Only use information the caller actually provided. Return strict JSON.";
  const user =
    `Transcript:\n${transcript}\n\n` +
    `Return a JSON object with:\n` +
    `- "summary": one short sentence describing the call.\n` +
    (fields.length ? `- "collected": an object with any of these keys that the caller provided { ${wanted} }. Omit keys not provided. Values as plain strings.\n` : `- "collected": {}\n`) +
    `Only JSON, no prose.`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openAIKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.4-nano",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      reasoning_effort: "none",
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) return { summary: null, collected: {} };
  const d = await r.json();
  try {
    const parsed = JSON.parse(d.choices?.[0]?.message?.content || "{}");
    const collected: Record<string, string> = {};
    if (parsed.collected && typeof parsed.collected === "object") {
      for (const [k, v] of Object.entries(parsed.collected)) {
        if (v != null && String(v).trim()) collected[FIELD_LABELS[k] || k] = String(v);
      }
    }
    return { summary: parsed.summary || null, collected };
  } catch { return { summary: null, collected: {} }; }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const telnyxKey = Deno.env.get("TELNYX_API_KEY");
    const openAIKey = Deno.env.get("OPENAI_API_KEY");

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(url, service);

    let body: { assistantId?: string } = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }

    let assistant: any = null;
    if (body?.assistantId) {
      const { data: a } = await admin
        .from("ai_assistants").select("*").eq("id", body.assistantId).maybeSingle();
      if (!a) return json({ assistant: null });
      if (a.assigned_user_id !== user.id) {
        const [{ data: me }, { data: owner }] = await Promise.all([
          admin.from("profiles").select("company_name, is_company_admin").eq("id", user.id).maybeSingle(),
          a.assigned_user_id
            ? admin.from("profiles").select("company_name").eq("id", a.assigned_user_id).maybeSingle()
            : Promise.resolve({ data: null as { company_name: string | null } | null }),
        ]);
        const allowed = !!me?.is_company_admin && !!me?.company_name && owner?.company_name === me.company_name;
        if (!allowed) return json({ error: "Forbidden" }, 403);
      }
      assistant = a;
    } else {
      const { data: a } = await admin
        .from("ai_assistants").select("*").eq("assigned_user_id", user.id).maybeSingle();
      assistant = a;
    }
    if (!assistant) return json({ assistant: null });
    // Cached extractions belong to the assistant's user, not whoever is viewing.
    const ownerUserId: string = assistant.assigned_user_id || user.id;

    const summary = {
      id: assistant.id, name: assistant.name, description: assistant.description,
      voice: assistant.voice, greeting: assistant.greeting,
      phone_number: assistant.telnyx_phone_number,
      collect_fields: assistant.collect_fields || [], is_active: assistant.is_active,
      has_number: !!assistant.telnyx_phone_number,
    };
    const emptyStats = { calls: 0, avg_duration_secs: 0, total_duration_secs: 0 };

    if (!telnyxKey || !assistant.telnyx_assistant_id) {
      return json({ assistant: summary, stats: emptyStats, conversations: [] });
    }

    const aid = assistant.telnyx_assistant_id;
    const fields: string[] = assistant.collect_fields || [];

    // List conversations (plain list; nested metadata filter isn't supported), then
    // keep only this assistant's, most recent first.
    const list = await tGet(`/ai/conversations?page[size]=100`, telnyxKey);
    let convs: any[] = Array.isArray(list.data?.data) ? list.data.data : [];
    convs = convs.filter((c: any) => c?.metadata?.assistant_id === aid);
    convs.sort((a: any, b: any) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

    // If Telnyx is unreachable, fall back to cached rows so the tab still shows data.
    if (!list.ok && convs.length === 0) {
      const { data: cached } = await admin
        .from("ai_conversation_data").select("*").eq("assistant_id", aid)
        .order("started_at", { ascending: false });
      const conversations = (cached || []).map((c) => ({
        id: c.conversation_id, started_at: c.started_at, duration_secs: c.duration_secs || 0,
        from: c.from_number, summary: c.summary, collected: c.collected || {},
      }));
      const durs = conversations.map((c) => c.duration_secs).filter(Boolean);
      return json({
        assistant: summary,
        stats: { calls: conversations.length, avg_duration_secs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0, total_duration_secs: durs.reduce((a, b) => a + b, 0) },
        conversations, degraded: true,
      });
    }

    // Load any cached extractions for these conversations.
    const ids = convs.map((c: any) => c.id);
    const { data: cachedRows } = ids.length
      ? await admin.from("ai_conversation_data").select("*").in("conversation_id", ids)
      : { data: [] as any[] };
    const cacheMap = new Map((cachedRows || []).map((r: any) => [r.conversation_id, r]));

    const durations: number[] = [];
    const conversations: any[] = [];

    for (const c of convs) {
      const start = c.created_at || null;
      const end = c.last_message_at || c.updated_at || null;
      let dur = 0;
      if (start && end) dur = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
      if (dur) durations.push(dur);
      const from = c.metadata?.from || null;

      let collected: Record<string, string> = {};
      let convSummary: string | null = null;

      const cached = cacheMap.get(c.id);
      if (cached) {
        collected = cached.collected || {};
        convSummary = cached.summary || null;
      } else if (openAIKey) {
        // Fetch transcript and extract on first sight; then cache.
        const msgs = await tGet(`/ai/conversations/${c.id}/messages?page[size]=100`, telnyxKey);
        const transcript = msgs.ok ? buildTranscript(msgs.data) : "";
        if (transcript) {
          const ex = await extractWithLLM(transcript, fields, openAIKey);
          collected = ex.collected;
          convSummary = ex.summary;
          await admin.from("ai_conversation_data").upsert({
            conversation_id: c.id, assistant_id: aid, user_id: ownerUserId,
            from_number: from, started_at: start, duration_secs: dur,
            summary: convSummary, collected,
          });
        }
      }

      conversations.push({ id: c.id, started_at: start, duration_secs: dur, from, summary: convSummary, collected });
    }

    return json({
      assistant: summary,
      stats: {
        calls: conversations.length,
        avg_duration_secs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
        total_duration_secs: durations.reduce((a, b) => a + b, 0),
      },
      conversations,
    });
  } catch (e) {
    console.error("ai-assistant-stats error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
