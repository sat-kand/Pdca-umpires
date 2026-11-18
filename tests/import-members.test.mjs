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
  assert.deepEqual(plan.people.map(p => [p.email, p.membership, p.memberSince]), [
    ['j.smith@example.com', 'Ordinary member', '2019-04-15'],
    ['raj@example.com', 'Life member', '2012-01-01'],
    ['ann@example.com', '', ''],
  ]);
  assert.deepEqual(plan.unknownTypes, ['Life member']);
  assert.equal(plan.bad.length, 1);
});

test('people already on the list keep their own details; only the association part changes', async () => {
  const saved = [];
  const store = { saveUmpire: async u => saved.push(u) };
  const existing = { pid: 'p1', email: 'raj@example.com', firstName: 'Rajesh', lastName: 'K', name: 'Rajesh K', phone: '0411' };
  const suspended = { pid: 'p2', email: 'ann@example.com', name: 'A Lee', approved: true, suspended: true, active: false };
  const plan = planMembers({ text: FILE, members: [existing, suspended] });
  const res = await applyMembers(store, plan, { newPid: () => 'new', today: '2026-11-19' });
  assert.deepEqual(res, { added: 1, updated: 2 });
  const raj = saved.find(u => u.email === 'raj@example.com');
  assert.deepEqual([raj.name, raj.phone, raj.memberSince, membershipOf(raj)], ['Rajesh K', '0411', '2012-01-01', 'member']);
  assert.equal(membershipOf(saved.find(u => u.email === 'ann@example.com')), 'suspended');      // a suspension stays
  const jane = saved.find(u => u.email === 'j.smith@example.com');
  assert.deepEqual([jane.name, membershipOf(jane), memberStatus(jane, null)], ['Jane Smith', 'member', 'inactive']);   // no availability yet
});

test('the old one-line format still works', () => {
  const plan = planMembers({ text: 'Jane, Smith, jane@example.com, 0400 000 000, L1-2284', members: [] });
  assert.deepEqual(plan.people.map(p => [p.firstName, p.lastName, p.email, p.phone, p.accreditation]), [['Jane', 'Smith', 'jane@example.com', '0400 000 000', 'L1-2284']]);
});

test('Active umpire or Inactive member follows availability, for members only', () => {
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
