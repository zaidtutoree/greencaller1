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
- `column_meta jsonb` (migration `20261115000000_crm_sheets_column_meta.sql`, applied 2026-11-15):
  `{ width?: px, type?: "text"|"choice", options?: string[] }[]` aligned by index to `columns`.
  `normaliseMeta()` always pads/truncates it to `columns.length`; EVERY column mutation
  (add/delete/move/split) must update `meta` alongside `columns` and each row.
  `ColumnMeta` is a `type` alias, not an `interface`, so it is assignable to the generated `Json` type.
- Whole sheet (name + columns + rows) is re-saved with a 900 ms debounce; pending saves are
  flushed on sheet switch / sign out, and `beforeunload` warns if unsaved.
- CSV parsing is the in-house `src/lib/csv.ts` (RFC 4180, BOM, delimiter auto-detect) — no dependency.

## Access control
- Only `zaid@greencaller.co.uk` may use it. Frontend checks `session.user.email`, but the real
  gate is RLS: policy uses `public.is_crm_user()` which compares `auth.jwt()->>'email'`.
  To allow another account, change the email in BOTH `is_crm_user()` and `ALLOWED_EMAIL` in Crm.tsx.
- Uses normal Supabase Auth (same login as the dashboard), not the `admin-auth` token flow.
- The account must already exist in Supabase Auth (there is no sign-up on the page).

## Grid features (added 2026-11-15)
- **Column reorder**: drag the grip handle on a header onto another header (native HTML5 DnD on the
  `<th>`; only the grip `<span>` is `draggable` so the rename input still takes text selection), or use
  the ←/→ hover buttons. `moveColumn(from,to)` reorders `columns` AND every row, and re-points `searchCol`.
- **Row selection**: `selected` is a `Set` of ORIGINAL row indexes. Click the checkbox cell, shift-click
  for a range (range is computed over `visibleIndexes` display order), header checkbox = this page,
  "Select all" = all rows matching the current search, "Rows X to Y" = 1-based range picker.
  `deleteRow` remaps indexes; `switchSheet`/`createSheet` call `resetView()` which clears it.
- **Move / Copy to new list**: creates a new `crm_sheets` row with the same columns + selected rows
  (`createSheet` first, then removes rows from the source only if the insert succeeded). New list
  becomes active and shows in the left Lists panel.
- **Search**: multi-word AND match; `<select>` next to the box scopes it to one column (`searchCol`,
  -1 = all). Column delete/move keep `searchCol` pointing at the same column.

## Column width / column type / Excel import (added 2026-11-15)
- **Width**: resize handle is an absolutely-positioned 7px strip on the right of each `<th>`
  (`startResize` → window pointermove/up; live width in `tempWidth`, committed to `meta[c].width`
  on release; double-click resets). Width applied via inline `width/minWidth/maxWidth` on th AND td.
- **Type**: "Column" button and the per-header ⚙ button open the same dialog (`columnDialog`,
  `index: null` = add). Type "choice" renders a native `<select>` per cell with the options; a cell
  value no longer in the options is kept as an extra `<option>` so it isn't lost.
- **Excel**: `src/lib/excel.ts` (`parseExcelTables`) uses SheetJS `xlsx` 0.20.3 installed from
  `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (npm's 0.18.5 has known CVEs) — dynamic
  `import("xlsx")` so it's a lazy ~500 kB chunk. Splits each worksheet into "islands" of filled cells
  (8-connected flood fill + bounding-box merge); a lone cell above a wider row becomes the table title.
  Islands with <2 filled cells are ignored. CSV import is unchanged (no splitting).
  Naming: single table → file name; else title, or `Sheet` / `Sheet – table N`. All tables are
  inserted in ONE `insert([...])` via `createSheets()`.

## Gotchas
- Grid renders one `<input>` per cell, paginated at 50 rows to keep large lists fast.
- Search filters by original row index so edits on filtered rows hit the right row.
- `supabase/migrations` CLI on this machine was not logged in on 2026-11-14; migration was
  written but had to be applied via SQL editor / `npx supabase db push` after `npx supabase login`.
