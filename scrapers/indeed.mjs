#!/usr/bin/env node
/**
 * indeed.mjs — Indeed search + job-description scraper.
 *
 *   node scrapers/indeed.mjs --login [ca.indeed.com]   sign in once (optionally on a country site)
 *   node scrapers/indeed.mjs --search [--dry-run]      run the searches in profile/search.json, print new job URLs
 *   node scrapers/indeed.mjs --urls-file F [--out F]   scrape these job pages into a JSON array
 *
 * Normally you don't call this directly — `npm run search` / `npm run queue`
 * (src/pipeline.mjs) drive it, and n8n drives those.
 */
import { readFile } from 'node:fs/promises';
import { launchBrowser, firstPage, loginFlow, humanHelper, emit } from './browser.mjs';

const CHALLENGE_RE = /just a moment|verification required|blocked|attention required/i;

export const jkOf = (url) => {
  try { const u = new URL(url); return u.searchParams.get('jk') || u.searchParams.get('vjk') || ''; }
  catch { return ''; }
};

async function classifyBlock(page) {
  const i = await page.evaluate(() => ({ t: document.title, u: location.href, b: (document.body?.innerText || '').slice(0, 600) }))
    .catch(() => ({ t: '', u: '', b: '' }));
  if (CHALLENGE_RE.test(i.t)) return 'captcha';
  if (/secure\.indeed\.com|\/account\/login|\/auth(\b|\/)|\/login\b/i.test(i.u)
    || /\bsign in\b/i.test(i.t) || /sign in to (continue|your account)/i.test(i.b)) return 'login';
  return null;
}

/** Wait for the Cloudflare interstitial to clear and the description to render. */
async function waitForJob(page, maxMs = 45000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => ({
      t: document.title,
      jd: (document.querySelector('#jobDescriptionText, .simple-job-description-html')?.innerText || '').length,
    })).catch(() => ({ t: '', jd: 0 }));
    if (!CHALLENGE_RE.test(s.t) && s.jd > 80) return true;
  }
  return false;
}

/** Scrape Indeed job pages. Returns [{ url, title, company, location, salary, body, applyType }]. */
export async function scrapeIndeed(page, urls) {
  const waitForHuman = humanHelper('Indeed');
  await page.goto('https://www.indeed.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);   // let Cloudflare set clearance on the profile

  const jobs = [];
  const blocked = [];
  for (const url of urls) {
    const jk = jkOf(url);
    // Keep the job's own country host — a country job only resolves there.
    let target = url;
    if (jk) { try { target = `${new URL(url).origin}/viewjob?jk=${jk}`; } catch { target = `https://www.indeed.com/viewjob?jk=${jk}`; } }
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }); ok = await waitForJob(page); }
      catch (e) { console.error(`  nav error ${target}: ${e.message}`); }
      if (!ok) await page.waitForTimeout(3000);
    }
    if (!ok) {
      const reason = await classifyBlock(page);
      if (reason && await waitForHuman(page, reason, target, classifyBlock)) ok = await waitForJob(page);
    }
    if (!ok) { blocked.push(url); console.error(`SKIP (blocked/empty): ${target}`); continue; }

    // Indeed serves two page layouts: the classic one (#jobDescriptionText,
    // inlineHeader-*) and a newer one (vj-job-title, company-info-*,
    // .simple-job-description-html). Try both.
    const data = await page.evaluate(() => {
      const pick = (...ss) => { for (const s of ss) { const e = document.querySelector(s); const t = e?.innerText || e?.textContent || ''; if (t.trim()) return t.trim(); } return ''; };
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const metaLines = (document.querySelector('[data-testid="company-info-metadata"]')?.innerText || '')
        .split('\n').map((l) => l.trim()).filter((l) => l && l !== '·' && !/^\d(\.\d)?$/.test(l));
      // Pay: only look inside this job's own details, never the "similar jobs" sidebar.
      const details = document.querySelector('#jobDetailsSection, #salaryInfoAndJobType');
      const pay = (details?.innerText || '').split('\n').map((l) => l.trim())
        .find((l) => /[$£€₹][\d,.]+.*\b(year|hour|month|week|day)\b/i.test(l) && l.length < 80) || '';
      return {
        title: pick('[data-testid="vj-job-title"]', 'h1[data-testid="jobsearch-JobInfoHeader-title"]', 'h2[data-testid="jobsearch-JobInfoHeader-title"]', '.jobsearch-JobInfoHeader-title', 'h1').replace(/\s+-\s*job\s*post\s*$/i, '').trim(),
        company: clean(pick('[data-testid="inlineHeader-companyName"] a', '[data-testid="inlineHeader-companyName"]', '[data-company-name="true"]')) || metaLines[0] || '',
        location: clean(pick('[data-testid="inlineHeader-companyLocation"]', '[data-testid="jobsearch-JobInfoHeader-companyLocation"]')) || (metaLines.length > 1 ? metaLines[metaLines.length - 1] : ''),
        salary: clean(pick('#salaryInfoAndJobType')) || clean(pay),
        body: pick('#jobDescriptionText', '.simple-job-description-html', '.jobsearch-JobComponent-description'),
      };
    });
    if (!data.body || data.body.trim().length < 30 || !data.title) { blocked.push(url); console.error(`SKIP (thin): ${target}`); continue; }
    jobs.push({ ...data, url: page.url(), applyType: 'indeed' });
    console.error(`OK   ${data.title} @ ${data.company}`);
    await page.waitForTimeout(1500);
  }
  return { jobs, blocked };
}

/** Every job key on the currently loaded results page. */
async function jksOnPage(page) {
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(1800);
    const s = await page.evaluate(() => ({ t: document.title, n: document.querySelectorAll('[data-jk]').length })).catch(() => ({ t: '', n: 0 }));
    if (CHALLENGE_RE.test(s.t)) { if (i === 15) return { jks: [], blocked: true }; continue; }
    if (s.n > 0) {
      const jks = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-jk]')].map((e) => e.getAttribute('data-jk')).filter(Boolean))]);
      return { jks, blocked: false };
    }
    if (i >= 4) return { jks: [], blocked: false };   // loaded, genuinely no results
  }
  return { jks: [], blocked: false };
}

/** Walk result pages (10 per page) for one query in one tier. */
async function collect(page, q, tier, fromageDays) {
  const domain = tier.domain || 'www.indeed.com';
  const base = { q, fromage: String(fromageDays), sort: 'date' };
  if (tier.l) base.l = tier.l;
  if (tier.radius) base.radius = String(tier.radius);
  const all = new Set();
  for (let p = 0; p < (tier.maxPages ?? 25); p++) {
    const params = new URLSearchParams({ ...base, start: String(p * 10) });
    await page.goto(`https://${domain}/jobs?${params}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const { jks, blocked } = await jksOnPage(page);
    if (blocked) { console.error(`  [${tier.label} / ${q}] Cloudflare on page ${p + 1}, stopping`); break; }
    if (!jks.length) break;
    const before = all.size;
    for (const jk of jks) all.add(jk);
    if (all.size === before) break;        // Indeed repeats the last page when you run past the end
    await page.waitForTimeout(1000 + Math.floor(Math.random() * 900));
  }
  return [...all];
}

/**
 * Run the Indeed searches from search.json. `skip` is a Set of job keys already
 * saved or queued. Returns [{ url, tier }] for new jobs, most specific tier first.
 */
export async function searchIndeed(page, cfg, skip = new Set()) {
  const picked = new Map();
  const cap = cfg.maxPerRun ?? 40;
  await page.goto('https://www.indeed.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  outer:
  for (const tier of cfg.tiers || [{ label: 'USA', l: 'United States' }]) {
    for (const q of cfg.queries || []) {
      let jks = [];
      try { jks = await collect(page, q, tier, cfg.fromageDays ?? 1); }
      catch (e) { console.error(`  search error [${tier.label} / ${q}]: ${e.message}`); continue; }
      let added = 0;
      for (const jk of jks) {
        if (skip.has(`indeed:${jk}`) || picked.has(jk)) continue;
        picked.set(jk, { label: tier.label, domain: tier.domain || 'www.indeed.com' });
        added++;
        if (picked.size >= cap) { console.error(`  hit maxPerRun (${cap})`); break outer; }
      }
      console.error(`  [${tier.label} / ${q}] ${jks.length} results, ${added} new`);
    }
  }
  return [...picked].map(([jk, v]) => ({ url: `https://${v.domain}/viewjob?jk=${jk}`, tier: v.label }));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : ''; };
  if (args.includes('--login')) {
    const where = flag('--login');
    return loginFlow(where ? (where.startsWith('http') ? where : `https://${where}/`) : 'https://secure.indeed.com/auth', 'Indeed');
  }
  if (args.includes('--search')) {
    const { loadSearch } = await import('../src/pipeline.mjs');
    const ctx = await launchBrowser();
    try {
      const found = await searchIndeed(await firstPage(ctx), loadSearch().indeed || {});
      console.log(found.map((f) => `${f.url}\t${f.tier}`).join('\n'));
    } finally { await ctx.close(); }
    return;
  }
  const file = flag('--urls-file');
  if (!file) { console.error('usage: indeed.mjs --login [domain] | --search | --urls-file F [--out F]'); process.exit(1); }
  const urls = (await readFile(file, 'utf8')).split('\n').map((s) => s.trim()).filter((u) => /^https?:\/\//.test(u));
  const ctx = await launchBrowser();
  try {
    const { jobs } = await scrapeIndeed(await firstPage(ctx), urls);
    await emit(jobs, flag('--out'));
    console.error(`scraped ${jobs.length}/${urls.length}`);
  } finally { await ctx.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
