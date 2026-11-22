-- The platform owner sets up associations: their PlayHQ organisation, who their appointments officers are,
-- and which features they have. Officers no longer enter the PlayHQ ID themselves.
--
-- From the Supabase SQL editor (see README, "Platform owner"):
--   select platform_setup_association('pdca', 'Parramatta District Cricket Association', '<playhq org id>', 'officer@example.com');
--   select platform_add_officer('pdca', 'second.officer@example.com');
--   select platform_set_flag('pdca', 'player_umpire', true);

-- Player umpiring is a feature the platform owner switches on per association.
insert into feature_flags (key, description) values
  ('player_umpire', 'Members may choose their own games to umpire (player umpires)')
on conflict (key) do nothing;

-- Associations already using it keep it.
insert into association_flags (association_id, key, enabled)
select id, 'player_umpire', true from associations where coalesce((config #>> '{playerUmpire,enabled}')::boolean, false)
on conflict (association_id, key) do nothing;

-- Officers cannot change the plan, the owner or the PlayHQ organisation. The SQL editor and the server
-- (not a signed-in user) can.
create or replace function guard_assoc() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if current_user = 'authenticated' and not is_platform_admin() and (
       new.plan <> old.plan or new.created_by is distinct from old.created_by or new.id <> old.id
       or new.playhq_org_id is distinct from old.playhq_org_id) then
    raise exception 'Only the platform owner can change the plan or the PlayHQ organisation';
  end if;
  return new;
end $$;

-- Create (or update) an association and make an email its appointments officer.
create or replace function platform_setup_association(p_id text, p_name text, p_playhq_org_id text, p_officer_email text)
returns text language plpgsql security definer set search_path = public as $$
begin
  if p_playhq_org_id is not null and p_playhq_org_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'That does not look like a PlayHQ organisation ID: %', p_playhq_org_id;
  end if;
  insert into associations (id, name, playhq_org_id, created_by)
  values (p_id, p_name, lower(p_playhq_org_id), 'platform')
  on conflict (id) do update set name = excluded.name, playhq_org_id = excluded.playhq_org_id;
  if p_officer_email is not null then
    insert into officers (association_id, email) values (p_id, lower(trim(p_officer_email))) on conflict do nothing;
  end if;
  return p_id;
end $$;

create or replace function platform_add_officer(p_id text, p_email text)
returns void language sql security definer set search_path = public as $$
  insert into officers (association_id, email) values (p_id, lower(trim(p_email))) on conflict do nothing;
$$;

create or replace function platform_remove_officer(p_id text, p_email text)
returns void language sql security definer set search_path = public as $$
  delete from officers where association_id = p_id and email = lower(trim(p_email));
$$;

create or replace function platform_set_flag(p_id text, p_key text, p_on boolean)
returns void language sql security definer set search_path = public as $$
  insert into association_flags (association_id, key, enabled) values (p_id, p_key, p_on)
  on conflict (association_id, key) do update set enabled = excluded.enabled;
$$;

-- Only the platform owner (SQL editor / server), never a signed-in user, may call these.
revoke all on function platform_setup_association(text, text, text, text), platform_add_officer(text, text),
  platform_remove_officer(text, text), platform_set_flag(text, text, boolean) from public, anon, authenticated;
