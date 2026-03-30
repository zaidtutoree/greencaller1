-- Add call_sid column to call_history to uniquely identify each call
ALTER TABLE public.call_history ADD COLUMN call_sid text;

-- Create index for faster lookups
CREATE INDEX idx_call_history_call_sid ON public.call_history(call_sid);