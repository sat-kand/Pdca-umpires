-- Row-level security. Nothing is readable or writable unless a policy below allows it.

create function jwt_email() returns text language sql stable
as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create function is_platform_admin() returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from platform_admins where email = jwt_email()) $$;

create function is_officer(aid text) returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from officers where association_id = aid and email = jwt_email()) $$;

create function is_member(aid text) returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from memberships where association_id = aid and email = jwt_email()) $$;

-- an officer of any association the person belongs to (security definer avoids RLS recursion)
create function officer_of_person(p text) returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from memberships m join officers o on o.association_id = m.association_id
                     where m.email = p and o.email = jwt_email()) $$;

create function in_assoc(aid text) returns boolean language sql stable
as $$ select is_officer(aid) or is_member(aid) $$;

-- trial and active associations can be changed; a suspended one is read-only
create function assoc_open(aid text) returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from associations where id = aid and plan in ('trial','active')) $$;

create function round_published(aid text, rid text) returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from rounds where association_id = aid and id = rid and published) $$;

create function game_round_published(aid text, gid text) returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from games g join rounds r on r.association_id = g.association_id and r.id = g.round_id
                     where g.association_id = aid and g.id = gid and r.published) $$;

do $$ declare t text; begin
  foreach t in array array['associations','people','memberships','officers','platform_admins','groups','seasons','grades',
    'rounds','games','game_days','availability','appointments','withdrawals','association_settings','audit_log',
    'feature_flags','association_flags','sync_runs','mail_queue'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- ----- platform admins: you can only check whether YOU are one -----
create policy pa_self on platform_admins for select to authenticated using (email = jwt_email());

-- ----- associations -----
create policy assoc_read on associations for select to authenticated using (true);   -- open by id (the link); no secrets live here
create policy assoc_create on associations for insert to authenticated with check (is_platform_admin());
create policy assoc_update on associations for update to authenticated
  using (is_platform_admin() or is_officer(id)) with check (is_platform_admin() or is_officer(id));
-- officers cannot change the plan or the owner
create function guard_assoc() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if not is_platform_admin() and (new.plan <> old.plan or new.created_by is distinct from old.created_by or new.id <> old.id) then
    raise exception 'Only the product owner can change the plan';
  end if;
  return new;
end $$;
create trigger trg_guard_assoc before update on associations for each row execute function guard_assoc();

-- ----- officers -----
create policy off_read on officers for select to authenticated using (email = jwt_email() or is_officer(association_id));
create policy off_add on officers for insert to authenticated with check (is_officer(association_id) or is_platform_admin());
create policy off_del on officers for delete to authenticated using (is_officer(association_id) and email <> jwt_email());  -- one officer always remains

-- ----- people: theirs alone. Officers can read members of their association, never edit. -----
create policy ppl_self_read on people for select to authenticated using (email = jwt_email());
create policy ppl_officer_read on people for select to authenticated using (officer_of_person(email));
create policy ppl_self_write on people for insert to authenticated with check (email = jwt_email());
create policy ppl_self_update on people for update to authenticated using (email = jwt_email()) with check (email = jwt_email());

-- ----- memberships -----
create policy mem_read on memberships for select to authenticated using (
  email = jwt_email() or is_officer(association_id)
  or officer_of_person(email));  -- an officer sees a member's lines in other associations: membership only
-- self sign-up starts inactive until an officer approves; officers may add anyone
create policy mem_insert on memberships for insert to authenticated with check (assoc_open(association_id) and (
  is_officer(association_id) or (email = jwt_email() and active = false and approved is not true)));
create policy mem_update on memberships for update to authenticated
  using (assoc_open(association_id) and (is_officer(association_id) or email = jwt_email()))
  with check (assoc_open(association_id) and (is_officer(association_id) or email = jwt_email()));
-- officers may turn down someone who has just registered
create policy mem_delete on memberships for delete to authenticated using (
  assoc_open(association_id) and is_officer(association_id) and active = false
  and coalesce(deactivated,false) = false and coalesce(approved,false) = false);

-- Officers set only what the association decides; members set only their own wish and start date.
create function guard_membership() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if is_officer(old.association_id) then
    if new.pid <> old.pid or new.email <> old.email then raise exception 'pid and email are fixed'; end if;
    return new;
  end if;
  if new.active <> old.active or new.pid <> old.pid or new.email <> old.email
     or new.approved is distinct from old.approved or new.deactivated is distinct from old.deactivated
     or new.non_member is distinct from old.non_member or new.rejected is distinct from old.rejected
     or new.suspended is distinct from old.suspended or new.membership is distinct from old.membership then
    raise exception 'Members may change only their own member-since date and umpiring wish';
  end if;
  return new;
end $$;
create trigger trg_guard_membership before update on memberships for each row execute function guard_membership();

-- ----- fixtures: members of the association read; its officers write -----
do $$ declare t text; begin
  foreach t in array array['groups','seasons','grades','rounds','games','game_days'] loop
    execute format('create policy %1$s_read on %1$I for select to authenticated using (in_assoc(association_id))', t);
    execute format('create policy %1$s_ins on %1$I for insert to authenticated with check (is_officer(association_id) and assoc_open(association_id))', t);
    execute format('create policy %1$s_upd on %1$I for update to authenticated using (is_officer(association_id) and assoc_open(association_id)) with check (is_officer(association_id) and assoc_open(association_id))', t);
    execute format('create policy %1$s_del on %1$I for delete to authenticated using (is_officer(association_id) and assoc_open(association_id))', t);
  end loop;
end $$;

-- ----- appointments: umpires see them only once the round is published -----
create policy app_read on appointments for select to authenticated using (
  is_officer(association_id) or (is_member(association_id) and game_round_published(association_id, game_id)));
create policy app_ins on appointments for insert to authenticated with check (is_officer(association_id) and assoc_open(association_id));
create policy app_upd on appointments for update to authenticated using (is_officer(association_id) and assoc_open(association_id)) with check (is_officer(association_id));
create policy app_del on appointments for delete to authenticated using (is_officer(association_id) and assoc_open(association_id));

-- ----- availability: your own, or any if you are an officer -----
create policy av_read on availability for select to authenticated using (email = jwt_email() or is_officer(association_id));
create policy av_write on availability for insert to authenticated with check (assoc_open(association_id) and (is_officer(association_id) or (email = jwt_email() and is_member(association_id))));
create policy av_upd on availability for update to authenticated using (assoc_open(association_id) and (is_officer(association_id) or email = jwt_email()))
  with check (is_officer(association_id) or email = jwt_email());

-- ----- withdrawals: an umpire records their own; officers handle them -----
create policy wd_read on withdrawals for select to authenticated using (is_officer(association_id));
create policy wd_ins on withdrawals for insert to authenticated with check (assoc_open(association_id) and is_member(association_id)
  and email = jwt_email() and handled = false
  and pid = (select m.pid from memberships m where m.association_id = withdrawals.association_id and m.email = jwt_email()));
create policy wd_upd on withdrawals for update to authenticated using (is_officer(association_id) and assoc_open(association_id)) with check (is_officer(association_id));
create policy wd_del on withdrawals for delete to authenticated using (is_officer(association_id) and assoc_open(association_id));

-- ----- settings: officers only -----
create policy set_all on association_settings for all to authenticated using (is_officer(association_id)) with check (is_officer(association_id) and assoc_open(association_id));

-- ----- audit: officers read their own association's log; written only by triggers -----
create policy audit_read on audit_log for select to authenticated using (is_officer(association_id) or is_platform_admin());

-- ----- flags: readable by everyone signed in; the product owner changes them -----
create policy ff_read on feature_flags for select to authenticated using (true);
create policy ff_write on feature_flags for all to authenticated using (is_platform_admin()) with check (is_platform_admin());
create policy af_read on association_flags for select to authenticated using (in_assoc(association_id));
create policy af_write on association_flags for all to authenticated using (is_platform_admin()) with check (is_platform_admin());

-- ----- sync runs: officers read; written by the sync function (service role bypasses RLS) -----
create policy sr_read on sync_runs for select to authenticated using (is_officer(association_id));

-- ----- mail queue: write-only, only to the address set in Settings -----
create policy mq_ins on mail_queue for insert to authenticated with check (in_assoc(association_id)
  and to_email = (select a.notify_email from associations a where a.id = mail_queue.association_id));

-- Stop the public API role touching anything.
revoke all on all tables in schema public from anon;
