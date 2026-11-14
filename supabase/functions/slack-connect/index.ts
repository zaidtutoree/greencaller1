// Slack connection management for enterprise companies (JWT-authed).
// Actions: start (begin OAuth), status (is the company connected?), disconnect.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SCOPES = ["chat:write", "chat:write.public", "commands", "users:read", "users:read.email", "im:write"].join(",");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("SLACK_CLIENT_ID");

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(url, service);
    const { data: profile } = await admin
      .from("profiles").select("company_name, account_type").eq("id", user.id).maybeSingle();

    if (!profile || profile.account_type !== "enterprise" || !profile.company_name) {
      return json({ error: "Slack integration is available to enterprise accounts with a company." }, 403);
    }
    const company = profile.company_name;

    const { action } = await req.json();

    if (action === "status") {
      const { data: integ } = await admin
        .from("slack_integrations").select("team_name, created_at").eq("company_name", company).maybeSingle();
      const { data: link } = await admin
        .from("slack_user_links").select("slack_user_id").eq("user_id", user.id).maybeSingle();
      return json({
        connected: !!integ,
        team_name: integ?.team_name || null,
        connected_at: integ?.created_at || null,
        linked: !!link?.slack_user_id,
      });
    }

    if (action === "disconnect") {
      await admin.from("slack_integrations").delete().eq("company_name", company);
      return json({ ok: true });
    }

    // action "start" = install the company workspace; action "link" = the
    // current user links their personal Slack account (captures their Slack id).
    if (action === "start" || action === "link") {
      if (!clientId) return json({ error: "SLACK_CLIENT_ID not configured" }, 500);
      const mode = action === "link" ? "link" : "install";
      const state = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
      await admin.from("slack_oauth_states").insert({
        state, company_name: company, user_id: user.id, mode,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      const redirectUri = `${url}/functions/v1/slack-oauth-callback`;
      const authorizeUrl =
        `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}`;
      return json({ url: authorizeUrl });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("slack-connect error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
