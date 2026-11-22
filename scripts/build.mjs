// Cloudflare Pages build: point config.js at this environment's Supabase project, then copy the site into dist/.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync } from 'node:fs';

execFileSync('node', ['scripts/write-config.mjs'], { stdio: 'inherit' });
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const p of ['index.html', 'css', 'js']) cpSync(p, `dist/${p}`, { recursive: true });
console.log('build: site copied to dist/');
