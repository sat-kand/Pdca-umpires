-- Each check prints PASS or raises. `as(email)` switches to a signed-in user.
create function as_user(e text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('email', e)::text, false); end $$;
create function expect(label text, ok boolean) returns void language plpgsql as $$
begin if not ok then raise exception 'FAIL: %', label; end if; raise notice 'PASS: %', label; end $$;
create function denied(label text, sql text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'PASS: % (%)', label, sqlerrm; return; end;
  raise exception 'FAIL (was allowed): %', label;
end $$;
create function rows_visible(sql text) returns int language plpgsql as $$
declare n int; begin execute 'select count(*) from (' || sql || ') q' into n; return n; end $$;

-- seed as the owner (bypasses RLS)
insert into associations (id, name) values ('pdca','PDCA'), ('other','Other');
insert into platform_admins values ('owner@x.test');
insert into people (email, name) values ('off@x.test','Officer'),('u1@x.test','U One'),('u2@x.test','U Two'),('o2@x.test','Other officer');
insert into officers values ('pdca','off@x.test'), ('other','o2@x.test');
insert into memberships (association_id,email,pid,active) values ('pdca','u1@x.test','p1',true),('pdca','u2@x.test','p2',true),('other','u1@x.test','q1',true);
insert into rounds (association_id,id,published) values ('pdca','r-pub',true),('pdca','r-draft',false);
insert into games (association_id,id,round_id) values ('pdca','g-pub','r-pub'),('pdca','g-draft','r-draft');
insert into game_days values ('pdca','g-pub',1,'2026-11-28','13:30','Park',null,null,null),('pdca','g-pub',2,'2026-11-29','13:30','Park',null,null,null);
insert into appointments (association_id,game_id,date,slot_index,pid) values ('pdca','g-pub','2026-11-28',0,'p1'),('pdca','g-draft','2026-11-28',0,'p2');
reset role;

set role authenticated;

-- umpire u1
select as_user('u1@x.test');
select expect('umpire sees published appointment', rows_visible($$select 1 from appointments where game_id='g-pub'$$) = 1);
select expect('umpire cannot see draft appointment', rows_visible($$select 1 from appointments where game_id='g-draft'$$) = 0);
select expect('umpire sees both games (fixtures)', rows_visible($$select 1 from games where association_id='pdca'$$) = 2);
select expect('two-day game has two day rows', rows_visible($$select 1 from game_days where game_id='g-pub'$$) = 2);
select denied('umpire cannot add an appointment', $$insert into appointments (association_id,game_id,date,slot_index,pid) values ('pdca','g-pub','2026-11-28',1,'p1')$$);
select denied('umpire cannot approve themselves', $$update memberships set active=false where email='u1@x.test' and association_id='pdca'$$ );
select denied('umpire cannot change membership type', $$update memberships set membership='full' where email='u1@x.test' and association_id='pdca'$$);
update memberships set wants_to_umpire = true where email='u1@x.test' and association_id='pdca';
select expect('umpire may set own wish', (select wants_to_umpire from memberships where email='u1@x.test' and association_id='pdca'));
select expect('umpire cannot see another umpire profile', rows_visible($$select 1 from people where email='u2@x.test'$$) = 0);
update people set phone='0400' where email='u1@x.test';
select expect('umpire edits own details', (select phone from people where email='u1@x.test') = '0400');
select expect('umpire sees only own membership lines', rows_visible($$select 1 from memberships$$) = 2);
select denied('umpire cannot add an officer', $$insert into officers values ('pdca','u1@x.test')$$);
select denied('umpire cannot change settings', $$insert into association_settings values ('pdca','{}')$$);
select expect('umpire cannot read audit log', rows_visible($$select 1 from audit_log$$) = 0);
select as_user('u2@x.test');
select denied('umpire cannot join as active', $$insert into memberships (association_id,email,pid,active) values ('other','u2@x.test','q3',true)$$);
select as_user('u2@x.test');
insert into memberships (association_id,email,pid,active) values ('other','u2@x.test','q2',false);
select as_user('u1@x.test');
select denied('umpire cannot write availability for someone else', $$insert into availability (association_id,season_id,email) values ('pdca','s','u2@x.test')$$);
insert into availability (association_id,season_id,email) values ('pdca','s','u1@x.test');
select expect('own availability saved', rows_visible($$select 1 from availability$$) = 1);
select denied('cannot withdraw as someone else', $$insert into withdrawals (association_id,id,email,pid) values ('pdca','w1','u1@x.test','p2')$$);
insert into withdrawals (association_id,id,email,pid) values ('pdca','w1','u1@x.test','p1');
select expect('umpire cannot read withdrawals', rows_visible($$select 1 from withdrawals$$) = 0);

-- umpire u1 has no access to an association they have not joined
select as_user('u2@x.test');
select expect('u2 sees nothing in an association they have not joined', rows_visible($$select 1 from games where association_id='other'$$) = 0);

-- officer
select as_user('off@x.test');
select expect('officer sees draft appointment', rows_visible($$select 1 from appointments where game_id='g-draft'$$) = 1);
select expect('officer sees members profiles', rows_visible($$select 1 from people where email in ('u1@x.test','u2@x.test')$$) = 2);
update people set phone='1' where email='u2@x.test';   -- matches no row: officers have no update policy on people
select expect('officer edit of person changed nothing', (select coalesce(phone,'') from people where email='u2@x.test') = '');
update memberships set active=false where email='u2@x.test' and association_id='pdca';
select expect('officer can deactivate a member', not (select active from memberships where email='u2@x.test' and association_id='pdca'));
select denied('officer cannot change plan', $$update associations set plan='suspended' where id='pdca'$$);
update associations set playhq_org_id='abc' where id='pdca';
select expect('officer sets PlayHQ org id', (select playhq_org_id from associations where id='pdca') = 'abc');
select denied('officer cannot write another association', $$insert into rounds (association_id,id) values ('other','x')$$);
select expect('officer sees other-association memberships of own member (membership only)', rows_visible($$select 1 from memberships where email='u1@x.test'$$) = 2);
delete from officers where email='off@x.test';   -- matches no row
select expect('officer still present', rows_visible($$select 1 from officers where association_id='pdca'$$) = 1);
insert into appointments (association_id,game_id,date,slot_index,pid) values ('pdca','g-pub','2026-11-29',0,'p1');
update appointments set pid='p2' where game_id='g-pub' and date='2026-11-29';
select expect('audit log records changes', rows_visible($$select 1 from audit_log where table_name='appointments' and actor='off@x.test'$$) >= 2);

-- suspended association is read-only
reset role;
select as_user('owner@x.test');
update associations set plan='suspended' where id='pdca';
set role authenticated;
select as_user('off@x.test');
select denied('suspended association is read-only', $$insert into rounds (association_id,id) values ('pdca','r-new')$$);

-- other officer cannot see pdca
select as_user('o2@x.test');
select expect('other association officer sees no pdca games', rows_visible($$select 1 from games where association_id='pdca'$$) = 0);
select expect('other officer cannot see audit rows of pdca', rows_visible($$select 1 from audit_log where association_id='pdca'$$) = 0);

-- anon sees nothing
reset role; set role anon;
select denied('anon cannot read', $$select 1 from games$$);

-- save_games and officer-created people (run as the owner first so the suspended association is open again)
reset role;
select as_user('owner@x.test');
update associations set plan='trial' where id='pdca';
set role authenticated;
select as_user('off@x.test');
insert into people (email, name) values ('new@x.test', 'New Member');
insert into memberships (association_id,email,pid,active) values ('pdca','new@x.test','p9',true);
select expect('officer can create a person record', rows_visible($$select 1 from people where email='new@x.test'$$) = 1);
select expect('save_games saves a two-day game with an appointment', save_games('pdca','r-draft', $j$[
  {"game":{"id":"g-new","grade":"Senior A Grade","format":"twoDay","slots":1,"home_name":"A","away_name":"B","extra":{}},
   "days":[{"day_no":1,"date":"2026-12-05","start_time":"13:30","ground":"Park"},{"day_no":2,"date":"2026-12-06","start_time":"13:30","ground":"Park"}],
   "appts":[{"date":"2026-12-05","slot_index":0,"pid":"p1","name":"U One"},{"date":"2026-12-06","slot_index":0,"pid":"p1","name":"U One"}]}]$j$::jsonb) = 1);
select expect('draft round appointments are draft', (select count(*) from appointments where game_id='g-new' and status='draft') = 2);
update rounds set published = true where association_id='pdca' and id='r-draft';
select expect('publishing a round publishes its appointments', (select count(*) from appointments where game_id='g-new' and status='published') = 2);
select as_user('u1@x.test');
select denied('umpire cannot save games', $j$select save_games('pdca','r-draft','[{"game":{"id":"g-hack","slots":1},"days":[],"appts":[]}]'::jsonb)$j$);
