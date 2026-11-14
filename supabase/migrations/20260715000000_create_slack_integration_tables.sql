-- Slack integration (enterprise, per company).
-- slack_integrations: the connected workspace + bot token (service-role only).
-- slack_oauth_states: short-lived CSRF nonces for the OAuth handshake.
-- slack_user_links: cache of app user -> Slack user id, for DMing the owner.
CREATE TABLE IF NOT EXISTS public.slack_integrations (
  company_name text PRIMARY KEY,
  team_id text,
  team_name text,
  bot_token text NOT NULL,
  installed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  default_channel_id text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.slack_integrations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.slack_oauth_states (
  state text PRIMARY KEY,
  company_name text NOT NULL,
  user_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.slack_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.slack_user_links (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  company_name text,
  slack_user_id text,
  slack_email text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.slack_user_links ENABLE ROW LEVEL SECURITY;
