#!/usr/bin/env node
/**
 * rate.mjs — AI fit score (0-5 + reasons) for each job, written to score.json.
 *
 * The rubric is built from the `preferences` section of profile/profile.yml,
 * so each person's stack, dealbreakers and authorization decide the score.
 *
 *   node src/rate.mjs                 # rate every unrated job
 *   node src/rate.mjs --all           # re-rate everything
 *   node src/rate.mjs --folder 042-acme-frontend-engineer
 *   node src/rate.mjs --below 3       # re-rate jobs currently scored under 3
 *   node src/rate.mjs --limit 20 --concurrency 4
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, SETTINGS, loadProfile, profileAsText } from './config.mjs';
import { chatJson, llmConfigured } from './llm.mjs';
import { listFolders, parseJdHeader, readScore, writeScore } from './jobs.mjs';

const list = (xs) => (Array.isArray(xs) && xs.length ? xs.join('; ') : '');

export function ratingSystemPrompt(profile = loadProfile()) {
  const pref = profile.preferences || {};
  const auth = profile.work_authorization || {};
  return [
    'You rate how well one job fits one candidate, given their profile.',
    'Output STRICT JSON only: {"score": <number 0-5, one decimal>, "reasons": [<3 to 6 short strings>]}.',
    'Score: 0 = no fit, 5 = excellent fit.',
    'THE DOMINANT FACTOR IS TECH-STACK / SKILLS MATCH. When the job\'s core stack aligns with the candidate\'s, score it high (4-5).',
    'Do not lower the score just because the listed years of experience or the title seniority differ, when the stack matches.',
    pref.core_stack?.length && `Candidate core stack: ${list(pref.core_stack)}.`,
    pref.target_roles?.length && `Target roles: ${list(pref.target_roles)}.`,
    pref.mismatched_stacks?.length && `A job whose PRIMARY stack is one of these is a different stack and must score <= 2, even if some keywords overlap: ${list(pref.mismatched_stacks)}.`,
    pref.dealbreakers?.length && `Hard dealbreakers (score <= 1.5 if present): ${list(pref.dealbreakers)}.`,
    pref.nice_to_have?.length && `Nice to have (small bonus): ${list(pref.nice_to_have)}.`,
    pref.locations?.length && `Preferred locations: ${list(pref.locations)}. Remote OK: ${pref.remote_ok !== false ? 'yes' : 'no'}. Open to relocation: ${pref.open_to_relocation ? 'yes' : 'no'}.`,
    auth.summary && `Work authorization: ${auth.summary}. A job requiring authorization, citizenship or clearance the candidate lacks is a hard blocker.`,
    'Only genuine HARD BLOCKERS may pull a stack match down: work authorization, required clearance, a required license or degree the candidate lacks, or a fundamentally different stack.',
    'Score obvious scams or illegitimate postings low.',
    'reasons: concise strings — lead with the stack matches, then name any real blocker.',
  ].filter(Boolean).join(' ');
}

/** Rate one job ({ title, company, body }). Returns { score, reasons } or null. */
export async function rateOne(job, { profileText = profileAsText(), system = ratingSystemPrompt() } = {}) {
  if (!llmConfigured()) { console.error('  [rate] LLM not configured (set LLM_API_KEY in .env) — skipping'); return null; }
  if (!job?.body || String(job.body).trim().length < 30) return null;
  const jd = `${job.title ? `Title: ${job.title}\n` : ''}${job.company ? `Company: ${job.company}\n` : ''}\n${job.body}`;
  try {
    const parsed = await chatJson({
      model: SETTINGS.llm.ratingModel,
      system,
      user: `CANDIDATE PROFILE:\n${profileText.slice(0, 8000)}\n\nJOB DESCRIPTION:\n${jd.slice(0, 8000)}\n\nReturn the JSON rating.`,
      maxTokens: 2000,
      timeoutMs: 120000,
    });
    let score = Number.parseFloat(parsed.score);
    if (!Number.isFinite(score)) return null;
    score = Math.max(0, Math.min(5, Math.round(score * 10) / 10));
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()).slice(0, 8)
      : [];
    return { score, reasons };
  } catch (e) {
    console.error(`  [rate] ${e.message}`);
    return null;
  }
}

/** Rate a saved job folder and write score.json. Returns the rating or null. */
export async function rateFolder(folder, opts) {
  let text;
  try { text = await readFile(join(PATHS.jobs, folder, 'jd.txt'), 'utf8'); } catch { return null; }
  const h = parseJdHeader(text);
  const rating = await rateOne({ title: h.title, company: h.company, body: text }, opts);
  if (rating) await writeScore(folder, rating);
  return rating;
}

async function main() {
  const args = process.argv.slice(2);
  const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
  const only = val('--folder');
  const below = val('--below') != null ? Number(val('--below')) : null;
  const limit = val('--limit') != null ? Number(val('--limit')) : Infinity;
  const concurrency = Math.max(1, Number(val('--concurrency') || 4));

  if (!llmConfigured()) { console.error('LLM not configured — set LLM_API_KEY (and LLM_BASE_URL/LLM_MODEL) in .env'); process.exit(1); }
  const opts = { profileText: profileAsText(), system: ratingSystemPrompt() };

  let folders = only ? [only] : (await listFolders()).sort();
  if (!only && below != null) {
    const sel = [];
    for (const f of folders) { const s = await readScore(f); if (s && s.score < below) sel.push(f); }
    folders = sel;
  } else if (!only && !args.includes('--all')) {
    const sel = [];
    for (const f of folders) if (!(await readScore(f))) sel.push(f);
    folders = sel;
  }
  folders = folders.slice(0, limit);
  console.log(`rating ${folders.length} job(s) with ${SETTINGS.llm.ratingModel}…`);

  let ok = 0, fail = 0;
  for (let i = 0; i < folders.length; i += concurrency) {
    await Promise.all(folders.slice(i, i + concurrency).map(async (f) => {
      const r = await rateFolder(f, opts);
      if (r) { ok++; console.log(`  ✓ ${f} → ${r.score}/5`); } else { fail++; console.log(`  ✗ ${f}`); }
    }));
  }
  console.log(`done: ${ok} rated, ${fail} failed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
