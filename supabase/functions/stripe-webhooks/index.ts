import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

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
  return resp.json();
}

// Update all users in a subscription with new status
async function updateSubscriptionUsers(subscriptionId: string, status: string, canMakeCalls: boolean) {
  const subUsers = await supabaseRest(
    `subscription_users?subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id`
  );
  if (Array.isArray(subUsers)) {
    for (const su of subUsers) {
      await supabaseRest(
        `profiles?id=eq.${encodeURIComponent(su.user_id)}`,
        "PATCH",
        { subscription_status: status, can_make_calls: canMakeCalls }
      );
    }
  }
}

// Find our subscription record by stripe_subscription_id
async function findSubscription(stripeSubId: string) {
  const subs = await supabaseRest(
    `subscriptions?stripe_subscription_id=eq.${encodeURIComponent(stripeSubId)}&select=*`
  );
  return Array.isArray(subs) && subs.length > 0 ? subs[0] : null;
}

// Verify Stripe webhook signature using Web Crypto API (no external deps)
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts = sigHeader.split(",").reduce((acc: Record<string, string[]>, part) => {
    const [key, val] = part.split("=");
    if (!acc[key]) acc[key] = [];
    acc[key].push(val);
    return acc;
  }, {});

  const timestamp = parts["t"]?.[0];
  const signatures = parts["v1"] || [];
  if (!timestamp || signatures.length === 0) return false;

  // Check timestamp is within tolerance (5 minutes)
  const timestampAge = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  if (timestampAge > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const expectedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((s) => s === expectedSig);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const rawBody = await req.text();
    const sigHeader = req.headers.get("stripe-signature") || "";

    // Verify webhook signature
    if (STRIPE_WEBHOOK_SECRET) {
      const isValid = await verifyStripeSignature(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET);
      if (!isValid) {
        console.error("Invalid Stripe webhook signature");
        return new Response("Invalid signature", { status: 400 });
      }
    }

    const event = JSON.parse(rawBody);
    console.log("Stripe webhook event:", event.type, event.id);

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const stripeSubId = session.subscription;
        const leadUserId = session.metadata?.lead_user_id;
        const userIds = session.subscription_data?.metadata?.user_ids
          || session.metadata?.user_ids;

        if (!stripeSubId || !leadUserId) {
          console.error("Missing subscription or lead_user_id in checkout session");
          break;
        }

        // Retrieve subscription from Stripe to get status and items
        const stripeSub = await stripeRequest(`subscriptions/${stripeSubId}`);
        const status = stripeSub.status === "trialing" ? "trialing" : "active";

        // Find metered subscription item ID for usage reporting
        let meteredItemId: string | null = null;
        if (stripeSub.items?.data) {
          for (const item of stripeSub.items.data) {
            if (item.price?.recurring?.usage_type === "metered") {
              meteredItemId = item.id;
              break;
            }
          }
        }

        // Find our subscription by lead_user_id (since we don't have stripe_subscription_id yet)
        const subs = await supabaseRest(
          `subscriptions?lead_user_id=eq.${encodeURIComponent(leadUserId)}&status=eq.invite_sent&order=created_at.desc&limit=1`
        );
        const sub = Array.isArray(subs) && subs.length > 0 ? subs[0] : null;

        if (sub) {
          // Update subscription record
          await supabaseRest(
            `subscriptions?id=eq.${encodeURIComponent(sub.id)}`,
            "PATCH",
            {
              status,
              stripe_subscription_id: stripeSubId,
              stripe_subscription_item_id: meteredItemId,
            }
          );

          // Update all assigned users
          await updateSubscriptionUsers(sub.id, status, true);
        }

        console.log("Checkout completed:", { stripeSubId, status, leadUserId });
        break;
      }

      case "customer.subscription.updated": {
        const stripeSub = event.data.object;
        const sub = await findSubscription(stripeSub.id);
        if (!sub) {
          console.log("No matching subscription found for:", stripeSub.id);
          break;
        }

        let dbStatus: string;
        let canMakeCalls = true;
        switch (stripeSub.status) {
          case "trialing": dbStatus = "trialing"; break;
          case "active": dbStatus = "active"; break;
          case "past_due": dbStatus = "past_due"; canMakeCalls = false; break;
          case "canceled": dbStatus = "cancelled"; canMakeCalls = false; break;
          case "unpaid": dbStatus = "past_due"; canMakeCalls = false; break;
          default: dbStatus = stripeSub.status;
        }

        await supabaseRest(
          `subscriptions?id=eq.${encodeURIComponent(sub.id)}`,
          "PATCH",
          { status: dbStatus }
        );
        await updateSubscriptionUsers(sub.id, dbStatus, canMakeCalls);

        console.log("Subscription updated:", { id: sub.id, status: dbStatus });
        break;
      }

      case "customer.subscription.deleted": {
        const stripeSub = event.data.object;
        const sub = await findSubscription(stripeSub.id);
        if (!sub) break;

        await supabaseRest(
          `subscriptions?id=eq.${encodeURIComponent(sub.id)}`,
          "PATCH",
          { status: "cancelled" }
        );
        await updateSubscriptionUsers(sub.id, "cancelled", false);

        console.log("Subscription cancelled:", sub.id);
        break;
      }

      case "customer.subscription.trial_will_end": {
        const stripeSub = event.data.object;
        const sub = await findSubscription(stripeSub.id);
        if (!sub) break;

        // Send trial ending reminder email
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: `Greencaller <${sub.invite_email_from}>`,
              to: [sub.invite_email_to],
              subject: "Your Greencaller trial is ending soon",
              html: `<p>Hi,</p><p>Your Greencaller trial is ending in 3 days. After your trial, you will be charged &pound;${(sub.amount_pence / 100).toFixed(2)}/month.</p><p>No action needed if you'd like to continue — your subscription will start automatically.</p><p>Thanks,<br>Greencaller Team</p>`,
            }),
          });
        } catch (emailErr) {
          console.error("Failed to send trial reminder:", emailErr);
        }

        console.log("Trial ending reminder sent for:", sub.id);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const stripeSubId = invoice.subscription;
        if (!stripeSubId) break;

        const sub = await findSubscription(stripeSubId);
        if (!sub) break;

        await supabaseRest(
          `subscriptions?id=eq.${encodeURIComponent(sub.id)}`,
          "PATCH",
          { status: "past_due" }
        );
        await updateSubscriptionUsers(sub.id, "past_due", false);

        console.log("Payment failed, subscription past_due:", sub.id);
        break;
      }

      case "invoice.upcoming": {
        // Calculate overage and report usage to Stripe
        const invoice = event.data.object;
        const stripeSubId = invoice.subscription;
        if (!stripeSubId) break;

        const sub = await findSubscription(stripeSubId);
        if (!sub || !sub.stripe_subscription_item_id) break;

        // Get all users in this subscription
        const subUsers = await supabaseRest(
          `subscription_users?subscription_id=eq.${encodeURIComponent(sub.id)}&select=user_id`
        );

        // Calculate billing period — use the invoice's period OR subscription dates
        // For the first invoice after trial, this should cover the entire trial period
        // so trial overages are included in the first real charge
        const invoicePeriodStart = invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null;
        const invoicePeriodEnd = invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null;

        // Also get the subscription's trial start to capture trial-period usage
        let trialStart: string | null = null;
        if (sub.trial_start) {
          trialStart = new Date(sub.trial_start).toISOString();
        } else if (sub.created_at) {
          trialStart = new Date(sub.created_at).toISOString();
        }

        // Use the earliest of: invoice period start, trial start, or subscription created_at
        const candidateStarts = [invoicePeriodStart, trialStart].filter(Boolean) as string[];
        const periodStart = candidateStarts.length > 0
          ? candidateStarts.sort()[0] // earliest date
          : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
        const periodEnd = invoicePeriodEnd || new Date().toISOString();

        console.log('Billing period for usage calc:', { periodStart, periodEnd, invoicePeriodStart, invoicePeriodEnd, trialStart });

        let totalOverageMins = 0;
        for (const su of (subUsers || [])) {
          const userId = su.user_id;
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
          totalOverageMins += Math.max(0, outboundMins - outboundLimit) + Math.max(0, inboundMins - inboundLimit);
        }

        // Report usage to Stripe via subscription item usage records
        // This is the correct way to report metered usage for overage billing
        if (totalOverageMins > 0 && sub.stripe_subscription_item_id) {
          const params = new URLSearchParams();
          params.append("quantity", String(totalOverageMins));
          params.append("action", "set"); // "set" replaces previous value (not "increment")
          params.append("timestamp", String(Math.floor(Date.now() / 1000)));

          const usageResp = await fetch(
            `https://api.stripe.com/v1/subscription_items/${encodeURIComponent(sub.stripe_subscription_item_id)}/usage_records`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: params.toString(),
            }
          );

          if (usageResp.ok) {
            console.log("Reported overage usage to Stripe:", { subId: sub.id, totalOverageMins, subscriptionItemId: sub.stripe_subscription_item_id });
          } else {
            const errText = await usageResp.text();
            console.error("Failed to report usage to Stripe:", errText);
          }
        } else if (totalOverageMins === 0 && sub.stripe_subscription_item_id) {
          // Report zero usage so previous overages don't carry over
          const params = new URLSearchParams();
          params.append("quantity", "0");
          params.append("action", "set");
          params.append("timestamp", String(Math.floor(Date.now() / 1000)));

          await fetch(
            `https://api.stripe.com/v1/subscription_items/${encodeURIComponent(sub.stripe_subscription_item_id)}/usage_records`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: params.toString(),
            }
          );
          console.log("Reported zero overage usage for:", sub.id);
        }

        break;
      }

      default:
        console.log("Unhandled webhook event type:", event.type);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Stripe webhook error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
