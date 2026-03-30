-- Drop the foreign key constraint and make created_by nullable
ALTER TABLE public.departments DROP CONSTRAINT IF EXISTS departments_created_by_fkey;
ALTER TABLE public.departments ALTER COLUMN created_by DROP NOT NULL;