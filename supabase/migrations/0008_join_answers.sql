-- Each association can ask its own questions when someone joins (Settings -> New umpires -> Your own questions,
-- kept in associations.config.joining.custom). The answers belong to that association, so they sit on the
-- membership rather than on the person.
alter table memberships add column if not exists answers jsonb;
