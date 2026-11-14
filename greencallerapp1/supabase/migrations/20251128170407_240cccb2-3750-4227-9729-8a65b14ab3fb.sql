-- Create departments table
CREATE TABLE public.departments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  company_name text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create department_members junction table
CREATE TABLE public.department_members (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at timestamp with time zone DEFAULT now(),
  UNIQUE(department_id, user_id)
);

-- Enable RLS
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_members ENABLE ROW LEVEL SECURITY;

-- RLS Policies for departments
CREATE POLICY "Enterprise users can view departments in their company"
ON public.departments
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
    AND profiles.company_name = departments.company_name
    AND profiles.account_type = 'enterprise'
  )
);

CREATE POLICY "Enterprise users can create departments"
ON public.departments
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
    AND profiles.company_name = departments.company_name
    AND profiles.account_type = 'enterprise'
  )
);

CREATE POLICY "Enterprise users can update departments in their company"
ON public.departments
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
    AND profiles.company_name = departments.company_name
    AND profiles.account_type = 'enterprise'
  )
);

CREATE POLICY "Enterprise users can delete departments in their company"
ON public.departments
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
    AND profiles.company_name = departments.company_name
    AND profiles.account_type = 'enterprise'
  )
);

-- RLS Policies for department_members
CREATE POLICY "Users can view members of departments in their company"
ON public.department_members
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.departments d
    JOIN public.profiles p ON p.company_name = d.company_name
    WHERE d.id = department_members.department_id
    AND p.id = auth.uid()
    AND p.account_type = 'enterprise'
  )
);

CREATE POLICY "Enterprise users can add members to departments"
ON public.department_members
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.departments d
    JOIN public.profiles p ON p.company_name = d.company_name
    WHERE d.id = department_members.department_id
    AND p.id = auth.uid()
    AND p.account_type = 'enterprise'
  )
);

CREATE POLICY "Enterprise users can remove members from departments"
ON public.department_members
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.departments d
    JOIN public.profiles p ON p.company_name = d.company_name
    WHERE d.id = department_members.department_id
    AND p.id = auth.uid()
    AND p.account_type = 'enterprise'
  )
);

-- Add updated_at trigger for departments
CREATE TRIGGER update_departments_updated_at
BEFORE UPDATE ON public.departments
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();