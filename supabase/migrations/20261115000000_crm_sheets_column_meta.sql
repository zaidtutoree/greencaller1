-- Per-column settings for CRM sheets, aligned by index to `columns`.
-- Each entry: { "width": number|null, "type": "text"|"choice", "options": string[] }
--   width:   pixel width the user dragged the column to (null = default)
--   type:    "text" = free typing (default), "choice" = pick from `options`
--   options: the allowed values for a "choice" column
ALTER TABLE public.crm_sheets
  ADD COLUMN IF NOT EXISTS column_meta JSONB NOT NULL DEFAULT '[]'::jsonb;
