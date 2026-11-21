-- Functions the app calls, and two policy additions.

-- An officer may create the person record for a new member they add (a file import, say), never edit an existing one.
create policy ppl_officer_insert on people for insert to authenticated with check (
  exists (select 1 from officers o where o.email = jwt_email()));

-- When a round is published or unpublished, its appointments follow.
create function sync_appointment_status() returns trigger language plpgsql as $$
begin
  if new.published is distinct from old.published then
    update appointments a set status = case when new.published then 'published' else 'draft' end, updated_at = now()
      from games g
     where g.association_id = new.association_id and g.round_id = new.id
       and a.association_id = g.association_id and a.game_id = g.id and a.status <> 'withdrawn';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger trg_round_published before update on rounds for each row execute function sync_appointment_status();

-- Save games, their days and their appointments in one transaction. Runs as the caller, so row-level security applies.
-- items: [{ game: {...}, days: [{day_no,date,start_time,ground,address,lat,lng}], appts: [{date,slot_index,pid,name,player_umpire}] }]
create function save_games(aid text, rid text, items jsonb) returns int language plpgsql as $$
declare it jsonb; gid text; pub boolean; n int := 0;
begin
  select published into pub from rounds where association_id = aid and id = rid;
  if pub is null then raise exception 'Round % not found', rid; end if;
  for it in select * from jsonb_array_elements(items) loop
    gid := it #>> '{game,id}';
    insert into games (association_id, id, round_id, grade, comp, round_name, format, home_name, away_name, status, slots, removed, playhq_game_id, last_synced_at, extra)
    values (aid, gid, rid, it #>> '{game,grade}', it #>> '{game,comp}', it #>> '{game,round_name}', it #>> '{game,format}',
            it #>> '{game,home_name}', it #>> '{game,away_name}', it #>> '{game,status}', coalesce((it #>> '{game,slots}')::int, 0),
            coalesce((it #>> '{game,removed}')::boolean, false), nullif(it #>> '{game,playhq_game_id}', ''),
            nullif(it #>> '{game,last_synced_at}', '')::timestamptz, coalesce(it #> '{game,extra}', '{}'::jsonb))
    on conflict (association_id, id) do update set
      round_id = excluded.round_id, grade = excluded.grade, comp = excluded.comp, round_name = excluded.round_name,
      format = excluded.format, home_name = excluded.home_name, away_name = excluded.away_name, status = excluded.status,
      slots = excluded.slots, removed = excluded.removed, playhq_game_id = excluded.playhq_game_id,
      last_synced_at = excluded.last_synced_at, extra = excluded.extra;

    delete from game_days where association_id = aid and game_id = gid;
    insert into game_days (association_id, game_id, day_no, date, start_time, ground, address, lat, lng)
    select aid, gid, (d ->> 'day_no')::int, (d ->> 'date')::date, d ->> 'start_time', d ->> 'ground', d ->> 'address',
           (d ->> 'lat')::double precision, (d ->> 'lng')::double precision
      from jsonb_array_elements(coalesce(it -> 'days', '[]'::jsonb)) d;

    delete from appointments where association_id = aid and game_id = gid;
    insert into appointments (association_id, game_id, date, slot_index, pid, name, player_umpire, status)
    select aid, gid, (a ->> 'date')::date, (a ->> 'slot_index')::int, a ->> 'pid', a ->> 'name',
           coalesce((a ->> 'player_umpire')::boolean, false), case when pub then 'published' else 'draft' end
      from jsonb_array_elements(coalesce(it -> 'appts', '[]'::jsonb)) a;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function save_games(text, text, jsonb) from public, anon;
grant execute on function save_games(text, text, jsonb) to authenticated;
