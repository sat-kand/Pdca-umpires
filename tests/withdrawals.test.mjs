import test from 'node:test';
import './pdca-groups.mjs';
import assert from 'node:assert/strict';
import { applyWithdrawals, dismissWithdrawals } from '../js/withdrawals.js';

const DATE = '2099-11-21';
function store({ days = {}, picks = [], updatedAt = '2099-01-02T00:00:00Z', alloc = [{ p: 'p1', n: 'D Henry' }, null] } = {}) {
  const db = {
    w: { w1: { id: 'w1', email: 'dh@x.test', name: 'D Henry', pid: 'p1', handled: false, createdAt: '2099-01-01T00:00:00Z',
      games: [{ roundId: 'r1', gameId: 'g1', date: DATE, comp: 'senior', label: 'B09: H v A' }] } },
    games: { r1: [{ id: 'g1', grade: 'Senior B09', slots: 2, days: [{ date: DATE, day: 1 }], alloc: { [DATE]: alloc } }] },
    avail: [{ email: 'dh@x.test', days, picks, updatedAt }],
  };
  return {
    db,
    getSeason: async () => ({ id: 's1' }),
    listAvailability: async () => structuredClone(db.avail),
    listWithdrawals: async () => structuredClone(Object.values(db.w)),
    saveWithdrawal: async w => { db.w[w.id] = { ...(db.w[w.id] || {}), ...structuredClone(w) }; },
    listGames: async rid => structuredClone(db.games[rid]),
    saveGame: async (rid, g) => { db.games[rid] = db.games[rid].map(x => (x.id === g.id ? structuredClone(g) : x)); },
    saveRound: async () => {},
    listRounds: async () => [{ id: 'r1', published: db.published !== false }],
  };
}

test('pulling out frees the place and flags the game', async () => {
  const s = store({ days: { [`senior:${DATE}`]: 'no' } });
  const shown = await applyWithdrawals(s);
  assert.equal(s.db.games.r1[0].alloc[DATE][0], null);
  assert.match(s.db.games.r1[0].changeNote, /no longer available/);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].shown.length, 1);
});

test('if the officer already filled the place, the other umpire stays; the warning still goes', async () => {
  const s = store({ days: { [`senior:${DATE}`]: 'no' } });
  await applyWithdrawals(s);
  s.db.games.r1[0].alloc[DATE] = [{ p: 'p2', n: 'G Serrao' }, { p: 'p3', n: 'K Bakon' }];
  s.db.avail[0].days[`senior:${DATE}`] = 'yes';
  s.db.avail[0].updatedAt = '2099-01-03T00:00:00Z';
  const shown = await applyWithdrawals(s);
  assert.deepEqual(s.db.games.r1[0].alloc[DATE].map(a => a.p), ['p2', 'p3']);
  assert.equal(shown.length, 0);
});

test('dismissing keeps the record whole', async () => {
  const s = store({ days: { [`senior:${DATE}`]: 'no' } });
  const shown = await applyWithdrawals(s);
  await dismissWithdrawals(s, shown);
  assert.equal(s.db.w.w1.dismissed, true);
  assert.equal(s.db.w.w1.games.length, 1);
  assert.ok(!('shown' in s.db.w.w1));
});

test('once the officer puts someone in the freed place, the warning and the banner go', async () => {
  const s = store({ days: { [`senior:${DATE}`]: 'no' } });
  await applyWithdrawals(s);
  s.db.games.r1[0].alloc[DATE] = [{ p: 'p2', n: 'G Serrao' }, { p: 'p3', n: 'K Bakon' }];
  const shown = await applyWithdrawals(s);
  assert.equal(shown.length, 0);
  assert.equal(s.db.games.r1[0].changeNote, '');
});

test('a pull-out stands: saying Available again or choosing the game again never puts them back', async () => {
  const s = store({ days: { [`senior:${DATE}`]: 'yes' }, picks: [{ gameId: 'g1', comp: 'senior', dates: [DATE] }], updatedAt: '2099-01-03T00:00:00Z' });
  const shown = await applyWithdrawals(s);
  assert.equal(s.db.games.r1[0].alloc[DATE][0], null, 'freed even though they say Available again');
  assert.equal(shown.length, 1, 'and the officer is told');
  await applyWithdrawals(s);
  assert.equal(s.db.games.r1[0].alloc[DATE][0], null, 'and not put back later either');
});
