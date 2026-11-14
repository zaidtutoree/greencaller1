---
name: Project Structure and Deployment
description: How the web app, exe app, and shared backend are structured — deployment workflow for both
type: project
---

## Folder Structure

```
greencaller1/
├── greencallerapp1/          ← Web app (React, deployed via Netlify to greencaller.app)
│   ├── src/                  ← Frontend code
│   ├── supabase/             ← LEGACY copy — do NOT deploy from here
│   └── .claude/              ← Memory/reference files
├── greencallerapp1exe/       ← Exe app (React + Electron)
│   ├── src/                  ← Frontend code (must match greencallerapp1/src/)
│   ├── electron/             ← Electron-specific code
│   └── supabase/             ← LEGACY copy — do NOT deploy from here
└── supabase/                 ← SHARED backend (edge functions, migrations, config)
```

## Shared Backend

Both apps use the same Supabase project (`wofpxloehneavpoiqpal`). Edge functions are deployed from `greencaller1/supabase/` ONLY.

**Deploy commands (always from greencaller1/):**
```bash
cd C:/Users/zaid/Downloads/greencaller1
npx supabase functions deploy <function-name>
```

The `supabase/` folders inside `greencallerapp1/` and `greencallerapp1exe/` are legacy copies kept for reference. NEVER deploy from those folders — it causes desync.

## Frontend Sync

Both apps share identical frontend code in `src/` EXCEPT for exe-only files:
- `greencallerapp1exe/src/electron.d.ts` — Electron types
- `greencallerapp1exe/src/components/RingtoneSettings.tsx` — Exe-only feature
- `greencallerapp1exe/src/utils/` — Exe-only utilities

**When making frontend changes:**
1. Edit `greencallerapp1/src/` (web app)
2. Copy the changed file to `greencallerapp1exe/src/` (exe app)
3. Both frontends must stay in sync

**Quick sync command for a file:**
```bash
cp greencallerapp1/src/path/to/file.ts greencallerapp1exe/src/path/to/file.ts
```

## Deployment

### Web App (Netlify)
- Auto-deploys when pushing to GitHub (`greencallerapp1/` repo)
- Domain: greencaller.app
- Environment variables set in Netlify dashboard (VITE_SUPABASE_URL, etc.)

### Exe App (Electron)
- Built locally with Electron builder
- Frontend changes need manual rebuild

### Edge Functions (Supabase)
- Must be deployed manually from `greencaller1/`:
```bash
cd C:/Users/zaid/Downloads/greencaller1
npx supabase functions deploy <function-name>
```
- One deploy serves both web and exe apps
- Supabase linked to project: `npx supabase link --project-ref wofpxloehneavpoiqpal`

## Key Rules

1. **NEVER deploy edge functions from greencallerapp1/ or greencallerapp1exe/** — only from greencaller1/
2. **Always sync frontend changes to both** greencallerapp1/src/ and greencallerapp1exe/src/
3. **Backend edits go in** greencaller1/supabase/ only
4. **Git repo is in** greencallerapp1/ — push from there for Netlify deploys
