/**
 * jobs.mjs — the job store. Every job is a folder under data/jobs/:
 *
 *   data/jobs/042-acme-frontend-engineer/
 *     jd.txt        header lines + "---" + the job description
 *     score.json    { score: 0-5, reasons: [...] }       (AI rating)
 *     cv.json       tailored resume content              (AI resume writer)
 *     cv-<name>-<slug>-<date>.html / .pdf                (rendered resume)
 *     submitted.flag / skip.json                         (your tracking)
 *
 * The dashboard, the browser extension, the scrapers and n8n all write jobs
 * through saveJob(), so deduplication and numbering behave the same everywhere.
 */
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from './config.mjs';

export const FOLDER_RE = /^\d+-[a-z0-9-]+$/i;

/** A stable identity for a job URL, so the same posting is never saved twice. */
export function canonicalJobKey(rawUrl = '') {
  try {
    const u = new URL(rawUrl);
    // Indeed uses jk= on the job page and vjk= on search results for the same job.
    const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
    if (jk) return 'indeed:' + jk;
    const li = rawUrl.match(/linkedin\.com\/.*jobs\/view\/(?:[^/?#]*-)?(\d{6,})/) || rawUrl.match(/currentJobId=(\d+)/) || rawUrl.match(/jobPosting[:/](\d+)/);
    if (li) return 'linkedin:' + li[1];
    ['tk', 'rgtk', 'from', 'xpse', 'xfps', 'xkcb', 'utm_source', 'utm_medium', 'utm_campaign',
      'alid', 'advn', 'adid', 'ad', 'sjdu', 'acatk', 'pub', 'camk', 'fromage', 'radius', 'trk', 'refId', 'trackingId']
      .forEach((p) => u.searchParams.delete(p));
    return u.toString();
  } catch { return rawUrl; }
}

export function slugify(s = '') {
  return String(s).toLowerCase().replace(/[^\w\s-]/g, '').replace(/_/g, '-')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function makeSlug(company, title) {
  const c = slugify(company).split('-').filter(Boolean).slice(0, 2).join('-');
  const t = slugify(title)
    .replace(/^(senior|sr|jr|junior|lead|principal|staff)-/i, '')
    .replace(/-job-post$/i, '')
    .split('-').filter(Boolean).slice(0, 4).join('-');
  return ([c, t].filter(Boolean).join('-') || 'untitled').slice(0, 60);
}

/** Job-board shortlinks rotate, so company+title is a second dedup key. */
export function contentKey(company = '', title = '') {
  return `${slugify(company)}|${slugify(title)}`;
}

export async function listFolders() {
  try {
    const entries = await readdir(PATHS.jobs, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && /^\d+-/.test(e.name)).map((e) => e.name);
  } catch { return []; }
}

export function parseJdHeader(text = '') {
  const out = { title: '', company: '', location: '', salary: '', url: '', applyType: '', searchTier: '', body: '' };
  if (!text) return out;
  const [head, ...rest] = text.split(/\n---\n/);
  out.body = rest.join('\n---\n').trim();
  const lines = head.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length) out.title = lines[0];
  for (const line of lines.slice(1)) {
    const m = /^(Company|Location|Pay|Salary|URL|Apply|Search):\s*(.+)$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'company') out.company = m[2];
    else if (k === 'location') out.location = m[2];
    else if (k === 'pay' || k === 'salary') out.salary = m[2];
    else if (k === 'url') out.url = m[2];
    else if (k === 'apply') out.applyType = m[2].toLowerCase();
    else if (k === 'search') out.searchTier = m[2];
  }
  return out;
}

export function jdText({ title = '', company = '', location = '', salary = '', url = '', applyType = '', searchTier = '', body = '' }) {
  const header = [
    title,
    company && `Company: ${company}`,
    location && `Location: ${location}`,
    salary && `Pay: ${salary}`,
    url && `URL: ${url}`,
    applyType && `Apply: ${String(applyType).toLowerCase()}`,
    searchTier && `Search: ${searchTier}`,
  ].filter(Boolean).join('\n');
  return `${header}\n\n---\n\n${String(body).trim()}\n`;
}

/** Keys of every saved job, mapped to the folder that holds it. */
export async function existingKeys() {
  const folderFor = new Map();
  for (const folder of await listFolders()) {
    try {
      const { title, company, url } = parseJdHeader(await readFile(join(PATHS.jobs, folder, 'jd.txt'), 'utf8'));
      for (const k of [url && canonicalJobKey(url), (company || title) && contentKey(company, title)]) {
        if (k && !folderFor.has(k)) folderFor.set(k, folder);
      }
    } catch { /* unreadable folder — ignore */ }
  }
  return folderFor;
}

async function nextFolderNum() {
  const nums = (await listFolders()).map((n) => Number(/^(\d+)-/.exec(n)?.[1])).filter(Number.isFinite);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

/**
 * Save one job. Returns { folder, created: true } for a new job, or
 * { folder, created: false } when it was already saved.
 * Pass a `known` map from existingKeys() when saving many jobs in a row.
 */
export async function saveJob(job, known) {
  if (!job?.body || String(job.body).trim().length < 30) throw new Error('job description is empty or too short');
  const keys = known || await existingKeys();
  const urlKey = job.url ? canonicalJobKey(job.url) : '';
  const cKey = (job.company || job.title) ? contentKey(job.company, job.title) : '';
  const hit = (urlKey && keys.get(urlKey)) || (cKey && keys.get(cKey));
  if (hit) return { folder: hit, created: false };

  const folder = `${String(await nextFolderNum()).padStart(3, '0')}-${makeSlug(job.company, job.title)}`;
  await mkdir(join(PATHS.jobs, folder), { recursive: true });
  await writeFile(join(PATHS.jobs, folder, 'jd.txt'), jdText(job), 'utf8');
  for (const k of [urlKey, cKey]) if (k) keys.set(k, folder);
  return { folder, created: true };
}

export async function readScore(folder) {
  try {
    const d = JSON.parse(await readFile(join(PATHS.jobs, folder, 'score.json'), 'utf8'));
    const n = Number.parseFloat(d.score);
    return Number.isFinite(n) ? { score: n, reasons: Array.isArray(d.reasons) ? d.reasons : [] } : null;
  } catch { return null; }
}

export async function writeScore(folder, rating) {
  await writeFile(join(PATHS.jobs, folder, 'score.json'), JSON.stringify(rating, null, 2) + '\n', 'utf8');
}
