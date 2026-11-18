import { test } from 'node:test';
import './pdca-groups.mjs';
import assert from 'node:assert/strict';
import {
  fmtRange, gradeShort, compareGrades, groupSections, allocFor, buildBusyMap,
  assignmentWarnings, slotOptions, recount, autoAllocate, applyChanges, umpireText, seasonLoads, buildCalendar, upcomingDates, byMonth,
  compKeyOf, availKey, availStatus, roundColumns,
} from '../js/logic.js';

const mk = (id, grade, home, away, days, slots = 1, alloc = {}, extra = {}) => ({
  id, comp: 'PDCA Senior Competition', grade, roundName: 'Round 2', matchType: days.length > 1 ? 'Two Day' : 'T20',
  days: days.map((d, i) => ({ day: i + 1, date: d, time: '13:30' })),
  home: { name: home, org: home + ' Cricket Club' }, away: { name: away, org: away + ' Cricket Club' },
  ground: 'Park', slots, alloc, ...extra,
});
const U = (pid, name, active = true) => ({ pid, email: pid + '@x.test', name, active });
const D1 = '2026-10-10', D2 = '2026-10-17';
// avail({ u1: { [D1]: 'yes' } }) answers for the Senior competition; pass comp for Junior / T20.
const avail = (map, comp = 'senior') => Object.fromEntries(Object.entries(map).map(([pid, days]) =>
  [pid + '@x.test', { days: Object.fromEntries(Object.entries(days).map(([d, v]) => [availKey(comp, d), v])) }]));
const JUN = 'PDCA Junior Competition', T20C = 'PDCA T20 Competition';

test('fmtRange matches the report heading style', () => {
  assert.equal(fmtRange([D2, D1]), '10/17 OCT');
  assert.equal(fmtRange([D2]), '17 OCT');
  assert.equal(fmtRange(['2026-10-31', '2026-11-07']), '31 OCT / 7 NOV');
});

test('grade short names and ordering follow the report (A, Ar, B1..B16, then others)', () => {
  assert.equal(gradeShort('Senior A Grade'), 'A');
  assert.equal(gradeShort('Senior A Reserve'), 'Ar');
  assert.equal(gradeShort('Senior B02'), 'B2');
  assert.equal(gradeShort('Senior B16'), 'B16');
  const order = ['Senior Women', 'Senior B10', 'Senior B02', 'Senior A Reserve', 'Senior A Grade'].sort(compareGrades).map(gradeShort);
  assert.deepEqual(order, ['A', 'Ar', 'B2', 'B10', 'Women']);
});

test('groupSections splits two-day seniors from single-day women on the same weekend', () => {
  const games = [
    mk('1', 'Senior B02', 'A', 'B', [D1, D2]),
    mk('2', 'Senior Women', 'C', 'D', [D2], 1, {}, { roundName: 'Round 4', matchType: 'T20' }),
    mk('3', 'Senior A Grade', 'E', 'F', [D1, D2]),
  ];
  const s = groupSections(games);
  assert.equal(s.length, 2);
  assert.equal(s[0].label, 'Round 2 Senior');
  assert.deepEqual(s[0].games.map(g => g.id), ['3', '1']);
  assert.equal(s[1].label, 'Round 4 Women');
});

test('allocFor pads to slot count; removed games have no slots', () => {
  const g = mk('1', 'Senior A Grade', 'A', 'B', [D1], 2, { [D1]: [{ p: 'u1', n: 'Ann' }] });
  assert.deepEqual(allocFor(g, D1), [{ p: 'u1', n: 'Ann' }, null]);
  assert.deepEqual(allocFor({ ...g, removed: true }, D1), []);
});

test('warnings: unavailable, no response, double-booked, same umpire twice', () => {
  const g1 = mk('1', 'Senior A Grade', 'Kings Langley', 'B', [D1], 2, { [D1]: [{ p: 'u1', n: 'Ann' }, null] });
  const g2 = mk('2', 'Senior B02', 'C', 'D', [D1], 1, { [D1]: [{ p: 'u1', n: 'Ann' }] });
  const busy = buildBusyMap([g1, g2]);
  const ann = U('u1', 'Ann');
  const w = assignmentWarnings({ game: g2, date: D1, slotIndex: 0, umpire: ann, availByEmail: avail({ u1: { [D1]: 'no' } }), busy });
  assert.deepEqual(w, ['Marked unavailable for Senior on this day', 'Already umpiring another Senior game this day']);
  const bob = U('u2', 'Bob');
  assert.deepEqual(assignmentWarnings({ game: g1, date: D1, slotIndex: 1, umpire: bob, availByEmail: {}, busy }),
    ['No Senior availability submitted']);
  assert.ok(assignmentWarnings({ game: g1, date: D1, slotIndex: 1, umpire: ann, availByEmail: avail({ u1: { [D1]: 'yes' } }), busy }).includes('Already in this game'));
  assert.deepEqual(assignmentWarnings({ game: g1, date: D1, slotIndex: 0, umpire: ann, availByEmail: avail({ u1: { [D1]: 'yes' } }), busy: buildBusyMap([g1]) }), []);
});

test('slotOptions groups yes / no response / non-member / avoid', () => {
  const g = mk('1', 'Senior A Grade', 'A', 'B', [D1]);
  const g2 = mk('2', 'Senior B02', 'C', 'D', [D1], 1, { [D1]: [{ p: 'u4', n: 'Dee' }] });
  const umpires = [U('u1', 'Ann'), U('u2', 'Bob'), U('u3', 'Cat'), U('u4', 'Dee'), U('u5', 'Eve'), U('u6', 'Fay', false)];
  const a = avail({ u1: { [D1]: 'yes' }, u2: { [D1]: 'yes' }, u4: { [D1]: 'yes' }, u5: { [D1]: 'no' }, u6: { [D1]: 'yes' } });
  const opts = slotOptions({ game: g, date: D1, slotIndex: 0, umpires, availByEmail: a, busy: buildBusyMap([g, g2]), loads: {} });
  const by = Object.fromEntries(opts.map(o => [o.umpire.name, o.group]));
  // Fay is not an active member: available, but in a group of her own so she is picked on purpose.
  assert.deepEqual(by, { Ann: 'ok', Bob: 'ok', Cat: 'none', Dee: 'avoid', Eve: 'avoid', Fay: 'nonmember' });

  const quiet = slotOptions({ game: g, date: D1, slotIndex: 0, umpires: [U('u7', 'Gus', false)], availByEmail: avail({}), busy: {}, loads: {} });
  assert.equal(quiet[0].group, 'avoid', 'a non-member who has not said they are available is not offered as available');
  const warn = assignmentWarnings({ game: g, date: D1, slotIndex: 0, umpire: U('u6', 'Fay', false), availByEmail: a, busy: {} });
  assert.deepEqual(warn, ['Not a member in good standing']);
  const chosen = assignmentWarnings({ game: g, date: D1, slotIndex: 0, umpire: U('u7', 'Gus'), availByEmail: avail({}), busy: {}, chosen: true });
  assert.deepEqual(chosen, [], 'a player umpire who chose the game is not warned about their date answers');
});

test('recount counts slot-days and per-umpire games (a two-day game once)', () => {
  const games = [
    mk('1', 'Senior A Grade', 'A', 'B', [D1, D2], 2, { [D1]: [{ p: 'u1', n: 'Ann' }, { p: 'u2', n: 'Bob' }], [D2]: [{ p: 'u1', n: 'Ann' }] }),
    mk('2', 'Senior B02', 'C', 'D', [D1], 0),
    mk('3', 'Senior B03', 'E', 'F', [D1], 1),
  ];
  const r = recount(games);
  assert.equal(r.games, 2);
  assert.equal(r.needed, 5);
  assert.equal(r.filled, 3);
  assert.deepEqual(r.byUmpire, { u1: 1, u2: 1 });
  assert.deepEqual(seasonLoads([r, { byUmpire: { u1: 4, u9: 1 } }, null]), { u1: 5, u2: 1, u9: 1 });
});

test('autoAllocate: only "yes", no double-booking, balances load, keeps two-day pair', () => {
  const games = [
    mk('1', 'Senior A Grade', 'Kings Langley', 'B', [D1, D2]),
    mk('2', 'Senior B02', 'C', 'D', [D1, D2]),
    mk('3', 'Senior B03', 'E', 'F', [D1]),
  ];
  const umpires = [U('u1', 'Ann'), U('u2', 'Bob'), U('u3', 'Cat'), U('u4', 'Dan')];
  const a = avail({
    u1: { [D1]: 'yes', [D2]: 'yes' }, u2: { [D1]: 'yes', [D2]: 'yes' },
    u3: { [D1]: 'yes', [D2]: 'no' }, u4: { [D1]: 'no', [D2]: 'yes' },
  });
  const ch = autoAllocate({ games, umpires, availByEmail: a });
  const apply = g => ({ ...g, alloc: applyChanges(g, ch) });
  const done = games.map(apply);
  const pid = (id, d) => allocFor(done.find(g => g.id === id), d)[0];
  for (const d of [D1, D2]) {                              // nobody twice on one day
    const ps = done.flatMap(g => allocFor(g, d)).filter(Boolean).map(x => x.p);
    assert.equal(new Set(ps).size, ps.length);
  }
  assert.ok(!allocFor(done[0], D1).some(x => x?.p === 'u4'));  // Dan said no on D1
  assert.ok(!pid('3', D2));                                // game 3 is one-day, nothing on D2
  assert.ok(pid('1', D1) && pid('2', D1) && pid('3', D1));
  // day 2: Cat said no so must not be picked
  assert.ok(![pid('1', D2), pid('2', D2)].some(x => x?.p === 'u3'));
});

test('autoAllocate never overwrites an existing allocation and respects slot counts', () => {
  const games = [mk('1', 'Senior A Grade', 'A', 'B', [D1], 2, { [D1]: [{ p: 'u1', n: 'Ann' }, null] })];
  const umpires = [U('u1', 'Ann'), U('u2', 'Bob'), U('u3', 'Cat')];
  const a = avail({ u1: { [D1]: 'yes' }, u2: { [D1]: 'yes' }, u3: { [D1]: 'yes' } });
  const ch = autoAllocate({ games, umpires, availByEmail: a });
  assert.equal(ch.length, 1);
  assert.equal(ch[0].slot, 1);
  assert.notEqual(ch[0].entry.p, 'u1');
  const next = applyChanges(games[0], ch);
  assert.equal(next[D1][0].p, 'u1');
});

test('autoAllocate leaves a slot empty when nobody is free', () => {
  const games = [mk('1', 'Senior A Grade', 'A', 'B', [D1])];
  assert.deepEqual(autoAllocate({ games, umpires: [U('u1', 'Ann')], availByEmail: avail({ u1: { [D1]: 'no' } }) }), []);
});

test('report text: one day, two slots, and a different umpire each day', () => {
  const one = mk('1', 'Senior A Grade', 'A', 'B', [D1], 2, { [D1]: [{ p: 'a', n: 'K Bakon' }, { p: 'b', n: 'B Chellapa' }] });
  assert.equal(umpireText(one), 'K BAKON & B CHELLAPA');
  const two = mk('2', 'Senior A Grade', 'A', 'B', [D1, D2], 1, { [D1]: [{ p: 'a', n: 'G Serrao' }], [D2]: [{ p: 'b', n: 'D Everton' }] });
  assert.equal(umpireText(two), 'G SERRAO (DAY 1) / D EVERTON (DAY 2)');
  const same = mk('3', 'Senior A Grade', 'A', 'B', [D1, D2], 1, { [D1]: [{ p: 'a', n: 'M Verma' }], [D2]: [{ p: 'a', n: 'M Verma' }] });
  assert.equal(umpireText(same), 'M VERMA');
  assert.equal(umpireText(mk('4', 'Senior B02', 'A', 'B', [D1], 1)), '—');
  assert.equal(umpireText(mk('5', 'Senior B02', 'A', 'B', [D1], 0)), '');
});

test('compKeyOf puts a competition in the group its own name suggests, else the first group', () => {
  assert.equal(compKeyOf('PDCA Senior Competition'), 'senior');
  assert.equal(compKeyOf('PDCA Junior Competition'), 'junior');
  assert.equal(compKeyOf('PDCA T20 Competition'), 't20');
  assert.equal(compKeyOf({ comp: 'PDCA Junior Competition' }), 'junior');
  assert.equal(compKeyOf('Imported'), 'senior');
  // a T20 *match* inside the Senior competition (e.g. Women) is still Senior
  assert.equal(compKeyOf(mk('1', 'Senior Women', 'A', 'B', [D1])), 'senior');
});

test('availability is separate per competition for the same date', () => {
  const a = { 'u1@x.test': { days: { [availKey('senior', D1)]: 'yes', [availKey('junior', D1)]: 'no' } } };
  assert.equal(availStatus(a, U('u1', 'Ann'), 'senior', D1), 'yes');
  assert.equal(availStatus(a, U('u1', 'Ann'), 'junior', D1), 'no');
  assert.equal(availStatus(a, U('u1', 'Ann'), 't20', D1), 'none');
});

test('an umpire can be appointed to a Senior and a Junior game on the same day without a warning', () => {
  const sen = mk('1', 'Senior A Grade', 'A', 'B', [D1], 1, { [D1]: [{ p: 'u1', n: 'Ann' }] });
  const jun = mk('2', 'U12 Gold', 'C', 'D', [D1], 1, { [D1]: [{ p: 'u1', n: 'Ann' }] }, { comp: JUN });
  const a = { 'u1@x.test': { days: { [availKey('senior', D1)]: 'yes', [availKey('junior', D1)]: 'yes' } } };
  const busy = buildBusyMap([sen, jun]);
  const ann = U('u1', 'Ann');
  assert.deepEqual(assignmentWarnings({ game: sen, date: D1, slotIndex: 0, umpire: ann, availByEmail: a, busy }), []);
  assert.deepEqual(assignmentWarnings({ game: jun, date: D1, slotIndex: 0, umpire: ann, availByEmail: a, busy }), []);
});

test('but two games in the SAME competition on one day still clash, and availability must match the competition', () => {
  const s1 = mk('1', 'Senior A Grade', 'A', 'B', [D1], 1, { [D1]: [{ p: 'u1', n: 'Ann' }] });
  const s2 = mk('2', 'Senior B02', 'C', 'D', [D1], 1, { [D1]: [{ p: 'u1', n: 'Ann' }] });
  const busy = buildBusyMap([s1, s2]);
  const onlyJunior = { 'u1@x.test': { days: { [availKey('junior', D1)]: 'yes' } } };
  const w = assignmentWarnings({ game: s2, date: D1, slotIndex: 0, umpire: U('u1', 'Ann'), availByEmail: onlyJunior, busy });
  assert.deepEqual(w, ['No Senior availability submitted', 'Already umpiring another Senior game this day']);
});

test('autoAllocate uses each competition\'s own availability and can use one umpire for two competitions on a day', () => {
  const games = [
    mk('1', 'Senior A Grade', 'A', 'B', [D1]),
    mk('2', 'U12 Gold', 'C', 'D', [D1], 1, {}, { comp: JUN }),
    mk('3', 'T20 Mens', 'E', 'F', [D1], 1, {}, { comp: T20C }),
  ];
  const umpires = [U('u1', 'Ann'), U('u2', 'Bob')];
  const a = {
    'u1@x.test': { days: { [availKey('senior', D1)]: 'yes', [availKey('junior', D1)]: 'yes', [availKey('t20', D1)]: 'no' } },
    'u2@x.test': { days: { [availKey('senior', D1)]: 'no', [availKey('junior', D1)]: 'no', [availKey('t20', D1)]: 'yes' } },
  };
  const ch = autoAllocate({ games, umpires, availByEmail: a });
  const who = Object.fromEntries(ch.map(c => [c.gameId, c.entry.p]));
  assert.deepEqual(who, { 1: 'u1', 2: 'u1', 3: 'u2' });   // Ann does Senior and Junior on the same day
});


// ---------- season calendar: plain dates per competition ------------------

test('same-length competition is shown by round with Day 1 / Day 2; mixed lengths fall back to a date list', () => {
  const [X, Y, Z, W] = ['2026-11-21', '2026-11-28', '2026-12-05', '2026-12-12'];
  const j = (id, grade, days, roundName) => mk(id, grade, 'A', 'B', days, 1, {}, { comp: JUN, roundName });
  const games = [
    // Senior: every game two-day -> rounds layout, ordered by date (Round 9 is played before Round 10)
    mk('1', 'Senior A Grade', 'A', 'B', [X, Y], 1, {}, { roundName: 'Round 9' }),
    mk('2', 'Senior B02', 'E', 'F', [Z, W], 1, {}, { roundName: 'Round 10' }),
    // Junior: U14 two-day, U13 one-day on day 2 -> date list
    j('4', 'U14 Blue', [X, Y], 'Round 3'),
    j('5', 'U13 Gold', [Y], 'Round 4'),
    // T20: every game one-day -> rounds layout
    mk('6', 'T20 Mens', 'G', 'H', [Y], 1, {}, { comp: T20C, roundName: 'Round 1' }),
    mk('7', 'T20 Mens', 'G', 'H', [Z], 1, {}, { comp: T20C, roundName: 'Round 2' }),
  ];
  assert.deepEqual(buildCalendar(games), [
    { comp: 'senior', label: 'Round 9', dates: [X, Y] },
    { comp: 'senior', label: 'Round 10', dates: [Z, W] },
    { comp: 'junior', dates: [X, Y] },
    { comp: 't20', label: 'Round 1', dates: [Y] },
    { comp: 't20', label: 'Round 2', dates: [Z] },
  ]);
});

test('a Senior competition with one-day Women games next to two-day men is mixed, so it is a date list', () => {
  const games = [mk('1', 'Senior A Grade', 'A', 'B', [D1, D2]), mk('2', 'Senior Women', 'C', 'D', [D2], 1, {}, { roundName: 'Round 4' })];
  assert.deepEqual(buildCalendar(games), [{ comp: 'senior', dates: [D1, D2] }]);
});

test('rounds layout: duplicate round names stay distinguishable and the most common name wins for a date', () => {
  const games = [
    mk('1', 'Senior A Grade', 'A', 'B', [D1, D2]),
    mk('2', 'Senior B02', 'A', 'B', [D1, D2], 1, {}, { roundName: 'Round 2' }),
    mk('3', 'Senior B03', 'A', 'B', [D1, D2], 1, {}, { roundName: 'Round 3' }),
    mk('4', 'Senior A Grade', 'A', 'B', ['2026-12-05', '2026-12-06']),
  ];
  assert.deepEqual(buildCalendar(games).map(r => r.label), ['Round 2', 'Round 2 (2)']);
});

test('upcomingDates: rounds layout keeps Day numbers; dates layout is a sorted date list; older calendars still work', () => {
  const cal = [
    { comp: 'senior', label: 'Round 2', dates: ['2026-10-10', '2026-10-17'] },
    { comp: 'senior', label: 'Round 3', dates: ['2026-10-24', '2026-10-31'] },
    { comp: 'junior', dates: ['2026-10-24', '2026-10-17', '2026-10-10'] },
  ];
  const up = upcomingDates(cal, '2026-10-17');
  assert.deepEqual(up[0], {
    comp: 'senior', label: 'Senior', mode: 'rounds', dates: ['2026-10-17', '2026-10-24', '2026-10-31'],
    rounds: [
      { label: 'Round 2', rows: [{ date: '2026-10-17', dayNo: 2, of: 2 }] },
      { label: 'Round 3', rows: [{ date: '2026-10-24', dayNo: 1, of: 2 }, { date: '2026-10-31', dayNo: 2, of: 2 }] },
    ],
  });
  assert.deepEqual(up[1], { comp: 'junior', label: 'Junior', mode: 'dates', rounds: [], dates: ['2026-10-17', '2026-10-24'] });
  assert.deepEqual(upcomingDates(cal, '2027-01-01'), []);
  assert.deepEqual(upcomingDates(null, '2026-10-17'), []);
});

test('byMonth groups sorted dates under month headings', () => {
  const m = byMonth(['2026-11-21', '2026-11-28', '2026-12-05']);
  assert.deepEqual(m.map(x => [x.month, x.dates.length]), [['November 2026', 2], ['December 2026', 1]]);
});

test('roundColumns lists comp+date pairs, skipping removed games', () => {
  const games = [mk('1', 'Senior A Grade', 'A', 'B', [D1, D2]), mk('2', 'U12 Gold', 'C', 'D', [D1], 1, {}, { comp: JUN }), mk('3', 'x', 'C', 'D', [D1], 1, {}, { removed: true, comp: T20C })];
  assert.deepEqual(roundColumns(games).map(c => c.key), [availKey('senior', D1), availKey('junior', D1), availKey('senior', D2)]);
});

test('two-day game: umpires free on both days are grouped first, one-day-only umpires separately', () => {
  const g = mk('1', 'Senior A Grade', 'A', 'B', [D1, D2]);
  const umpires = [U('u1', 'Ann'), U('u2', 'Bob'), U('u3', 'Cat'), U('u4', 'Dee'), U('u5', 'Eve')];
  const a = avail({
    u1: { [D1]: 'yes', [D2]: 'yes' },      // both days
    u2: { [D1]: 'yes', [D2]: 'no' },       // Day 1 only
    u3: { [D1]: 'yes' },                   // yes Day 1, no reply Day 2 -> not both
    u4: { [D1]: 'yes', [D2]: 'yes' },      // both days, but already busy on Day 2 in another Senior game
  });
  const other = mk('2', 'Senior B02', 'C', 'D', [D2], 1, { [D2]: [{ p: 'u4', n: 'Dee' }] });
  const opts = slotOptions({ game: g, date: D1, slotIndex: 0, umpires, availByEmail: a, busy: buildBusyMap([g, other]), loads: {} });
  const by = Object.fromEntries(opts.map(o => [o.umpire.name, o.group]));
  assert.deepEqual(by, { Ann: 'both', Bob: 'ok', Cat: 'ok', Dee: 'ok', Eve: 'none' });
  assert.deepEqual(opts.find(o => o.umpire.name === 'Bob').okDays, [D1]);
});

test('one-day games never use the "both days" group', () => {
  const g = mk('1', 'Senior A Grade', 'A', 'B', [D1]);
  const opts = slotOptions({ game: g, date: D1, slotIndex: 0, umpires: [U('u1', 'Ann')], availByEmail: avail({ u1: { [D1]: 'yes' } }), busy: {}, loads: {} });
  assert.equal(opts[0].group, 'ok');
});

import { reliabilityOf as rel } from '../js/logic.js';
test('Suggest allocations gives empty places to the most reliable umpires first', async () => {
  const { autoAllocate } = await import('../js/logic.js');
  const umpires = [{ pid: 'a', email: 'a@x', name: 'A Able', active: true }, { pid: 'b', email: 'b@x', name: 'B Baker', active: true }];
  const days = { 'senior:2026-11-21': 'yes' };
  const availByEmail = { 'a@x': { days }, 'b@x': { days } };
  const game = { id: 'g', grade: 'Senior B09', comp: 'Senior', slots: 1, days: [{ date: '2026-11-21', day: 1 }], alloc: {} };
  // A has fewer games but pulled out of 2 of 3 published appointments; B kept all 5.
  const reliability = rel({ kept: { a: 1, b: 5 }, dropped: { a: 2 } });
  assert.ok(reliability.a < reliability.b);
  const changes = autoAllocate({ games: [structuredClone(game)], umpires, availByEmail, baseLoads: { a: 1, b: 5 }, reliability });
  assert.equal(changes[0].entry.p, 'b');
  // With equal records, fewest games wins as before.
  const even = autoAllocate({ games: [structuredClone(game)], umpires, availByEmail, baseLoads: { a: 1, b: 5 }, reliability: rel({ kept: { a: 1, b: 5 } }) });
  assert.equal(even[0].entry.p, 'a');
});

test('umpires see the published copy, not later work on the board', async () => {
  const { publishedSnapshot, publishedAllocFor } = await import('../js/logic.js');
  const g = { id: 'g', grade: 'Senior B09', slots: 1, days: [{ date: '2026-11-21', day: 1 }], alloc: { '2026-11-21': [{ p: 'a', n: 'A Able' }] } };
  const round = { publishedAlloc: publishedSnapshot([g]) };
  g.alloc['2026-11-21'] = [{ p: 'b', n: 'B Baker' }];                // the officer changes it after publishing
  assert.equal(publishedAllocFor(round, g, '2026-11-21')[0].p, 'a');
  assert.equal(publishedAllocFor({}, g, '2026-11-21')[0].p, 'b', 'rounds published before copies existed use the board');
});

test('in "unavailable or already allocated", allocated umpires come before unavailable ones', async () => {
  const { slotOptions } = await import('../js/logic.js');
  const umpires = [
    { pid: 'a', email: 'a@x', name: 'A Adams', active: true },     // not available
    { pid: 'z', email: 'z@x', name: 'Z Zed', active: true },       // allocated elsewhere that day
  ];
  const availByEmail = { 'a@x': { days: { 'senior:2026-11-21': 'no' } }, 'z@x': { days: { 'senior:2026-11-21': 'yes' } } };
  const game = { id: 'g', grade: 'Senior B09', comp: 'Senior', slots: 1, days: [{ date: '2026-11-21', day: 1 }], alloc: {} };
  const busy = { 'senior:2026-11-21': { z: ['other'] } };
  const rows = slotOptions({ game, date: '2026-11-21', slotIndex: 0, umpires, availByEmail, busy, loads: {} }).filter(r => r.group === 'avoid');
  assert.deepEqual(rows.map(r => r.umpire.pid), ['z', 'a']);
});

test('player umpires elsewhere come after allocated umpires and before unavailable ones', async () => {
  const { slotOptions } = await import('../js/logic.js');
  const umpires = [
    { pid: 'a', email: 'a@x', name: 'A Adams', active: true },     // not available
    { pid: 'm', email: 'm@x', name: 'M Moss', active: true },      // chose another game as a player umpire
    { pid: 'z', email: 'z@x', name: 'Z Zed', active: true },       // allocated elsewhere that day
  ];
  const availByEmail = { 'a@x': { days: { 'senior:2026-11-21': 'no' } }, 'm@x': { days: { 'senior:2026-11-21': 'yes' } }, 'z@x': { days: { 'senior:2026-11-21': 'yes' } } };
  const game = { id: 'g', grade: 'Senior B09', comp: 'Senior', slots: 1, days: [{ date: '2026-11-21', day: 1 }], alloc: {} };
  const busy = { 'senior:2026-11-21': { z: ['other'] } };
  const claimOf = (pid, date, comp) => (pid === 'm' ? 'other2' : null);
  const rows = slotOptions({ game, date: '2026-11-21', slotIndex: 0, umpires, availByEmail, busy, loads: {}, claimOf }).filter(r => r.group === 'avoid');
  assert.deepEqual(rows.map(r => r.umpire.pid), ['z', 'm', 'a']);
});

test('group names are suggested from each association\'s own competition names', async () => {
  const { suggestGroups } = await import('../js/logic.js');
  const names = (org, comps) => suggestGroups(comps, org).groups.map(g => g.name);
  assert.deepEqual(names('Parramatta District Cricket Association', ['PDCA Junior Competition', 'PDCA Senior Competition', 'PDCA Sunday T20']), ['Junior', 'Senior', 'Sunday T20']);   // in the competitions' own order
  assert.deepEqual(names('Sydney Shires Competition', ["Frank Gray Shield (U24's)", 'Sydney Shires Competition']), ['Frank Gray', 'Shires']);
  assert.deepEqual(names('Blacktown City District Cricket Association', ["BCDCA - GIRL'S LEAGUE", 'BCDCA - Senior Competition', 'BCDCA - White Ball Cricket', 'U9 Futures - Season 4']),
    ["Girl's League", 'Senior', 'White Ball', 'U9 Futures']);
  assert.deepEqual(names('NSW Premier Cricket', ["NSW  Premier Cricket (Women's)", "NSW Premier Cricket (Men's)"]), ["Premier (Women's)", "Premier (Men's)"]);
  assert.deepEqual(names('Nepean District Cricket Association', ['Nepean District Cricket Association - Seniors', 'NDCA T20 COMPETITION']), ['Seniors', 'T20']);
  assert.deepEqual(names('Inner West Harbour Junior Cricket Association', ['IWHJCA Cricket Blast Competitions', 'IWHJCA Junior Competition']), ['Blast', 'Junior']);
  // keys are made from the names, so PDCA's Senior and Junior keep the keys its availability is saved under
  assert.deepEqual(suggestGroups(['PDCA Senior Competition', 'PDCA Junior Competition', 'PDCA Sunday T20'], 'Parramatta District Cricket Association').groups.map(g => g.key), ['senior', 'junior', 'sunday-t20']);
});

test('nothing is built in: no group or umpire count is guessed from words like Junior or U24', async () => {
  const { setGroups, guessGroup, suggestUmpires, COMPS } = await import('../js/logic.js');
  const { usePdcaGroups } = await import('./pdca-groups.mjs');
  setGroups({});
  assert.deepEqual(COMPS.map(c => c.key), ['all']);
  assert.equal(guessGroup('PDCA Junior Competition'), null);
  setGroups({ name: 'Sydney Shires Competition', groups: [{ key: 'shires', name: 'Shires' }, { key: 'frank-gray', name: 'Frank Gray' }] });
  assert.equal(guessGroup("Frank Gray Shield (U24's)"), 'frank-gray');
  assert.equal(guessGroup('Sydney Shires Competition'), 'shires');
  assert.deepEqual([suggestUmpires("Frank Gray Shield (U24's)"), suggestUmpires('U10 - 1'), suggestUmpires('Cricket Blast Competition')], [1, 0, 0]);
  usePdcaGroups();
});

test('startSummary: Saturday and Sunday starts are separate lines, each with its own day 2', async () => {
  const { startSummary } = await import('../js/logic.js');
  const g = (sat, d2, type = 'Two Day') => ({ matchType: type, days: [{ date: sat }, ...(d2 ? [{ date: d2 }] : [])] });
  assert.deepEqual(startSummary([g('2026-11-21', '2026-11-28'), g('2026-11-21', '2026-11-28'), g('2026-11-22', '2026-11-29'), g('2026-11-21', null, 'One Day'), g('2026-11-21', null)]), [
    { date: '2026-11-21', n: 1, type: 'One Day', later: [], noLater: 0 },
    { date: '2026-11-21', n: 3, type: 'Two Day', later: ['2026-11-28'], noLater: 1 },   // one listed with no day 2 yet: same line
    { date: '2026-11-22', n: 1, type: 'Two Day', later: ['2026-11-29'], noLater: 0 },
  ]);
});

test('a grade set to None is never on the board, even if its games were given places before', async () => {
  const { setGroups, isPicked, slotCount, groupNeedsUmpires } = await import('../js/logic.js');
  const { PDCA, usePdcaGroups } = await import('./pdca-groups.mjs');
  setGroups({ ...PDCA, gradeGroups: { 'U11 - 1': 'junior', 'U12 Gold': 'junior', 'T20 Mens': 't20' }, gradeUmpires: { 'U11 - 1': 0, 'U12 Gold': 1, 'T20 Mens': 0 } });
  const g = grade => ({ grade, slots: 1, days: [{ date: '2026-11-29' }] });
  assert.deepEqual([isPicked(g('U11 - 1')), slotCount(g('U11 - 1')), isPicked(g('U12 Gold')), slotCount(g('U12 Gold'))], [false, 0, true, 1]);
  assert.deepEqual([groupNeedsUmpires('junior'), groupNeedsUmpires('t20'), groupNeedsUmpires('senior')], [true, false, true]);
  usePdcaGroups();
});

test('a two-day game counts once: per umpire loads and grouped lists', async () => {
  const { recount, byGame, gameCount } = await import('../js/logic.js');
  const g = { id: 'g1', grade: 'Senior A Grade', slots: 1, days: [{ date: '2026-11-28' }, { date: '2026-12-05' }],
    alloc: { '2026-11-28': [{ p: 'u1' }], '2026-12-05': [{ p: 'u1' }] } };
  const r = recount([g]);
  assert.equal(r.filled, 2);                      // two places filled
  assert.deepEqual(r.byUmpire, { u1: 1 });       // but one game for the umpire
  const pulls = [{ roundId: 'r', gameId: 'g1', date: '2026-12-05' }, { roundId: 'r', gameId: 'g1', date: '2026-11-28' }];
  assert.equal(gameCount(pulls), 1);
  assert.deepEqual(byGame(pulls)[0].dates, ['2026-11-28', '2026-12-05']);
});
