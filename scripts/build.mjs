// Cloudflare Pages build: point config.js at this environment's Supabase project, then copy the site into dist/.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

execFileSync('node', ['scripts/write-config.mjs'], { stdio: 'inherit' });
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const p of ['index.html', 'css', 'js']) cpSync(p, `dist/${p}`, { recursive: true });
// Which commit this deployment is, so the post-deploy tests know when the new version is live.
writeFileSync('dist/version.json', JSON.stringify({ sha: process.env.CF_PAGES_COMMIT_SHA || '', builtAt: new Date().toISOString() }));
console.log('build: site copied to dist/');
