-- An admin adding members (Members -> Add a member, or the bulk upload) creates each new person's record.
-- A plain insert is refused: Supabase also checks the admin can read the row it just added, and an admin
-- can only read people who are already members, which a new person is not until a moment later. This
-- function adds the record for an admin of that association, and never changes a record that exists.
create or replace function officer_add_person(aid text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_officer(aid) then raise exception 'Only an admin of this association can add members'; end if;
  insert into people (email, first_name, last_name, name, dob, address, phone, accreditation, accreditation_provider)
  values (lower(p->>'email'), nullif(p->>'first_name', ''), nullif(p->>'last_name', ''), nullif(p->>'name', ''),
          nullif(p->>'dob', '')::date, nullif(p->>'address', ''), nullif(p->>'phone', ''),
          nullif(p->>'accreditation', ''), nullif(p->>'accreditation_provider', ''))
  on conflict (email) do nothing;
end $$;
revoke all on function officer_add_person(text, jsonb) from public;
grant execute on function officer_add_person(text, jsonb) to authenticated;
