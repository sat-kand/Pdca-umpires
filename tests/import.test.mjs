import test from 'node:test';
import './pdca-groups.mjs';
import assert from 'node:assert/strict';
import { parseTable, datesForHeading, answersFor, calendarFor, planImport, applyImport } from '../js/import-availability.js';

const season = {
  id: 's1',
  calendar: [
    { comp: 'senior', label: 'Round 1', dates: ['2026-09-20', '2026-09-27'] },
    { comp: 'senior', label: 'Round 2', dates: ['2026-10-11', '2026-10-18'] },
    { comp: 'senior', label: 'Round 9', dates: ['2026-10-25', '2026-11-01'] },
    { comp: 'senior', label: 'Round 5', dates: ['2026-11-22'] },
    { comp: 'junior', dates: ['2026-09-20'] },
  ],
};
const cal = calendarFor(season, 'senior');

test('a sheet is read as tabs when it has them, so "Day 1, Day 2" stays one cell', () => {
  assert.deepEqual(parseTable('a\tb, c\nd\te'), [['a', 'b, c'], ['d', 'e']]);
  assert.deepEqual(parseTable('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseTable('name,"Smith, J"'), [['name', 'Smith, J']], 'quoted commas still work in CSV');
  assert.deepEqual(parseTable(''), []);
});

test('a column heading is matched to the season dates', () => {
  assert.deepEqual(datesForHeading('Round 1 - 20th & 27th Sep', cal), ['2026-09-20', '2026-09-27'], 'by round name');
  assert.deepEqual(datesForHeading('11th  & 18th Oct', cal), ['2026-10-11', '2026-10-18'], 'by the dates written in it');
  assert.deepEqual(datesForHeading('Round 9 : 25th Oct & 1st Nov', cal), ['2026-10-25', '2026-11-01'], 'across two months');
  assert.deepEqual(datesForHeading('Round 5 : 22nd Nov', cal), ['2026-11-22']);
  assert.deepEqual(datesForHeading('Name', cal), [], 'nothing to match');
  assert.deepEqual(datesForHeading('7th & 14th Mar', cal), [], 'dates that are not in this season');
  assert.deepEqual(calendarFor(season, 'junior').dates, ['2026-09-20']);
});

test('a cell becomes one answer per date of its column', () => {
  const two = ['2026-09-20', '2026-09-27'];
  assert.deepEqual(answersFor('Day 1, Day 2', two).answers, { '2026-09-20': 'yes', '2026-09-27': 'yes' });
  assert.deepEqual(answersFor('Day 2', two).answers, { '2026-09-20': 'no', '2026-09-27': 'yes' });
  assert.deepEqual(answersFor('Not Available', two).answers, { '2026-09-20': 'no', '2026-09-27': 'no' });
  assert.deepEqual(answersFor('Yes', ['2026-11-22']).answers, { '2026-11-22': 'yes' });
  assert.deepEqual(answersFor('no', ['2026-11-22']).answers, { '2026-11-22': 'no' });
  assert.deepEqual(answersFor('', two), { answers: {}, known: true }, 'blank means not answered');
  assert.deepEqual(answersFor('ask me later', two), { answers: {}, known: false }, 'anything else is reported, not guessed');
});

const members = [
  { pid: 'p1', email: 'gerry@x.test', firstName: 'Gerry', lastName: 'Smith', name: 'Gerry Smith', active: true },
  { pid: 'p2', email: 'nn@x.test', name: 'Naresh Narendiran', active: true },
];
const SHEET = ['Name\tRound 1 - 20th & 27th Sep\tRound 2  - 11th  & 18th Oct\tRound 5 : 22nd Nov\tNotes',
  'Gerry Smith\tDay 1, Day 2\tDay 2\tYes\tx',
  'naresh narendiran\tNot Available\tNot Available\tNo\t',
  'Pat Stranger\tDay 1\t\tmaybe\t'].join('\n');

test('a pasted sheet is planned before anything is written', () => {
  const plan = planImport({ text: SHEET, comp: 'senior', season, members, availability: [] });
  assert.equal(plan.error, '');
  assert.deepEqual(plan.used.map(c => c.dates.length), [2, 2, 1]);
  assert.deepEqual(plan.unmatchedColumns, ['Notes'], 'a column with no dates is reported and skipped');
  assert.equal(plan.matched, 2);
  assert.deepEqual(plan.strangers.map(p => p.name), ['Pat Stranger']);

  const [gerry, naresh, pat] = plan.people;
  assert.equal(gerry.member.pid, 'p1');
  assert.deepEqual(gerry.days, {
    'senior:2026-09-20': 'yes', 'senior:2026-09-27': 'yes',
    'senior:2026-10-11': 'no', 'senior:2026-10-18': 'yes',
    'senior:2026-11-22': 'yes',
  });
  assert.equal(naresh.member.pid, 'p2', 'names match whatever the capitals');
  assert.equal(naresh.no, 5);
  assert.equal(pat.unknown, 1, '"maybe" is counted as not understood');
  assert.equal(plan.people.length, 3);

  assert.match(planImport({ text: 'Name', comp: 'senior', season, members }).error, /heading row/);
  assert.match(planImport({ text: SHEET, comp: 't20', season, members }).error, /no dates/);
});

function fakeStore() {
  const umpires = new Map(members.map(m => [m.email, { ...m }]));
  const avail = new Map();
  return {
    umpires, avail,
    saveUmpire: async u => umpires.set(u.email, u),
    getAvailability: async (sid, email) => avail.get(email) || null,
    saveAvailability: async a => avail.set(a.email, a),
  };
}

test('importing writes availability and can add the people it does not know', async () => {
  const store = fakeStore();
  store.avail.set('gerry@x.test', { seasonId: 's1', email: 'gerry@x.test', days: { 'junior:2026-09-20': 'yes', 'senior:2026-09-20': 'no' } });
  const plan = planImport({ text: SHEET, comp: 'senior', season, members, availability: [...store.avail.values()] });

  const res = await applyImport(store, plan, { comp: 'senior', season, addStrangers: false, newPid: () => 'new1' });
  assert.deepEqual(res, { saved: 2, added: 0, skipped: 1, noEmail: 0 });
  assert.equal(store.avail.get('gerry@x.test').days['junior:2026-09-20'], 'yes', 'another competition is left alone');
  assert.equal(store.avail.get('gerry@x.test').days['senior:2026-09-20'], 'yes', 'the sheet wins for its own dates');
  assert.equal(store.umpires.size, 2, 'nobody is added unless asked');

  const withEmail = planImport({
    text: 'Name\tEmail\tRound 5 : 22nd Nov\nPat Stranger\tpat@x.test\tYes\nNo Email\t\tYes',
    comp: 'senior', season, members, availability: [],
  });
  const res2 = await applyImport(store, withEmail, { comp: 'senior', season, addStrangers: true, newPid: () => 'new1' });
  assert.deepEqual(res2, { saved: 1, added: 1, skipped: 1, noEmail: 1 }, 'someone with no email address cannot be added');
  const pat = store.umpires.get('pat@x.test');
  assert.equal(pat.active, false, 'people added this way are not members');
  assert.deepEqual([pat.firstName, pat.lastName], ['Pat', 'Stranger']);
  assert.equal(store.avail.get('pat@x.test').days['senior:2026-11-22'], 'yes');
});
