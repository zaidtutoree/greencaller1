-- Add user_id column to ivr_menu_options for direct user routing
ALTER TABLE public.ivr_menu_options
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Make department_id nullable (it already is, but be explicit)
-- When user_id is set, department_id can be null and vice versa
