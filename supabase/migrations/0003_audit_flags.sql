-- Audit trail: every change to people-facing and allocation data is recorded, including edits to past rounds.

create function write_audit() returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb; o jsonb;
begin
  r := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  o := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  insert into audit_log (association_id, actor, table_name, action, row_key, old_row, new_row)
  values (coalesce(r ->> 'association_id', o ->> 'association_id', r ->> 'id', o ->> 'id'),
          jwt_email(), tg_table_name, tg_op,
          coalesce(r, o) ->> 'id', o, r);
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['associations','memberships','officers','rounds','games','game_days','appointments','withdrawals','grades','association_settings'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$I for each row execute function write_audit()', t);
  end loop;
end $$;

insert into feature_flags (key, description) values
  ('clash_checks', 'Time-based clash checks between games'),
  ('part_of_day_availability', 'Morning / afternoon / evening availability'),
  ('setup_wizard', 'Guided association set-up');
