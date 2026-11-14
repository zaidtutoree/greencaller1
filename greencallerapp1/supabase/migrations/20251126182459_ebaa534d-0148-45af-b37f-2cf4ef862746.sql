-- Create storage bucket for call recordings
INSERT INTO storage.buckets (id, name, public)
VALUES ('call-recordings', 'call-recordings', true)
ON CONFLICT (id) DO NOTHING;

-- Create storage policies for call recordings
CREATE POLICY "Public access to call recordings"
ON storage.objects FOR SELECT
USING (bucket_id = 'call-recordings');

CREATE POLICY "Authenticated users can upload recordings"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'call-recordings' AND auth.role() = 'authenticated');

CREATE POLICY "Users can delete own recordings"
ON storage.objects FOR DELETE
USING (bucket_id = 'call-recordings' AND auth.uid()::text = (storage.foldername(name))[1]);