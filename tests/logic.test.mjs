import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtRange, gradeShort, compareGrades, groupSections, clubConflict, normClub, allocFor, buildBusyMap,
  assignmentWarnings, slotOptions, recount, autoAllocate, applyChanges, umpireText, seasonLoads, buildCalendar, upcomingCalendar,
} from '../js/logic.js';

const mk = (id, grade, home, away, days, slots = 1, alloc = {}, extra = {}) => ({
  id, comp: 'PDCA Senior Competition', grade, roundName: 'Round 2', matchType: days.length > 1 ? 'Two Day' : 'T20',
  days: days.map((d, i) => ({ day: i + 1, date: d, time: '13:30' })),
  home: { name: home, org: home + ' Cricket Club' }, away: { name: away, org: away + ' Cricket Club' },
  ground: 'Park', slots, alloc, ...extra,
});
const U = (pid, name, clubs = '', active = true) => ({ pid, email: pid + '@x.test', name, clubs, active });
const D1 = '2026-10-10', D2 = '2026-10-17';
const avail = (map) => Object.fromEntries(Object.entries(map).map(([pid, days]) => [pid + '@x.test', { days }]));

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
  assert.equal(s[0].label, 'Round 2 Seniors');
  assert.deepEqual(s[0].games.map(g => g.id), ['3', '1']);
  assert.equal(s[1].label, 'Round 4 Women');
});

test('club conflict matches by club name, ignoring suffixes, and ignores tiny names', () => {
  assert.equal(normClub('Kings Langley Cricket Club'), 'kings langley');
  const g = mk('1', 'Senior A Grade', 'Kings Langley', 'Vone Sports Club', [D1]);
  assert.equal(clubConflict(U('a', 'A', 'Kings Langley CC'), g), true);
  assert.equal(clubConflict(U('a', 'A', 'Vone'), g), true);
  assert.equal(clubConflict(U('a', 'A', 'Winston Hills'), g), false);
  assert.equal(clubConflict(U('a', 'A', 'KL, Winston Hills'), g), false);
  assert.equal(clubConflict(U('a', 'A', ''), g), false);
});

test('allocFor pads to slot count; removed games have no slots', () => {
  const g = mk('1', 'Senior A Grade', 'A', 'B', [D1], 2, { [D1]: [{ p: 'u1', n: 'Ann' }] });
  assert.deepEqual(allocFor(g, D1), [{ p: 'u1', n: 'Ann' }, null]);
  assert.deepEqual(allocFor({ ...g, removed: true }, D1), []);
});

test('warnings: unavailable, no response, double-booked, club conflict, same umpire twice', () => {
  const g1 = mk('1', 'Senior A Grade', 'Kings Langley', 'B', [D1], 2, { [D1]: [{ p: 'u1', n: 'Ann' }, null] });
  const g2 = mk('2', 'Senior B02', 'C', 'D', [D1], 1, { [D1]: [{ p: 'u1', n: 'Ann' }] });
  const busy = buildBusyMap([g1, g2]);
  const ann = U('u1', 'Ann');
  const w = assignmentWarnings({ game: g2, date: D1, slotIndex: 0, umpire: ann, availByEmail: avail({ u1: { [D1]: 'no' } }), busy });
  assert.deepEqual(w, ['Marked unavailable for this day', 'Already umpiring another game this day']);
  const bob = U('u2', 'Bob', 'Kings Langley');
  assert.deepEqual(assignmentWarnings({ game: g1, date: D1, slotIndex: 1, umpire: bob, availByEmail: {}, busy }),
    ['No availability submitted', 'Belongs to the home or away club']);
  assert.ok(assignmentWarnings({ game: g1, date: D1, slotIndex: 1, umpire: ann, availByEmail: avail({ u1: { [D1]: 'yes' } }), busy }).includes('Already in this game'));
  assert.deepEqual(assignmentWarnings({ game: g1, date: D1, slotIndex: 0, umpire: ann, availByEmail: avail({ u1: { [D1]: 'yes' } }), busy: buildBusyMap([g1]) }), []);
});

test('slotOptions groups yes / maybe / no response / avoid and skips inactive umpires', () => {
  const g = mk('1', 'Senior A Grade', 'A', 'B', [D1]);
  const g2 = mk('2', 'Senior B02', 'C', 'D', [D1], 1, { [D1]: [{ p: 'u4', n: 'Dee' }] });
  const umpires = [U('u1', 'Ann'), U('u2', 'Bob'), U('u3', 'Cat'), U('u4', 'Dee'), U('u5', 'Eve'), U('u6', 'Fay', '', false)];
  const a = avail({ u1: { [D1]: 'yes' }, u2: { [D1]: 'maybe' }, u4: { [D1]: 'yes' }, u5: { [D1]: 'no' }, u6: { [D1]: 'yes' } });
  const opts = slotOptions({ game: g, date: D1, slotIndex: 0, umpires, availByEmail: a, busy: buildBusyMap([g, g2]), loads: {} });
  const by = Object.fromEntries(opts.map(o => [o.umpire.name, o.group]));
  assert.deepEqual(by, { Ann: 'ok', Bob: 'maybe', Cat: 'none', Dee: 'avoid', Eve: 'avoid' });
});

test('recount counts slot-days and per-umpire appointments', () => {
  const games = [
    mk('1', 'Senior A Grade', 'A', 'B', [D1, D2], 2, { [D1]: [{ p: 'u1', n: 'Ann' }, { p: 'u2', n: 'Bob' }], [D2]: [{ p: 'u1', n: 'Ann' }] }),
    mk('2', 'Senior B02', 'C', 'D', [D1], 0),
    mk('3', 'Senior B03', 'E', 'F', [D1], 1),
  ];
  const r = recount(games);
  assert.equal(r.games, 2);
  assert.equal(r.needed, 5);
  assert.equal(r.filled, 3);
  assert.deepEqual(r.byUmpire, { u1: 2, u2: 1 });
  assert.deepEqual(seasonLoads([r, { byUmpire: { u1: 4, u9: 1 } }, null]), { u1: 6, u2: 1, u9: 1 });
});

test('autoAllocate: only "yes", no double-booking, no club conflict, balances load, keeps two-day pair', () => {
  const games = [
    mk('1', 'Senior A Grade', 'Kings Langley', 'B', [D1, D2]),
    mk('2', 'Senior B02', 'C', 'D', [D1, D2]),
    mk('3', 'Senior B03', 'E', 'F', [D1]),
  ];
  const umpires = [U('u1', 'Ann', 'Kings Langley'), U('u2', 'Bob'), U('u3', 'Cat'), U('u4', 'Dan')];
  const a = avail({
    u1: { [D1]: 'yes', [D2]: 'yes' }, u2: { [D1]: 'yes', [D2]: 'yes' },
    u3: { [D1]: 'yes', [D2]: 'maybe' }, u4: { [D1]: 'no', [D2]: 'yes' },
  });
  const ch = autoAllocate({ games, umpires, availByEmail: a });
  const apply = g => ({ ...g, alloc: applyChanges(g, ch) });
  const done = games.map(apply);
  const pid = (id, d) => allocFor(done.find(g => g.id === id), d)[0];
  assert.notEqual(pid('1', D1)?.p, 'u1');                 // club conflict (Ann is Kings Langley)
  for (const d of [D1, D2]) {                              // nobody twice on one day
    const ps = done.flatMap(g => allocFor(g, d)).filter(Boolean).map(x => x.p);
    assert.equal(new Set(ps).size, ps.length);
  }
  assert.ok(!allocFor(done[0], D1).some(x => x?.p === 'u4'));  // Dan said no on D1
  assert.ok(!pid('3', D2));                                // game 3 is one-day, nothing on D2
  assert.ok(pid('1', D1) && pid('2', D1) && pid('3', D1));
  // day 2: Cat is only "maybe" so must not be picked
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
  assert.deepEqual(autoAllocate({ games, umpires: [U('u1', 'Ann')], availByEmail: avail({ u1: { [D1]: 'maybe' } }) }), []);
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

test('buildCalendar: two-day rounds become Day 1 / Day 2, one-day games on the same Saturdays are absorbed', () => {
  const [S1, S2, S3, S4, S5] = ['2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07'];
  const games = [
    mk('1', 'Senior A Grade', 'A', 'B', [S1, S2]),
    mk('2', 'Senior Women', 'C', 'D', [S1], 1, {}, { roundName: 'Round 3' }),   // same Saturday as Round 2 Day 1
    mk('3', 'Senior Women', 'C', 'D', [S2], 1, {}, { roundName: 'Round 4' }),   // same Saturday as Round 2 Day 2
    mk('4', 'Senior Women', 'C', 'D', [S3], 1, {}, { roundName: 'Round 5' }),   // a Saturday with only one-day games
    mk('5', 'Senior A Grade', 'A', 'B', [S4, S5], 1, {}, { roundName: 'Round 3' }),
  ];
  const cal = buildCalendar(games);
  assert.deepEqual(cal, [
    { label: 'Round 2', dates: [S1, S2] },
    { label: 'Round 5', dates: [S3] },
    { label: 'Round 3', dates: [S4, S5] },
  ]);
});

test('buildCalendar: duplicate round names stay distinguishable', () => {
  const games = [mk('1', 'Senior A Grade', 'A', 'B', ['2026-10-10', '2026-10-17']), mk('2', 'Senior Women', 'C', 'D', ['2026-12-05'])];
  assert.deepEqual(buildCalendar(games).map(r => r.label), ['Round 2', 'Round 2 (2)']);
});

test('upcomingCalendar hides past dates but keeps Day numbers', () => {
  const cal = [{ label: 'Round 2', dates: ['2026-10-10', '2026-10-17'] }, { label: 'Round 3', dates: ['2026-10-24', '2026-10-31'] }];
  assert.deepEqual(upcomingCalendar(cal, '2026-10-17'), [
    { label: 'Round 2', rows: [{ date: '2026-10-17', dayNo: 2, of: 2 }] },
    { label: 'Round 3', rows: [{ date: '2026-10-24', dayNo: 1, of: 2 }, { date: '2026-10-31', dayNo: 2, of: 2 }] },
  ]);
  assert.deepEqual(upcomingCalendar(cal, '2027-01-01'), []);
  assert.deepEqual(upcomingCalendar(null, '2026-10-17'), []);
});
