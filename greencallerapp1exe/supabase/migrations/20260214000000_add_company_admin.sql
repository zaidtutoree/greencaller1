-- Add is_company_admin column to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_company_admin BOOLEAN NOT NULL DEFAULT false;

-- Update department_members RLS policies: only company admins can INSERT/DELETE
-- Drop existing INSERT policy and recreate
DROP POLICY IF EXISTS "Enterprise users can add department members" ON department_members;
CREATE POLICY "Company admins can add department members" ON department_members
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.account_type = 'enterprise'
        AND profiles.is_company_admin = true
    )
  );

-- Drop existing DELETE policy and recreate
DROP POLICY IF EXISTS "Enterprise users can remove department members" ON department_members;
CREATE POLICY "Company admins can remove department members" ON department_members
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.account_type = 'enterprise'
        AND profiles.is_company_admin = true
    )
  );
