#!/usr/bin/env node
/**
 * setup.mjs — first-run setup. Safe to run again; it never overwrites your files.
 *   - copies the example profile / search / .env files for you to fill in
 *   - creates the data folders
 *   - generates a DASHBOARD_TOKEN if you don't have one
 */
import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists = (p) => access(p).then(() => true, () => false);

const copies = [
  ['.env.example', '.env'],
  ['profile/profile.example.yml', 'profile/profile.yml'],
  ['profile/search.example.json', 'profile/search.json'],
  ['profile/context.example.md', 'profile/context.md'],
];

for (const [from, to] of copies) {
  if (await exists(join(ROOT, to))) { console.log(`  keep     ${to} (already exists)`); continue; }
  await copyFile(join(ROOT, from), join(ROOT, to));
  console.log(`  created  ${to}`);
}

for (const d of ['data/jobs', 'data/queue', 'data/logs']) await mkdir(join(ROOT, d), { recursive: true });

const envPath = join(ROOT, '.env');
const env = await readFile(envPath, 'utf8');
if (/^DASHBOARD_TOKEN=\s*$/m.test(env)) {
  await writeFile(envPath, env.replace(/^DASHBOARD_TOKEN=\s*$/m, `DASHBOARD_TOKEN=${randomBytes(24).toString('hex')}`));
  console.log('  added    a random DASHBOARD_TOKEN to .env');
}

console.log(`
Next steps:
  1. Edit profile/profile.yml   — replace the example person with you
  2. Edit profile/search.json   — the jobs you want searched for
  3. Edit .env                  — add your AI provider key (LLM_API_KEY)
  4. npm run doctor             — check everything is ready
  5. npm start                  — open the dashboard at http://localhost:7867
Full guide: docs/USAGE.md`);
