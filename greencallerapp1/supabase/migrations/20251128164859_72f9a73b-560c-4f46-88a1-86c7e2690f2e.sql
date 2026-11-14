-- Create account type enum
CREATE TYPE public.account_type AS ENUM ('basic', 'premium', 'enterprise');

-- Add account_type column to profiles table
ALTER TABLE public.profiles 
ADD COLUMN account_type account_type NOT NULL DEFAULT 'basic';

-- Create index for faster queries
CREATE INDEX idx_profiles_account_type ON public.profiles(account_type);

-- Update RLS policy to allow admins to update account types
CREATE POLICY "Admins can update account types"
ON public.profiles
FOR UPDATE
USING (has_role(auth.uid(), 'admin'))
WITH CHECK (has_role(auth.uid(), 'admin'));