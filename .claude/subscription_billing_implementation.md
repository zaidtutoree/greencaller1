---
name: Subscription & Overage Billing Implementation
description: How Stripe subscriptions, trials, and overage billing work — including what approaches failed and why
type: project
---

## Overview

Subscriptions are managed via Stripe. Each subscription has:
- **Flat-rate monthly price** (e.g., £30/month) — recurring, charged at each billing cycle
- **Metered overage price** (4p/min) — backed by a Stripe Billing Meter, charges based on usage above included minutes

## Key Files

- **`supabase/functions/admin-subscription/index.ts`** — Creates subscriptions, Stripe products/prices, checkout sessions
- **`supabase/functions/stripe-webhooks/index.ts`** — Handles all Stripe webhook events (trial end, invoice, payment)
- **`src/components/SubscriptionManagement.tsx`** — Admin UI for creating/managing subscriptions

## Subscription Creation Flow

1. Admin creates subscription in the UI with: users, lead user, trial days, monthly amount, minute limits
2. `admin-subscription` (action: "create"):
   - Creates Stripe Product
   - Creates recurring monthly Price (flat-rate)
   - Creates metered overage Price (backed by Billing Meter via `recurring[meter]`)
   - Creates/retrieves Stripe Customer
   - Creates Checkout Session with both line items + trial
   - Saves subscription to DB
3. Lead user receives invite email with checkout link
4. User completes checkout → `checkout.session.completed` webhook fires → subscription activated

### Stripe API Requirements (as of 2025-03-31)

- **Metered prices MUST use Billing Meters** — `recurring[meter]` is required. Standard `recurring[usage_type]: "metered"` without a meter throws: `"metered prices must be backed by meters"`
- **Trial minimum via `trial_end`** = 48 hours. But `trial_period_days: 1` works fine (use days, not hours)
- The Billing Meter event_name is `"greencaller_overage_minutes"` — created/reused via `getOrCreateOverageMeter()`

## Overage Billing — What Works

### Trial Period Overages (at trial end)

**Trigger:** `customer.subscription.updated` webhook when status changes from `trialing` → `active`

**Flow:**
1. Detect trial → active transition by comparing `previousStatus` (from DB) with new status
2. Get trial start/end from Stripe subscription object (`stripeSub.trial_start`, `stripeSub.trial_end`)
3. Query `call_history` for all users in the subscription during trial period
4. Calculate overage: `max(0, outbound_mins - outbound_limit) + max(0, inbound_mins - inbound_limit)`
5. If overages > 0:
   - Create a **draft invoice** with `pending_invoice_items_behavior: "exclude"`
   - Add invoice item to that specific draft invoice (amount = overage_mins × 4 pence)
   - Finalize the invoice → triggers immediate payment

**Why this approach:**
- Meter events during trial are IGNORED by Stripe (trial = no charges)
- Meter events after trial go to the NEXT month's invoice (wrong period)
- Creating invoice item without specifying invoice ID attaches to subscription's next invoice
- Only the draft-first-then-add-item approach correctly charges immediately

### Monthly Overages (at each renewal)

**Trigger:** `invoice.upcoming` webhook (~3 days before invoice finalization)

**Flow:**
1. Fetch Stripe subscription to determine billing period
2. If first invoice after trial: extend period back to trial start
3. If subsequent invoice: use `current_period_start` to now
4. Query `call_history` for usage during the period
5. Calculate overages same as above
6. If overages > 0:
   - Create a **pending invoice item** attached to the subscription (`subscription` param)
   - Stripe automatically includes pending invoice items on the next subscription invoice
   - Result: one invoice with monthly fee + overage line item

**Note:** `invoice.upcoming` does NOT fire for very short trials (< 3 days). That's why trial overages use the `customer.subscription.updated` handler instead.

## What DOESN'T Work (Failed Approaches)

### ❌ Billing Meter Events for Trial Overages
- Meter events with timestamp during trial → **ignored by Stripe** (trial = free)
- Meter events with timestamp after trial → **attributed to next month's invoice**
- Meter events with timestamp at trial_end + 1min → **still goes to next month** (subscription invoice already finalized)

### ❌ `subscriptionItems.createUsageRecord` API
- Stripe API 2025-03-31+ requires Billing Meters for metered prices
- This API is incompatible with Billing Meter-backed prices
- Error: not applicable for meter-backed prices

### ❌ Invoice Item Without Specifying Invoice ID
- When a customer has an active subscription, Stripe attaches unassigned invoice items to the **subscription's next invoice**
- Our standalone invoice ends up with £0.00, and the amount shows on next month's subscription invoice

### ❌ `invoice.upcoming` for Short Trials
- Only fires ~3 days before invoice finalization
- For 1-day trials, the invoice is generated immediately when trial ends
- `invoice.upcoming` never fires at all

## Database Tables

### `subscriptions`
- `id`, `stripe_subscription_id`, `stripe_product_id`, `stripe_recurring_price_id`, `stripe_overage_price_id`
- `stripe_subscription_item_id` — the metered subscription item (for usage reporting)
- `lead_user_id`, `amount_pence`, `trial_period_days`
- `outbound_mins_limit` (default 500), `inbound_mins_limit` (default 1000)
- `status`: invite_sent, trialing, active, past_due, cancelled

### `subscription_users`
- Links users to subscriptions
- `subscription_id`, `user_id`

### `profiles` (relevant columns)
- `stripe_customer_id`, `active_subscription_id`, `subscription_status`, `can_make_calls`

## Stripe Webhook Events Handled

| Event | Handler | Purpose |
|-------|---------|---------|
| `checkout.session.completed` | Activates subscription, stores metered item ID | First setup |
| `customer.subscription.updated` | Updates status, **calculates trial overages** | Status changes |
| `customer.subscription.deleted` | Marks cancelled | Cancellation |
| `customer.subscription.trial_will_end` | Sends reminder email | 3 days before trial end |
| `invoice.upcoming` | **Calculates monthly overages**, creates pending invoice item | Before each renewal |
| `invoice.payment_failed` | Marks past_due, blocks calls | Payment failure |

## Switching to Stripe Live Mode

When switching from test to live:

1. **Create new webhook endpoint** in Stripe Live dashboard pointing to same URL
2. **Enable these events:** `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.upcoming`, `invoice.payment_failed`
3. **Update environment variables** in Supabase:
   - `STRIPE_SECRET_KEY` → live secret key (`sk_live_...`)
   - `STRIPE_WEBHOOK_SECRET` → live webhook signing secret (`whsec_...`)
4. **The Billing Meter** will need to be recreated in live mode (test meters don't carry over)
   - The `getOrCreateOverageMeter()` function handles this automatically on first subscription creation
5. **Test with a real card** before going live to customers
6. **DO NOT** delete or modify test mode data — it stays separate

## Deploy Commands

```bash
cd C:/Users/zaid/Downloads/greencaller1
npx supabase functions deploy admin-subscription
npx supabase functions deploy stripe-webhooks
```
