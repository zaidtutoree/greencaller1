-- Add transcription column to call_recordings table
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS transcription TEXT;