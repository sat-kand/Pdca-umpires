import test from 'node:test';
import assert from 'node:assert/strict';
import { joinSettings, joinFieldsFor, missingJoinDetails, canUmpire, setMembershipRequired, membershipOf } from '../js/logic.js';
import { rowToUmpire } from '../js/supabase-map.js';

test('an association with no joining settings asks for a mobile, lists itself and needs approval', () => {
  const s = joinSettings({});
  assert.equal(s.open, true);
  assert.equal(s.membershipRequired, true);
  assert.equal(s.fields.phone, 'required');
  assert.equal(s.fields.dob, 'optional');
});

test('settings are read from the association, ignoring junk values', () => {
  const org = { joining: { open: false, membershipRequired: false, fields: { dob: 'required', address: 'off', phone: 'bogus' } } };
  const s = joinSettings(org);
  assert.equal(s.open, false);
  assert.equal(s.membershipRequired, false);
  assert.deepEqual([s.fields.dob, s.fields.address, s.fields.phone], ['required', 'off', 'required']);
  assert.ok(!joinFieldsFor(org).some(f => f.key === 'address'));
});

test('required details still blank are named; names are always required', () => {
  const org = { joining: { fields: { dob: 'required' } } };
  assert.deepEqual(missingJoinDetails(org, { firstName: 'A', lastName: 'B', phone: '04' }), ['Date of birth']);
  assert.deepEqual(missingJoinDetails(org, {}), ['First name', 'Last name', 'Mobile', 'Date of birth']);
  assert.deepEqual(missingJoinDetails(org, { firstName: 'A', lastName: 'B', phone: ' ', dob: '2000-01-01' }), ['Mobile']);
});

test('someone waiting can be allocated only where membership is not required', () => {
  const waiting = { pid: 'p', email: 'a@b.c', active: false };
  assert.equal(membershipOf(waiting), 'applied');
  setMembershipRequired(true);
  assert.equal(canUmpire(waiting), false);
  setMembershipRequired(false);
  assert.equal(canUmpire(waiting), true);
  assert.equal(canUmpire({ ...waiting, rejected: true }), false);
  assert.equal(canUmpire({ ...waiting, suspended: true }), false);
  setMembershipRequired(true);
});

test('when they asked to join comes back from the membership row', () => {
  assert.equal(rowToUmpire({ pid: 'p', email: 'a@b.c', active: false, created_at: '2026-11-23T01:00:00Z', people: {} }).createdAt, '2026-11-23T01:00:00Z');
});
