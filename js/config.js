// ---------------------------------------------------------------------------
// App configuration
// ---------------------------------------------------------------------------
// While `supabase.url` is empty the app runs in DEMO MODE: everything is
// stored in this browser only (localStorage), so you can click through it
// without any setup. To go live, put your Supabase project's URL and public
// (publishable) key below. See README.md for the full setup.

export const CONFIG = {
  appName: 'Third Umpire',

  // Supabase (the live back-end). Both values are public by design: the database is protected by
  // row-level security, not by hiding these. Leave blank for demo mode. Each environment
  // (dev, staging, prod) uses its own project.
  supabase: { url: 'https://vziphltqtkuzlpltudqy.supabase.co', anonKey: 'sb_publishable_IxGIQNMptZZFoZNwCcv8dw_pX-L4k9C' },
};

export const SUPABASE_SDK = 'https://esm.sh/@supabase/supabase-js@2.45.4';

// The association the demo starts with (demo mode only; live associations are created in the app).
export const DEMO_ORG = {
  id: 'pdca',
  name: 'Parramatta District Cricket Association',
  playhqOrgId: '00000000-0000-4000-8000-000000000001',        // a made-up id: the demo never calls PlayHQ
  plan: 'trial',
  flags: { player_umpire: true },                              // features the platform owner switches on per association
  notifyEmail: 'admin@demo.test',
  playerUmpire: { description: 'Pick any Senior round, grade or fixture you want to umpire.' },
  membership: { renewalDay: '06-30', types: [{ name: 'Ordinary member', fee: 60 }, { name: 'Junior member', fee: 25 }, { name: 'Life member', fee: 0 }] },
};
