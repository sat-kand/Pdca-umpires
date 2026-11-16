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
  assert.deepEqual(wantedKeys({ modes: { player: false }, picks: [pick('g1', ['2026-11-21'])] }, TODAY), [], 'switched off');
  assert.deepEqual(wantedKeys({ modes: { player: true }, picks: [pick('g1', ['2026-11-01'])] }, TODAY), [], 'already played');
  assert.deepEqual(wantedKeys(null, TODAY), []);
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
  store.db.avail[0].modes = { regular: true, player: false };
  const res = await applyPlayerUmpires(store, { today: TODAY });
  assert.equal(res.removed.length, 1);
  assert.deepEqual(store.db.games.r1[0].alloc['2026-11-21'], [null], 'switching player umpire off gives the game back');
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
