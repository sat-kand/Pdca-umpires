// Live back-end: Supabase Auth + Postgres. Same interface as store-demo.js, so the app code is identical.
// Every association's data is kept apart by row-level security (supabase/migrations/0002_rls.sql);
// nothing here relies on the browser being honest.
// Loaded lazily from a CDN so demo mode needs no network at all.

import { SUPABASE_SDK } from './config.js';
import { fixtureList } from './rounds.js';
import {
  orgToRow, rowToOrg, personRow, membershipRow, rowToUmpire, roundToRow, rowToRound,
  gameToItem, itemToGame, withdrawalToRow, rowToWithdrawal, rowToMembershipLine,
} from './supabase-map.js';

const PAGE = 1000;                                              // PostgREST returns at most 1000 rows a call
const fail = ({ error }) => { if (error) throw Object.assign(new Error(error.message), { code: error.code }); };

const LINK_MESSAGE = 'This sign-in link cannot be used. It may have been used already, be more than an hour old, or have been opened in a different browser from the one you asked for it in. Get a new link below and open it in this same browser.';

export async function createSupabaseStore(cfg, { createClient } = {}) {
  createClient ||= (await import(SUPABASE_SDK)).createClient;
  const sb = createClient(cfg.url, cfg.anonKey, { auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true } });
  let org = null;                                               // the association in use
  let me = '';
  const A = () => { if (!org) throw new Error('No association selected'); return org.id; };
  const ok = async q => { const r = await q; fail(r); return r.data; };
  // Every row of a query, a page at a time. `make` builds a fresh query each call.
  const all = async make => {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await ok(make().range(from, from + PAGE - 1));
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  };
  const one = async q => (await ok(q.limit(1)))[0] || null;
  sb.auth.onAuthStateChange((_e, s) => { me = ((s && s.user && s.user.email) || '').toLowerCase(); });

  // Games with their days and appointments, for one round (or all of an association's)
  const gamesOf = async (aid, rid) => {
    const q = () => sb.from('games').select('*, game_days(*)').eq('association_id', aid).order('id');
    const gs = await all(() => rid ? q().eq('round_id', rid) : q());
    const aq = () => sb.from('appointments').select('*').eq('association_id', aid);
    const ids = new Set(gs.map(g => g.id));
    const appts = (await all(() => rid ? aq().in('game_id', [...ids]) : aq())).filter(a => ids.has(a.game_id));
    const by = new Map();
    for (const a of appts) (by.get(a.game_id) || by.set(a.game_id, []).get(a.game_id)).push(a);
    const out = gs.map(g => itemToGame(g, g.game_days, by.get(g.id) || []));
    out.roundOf = new Map(gs.map(g => [g.id, g.round_id]));
    return out;
  };
  const saveItems = async (aid, rid, games) => {
    for (let i = 0; i < games.length; i += 100) await ok(sb.rpc('save_games', { aid, rid, items: games.slice(i, i + 100).map(gameToItem) }));
  };

  const view = id => ({                                         // a member's own view of one association
    async getUmpire(email) { return rowToUmpire(await one(sb.from('memberships').select('*, people(*)').eq('association_id', id).eq('email', email))); },
    async saveUmpire(u) { await saveUmpire(id, u); },
    async getSeason() { return seasonOf(id); },
    async getOrg() { return rowToOrg(await one(sb.from('associations').select('*').eq('id', id))); },
    async listRounds() { return (await all(() => sb.from('rounds').select('*').eq('association_id', id).eq('published', true))).map(rowToRound); },
    async listGames(rid) { return gamesOf(id, rid); },
    async getAvailability(seasonId, email) { const r = await one(sb.from('availability').select('data').eq('association_id', id).eq('season_id', seasonId).eq('email', email)); return r ? r.data : null; },
  });
  const seasonOf = async id => { const r = await one(sb.from('seasons').select('data').eq('association_id', id).order('updated_at', { ascending: false })); return r ? r.data : null; };

  async function saveUmpire(aid, u) {
    const email = u.email.toLowerCase();
    const p = personRow({ ...u, email });
    // A person's own details are theirs: only they can change an existing record. An officer adding a
    // brand-new member creates it, and never overwrites one.
    if (email === me) await ok(sb.from('people').upsert(p));
    else await ok(sb.from('people').upsert(p, { ignoreDuplicates: true }));
    const m = membershipRow(aid, { ...u, email });
    await ok(sb.from('memberships').upsert(m));
  }

  return {
    mode: 'supabase',
    async init() {},

    // ----- auth -----
    onAuth(cb) {
      sb.auth.getSession().then(({ data }) => { me = ((data.session && data.session.user.email) || '').toLowerCase(); cb(me ? { email: me } : null); });
      const { data } = sb.auth.onAuthStateChange((_e, s) => { const e = ((s && s.user && s.user.email) || '').toLowerCase(); cb(e ? { email: e } : null); });
      return () => data.subscription.unsubscribe();
    },
    async sendLink(email) {
      try { localStorage.setItem('pdca-last-email', email); } catch { /* private mode: the form just starts empty */ }
      fail(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true } }));
      return { sent: true };
    },
    // Call once at start-up. Returns true if the page was opened from an emailed link (?code=...).
    async completeLink() {
      // Supabase sends an already-used or expired emailed link back here with the error in the address (in the query or after the #).
      const bad = new URLSearchParams(location.search).get('error_code') ? new URLSearchParams(location.search)
        : /(^|[#&?])error_code=/.test(location.hash || '') ? new URLSearchParams(location.hash.replace(/^#\/?\??/, '')) : null;
      if (bad) {
        history.replaceState(null, '', location.pathname + '#/');
        const { data } = await sb.auth.getSession();
        if (data && data.session) return true;                  // already signed in: the old link does not matter
        throw Object.assign(new Error(LINK_MESSAGE), { signInLink: true });
      }
      const code = new URLSearchParams(location.search).get('code');
      if (!code) return false;
      // The code is single-use: take it out of the address first, so a second start-up (or a reload) cannot try it again.
      history.replaceState(null, '', location.pathname + '#/');
      const { error } = await sb.auth.exchangeCodeForSession(code);
      if (error) {
        const { data } = await sb.auth.getSession();            // already signed in by an earlier attempt with this same link: not a problem
        if (data && data.session) return true;
        // A used link and a link opened in another browser look the same from here (a used link also loses its key in this browser),
        // so the message names the likely causes instead of guessing one.
        throw Object.assign(new Error(LINK_MESSAGE), { signInLink: true });
      }
      return true;
    },
    async signInGoogle() { fail(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } })); },
    async signOut() {
      // If the server cannot be reached the library keeps the session; always end it in this browser.
      let r; try { r = await sb.auth.signOut(); } catch (e) { r = { error: e }; }
      if (r && r.error) { try { await sb.auth.signOut({ scope: 'local' }); } catch { /* nothing more to clear */ } }
      me = '';
    },
    async isPlatformAdmin(email) { return !!(await one(sb.from('platform_admins').select('email').eq('email', email))); },

    // ----- associations -----
    get org() { return org; },
    async useOrg(id) { org = id ? rowToOrg(await one(sb.from('associations').select('*').eq('id', id))) : null; return org; },
    async getOrg(id) { return rowToOrg(await one(sb.from('associations').select('*').eq('id', id))); },
    async listMyOrgs(email) {
      const [m, o] = await Promise.all([
        ok(sb.from('memberships').select('association_id').eq('email', email)),
        ok(sb.from('officers').select('association_id').eq('email', email)),
      ]);
      const ids = [...new Set([...m, ...o].map(r => r.association_id))];
      if (!ids.length) return [];
      return (await ok(sb.from('associations').select('*').in('id', ids))).map(rowToOrg);
    },
    async rememberOrg() {},                                    // membership and officer rows are the list; nothing to remember
    async createOrg(o, email) {
      const row = orgToRow({ ...o, createdBy: email });
      await ok(sb.from('associations').insert(row));
      await ok(sb.from('officers').insert({ association_id: o.id, email }));
      return rowToOrg(row);
    },
    async saveOrg(patch) {
      const next = { ...org, ...patch };
      const { id, createdBy, plan, ...rest } = next;            // the plan is the product owner's to change
      const row = orgToRow(rest); delete row.created_by;
      await ok(sb.from('associations').update(row).eq('id', org.id));
      org = next;
    },
    async listAdmins() { return (await ok(sb.from('officers').select('email').eq('association_id', A()))).map(r => r.email); },
    async addAdmin(email) { await ok(sb.from('officers').upsert({ association_id: A(), email: email.toLowerCase() }, { ignoreDuplicates: true })); },
    async removeAdmin(email) { await ok(sb.from('officers').delete().eq('association_id', A()).eq('email', email)); },
    async isAdmin(email) { return !!org && !!(await one(sb.from('officers').select('email').eq('association_id', org.id).eq('email', email))); },

    // ----- umpires -----
    memberView: view,
    async getUmpire(email) { return view(A()).getUmpire(email); },
    async saveUmpire(u) { return saveUmpire(A(), u); },
    async deleteUmpire(email) { await ok(sb.from('memberships').delete().eq('association_id', A()).eq('email', email)); },
    async listUmpires() { return (await all(() => sb.from('memberships').select('*, people(*)').eq('association_id', A()).order('pid'))).map(rowToUmpire); },

    // ----- rounds & games -----
    async listRounds() { return (await all(() => sb.from('rounds').select('*').eq('association_id', A()).order('start_date', { ascending: false }))).map(rowToRound); },
    async getRound(id) { return rowToRound(await one(sb.from('rounds').select('*').eq('association_id', A()).eq('id', id))); },
    async saveRound(r) {
      const old = await this.getRound(r.id);
      await ok(sb.from('rounds').upsert(roundToRow(A(), { ...(old || {}), ...r })));
    },
    listGames(rid) { return gamesOf(A(), rid); },
    async saveGame(rid, g) { await saveItems(A(), rid, [g]); },
    async saveGames(rid, games) { await saveItems(A(), rid, games); },

    // ----- PlayHQ fixtures: asked of the `playhq` Edge Function, which holds the key -----
    async playhq(action, params = {}) {
      const { data, error } = await sb.functions.invoke('playhq', { body: { action, associationId: A(), ...params } });
      if (error) throw new Error('Could not reach the fixture service. Try again in a minute.');
      if (data && data.error) throw new Error(data.error);
      return data;
    },

    // ----- season calendar (the dates umpires answer for) -----
    getSeason() { return seasonOf(A()); },
    async saveSeason(s) {
      const id = String((s && s.id) || 'season');
      await ok(sb.from('seasons').upsert({ association_id: A(), id, name: s.name || null, data: s, updated_at: new Date().toISOString() }));
    },

    // ----- availability: one row per umpire per season -----
    getAvailability: (seasonId, email) => view(A()).getAvailability(seasonId, email),
    async saveAvailability(a) {
      await ok(sb.from('availability').upsert({ association_id: A(), season_id: a.seasonId, email: a.email, data: a, updated_at: new Date().toISOString() }));
    },
    async listAvailability(seasonId) { return (await all(() => sb.from('availability').select('data').eq('association_id', A()).eq('season_id', seasonId))).map(r => r.data); },

    // ----- withdrawals, mail, settings -----
    async listWithdrawals() { return (await all(() => sb.from('withdrawals').select('*').eq('association_id', A()))).map(rowToWithdrawal); },
    async saveWithdrawal(w) {
      const old = await one(sb.from('withdrawals').select('*').eq('association_id', A()).eq('id', w.id));
      await ok(sb.from('withdrawals').upsert(withdrawalToRow(A(), { ...(old ? rowToWithdrawal(old) : {}), ...w })));
    },
    async queueMail(m) { await ok(sb.from('mail_queue').insert({ association_id: A(), to_email: m.to, message: m.message })); },
    async getSettings() { const r = await one(sb.from('association_settings').select('data').eq('association_id', A())); return (r && r.data) || {}; },
    async saveSettings(s) {
      const cur = await this.getSettings();
      await ok(sb.from('association_settings').upsert({ association_id: A(), data: { ...cur, ...s } }));
    },

    // Members read the fixtures straight from the games tables (appointments are held back until a round is published).
    async saveFixtureList() {},
    async listFixtureLists() {
      const rounds = (await all(() => sb.from('rounds').select('*').eq('association_id', A()))).map(rowToRound);
      const games = await gamesOf(A());
      const byRound = new Map();
      for (const g of games) { const k = games.roundOf.get(g.id); (byRound.get(k) || byRound.set(k, []).get(k)).push(g); }
      return rounds.map(r => fixtureList(r, byRound.get(r.id) || []));
    },

    // ----- memberships across associations: membership only (association, type, active, since) -----
    async saveMembershipLink() {},                              // derived from memberships; nothing to write
    async listMemberships(email) {
      const rows = await ok(sb.from('memberships').select('association_id, membership, active, member_since, associations(name)').eq('email', email));
      return rows.map(rowToMembershipLine);
    },
  };
}
