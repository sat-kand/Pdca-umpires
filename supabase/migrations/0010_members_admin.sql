-- Members page, admin side.
--
-- 1. A membership file can fill in details an existing member has left blank (mobile, address, ...). It never
--    changes a detail the member has: their own details stay theirs. Only for people who are members of an
--    association the admin runs.
create or replace function officer_add_person(aid text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(p->>'email');
begin
  if not is_officer(aid) then raise exception 'Only an admin of this association can add members'; end if;
  if exists (select 1 from people where email = e) then
    if not exists (select 1 from memberships where association_id = aid and email = e) then return; end if;
    update people set
      first_name = coalesce(first_name, nullif(p->>'first_name', '')),
      last_name = coalesce(last_name, nullif(p->>'last_name', '')),
      name = coalesce(name, nullif(p->>'name', '')),
      dob = coalesce(dob, nullif(p->>'dob', '')::date),
      address = coalesce(address, nullif(p->>'address', '')),
      phone = coalesce(phone, nullif(p->>'phone', '')),
      accreditation = coalesce(accreditation, nullif(p->>'accreditation', '')),
      accreditation_provider = coalesce(accreditation_provider, nullif(p->>'accreditation_provider', '')),
      updated_at = now()
    where email = e;
    return;
  end if;
  insert into people (email, first_name, last_name, name, dob, address, phone, accreditation, accreditation_provider)
  values (e, nullif(p->>'first_name', ''), nullif(p->>'last_name', ''), nullif(p->>'name', ''),
          nullif(p->>'dob', '')::date, nullif(p->>'address', ''), nullif(p->>'phone', ''),
          nullif(p->>'accreditation', ''), nullif(p->>'accreditation_provider', ''))
  on conflict (email) do nothing;
end $$;
revoke all on function officer_add_person(text, jsonb) from public;
grant execute on function officer_add_person(text, jsonb) to authenticated;

-- 2. An admin can delete a member from their association (the member's profile -> Delete member). Their
--    person record and their memberships elsewhere stay.
drop policy if exists mem_officer_delete on memberships;
create policy mem_officer_delete on memberships for delete to authenticated using (assoc_open(association_id) and is_officer(association_id));
