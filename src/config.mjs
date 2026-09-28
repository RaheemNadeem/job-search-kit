/**
 * config.mjs — one place for paths, settings, and the candidate profile.
 *
 * Settings come from `.env` in the repo root, overridden by real environment
 * variables. The candidate profile comes from `profile/profile.yml` (copy
 * `profile/profile.example.yml` to start). Nothing personal is hardcoded
 * anywhere else in the kit — every script reads it from here.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readEnvFile(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env yet — defaults apply */ }
  return out;
}

export const ENV = { ...readEnvFile(join(ROOT, '.env')), ...process.env };

const dataDir = resolve(ROOT, ENV.DATA_DIR || 'data');

export const PATHS = {
  data: dataDir,
  jobs: join(dataDir, 'jobs'),                 // one folder per job: NNN-company-title/
  queue: join(dataDir, 'queue'),               // *.urls files waiting to be scraped
  browserProfile: join(dataDir, 'browser-profile'), // logged-in Indeed/LinkedIn cookies
  logs: join(dataDir, 'logs'),
  profile: join(ROOT, 'profile', 'profile.yml'),
  profileContext: join(ROOT, 'profile', 'context.md'),
  search: join(ROOT, 'profile', 'search.json'),
  resume: join(ROOT, 'resume'),
};

export const SETTINGS = {
  llm: {
    baseUrl: (ENV.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
    apiKey: ENV.LLM_API_KEY || '',
    ratingModel: ENV.LLM_RATING_MODEL || ENV.LLM_MODEL || 'deepseek-chat',
    resumeModel: ENV.LLM_RESUME_MODEL || ENV.LLM_MODEL || 'deepseek-chat',
    jsonMode: ENV.LLM_JSON_MODE !== '0',
  },
  server: {
    host: ENV.DASHBOARD_HOST || '127.0.0.1',
    port: Number(ENV.DASHBOARD_PORT || 7867),
    token: ENV.DASHBOARD_TOKEN || '',
  },
  resumeMinScore: Number(ENV.RESUME_MIN_SCORE || 3.5),
  autoResume: ENV.AUTO_RESUME === '1',
  captchaWaitMin: Number(ENV.CAPTCHA_WAIT_MIN ?? 10),
  notifyWebhook: ENV.NOTIFY_WEBHOOK_URL || '',
};

let cachedProfile = null;

/** The parsed profile.yml. Exits with a clear message if it is missing. */
export function loadProfile({ required = true } = {}) {
  if (cachedProfile) return cachedProfile;
  if (!existsSync(PATHS.profile)) {
    if (!required) return null;
    console.error('profile/profile.yml not found. Copy profile/profile.example.yml to profile/profile.yml and fill it in.');
    process.exit(1);
  }
  cachedProfile = yaml.load(readFileSync(PATHS.profile, 'utf8')) || {};
  return cachedProfile;
}

/** Optional free-form notes the AI may use as extra ground truth. */
export function loadContext() {
  try { return readFileSync(PATHS.profileContext, 'utf8'); } catch { return ''; }
}

/**
 * The profile rendered as plain text — the "master CV" the AI treats as the
 * only source of truth when rating jobs and writing tailored resumes.
 */
export function profileAsText(p = loadProfile()) {
  const lines = [];
  const push = (...xs) => lines.push(...xs.filter((x) => x != null && x !== ''));
  push(`NAME: ${p.name || ''}`, p.headline && `HEADLINE: ${p.headline}`, p.location && `LOCATION: ${p.location}`);
  if (p.summary) push('', 'SUMMARY:', p.summary.trim());
  if (p.experience?.length) {
    push('', 'WORK EXPERIENCE:');
    for (const e of p.experience) {
      push(`- [id: ${e.id}] ${e.title} @ ${e.company} (${e.period})${e.context ? ` — ${e.context}` : ''}`);
      for (const b of e.bullets || []) push(`    • ${b}`);
    }
  }
  if (p.projects?.length) {
    push('', 'PROJECTS:');
    for (const pr of p.projects) push(`- ${pr.name}: ${pr.description || ''}`);
  }
  if (p.skills && Object.keys(p.skills).length) {
    push('', 'SKILLS:');
    for (const [cat, body] of Object.entries(p.skills)) push(`- ${cat}: ${body}`);
  }
  if (p.education?.length) {
    push('', 'EDUCATION:');
    for (const ed of p.education) push(`- ${ed.degree}, ${ed.school} (${ed.period || ''})`);
  }
  if (p.recognition?.length) {
    push('', 'RECOGNITION:');
    for (const r of p.recognition) push(`- ${r.title}: ${r.body || ''}`);
  }
  const ctx = loadContext();
  if (ctx.trim()) push('', 'ADDITIONAL CONTEXT:', ctx.trim());
  return lines.join('\n');
}
