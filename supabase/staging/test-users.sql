-- STAGING ONLY. Sets up the three test accounts the automated tests sign in with, in the Parramatta
-- District association (id 'pdca'). Never run this on production.
--
-- 1. Supabase dashboard (staging project) -> Authentication -> Users -> Add user -> Create new user.
--    Tick "Auto Confirm User". Create these three, each with its own long random password:
--        test-officer@thirdumpire.test
--        test-umpire@thirdumpire.test
--        test-applicant@thirdumpire.test
--    Keep the passwords in a password manager and in GitHub (Settings -> Secrets and variables -> Actions):
--        TEST_OFFICER_PASSWORD, TEST_UMPIRE_PASSWORD, TEST_APPLICANT_PASSWORD
--    Never put them in the repo or in chat.
-- 2. Run this file in the SQL Editor. It can be run again at any time.

-- The officer: an appointments officer of Parramatta (and nothing else).
select platform_add_officer('pdca', 'test-officer@thirdumpire.test');

-- The umpire: an approved member of Parramatta, with a profile.
insert into people (email, first_name, last_name, name, phone)
values ('test-umpire@thirdumpire.test', 'Test', 'Umpire', 'Test Umpire', '0400 000 001')
on conflict (email) do update set first_name = excluded.first_name, last_name = excluded.last_name, name = excluded.name;

insert into memberships (association_id, email, pid, active, membership, member_since, approved)
values ('pdca', 'test-umpire@thirdumpire.test', 'p-test-umpire', true, 'Ordinary member', current_date, true)
on conflict (association_id, email) do update set approved = true, active = true, rejected = null, suspended = null;

-- The applicant: signed up, not in any association. The test asks to join and then takes the request back,
-- so this also clears anything left behind by a test that stopped half way.
delete from memberships where association_id = 'pdca' and email = 'test-applicant@thirdumpire.test';
