// Run by the host's build step (Cloudflare Pages): points this deployment at its own Supabase project.
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=sb_publishable_... node scripts/write-config.mjs
// Both values are public by design. Without them, config.js is left as it is.
import { readFileSync, writeFileSync } from 'node:fs';

// Staging only: PASSWORD_LOGIN=1 shows the test-account password sign-in.
const passwordLogin = process.env.PASSWORD_LOGIN === '1';
const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
const file = new URL('../js/config.js', import.meta.url);
const flag = text => text.replace(/passwordLogin: (true|false)/, `passwordLogin: ${passwordLogin}`);
if (!url || !key) {
  writeFileSync(file, flag(readFileSync(file, 'utf8')));
  console.log(`write-config: SUPABASE_URL / SUPABASE_ANON_KEY not set, config.js left as it is (password sign-in ${passwordLogin ? 'ON' : 'off'})`);
  process.exit(0);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) { console.error('write-config: SUPABASE_URL does not look like https://<project>.supabase.co'); process.exit(1); }
if (!/^[A-Za-z0-9._-]+$/.test(key) || /service_role/i.test(key)) { console.error('write-config: SUPABASE_ANON_KEY must be the publishable (anon) key'); process.exit(1); }

const src = readFileSync(file, 'utf8');
const next = flag(src).replace(/supabase: \{[^}]*\}/, `supabase: { url: '${url}', anonKey: '${key}' }`);
if (next === src && !src.includes(url)) { console.error('write-config: could not find the supabase line in js/config.js'); process.exit(1); }
writeFileSync(file, next);
console.log(`write-config: config.js now points at ${url} (password sign-in ${passwordLogin ? 'ON' : 'off'})`);
