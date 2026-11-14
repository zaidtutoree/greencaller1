// Slack OAuth redirect target (public — Slack redirects the browser here).
// Verifies the CSRF state, exchanges the code for a bot token, stores it for
// the company, and shows a small success page.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

function page(title: string, message: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1b2a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#132133;border:1px solid #22344a;border-radius:16px;padding:40px;max-width:420px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#9fb0c3;margin:0}
.ok{color:#22c55e;font-size:40px;margin-bottom:12px}
</style></head><body><div class="card"><div class="ok">${title.includes("Connected") ? "✓" : "⚠"}</div>
<h1>${title}</h1><p>${message}</p></div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}

serve(async (req) => {
  try {
    const u = new URL(req.url);
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    const oauthError = u.searchParams.get("error");
    if (oauthError) return page("Slack connection cancelled", "You can close this tab and try again.");
    if (!code || !state) return page("Something went wrong", "Missing authorization code. Please close this tab and retry.");

    const url = Deno.env.get("SUPABASE_URL")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("SLACK_CLIENT_ID")!;
    const clientSecret = Deno.env.get("SLACK_CLIENT_SECRET")!;
    const admin = createClient(url, service);

    // Validate + consume the state nonce.
    const { data: st } = await admin.from("slack_oauth_states").select("*").eq("state", state).maybeSingle();
    if (!st || new Date(st.expires_at).getTime() < Date.now()) {
      return page("Link expired", "This connection link has expired. Please start again from Greencaller.");
    }
    await admin.from("slack_oauth_states").delete().eq("state", state);

    // Exchange the code for a bot token.
    const redirectUri = `${url}/functions/v1/slack-oauth-callback`;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("Slack oauth.v2.access failed:", data);
      return page("Couldn't connect Slack", `Slack said: ${data.error || "unknown error"}. Please try again.`);
    }

    const slackUserId = data.authed_user?.id || null;

    if (st.mode === "link") {
      // Per-user link: just record who this Greencaller user is in Slack.
      if (st.user_id && slackUserId) {
        await admin.from("slack_user_links").upsert({
          user_id: st.user_id,
          company_name: st.company_name,
          slack_user_id: slackUserId,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      }
      return page("Slack Account Linked", "Your Slack account is linked — you'll now get call notifications as a DM. You can close this tab.");
    }

    // Install: store the company workspace token, and auto-link the installer.
    await admin.from("slack_integrations").upsert({
      company_name: st.company_name,
      team_id: data.team?.id || null,
      team_name: data.team?.name || null,
      bot_token: data.access_token,
      installed_by: st.user_id || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "company_name" });

    if (st.user_id && slackUserId) {
      await admin.from("slack_user_links").upsert({
        user_id: st.user_id,
        company_name: st.company_name,
        slack_user_id: slackUserId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    }

    return page("Slack Connected", `Greencaller is now connected to ${data.team?.name || "your workspace"}. You can close this tab.`);
  } catch (e) {
    console.error("slack-oauth-callback error:", e);
    return page("Something went wrong", "Please close this tab and try connecting again.");
  }
});
