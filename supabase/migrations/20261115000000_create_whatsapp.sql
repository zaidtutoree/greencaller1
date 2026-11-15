-- WhatsApp Business (via Telnyx) — per-user feature enabled by the platform admin.
--
-- whatsapp_accounts      one row per user the admin has granted WhatsApp to. Holds the assigned
--                        Telnyx number, Telnyx hosted-signup session, WABA ids and the cached
--                        business profile. Users can only READ their own row; all writes go through
--                        edge functions with the service role (so a user cannot enable themselves).
-- whatsapp_conversations one row per (user, contact number). Users may update their own rows
--                        (mark read / rename contact). Inserts come from edge functions.
-- whatsapp_messages      every inbound/outbound message. Read-only for users; written by the
--                        webhook + send functions. Added to realtime so the chat view updates live.
-- whatsapp_config        key/value store for account-wide Telnyx ids (shared messaging profile id,
--                        whether the signup webhook is configured). Service role only.

CREATE TABLE IF NOT EXISTS public.whatsapp_accounts (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  phone_number TEXT,                       -- assigned Telnyx number (E.164) the user must register
  status TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('not_connected', 'connecting', 'connected', 'failed')),
  signup_session_id TEXT,
  signup_url TEXT,
  signup_expires_at TIMESTAMPTZ,
  signup_state TEXT,
  waba_id TEXT,
  phone_number_id TEXT,
  messaging_profile_id TEXT,
  connected_phone_number TEXT,             -- number Meta actually registered (should equal phone_number)
  display_name TEXT,
  profile_photo_url TEXT,
  about TEXT,
  description TEXT,
  category TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  last_error TEXT,
  last_otp_code TEXT,                      -- Meta's SMS verification code captured by our webhook
  last_otp_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.whatsapp_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own whatsapp account" ON public.whatsapp_accounts;
CREATE POLICY "Users read own whatsapp account" ON public.whatsapp_accounts
  FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS whatsapp_accounts_phone_idx ON public.whatsapp_accounts (phone_number);
CREATE INDEX IF NOT EXISTS whatsapp_accounts_session_idx ON public.whatsapp_accounts (signup_session_id);

-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_number TEXT NOT NULL,            -- E.164
  contact_name TEXT,                       -- WhatsApp profile name from inbound, or user-edited
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_inbound_at TIMESTAMPTZ,             -- drives the 24-hour free-form reply window
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, contact_number)
);

ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own whatsapp conversations" ON public.whatsapp_conversations;
CREATE POLICY "Users read own whatsapp conversations" ON public.whatsapp_conversations
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own whatsapp conversations" ON public.whatsapp_conversations;
CREATE POLICY "Users update own whatsapp conversations" ON public.whatsapp_conversations
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS whatsapp_conversations_user_last_idx
  ON public.whatsapp_conversations (user_id, last_message_at DESC);

-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  telnyx_message_id TEXT,                  -- Telnyx message id (used to match status webhooks)
  foreign_id TEXT,                         -- Meta wamid
  message_type TEXT NOT NULL DEFAULT 'text',
  body TEXT,                               -- text body / caption / template name
  media_url TEXT,
  media_mime TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  error TEXT,
  raw JSONB,                               -- original webhook payload for debugging
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own whatsapp messages" ON public.whatsapp_messages;
CREATE POLICY "Users read own whatsapp messages" ON public.whatsapp_messages
  FOR SELECT USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS whatsapp_messages_conv_created_idx
  ON public.whatsapp_messages (conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_telnyx_id_idx
  ON public.whatsapp_messages (telnyx_message_id) WHERE telnyx_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_foreign_id_idx
  ON public.whatsapp_messages (foreign_id) WHERE foreign_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.whatsapp_config ENABLE ROW LEVEL SECURITY;   -- no policies: service role only

-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_whatsapp_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS whatsapp_accounts_updated_at ON public.whatsapp_accounts;
CREATE TRIGGER whatsapp_accounts_updated_at BEFORE UPDATE ON public.whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_whatsapp_updated_at();

DROP TRIGGER IF EXISTS whatsapp_conversations_updated_at ON public.whatsapp_conversations;
CREATE TRIGGER whatsapp_conversations_updated_at BEFORE UPDATE ON public.whatsapp_conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_whatsapp_updated_at();

-- Live updates for the chat view.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'whatsapp_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'whatsapp_conversations') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_conversations;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'whatsapp_accounts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_accounts;
  END IF;
END $$;
