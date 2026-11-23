import test from 'node:test';
import './pdca-groups.mjs';
import assert from 'node:assert/strict';
import { roundWindows, roundSets, visibleRounds, nextRoundWindow, majorityRound, currentRound, needsSync, saveSeasonAndRounds, applyFresh, defaultSlotsFn, STALE_MS, SCHEMA } from '../js/rounds.js';
import { summarise, isPicked } from '../js/logic.js';

const SEN = 'PDCA Senior Competition', JUN = 'PDCA Junior Competition', T20 = 'PDCA T20 Competition';
const game = (id, comp, grade, days, roundName = 'Round 5', extra = {}) => ({
  id, comp, grade, roundName, matchType: days.length > 1 ? 'Two Day' : 'One Day',
  days: days.map((date, i) => ({ day: i + 1, date, time: '' })),
  home: { name: 'H' + id, org: '' }, away: { name: 'A' + id, org: '' }, ground: 'G', address: '', lat: null, lng: null, ...extra,
});

function fakeStore() {
  const db = { rounds: {}, games: {}, settings: {}, season: null };
  return {
    db,
    async listRounds() { return Object.values(db.rounds); },
    async getRound(id) { return db.rounds[id] || null; },
    async saveRound(r) { db.rounds[r.id] = { ...(db.rounds[r.id] || {}), ...r }; },
    async listGames(rid) { return Object.values(db.games[rid] || {}); },
    async saveGames(rid, list) { const m = (db.games[rid] ||= {}); for (const g of list) m[g.id] = structuredClone(g); },
    async getSettings() { return db.settings; },
    async saveSettings(s) { db.settings = { ...db.settings, ...s }; },
    async getSeason() { return db.season; },
    async saveSeason(s) { db.season = s; },
  };
}

test('nextRoundWindow: the calendar week (Monday to Sunday) of the earliest game that has not finished', () => {
  const games = [
    game('1', SEN, 'Senior A Grade', ['2026-11-14', '2026-11-15'], 'Round 4'),   // finished
    game('2', SEN, 'Senior A Grade', ['2026-11-21', '2026-11-22']),
    game('3', SEN, 'Senior B02', ['2026-11-21', '2026-11-22']),
    game('4', SEN, 'Senior A Grade', ['2026-11-28', '2026-11-29'], 'Round 6'),
  ];
  const w = nextRoundWindow(games, '2026-11-16');
  assert.equal(w.from, '2026-11-16');
  assert.equal(w.to, '2026-11-22');
  assert.deepEqual(w.games.map(g => g.id), ['2', '3']);
});

test('nextRoundWindow: a two-day game still in progress today is part of the current round; nothing left -> null', () => {
  const games = [game('1', SEN, 'Senior A Grade', ['2026-11-21', '2026-11-22']), game('2', SEN, 'Senior A Grade', ['2026-11-28', '2026-11-29'], 'Round 6')];
  assert.equal(nextRoundWindow(games, '2026-11-22').games[0].id, '1');     // Sunday: day 2 of round 5
  assert.equal(nextRoundWindow(games, '2026-11-23').games[0].id, '2');
  assert.equal(nextRoundWindow(games, '2027-01-01'), null);
});

test('nextRoundWindow: removed games are ignored; juniors with different round numbers share one week', () => {
  const games = [
    game('1', JUN, 'U14 Blue', ['2026-11-21', '2026-11-22'], 'Round 3'),
    game('2', JUN, 'U13 Gold', ['2026-11-22'], 'Round 4'),
    game('3', JUN, 'U12 Red', ['2026-11-21'], 'Round 3', { removed: true }),
    game('4', JUN, 'U14 Blue', ['2026-11-28'], 'Round 5'),
  ];
  const w = nextRoundWindow(games, '2026-11-16');
  assert.deepEqual(w.games.map(g => g.id).sort(), ['1', '2']);
  assert.equal(majorityRound(w.games), 'Round 3');   // tie -> the lower round number
});

test('currentRound picks a competition\'s earliest unfinished round; needsSync reasons', () => {
  const rounds = [
    { id: 'senior-2026-11-07', comp: 'senior', source: { from: '2026-11-07' }, start: '2026-11-07', end: '2026-11-08' },
    { id: 'senior-2026-11-21', comp: 'senior', source: { from: '2026-11-21' }, start: '2026-11-21', end: '2026-11-22' },
    { id: 'junior-2026-11-21', comp: 'junior', source: { from: '2026-11-21' }, start: '2026-11-21', end: '2026-11-22' },
    { id: 'k3Xr9aQ', comp: 'senior', source: { from: '2026-11-14' }, start: '2026-11-14', end: '2026-11-15' },   // built by an earlier version
  ];
  assert.equal(currentRound(rounds, 'senior', '2026-11-16').id, 'senior-2026-11-21');
  assert.equal(currentRound(rounds, 'senior', '2026-11-10').id, 'senior-2026-11-21', 'a round from an older version is ignored');
  assert.equal(currentRound(rounds, 't20', '2026-11-16'), null);
  const fresh = { calendar: [{ comp: 'senior', dates: ['2026-11-21'] }], schema: SCHEMA, updatedAt: new Date().toISOString() };
  assert.equal(needsSync({ ...fresh, schema: undefined }, rounds, '2026-11-16', Date.now()), true);   // saved by an older version: rebuild
  const now = Date.now();
  assert.equal(needsSync(null, rounds, '2026-11-16', now), true);                                        // never synced
  assert.equal(needsSync(fresh, rounds, '2026-11-16', now), false);
  assert.equal(needsSync(fresh, rounds, '2026-11-16', now, { name: 'x' }), true);                       // grade list from PlayHQ not saved yet
  assert.equal(needsSync(fresh, rounds, '2026-11-16', now, { gradeComps: {} }), false);
  assert.equal(needsSync(fresh, rounds, '2026-11-16', now + STALE_MS + 1000), true);                     // stale
  assert.equal(needsSync({ ...fresh, calendar: [{ comp: 't20', dates: ['2026-11-21'] }] }, rounds, '2026-11-16', now), true); // T20 has dates but no round
  assert.equal(needsSync({ ...fresh, calendar: [{ comp: 't20', dates: ['2026-10-01'] }] }, rounds, '2026-11-16', now), false); // T20 finished
});

test('saveSeasonAndRounds creates one next round per competition, with nothing picked the first time', async () => {
  const store = fakeStore();
  const games = [
    game('s1', SEN, 'Senior A Grade', ['2026-11-21', '2026-11-22']),
    game('s2', SEN, 'Senior B02', ['2026-11-21', '2026-11-22']),
    game('t1', T20, 'T20 Mens', ['2026-11-22'], 'Round 1'),
    game('j1', JUN, 'U14 Blue', ['2026-11-21'], 'Round 3'),
    game('j2', JUN, 'U13 Gold', ['2026-11-22'], 'Round 3'),
  ];
  const made = await saveSeasonAndRounds(store, { season: { id: 's', name: 'Summer' }, games, comps: [{ id: 'c1', name: SEN }, { id: 'c2', name: JUN }], today: '2026-11-16' });
  assert.deepEqual(made.sort(), ['junior-2026-11-16', 'senior-2026-11-16', 't20-2026-11-16']);
  const sen = store.db.rounds['senior-2026-11-16'];
  assert.deepEqual([sen.comp, sen.title, sen.start, sen.end, sen.picked, sen.stats.needed], ['senior', 'Round 5', '2026-11-21', '2026-11-22', 0, 0]);
  assert.deepEqual(sen.source.comps, ['c1']);
  assert.equal(store.db.season.calendar.length > 0, true);
  assert.equal((await store.listGames('senior-2026-11-16')).every(g => g.slots === 0), true);
});

test('picking grades drives the slot total: 5 grades x 3 games = 15 slots', () => {
  const games = [];
  for (const gr of ['Senior A Grade', 'Senior A Reserve', 'Senior B01', 'Senior B02', 'Senior B03', 'Senior B04'])
    for (let i = 0; i < 3; i++) games.push(game(gr + i, SEN, gr, ['2026-11-21'], 'Round 5', { slots: gr === 'Senior B04' ? 0 : 1 }));
  const s = summarise(games);
  assert.equal(s.picked, 5);
  assert.equal(s.stats.needed, 15);
  assert.equal(games.filter(isPicked).length, 15);
});

test('the next round remembers the grades ticked last time, and applyFresh keeps allocations and flags changes', async () => {
  const store = fakeStore();
  await store.saveSettings({ slotsByGrade: { 'Senior A Grade': 1, 'Senior B02': 2, 'Senior B03': 0 } });
  const g1 = game('s1', SEN, 'Senior A Grade', ['2026-11-21']), g2 = game('s2', SEN, 'Senior B02', ['2026-11-21']), g3 = game('s3', SEN, 'Senior B03', ['2026-11-21']);
  await saveSeasonAndRounds(store, { season: { id: 's', name: 'S' }, games: [g1, g2, g3], today: '2026-11-16' });
  const id = 'senior-2026-11-16';
  assert.deepEqual((await store.listGames(id)).map(g => [g.grade, g.slots]).sort(), [['Senior A Grade', 1], ['Senior B02', 2], ['Senior B03', 0]]);

  // officer allocates someone, then the ground changes and a new game appears
  const stored = await store.listGames(id);
  await store.saveGames(id, stored.map(g => g.id === 's1' ? { ...g, alloc: { '2026-11-21': [{ p: 'u1', n: 'Ann' }] } } : g));
  const fresh = [{ ...g1, ground: 'New Oval' }, g2, g3, game('s4', SEN, 'Senior A Grade', ['2026-11-21'])];
  const res = await applyFresh(store, await store.getRound(id), fresh, await store.getSettings());
  assert.deepEqual([res.added, res.changed, res.removed], [1, 1, 0]);
  const after = Object.fromEntries((await store.listGames(id)).map(g => [g.id, g]));
  assert.equal(after.s1.alloc['2026-11-21'][0].p, 'u1');            // allocation kept
  assert.match(after.s1.changeNote, /New Oval/);
  assert.equal(after.s4.slots, 1);                                    // new game in a grade ticked before
  assert.equal(store.db.rounds[id].picked, 2);
  assert.equal(defaultSlotsFn({}) (g1), 0);
});

test('juniors sort oldest age group first; seniors keep A, Ar, B1...', async () => {
  const { compareGrades } = await import('../js/logic.js');
  const j = ['U10 Blue North', 'U17 Division 2', 'U12 Division 1', 'U15 Division 1', 'U17 Division 1', 'U12 Girls Stage 1'];
  assert.deepEqual(j.sort(compareGrades), ['U17 Division 1', 'U17 Division 2', 'U15 Division 1', 'U12 Division 1', 'U12 Girls Stage 1', 'U10 Blue North']);
  assert.deepEqual(['Senior B02', 'Senior Women', 'Senior A Reserve', 'Senior A Grade', 'Senior B01'].sort(compareGrades), ['Senior A Grade', 'Senior A Reserve', 'Senior B01', 'Senior B02', 'Senior Women']);
});

test('round title follows the picked grades; a grade on another round is listed beside it', () => {
  const g = (id, grade, roundName, slots) => ({ id, grade, roundName, slots, days: [{ date: '2026-11-21' }], alloc: {} });
  const games = [g('1', 'Senior A Grade', 'Round 5', 0), g('2', 'Senior B01', 'Round 5', 0), g('3', 'Senior Women', 'Round 4', 0)];
  assert.equal(summarise(games).title, 'Round 5');
  assert.equal(summarise(games).other, 'Women: Round 4');                      // nothing picked: all grades considered
  games[0].slots = 1; games[1].slots = 1;
  assert.equal(summarise(games).other, '');                                    // Women not picked: the tile is simply Round 5
  games[2].slots = 1;
  assert.equal(summarise(games).title, 'Round 5');
  assert.equal(summarise(games).other, 'Women: Round 4');
  games[0].slots = 0; games[1].slots = 0;
  assert.equal(summarise(games).title, 'Round 4');                             // only Women picked: Round 4
});

test('tile format line uses the competition\'s own match types', async () => {
  const { formatSummary } = await import('../js/logic.js');
  const G = (matchType, slots = 0) => ({ id: matchType + slots, grade: matchType, roundName: 'Round 1', matchType, slots, days: [{ date: '2026-11-21' }], alloc: {} });
  assert.equal(formatSummary([G('Two Day'), G('Two Day')]), 'Two Day');
  assert.equal(formatSummary([G('T20')]), 'T20');
  assert.equal(formatSummary([G('Two Day'), G('One Day')]), 'One Day & Two Day');
  assert.equal(formatSummary([{ days: [] }]), '');
  assert.equal(summarise([G('One Day'), G('Two Day')]).formats, 'One Day & Two Day');          // nothing picked: all games
  assert.equal(summarise([G('One Day'), G('Two Day', 1)]).formats, 'Two Day');                  // only the picked grades count
});

test('roundWindows: a two-day game belongs to the week it starts; the one-day games on its second Saturday are the next week', () => {
  const G = (id, days) => ({ id, grade: 'g' + id, roundName: 'Round 1', matchType: days.length > 1 ? 'Two Day' : 'One Day', days: days.map(date => ({ date })) });
  const games = [G('m', ['2026-11-21', '2026-11-28']), G('w', ['2026-11-28']), G('m2', ['2026-12-05', '2026-12-12'])];
  const w = roundWindows(games, '2026-11-16');
  assert.deepEqual(w.map(x => x.from), ['2026-11-16', '2026-11-23', '2026-11-30']);
  assert.deepEqual(w.map(x => x.games.map(g => g.id)), [['m'], ['w'], ['m2']]);
  assert.equal(roundWindows(games, '2026-11-16', 2).length, 2);
  assert.equal(roundWindows(games, '2026-12-20').length, 0);
});

test('roundWindows: Friday night, Saturday and Sunday games are one week; a week can start on another day', () => {
  const G = (id, date) => ({ id, grade: 'g', roundName: 'R', matchType: 'T20', days: [{ date }] });
  const games = [G('fri', '2026-11-20'), G('sat', '2026-11-21'), G('sun', '2026-11-22'), G('nextfri', '2026-11-27')];
  assert.deepEqual(roundWindows(games, '2026-11-16').map(x => x.games.map(g => g.id)), [['fri', 'sat', 'sun'], ['nextfri']]);
  // weeks starting on Saturday: Friday belongs to the week before
  assert.deepEqual(roundWindows(games, '2026-11-16', 12, 6).map(x => x.games.map(g => g.id)), [['fri'], ['sat', 'sun', 'nextfri']]);
});

test('visibleRounds: one set per week, in group order; enough weeks show for every group; Load more adds a week', () => {
  const R = (comp, start, end = start) => ({ id: `${comp}-${start}`, comp, start, end, dates: [...new Set([start, end])] });
  const rounds = [
    R('senior', '2026-11-21', '2026-11-28'), R('t20', '2026-11-22'), R('junior', '2026-11-21'),
    R('senior', '2026-11-28'), R('t20', '2026-11-29'),
    R('senior', '2026-12-05', '2026-12-12'), R('junior', '2026-12-05'),
  ];
  const sets = roundSets(rounds, '2026-11-16');
  assert.deepEqual(sets.map(x => x.week), ['2026-11-16', '2026-11-23', '2026-11-30']);
  assert.deepEqual(sets[0].map(r => r.id), ['senior-2026-11-21', 'junior-2026-11-21', 't20-2026-11-22'], 'Senior, Junior, T20');
  const v0 = visibleRounds(rounds, '2026-11-16');
  assert.equal(v0.sets.length, 1, 'every group plays in the first week');
  assert.equal(v0.hasMore, true);
  assert.equal(visibleRounds(rounds, '2026-11-16', 2).hasMore, false);
  assert.deepEqual(visibleRounds([], '2026-11-16'), { sets: [], hasMore: false });
});

test('weeks on the real PDCA fixtures (16 Nov 2026): no tile ever spans two weeks', () => {
  const real = [['senior', '2026-11-21', '2026-11-21'], ['senior', '2026-11-28', '2026-11-28'], ['senior', '2026-12-05', '2026-12-12'], ['senior', '2026-12-12', '2026-12-12'], ['senior', '2027-01-09', '2027-01-09'],
    ['junior', '2026-11-21', '2026-11-21'], ['junior', '2026-11-28', '2026-12-05'], ['junior', '2026-12-05', '2026-12-05'], ['junior', '2026-12-12', '2026-12-12'],
    ['t20', '2026-11-22', '2026-11-22'], ['t20', '2026-11-29', '2026-11-29'], ['t20', '2026-12-06', '2026-12-06'], ['t20', '2026-12-13', '2026-12-13']]
    .map(([comp, start, end]) => ({ id: `${comp}-${start}`, comp, start, end, dates: [...new Set([start, end])] }));
  const ids = roundSets(real, '2026-11-16').map(set => set.map(r => r.id));
  assert.deepEqual(ids, [
    ['senior-2026-11-21', 'junior-2026-11-21', 't20-2026-11-22'],
    ['senior-2026-11-28', 'junior-2026-11-28', 't20-2026-11-29'],       // the Junior two-day game continues on 5 Dec: shown there as continuing
    ['senior-2026-12-05', 'junior-2026-12-05', 't20-2026-12-06'],
    ['senior-2026-12-12', 'junior-2026-12-12', 't20-2026-12-13'],
    ['senior-2027-01-09'],
  ]);
});

test('custom groups: grades are allocated in the groups the association chose', async () => {
  const { setGroups, compKeyOf, COMPS, umpiresForGrade, suggestUmpires } = await import('../js/logic.js');
  try {
    setGroups({ groups: [{ key: 'sat', name: 'Saturday Seniors' }, { key: 'girls', name: 'Friday Girls' }, { key: 'jun', name: 'Juniors' }],
      gradeGroups: { '.1st Grade': 'sat', 'Girls League': 'girls', 'U13 - 1': 'jun' }, gradeUmpires: { 'U10 - 1': 0 } });
    assert.deepEqual(COMPS.map(c => c.label), ['Saturday Seniors', 'Friday Girls', 'Juniors']);
    assert.equal(compKeyOf({ grade: 'Girls League', comp: 'BCDCA - GIRL\'S LEAGUE' }), 'girls');
    assert.equal(compKeyOf({ grade: 'Unknown', comp: 'Something' }), 'sat', 'a grade not set yet goes to the first group');
    assert.equal(umpiresForGrade('U10 - 1'), 0);
    assert.equal(umpiresForGrade('U13 - 1'), undefined);
    const store = fakeStore();
    const made = await saveSeasonAndRounds(store, { season: { id: 's', name: 'S' }, today: '2026-11-16', games: [
      game('g1', 'BCDCA - GIRL\'S LEAGUE', 'Girls League', ['2026-11-20']),
      game('s1', 'BCDCA - Senior Competition', '.1st Grade', ['2026-11-21']),
      game('j1', 'BCDCA - Junior Competition', 'U13 - 1', ['2026-11-21']),
    ] });
    assert.deepEqual(made.sort(), ['girls-2026-11-16', 'jun-2026-11-16', 'sat-2026-11-16']);
  } finally { (await import('./pdca-groups.mjs')).usePdcaGroups(); }
  assert.deepEqual([suggestUmpires('U10 - 1'), suggestUmpires('Cricket Blast Competition'), suggestUmpires('U15 - 2'), suggestUmpires('.1st Grade')], [0, 0, 1, 1]);
});

test('moving a grade to another group takes its upcoming games out of the old group\'s round', async () => {
  const { setGroups } = await import('../js/logic.js');
  const store = fakeStore();
  const games = [game('a', SEN, 'Senior A Grade', ['2026-11-21']), game('w', SEN, 'Senior Women', ['2026-11-21'])];
  try {
    await saveSeasonAndRounds(store, { season: { id: 's', name: 'S' }, games, today: '2026-11-16' });
    setGroups({ groups: [{ key: 'senior', name: 'Senior' }, { key: 'women', name: 'Women' }], gradeGroups: { 'Senior Women': 'women' } });
    await saveSeasonAndRounds(store, { season: { id: 's', name: 'S' }, games, today: '2026-11-16' });
    const old = await store.listGames('senior-2026-11-16');
    assert.equal(old.find(g => g.id === 'w').removed, true);
    assert.ok(!old.find(g => g.id === 'a').removed);
    assert.deepEqual((await store.listGames('women-2026-11-16')).map(g => g.id), ['w']);
  } finally { (await import('./pdca-groups.mjs')).usePdcaGroups(); }
});

test('association helpers: PlayHQ id from a link, association id', async () => {
  globalThis.location ||= { origin: 'https://x.test', pathname: '/app/' };
  const { playhqIdFrom, orgIdFrom } = await import('../js/views-org.js');
  assert.equal(playhqIdFrom('https://www.playhq.com/cricket-australia/org/parramatta-district-cricket-association/EE7D89D9-6732-ec11-981f-501ac52e1666?tab=grades'), 'ee7d89d9-6732-ec11-981f-501ac52e1666');
  assert.equal(playhqIdFrom('ee7d89d9-6732-ec11-981f-501ac52e1666'), 'ee7d89d9-6732-ec11-981f-501ac52e1666');
  assert.equal(playhqIdFrom('https://www.playhq.com/'), '');
  assert.equal(orgIdFrom('Hills District Cricket Assoc.!', () => 0), 'hills-district-cricket-assoc-0000');
  assert.match(orgIdFrom(''), /^association-[0-9a-z]{4}$/);
});

test('member names: two fields, with a fallback for records that only have a full name', async () => {
  const { nameParts, fullName, compareMembers } = await import('../js/logic.js');
  assert.deepEqual(nameParts({ firstName: 'Jane', lastName: 'Smith', name: 'ignored' }), { firstName: 'Jane', lastName: 'Smith' });
  assert.deepEqual(nameParts({ name: 'Jane Van Der Berg' }), { firstName: 'Jane', lastName: 'Van Der Berg' });
  assert.deepEqual(nameParts({ name: 'Cher' }), { firstName: 'Cher', lastName: '' });
  assert.deepEqual(nameParts({}), { firstName: '', lastName: '' });
  assert.deepEqual(nameParts({ firstName: '', lastName: 'Smith' }), { firstName: '', lastName: 'Smith' });
  assert.equal(fullName(' Jane ', 'Smith'), 'Jane Smith');
  assert.equal(fullName('Jane', ''), 'Jane');
  const list = [{ name: 'Zoe Adams' }, { firstName: 'Al', lastName: 'Zane' }, { firstName: 'Bea', lastName: 'Adams' }];
  assert.deepEqual(list.sort(compareMembers).map(u => fullName(...Object.values(nameParts(u)))), ['Bea Adams', 'Zoe Adams', 'Al Zane']);
});

test('membership: a renewal day and month, types and fees', async () => {
  globalThis.location ||= { origin: 'https://x.test', pathname: '/app/' };
  const { renewalOf, renewalText, daysInMonth, membershipTypes, feeFor, money } = await import('../js/views-org.js');
  assert.equal(renewalOf({ membership: { renewalDay: '06-30' } }), '06-30');
  assert.equal(renewalOf({ membership: { renewalDate: '2027-06-30' } }), '06-30', 'a full date saved by an older version still reads');
  assert.equal(renewalOf({}), '');
  assert.equal(renewalText({ membership: { renewalDay: '09-01' } }), '1 September each year');
  assert.equal(renewalText({ membership: { renewalDay: '' } }), '');
  assert.equal(daysInMonth('02'), 29);
  assert.equal(daysInMonth('09'), 30);
  const org = { membership: { types: [{ name: 'Ordinary member', fee: 60 }, { name: '', fee: 5 }, { name: 'Life member', fee: 0 }] } };
  assert.deepEqual(membershipTypes(org).map(t => t.name), ['Ordinary member', 'Life member'], 'a blank row is not a type');
  assert.equal(feeFor(org, 'Ordinary member'), 60);
  assert.equal(feeFor(org, 'Nobody'), null);
  assert.equal(money(60), '$60');
  assert.equal(money(12.5), '$12.50');
  assert.equal(money(null), '');
});

test('publish state: never published, published, changed since publishing', async () => {
  const { publishState, fmtWhen } = await import('../js/logic.js');
  assert.deepEqual(publishState({}), { key: 'never', cls: '', label: 'Not published yet', short: 'Not published' });
  const live = publishState({ published: true, publishedAt: '2026-11-16T02:14:00Z' });
  assert.equal(live.key, 'live');
  assert.match(live.label, /^Published /);
  assert.equal(live.short, 'Published');
  assert.equal(publishState({ published: true, publishedAt: '2026-11-16T02:14:00Z', changedAt: '2026-11-16T01:00:00Z' }).key, 'live', 'a change before publishing does not count');
  const stale = publishState({ published: true, publishedAt: '2026-11-16T02:14:00Z', changedAt: '2026-11-16T03:00:00Z' });
  assert.equal(stale.key, 'stale');
  assert.equal(stale.short, 'Changes to publish');
  assert.equal(publishState({ published: false, publishedAt: '2026-11-16T02:14:00Z' }).short, 'Unpublished');
  assert.equal(fmtWhen('not a date'), '');
  assert.match(fmtWhen('2026-11-16T02:14:00Z'), /, 16 Nov$/);
});

test('every week left in the season gets its round, however long the season', async () => {
  const store = fakeStore();
  const games = [];
  for (let i = 0; i < 20; i++) {           // 20 Saturdays from 21 Nov to early April
    const d = new Date(Date.UTC(2026, 10, 21 + 7 * i)).toISOString().slice(0, 10);
    games.push(game('s' + i, SEN, 'Senior A Grade', [d]));
  }
  const made = await saveSeasonAndRounds(store, { season: { id: 's', name: 'S' }, games, today: '2026-11-16' });
  assert.equal(made.length, 20);
  assert.ok(made.includes('senior-2027-03-29'), 'the last week of the season is there too');
});

test('groups follow the fixtures: suggested the first time, new grades placed, empty groups removed', async () => {
  const { ensureGroups } = await import('../js/rounds.js');
  const { setGroups } = await import('../js/logic.js');
  const store = { org: { id: 'x', name: 'Sydney Shires Competition' }, async saveOrg(p) { Object.assign(this.org, structuredClone(p)); } };
  try {
    await ensureGroups(store, [game('1', 'Sydney Shires Competition', 'First Grade (The RB Clark Cup)', ['2026-11-21']), game('2', "Frank Gray Shield (U24's)", "Frank Gray Shield (U24's)", ['2026-11-22'])]);
    assert.deepEqual(store.org.groups.map(g => g.name), ['Shires', 'Frank Gray']);
    assert.equal(store.org.gradeUmpires["Frank Gray Shield (U24's)"], 1);
    const shires = store.org.groups[0].key;
    // a new grade arrives in a competition; Frank Gray finishes
    await ensureGroups(store, [game('1', 'Sydney Shires Competition', 'First Grade (The RB Clark Cup)', ['2026-11-21']), game('3', 'Sydney Shires Competition', 'Second Grade', ['2026-11-21'])]);
    assert.deepEqual(store.org.groups.map(g => g.name), ['Shires'], 'the new grade joins its competition\'s group; the empty Frank Gray group goes');
    assert.equal(store.org.gradeGroups['Second Grade'], shires);
    assert.equal(store.org.gradeGroups['First Grade (The RB Clark Cup)'], shires, 'existing grades stay in their competition\'s group');
    // a grade PlayHQ now lists under another competition moves to that competition's group
    await ensureGroups(store, [game('1', 'Sydney Shires Competition', 'First Grade (The RB Clark Cup)', ['2026-11-21']), game('3', "Frank Gray Shield (U24's)", 'Second Grade', ['2026-11-21'])]);
    assert.notEqual(store.org.gradeGroups['Second Grade'], store.org.gradeGroups['First Grade (The RB Clark Cup)']);
    // Settings lists exactly what PlayHQ lists now: a competition that is gone leaves no grade behind
    assert.deepEqual(store.org.gradeComps, { 'First Grade (The RB Clark Cup)': 'Sydney Shires Competition', 'Second Grade': "Frank Gray Shield (U24's)" });
    // a different association's fixtures entirely: the old groups go, new ones are suggested
    store.org.name = 'Parramatta District Cricket Association';
    await ensureGroups(store, [game('9', 'PDCA Senior Competition', 'Senior A Grade', ['2026-11-21'])]);
    assert.deepEqual(store.org.groups.map(g => g.name), ['Senior']);
  } finally { (await import('./pdca-groups.mjs')).usePdcaGroups(); }
});

test('rounds of a group that was removed are not shown', async () => {
  const { upcomingRounds } = await import('../js/rounds.js');
  const { setGroups } = await import('../js/logic.js');
  setGroups({ groups: [{ key: 'shires', name: 'Shires' }] });
  const rounds = [
    { id: 'senior-2026-11-23', comp: 'senior', start: '2026-11-28', end: '2026-11-29' },
    { id: 'shires-2026-11-23', comp: 'shires', start: '2026-11-28', end: '2026-11-28' },
  ];
  assert.deepEqual(upcomingRounds(rounds, '2026-11-18').map(r => r.id), ['shires-2026-11-23']);
  (await import('./pdca-groups.mjs')).usePdcaGroups();
});
