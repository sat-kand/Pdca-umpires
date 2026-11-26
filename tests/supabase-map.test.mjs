import test from 'node:test';
import assert from 'node:assert/strict';
import { orgToRow, rowToOrg, membershipRow, personRow, rowToUmpire, roundToRow, rowToRound, gameToItem, itemToGame, withdrawalToRow, rowToWithdrawal } from '../js/supabase-map.js';

const game = {
  id: 'g1', comp: 'Senior Competition', grade: 'Senior A Grade', roundName: 'Round 3', matchType: 'Two Day', status: 'SCHEDULED',
  days: [{ day: 1, date: '2026-10-24', time: '13:30' }, { day: 2, date: '2026-10-31', time: '13:30' }],
  home: { name: 'GLCC', org: 'GLCC-org' }, away: { name: 'Hills', org: 'Hills-org' }, ground: 'McCredie Park', address: '1 Road', lat: -33.8, lng: 151.0,
  slots: 2, alloc: { '2026-10-24': [{ p: 'p1', n: 'G Serrao' }, null], '2026-10-31': [null, { p: 'p2', n: 'D Everton', pu: true }] }, manual: true,
};

test('a game survives the trip to rows and back', () => {
  const item = gameToItem(game);
  assert.equal(item.days.length, 2);                       // one game, two day rows
  assert.equal(item.appts.length, 2);                      // empty slots are not rows
  const back = itemToGame({ ...item.game, round_id: 'r' }, item.days.map(d => ({ ...d })), item.appts);
  assert.deepEqual(back, game);
});

test('player-umpire flag and slot position are kept', () => {
  const item = gameToItem(game);
  assert.deepEqual(item.appts.find(a => a.pid === 'p2'), { date: '2026-10-31', slot_index: 1, pid: 'p2', name: 'D Everton', player_umpire: true });
});

test('a game with no allocation has no appointment rows and an empty alloc', () => {
  const item = gameToItem({ ...game, alloc: {} });
  assert.equal(item.appts.length, 0);
  assert.deepEqual(itemToGame(item.game, item.days, []).alloc, {});
});

test('removed games are marked, not dropped; PlayHQ id is carried', () => {
  const item = gameToItem({ ...game, removed: true, playhqId: 'abc' });
  assert.equal(item.game.removed, true);
  assert.equal(item.game.playhq_game_id, 'abc');
  const back = itemToGame(item.game, item.days, item.appts);
  assert.equal(back.removed, true);
  assert.equal(back.playhqId, 'abc');
});

test('a second day at a different ground is kept on that day', () => {
  const g = { ...game, days: [{ day: 1, date: '2026-10-24', time: '13:30' }, { day: 2, date: '2026-10-25', time: '13:30', ground: 'Other Oval' }] };
  const item = gameToItem(g);
  assert.equal(item.days[1].ground, 'Other Oval');
  assert.equal(itemToGame(item.game, item.days, []).days[1].ground, 'Other Oval');
});

test('an allocation array is padded to the number of slots', () => {
  const item = gameToItem({ ...game, slots: 3, alloc: { '2026-10-24': [null, null, { p: 'p1', n: 'x' }] } });
  assert.equal(itemToGame(item.game, item.days, item.appts).alloc['2026-10-24'].length, 3);
});

test('association: known columns split from the rest of its settings', () => {
  const o = { id: 'pdca', name: 'PDCA', plan: 'trial', notifyEmail: 'a@b.c', playhqOrgId: 'org-1', weekStart: 1, groups: [{ key: 'senior' }], playerUmpire: { description: 'x' } };
  const row = orgToRow(o);
  assert.equal(row.playhq_org_id, 'org-1');
  assert.equal(row.notify_email, 'a@b.c');
  assert.deepEqual(row.config.groups, [{ key: 'senior' }]);
  assert.deepEqual(rowToOrg(row), o);
});

test('umpire splits into person and membership and joins back', () => {
  const u = { pid: 'p1', email: 'a@b.c', name: 'A B', firstName: 'A', lastName: 'B', phone: '0400', active: true, membership: 'Ordinary member', wantsToUmpire: true };
  const person = personRow(u), mem = membershipRow('pdca', u);
  assert.equal(person.phone, '0400');
  assert.equal(mem.name, undefined);                       // personal details never go in the membership
  const back = rowToUmpire({ ...mem, people: { ...person } });
  assert.deepEqual(back, u);
});

test('an officer-style update of membership fields never carries personal details', () => {
  const row = membershipRow('pdca', { email: 'a@b.c', active: false, suspended: true });
  assert.deepEqual(Object.keys(row).sort(), ['active', 'association_id', 'email', 'suspended']);
});

test('round and withdrawal round-trip', () => {
  const r = { id: 'senior-2026-10-24', comp: 'senior', title: 'Round 3', start: '2026-10-24', end: '2026-10-31', published: true, dates: ['2026-10-24'], total: 4 };
  assert.deepEqual(rowToRound(roundToRow('pdca', r)), r);
  const w = { id: 'w1', email: 'a@b.c', pid: 'p1', handled: false, gameId: 'g1', date: '2026-10-24' };
  assert.deepEqual(rowToWithdrawal(withdrawalToRow('pdca', w)), w);
});
