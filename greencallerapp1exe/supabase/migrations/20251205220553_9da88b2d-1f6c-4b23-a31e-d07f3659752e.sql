-- Drop the old constraint and add a new one with 'ringing' status
ALTER TABLE call_queue DROP CONSTRAINT call_queue_status_check;

ALTER TABLE call_queue ADD CONSTRAINT call_queue_status_check 
CHECK (status = ANY (ARRAY['waiting'::text, 'ringing'::text, 'picked_up'::text, 'abandoned'::text, 'connected'::text, 'completed'::text]));