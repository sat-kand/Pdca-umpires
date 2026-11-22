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
  const [people, mem] = c.calls.filter(x => x.op === 'upsert');
  assert.equal(people.table, 'people');
  assert.equal(mem.table, 'memberships');
  assert.equal(mem.payload.name, undefined);
});

test('saving the association never sends the plan', async () => {
  const { c, s } = await mk({ associations: [{ id: 'pdca', name: 'P', plan: 'trial', config: {} }] });
  await s.useOrg('pdca');
  await s.saveOrg({ name: 'New name', plan: 'active', playhqOrgId: 'abc' });
  const u = c.calls.find(x => x.op === 'update');
  assert.equal(u.payload.plan, undefined);
  assert.equal(u.payload.playhq_org_id, 'abc');
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
  globalThis.location = url; globalThis.history = { replaceState: (_a, _b, to) => { url.search = ''; url.hash = to; } };
  try {
    assert.equal(await s.completeLink(), true);
    assert.equal(await s.completeLink(), false);              // the address no longer carries the code
    assert.equal(exchanged, 1);
    url.search = '?code=def'; fail = true;                    // the exchange fails but a session exists (see fake getSession)
    assert.equal(await s.completeLink(), true);
    url.search = '?code=ghi'; c.auth.getSession = async () => ({ data: { session: null } });
    await assert.rejects(s.completeLink(), /expired/);        // really expired
  } finally { delete globalThis.location; delete globalThis.history; }
});
