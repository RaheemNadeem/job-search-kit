#!/usr/bin/env node
/**
 * pipeline.mjs — search → queue → scrape → save → score → (resume).
 *
 *   node src/pipeline.mjs search            run the Indeed + LinkedIn searches in profile/search.json,
 *                                           queue new jobs, then process the queue
 *   node src/pipeline.mjs search --indeed   only Indeed (or --linkedin)
 *   node src/pipeline.mjs queue             process whatever is waiting in data/queue/
 *   node src/pipeline.mjs add <url> [url…]  queue job links by hand, then process them
 *
 * Only one pipeline run happens at a time (they share one browser profile);
 * a second run exits straight away. The dashboard server exposes the same
 * actions over HTTP so n8n can trigger them.
 */
import { readFile, writeFile, readdir, mkdir, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, SETTINGS } from './config.mjs';
import { canonicalJobKey, existingKeys, saveJob, writeScore } from './jobs.mjs';
import { rateOne } from './rate.mjs';
import { notify } from './notify.mjs';

const LOCK = () => join(PATHS.data, '.pipeline.lock');
const SEEN = () => join(PATHS.queue, '.seen.json');

export function loadSearch() {
  try { return JSON.parse(readFileSync(PATHS.search, 'utf8')); }
  catch { throw new Error('profile/search.json not found — copy profile/search.example.json and edit it.'); }
}

// ── lock ─────────────────────────────────────────────────────────────────────
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

export function pipelineBusy() {
  try {
    const pid = Number(readFileSync(LOCK(), 'utf8'));
    return pid && pidAlive(pid) ? pid : 0;
  } catch { return 0; }
}

async function withLock(fn) {
  await mkdir(PATHS.data, { recursive: true });
  const busy = pipelineBusy();
  if (busy) { console.error(`another pipeline run is in progress (pid ${busy}); skipping`); return { skipped: true }; }
  await writeFile(LOCK(), String(process.pid));
  try { return await fn(); } finally { await unlink(LOCK()).catch(() => {}); }
}

// ── queue ────────────────────────────────────────────────────────────────────
const siteOf = (url) => (/indeed\./i.test(url) ? 'indeed' : /linkedin\.com/i.test(url) ? 'linkedin' : '');

/**
 * Add job links to the queue. `entries` = strings or { url, tier }.
 * `meta` (e.g. { source: 'email', subject }) is kept for the summary.
 * Returns the number of links queued.
 */
export async function queueUrls(entries, meta = {}) {
  const rows = entries
    .map((e) => (typeof e === 'string' ? { url: e, tier: '' } : e))
    .filter((e) => /^https?:\/\//.test(e?.url || '') && siteOf(e.url));
  if (!rows.length) return 0;
  await mkdir(PATHS.queue, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${(meta.source || 'manual').replace(/[^a-z0-9-]/gi, '')}-${ts}.urls`;
  const text = `#META ${JSON.stringify(meta)}\n` + rows.map((r) => `${r.url}\t${r.tier || ''}`).join('\n') + '\n';
  await writeFile(join(PATHS.queue, name), text, 'utf8');
  return rows.length;
}

async function readQueue() {
  const files = (await readdir(PATHS.queue).catch(() => [])).filter((f) => f.endsWith('.urls')).sort();
  const items = [];
  const metas = [];
  for (const f of files) {
    const raw = await readFile(join(PATHS.queue, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (line.startsWith('#META')) { try { metas.push(JSON.parse(line.slice(5))); } catch { /* ignore */ } continue; }
      const [url, tier = ''] = line.trim().split('\t');
      if (/^https?:\/\//.test(url || '')) items.push({ url: url.trim(), tier: tier.trim() });
    }
  }
  return { files, items, metas };
}

async function loadSeen(days) {
  try {
    const o = JSON.parse(await readFile(SEEN(), 'utf8'));
    const cutoff = Date.now() - (days + 1) * 864e5;
    return Object.fromEntries(Object.entries(o).filter(([, ts]) => ts > cutoff));
  } catch { return {}; }
}

// ── processing ───────────────────────────────────────────────────────────────
async function processQueueInner() {
  const { files, items, metas } = await readQueue();
  if (!items.length) { console.error('queue is empty'); return { found: 0, saved: 0 }; }

  const known = await existingKeys();
  const byKey = new Map();
  for (const it of items) {
    const k = canonicalJobKey(it.url);
    if (!known.has(k) && !byKey.has(k)) byKey.set(k, it);
  }
  const todo = [...byKey.values()];
  const tierOf = new Map(todo.map((t) => [canonicalJobKey(t.url), t.tier]));
  console.error(`queue: ${items.length} link(s), ${todo.length} not saved yet`);

  let scraped = [];
  let blocked = [];
  if (todo.length) {
    const { launchBrowser, firstPage } = await import('../scrapers/browser.mjs');
    const ctx = await launchBrowser();
    try {
      const page = await firstPage(ctx);
      const indeed = todo.filter((t) => siteOf(t.url) === 'indeed').map((t) => t.url);
      const linkedin = todo.filter((t) => siteOf(t.url) === 'linkedin').map((t) => t.url);
      if (indeed.length) {
        const { scrapeIndeed } = await import('../scrapers/indeed.mjs');
        const r = await scrapeIndeed(page, indeed);
        scraped.push(...r.jobs); blocked.push(...r.blocked);
      }
      if (linkedin.length) {
        const { scrapeLinkedIn } = await import('../scrapers/linkedin.mjs');
        const r = await scrapeLinkedIn(page, linkedin);
        scraped.push(...r.jobs); blocked.push(...r.blocked);
      }
    } finally { await ctx.close().catch(() => {}); }
  }

  const created = [];
  for (const job of scraped) {
    job.searchTier = tierOf.get(canonicalJobKey(job.url)) || '';
    try {
      const { folder, created: isNew } = await saveJob(job, known);
      if (!isNew) continue;
      job.folder = folder;
      job.rating = await rateOne(job);
      if (job.rating) await writeScore(folder, job.rating);
      created.push(job);
      console.error(`NEW  ${folder}${job.rating ? `  ★ ${job.rating.score}` : ''}`);
    } catch (e) { console.error(`save failed for ${job.url}: ${e.message}`); }
  }

  let resumes = 0;
  if (SETTINGS.autoResume) {
    const { generateForFolder } = await import('../resume/generate-cv.mjs');
    for (const j of created.filter((x) => x.rating?.score >= SETTINGS.resumeMinScore)) {
      try { await generateForFolder(j.folder); resumes++; } catch (e) { console.error(`resume failed for ${j.folder}: ${e.message}`); }
    }
  }

  // Archive processed queue files.
  const done = join(PATHS.queue, 'processed');
  await mkdir(done, { recursive: true });
  for (const f of files) await rename(join(PATHS.queue, f), join(done, f)).catch(() => {});

  const summary = { found: items.length, scraped: scraped.length, saved: created.length, blocked: blocked.length, resumes };
  await sendSummary(summary, created, blocked, metas);
  return summary;
}

async function sendSummary(s, created, blocked, metas) {
  if (!s.saved && !s.blocked) return;   // nothing worth telling anyone
  const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const top = [...created].sort((a, b) => (b.rating?.score ?? -1) - (a.rating?.score ?? -1));
  const rows = top.map((j) => `<li>${j.rating ? `<b>★ ${j.rating.score}</b> ` : ''}${esc(j.title)} — ${esc(j.company)}${j.location ? ` · ${esc(j.location)}` : ''}${j.searchTier ? ` <small>[${esc(j.searchTier)}]</small>` : ''} <a href="${esc(j.url)}">view</a>${j.rating?.reasons?.length ? `<br><small>${j.rating.reasons.map(esc).join(' · ')}</small>` : ''}</li>`).join('');
  const sources = [...new Set(metas.map((m) => m.source).filter(Boolean))].join(', ') || 'queue';
  const html = `<p><b>Job import (${esc(sources)})</b>: ${s.found} link(s), ${s.saved} new job(s) saved`
    + `${s.blocked ? `, <b style="color:#b00">${s.blocked} blocked</b>` : ''}${s.resumes ? `, ${s.resumes} resume(s) generated` : ''}.</p>`
    + (rows ? `<ul>${rows}</ul>` : '')
    + (blocked.length ? `<p>Blocked — open these by hand or capture them with the browser extension:</p><ul>${blocked.map((u) => `<li><a href="${esc(u)}">${esc(u)}</a></li>`).join('')}</ul>` : '');
  await notify('import-summary', {
    subject: `Job import: ${s.saved} new, ${s.blocked} blocked`,
    text: top.map((j) => `${j.rating ? `★${j.rating.score} ` : ''}${j.title} — ${j.company} ${j.url}`).join('\n'),
    html,
    summary: s,
    jobs: top.map(({ folder, title, company, location, url, rating }) => ({ folder, title, company, location, url, score: rating?.score ?? null })),
  });
}

export const processQueue = () => withLock(processQueueInner);

/** Run the configured searches, queue new jobs, then process the queue. */
export function runSearch({ indeed = true, linkedin = true } = {}) {
  return withLock(async () => {
    const cfg = loadSearch();
    const known = await existingKeys();
    const days = Math.max(cfg.indeed?.fromageDays ?? 1, cfg.linkedin?.fromageDays ?? 1);
    const seen = await loadSeen(days);
    const skip = new Set([...known.keys(), ...Object.keys(seen)]);
    const found = [];

    const { launchBrowser, firstPage } = await import('../scrapers/browser.mjs');
    const ctx = await launchBrowser();
    try {
      const page = await firstPage(ctx);
      if (indeed && cfg.indeed?.enabled !== false && cfg.indeed?.queries?.length) {
        const { searchIndeed } = await import('../scrapers/indeed.mjs');
        found.push(...await searchIndeed(page, cfg.indeed, skip));
      }
      if (linkedin && cfg.linkedin?.enabled !== false && cfg.linkedin?.queries?.length) {
        const { searchLinkedIn } = await import('../scrapers/linkedin.mjs');
        found.push(...await searchLinkedIn(page, cfg.linkedin, skip));
      }
    } finally { await ctx.close().catch(() => {}); }

    console.error(`search: ${found.length} new job link(s)`);
    if (!found.length) return { found: 0, saved: 0 };
    await queueUrls(found, { source: 'search' });
    const now = Date.now();
    for (const f of found) seen[canonicalJobKey(f.url)] = now;
    await mkdir(PATHS.queue, { recursive: true });
    await writeFile(SEEN(), JSON.stringify(seen), 'utf8');
    return processQueueInner();
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let result;
  if (cmd === 'search') {
    const only = rest.includes('--indeed') ? 'indeed' : rest.includes('--linkedin') ? 'linkedin' : '';
    result = await runSearch({ indeed: !only || only === 'indeed', linkedin: !only || only === 'linkedin' });
  } else if (cmd === 'queue') {
    result = await processQueue();
  } else if (cmd === 'add') {
    const n = await queueUrls(rest.filter((a) => !a.startsWith('--')), { source: 'manual' });
    console.error(`queued ${n} link(s)`);
    result = await processQueue();
  } else {
    console.error('usage: pipeline.mjs search [--indeed|--linkedin] | queue | add <url> [url…]');
    process.exit(1);
  }
  console.log(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
