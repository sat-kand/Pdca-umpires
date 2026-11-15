import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRoundWindow, majorityRound, currentRound, needsSync, saveSeasonAndRounds, applyFresh, defaultSlotsFn, STALE_MS } from '../js/rounds.js';
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

test('nextRoundWindow: the week starting at the earliest game that has not finished', () => {
  const games = [
    game('1', SEN, 'Senior A Grade', ['2026-11-14', '2026-11-15'], 'Round 4'),   // finished
    game('2', SEN, 'Senior A Grade', ['2026-11-21', '2026-11-22']),
    game('3', SEN, 'Senior B02', ['2026-11-21', '2026-11-22']),
    game('4', SEN, 'Senior A Grade', ['2026-11-28', '2026-11-29'], 'Round 6'),
  ];
  const w = nextRoundWindow(games, '2026-11-16');
  assert.equal(w.from, '2026-11-21');
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
  const fresh = { calendar: [{ comp: 'senior', dates: ['2026-11-21'] }], updatedAt: new Date().toISOString() };
  const now = Date.now();
  assert.equal(needsSync(null, rounds, '2026-11-16', now), true);                                        // never synced
  assert.equal(needsSync(fresh, rounds, '2026-11-16', now), false);
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
  assert.deepEqual(made.sort(), ['junior-2026-11-21', 'senior-2026-11-21', 't20-2026-11-22']);
  const sen = store.db.rounds['senior-2026-11-21'];
  assert.deepEqual([sen.comp, sen.title, sen.start, sen.end, sen.picked, sen.stats.needed], ['senior', 'Round 5', '2026-11-21', '2026-11-22', 0, 0]);
  assert.deepEqual(sen.source.comps, ['c1']);
  assert.equal(store.db.season.calendar.length > 0, true);
  assert.equal((await store.listGames('senior-2026-11-21')).every(g => g.slots === 0), true);
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
  const id = 'senior-2026-11-21';
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

test('tile format line comes from the games: One, Two or One & Two day games', async () => {
  const { formatSummary } = await import('../js/logic.js');
  const G = (n, slots = 0) => ({ id: 'x' + n + slots, grade: 'g' + n, roundName: 'Round 1', slots, days: Array.from({ length: n }, (_, i) => ({ date: '2026-11-2' + (1 + i) })), alloc: {} });
  assert.equal(formatSummary([G(2), G(2)]), 'Two day games');
  assert.equal(formatSummary([G(1)]), 'One day games');
  assert.equal(formatSummary([G(1), G(2)]), 'One & Two day games');
  assert.equal(formatSummary([]), '');
  assert.equal(summarise([G(1), G(2)]).formats, 'One & Two day games');            // nothing picked: all games
  assert.equal(summarise([G(1), G(2, 1)]).formats, 'Two day games');               // only the picked grades count
});
