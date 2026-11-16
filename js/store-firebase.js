// Live back-end: Firebase Authentication (email link) + Cloud Firestore.
// Loaded lazily from Google's CDN so demo mode needs no network at all.
//
// Every association (org) has its own data, kept apart by the rules in firestore.rules:
//   users/{email}                            which associations a person has opened (their own list)
//   platformAdmins/{email}                   the product owner(s); created by hand in the Firebase console
//   orgs/{orgId}                             name, Play Cricket id, plan
//   orgs/{orgId}/admins/{email}              appointments officers
//   orgs/{orgId}/umpires/{email}             one per umpire (id = lower-case email)
//   orgs/{orgId}/config/season               season calendar: the dates umpires answer for
//   orgs/{orgId}/rounds/{roundId}            title, dates, published, stats
//   orgs/{orgId}/rounds/{roundId}/games/{id} fixture + slots + alloc
//   orgs/{orgId}/availability/{seasonId__email}
//   orgs/{orgId}/withdrawals/{id}            an umpire who pulled out of a published round
//   orgs/{orgId}/settings/defaults           default umpires-per-game by grade
//   mail/{id}                                outgoing email, sent by the Firebase "Trigger Email" extension

import { FIREBASE_SDK } from './config.js';

const clean = x => JSON.parse(JSON.stringify(x));
const LINK_EMAIL_KEY = 'pdca-email-for-signin';

export async function createFirebaseStore(cfg) {
  const [appM, authM, fs] = await Promise.all([
    import(FIREBASE_SDK + 'firebase-app.js'),
    import(FIREBASE_SDK + 'firebase-auth.js'),
    import(FIREBASE_SDK + 'firebase-firestore.js'),
  ]);
  const app = appM.initializeApp(cfg);
  const auth = authM.getAuth(app);
  const db = fs.getFirestore(app);

  const getOne = async (...path) => {
    const snap = await fs.getDoc(fs.doc(db, ...path));
    return snap.exists() ? snap.data() : null;
  };
  const putOne = (data, ...path) => fs.setDoc(fs.doc(db, ...path), clean(data), { merge: false });
  let org = null;                                        // the association in use
  const P = (...p) => { if (!org) throw new Error('No association selected'); return ['orgs', org.id, ...p]; };

  return {
    mode: 'firebase',
    async init() {},

    // ----- auth -----
    onAuth(cb) {
      return authM.onAuthStateChanged(auth, u => cb(u && u.email ? { email: u.email.toLowerCase() } : null));
    },
    async sendLink(email) {
      const url = location.origin + location.pathname;
      await authM.sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
      localStorage.setItem(LINK_EMAIL_KEY, email);
      return { sent: true };
    },
    // Call once at start-up. Returns true if the page was opened from an emailed link.
    async completeLink(askEmail) {
      if (!authM.isSignInWithEmailLink(auth, location.href)) return false;
      let email = localStorage.getItem(LINK_EMAIL_KEY);
      if (!email) email = await askEmail(); // opened on a different device/browser
      if (!email) return false;
      await authM.signInWithEmailLink(auth, email, location.href);
      localStorage.removeItem(LINK_EMAIL_KEY);
      history.replaceState(null, '', location.pathname + '#/');
      return true;
    },
    // Google sign-in has no email-sending quota (email-link emails are capped at 5/day on Firebase's free plan).
    async signInGoogle() { await authM.signInWithPopup(auth, new authM.GoogleAuthProvider()); },
    signOut() { return authM.signOut(auth); },

    // ----- associations -----
    get org() { return org; },
    async useOrg(id) { org = id ? await getOne('orgs', id) : null; return org; },
    getOrg: id => getOne('orgs', id),
    async listMyOrgs(email) {
      const u = await getOne('users', email);
      const found = await Promise.all(((u && u.orgs) || []).map(id => getOne('orgs', id).catch(() => null)));
      return found.filter(Boolean);
    },
    rememberOrg: (email, id) => fs.setDoc(fs.doc(db, 'users', email), { orgs: fs.arrayUnion(id) }, { merge: true }),
    async createOrg(o, email) {
      const doc = { ...clean(o), createdBy: email };
      await fs.setDoc(fs.doc(db, 'orgs', o.id), doc);                                  // fails if the id is taken (no update permission)
      await fs.setDoc(fs.doc(db, 'orgs', o.id, 'admins', email), { email, addedAt: new Date().toISOString() });
      await this.rememberOrg(email, o.id);
      return doc;
    },
    async saveOrg(patch) { await fs.setDoc(fs.doc(db, 'orgs', org.id), clean(patch), { merge: true }); Object.assign(org, clean(patch)); },
    async listAdmins() { const s = await fs.getDocs(fs.collection(db, ...P('admins'))); return s.docs.map(d => d.id); },
    addAdmin: email => fs.setDoc(fs.doc(db, ...P('admins', email)), { email, addedAt: new Date().toISOString() }),
    removeAdmin: email => fs.deleteDoc(fs.doc(db, ...P('admins', email))),
    async isAdmin(email) { return !!org && !!(await getOne(...P('admins', email))); },

    // ----- umpires -----
    getUmpire: email => getOne(...P('umpires', email)),
    saveUmpire: u => fs.setDoc(fs.doc(db, ...P('umpires', u.email)), clean(u), { merge: true }),
    async listUmpires() {
      const s = await fs.getDocs(fs.collection(db, ...P('umpires')));
      return s.docs.map(d => d.data());
    },

    // ----- rounds & games -----
    async listRounds() {
      const s = await fs.getDocs(fs.query(fs.collection(db, ...P('rounds')), fs.orderBy('start', 'desc')));
      return s.docs.map(d => d.data());
    },
    getRound: id => getOne(...P('rounds', id)),
    saveRound: r => fs.setDoc(fs.doc(db, ...P('rounds', r.id)), clean(r), { merge: true }),
    async listGames(rid) {
      const s = await fs.getDocs(fs.collection(db, ...P('rounds', rid, 'games')));
      return s.docs.map(d => d.data());
    },
    saveGame: (rid, g) => putOne(g, ...P('rounds', rid, 'games', g.id)),
    async saveGames(rid, games) {
      for (let i = 0; i < games.length; i += 400) {
        const batch = fs.writeBatch(db);
        for (const g of games.slice(i, i + 400)) batch.set(fs.doc(db, ...P('rounds', rid, 'games', g.id)), clean(g));
        await batch.commit();
      }
    },

    // ----- season calendar (the dates umpires answer for) -----
    getSeason: () => getOne(...P('config', 'season')),
    saveSeason: s => putOne(s, ...P('config', 'season')),

    // ----- availability: one document per umpire per season -----
    getAvailability: (seasonId, email) => getOne(...P('availability', `${seasonId}__${email}`)),
    saveAvailability: a => putOne(a, ...P('availability', `${a.seasonId}__${a.email}`)),
    async listAvailability(seasonId) {
      const s = await fs.getDocs(fs.query(fs.collection(db, ...P('availability')), fs.where('seasonId', '==', seasonId)));
      return s.docs.map(d => d.data());
    },

    // ----- settings -----
    async listWithdrawals() {
      const snap = await fs.getDocs(fs.collection(db, ...P('withdrawals')));
      return snap.docs.map(d => d.data());
    },
    saveWithdrawal: w => fs.setDoc(fs.doc(db, ...P('withdrawals', w.id)), clean(w), { merge: true }),
    // Picked up by the "Trigger Email from Firestore" extension, if the owner has installed it.
    queueMail: m => fs.addDoc(fs.collection(db, 'mail'), clean(m)),

    async getSettings() { return (await getOne(...P('settings', 'defaults'))) || {}; },
    saveSettings: s => fs.setDoc(fs.doc(db, ...P('settings', 'defaults')), clean(s), { merge: true }),
  };
}
