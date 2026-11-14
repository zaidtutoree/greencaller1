-- Add public read access to all tables
-- WARNING: This allows anyone with the API key to read ALL user data

-- Call History - Public read access
CREATE POLICY "Public read access for call_history"
ON public.call_history
FOR SELECT
USING (true);

-- Messages - Public read access  
CREATE POLICY "Public read access for messages"
ON public.messages
FOR SELECT
USING (true);

-- Phone Numbers - Public read access
CREATE POLICY "Public read access for phone_numbers"
ON public.phone_numbers
FOR SELECT
USING (true);

-- Profiles - Public read access
CREATE POLICY "Public read access for profiles"
ON public.profiles
FOR SELECT
USING (true);

-- Voicemails - Public read access
CREATE POLICY "Public read access for voicemails"
ON public.voicemails
FOR SELECT
USING (true);