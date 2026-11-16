// Demo back-end: everything lives in this browser's localStorage.
// Same interface as store-firebase.js, so the app code is identical.
// "Sign in" simply asks for an email (no link is sent).
//
// Data is kept per association (org), exactly like the live back-end:
//   db.orgs[orgId] = { org, admins, umpires, rounds, games, availability, settings, season }
//   db.users[email] = [orgId, ...]      which associations a person has opened

import { DEMO_ORG } from './config.js';

const KEY = 'pdca-umpires-demo-v2';
const clone = x => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const blank = org => ({ org, admins: [], umpires: {}, rounds: {}, games: {}, availability: {}, settings: {}, season: null, withdrawals: {}, mail: {} });

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
  const save = () => localStorage.setItem(KEY, JSON.stringify(db));
  const emit = () => listeners.forEach(cb => cb(db.session ? { email: db.session } : null));
  const o = () => { if (!cur || !db.orgs[cur]) throw new Error('No association selected'); return db.orgs[cur]; };
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
    async listMyOrgs(email) { return (db.users[email] || []).filter(id => db.orgs[id]).map(id => clone(db.orgs[id].org)); },
    async rememberOrg(email, id) { index(email, id); save(); },
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

    async getUmpire(email) { return clone(o().umpires[email]) || null; },
    async saveUmpire(u) { o().umpires[u.email] = { ...(o().umpires[u.email] || {}), ...clone(u) }; index(u.email, cur); save(); },
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

    async getSettings() { return clone(o().settings); },
    async saveSettings(s) { o().settings = { ...o().settings, ...clone(s) }; save(); },

    // demo-only helpers
    demoReset() { localStorage.removeItem(KEY); cur = null; load(); emit(); },
    demoRaw() { return db; },
    demoPersist() { save(); },
  };
}
