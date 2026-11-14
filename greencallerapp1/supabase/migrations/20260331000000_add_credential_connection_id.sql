-- Add credential_connection_id to telnyx_webrtc_registrations
-- This stores the Telnyx Credential Connection ID so the call events
-- handler can use it to dial WebRTC SIP URIs (instead of the Call Control App ID)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'telnyx_webrtc_registrations'
    AND column_name = 'credential_connection_id'
  ) THEN
    ALTER TABLE telnyx_webrtc_registrations ADD COLUMN credential_connection_id TEXT;
  END IF;
END $$;
