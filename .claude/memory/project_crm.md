---
name: CRM page
description: /crm cold-calling CRM — CSV upload into editable table, single-account access (zaid@greencaller.co.uk) enforced by RLS
type: project
---

## What it is (added 2026-11-14)
`/crm` route (web `greencallerapp1/src/pages/Crm.tsx`, copied to exe) — upload a CSV of cold-calling
leads, shows it as an editable grid; add/delete rows and columns, rename columns, search, export CSV.
Multiple lists ("sheets") per account, listed in a left sidebar.

## Storage
- Table `crm_sheets` (migration `supabase/migrations/20261114000000_create_crm_sheets.sql`):
  `columns jsonb` = string[], `rows jsonb` = string[][] aligned to columns. One row per list.
- Whole sheet (name + columns + rows) is re-saved with a 900 ms debounce; pending saves are
  flushed on sheet switch / sign out, and `beforeunload` warns if unsaved.
- CSV parsing is the in-house `src/lib/csv.ts` (RFC 4180, BOM, delimiter auto-detect) — no dependency.

## Access control
- Only `zaid@greencaller.co.uk` may use it. Frontend checks `session.user.email`, but the real
  gate is RLS: policy uses `public.is_crm_user()` which compares `auth.jwt()->>'email'`.
  To allow another account, change the email in BOTH `is_crm_user()` and `ALLOWED_EMAIL` in Crm.tsx.
- Uses normal Supabase Auth (same login as the dashboard), not the `admin-auth` token flow.
- The account must already exist in Supabase Auth (there is no sign-up on the page).

## Gotchas
- Grid renders one `<input>` per cell, paginated at 50 rows to keep large lists fast.
- Search filters by original row index so edits on filtered rows hit the right row.
- `supabase/migrations` CLI on this machine was not logged in on 2026-11-14; migration was
  written but had to be applied via SQL editor / `npx supabase db push` after `npx supabase login`.
