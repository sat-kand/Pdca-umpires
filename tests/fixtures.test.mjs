import { test } from 'node:test';
import './pdca-groups.mjs';
import assert from 'node:assert/strict';
import { normaliseMatch, loadFixtures, gamesFromCsv, parseDate, mergeFixtures } from '../js/fixtures.js';

// Shape captured from the live PDCA service (Senior B02, Round 2).
const apiMatch = {
  id: '0a5ee9ec-4e4a-4831-8f8c-69a64d43d446', status: 'COMPLETED', matchType: 'Two Day',
  round: { id: 'r', name: 'Round 2', shortName: 'R2' },
  matchSchedule: [
    { matchDay: 2, startDateTime: '2026-10-17T13:30:00.0000000+11:00' },
    { matchDay: 1, startDateTime: '2026-10-10T13:30:00.0000000+11:00' },
  ],
  venue: { name: 'Harold West Reserve', line1: 'Moseley St, Carlingford', suburb: 'PARRAMATTA',
    playingSurface: { name: 'Harold West Reserve', latitude: -33.7755, longitude: 151.0492222 } },
  teams: [
    { id: 't1', displayName: 'Western Legends NR', isHome: true, owningOrganisation: { name: 'Western Legends Cricket Club' } },
    { id: 't2', displayName: 'Wenty Leagues', isHome: false, owningOrganisation: { name: 'Wenty Leagues Cricket Club' } },
  ],
};
const grade = { id: 'g1', name: 'Senior B02' };
const comp = { id: 'c1', name: 'PDCA Senior Competition' };

test('normaliseMatch sorts days, keeps local date, finds home/away and ground', () => {
  const g = normaliseMatch(apiMatch, grade, comp);
  assert.deepEqual(g.days, [
    { day: 1, date: '2026-10-10', time: '13:30' },
    { day: 2, date: '2026-10-17', time: '13:30' },
  ]);
  assert.equal(g.home.name, 'Western Legends NR');
  assert.equal(g.away.org, 'Wenty Leagues Cricket Club');
  assert.equal(g.ground, 'Harold West Reserve');
  assert.equal(g.roundName, 'Round 2');
  assert.equal(g.lat, -33.7755);
});

test('normaliseMatch combines venue and a differently-named playing surface', () => {
  const m = { ...apiMatch, venue: { name: 'Stringer Road Reserve', playingSurface: { name: 'Oval 2' } } };
  assert.equal(normaliseMatch(m, grade, comp).ground, 'Stringer Road Reserve – Oval 2');
  const m2 = { ...apiMatch, venue: { name: 'Granville Park', playingSurface: { name: 'Granville Park Oval 2 Upper' } } };
  assert.equal(normaliseMatch(m2, grade, comp).ground, 'Granville Park Oval 2 Upper');
});

test('byes and games without a schedule are skipped', () => {
  assert.equal(normaliseMatch({ matchType: 'BYE', matchSchedule: [] }, grade, comp), null);
  assert.equal(normaliseMatch({ ...apiMatch, matchSchedule: [] }, grade, comp), null);
});

test('loadFixtures filters by first-day date window across grades', async () => {
  const later = { ...apiMatch, id: 'later', matchSchedule: [{ matchDay: 1, startDateTime: '2026-10-24T13:30:00.0000000+11:00' }] };
  const api = async path => ({ matches: path.includes('/g1/') ? [apiMatch, later, { matchType: 'BYE', matchSchedule: [] }] : [] });
  const comps = [{ ...comp, grades: [{ id: 'g1', name: 'Senior B02' }, { id: 'g2', name: 'Senior B03' }] }];
  const res = await loadFixtures({ api, comps, from: '2026-10-10', to: '2026-10-17' });
  assert.equal(res.length, 1);
  assert.equal(res[0].id, apiMatch.id);
});

test('parseDate handles ISO and Australian d/m/yyyy', () => {
  assert.equal(parseDate('2026-10-10'), '2026-10-10');
  assert.equal(parseDate('10/10/2026'), '2026-10-10');
  assert.equal(parseDate('3/1/26'), '2026-01-03');
  assert.equal(parseDate('soon'), null);
});

test('CSV import: quotes, two-day games, errors reported per row', () => {
  const csv = 'Grade,Home,Away,Ground,Date,Day 2,Time\r\n' +
    'Senior A Grade,"GLCC Senior Maroon","Baulkham Hills","McCredie Park",10/10/2026,17/10/2026,13:30\r\n' +
    'B1,Kings Langley,Vone,Pearce Reserve,not-a-date,,\r\n';
  const { games, errors } = gamesFromCsv(csv);
  assert.equal(games.length, 1);
  assert.equal(games[0].days.length, 2);
  assert.equal(games[0].days[1].date, '2026-10-17');
  assert.equal(games[0].matchType, 'Two Day');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Row 3/);
});

test('CSV import: same fixture gets the same id (so re-import keeps allocations)', () => {
  const csv = 'grade,home,away,date\nB1,A,B,2026-10-10\n';
  assert.equal(gamesFromCsv(csv).games[0].id, gamesFromCsv(csv).games[0].id);
});

test('CSV import: missing required column is a clear error', () => {
  assert.throws(() => gamesFromCsv('grade,home\nA,B\n'), /Missing column: away/);
});

test('mergeFixtures keeps allocations, notes changes, flags removed games', () => {
  const base = normaliseMatch(apiMatch, grade, comp);
  const existing = [
    { ...base, slots: 2, alloc: { '2026-10-10': [{ p: 'u1', n: 'Ann' }] } },
    { ...normaliseMatch({ ...apiMatch, id: 'gone' }, grade, comp), slots: 1, alloc: {} },
  ];
  const moved = normaliseMatch({ ...apiMatch, venue: { name: 'Other Park', playingSurface: { name: 'Other Park' } } }, grade, comp);
  const fresh = [moved, normaliseMatch({ ...apiMatch, id: 'new' }, grade, comp)];
  const r = mergeFixtures(existing, fresh, () => 1);
  assert.equal(r.added, 1); assert.equal(r.changed, 1); assert.equal(r.removed, 1);
  const kept = r.games.find(g => g.id === base.id);
  assert.equal(kept.slots, 2);
  assert.equal(kept.alloc['2026-10-10'][0].n, 'Ann');
  assert.match(kept.changeNote, /Ground/);
  assert.equal(r.games.find(g => g.id === 'gone').removed, true);
  assert.equal(r.games.find(g => g.id === 'new').slots, 1);
});

test('mergeFixtures with no differences writes nothing', () => {
  const base = { ...normaliseMatch(apiMatch, grade, comp), slots: 1, alloc: {}, removed: false };
  const r = mergeFixtures([base], [normaliseMatch(apiMatch, grade, comp)]);
  assert.equal(r.games.length, 0);
});

test('mergeFixtures: a game that has not changed is not rewritten, whatever order its keys come back in', async () => {
  const { mergeFixtures } = await import('../js/fixtures.js');
  const fresh = { id: 'g1', grade: 'A', comp: 'c', home: 'X', away: 'Y', venue: 'V', status: 'UPCOMING', days: [{ day: 1, date: '2026-12-05', time: '13:30' }] };
  const stored = { slots: 1, alloc: {}, removed: false, days: [{ time: '13:30', date: '2026-12-05', day: 1 }], ...fresh };   // same game, keys in another order
  stored.days = [{ time: '13:30', date: '2026-12-05', day: 1 }];
  assert.equal(mergeFixtures([stored], [fresh]).games.length, 0);
  assert.equal(mergeFixtures([stored], [{ ...fresh, ground: 'W' }]).games.length, 1);
});

test('mergeFixtures: a game that is back in the list loses its "No longer in the fixture list" warning', () => {
  const g = { id: 'a', grade: 'G', home: { name: 'H' }, away: { name: 'A' }, days: [{ date: '2026-11-21', day: 1, time: '10:00' }], slots: 2, alloc: {} };
  const gone = mergeFixtures([g], []).games[0];
  assert.equal(gone.removed, true); assert.match(gone.changeNote, /No longer/);
  const back = mergeFixtures([gone], [g]).games[0];
  assert.ok(!back.removed); assert.ok(!back.changeNote);
  const stuck = mergeFixtures([{ ...g, changeNote: 'No longer in the fixture list' }], [g]).games[0];   // flagged earlier, restored, note left behind
  assert.ok(!stuck.changeNote);
});
