-- Desk phones (e.g. Yealink) registered on their OWN Telnyx credential
-- connection, deliberately separate from telnyx_webrtc_registrations so the
-- app registration logic never sees them.
create table if not exists public.desk_phones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phone_number_id uuid references public.phone_numbers(id) on delete set null,
  telnyx_connection_id text not null unique,
  telnyx_credential_id text,
  sip_username text not null,
  sip_password text,
  label text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists desk_phones_user_id_idx on public.desk_phones (user_id);

alter table public.desk_phones enable row level security;

-- Owners may read their own desk phone(s); company admins may read their
-- teammates'. Writes go through service-role edge functions only.
create policy "desk_phones_select_own_or_company_admin" on public.desk_phones
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_company_admin_of(user_id));

create or replace function public.set_desk_phones_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists desk_phones_updated_at on public.desk_phones;
create trigger desk_phones_updated_at
  before update on public.desk_phones
  for each row execute function public.set_desk_phones_updated_at();

-- Which surface handled the call: web | desktop | mobile | deskphone. Null for
-- historical rows and for anything that does not stamp it.
alter table public.call_history add column if not exists device text;
