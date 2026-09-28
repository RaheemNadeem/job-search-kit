#!/usr/bin/env node
/**
 * generate-cv.mjs — AI-tailored resume for a job, then render it to PDF.
 *
 * Reads the job's jd.txt and your profile, asks the model for a tailored
 * cv.json (truthful: emphasis and ordering of your REAL history only), then
 * runs build-cv.mjs to produce the HTML + PDF.
 *
 *   node resume/generate-cv.mjs --folder 042-acme-frontend-engineer
 *   node resume/generate-cv.mjs --min-score 3.5 [--limit 10]   # every good match without a resume
 *   node resume/generate-cv.mjs --folder X --force             # regenerate
 *   node resume/generate-cv.mjs --folder X --no-build          # cv.json only
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, SETTINGS, loadProfile, profileAsText } from '../src/config.mjs';
import { chatJson, llmConfigured } from '../src/llm.mjs';
import { listFolders, readScore } from '../src/jobs.mjs';
import { buildCv } from './build-cv.mjs';

function systemPrompt(p) {
  const t = p.tailoring || {};
  const auth = p.work_authorization || {};
  const roles = (p.experience || []).map((e) => `    "${e.id}": currently "${e.title}" (employer: ${e.company}, ${e.period})`).join('\n');
  return [
    'You write a tailored, TRUTHFUL resume data file (JSON) for one job, given the candidate profile and the job description.',
    'Output STRICT JSON only — no prose, no markdown fences. It is consumed by a build script.',
    '',
    'GROUND TRUTH: use ONLY facts, employers, projects, metrics and skills present in the candidate profile. NEVER invent',
    'experience, titles, metrics or technologies. Tailoring = emphasis and reordering of REAL history only.',
    '',
    'RULES:',
    '- Subtle only. Never say the candidate matches the posting; no meta references to "the job description".',
    '- No em dashes anywhere. Use "--" instead.',
    `- Seniority framing: ${t.seniority || 'match the candidate\'s real level'}.`,
    '- fit_title must be "What I Bring" or "What I Bring to <Company>".',
    t.retitle_roles !== false
      ? `- role_titles: retitle each role to emphasise the stack/domain this job wants, staying truthful to what the person did and at the same seniority. The value is the job title ONLY -- never include the company name, "@" or dates. Role ids:\n${roles}`
      : '- role_titles: return an empty object (role titles are fixed).',
    auth.summary
      ? `- Work authorization (${auth.summary}) must NOT appear in summary, tagline or work history.`
      : '',
    t.match_job_location
      ? '- location_note: if the job is on-site or hybrid in a specific city, use that city/state (the candidate is open to relocating); if remote, use "Remote".'
      : `- location_note: "${p.location_note || p.location || 'Remote'}" unless the job is remote, then "Remote".`,
    t.extra_rules ? `- ${t.extra_rules}` : '',
    '',
    'Field values may use light inline HTML: <strong>, &amp;, &middot;, &nbsp;. Put the job\'s core stack first.',
    '',
    'OUTPUT JSON (all keys):',
    '{',
    '  "title": string (exact job title),',
    '  "tagline": string (one line, e.g. "Full Stack Developer &middot; React &middot; Node.js"),',
    '  "location_note": string,',
    '  "role_titles": { "<role id>": string, ... },',
    '  "summary": [string, ...] (1-2 short paragraphs),',
    '  "fit_title": string,',
    '  "fit_cards": [{"title": string, "body": string}, ...] (2-3 cards),',
    '  "competencies": [string, ...] (6-8 keywords, most relevant first),',
    '  "evidence_title": "Relevant Expertise",',
    '  "evidence_blocks": [{"title": string, "body": string}, ...] (3-5, real achievements),',
    '  "skills": [{"cat": string, "body": string}, ...] (4-7 categories, relevant tech first),',
    '  "additional_notes": [string, ...] (0-2 short honest notes)',
    '}',
  ].filter((l) => l !== '').join('\n');
}

const deDash = (v) => {
  if (typeof v === 'string') return v.replace(/—|–|&mdash;|&ndash;/g, '--');
  if (Array.isArray(v)) return v.map(deDash);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deDash(x)]));
  return v;
};

/** Ask the model for a tailored cv.json object for one job. */
export async function tailorCv(jdText, folder, p = loadProfile()) {
  const cfg = deDash(await chatJson({
    model: SETTINGS.llm.resumeModel,
    system: systemPrompt(p),
    user: `CANDIDATE PROFILE (ground truth):\n${profileAsText(p).slice(0, 10000)}\n\nJOB DESCRIPTION:\n${jdText.slice(0, 8000)}\n\nReturn the tailored cv.json object.`,
    temperature: 0.4,
    maxTokens: 8000,
  }));
  cfg.slug = folder.replace(/^\d+-/, '').slice(0, 60);
  cfg.date = new Date().toISOString().slice(0, 10);
  cfg.format = cfg.format || p.tailoring?.paper || 'letter';
  if (!/what i bring/i.test(cfg.fit_title || '')) cfg.fit_title = 'What I Bring';
  // Only keep role titles for roles that exist in the profile.
  const ids = new Set((p.experience || []).map((e) => e.id));
  const companyOf = Object.fromEntries((p.experience || []).map((e) => [e.id, e.company]));
  cfg.role_titles = Object.fromEntries(Object.entries(cfg.role_titles || {})
    .filter(([id, title]) => ids.has(id) && typeof title === 'string' && title.trim())
    // Models sometimes append the employer ("… @ Acme", "… at Acme"); the template prints it already.
    .map(([id, title]) => [id, title.replace(/\s*(?:@|\bat\b|,|-{1,2}|\|)\s*$/i, '')
      .replace(new RegExp(`\\s*(?:@|\\bat\\b|,|-{1,2}|\\|)\\s*${companyOf[id].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'i'), '').trim()]));
  return cfg;
}

/** Generate cv.json (+ PDF unless build=false) for one job folder. */
export async function generateForFolder(folder, { build = true } = {}) {
  const dir = join(PATHS.jobs, folder);
  const jd = await readFile(join(dir, 'jd.txt'), 'utf8');
  const cfg = await tailorCv(jd, folder);
  const cfgPath = join(dir, 'cv.json');
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  if (build) await buildCv(cfgPath);
  return cfgPath;
}

const hasCv = (f) => access(join(PATHS.jobs, f, 'cv.json')).then(() => true, () => false);

/** Folders scoring >= minScore that have no resume yet, newest first. */
export async function pendingResumeFolders(minScore, { force = false } = {}) {
  const folders = (await listFolders()).sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
  const out = [];
  for (const f of folders) {
    const s = await readScore(f);
    if (s && s.score >= minScore && (force || !(await hasCv(f)))) out.push(f);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
  if (!llmConfigured()) { console.error('LLM not configured — set LLM_API_KEY (and LLM_BASE_URL/LLM_MODEL) in .env'); process.exit(1); }
  loadProfile();

  const only = val('--folder');
  const minScore = val('--min-score') != null ? Number(val('--min-score')) : SETTINGS.resumeMinScore;
  const limit = val('--limit') != null ? Number(val('--limit')) : Infinity;
  const force = args.includes('--force');
  const build = !args.includes('--no-build');

  let folders = only ? [only] : await pendingResumeFolders(minScore, { force });
  if (only && !force && await hasCv(only) && !build) { console.log('cv.json exists (use --force)'); return; }
  folders = folders.slice(0, limit);
  console.log(`generating ${folders.length} resume(s) with ${SETTINGS.llm.resumeModel}…`);

  let ok = 0, fail = 0;
  for (const f of folders) {
    try { await generateForFolder(f, { build }); ok++; console.log(`  ✓ ${f}`); }
    catch (e) { fail++; console.log(`  ✗ ${f}: ${e.message}`); }
  }
  console.log(`done: ${ok} generated, ${fail} failed.`);
  if (fail) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
