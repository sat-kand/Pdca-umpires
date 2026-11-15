// Demo back-end: everything lives in this browser's localStorage.
// Same interface as store-firebase.js, so the app code is identical.
// "Sign in" simply asks for an email (no link is sent).

const KEY = 'pdca-umpires-demo-v1';
const clone = x => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

export function createDemoStore() {
  let db = null;
  const listeners = [];

  const load = () => {
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
    db ||= { admins: ['admin@demo.test'], umpires: {}, rounds: {}, games: {}, availability: {}, settings: {}, session: null };
  };
  const save = () => localStorage.setItem(KEY, JSON.stringify(db));
  const emit = () => listeners.forEach(cb => cb(db.session ? { email: db.session } : null));

  load();
  return {
    mode: 'demo',
    async init() { load(); },

    onAuth(cb) { listeners.push(cb); setTimeout(() => cb(db.session ? { email: db.session } : null), 0); return () => {}; },
    async sendLink(email) { db.session = email.trim().toLowerCase(); save(); emit(); return { sent: false, signedIn: true }; },
    async completeLink() { return false; },
    async signOut() { db.session = null; save(); emit(); },
    async isAdmin(email) { return db.admins.includes(email); },

    async getUmpire(email) { return clone(db.umpires[email]) || null; },
    async saveUmpire(u) { db.umpires[u.email] = { ...(db.umpires[u.email] || {}), ...clone(u) }; save(); },
    async listUmpires() { return Object.values(clone(db.umpires)); },

    async listRounds() { return Object.values(clone(db.rounds)).sort((a, b) => (b.start || '').localeCompare(a.start || '')); },
    async getRound(id) { return clone(db.rounds[id]) || null; },
    async saveRound(r) { db.rounds[r.id] = { ...(db.rounds[r.id] || {}), ...clone(r) }; save(); },
    async listGames(rid) { return Object.values(clone(db.games[rid] || {})); },
    async saveGame(rid, g) { (db.games[rid] ||= {})[g.id] = clone(g); save(); },
    async saveGames(rid, games) { for (const g of games) (db.games[rid] ||= {})[g.id] = clone(g); save(); },

    async getAvailability(rid, email) { return clone(db.availability[`${rid}__${email}`]) || null; },
    async saveAvailability(a) { db.availability[`${a.roundId}__${a.email}`] = clone(a); save(); },
    async listAvailability(rid) { return Object.values(clone(db.availability)).filter(a => a.roundId === rid); },

    async getSettings() { return clone(db.settings); },
    async saveSettings(s) { db.settings = { ...db.settings, ...clone(s) }; save(); },

    // demo-only helpers
    demoReset() { localStorage.removeItem(KEY); load(); emit(); },
    demoRaw() { return db; },
    demoPersist() { save(); },
  };
}
