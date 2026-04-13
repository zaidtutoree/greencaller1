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

        const previousStatus = sub.status;
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

        console.log("Subscription updated:", { id: sub.id, status: dbStatus, previousStatus });

        // When trial ends (trialing → active), report any trial period overages
        // invoice.upcoming may not fire for short trials, so we catch it here
        if (previousStatus === "trialing" && dbStatus === "active") {
          console.log("Trial ended — calculating trial period overages...");

          const trialStart = stripeSub.trial_start
            ? new Date(stripeSub.trial_start * 1000).toISOString()
            : (sub.created_at || new Date().toISOString());
          const trialEnd = stripeSub.trial_end
            ? new Date(stripeSub.trial_end * 1000).toISOString()
            : new Date().toISOString();

          console.log("Trial period:", { trialStart, trialEnd });

          // Get all users in this subscription
          const subUsers = await supabaseRest(
            `subscription_users?subscription_id=eq.${encodeURIComponent(sub.id)}&select=user_id`
          );

          let totalOverageMins = 0;
          for (const su of (subUsers || [])) {
            const userId = su.user_id;
            const calls = await supabaseRest(
              `call_history?user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${encodeURIComponent(trialStart)}&created_at=lte.${encodeURIComponent(trialEnd)}&select=direction,duration`
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

          console.log("Trial overage minutes:", totalOverageMins);

          if (totalOverageMins > 0) {
            // Get the Stripe customer ID
            const leadProfiles = await supabaseRest(
              `profiles?id=eq.${encodeURIComponent(sub.lead_user_id)}&select=stripe_customer_id`
            );
            const stripeCustomerId = Array.isArray(leadProfiles) && leadProfiles[0]?.stripe_customer_id;

            if (stripeCustomerId) {
              const params = new URLSearchParams();
              params.append("event_name", "greencaller_overage_minutes");
              params.append("payload[value]", String(totalOverageMins));
              params.append("payload[stripe_customer_id]", stripeCustomerId);
              params.append("timestamp", String(Math.floor(Date.now() / 1000)));

              const meterResp = await fetch("https://api.stripe.com/v1/billing/meter_events", {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: params.toString(),
              });

              if (meterResp.ok) {
                console.log("Trial overages reported via meter event:", { totalOverageMins, stripeCustomerId });
              } else {
                const errText = await meterResp.text();
                console.error("Failed to report trial overage meter event:", errText);
              }
            } else {
              console.error("No stripe_customer_id for lead user:", sub.lead_user_id);
            }
          }
        }

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

        // Calculate the usage period for overage calculation
        //
        // How Stripe billing works:
        // - Trial starts April 5 (1 day trial)
        // - April 6: trial ends, first invoice fires (invoice.upcoming)
        //   → We report overages from April 5 (trial start) to now
        //   → Invoice = monthly fee + trial overages
        // - May 6: second invoice fires (invoice.upcoming)
        //   → We report overages from April 6 to now (current period only)
        //   → Invoice = monthly fee + this month's overages
        //
        // To determine the usage start:
        // - Get the Stripe subscription's current_period_start
        // - If subscription had a trial, and this is the first invoice,
        //   extend back to trial/creation start

        // Fetch the actual Stripe subscription to get current_period_start and trial info
        let usagePeriodStart: string;
        let usagePeriodEnd = new Date().toISOString();

        try {
          const stripeSubResp = await fetch(
            `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSubId)}`,
            {
              headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` },
            }
          );

          if (stripeSubResp.ok) {
            const stripeSub = await stripeSubResp.json();
            const currentPeriodStart = stripeSub.current_period_start
              ? new Date(stripeSub.current_period_start * 1000).toISOString()
              : null;
            const trialStart = stripeSub.trial_start
              ? new Date(stripeSub.trial_start * 1000).toISOString()
              : null;
            const trialEnd = stripeSub.trial_end
              ? new Date(stripeSub.trial_end * 1000).toISOString()
              : null;

            console.log('Stripe subscription info:', {
              currentPeriodStart,
              trialStart,
              trialEnd,
              status: stripeSub.status,
            });

            // If this is the first billing period (current_period_start == trial_end),
            // include the trial period in the usage calculation
            if (trialStart && currentPeriodStart && trialEnd) {
              const periodStartMs = new Date(currentPeriodStart).getTime();
              const trialEndMs = new Date(trialEnd).getTime();
              // First invoice: current_period_start is at or near trial_end
              if (Math.abs(periodStartMs - trialEndMs) < 24 * 60 * 60 * 1000) {
                usagePeriodStart = trialStart;
                console.log('First invoice after trial — counting from trial start:', trialStart);
              } else {
                usagePeriodStart = currentPeriodStart;
                console.log('Subsequent invoice — counting from period start:', currentPeriodStart);
              }
            } else {
              usagePeriodStart = currentPeriodStart || sub.created_at || new Date().toISOString();
              console.log('No trial — counting from:', usagePeriodStart);
            }
          } else {
            console.error('Failed to fetch Stripe subscription:', await stripeSubResp.text());
            usagePeriodStart = sub.created_at || new Date().toISOString();
          }
        } catch (e) {
          console.error('Error fetching Stripe subscription:', e);
          usagePeriodStart = sub.created_at || new Date().toISOString();
        }

        const periodStart = usagePeriodStart;
        const periodEnd = usagePeriodEnd;

        console.log('Final usage period:', { periodStart, periodEnd });

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

        // Report usage to Stripe via Billing Meter Events API
        // Stripe 2025-03-31+ requires metered prices to be backed by billing meters
        // Meter events are sent per-minute of overage, with the customer's stripe ID
        if (totalOverageMins > 0) {
          // Get the Stripe customer ID for this subscription's lead user
          const leadProfiles = await supabaseRest(
            `profiles?id=eq.${encodeURIComponent(sub.lead_user_id)}&select=stripe_customer_id`
          );
          const stripeCustomerId = Array.isArray(leadProfiles) && leadProfiles[0]?.stripe_customer_id;

          if (stripeCustomerId) {
            // Send a single meter event with the total overage quantity
            const params = new URLSearchParams();
            params.append("event_name", "greencaller_overage_minutes");
            params.append("payload[value]", String(totalOverageMins));
            params.append("payload[stripe_customer_id]", stripeCustomerId);
            params.append("timestamp", String(Math.floor(Date.now() / 1000)));

            const meterResp = await fetch("https://api.stripe.com/v1/billing/meter_events", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: params.toString(),
            });

            if (meterResp.ok) {
              console.log("Reported overage via billing meter event:", { subId: sub.id, totalOverageMins, stripeCustomerId });
            } else {
              const errText = await meterResp.text();
              console.error("Failed to report meter event:", errText);
            }
          } else {
            console.error("No stripe_customer_id found for lead user:", sub.lead_user_id);
          }
        } else {
          console.log("No overages to report for:", sub.id);
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
