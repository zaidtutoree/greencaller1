-- Drop the existing check constraint
ALTER TABLE call_queue DROP CONSTRAINT IF EXISTS call_queue_status_check;

-- Add updated check constraint that includes 'completed'
ALTER TABLE call_queue ADD CONSTRAINT call_queue_status_check 
CHECK (status = ANY (ARRAY['waiting'::text, 'picked_up'::text, 'abandoned'::text, 'connected'::text, 'completed'::text]));