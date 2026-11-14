-- CRM sheets: cold-calling client lists uploaded as CSV at /crm.
-- One row per uploaded spreadsheet. Columns and cell values are stored as JSON so the
-- user can add/rename/remove columns freely without schema changes.
--   columns: ["Name", "Phone", "Company", ...]
--   rows:    [["Acme", "0207...", ...], ...]   (array of string arrays aligned to columns)
--
-- Access is locked to a single account (zaid@greencaller.co.uk) at the database level via
-- RLS, so the /crm page's frontend email check is only a convenience, not the security boundary.

CREATE TABLE IF NOT EXISTS public.crm_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled list',
  columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE public.crm_sheets ENABLE ROW LEVEL SECURITY;

-- Only the allowed account may touch its own sheets.
CREATE OR REPLACE FUNCTION public.is_crm_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lower(coalesce(auth.jwt() ->> 'email', '')) = 'zaid@greencaller.co.uk';
$$;

DROP POLICY IF EXISTS "CRM user manages own sheets" ON public.crm_sheets;
CREATE POLICY "CRM user manages own sheets" ON public.crm_sheets
  FOR ALL
  USING (auth.uid() = user_id AND public.is_crm_user())
  WITH CHECK (auth.uid() = user_id AND public.is_crm_user());

CREATE INDEX IF NOT EXISTS crm_sheets_user_updated_idx
  ON public.crm_sheets (user_id, updated_at DESC);

CREATE OR REPLACE FUNCTION public.set_crm_sheets_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_sheets_updated_at ON public.crm_sheets;
CREATE TRIGGER crm_sheets_updated_at
  BEFORE UPDATE ON public.crm_sheets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_crm_sheets_updated_at();
