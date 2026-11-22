-- Joining an association.
--
-- A person signs up, sees the associations on Third Umpire, and asks to join one (a memberships row, not yet
-- approved). Each association decides, in Settings -> New umpires (associations.config.joining):
--   open                 whether it is listed for new umpires (default yes)
--   membershipRequired   whether someone must be approved before giving availability (default yes)
--   fields               which personal details it asks for when someone joins
--
-- Until now anyone who had asked to join could already give availability. From here that needs approval,
-- unless the association has turned "membership required" off.

-- May this signed-in person give availability to this association?
-- Yes if they are an approved member, or if they have asked to join and the association does not require
-- membership. Never if they were turned down or suspended.
create function can_give_availability(aid text) returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
      from memberships m
      join associations a on a.id = m.association_id
     where m.association_id = aid and m.email = jwt_email()
       and not coalesce(m.rejected, false) and not coalesce(m.suspended, false)
       and (coalesce(m.approved, false) or coalesce(m.active, false) or coalesce(m.deactivated, false)
            or coalesce((a.config #>> '{joining,membershipRequired}')::boolean, true) = false));
$$;

drop policy av_write on availability;
create policy av_write on availability for insert to authenticated with check (
  assoc_open(association_id) and (is_officer(association_id) or (email = jwt_email() and can_give_availability(association_id))));

drop policy av_upd on availability;
create policy av_upd on availability for update to authenticated
  using (assoc_open(association_id) and (is_officer(association_id) or (email = jwt_email() and can_give_availability(association_id))))
  with check (is_officer(association_id) or (email = jwt_email() and can_give_availability(association_id)));

-- Someone may take back their own request while it is still waiting. Once an officer has turned it down
-- they cannot delete it (and ask again); officers can still clear a waiting request as before.
drop policy mem_delete on memberships;
create policy mem_delete on memberships for delete to authenticated using (
  assoc_open(association_id) and active = false
  and coalesce(deactivated, false) = false and coalesce(approved, false) = false
  and (is_officer(association_id) or (email = jwt_email() and not coalesce(rejected, false) and not coalesce(suspended, false))));
