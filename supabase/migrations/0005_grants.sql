-- Supabase does not give signed-in users access to new tables by default. Grant it here; row-level
-- security (0002) still decides which rows each person can see or change.
grant usage on schema public to authenticated;

grant select, insert, update, delete on
  associations, people, memberships, officers, groups, seasons, grades, rounds, games, game_days,
  availability, appointments, withdrawals, association_settings, feature_flags, association_flags
  to authenticated;

grant select on platform_admins, audit_log, sync_runs to authenticated;
grant insert on mail_queue to authenticated;

grant usage, select on all sequences in schema public to authenticated;

-- The server side (Edge Functions with the secret key) keeps full access.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
