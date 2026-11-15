-- WhatsApp: switch from Telnyx to Meta's WhatsApp Cloud API directly.
-- Each customer's Embedded Signup yields a business token scoped to THEIR WhatsApp Business
-- Account. Tokens (and the registration PIN) live in a service-role-only table so a user's
-- RLS SELECT on whatsapp_accounts can never expose them.

ALTER TABLE public.whatsapp_accounts ADD COLUMN IF NOT EXISTS business_id TEXT;      -- customer's Meta business portfolio
ALTER TABLE public.whatsapp_accounts ADD COLUMN IF NOT EXISTS name_status TEXT;      -- display-name review state
CREATE INDEX IF NOT EXISTS whatsapp_accounts_phone_number_id_idx ON public.whatsapp_accounts (phone_number_id);

CREATE TABLE IF NOT EXISTS public.whatsapp_secrets (
  user_id UUID PRIMARY KEY REFERENCES public.whatsapp_accounts(user_id) ON DELETE CASCADE,
  access_token TEXT,                        -- business integration system-user token from Embedded Signup
  pin TEXT,                                 -- 6-digit two-step PIN we set at registration (needed to re-register)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.whatsapp_secrets ENABLE ROW LEVEL SECURITY;   -- no policies: service role only

-- Inbound media is copied from Meta (its URLs expire in 5 minutes) into a private bucket.
-- Path: whatsapp-media/<user_id>/<file>. Users can read only their own folder via signed URLs.
INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp-media', 'whatsapp-media', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users read own whatsapp media" ON storage.objects;
CREATE POLICY "Users read own whatsapp media" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'whatsapp-media'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Meta message ids (wamid) are used for both directions now; keep the index unique.
-- (whatsapp_messages_foreign_id_idx already exists from the previous migration.)
