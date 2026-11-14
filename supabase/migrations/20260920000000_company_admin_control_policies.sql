-- Company-admin "Control" dashboard (/control).
--
-- A company admin (profiles.is_company_admin = true) manages the users who
-- share their profiles.company_name. profiles / phone_numbers / call_history /
-- call_recordings already have public SELECT policies; the tables below were
-- own-row or enterprise-only, so a company admin could not read a teammate's
-- notes, the company's AI assistants, or (on a non-enterprise plan) the
-- company's departments and IVR. These helpers are SECURITY DEFINER so the
-- policies never recurse into profiles' own RLS.

create or replace function public.is_company_admin_for(target_company text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_company is not null
     and exists (
       select 1
       from public.profiles me
       where me.id = auth.uid()
         and me.is_company_admin = true
         and me.company_name = target_company
     );
$$;

create or replace function public.is_company_admin_of(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles me
    join public.profiles t on t.company_name = me.company_name
    where me.id = auth.uid()
      and me.is_company_admin = true
      and me.company_name is not null
      and t.id = target_user
  );
$$;

revoke all on function public.is_company_admin_for(text) from public;
revoke all on function public.is_company_admin_of(uuid) from public;
grant execute on function public.is_company_admin_for(text) to authenticated;
grant execute on function public.is_company_admin_of(uuid) to authenticated;

-- Teammates' call notes (read-only for the admin; editing stays own-row).
drop policy if exists "Company admins can view team call notes" on public.call_notes;
create policy "Company admins can view team call notes"
  on public.call_notes for select
  using (public.is_company_admin_of(user_id));

-- AI assistants assigned to anyone in the company.
drop policy if exists "Company admins can view company assistants" on public.ai_assistants;
create policy "Company admins can view company assistants"
  on public.ai_assistants for select
  using (assigned_user_id is not null and public.is_company_admin_of(assigned_user_id));

-- Departments + membership, scoped to the admin's own company (the existing
-- enterprise policies stay; these add the company-admin path and scope
-- membership changes to the company, which the old ones did not).
drop policy if exists "Company admins can view company departments" on public.departments;
create policy "Company admins can view company departments"
  on public.departments for select
  using (public.is_company_admin_for(company_name));

drop policy if exists "Company admins can view company department members" on public.department_members;
create policy "Company admins can view company department members"
  on public.department_members for select
  using (exists (
    select 1 from public.departments d
    where d.id = department_members.department_id
      and public.is_company_admin_for(d.company_name)
  ));

drop policy if exists "Company admins can add company department members" on public.department_members;
create policy "Company admins can add company department members"
  on public.department_members for insert
  with check (
    public.is_company_admin_of(user_id)
    and exists (
      select 1 from public.departments d
      where d.id = department_members.department_id
        and public.is_company_admin_for(d.company_name)
    )
  );

drop policy if exists "Company admins can remove company department members" on public.department_members;
create policy "Company admins can remove company department members"
  on public.department_members for delete
  using (exists (
    select 1 from public.departments d
    where d.id = department_members.department_id
      and public.is_company_admin_for(d.company_name)
  ));

-- IVR (read-only in Control; editing remains an admin-console action).
drop policy if exists "Company admins can view company IVR" on public.ivr_configurations;
create policy "Company admins can view company IVR"
  on public.ivr_configurations for select
  using (public.is_company_admin_for(company_name));

drop policy if exists "Company admins can view company IVR menu" on public.ivr_menu_options;
create policy "Company admins can view company IVR menu"
  on public.ivr_menu_options for select
  using (exists (
    select 1 from public.ivr_configurations c
    where c.id = ivr_menu_options.ivr_config_id
      and public.is_company_admin_for(c.company_name)
  ));
