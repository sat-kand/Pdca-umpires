import './pdca-groups.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { planMembers, applyMembers, statusFrom, dateFrom, columnsOf } from '../js/import-members.js';
import { memberStatus } from '../js/logic.js';

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

test('a membership file: new members, the file-wide choice for blanks, and rows that cannot be read', () => {
  const types = [{ name: 'Ordinary member' }, { name: 'Junior member' }];
  const plan = planMembers({ text: FILE, members: [], defaultActive: false, types });
  assert.equal(plan.error, '');
  assert.deepEqual(plan.people.map(p => [p.email, p.active, p.membership, p.memberSince]), [
    ['j.smith@example.com', true, 'Ordinary member', '2019-04-15'],
    ['raj@example.com', false, 'Life member', '2012-01-01'],
    ['ann@example.com', false, '', ''],                    // no Status: the officer's choice (inactive here)
  ]);
  assert.deepEqual(plan.unknownTypes, ['Life member']);
  assert.equal(plan.bad.length, 1);
});

test('people already on the list keep their own details; only the association part changes', async () => {
  const saved = [];
  const store = { saveUmpire: async u => saved.push(u) };
  const existing = { pid: 'p1', email: 'raj@example.com', firstName: 'Rajesh', lastName: 'K', name: 'Rajesh K', phone: '0411', active: true };
  const plan = planMembers({ text: FILE, members: [existing], defaultActive: true });
  const res = await applyMembers(store, plan, { newPid: () => 'new', today: '2026-11-19' });
  assert.deepEqual(res, { added: 2, updated: 1 });
  const raj = saved.find(u => u.email === 'raj@example.com');
  assert.deepEqual([raj.name, raj.phone, raj.active, raj.deactivated, raj.memberSince, memberStatus(raj)], ['Rajesh K', '0411', false, true, '2012-01-01', 'inactive']);
  const ann = saved.find(u => u.email === 'ann@example.com');
  assert.deepEqual([ann.name, ann.active, ann.memberSince, memberStatus(ann)], ['Ann Lee', true, '2026-11-19', 'active']);
});

test('the old one-line format still works', () => {
  const plan = planMembers({ text: 'Jane, Smith, jane@example.com, 0400 000 000, L1-2284', members: [] });
  assert.deepEqual(plan.people.map(p => [p.firstName, p.lastName, p.email, p.phone, p.accreditation, p.active]), [['Jane', 'Smith', 'jane@example.com', '0400 000 000', 'L1-2284', true]]);
});

test('member status: applied, active, inactive, not a member', () => {
  assert.deepEqual([{}, { active: true }, { deactivated: true }, { approved: true }, { nonMember: true }, { wantsToUmpire: false }, { approved: true, suspended: true }, { rejected: true }].map(memberStatus),
    ['applied', 'active', 'inactive', 'inactive', 'nonmember', 'applied', 'suspended', 'rejected']);
});
