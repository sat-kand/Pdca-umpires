// ---------------------------------------------------------------------------
// App configuration
// ---------------------------------------------------------------------------
// While `firebase.apiKey` is empty the app runs in DEMO MODE: everything is
// stored in this browser only (localStorage), so you can click through it
// without any setup. To go live, paste your Firebase web-app config below
// (Firebase console > Project settings > Your apps > Web app > Config).
// See README.md for the full setup.

export const CONFIG = {
  appName: 'PDCA Umpire Allocation',

  apiBase: 'https://grassrootsapiproxy.cricket.com.au',

  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
  },
};

export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

// The association the demo starts with (demo mode only; live associations are created in the app).
export const DEMO_ORG = {
  id: 'pdca',
  name: 'Parramatta District Cricket Association',
  playCricketId: 'ee7d89d9-6732-ec11-981f-501ac52e1666',
  plan: 'trial',
  notifyEmail: 'admin@demo.test',
  membership: { renewalDay: '06-30', types: [{ name: 'Ordinary member', fee: 60 }, { name: 'Junior member', fee: 25 }, { name: 'Life member', fee: 0 }] },
};
