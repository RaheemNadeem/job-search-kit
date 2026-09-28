#!/usr/bin/env node
/**
 * doctor.mjs — check that the kit is ready to run, and say how to fix what isn't.
 *   npm run doctor            quick checks
 *   npm run doctor -- --llm   also send one tiny request to your AI provider
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, PATHS, SETTINGS, loadProfile } from '../src/config.mjs';
import { llmConfigured, chatJson } from '../src/llm.mjs';

let problems = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m, fix) => { problems++; console.log(`  ✗ ${m}\n      → ${fix}`); };
const warn = (m, fix) => console.log(`  ! ${m}\n      → ${fix}`);

console.log('\nJob Search Kit — doctor\n');

const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old`, 'install Node 20 or newer');

existsSync(join(ROOT, 'node_modules')) ? ok('dependencies installed') : bad('dependencies missing', 'run: npm install');
existsSync(join(ROOT, '.env')) ? ok('.env exists') : bad('.env missing', 'run: npm run setup');

// Profile
const profile = loadProfile({ required: false });
if (!profile) bad('profile/profile.yml missing', 'run: npm run setup, then edit profile/profile.yml');
else {
  const raw = readFileSync(PATHS.profile, 'utf8');
  if (/Jordan Example|jordan@example\.com/.test(raw)) bad('profile.yml still has the example person', 'replace Jordan Example with your own details');
  else ok(`profile: ${profile.name}`);
  if (!profile.experience?.length) bad('profile has no experience entries', 'add your work history under experience:');
  const ids = (profile.experience || []).map((e) => e.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) bad('every experience entry needs a unique id', 'e.g. id: current, id: previous');
  if (!profile.preferences?.core_stack?.length) warn('preferences.core_stack is empty', 'scoring works best when you list your main technologies');
}

// Search config
if (!existsSync(PATHS.search)) bad('profile/search.json missing', 'run: npm run setup, then edit it');
else {
  try { JSON.parse(readFileSync(PATHS.search, 'utf8')); ok('search.json is valid'); }
  catch (e) { bad(`search.json is not valid JSON: ${e.message}`, 'fix the syntax (a trailing comma is the usual cause)'); }
}

// AI
if (!llmConfigured()) bad('AI provider not configured', 'set LLM_API_KEY (and LLM_BASE_URL / LLM_MODEL) in .env');
else {
  ok(`AI: ${SETTINGS.llm.baseUrl} (${SETTINGS.llm.ratingModel})`);
  if (process.argv.includes('--llm')) {
    try {
      const r = await chatJson({ model: SETTINGS.llm.ratingModel, system: 'Reply with JSON only.', user: 'Return {"ok": true}', maxTokens: 50, timeoutMs: 60000 });
      r?.ok ? ok('AI provider answered') : bad('AI provider answered but not with the expected JSON', 'try another model, or set LLM_JSON_MODE=0');
    } catch (e) { bad(`AI request failed: ${e.message}`, 'check LLM_API_KEY, LLM_BASE_URL and LLM_MODEL'); }
  }
}

// PDF tooling
const py = spawnSync('python3', ['-c', 'import pypdf'], { encoding: 'utf8' });
const pdftotext = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
if (py.error) warn('python3 not found — resume PDFs will not be verified', 'install Python 3 and run: pip install pypdf');
else if (py.status === 0 || !pdftotext.error) ok('PDF verification available');
else warn('neither pypdf nor pdftotext found — PDF verification will fail', 'pip install pypdf   (or install poppler-utils)');

try {
  const { chromium } = await import('playwright');
  const path = chromium.executablePath();
  existsSync(path) || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(existsSync) || process.env.CHROME_PATH
    ? ok('Chromium available for PDF rendering')
    : bad('no Chromium for PDF rendering', 'run: npx playwright install chromium');
} catch { bad('playwright not installed', 'run: npm install'); }

// Scraping
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  warn('no desktop display detected', 'the scrapers open a visible browser: run them from a desktop session, or under Xvfb (xvfb-run npm run search)');
}
existsSync(PATHS.browserProfile) ? ok('browser session folder exists') : warn('not logged in to Indeed yet', 'run: npm run login:indeed   (LinkedIn works without a login)');

// Server exposure
if (SETTINGS.server.host !== '127.0.0.1' && !SETTINGS.server.token) bad('DASHBOARD_HOST is not 127.0.0.1 but DASHBOARD_TOKEN is empty', 'set DASHBOARD_TOKEN (npm run setup generates one)');

console.log(problems ? `\n${problems} problem(s) to fix.\n` : '\nAll set. Run: npm start\n');
process.exitCode = problems ? 1 : 0;
