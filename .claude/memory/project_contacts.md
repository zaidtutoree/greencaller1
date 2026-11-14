---
name: project_contacts
description: "Contacts area: personal contacts (user_contacts) + enterprise Teammates with built-in team messaging (no Messages tab since 2026-09-20); ContactsView/TeamConversation/usePersonalContacts"
metadata: 
  node_type: memory
  type: project
  originSessionId: d39d4353-9ee0-4f3c-8592-c23fd2645cef
  modified: 2026-09-20T17:58:07.515Z
---

## Data
- Personal contacts = `user_contacts` (id, user_id, name, phone_number, email), shared
  with the mobile app, realtime. NOT `contacts`. Hook `hooks/usePersonalContacts.ts`
  (fetch/realtime/add/delete + `contactInitials`/`contactColor`), dialog
  `components/AddContactDialog.tsx`. Writes call `invalidateContactsCache()`
  (`utils/contactLookup.ts`, used for live caller-name resolution).
- Teammates = profiles sharing `company_name` (minus self) + `phone_numbers` +
  `departments`/`department_members`. Team chat = `team_messages`
  (from_user_id, to_user_id, message_body, read).

## Surfaces (2026-09-20 redesign)
- **Enterprise** `components/ContactsView.tsx`: ONE left bar (w-80) whose header
  holds two title-style tabs **Contacts | Teammates** (+ Add button for contacts,
  red dot on Teammates when unread). Right pane = contact details (call/info/
  delete) or `components/TeamConversation.tsx` (1:1 chat: header w/ online +
  phone + Call, bubbles, composer; marks read on open/arrival; realtime on
  to_user_id / from_user_id). Teammate rows: avatar with online dot + red unread
  count badge, grouped Unassigned/departments, admin dropdown (assign/move/
  remove) when `profiles.is_company_admin`. Presence channel `online-users`
  keyed by userId. `compact` prop = single column, detail/chat replaces the list
  with a back chevron (Sidebar Mode). `onMessagesRead` → parent refreshes badge.
- **Messages tab is gone**: MainSidebar item removed, unread badge now on the
  Contacts item (`unreadMessageCount` prop still computed in EnterprisePlatform);
  AppSidebar Messages item + Dashboard `/messages` route removed; SidebarApp strip
  "messages" panel removed, `badges.messages` shown on the contacts strip item.
  `MessagesList.tsx` and the old `Contacts.tsx` were deleted in both apps.
- **Basic/premium**: `components/PersonalContacts.tsx` single list (Dashboard
  `/dashboard/contacts` card, sidebar) — now built on the same hook + dialog.

## Gotchas
- `handleMakeCall(phoneNumber, record?)` — 2nd arg is a RECORD flag; onCall must
  pass only the number.
- `AppSidebar` requiresAccount union lost 'enterprise' when Messages was removed;
  the filter compares via `as string | undefined` to keep the enterprise branch.
