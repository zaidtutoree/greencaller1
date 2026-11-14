---
name: project_control_dashboard
description: "/control company-admin dashboard (users, IVR, AI assistant cards + per-user analytics/recordings/notes/departments); RLS helpers; what a company admin is"
metadata: 
  node_type: memory
  type: project
  originSessionId: d39d4353-9ee0-4f3c-8592-c23fd2645cef
  modified: 2026-09-20T16:36:41.060Z
---

Added 2026-09-20. Route `/control` in BOTH apps (web BrowserRouter, exe HashRouter
`#/control`). Shared code: `src/pages/ControlDashboard.tsx` +
`src/components/control/{CallAnalytics,RecordingsList,NotesList,ControlUserDetail,ControlIvrDetail}.tsx`.
Identical in web + exe; edit in exe, copy to web (see [[project_structure]]).

## Who gets in
A "company admin" = `profiles.is_company_admin = true` (toggled per company in the
admin console's Companies tab, `CompanyManagement.tsx` → `admin-user` fn; one per
company). Company = `profiles.company_name` (there is NO companies table). Any
account type can be company admin (Kufa's admin is `basic`). `/control` uses the
normal Supabase login (inline form); non-admins get a "Not a company admin" screen.

## Layout
Overview = cards: Team (one per profile with that company_name: number, dept
badges, 30-day calls/min/missed), IVR numbers (ivr_configurations by company),
AI assistants (ai_assistants whose assigned_user_id is in the company). Clicking
a card swaps in a detail view (state, not a route).
- User detail tabs: Analytics (stat tiles + 14-day inbound/outbound BarChart via
  ui/chart + recharts), Calls (reuses `CallHistory` w/ accountType="enterprise"),
  Recordings (`RecordingsList`, read-only: play/download/AI summary), Notes
  (`NotesList`, read-only), Departments (Switch per department →
  department_members insert/delete).
- IVR detail: analytics of inbound call_history to that number across company
  users (matched on last 9 digits), menu options w/ dept/user names, recordings.
- Assistant detail: `<AIAssistant assistantId readOnly />` — new props; fn
  `ai-assistant-stats` accepts `{assistantId}` and allows the assigned user OR a
  company admin of that user's company (v8, verify_jwt true).

## RLS (migration 20260920000000_company_admin_control_policies.sql, applied)
SECURITY DEFINER helpers `is_company_admin_for(company text)` /
`is_company_admin_of(user uuid)`. New SELECT policies for company admins on
call_notes, ai_assistants, departments, department_members, ivr_configurations,
ivr_menu_options; INSERT/DELETE on department_members scoped to own company.
profiles / phone_numbers / call_history / call_recordings already had public
SELECT (`true`) so no change there. summarize-call / proxy-recording /
transcribe-recording have no ownership checks, so AI summary + playback work for
admins as-is.

## Gotchas
- Old enterprise-only department policies still exist; the new ones add the
  company-admin path. A non-enterprise company admin can now toggle departments
  (their company just has none, typically).
- Recordings for an IVR number span all users → `RecordingsList` takes
  `userIds` + `matchNumber`.
