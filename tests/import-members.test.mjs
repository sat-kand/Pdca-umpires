import './pdca-groups.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { planMembers, applyMembers, statusFrom, dateFrom, columnsOf } from '../js/import-members.js';
import { memberStatus, membershipOf } from '../js/logic.js';

const FILE = [
  'First name\tLast name\tEmail\tMobile\tMembership type\tMember since\tStatus',
  'Jane\tSmith\tJ.Smith@Example.com\t0400 000 000\tordinary member\t15/04/2019\tActive',
  'Raj\tKumar\traj@example.com\t\tLife member\t2012\tInactive',
  'Ann\tLee\tann@example.com\t\t\t\t',
  'No\tEmail\t\t\t\t\t',
].join('\n');

test('columns are found by their headings, in any order', () => {
  assert.deepEqual(columnsOf(['Email Address', 'Surname', 'Given name', 'Umpiring?']), { email: 0, lastName: 1, firstName: 2, status: 3 });
});

test('status and dates are read the way associations write them', () => {
  assert.deepEqual(['Active', 'yes', 'Umpire', 'Inactive', 'No', 'Member only', '', 'maybe'].map(statusFrom), [true, true, true, false, false, false, null, null]);
  assert.deepEqual(['15/04/2019', '2019-4-5', '2012', 'x'].map(dateFrom), ['2019-04-15', '2019-04-05', '2012-01-01', '']);
});

test('a membership file: everyone becomes a member; rows that cannot be read are skipped', () => {
  const types = [{ name: 'Ordinary member' }, { name: 'Junior member' }];
  const plan = planMembers({ text: FILE, members: [], types });
  assert.equal(plan.error, '');
  assert.deepEqual(plan.people.map(p => [p.email, p.membership, p.status]), [
    ['j.smith@example.com', 'Ordinary member', 'new'],
    ['raj@example.com', 'Life member', 'new'],
    ['ann@example.com', '', 'new'],
  ]);
  assert.equal(plan.people[0].memberSince, undefined, 'member since is not read any more');
  assert.deepEqual(plan.unknownTypes, ['Life member']);
  assert.equal(plan.bad.length, 1);
});

test('people already on the list: blanks filled in, their own details kept; new, updated or existing', async () => {
  const saved = [];
  const store = { saveUmpire: async u => saved.push(u) };
  const existing = { pid: 'p1', email: 'raj@example.com', firstName: 'Rajesh', lastName: 'K', name: 'Rajesh K', phone: '0411', approved: true };
  const suspended = { pid: 'p2', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee', name: 'A Lee', approved: true, suspended: true, active: false };
  const file = FILE.replace('raj@example.com\t', 'raj@example.com\t0499 999 999').replace('Raj\tKumar', 'Raj\tKumar');
  const plan = planMembers({ text: FILE + '\n', members: [existing, suspended] });
  assert.deepEqual(plan.people.map(p => [p.email, p.status]), [['j.smith@example.com', 'new'], ['raj@example.com', 'updated'], ['ann@example.com', 'existing']]);
  assert.deepEqual(plan.people[1].changes, ['Membership type'], 'Raj: a new membership type; his own name is kept');
  assert.deepEqual(plan.people[1].kept, ['First name', 'Last name']);
  assert.deepEqual([plan.added.length, plan.updated.length, plan.unchanged.length], [1, 1, 1]);
  const res = await applyMembers(store, plan, { newPid: () => 'new' });
  assert.deepEqual(res, { added: 1, updated: 1, unchanged: 1 });
  assert.equal(saved.find(u => u.email === 'ann@example.com'), undefined, 'nothing to change: not written');
  const raj = saved.find(u => u.email === 'raj@example.com');
  assert.deepEqual([raj.name, raj.phone, raj.membership, membershipOf(raj)], ['Rajesh K', '0411', 'Life member', 'member']);
  // A blank mobile is filled in from the file; one they have is kept.
  const blank = { ...existing, phone: '', membership: 'Life member' };
  const p2 = planMembers({ text: FILE.replace('raj@example.com\t\t', 'raj@example.com\t0499 999 999\t'), members: [blank] });
  const r2 = p2.people.find(p => p.email === 'raj@example.com');
  assert.deepEqual([r2.status, r2.changes, r2.fills.phone], ['updated', ['Mobile'], '0499 999 999']);
  const p3 = planMembers({ text: FILE.replace('raj@example.com\t\t', 'raj@example.com\t0499 999 999\t'), members: [{ ...existing, membership: 'Life member' }] });
  assert.deepEqual([p3.people.find(p => p.email === 'raj@example.com').status, p3.people.find(p => p.email === 'raj@example.com').kept], ['existing', ['First name', 'Last name', 'Mobile']]);
  const jane = saved.find(u => u.email === 'j.smith@example.com');
  assert.deepEqual([jane.name, membershipOf(jane), memberStatus(jane, null)], ['Jane Smith', 'member', 'inactive']);   // no availability yet
});

test('the old one-line format still works', () => {
  const plan = planMembers({ text: 'Jane, Smith, jane@example.com, 0400 000 000, L1-2284', members: [] });
  assert.deepEqual(plan.people.map(p => [p.firstName, p.lastName, p.email, p.phone, p.accreditation]), [['Jane', 'Smith', 'jane@example.com', '0400 000 000', 'L1-2284']]);
});

test('Active umpire or Inactive umpire follows availability, for members only', () => {
  const m = { approved: true };
  assert.deepEqual([
    memberStatus(m, null),                                                   // no answer
    memberStatus(m, { days: { 'senior:2026-11-21': 'no', 'junior:2026-11-22': 'no' } }),   // Not available to everything
    memberStatus(m, { days: { 'senior:2026-11-21': 'no', 'junior:2026-11-22': 'yes' } }),  // one Available is enough
    memberStatus(m, { days: {}, picks: [{ gameId: 'g1' }] }),                // a game chosen as a player umpire
    memberStatus({}, { days: { 'senior:2026-11-21': 'yes' } }),              // applied: not a member yet
    memberStatus({ approved: true, suspended: true }, { days: { 'senior:2026-11-21': 'yes' } }),
    memberStatus({ rejected: true }, null), memberStatus({ nonMember: true }, null),
    memberStatus({ active: true }, null), memberStatus({ deactivated: true }, { days: { 'x:1': 'yes' } }),   // older records
  ], ['inactive', 'inactive', 'active', 'active', 'applied', 'suspended', 'rejected', 'nonmember', 'inactive', 'active']);
});

test("an association's own form layout (PDCA's membership form) is matched by its headings", async () => {
  const { matchColumns, providerGuess, phoneFrom } = await import('../js/import-members.js');
  const head = ['Email address', 'First Name', 'Last Name', 'Membership Type:', 'D.O.B(If under 18)', 'Address', 'Contact number', 'Eligibility to umpire?', 'Membership/Card number If passed NSWCUSA'];
  assert.deepEqual(matchColumns(head), { email: 0, firstName: 1, lastName: 2, membership: 3, dob: 4, address: 5, phone: 6, accreditationProvider: 7, accreditation: 8 });
  assert.deepEqual(matchColumns(head, { address: '', 'contact number': 'address' }), { email: 0, firstName: 1, lastName: 2, membership: 3, dob: 4, address: 6, accreditationProvider: 7, accreditation: 8 }, 'saved choices win, and an ignored column stays ignored');
  assert.equal(providerGuess('I have passed the NSWCUSA Course'), 'NSW Cricket Umpires & Scorers Association');
  assert.equal(providerGuess('I have passed the PDCUA Course'), 'PDCUA');
  assert.equal(providerGuess('I have obtained Cricket Australia Accreditation'), 'Cricket Australia');
  assert.equal(phoneFrom('423387957'), '0423387957');
  assert.equal(dateFrom('29289'), '1980-03-09', 'an Excel date number');
});

test('chosen columns and translated answers are used; a first name holding the whole name is trimmed', () => {
  const rows = [['Mail', 'Who', 'Family', 'Kind'], ['a@x.com', 'Ann Lee', 'Lee', 'Existing Member'], ['b@x.com', 'Bo', 'Ng', 'New Member']];
  const plan = planMembers({ rows, cols: { email: 0, firstName: 1, lastName: 2, membership: 3 }, values: { membership: { 'existing member': 'Ordinary', 'new member': '' } } });
  assert.equal(plan.error, '');
  assert.deepEqual(plan.people.map(p => [p.firstName, p.lastName, p.membership]), [['Ann', 'Lee', 'Ordinary'], ['Bo', 'Ng', '']]);
});
