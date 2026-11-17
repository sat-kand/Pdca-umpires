import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlayerUmpires, wantedKeys, pickKey } from '../js/player-umpire.js';

const TODAY = '2026-11-16';
const G = (id, grade, days, extra = {}) => ({ id, grade, comp: 'PDCA Senior Competition', home: { name: `H${id}` }, away: { name: `A${id}` }, ground: 'Oval',
  days: days.map((date, i) => ({ date, day: i + 1 })), slots: 0, alloc: {}, ...extra });

function fakeStore({ picks = [], modes = { regular: true, player: true }, games }) {
  const db = {
    season: { id: 's1' },
    umpires: [{ pid: 'p1', email: 'sk@x.test', name: 'S Kandhaswami', active: true }, { pid: 'p2', email: 'gs@x.test', name: 'G Serrao', active: true }],
    avail: [{ seasonId: 's1', email: 'sk@x.test', days: {}, modes, picks }],
    games: { r1: games },
    rounds: {},
    settings: {},
  };
  return {
    db,
    getSeason: async () => db.season,
    listAvailability: async () => structuredClone(db.avail),
    listUmpires: async () => structuredClone(db.umpires),
    getSettings: async () => structuredClone(db.settings),
    saveSettings: async s => { db.settings = { ...db.settings, ...structuredClone(s) }; },
    listGames: async rid => structuredClone(db.games[rid] || []),
    saveGame: async (rid, g) => { db.games[rid] = db.games[rid].map(x => (x.id === g.id ? structuredClone(g) : x)); },
    saveRound: async r => { db.rounds[r.id] = { ...(db.rounds[r.id] || {}), ...r }; },
  };
}
const pick = (gameId, dates) => ({ roundId: 'r1', gameId, comp: 'senior', grade: 'Senior B09', label: 'x', dates });

test('only a player umpire\'s future choices count', () => {
  assert.deepEqual(wantedKeys({ modes: { player: true }, picks: [pick('g1', ['2026-11-21', '2026-11-28'])] }, TODAY),
    [pickKey('r1', 'g1', '2026-11-21'), pickKey('r1', 'g1', '2026-11-28')]);
  assert.equal(wantedKeys({ modes: { player: false }, picks: [pick('g1', ['2026-11-21'])] }, TODAY).length, 1, 'the tick box only hides the section; saved games still count');
  assert.deepEqual(wantedKeys({ modes: { player: true }, picks: [pick('g1', ['2026-11-01'])] }, TODAY), [], 'already played');
  assert.deepEqual(wantedKeys(null, TODAY), []);
  assert.deepEqual(wantedKeys({ modes: { player: true }, picks: [{ ...pick('g1', ['2026-11-21']), comp: 'junior' }] }, TODAY), [], 'Senior games only');
});

test('a chosen game goes on the board with the name filled in and the grade turned on', async () => {
  const store = fakeStore({ picks: [pick('g1', ['2026-11-21'])], games: [G('g1', 'Senior B09', ['2026-11-21', '2026-11-28']), G('g2', 'Senior B09', ['2026-11-21', '2026-11-28'])] });
  const res = await applyPlayerUmpires(store, { today: TODAY });
  assert.equal(res.added.length, 1);
  const [g1, g2] = store.db.games.r1;
  assert.equal(g1.slots, 1, 'the game now needs an umpire, so its grade shows as selected');
  assert.deepEqual(g1.alloc['2026-11-21'], [{ p: 'p1', n: 'S Kandhaswami', pu: true }]);
  assert.equal(g1.alloc['2026-11-28'], undefined, 'only the day they chose');
  assert.equal(g2.slots, 0, 'other games of the grade are left for the officer');
  assert.ok(store.db.rounds.r1.changedAt, 'the round is marked as changed, so a published round asks to be re-published');
  assert.equal(store.db.rounds.r1.stats.filled, 1);

  const again = await applyPlayerUmpires(store, { today: TODAY });
  assert.deepEqual(again, { added: [], removed: [], blocked: [] }, 'running it again changes nothing');
});

test('the officer\'s own change stands, and a withdrawn choice is taken off', async () => {
  const store = fakeStore({ picks: [pick('g1', ['2026-11-21'])], games: [G('g1', 'Senior B09', ['2026-11-21'])] });
  await applyPlayerUmpires(store, { today: TODAY });

  // The officer puts someone else on the game instead.
  store.db.games.r1[0].alloc['2026-11-21'] = [{ p: 'p2', n: 'G Serrao' }];
  await applyPlayerUmpires(store, { today: TODAY });
  assert.deepEqual(store.db.games.r1[0].alloc['2026-11-21'], [{ p: 'p2', n: 'G Serrao' }], 'not put back');

  // A fresh choice by the member, then they change their mind.
  store.db.games.r1[0].alloc['2026-11-21'] = [null];
  store.db.avail[0].picks = [];
  await applyPlayerUmpires(store, { today: TODAY });
  store.db.avail[0].picks = [pick('g1', ['2026-11-21'])];
  await applyPlayerUmpires(store, { today: TODAY });
  assert.equal(store.db.games.r1[0].alloc['2026-11-21'][0].p, 'p1');
  store.db.avail[0].picks = [];
  const res = await applyPlayerUmpires(store, { today: TODAY });
  assert.equal(res.removed.length, 1);
  assert.deepEqual(store.db.games.r1[0].alloc['2026-11-21'], [null], 'removing the game and saving gives it back');
});

test('a full game gets a second place, and when that is taken too the officer is told', async () => {
  const store = fakeStore({ picks: [pick('g1', ['2026-11-21'])], games: [G('g1', 'Senior A Grade', ['2026-11-21'], { slots: 1, alloc: { '2026-11-21': [{ p: 'p2', n: 'G Serrao' }] } })] });
  await applyPlayerUmpires(store, { today: TODAY });
  const g = store.db.games.r1[0];
  assert.equal(g.slots, 2);
  assert.deepEqual(g.alloc['2026-11-21'].map(a => a.n), ['G Serrao', 'S Kandhaswami']);

  const full = fakeStore({ picks: [pick('g1', ['2026-11-21'])], games: [G('g1', 'Senior A Grade', ['2026-11-21'], { slots: 2, alloc: { '2026-11-21': [{ p: 'p2', n: 'G Serrao' }, { p: 'p9', n: 'X' }] } })] });
  const res = await applyPlayerUmpires(full, { today: TODAY });
  assert.equal(res.blocked.length, 1);
  assert.match(full.db.games.r1[0].changeNote, /S Kandhaswami asked to umpire this .* both places are taken/);
});

import { claimsFrom } from '../js/player-umpire.js';
import { slotOptions, assignmentWarnings, autoAllocate } from '../js/logic.js';

test('a player umpire comes first: offered for the game they chose, kept out of every other game that day', () => {
  const umpires = [{ pid: 'p1', email: 'sk@x.test', name: 'S Kandhaswami', active: true }, { pid: 'p2', email: 'gs@x.test', name: 'G Serrao', active: true }];
  const days = { 'senior:2026-11-21': 'yes', 'junior:2026-11-21': 'yes' };
  const avail = [{ email: 'sk@x.test', days, picks: [pick('g1', ['2026-11-21'])] }, { email: 'gs@x.test', days }];
  const availByEmail = Object.fromEntries(avail.map(a => [a.email, a]));
  const { claimOf, pickOf } = claimsFrom(avail, umpires);
  assert.equal(claimOf('p1', '2026-11-21', 'senior'), 'g1');
  assert.equal(pickOf('p1', '2026-11-21', 'senior').grade, 'Senior B09');
  assert.equal(claimOf('p2', '2026-11-21', 'senior'), null);
  assert.equal(claimOf('p1', '2026-11-21', 'junior'), null, 'in Junior they are a full umpire as usual');
  const g1 = G('g1', 'Senior B09', ['2026-11-21'], { slots: 2 });
  const g2 = G('g2', 'Senior C10', ['2026-11-21'], { slots: 1 });
  const own = slotOptions({ game: g1, date: '2026-11-21', slotIndex: 0, umpires, availByEmail, busy: {}, claimOf }).find(o => o.umpire.pid === 'p1');
  assert.equal(own.group, 'chosen');
  const other = slotOptions({ game: g2, date: '2026-11-21', slotIndex: 0, umpires, availByEmail, busy: {}, claimOf }).find(o => o.umpire.pid === 'p1');
  assert.equal(other.group, 'avoid');
  assert.ok(other.elsewhere);
  assert.deepEqual(assignmentWarnings({ game: g1, date: '2026-11-21', slotIndex: 0, umpire: umpires[0], availByEmail, busy: {}, claimOf }), []);
  assert.match(assignmentWarnings({ game: g2, date: '2026-11-21', slotIndex: 0, umpire: umpires[0], availByEmail, busy: {}, claimOf }).join(), /player umpire/);
  // Auto-fill puts them only in the game they chose, never anywhere else that day.
  const changes = autoAllocate({ games: [g1, g2], umpires, availByEmail, claimOf });
  assert.ok(changes.filter(c => c.entry.p === 'p1').every(c => c.gameId === 'g1' && c.entry.pu));
  // Switched off: nothing is claimed.
  assert.equal(claimsFrom(avail, umpires, false).claimOf('p1', '2026-11-21', 'senior'), null);
  // A Junior game that day: they are offered as usual, with no warning.
  const jg = { ...G('j1', 'Junior U14', ['2026-11-21'], { slots: 1 }), comp: 'PDCA Junior Competition' };
  const jr = slotOptions({ game: jg, date: '2026-11-21', slotIndex: 0, umpires, availByEmail, busy: {}, claimOf }).find(o => o.umpire.pid === 'p1');
  assert.equal(jr.group, 'ok');
  assert.ok(!jr.chosen && !jr.elsewhere);
  assert.deepEqual(assignmentWarnings({ game: jg, date: '2026-11-21', slotIndex: 0, umpire: umpires[0], availByEmail, busy: {}, claimOf }), []);
});

test('a chosen game in an unselected grade is turned on by itself; in a selected grade it is just filled', async () => {
  const s = fakeStore({ picks: [pick('g1', ['2026-11-21']), pick('g2', ['2026-11-28'])], games: [G('g1', 'Senior B09', ['2026-11-21']), G('g2', 'Senior A', ['2026-11-28'], { slots: 1 })] });
  await applyPlayerUmpires(s, { today: TODAY });
  const [g1, g2] = s.db.games.r1;
  assert.equal(g1.slots, 1);
  assert.equal(g1.puOnly, true, 'its grade stays unselected');
  assert.ok(!g2.puOnly, 'a grade the officer selected stays selected as normal');
});

test('Suggest allocations puts the player umpire back in their own empty game first', () => {
  const umpires = [{ pid: 'p1', email: 'sk@x.test', name: 'S Kandhaswami', active: true }, { pid: 'p2', email: 'gs@x.test', name: 'G Serrao', active: true }];
  const avail = [{ email: 'sk@x.test', days: {}, picks: [pick('g1', ['2026-11-21'])] }, { email: 'gs@x.test', days: { 'senior:2026-11-21': 'yes' } }];
  const { claimOf } = claimsFrom(avail, umpires);
  const g1 = G('g1', 'Senior B09', ['2026-11-21'], { slots: 2 });
  const changes = autoAllocate({ games: [g1], umpires, availByEmail: Object.fromEntries(avail.map(a => [a.email, a])), claimOf });
  assert.deepEqual(changes.map(c => [c.entry.p, !!c.entry.pu]), [['p1', true], ['p2', false]]);
});
