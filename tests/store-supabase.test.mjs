// The Supabase store against a tiny fake client: checks what it asks the database for, not the database itself
// (row-level security is tested separately by supabase/tests/run-rls.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStore } from '../js/store-supabase.js';

function fake(tables = {}) {
  const calls = [];
  const builder = (table, op = 'select', payload) => {
    const q = { filters: [], range: null };
    const run = () => {
      calls.push({ table, op, payload, filters: q.filters, range: q.range });
      let rows = tables[table] || [];
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      return Promise.resolve({ data: op === 'select' ? rows : null, error: null });
    };
    const chain = new Proxy({}, { get: (_, k) => {
      if (k === 'then') return (a, b) => run().then(a, b);
      if (k === 'range') return (a, b) => { q.range = [a, b]; return chain; };
      if (k === 'limit') return n => { q.range = [0, n - 1]; return chain; };
      return (...args) => { q.filters.push([k, ...args]); return chain; };
    } });
    return chain;
  };
  const client = {
    calls,
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'Off@X.test' } } } }) },
    from: t => ({ select: () => builder(t), upsert: p => builder(t, 'upsert', p), insert: p => builder(t, 'insert', p), update: p => builder(t, 'update', p), delete: () => builder(t, 'delete') }),
    rpc: (fn, args) => { calls.push({ rpc: fn, args }); return Promise.resolve({ data: 1, error: null }); },
  };
  return client;
}

const mk = async (tables) => { const c = fake(tables); const s = await createSupabaseStore({ url: 'u', anonKey: 'k' }, { createClient: () => c }); return { c, s }; };

test('saving games sends them to save_games in batches of 100, as rows', async () => {
  const { c, s } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }] });
  await s.useOrg('pdca');
  const g = i => ({ id: 'g' + i, grade: 'A', home: { name: 'H' }, away: { name: 'A' }, days: [{ day: 1, date: '2026-10-24', time: '13:30' }], slots: 1, alloc: { '2026-10-24': [{ p: 'p1', n: 'x' }] } });
  await s.saveGames('r1', Array.from({ length: 250 }, (_, i) => g(i)));
  const rpcs = c.calls.filter(x => x.rpc);
  assert.deepEqual(rpcs.map(x => x.args.items.length), [100, 100, 50]);
  assert.equal(rpcs[0].args.aid, 'pdca');
  assert.equal(rpcs[0].args.items[0].appts[0].pid, 'p1');
});

test('lists page through more than 1000 rows', async () => {
  const members = Array.from({ length: 2300 }, (_, i) => ({ association_id: 'pdca', email: `u${i}@x.test`, pid: 'p' + i, active: true, people: {} }));
  const { s } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }], memberships: members });
  await s.useOrg('pdca');
  assert.equal((await s.listUmpires()).length, 2300);
});

test('an officer adding a member never overwrites an existing person record', async () => {
  const { c, s } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }] });
  await s.useOrg('pdca');
  await s.onAuth(() => {}); await new Promise(r => setTimeout(r, 0));   // learns who is signed in
  await s.saveUmpire({ pid: 'p9', email: 'new@x.test', name: 'New', phone: '1', active: true });
  const add = c.calls.find(x => x.rpc === 'officer_add_person');
  assert.equal(add.args.aid, 'pdca');
  assert.equal(add.args.p.email, 'new@x.test');
  assert.equal(c.calls.filter(x => x.table === 'people' && x.op === 'upsert').length, 0, 'no direct write to people');
  const [mem] = c.calls.filter(x => x.op === 'upsert');
  assert.equal(mem.table, 'memberships');
  assert.equal(mem.payload.name, undefined);
});

test('saving the association never sends the plan, the flags or the PlayHQ organisation (the platform owner sets those)', async () => {
  const { c, s } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }] });
  await s.useOrg('pdca');
  await s.saveOrg({ name: 'New name', plan: 'active', playhqOrgId: 'abc' });
  const u = c.calls.find(x => x.op === 'update');
  assert.equal(u.payload.plan, undefined);
  assert.equal(u.payload.playhq_org_id, undefined);
  assert.equal((u.payload.config || {}).flags, undefined);
});

test('useOrg reads the association\'s feature flags: defaults first, then its own', async () => {
  const { s } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }],
    feature_flags: [{ key: 'player_umpire', enabled_by_default: false }, { key: 'clash_checks', enabled_by_default: true }],
    association_flags: [{ key: 'player_umpire', enabled: true }] });
  const o = await s.useOrg('pdca');
  assert.deepEqual(o.flags, { player_umpire: true, clash_checks: true });
});

test('playhq asks the Edge Function for the open association and surfaces its error message', async () => {
  const { c, s } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }] });
  const sent = [];
  let reply = { data: { seasons: [] }, error: null };
  c.functions = { invoke: async (name, opts) => { sent.push([name, opts.body]); return reply; } };
  await s.useOrg('pdca');
  assert.deepEqual(await s.playhq('seasons'), { seasons: [] });
  assert.deepEqual(sent[0], ['playhq', { action: 'seasons', associationId: 'pdca' }]);
  await s.playhq('check', { orgId: 'abc' });
  assert.equal(sent[1][1].orgId, 'abc');
  reply = { data: { error: 'PlayHQ has no organisation with that ID.' }, error: null };
  await assert.rejects(s.playhq('check', { orgId: 'x' }), /no organisation/);
  reply = { data: null, error: { message: 'boom' } };
  await assert.rejects(s.playhq('seasons'), /Could not reach the fixture service/);
});

test('completeLink: the code is used once; a second start-up or an already signed-in browser is not an error', async () => {
  const c = fake();
  let exchanged = 0, fail = false;
  c.auth.exchangeCodeForSession = async () => { exchanged++; return { error: fail ? { message: 'used' } : null }; };
  const s = await createSupabaseStore({ url: 'u', anonKey: 'k' }, { createClient: () => c });
  const url = { search: '?code=abc', pathname: '/' };
  globalThis.location = url; globalThis.history = { replaceState: (_a, _b, to) => { url.search = ''; url.hash = ''; url.pathname = to; } };
  try {
    assert.equal(await s.completeLink(), true);
    assert.equal(await s.completeLink(), false);              // the address no longer carries the code
    assert.equal(exchanged, 1);
    url.search = '?code=def'; fail = true;                    // the exchange fails but a session exists (see fake getSession)
    assert.equal(await s.completeLink(), true);
    url.search = '?code=ghi'; c.auth.getSession = async () => ({ data: { session: null } });
    await assert.rejects(s.completeLink(), e => e.signInLink && /cannot be used/.test(e.message) && /used already/.test(e.message) && /different browser/.test(e.message));
  } finally { delete globalThis.location; delete globalThis.history; }
});

test('completeLink: an already-used emailed link comes back with error_code in the address', async () => {
  const c = fake();
  const s = await createSupabaseStore({ url: 'u', anonKey: 'k' }, { createClient: () => c });
  const url = { search: '', hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', pathname: '/' };
  globalThis.location = url; globalThis.history = { replaceState: (_a, _b, to) => { url.search = ''; url.hash = ''; url.pathname = to; } };
  try {
    assert.equal(await s.completeLink(), true);                  // signed in already (fake getSession): no error
    assert.equal(url.hash, ''); assert.equal(url.pathname, '/');  // and the address is cleaned up
    url.search = '?error=access_denied&error_code=otp_expired'; url.hash = '';
    c.auth.getSession = async () => ({ data: { session: null } });
    await assert.rejects(s.completeLink(), e => e.signInLink && /cannot be used/.test(e.message));   // not signed in: say so, offer a new link
    assert.equal(url.search, '');
  } finally { delete globalThis.location; delete globalThis.history; }
});

test('signOut: still ends the session in this browser when the server call fails', async () => {
  const c = fake(); const calls = [];
  c.auth.signOut = async o => { calls.push(o); if (!o) return { error: new Error('network') }; return { error: null }; };
  const s = await createSupabaseStore({ url: 'u', anonKey: 'k' }, { createClient: () => c });
  await s.signOut();
  assert.deepEqual(calls, [undefined, { scope: 'local' }]);
});

test('saveWithdrawal: an officer handling a pull-out updates it (an upsert is checked as an insert and fails); a new one is inserted', async () => {
  const { c, s } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }], withdrawals: [{ association_id: 'pdca', id: 'w1', email: 'u@x.test', pid: 'p1', handled: false, data: {} }] });
  await s.useOrg('pdca');
  await s.saveWithdrawal({ id: 'w1', handled: true });
  const ops = c.calls.filter(x => x.table === 'withdrawals').map(x => x.op);
  assert.ok(ops.includes('update') && !ops.includes('upsert'), `ops: ${ops}`);
  const { c: c2, s: s2 } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }], withdrawals: [] });
  await s2.useOrg('pdca');
  await s2.saveWithdrawal({ id: 'w2', email: 'u@x.test', pid: 'p1', handled: false });
  const ops2 = c2.calls.filter(x => x.table === 'withdrawals').map(x => x.op);
  assert.ok(ops2.includes('insert') && !ops2.includes('upsert'), `ops: ${ops2}`);
});

test('password sign-in is only for the @thirdumpire.test accounts', async () => {
  const c = fake();
  const seen = [];
  c.auth.signInWithPassword = async a => { seen.push(a); return { error: null }; };
  const s = await createSupabaseStore({ url: 'u', anonKey: 'k' }, { createClient: () => c });
  await s.signInPassword('test-umpire@thirdumpire.test', 'pw');
  assert.deepEqual(seen, [{ email: 'test-umpire@thirdumpire.test', password: 'pw' }]);
  await assert.rejects(s.signInPassword('someone@gmail.com', 'pw'), /test accounts/);
  assert.equal(seen.length, 1, 'a real address never reaches the password sign-in');
});
