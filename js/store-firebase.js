// Live back-end: Firebase Authentication (email link) + Cloud Firestore.
// Loaded lazily from Google's CDN so demo mode needs no network at all.
//
// Collections (see firestore.rules):
//   admins/{email}                 created by hand in the Firebase console
//   umpires/{email}                one per umpire (id = lower-case email)
//   config/season                  season calendar: the dates umpires answer for
//   rounds/{roundId}               title, dates, published, stats
//   rounds/{roundId}/games/{id}    fixture + slots + alloc
//   availability/{seasonId__email} one per umpire per season
//   settings/defaults              default umpires-per-game by grade

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
    async isAdmin(email) { return !!(await getOne('admins', email)); },

    // ----- umpires -----
    getUmpire: email => getOne('umpires', email),
    saveUmpire: u => fs.setDoc(fs.doc(db, 'umpires', u.email), clean(u), { merge: true }),
    async listUmpires() {
      const s = await fs.getDocs(fs.collection(db, 'umpires'));
      return s.docs.map(d => d.data());
    },

    // ----- rounds & games -----
    async listRounds() {
      const s = await fs.getDocs(fs.query(fs.collection(db, 'rounds'), fs.orderBy('start', 'desc')));
      return s.docs.map(d => d.data());
    },
    getRound: id => getOne('rounds', id),
    saveRound: r => fs.setDoc(fs.doc(db, 'rounds', r.id), clean(r), { merge: true }),
    async listGames(rid) {
      const s = await fs.getDocs(fs.collection(db, 'rounds', rid, 'games'));
      return s.docs.map(d => d.data());
    },
    saveGame: (rid, g) => putOne(g, 'rounds', rid, 'games', g.id),
    async saveGames(rid, games) {
      for (let i = 0; i < games.length; i += 400) {
        const batch = fs.writeBatch(db);
        for (const g of games.slice(i, i + 400)) batch.set(fs.doc(db, 'rounds', rid, 'games', g.id), clean(g));
        await batch.commit();
      }
    },

    // ----- season calendar (the dates umpires answer for) -----
    getSeason: () => getOne('config', 'season'),
    saveSeason: s => putOne(s, 'config', 'season'),

    // ----- availability: one document per umpire per season -----
    getAvailability: (seasonId, email) => getOne('availability', `${seasonId}__${email}`),
    saveAvailability: a => putOne(a, 'availability', `${a.seasonId}__${a.email}`),
    async listAvailability(seasonId) {
      const s = await fs.getDocs(fs.query(fs.collection(db, 'availability'), fs.where('seasonId', '==', seasonId)));
      return s.docs.map(d => d.data());
    },

    // ----- settings -----
    async getSettings() { return (await getOne('settings', 'defaults')) || {}; },
    saveSettings: s => fs.setDoc(fs.doc(db, 'settings', 'defaults'), clean(s), { merge: true }),
  };
}
