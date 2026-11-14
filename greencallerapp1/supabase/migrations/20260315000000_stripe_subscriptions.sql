-- Create subscription_status enum
CREATE TYPE subscription_status AS ENUM (
  'draft',
  'invite_sent',
  'active',
  'trialing',
  'past_due',
  'cancelled'
);

-- Create subscriptions table
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  trial_period_days INTEGER NOT NULL DEFAULT 0,
  amount_pence INTEGER NOT NULL,
  stripe_product_id TEXT,
  stripe_recurring_price_id TEXT,
  stripe_overage_price_id TEXT,
  lead_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invite_email_to TEXT NOT NULL,
  invite_email_from TEXT NOT NULL,
  status subscription_status NOT NULL DEFAULT 'draft',
  stripe_subscription_id TEXT,
  stripe_subscription_item_id TEXT,
  checkout_url TEXT,
  invite_sent_at TIMESTAMP WITH TIME ZONE
);

-- Create subscription_users junction table
CREATE TABLE public.subscription_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(subscription_id, user_id)
);

-- Add subscription columns to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS active_subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS can_make_calls BOOLEAN DEFAULT TRUE;

-- Create indexes
CREATE INDEX idx_subscriptions_lead_user_id ON public.subscriptions(lead_user_id);
CREATE INDEX idx_subscriptions_status ON public.subscriptions(status);
CREATE INDEX idx_subscriptions_stripe_subscription_id ON public.subscriptions(stripe_subscription_id);
CREATE INDEX idx_subscription_users_subscription_id ON public.subscription_users(subscription_id);
CREATE INDEX idx_subscription_users_user_id ON public.subscription_users(user_id);
CREATE INDEX idx_profiles_stripe_customer_id ON public.profiles(stripe_customer_id);
CREATE INDEX idx_profiles_active_subscription_id ON public.profiles(active_subscription_id);

-- Enable RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_users ENABLE ROW LEVEL SECURITY;

-- RLS policies: service role can do everything, users can read their own
CREATE POLICY "Service role full access on subscriptions"
  ON public.subscriptions FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on subscription_users"
  ON public.subscription_users FOR ALL
  USING (true) WITH CHECK (true);

-- Allow users to read their own subscription
CREATE POLICY "Users can read own subscription"
  ON public.subscriptions FOR SELECT
  USING (lead_user_id = auth.uid() OR id IN (
    SELECT subscription_id FROM public.subscription_users WHERE user_id = auth.uid()
  ));

CREATE POLICY "Users can read own subscription_users"
  ON public.subscription_users FOR SELECT
  USING (user_id = auth.uid());
