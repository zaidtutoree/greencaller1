-- Add credential_connection_id to telnyx_webrtc_registrations
-- This is needed so the call events handler can dial the agent's WebRTC SIP URI
-- using the correct credential connection (not the Call Control App ID)
ALTER TABLE telnyx_webrtc_registrations
ADD COLUMN IF NOT EXISTS credential_connection_id TEXT;
