-- Add phone_number_id to departments table
ALTER TABLE public.departments
ADD COLUMN phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL;

-- Create index for better query performance
CREATE INDEX idx_departments_phone_number ON public.departments(phone_number_id);

-- Update RLS policies for departments to allow admins to assign phone numbers
-- (existing policies already allow admins to update departments)