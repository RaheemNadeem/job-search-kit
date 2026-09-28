#!/usr/bin/env node
/**
 * Dashboard server — the hub everything talks to.
 *
 *   Browser dashboard        GET  /
 *   Browser extension        POST /jd                      save the job you're looking at
 *   Dashboard actions        GET  /api/jobs, /api/jd, /files
 *                            POST /api/score, /api/submit, /api/skip, /api/generate-cv
 *                            DELETE /api/job
 *                            GET  /api/rate-unrated        (server-sent progress events)
 *   n8n / automation         POST /api/search              start an Indeed + LinkedIn search run
 *                            POST /api/queue               queue job links (e.g. from alert emails)
 *                            GET  /api/status              is a pipeline run in progress?
 *                            GET  /api/top?min=4&hours=24  best new jobs, for a digest
 *   Health                   GET  /health
 *
 * Security: listens on 127.0.0.1 by default. Requests from other machines
 * (e.g. n8n in Docker) are refused unless DASHBOARD_TOKEN is set and sent as
 * `Authorization: Bearer <token>`. In a browser, only the dashboard page itself
 * may call the API, and only Indeed/LinkedIn pages may POST /jd — so other
 * websites you visit can't touch your data.
 *
 * Usage: npm start   (or: node dashboard/server.mjs)
 */
import http from 'node:http';
import { readdir, readFile, writeFile, stat, rm, unlink, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ROOT, PATHS, SETTINGS } from '../src/config.mjs';
import { FOLDER_RE, listFolders, parseJdHeader, saveJob, readScore } from '../src/jobs.mjs';
import { rateFolder, ratingSystemPrompt } from '../src/rate.mjs';
import { llmConfigured } from '../src/llm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = join(HERE, 'dashboard.html');
const { host: HOST, port: PORT, token: TOKEN } = SETTINGS.server;
const JOB_SITE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(indeed\.com|linkedin\.com)$/i;

// ── helpers ──────────────────────────────────────────────────────────────────
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((ok, fail) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) { fail(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { ok(raw ? JSON.parse(raw) : {}); } catch { fail(new Error('invalid JSON')); } });
    req.on('error', fail);
  });
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const hasToken = (req) => Boolean(TOKEN) && req.headers.authorization === `Bearer ${TOKEN}`;

/** Returns an error string when the request must be refused, else null. */
function guard(req, url) {
  if (!isLoopback(req) && !hasToken(req)) {
    return TOKEN ? 'missing or wrong token' : 'remote access is off (set DASHBOARD_TOKEN to allow it)';
  }
  // Browsers label every request with where it came from. Only the dashboard
  // (same-origin) or a typed URL (none) may use the API; job-site pages may
  // only save a job. Non-browser clients (n8n, curl) send no such header.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    const origin = req.headers.origin || '';
    if (!(url.pathname === '/jd' && JOB_SITE_ORIGIN.test(origin))) return 'cross-site request refused';
  }
  return null;
}

function folderPath(folder) {
  if (!FOLDER_RE.test(folder)) return null;
  const p = resolve(PATHS.jobs, folder);
  return p.startsWith(PATHS.jobs + '/') || p.startsWith(PATHS.jobs + '\\') ? p : null;
}

// ── job listing ──────────────────────────────────────────────────────────────
async function inspectFolder(folderName) {
  const dir = join(PATHS.jobs, folderName);
  const num = /^(\d+)-/.exec(folderName)?.[1] || '';
  const { score = null, reasons = [] } = (await readScore(folderName)) || {};
  let files = [];
  try { files = await readdir(dir); } catch { /* */ }
  const find = (re) => files.find((f) => re.test(f)) || '';
  const htmlCv = find(/^cv-.*\.html$/i);
  const pdfCv = find(/^cv-.*\.pdf$/i);
  const htmlCover = find(/^cover-letter-.*\.html$/i);
  const pdfCover = find(/^cover-letter-.*\.pdf$/i);

  let skipNote = null;
  if (files.includes('skip.json')) {
    try { skipNote = JSON.parse(await readFile(join(dir, 'skip.json'), 'utf8')).note || null; } catch { /* */ }
  }

  let header = { title: '', company: '', location: '', salary: '', url: '', applyType: '', searchTier: '', body: '' };
  let mtime = 0;
  if (files.includes('jd.txt')) {
    try {
      header = parseJdHeader(await readFile(join(dir, 'jd.txt'), 'utf8'));
      mtime = (await stat(join(dir, 'jd.txt'))).mtimeMs;
    } catch { /* */ }
  }
  return {
    num, slug: folderName.replace(/^\d+-/, ''), folder: folderName, path: `data/jobs/${folderName}`,
    title: header.title, company: header.company, location: header.location, salary: header.salary,
    url: header.url, applyType: header.applyType, searchTier: header.searchTier,
    bodyPreview: header.body.slice(0, 280),
    hasJd: files.includes('jd.txt'),
    hasHtmlCv: !!htmlCv, hasPdfCv: !!pdfCv, hasHtmlCover: !!htmlCover, hasPdfCover: !!pdfCover,
    htmlCvName: htmlCv, pdfCvName: pdfCv, htmlCoverName: htmlCover, pdfCoverName: pdfCover,
    hasCvJson: files.includes('cv.json'),
    submitted: files.includes('submitted.flag'),
    score, scoreReasons: reasons, skipNote, mtime,
  };
}

async function allJobs() {
  const jobs = await Promise.all((await listFolders()).map(inspectFolder));
  return jobs.sort((a, b) => Number(b.num) - Number(a.num));
}

// ── background work ──────────────────────────────────────────────────────────
function startPipeline(args) {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'pipeline.mjs'), ...args], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
  });
  child.on('exit', (code) => console.log(`pipeline ${args.join(' ')} finished (exit ${code})`));
}

const generating = new Set();

// ── routes ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '';
    if (url.pathname === '/jd' && JOB_SITE_ORIGIN.test(origin)) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
    } else res.writeHead(204);
    return res.end();
  }

  const refused = guard(req, url);
  if (refused) return sendJson(res, 403, { ok: false, error: refused });

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(DASHBOARD_HTML, 'utf8'));
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, llm: llmConfigured() });
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      return sendJson(res, 200, { ok: true, jobs: await allJobs() });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const { pipelineBusy } = await import('../src/pipeline.mjs');
      return sendJson(res, 200, { ok: true, busy: Boolean(pipelineBusy()), generating: [...generating] });
    }

    // Best recent jobs — for n8n's daily digest.
    if (req.method === 'GET' && url.pathname === '/api/top') {
      const min = Number(url.searchParams.get('min') ?? 4);
      const hours = Number(url.searchParams.get('hours') ?? 24);
      const since = Date.now() - hours * 3600e3;
      const jobs = (await allJobs())
        .filter((j) => typeof j.score === 'number' && j.score >= min && j.mtime >= since && !j.skipNote && !j.submitted)
        .sort((a, b) => b.score - a.score)
        .map(({ folder, title, company, location, salary, url: link, score, scoreReasons, hasPdfCv }) =>
          ({ folder, title, company, location, salary, url: link, score, reasons: scoreReasons, hasResume: hasPdfCv }));
      return sendJson(res, 200, { ok: true, count: jobs.length, jobs });
    }

    if (req.method === 'GET' && url.pathname === '/files') {
      const folder = url.searchParams.get('folder') || '';
      const name = url.searchParams.get('name') || '';
      const dir = folderPath(folder);
      if (!dir) return sendJson(res, 400, { ok: false, error: 'Invalid folder' });
      if (!/^(cv|cover-letter)-[\w.-]+\.(pdf|html)$/i.test(name)) return sendJson(res, 400, { ok: false, error: 'Invalid filename' });
      try {
        const buf = await readFile(join(dir, name));
        res.writeHead(200, {
          'Content-Type': name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8',
          'Content-Disposition': `inline; filename="${name}"`,
          'Cache-Control': 'no-cache',
        });
        return res.end(buf);
      } catch { return sendJson(res, 404, { ok: false, error: 'File not found' }); }
    }

    if (req.method === 'GET' && url.pathname === '/api/jd') {
      const dir = folderPath(url.searchParams.get('folder') || '');
      if (!dir) return sendJson(res, 400, { ok: false, error: 'Invalid folder' });
      try { return sendJson(res, 200, { ok: true, text: await readFile(join(dir, 'jd.txt'), 'utf8') }); }
      catch { return sendJson(res, 404, { ok: false, error: 'jd.txt not found' }); }
    }

    // Save a job from the browser extension or the dashboard's "+ Add JD".
    if (req.method === 'POST' && url.pathname === '/jd') {
      const origin = req.headers.origin || '';
      if (JOB_SITE_ORIGIN.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
      const data = await readBody(req);
      const applyType = ['indeed', 'linkedin', 'company', 'unknown'].includes(String(data.applyType).toLowerCase())
        ? String(data.applyType).toLowerCase()
        : /linkedin\.com/i.test(data.url || '') ? 'linkedin' : '';
      if (!data.body || String(data.body).trim().length < 30) return sendJson(res, 400, { ok: false, error: 'Empty or too-short JD body' });
      const { folder, created } = await saveJob({ ...data, applyType });
      const num = /^(\d+)-/.exec(folder)?.[1] || '?';
      if (!created) return sendJson(res, 409, { ok: false, duplicate: true, folder, num, error: `Already saved as #${num} — ${folder}` });
      console.log(`✅ saved data/jobs/${folder}  (${data.title || '?'} @ ${data.company || '?'})`);
      // Score it in the background so the extension gets an instant reply.
      if (llmConfigured()) rateFolder(folder).then((r) => r && console.log(`★ ${folder} → ${r.score}/5`));
      return sendJson(res, 200, { ok: true, folder, num, path: `data/jobs/${folder}/jd.txt` });
    }

    if (req.method === 'POST' && url.pathname === '/api/score') {
      const dir = folderPath(url.searchParams.get('folder') || '');
      if (!dir) return sendJson(res, 400, { ok: false, error: 'Invalid folder' });
      const raw = url.searchParams.get('score');
      if (raw == null || raw === '' || raw === 'clear') {
        await unlink(join(dir, 'score.json')).catch(() => {});
        return sendJson(res, 200, { ok: true, score: null });
      }
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n) || n < 0 || n > 5) return sendJson(res, 400, { ok: false, error: 'Score must be 0-5' });
      const existing = await readScore(url.searchParams.get('folder'));
      await writeFile(join(dir, 'score.json'), JSON.stringify({ score: Number(n.toFixed(1)), reasons: existing?.reasons || [] }, null, 2) + '\n');
      return sendJson(res, 200, { ok: true, score: n });
    }

    if (req.method === 'POST' && url.pathname === '/api/submit') {
      const dir = folderPath(url.searchParams.get('folder') || '');
      if (!dir) return sendJson(res, 400, { ok: false, error: 'Invalid folder' });
      const flag = join(dir, 'submitted.flag');
      let submitted;
      try { await access(flag); await unlink(flag); submitted = false; }
      catch { await writeFile(flag, new Date().toISOString() + '\n'); submitted = true; }
      return sendJson(res, 200, { ok: true, submitted });
    }

    if (req.method === 'POST' && url.pathname === '/api/skip') {
      const data = await readBody(req, 100_000);
      const dir = folderPath(data.folder || '');
      if (!dir) return sendJson(res, 400, { ok: false, error: 'Invalid folder' });
      const note = String(data.note || '').trim();
      if (!note) { await unlink(join(dir, 'skip.json')).catch(() => {}); return sendJson(res, 200, { ok: true, skipNote: null }); }
      await writeFile(join(dir, 'skip.json'), JSON.stringify({ note, skippedAt: new Date().toISOString() }, null, 2) + '\n');
      return sendJson(res, 200, { ok: true, skipNote: note });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/job') {
      const dir = folderPath(url.searchParams.get('folder') || '');
      if (!dir) return sendJson(res, 400, { ok: false, error: 'Invalid folder' });
      await rm(dir, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }

    // Tailor + render a resume for one job (takes ~30-90s).
    if (req.method === 'POST' && url.pathname === '/api/generate-cv') {
      const folder = url.searchParams.get('folder') || '';
      const dir = folderPath(folder);
      if (!dir) return sendJson(res, 400, { ok: false, error: 'Invalid folder' });
      if (!(await access(join(dir, 'jd.txt')).then(() => true, () => false))) return sendJson(res, 404, { ok: false, error: 'Job not found' });
      if (!llmConfigured()) return sendJson(res, 400, { ok: false, error: 'LLM not configured — set LLM_API_KEY in .env' });
      if (generating.has(folder)) return sendJson(res, 409, { ok: false, error: 'Already generating' });
      generating.add(folder);
      try {
        const { generateForFolder } = await import('../resume/generate-cv.mjs');
        await generateForFolder(folder);
        return sendJson(res, 200, { ok: true, job: await inspectFolder(folder) });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      } finally { generating.delete(folder); }
    }

    if (req.method === 'GET' && url.pathname === '/api/rate-unrated') return rateUnrated(req, res);

    // ── automation (n8n) ──
    if (req.method === 'POST' && url.pathname === '/api/search') {
      const { pipelineBusy } = await import('../src/pipeline.mjs');
      if (pipelineBusy()) return sendJson(res, 409, { ok: false, busy: true, error: 'A pipeline run is already in progress' });
      const data = await readBody(req).catch(() => ({}));
      const only = data.source === 'indeed' ? ['--indeed'] : data.source === 'linkedin' ? ['--linkedin'] : [];
      startPipeline(['search', ...only]);
      return sendJson(res, 202, { ok: true, started: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/queue') {
      const { queueUrls, pipelineBusy } = await import('../src/pipeline.mjs');
      const data = await readBody(req);
      const urls = Array.isArray(data.urls) ? data.urls : [];
      const n = await queueUrls(urls, { source: data.source || 'api', subject: data.subject || '', from: data.from || '' });
      // A running pipeline picks the new file up on its next pass; otherwise start one.
      if (n && !pipelineBusy()) startPipeline(['queue']);
      return sendJson(res, 202, { ok: true, queued: n });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    console.error('❌', err);
    return sendJson(res, 500, { ok: false, error: String(err.message || err) });
  }
});

// ── rate every unrated job, streaming progress (Server-Sent Events) ──────────
async function rateUnrated(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 15_000);
  let aborted = false;
  req.on('close', () => { aborted = true; clearInterval(heartbeat); });
  try {
    if (!llmConfigured()) { send('fatal', { error: 'LLM not configured — set LLM_API_KEY in .env' }); return; }
    const targets = (await allJobs()).filter((j) => j.score == null && j.hasJd);
    send('start', { total: targets.length });
    const { profileAsText } = await import('../src/config.mjs');
    const opts = { profileText: profileAsText(), system: ratingSystemPrompt() };
    let rated = 0, errors = 0;
    for (let i = 0; i < targets.length && !aborted; i++) {
      const job = targets[i];
      const base = { index: i + 1, total: targets.length, num: job.num, slug: job.slug, folder: job.folder, company: job.company, title: job.title };
      send('progress', { ...base, status: 'rating' });
      const r = await rateFolder(job.folder, opts);
      if (r) { rated++; send('progress', { ...base, ...r, status: 'rated' }); }
      else { errors++; send('error', { ...base, error: 'rating failed (see server log)' }); }
    }
    send('done', { rated, errors, skipped: 0, total: targets.length });
  } catch (err) {
    send('fatal', { error: String(err.message || err) });
  } finally {
    clearInterval(heartbeat);
    try { res.end(); } catch { /* */ }
  }
}

server.listen(PORT, HOST, () => {
  console.log(`🌉 Job Search Kit dashboard: http://localhost:${PORT}/`);
  console.log(`📁 Jobs: ${PATHS.jobs}`);
  if (HOST !== '127.0.0.1' && !TOKEN) console.log('⚠️  Listening beyond localhost but DASHBOARD_TOKEN is not set — remote requests will be refused.');
  if (!llmConfigured()) console.log('⚠️  LLM not configured — scoring and resume generation are off until you set LLM_API_KEY in .env');
});
