-- Create IVR configurations table for company phone menus
CREATE TABLE public.ivr_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL UNIQUE,
  phone_number_id UUID REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
  greeting_message TEXT NOT NULL DEFAULT 'Thank you for calling. Please select from the following options.',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create IVR menu options table
CREATE TABLE public.ivr_menu_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ivr_config_id UUID REFERENCES public.ivr_configurations(id) ON DELETE CASCADE,
  digit TEXT NOT NULL CHECK (digit IN ('1', '2', '3', '4', '5', '6', '7', '8', '9', '0')),
  department_id UUID REFERENCES public.departments(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ivr_config_id, digit)
);

-- Create call queue table for active calls
CREATE TABLE public.call_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid TEXT NOT NULL UNIQUE,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'picked_up', 'abandoned', 'connected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  picked_up_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  picked_up_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ
);

-- Enable RLS on new tables
ALTER TABLE public.ivr_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ivr_menu_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_queue ENABLE ROW LEVEL SECURITY;

-- RLS policies for ivr_configurations
CREATE POLICY "Admins can manage IVR configurations"
  ON public.ivr_configurations
  FOR ALL
  USING (has_role(auth.uid(), 'admin'));

CREATE POLICY "Enterprise users can view their company IVR"
  ON public.ivr_configurations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.company_name = ivr_configurations.company_name
      AND profiles.account_type = 'enterprise'
    )
  );

-- RLS policies for ivr_menu_options
CREATE POLICY "Admins can manage IVR menu options"
  ON public.ivr_menu_options
  FOR ALL
  USING (has_role(auth.uid(), 'admin'));

CREATE POLICY "Enterprise users can view their company IVR menu"
  ON public.ivr_menu_options
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.ivr_configurations ivc
      JOIN public.profiles p ON p.company_name = ivc.company_name
      WHERE ivc.id = ivr_menu_options.ivr_config_id
      AND p.id = auth.uid()
      AND p.account_type = 'enterprise'
    )
  );

-- RLS policies for call_queue
CREATE POLICY "System can manage call queue"
  ON public.call_queue
  FOR ALL
  USING (true);

CREATE POLICY "Enterprise users can view their company queue"
  ON public.call_queue
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.company_name = call_queue.company_name
      AND profiles.account_type = 'enterprise'
    )
  );

CREATE POLICY "Enterprise users can update queue in their departments"
  ON public.call_queue
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.department_members dm
      JOIN public.profiles p ON p.id = auth.uid()
      WHERE dm.department_id = call_queue.department_id
      AND dm.user_id = auth.uid()
    )
  );

-- Enable realtime for call_queue
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_queue;

-- Add company_name to phone_numbers if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'phone_numbers' AND column_name = 'company_name'
  ) THEN
    ALTER TABLE public.phone_numbers ADD COLUMN company_name TEXT;
  END IF;
END $$;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_ivr_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ivr_configurations_updated_at
  BEFORE UPDATE ON public.ivr_configurations
  FOR EACH ROW
  EXECUTE FUNCTION update_ivr_updated_at();