-- Per-desk-phone "record every call" switch, owned by the user.
alter table public.desk_phones add column if not exists auto_record boolean not null default false;

-- The owner may flip auto_record on their own desk phone and nothing else:
-- RLS scopes the row, the column grant scopes the fields.
revoke update on public.desk_phones from authenticated;
grant update (auto_record) on public.desk_phones to authenticated;

drop policy if exists "desk_phones_update_own_auto_record" on public.desk_phones;
create policy "desk_phones_update_own_auto_record" on public.desk_phones
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
