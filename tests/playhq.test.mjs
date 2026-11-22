// The PlayHQ Edge Function's logic (supabase/functions/playhq/phq.js), against PlayHQ-shaped data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSeasons, legacySeasons, legacyCompetitions, legacyMatches, localStamp, matchTypeOf, run, makePhq, cachedPhq, PhqError, isUuid } from '../supabase/functions/playhq/phq.js';
import { normaliseMatch, makePlayhqApi, fixtureApi, loadFixtures } from '../js/fixtures.js';

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = U(1), S_SEN = U(10), S_JUN = U(11), S_OLD = U(12), G_A = U(20), G_B = U(21);

const seasons = [
  { id: S_SEN, name: 'Summer 2026/27', status: 'ACTIVE', createdAt: '2026-08-01T00:00:00Z', association: { id: ORG, name: 'Parramatta District Cricket Association' }, competition: { id: U(30), name: 'PDCA Senior Competition' } },
  { id: S_JUN, name: 'Summer 2026/27', status: 'ACTIVE', createdAt: '2026-08-02T00:00:00Z', association: { id: ORG, name: 'Parramatta District Cricket Association' }, competition: { id: U(31), name: 'PDCA Junior Competition' } },
  { id: S_OLD, name: 'Winter 2026', status: 'ENDED', createdAt: '2026-03-01T00:00:00Z', association: { id: ORG, name: 'PDCA' }, competition: { id: U(32), name: 'T10 Blast' } },
];

const v2 = {
  rounds: [
    { id: 'r3', name: 'Round 3', abbreviatedName: 'R3', isFinalRound: false, byes: [{ teamID: 't3' }], games: [
      { id: 'game-two', status: 'UPCOMING', type: 'twoDay',
        schedule: [{ day: 1, dateTime: '2026-10-24T02:30:00.000Z', playingSurfaceId: 'ps1' }, { day: 2, dateTime: '2026-10-31T02:30:00.000Z', playingSurfaceId: 'ps1' }],
        teams: [{ id: 't1', isHomeTeam: true }, { id: 't2', isHomeTeam: false }] },
      { id: 'game-one', status: 'FINAL', type: 'oneDay', schedule: [{ day: null, dateTime: '2026-10-24T02:30:00.000Z', playingSurfaceId: 'ps1' }],
        teams: [{ id: 't2', isHomeTeam: true }, { id: 't1', isHomeTeam: false }] },
      { id: 'final-undrawn', status: 'PENDING', type: 'twoDay', schedule: [], teams: [] },
    ] },
  ],
  teams: [{ id: 't1', name: 'Baulkham Hills A' }, { id: 't2', name: 'Kings Langley' }],
  playingSurfaces: [{ id: 'ps1', name: 'Oval 2', latitude: -33.77, longitude: 151.04,
    venue: { id: 'v1', name: 'Ted Horwood Reserve', timezone: 'Australia/Sydney', address: { line1: 'Moseley St', suburb: 'CARLINGFORD' } } }],
};

test('localStamp converts UTC to the ground\'s local time, summer and winter', () => {
  assert.equal(localStamp('2026-10-24T02:30:00.000Z', 'Australia/Sydney'), '2026-10-24T13:30:00.0000000+11:00');
  assert.equal(localStamp('2026-07-04T03:30:00.000Z', 'Australia/Sydney'), '2026-07-04T13:30:00.0000000+10:00');
  assert.equal(localStamp('2026-10-24T14:30:00.000Z', 'Australia/Sydney').slice(0, 10), '2026-10-25');   // crosses midnight
  assert.equal(localStamp('2026-10-24T02:30:00.000Z', 'Not/AZone'), '2026-10-24T13:30:00.0000000+11:00');
  assert.equal(localStamp('nonsense', 'Australia/Sydney'), null);
});

test('seasons with the same name are one season holding several competitions; the active one comes first', () => {
  const g = groupSeasons(seasons);
  assert.deepEqual(g.map(x => x.id), ['summer-2026-27', 'winter-2026']);
  assert.equal(g[0].members.length, 2);
  assert.equal(g[0].current, true);
  assert.equal(g[1].current, false);
  assert.deepEqual(legacySeasons(g).seasons[0], { id: 'summer-2026-27', name: 'Summer 2026/27', isCurrentSeason: true, startDate: '2026-08-02T00:00:00Z' });
  assert.equal(groupSeasons([{ id: 'x', name: 2021 }])[0].id, '2021');          // PlayHQ can send a number
});

test('competitions carry their grades, with ids that name the season they belong to', async () => {
  const phq = { grades: async id => (id === S_SEN ? [{ id: G_A, name: 'Senior A Grade' }] : [{ id: G_B, name: 'U12 Gold' }]) };
  const r = await legacyCompetitions(groupSeasons(seasons)[0], phq);
  assert.deepEqual(r.competitionSeasons.map(c => c.competition.name), ['PDCA Senior Competition', 'PDCA Junior Competition']);
  assert.equal(r.competitionSeasons[0].grades[0].id, `${S_SEN}.${G_A}`);
});

test('games come out in the shape the app already reads: format, both days, local times, ground, teams', () => {
  const { matches } = legacyMatches(v2);
  assert.equal(matches.length, 2);                                               // the undrawn final is left out
  const two = normaliseMatch(matches[0], { id: 'g', name: 'Senior A Grade' }, { id: 'c', name: 'PDCA Senior Competition' });
  assert.deepEqual(two.days, [{ day: 1, date: '2026-10-24', time: '13:30' }, { day: 2, date: '2026-10-31', time: '13:30' }]);
  assert.equal(two.matchType, 'Two Day');
  assert.equal(two.status, 'UPCOMING');
  assert.equal(two.roundName, 'Round 3');
  assert.equal(two.home.name, 'Baulkham Hills A');
  assert.equal(two.away.name, 'Kings Langley');
  assert.equal(two.ground, 'Ted Horwood Reserve – Oval 2');
  assert.equal(two.address, 'Moseley St, CARLINGFORD');
  assert.equal(two.lat, -33.77);
  const one = normaliseMatch(matches[1], { id: 'g', name: 'Senior A Grade' }, { id: 'c', name: 'x' });
  assert.equal(one.matchType, 'One Day');
  assert.equal(one.status, 'COMPLETED');
  assert.deepEqual(one.days, [{ day: 1, date: '2026-10-24', time: '13:30' }]);
  assert.equal(one.home.name, 'Kings Langley');
  assert.equal(matchTypeOf('t20'), 'T20');
});

const phqFake = (calls = []) => ({
  seasons: async id => { calls.push(['seasons', id]); if (id !== ORG) throw new PhqError('none', 404); return seasons; },
  grades: async id => { calls.push(['grades', id]); return [{ id: G_A, name: 'Senior A Grade' }]; },
  games: async id => { calls.push(['games', id]); return v2; },
});

test('check: names the organisation, refuses an unknown one', async () => {
  const ok = await run('check', {}, phqFake(), ORG);
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'Parramatta District Cricket Association');
  assert.deepEqual(ok.current, ['Summer 2026/27']);
  const bad = await run('check', {}, phqFake(), U(99));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no organisation/);
});

test('matches: only grades of this association\'s seasons can be read', async () => {
  const calls = [];
  const r = await run('matches', { gradeId: `${S_SEN}.${G_A}` }, phqFake(calls), ORG);
  assert.equal(r.matches.length, 2);
  await assert.rejects(run('matches', { gradeId: `${U(77)}.${G_A}` }, phqFake(), ORG), /not in this association/);   // another association's season
  await assert.rejects(run('matches', { gradeId: `${S_SEN}.${U(78)}` }, phqFake(), ORG), /not in this association/);   // a grade that is not in it
  await assert.rejects(run('matches', { gradeId: '../../etc' }, phqFake(), ORG), /not valid/);
  await assert.rejects(run('nope', {}, phqFake(), ORG), /Unknown/);
});

test('the PlayHQ client sends the key as headers, follows pages, retries a busy server, and caches', async () => {
  const seen = [];
  const pages = { undefined: { data: [{ id: 'a' }], metadata: { hasMore: true, nextCursor: 'c2' } }, c2: { data: [{ id: 'b' }], metadata: { hasMore: false } } };
  let busy = 1;
  const fetchFn = async (url, init) => {
    seen.push([url, init.headers]);
    if (busy-- > 0) return { ok: false, status: 429 };
    const cursor = new URL(url).searchParams.get('cursor') || undefined;
    return { ok: true, status: 200, json: async () => pages[cursor] };
  };
  const c = makePhq({ key: 'K', tenant: 'ca', fetchFn });
  assert.deepEqual((await c.grades(S_SEN)).map(x => x.id), ['a', 'b']);
  assert.equal(seen[0][0], `https://api.playhq.com/v1/seasons/${S_SEN}/grades`);
  assert.equal(seen[0][1]['x-api-key'], 'K');
  assert.equal(seen[0][1]['x-phq-tenant'], 'ca');
  assert.match(seen[2][0], /cursor=c2/);
  const n = seen.length;
  const cc = cachedPhq(c);
  await cc.grades(S_SEN); await cc.grades(S_SEN);
  assert.equal(seen.length, n + 2);                                              // two pages once, the second call came from memory
  const denied = makePhq({ key: 'bad', fetchFn: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(denied.seasons(ORG), /did not accept the key/);
  assert.ok(isUuid(ORG) && !isUuid('x'));
});

test('the app\'s fixture api asks the store, with the grade id intact', async () => {
  const asked = [];
  const store = { playhq: async (a, p) => { asked.push([a, p]); return a === 'matchesMany' ? { grades: Object.fromEntries(p.gradeIds.map(id => [id, legacyMatches(v2)])) } : { seasons: [] }; } };
  const api = makePlayhqApi(store);
  await api('/fixturesladders/organisations/abc/seasons');
  await api('/fixturesladders/organisations/abc/competition-seasons?seasonId=summer-2026-27&responseModifier=includeGrades');
  const games = await loadFixtures({ api, comps: [{ id: 'c', name: 'PDCA Senior Competition', grades: [{ id: `${S_SEN}.${G_A}`, name: 'Senior A Grade' }] }], from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(asked.map(a => a[0]), ['seasons', 'competitions', 'matchesMany']);
  assert.equal(asked[1][1].seasonId, 'summer-2026-27');
  assert.deepEqual(asked[2][1].gradeIds, [`${S_SEN}.${G_A}`]);
  assert.equal(games.length, 2);
  assert.equal(fixtureApi({}, { apiBase: 'https://x', fetchFn: async () => ({}) }).name, 'api');          // demo mode: the old service
  await assert.rejects(api('/something/else'), /Unsupported/);
});

test('matchesMany: all grades in one request, checked once, and nothing foreign gets through', async () => {
  const calls = [];
  const fake = phqFake(calls);
  fake.grades = async id => { calls.push(['grades', id]); return [{ id: G_A }, { id: G_B }]; };
  const r = await run('matchesMany', { gradeIds: [`${S_SEN}.${G_A}`, `${S_SEN}.${G_B}`, `${S_SEN}.${G_A}`] }, fake, ORG);
  assert.deepEqual(Object.keys(r.grades).sort(), [`${S_SEN}.${G_A}`, `${S_SEN}.${G_B}`].sort());
  assert.equal(calls.filter(c => c[0] === 'seasons').length, 1);     // ownership checked once, not per grade
  assert.equal(calls.filter(c => c[0] === 'grades').length, 1);
  assert.equal(calls.filter(c => c[0] === 'games').length, 2);       // duplicates dropped
  await assert.rejects(run('matchesMany', { gradeIds: [`${S_SEN}.${G_A}`, `${U(77)}.${G_A}`] }, phqFake(), ORG), /not in this association/);
  await assert.rejects(run('matchesMany', { gradeIds: [`${S_SEN}.${U(78)}`] }, phqFake(), ORG), /not in this association/);
  await assert.rejects(run('matchesMany', { gradeIds: [] }, phqFake(), ORG), /not valid/);
  await assert.rejects(run('matchesMany', { gradeIds: ['x'] }, phqFake(), ORG), /not valid/);
});
