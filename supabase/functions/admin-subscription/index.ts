import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function validateAdminToken(token: string): Promise<{ valid: boolean; adminId?: string }> {
  const url = `${SUPABASE_URL}/rest/v1/admin_sessions?token=eq.${encodeURIComponent(token)}&select=*,admin_users(*)`;
  const response = await fetch(url, {
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) return { valid: false };
  const sessions = await response.json();
  if (!sessions || sessions.length === 0) return { valid: false };
  const session = sessions[0];
  if (new Date(session.expires_at) <= new Date()) return { valid: false };
  return { valid: true, adminId: session.admin_id };
}

async function supabaseRest(path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (method === "POST") headers["Prefer"] = "return=representation";
  if (method === "PATCH") headers["Prefer"] = "return=minimal";

  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (method === "PATCH" || method === "DELETE") return resp.ok ? null : await resp.text();
  return resp.json();
}

async function stripeRequest(endpoint: string, method = "GET", body?: Record<string, string>) {
  const opts: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      params.append(k, v);
    }
    opts.body = params.toString();
  }
  const resp = await fetch(`https://api.stripe.com/v1/${endpoint}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Stripe error: ${resp.status}`);
  return data;
}

// Get or create the Greencaller overage billing meter
async function getOrCreateOverageMeter(): Promise<string> {
  // List existing meters to find ours
  const listResp = await fetch("https://api.stripe.com/v1/billing/meters?limit=100", {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const listData = await listResp.json();
  if (listData?.data) {
    const existing = listData.data.find((m: any) => m.event_name === "greencaller_overage_minutes");
    if (existing) {
      console.log("Reusing existing billing meter:", existing.id);
      return existing.id;
    }
  }

  // Create a new meter
  const params = new URLSearchParams();
  params.append("display_name", "Overage Minutes");
  params.append("event_name", "greencaller_overage_minutes");
  params.append("default_aggregation[formula]", "sum");

  const createResp = await fetch("https://api.stripe.com/v1/billing/meters", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const createData = await createResp.json();
  if (!createResp.ok) throw new Error(createData?.error?.message || "Failed to create billing meter");
  console.log("Created billing meter:", createData.id);
  return createData.id;
}

// Flatten nested params for Stripe (e.g. line_items[0][price] = ...)
function stripeRequestForm(endpoint: string, method: string, formBody: URLSearchParams) {
  return fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  }).then(async (resp) => {
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || `Stripe error: ${resp.status}`);
    return data;
  });
}

async function sendInviteEmail(params: {
  to: string;
  from: string;
  leadUserName: string;
  trialDays: number;
  amountPounds: string;
  users: { full_name: string; email: string }[];
  checkoutUrl: string;
}) {
  const userListHtml = params.users
    .map((u) => `<li style="padding:4px 0;color:#374151;">${u.full_name} (${u.email})</li>`)
    .join("");

  const trialText = params.trialDays > 0
    ? `<p style="margin:0 0 8px;color:#374151;">You have a <strong>${params.trialDays}-day free trial</strong>. After your trial, your subscription will be <strong>&pound;${params.amountPounds}/month</strong>.</p>`
    : `<p style="margin:0 0 8px;color:#374151;">Your subscription will be <strong>&pound;${params.amountPounds}/month</strong>.</p>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
        <!-- Header -->
        <tr><td style="background-color:#ffffff;padding:32px 40px;text-align:center;border-bottom:1px solid #e5e7eb;">
          <img src="https://greencaller.co.uk/assets/greencaller-logo-BPl5z0ge.png" alt="Greencaller" height="48" style="height:48px;" />
          <h1 style="margin:16px 0 0;color:#0d9668;font-size:22px;font-weight:600;">Your Greencaller Subscription</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 40px;">
          <p style="margin:0 0 16px;color:#374151;font-size:16px;">Hi ${params.leadUserName},</p>
          ${trialText}
          <p style="margin:16px 0 8px;color:#374151;font-size:14px;font-weight:600;">Users included in this subscription:</p>
          <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;">${userListHtml}</ul>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:16px 0;">
              <a href="${params.checkoutUrl}" style="display:inline-block;background-color:#0d9668;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;">Subscribe Now</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;text-align:center;">If you did not expect this email, you can safely ignore it.</p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background-color:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">&copy; ${new Date().getFullYear()} Greencaller. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Greencaller <${params.from}>`,
      to: [params.to],
      subject: "Your Greencaller subscription invitation",
      html,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Failed to send email: ${err}`);
  }

  return await resp.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const adminToken = req.headers.get("x-admin-token");
    if (!adminToken) return jsonResponse({ error: "Admin token required" }, 401);

    const { valid } = await validateAdminToken(adminToken);
    if (!valid) return jsonResponse({ error: "Invalid or expired admin token" }, 401);

    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "list": {
        // List all subscriptions
        const subscriptions = await supabaseRest(
          "subscriptions?select=*&order=created_at.desc"
        );

        if (!Array.isArray(subscriptions)) {
          console.error("Subscriptions query failed:", subscriptions);
          return jsonResponse({ success: true, data: [] });
        }

        // Enrich each subscription with lead user and assigned users
        for (const sub of subscriptions) {
          // Fetch lead user
          const leadUsers = await supabaseRest(
            `profiles?id=eq.${encodeURIComponent(sub.lead_user_id)}&select=id,full_name,email`
          );
          sub.lead_user = Array.isArray(leadUsers) && leadUsers.length > 0 ? leadUsers[0] : null;

          // Fetch subscription users
          const subUsers = await supabaseRest(
            `subscription_users?subscription_id=eq.${encodeURIComponent(sub.id)}&select=user_id,joined_at`
          );
          if (Array.isArray(subUsers)) {
            for (const su of subUsers) {
              const users = await supabaseRest(
                `profiles?id=eq.${encodeURIComponent(su.user_id)}&select=id,full_name,email`
              );
              su.user = Array.isArray(users) && users.length > 0 ? users[0] : null;
            }
            sub.subscription_users = subUsers;
          } else {
            sub.subscription_users = [];
          }
        }

        return jsonResponse({ success: true, data: subscriptions });
      }

      case "create": {
        const {
          userIds,        // string[] — all user IDs
          leadUserId,     // string — lead user ID (must be in userIds)
          trialPeriodDays,
          amountPence,    // integer in pence
          inviteEmailTo,
          inviteEmailFrom,
          outboundMinsLimit = 500,
          inboundMinsLimit = 1000,
        } = body;

        console.log('Create subscription request:', JSON.stringify({ userIds, leadUserId, trialPeriodDays, amountPence, inviteEmailTo, inviteEmailFrom }));

        if (!userIds?.length || !leadUserId || amountPence === undefined || !inviteEmailTo || !inviteEmailFrom) {
          return jsonResponse({ error: "Missing required fields", received: { userIds: !!userIds?.length, leadUserId: !!leadUserId, amountPence, inviteEmailTo: !!inviteEmailTo, inviteEmailFrom: !!inviteEmailFrom } }, 400);
        }

        if (!userIds.includes(leadUserId)) {
          return jsonResponse({ error: "Lead user must be in the user list" }, 400);
        }

        // Fetch lead user profile
        console.log('Step 1: Fetching lead user profile...');
        const leadUsers = await supabaseRest(
          `profiles?id=eq.${encodeURIComponent(leadUserId)}&select=*`
        );
        console.log('Lead user query result:', JSON.stringify(leadUsers));
        const leadUser = Array.isArray(leadUsers) && leadUsers.length > 0 ? leadUsers[0] : null;
        if (!leadUser) return jsonResponse({ error: "Lead user not found", debug: leadUsers }, 404);

        // Fetch all assigned user profiles
        const allUsers = await supabaseRest(
          `profiles?id=in.(${userIds.map((id: string) => encodeURIComponent(id)).join(",")})&select=id,full_name,email`
        );
        console.log('All users fetched:', Array.isArray(allUsers) ? allUsers.length : 'not array');

        const amountPounds = (amountPence / 100).toFixed(2);
        const trialDays = trialPeriodDays || 0;

        // 1. Create Stripe Product
        console.log('Step 2: Creating Stripe product...');
        let product;
        try {
          product = await stripeRequest("products", "POST", {
            name: `Greencaller Subscription - ${leadUser.full_name}`,
            "metadata[lead_user_id]": leadUserId,
          });
          console.log('Stripe product created:', product.id);
        } catch (stripeErr) {
          console.error('Stripe product creation failed:', stripeErr);
          return jsonResponse({ error: `Stripe product error: ${stripeErr.message}` }, 500);
        }

        // 2. Create recurring Price
        console.log('Step 3: Creating recurring price...');
        let recurringPrice;
        try {
          recurringPrice = await stripeRequest("prices", "POST", {
            product: product.id,
            unit_amount: String(amountPence),
            currency: "gbp",
            "recurring[interval]": "month",
          });
          console.log('Recurring price created:', recurringPrice.id);
        } catch (stripeErr) {
          console.error('Stripe recurring price failed:', stripeErr);
          return jsonResponse({ error: `Stripe price error: ${stripeErr.message}` }, 500);
        }

        // 3. Create metered overage Price (standard metered, NOT billing meter)
        // Standard metered prices work with subscriptionItems.createUsageRecord
        // and properly defer charges to the end of billing period / after trial
        console.log('Step 4: Creating metered overage price...');
        let overagePrice;
        try {
          overagePrice = await stripeRequest("prices", "POST", {
            product: product.id,
            unit_amount: "4",
            currency: "gbp",
            "recurring[interval]": "month",
            "recurring[usage_type]": "metered",
            "recurring[aggregate_usage]": "sum",
            nickname: "Overage minutes (4p/min)",
          });
          console.log('Overage price created:', overagePrice.id);
        } catch (stripeErr) {
          console.error('Stripe overage price failed:', stripeErr);
          return jsonResponse({ error: `Stripe overage price error: ${stripeErr.message}` }, 500);
        }

        // 4. Create or retrieve Stripe Customer for lead user
        console.log('Step 5: Creating/retrieving Stripe customer...');
        let stripeCustomerId = leadUser.stripe_customer_id;
        if (!stripeCustomerId) {
          try {
            const customer = await stripeRequest("customers", "POST", {
              email: leadUser.email,
              name: leadUser.full_name,
              "metadata[user_id]": leadUserId,
            });
            stripeCustomerId = customer.id;
            console.log('Stripe customer created:', stripeCustomerId);

            // Save customer ID to profile
            await supabaseRest(
              `profiles?id=eq.${encodeURIComponent(leadUserId)}`,
              "PATCH",
              { stripe_customer_id: stripeCustomerId }
            );
          } catch (stripeErr) {
            console.error('Stripe customer creation failed:', stripeErr);
            return jsonResponse({ error: `Stripe customer error: ${stripeErr.message}` }, 500);
          }
        }

        // 5. Create Stripe Checkout Session
        console.log('Step 6: Creating checkout session...');
        const checkoutParams = new URLSearchParams();
        checkoutParams.append("mode", "subscription");
        checkoutParams.append("customer", stripeCustomerId);
        checkoutParams.append("line_items[0][price]", recurringPrice.id);
        checkoutParams.append("line_items[0][quantity]", "1");
        checkoutParams.append("line_items[1][price]", overagePrice.id);
        checkoutParams.append("success_url", body.successUrl || "https://greencaller.co.uk/?subscription=success");
        checkoutParams.append("cancel_url", body.cancelUrl || "https://greencaller.co.uk/?subscription=cancelled");
        checkoutParams.append("metadata[lead_user_id]", leadUserId);
        if (trialDays > 0) {
          checkoutParams.append("subscription_data[trial_period_days]", String(trialDays));
        }
        checkoutParams.append("subscription_data[metadata][lead_user_id]", leadUserId);
        checkoutParams.append("subscription_data[metadata][user_ids]", userIds.join(","));

        let checkoutSession;
        try {
          checkoutSession = await stripeRequestForm("checkout/sessions", "POST", checkoutParams);
          console.log('Checkout session created:', checkoutSession.id, checkoutSession.url);
        } catch (stripeErr) {
          console.error('Stripe checkout session failed:', stripeErr);
          return jsonResponse({ error: `Stripe checkout error: ${stripeErr.message}` }, 500);
        }

        // 6. Save subscription to DB
        console.log('Step 7: Saving subscription to DB...');
        const subscriptionInsert = await supabaseRest("subscriptions", "POST", {
          trial_period_days: trialDays,
          amount_pence: amountPence,
          stripe_product_id: product.id,
          stripe_recurring_price_id: recurringPrice.id,
          stripe_overage_price_id: overagePrice.id,
          lead_user_id: leadUserId,
          invite_email_to: inviteEmailTo,
          invite_email_from: inviteEmailFrom,
          status: "invite_sent",
          checkout_url: checkoutSession.url,
          invite_sent_at: new Date().toISOString(),
          outbound_mins_limit: outboundMinsLimit,
          inbound_mins_limit: inboundMinsLimit,
        });
        console.log('Subscription insert result:', JSON.stringify(subscriptionInsert));

        const subscriptionRecord = Array.isArray(subscriptionInsert) ? subscriptionInsert[0] : subscriptionInsert;
        if (!subscriptionRecord?.id) {
          return jsonResponse({ error: "Failed to save subscription", debug: subscriptionInsert }, 500);
        }
        const subscriptionId = subscriptionRecord.id;

        // 7. Save subscription_users rows
        for (const uid of userIds) {
          await supabaseRest("subscription_users", "POST", {
            subscription_id: subscriptionId,
            user_id: uid,
          });
        }

        // 8. Update each user's subscription fields
        for (const uid of userIds) {
          await supabaseRest(
            `profiles?id=eq.${encodeURIComponent(uid)}`,
            "PATCH",
            {
              active_subscription_id: subscriptionId,
              subscription_status: "invite_sent",
              can_make_calls: false,
            }
          );
        }

        // 9. Send invitation email
        try {
          await sendInviteEmail({
            to: inviteEmailTo,
            from: inviteEmailFrom,
            leadUserName: leadUser.full_name?.split(" ")[0] || "there",
            trialDays,
            amountPounds,
            users: allUsers || [],
            checkoutUrl: checkoutSession.url,
          });
        } catch (emailErr) {
          console.error("Email send failed (subscription still created):", emailErr);
        }

        return jsonResponse({
          success: true,
          data: {
            subscription: subscriptionRecord,
            checkoutUrl: checkoutSession.url,
          },
        });
      }

      case "cancel": {
        const { subscriptionId } = body;
        if (!subscriptionId) return jsonResponse({ error: "subscriptionId required" }, 400);

        // Get subscription
        const subs = await supabaseRest(
          `subscriptions?id=eq.${encodeURIComponent(subscriptionId)}&select=*`
        );
        const sub = Array.isArray(subs) && subs.length > 0 ? subs[0] : null;
        if (!sub) return jsonResponse({ error: "Subscription not found" }, 404);

        // Cancel on Stripe if active
        if (sub.stripe_subscription_id) {
          try {
            await stripeRequest(`subscriptions/${sub.stripe_subscription_id}`, "DELETE");
          } catch (err) {
            console.error("Stripe cancel error:", err);
          }
        }

        // Update DB
        await supabaseRest(
          `subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`,
          "PATCH",
          { status: "cancelled" }
        );

        // Update all assigned users
        const subUsers = await supabaseRest(
          `subscription_users?subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id`
        );
        if (Array.isArray(subUsers)) {
          for (const su of subUsers) {
            await supabaseRest(
              `profiles?id=eq.${encodeURIComponent(su.user_id)}`,
              "PATCH",
              { subscription_status: "cancelled", can_make_calls: false }
            );
          }
        }

        return jsonResponse({ success: true });
      }

      case "usage": {
        // Get usage stats for all users in a subscription
        const { subscriptionId } = body;
        if (!subscriptionId) return jsonResponse({ error: "subscriptionId required" }, 400);

        const subs = await supabaseRest(
          `subscriptions?id=eq.${encodeURIComponent(subscriptionId)}&select=*`
        );
        const sub = Array.isArray(subs) && subs.length > 0 ? subs[0] : null;
        if (!sub) return jsonResponse({ error: "Subscription not found" }, 404);

        // Get assigned users
        const subUsers = await supabaseRest(
          `subscription_users?subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id,user:profiles!subscription_users_user_id_fkey(id,full_name,email)`
        );

        // Calculate billing period: from the later of (subscription start, current month start) to now
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const subStart = new Date(sub.created_at);
        const periodStart = (subStart > monthStart ? subStart : monthStart).toISOString();
        const periodEnd = now.toISOString();

        const usageData = [];
        for (const su of (subUsers || [])) {
          const userId = su.user_id;

          // Query call_history for this user in current period
          const calls = await supabaseRest(
            `call_history?user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${encodeURIComponent(periodStart)}&created_at=lte.${encodeURIComponent(periodEnd)}&select=direction,duration`
          );

          let outboundSeconds = 0;
          let inboundSeconds = 0;
          if (Array.isArray(calls)) {
            for (const call of calls) {
              const dur = call.duration || 0;
              if (call.direction === "outbound") outboundSeconds += dur;
              else inboundSeconds += dur;
            }
          }

          const outboundLimit = sub.outbound_mins_limit || 500;
          const inboundLimit = sub.inbound_mins_limit || 1000;
          const outboundMins = Math.ceil(outboundSeconds / 60);
          const inboundMins = Math.ceil(inboundSeconds / 60);
          const outboundOverage = Math.max(0, outboundMins - outboundLimit);
          const inboundOverage = Math.max(0, inboundMins - inboundLimit);
          const totalOverage = outboundOverage + inboundOverage;
          const overageChargePence = totalOverage * 4;

          usageData.push({
            user_id: userId,
            user: su.user,
            outbound_mins: outboundMins,
            inbound_mins: inboundMins,
            outbound_limit: outboundLimit,
            inbound_limit: inboundLimit,
            outbound_overage: outboundOverage,
            inbound_overage: inboundOverage,
            total_overage_mins: totalOverage,
            overage_charge_pence: overageChargePence,
          });
        }

        return jsonResponse({ success: true, data: usageData });
      }

      case "sync-gating": {
        // Fix any users with non-active status that still have can_make_calls=true
        const statuses = ["invite_sent", "draft", "cancelled", "past_due"];
        let fixed = 0;
        for (const st of statuses) {
          const users = await supabaseRest(
            `profiles?subscription_status=eq.${st}&can_make_calls=eq.true&select=id`
          );
          if (Array.isArray(users)) {
            for (const u of users) {
              await supabaseRest(
                `profiles?id=eq.${encodeURIComponent(u.id)}`,
                "PATCH",
                { can_make_calls: false }
              );
              fixed++;
            }
          }
        }
        console.log(`sync-gating: fixed ${fixed} users`);
        return jsonResponse({ success: true, fixed });
      }

      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("admin-subscription error:", err);
    return jsonResponse({ error: err.message || "Internal error" }, 500);
  }
});
