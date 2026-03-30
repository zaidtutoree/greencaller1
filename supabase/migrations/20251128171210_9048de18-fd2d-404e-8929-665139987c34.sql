-- Fix foreign key relationship for department_members
-- Drop the existing foreign key constraint
ALTER TABLE public.department_members
DROP CONSTRAINT IF EXISTS department_members_user_id_fkey;

-- Add new foreign key constraint pointing to profiles instead of auth.users
ALTER TABLE public.department_members
ADD CONSTRAINT department_members_user_id_fkey 
FOREIGN KEY (user_id) 
REFERENCES public.profiles(id) 
ON DELETE CASCADE;