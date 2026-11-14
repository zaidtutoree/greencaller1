-- Add minute limit columns to subscriptions table
-- These track the included minutes per billing period before overages apply
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions'
    AND column_name = 'outbound_mins_limit'
  ) THEN
    ALTER TABLE subscriptions ADD COLUMN outbound_mins_limit INTEGER DEFAULT 500;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions'
    AND column_name = 'inbound_mins_limit'
  ) THEN
    ALTER TABLE subscriptions ADD COLUMN inbound_mins_limit INTEGER DEFAULT 1000;
  END IF;
END $$;
