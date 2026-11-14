-- Fire a Slack DM (slack-notify) when an inbound call becomes 'missed'.
-- Uses pg_net so the call flow (telnyx-incoming-call) is never touched.
-- NOTE: the x-webhook-secret literal below is redacted here; the applied trigger
-- carries the real value (matches the SLACK_WEBHOOK_SECRET edge secret). Rotate
-- by re-setting both the secret and this trigger together.
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.slack_notify_missed_call()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF new.direction = 'inbound'
     AND new.status = 'missed'
     AND new.user_id IS NOT NULL
     AND (tg_op = 'INSERT' OR old.status IS DISTINCT FROM new.status) THEN
    PERFORM net.http_post(
      url := 'https://wofpxloehneavpoiqpal.supabase.co/functions/v1/slack-notify',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', '<SLACK_WEBHOOK_SECRET>'
      ),
      body := jsonb_build_object(
        'type', 'missed_call',
        'user_id', new.user_id,
        'from_number', new.from_number,
        'to_number', new.to_number,
        'call_sid', new.call_sid,
        'created_at', new.created_at
      )
    );
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS slack_notify_missed_call_trg ON public.call_history;
CREATE TRIGGER slack_notify_missed_call_trg
  AFTER INSERT OR UPDATE ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.slack_notify_missed_call();
