-- Add provider column to track which service each phone number belongs to
ALTER TABLE public.phone_numbers 
ADD COLUMN provider text NOT NULL DEFAULT 'twilio';

-- Add check constraint for valid providers
ALTER TABLE public.phone_numbers 
ADD CONSTRAINT phone_numbers_provider_check CHECK (provider IN ('twilio', 'telnyx'));

-- Create index for faster lookups by provider
CREATE INDEX idx_phone_numbers_provider ON public.phone_numbers(provider);