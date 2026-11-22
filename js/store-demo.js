// Demo back-end: everything lives in this browser's localStorage.
// Same interface as store-supabase.js, so the app code is identical.
// "Sign in" simply asks for an email (no link is sent).
//
// Data is kept per association (org), exactly like the live back-end:
//   db.orgs[orgId] = { org, admins, umpires, rounds, games, availability, settings, season }
//   db.users[email] = [orgId, ...]      which associations a person has opened

import { DEMO_ORG } from './config.js';
import { newPid } from './logic.js';

const KEY = 'pdca-umpires-demo-v2';
const clone = x => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const blank = org => ({ org, admins: [], umpires: {}, rounds: {}, games: {}, availability: {}, settings: {}, season: null, withdrawals: {}, mail: {}, fixtures: {} });

export function createDemoStore() {
  let db = null;
  let cur = null;                       // id of the association in use
  const listeners = [];

  const load = () => {
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
    if (!db) {
      db = { orgs: {}, users: {}, session: null };
      db.orgs[DEMO_ORG.id] = { ...blank({ ...DEMO_ORG, createdBy: 'admin@demo.test' }), admins: ['admin@demo.test'] };
      db.users['admin@demo.test'] = [DEMO_ORG.id];
    }
  };
  // Another tab (say the officer in one and an umpire in another) may have saved since: always work
  // from what is stored, so one tab never overwrites the other's changes with an old copy.
  let lastRaw = null;
  const fresh = () => { const raw = localStorage.getItem(KEY); if (raw !== lastRaw) { load(); lastRaw = raw; } };
  const save = () => { lastRaw = JSON.stringify(db); localStorage.setItem(KEY, lastRaw); };
  const emit = () => listeners.forEach(cb => cb(db.session ? { email: db.session } : null));
  const o = () => { fresh(); if (!cur || !db.orgs[cur]) throw new Error('No association selected'); return db.orgs[cur]; };
  const index = (email, id) => { const l = (db.users[email] ||= []); if (!l.includes(id)) l.push(id); };

  load();
  return {
    mode: 'demo',
    async init() { load(); },

    onAuth(cb) { listeners.push(cb); setTimeout(() => cb(db.session ? { email: db.session } : null), 0); return () => {}; },
    async sendLink(email) { db.session = email.trim().toLowerCase(); save(); emit(); return { sent: false, signedIn: true }; },
    async completeLink() { return false; },
    async signOut() { db.session = null; save(); emit(); },

    // ----- associations -----
    get org() { return cur && db.orgs[cur] ? clone(db.orgs[cur].org) : null; },
    useOrg(id) { cur = id && db.orgs[id] ? id : null; return this.org; },
    async getOrg(id) { return db.orgs[id] ? clone(db.orgs[id].org) : null; },
    // Like the live back-end: the associations they are an officer of or have a membership in (waiting or not).
    async listMyOrgs(email) { fresh(); return Object.values(db.orgs).filter(x => x.admins.includes(email) || x.umpires[email]).map(x => clone(x.org)); },
    async rememberOrg(email, id) { index(email, id); save(); },

    // ----- joining: the associations in this browser, and a person's place in each -----
    async listJoinableOrgs() { fresh(); return Object.values(db.orgs).map(x => clone(x.org)).filter(x => x.plan !== 'suspended').sort((a, b) => (a.name || '').localeCompare(b.name || '')); },
    // Details already on their profile: whatever any association here holds for this email.
    async getProfile(email) {
      fresh();
      const out = {};
      for (const x of Object.values(db.orgs)) {
        const u = x.umpires[email];
        if (u) for (const k of ['firstName', 'lastName', 'name', 'dob', 'address', 'phone', 'accreditation', 'accreditationProvider']) if (u[k] && !out[k]) out[k] = u[k];
      }
      return Object.keys(out).length ? { email, ...out } : null;
    },
    async listStandings(email) {
      fresh();
      const out = [];
      for (const [id, x] of Object.entries(db.orgs)) {
        const u = x.umpires[email], officer = x.admins.includes(email);
        if (u || officer) out.push({ orgId: id, u: u ? clone(u) : null, officer });
      }
      return out;
    },
    async joinOrg(orgId, details) {
      fresh();
      const x = db.orgs[orgId];
      if (!x) throw new Error('No such association');
      const email = details.email;
      const had = x.umpires[email];
      // The person's own details go on every association's copy that already has them; the new membership waits for approval.
      const person = Object.fromEntries(['firstName', 'lastName', 'name', 'dob', 'address', 'phone', 'accreditation', 'accreditationProvider'].filter(k => k in details).map(k => [k, details[k]]));
      x.umpires[email] = had ? { ...had, ...clone(person) } : { ...clone(person), email, pid: newPid(), active: false, createdAt: new Date().toISOString() };
      for (const y of Object.values(db.orgs)) if (y.umpires[email]) y.umpires[email] = { ...y.umpires[email], ...clone(person) };
      index(email, orgId); save();
      return x.umpires[email].pid;
    },
    async cancelJoin(orgId, email) {
      fresh();
      const x = db.orgs[orgId];
      const u = x && x.umpires[email];
      if (!u || u.active || u.approved || u.rejected) return;            // only a request still waiting can be taken back
      delete x.umpires[email];
      if (!x.admins.includes(email)) db.users[email] = (db.users[email] || []).filter(id => id !== orgId);
      save();
    },
    async listJoinRequests() { return Object.values(clone(o().umpires)).filter(u => !u.active); },
    async createOrg(org, email) {
      if (db.orgs[org.id]) throw new Error('That association already exists');
      db.orgs[org.id] = { ...blank({ ...clone(org), createdBy: email }), admins: [email] };
      index(email, org.id); save();
      return clone(db.orgs[org.id].org);
    },
    async saveOrg(patch) { Object.assign(o().org, clone(patch)); save(); },
    async listAdmins() { return [...o().admins]; },
    async addAdmin(email) { if (!o().admins.includes(email)) o().admins.push(email); index(email, cur); save(); },
    async removeAdmin(email) { o().admins = o().admins.filter(e => e !== email); save(); },
    async isAdmin(email) { return !!cur && o().admins.includes(email); },

    // A member's own view of one of their associations (any of them, not just the one open now):
    // their record there, its season, and its published rounds and games.
    memberView(id) {
      const x = () => { fresh(); if (!db.orgs[id]) throw new Error('No such association'); return db.orgs[id]; };
      return {
        org: clone(db.orgs[id] && db.orgs[id].org),
        async getUmpire(email) { return clone(x().umpires[email]) || null; },
        async saveUmpire(u) { x().umpires[u.email] = { ...(x().umpires[u.email] || {}), ...clone(u) }; save(); },
        async getSeason() { return clone(x().season) || null; },
        async getOrg() { return clone(x().org) || null; },
        async listRounds() { return Object.values(clone(x().rounds)).filter(r => r.published); },
        async listGames(rid) { return Object.values(clone(x().games[rid] || {})); },
        async getAvailability(seasonId, email) { return clone(x().availability[`${seasonId}__${email}`]) || null; },
      };
    },
    async getUmpire(email) { return clone(o().umpires[email]) || null; },
    async saveUmpire(u) { o().umpires[u.email] = { ...(o().umpires[u.email] || {}), ...clone(u) }; index(u.email, cur); save(); },
    async deleteUmpire(email) { delete o().umpires[email]; save(); },
    async listUmpires() { return Object.values(clone(o().umpires)); },

    async listRounds() { return Object.values(clone(o().rounds)).sort((a, b) => (b.start || '').localeCompare(a.start || '')); },
    async getRound(id) { return clone(o().rounds[id]) || null; },
    async saveRound(r) { o().rounds[r.id] = { ...(o().rounds[r.id] || {}), ...clone(r) }; save(); },
    async listGames(rid) { return Object.values(clone(o().games[rid] || {})); },
    async saveGame(rid, g) { (o().games[rid] ||= {})[g.id] = clone(g); save(); },
    async saveGames(rid, games) { for (const g of games) (o().games[rid] ||= {})[g.id] = clone(g); save(); },

    async getSeason() { return clone(o().season) || null; },
    async saveSeason(s) { o().season = clone(s); save(); },

    async getAvailability(seasonId, email) { return clone(o().availability[`${seasonId}__${email}`]) || null; },
    async saveAvailability(a) { o().availability[`${a.seasonId}__${a.email}`] = clone(a); save(); },
    async listAvailability(seasonId) { return Object.values(clone(o().availability)).filter(a => a.seasonId === seasonId); },

    // An umpire who pulls out after a round is published: the officer's app picks these up.
    async listWithdrawals() { return Object.values(clone(o().withdrawals || {})); },
    async saveWithdrawal(w) { (o().withdrawals ||= {})[w.id] = { ...(o().withdrawals[w.id] || {}), ...clone(w) }; save(); },
    async queueMail(m) { (o().mail ||= {})[`m${Date.now()}${Math.random().toString(36).slice(2, 6)}`] = clone(m); save(); },

    // A plain list of each round's games, which every member can read (the games themselves carry allocations).
    async saveFixtureList(rid, list) { (o().fixtures ||= {})[rid] = clone(list); save(); },
    // Memberships across associations: worked out from every association in this browser, plus
    // made-up ones the sample data adds for associations that are not here.
    async saveMembershipLink() {},
    async listMemberships(email) {
      fresh();
      const out = [];
      for (const [id, x] of Object.entries(db.orgs)) {
        const u = x.umpires && x.umpires[email];
        if (u) out.push({ orgId: id, orgName: x.org.name || id, membership: u.membership || '', active: !!u.active, since: u.memberSince || '' });
      }
      return [...out, ...clone((db.otherMemberships || {})[email] || [])];
    },
    async seedOtherMemberships(map) { fresh(); db.otherMemberships = clone(map); save(); },

    async listFixtureLists() { return Object.values(clone(o().fixtures || {})); },

    async getSettings() { return clone(o().settings); },
    async saveSettings(s) { o().settings = { ...o().settings, ...clone(s) }; save(); },

    // demo-only helpers
    demoReset() { localStorage.removeItem(KEY); cur = null; load(); emit(); },
    demoRaw() { return db; },
    demoPersist() { save(); },
  };
}
