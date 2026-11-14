// Sends a Slack DM to the owner of a number when a call is missed (and other
// call events later). Called by a DB trigger (pg_net) — verifies a shared
// secret so it can't be spammed. Never touches the call flow.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.81.1?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const APP_ORIGIN = "https://greencaller.app";

async function slack(method: string, botToken: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    // Shared-secret auth (from the DB trigger).
    const expected = Deno.env.get("SLACK_WEBHOOK_SECRET");
    const provided = req.headers.get("x-webhook-secret");
    if (!expected || provided !== expected) return json({ error: "forbidden" }, 403);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json();
    const { type, user_id, from_number, created_at } = body;

    if (type !== "missed_call" || !user_id) return json({ ok: true, skipped: "not a missed call" });

    // Who owns the number + their company.
    const { data: profile } = await admin
      .from("profiles").select("email, full_name, company_name").eq("id", user_id).maybeSingle();
    if (!profile?.company_name || !profile.email) return json({ ok: true, skipped: "no profile/company" });

    // Is the company connected to Slack?
    const { data: integ } = await admin
      .from("slack_integrations").select("bot_token").eq("company_name", profile.company_name).maybeSingle();
    if (!integ?.bot_token) return json({ ok: true, skipped: "company not connected" });
    const botToken = integ.bot_token;

    // Resolve the user's Slack id (cache in slack_user_links).
    let slackUserId: string | null = null;
    const { data: link } = await admin
      .from("slack_user_links").select("slack_user_id").eq("user_id", user_id).maybeSingle();
    if (link?.slack_user_id) {
      slackUserId = link.slack_user_id;
    } else {
      // users.lookupByEmail only accepts a query param (not JSON body).
      const lookupRes = await fetch(
        `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(profile.email)}`,
        { headers: { Authorization: `Bearer ${botToken}` } },
      );
      const lookup = await lookupRes.json();
      if (lookup.ok && lookup.user?.id) {
        slackUserId = lookup.user.id;
        await admin.from("slack_user_links").upsert({
          user_id, company_name: profile.company_name, slack_user_id: slackUserId, slack_email: profile.email,
          updated_at: new Date().toISOString(),
        });
      } else {
        return json({ ok: true, skipped: "slack user not found by email", slack_error: lookup.error });
      }
    }

    // Open a DM and post the missed-call alert.
    const dm = await slack("conversations.open", botToken, { users: slackUserId });
    if (!dm.ok || !dm.channel?.id) return json({ ok: false, step: "conversations.open", slack_error: dm.error });

    const unix = created_at ? Math.floor(new Date(created_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const when = `<!date^${unix}^{date_short_pretty} at {time}|just now>`;
    const post = await slack("chat.postMessage", botToken, {
      channel: dm.channel.id,
      text: `📞 Missed call from ${from_number || "unknown"}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `:telephone_receiver: *Missed call*\nFrom *${from_number || "Unknown"}*\n${when}` },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Call back", emoji: true },
              style: "primary",
              url: `${APP_ORIGIN}/dashboard/dialpad?number=${encodeURIComponent(from_number || "")}`,
            },
          ],
        },
      ],
    });
    if (!post.ok) return json({ ok: false, step: "chat.postMessage", slack_error: post.error });

    return json({ ok: true, delivered_to: slackUserId });
  } catch (e) {
    console.error("slack-notify error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
