-- Add voice column to ivr_configurations table
ALTER TABLE public.ivr_configurations 
ADD COLUMN voice text NOT NULL DEFAULT 'Polly.Amy-Neural';