#!/usr/bin/env node
/**
 * linkedin.mjs — LinkedIn job search + job-description scraper.
 *
 *   node scrapers/linkedin.mjs --login                         sign in once
 *   node scrapers/linkedin.mjs --search "react developer" [--location "United States"] [--limit 25]
 *   node scrapers/linkedin.mjs --urls-file F [--out F]         scrape these /jobs/view/<id>/ pages
 *   node scrapers/linkedin.mjs --probe <jobUrl>                debug: which selectors match
 *
 * Logging in is OPTIONAL. Without a session the scraper runs in guest mode:
 * it searches LinkedIn's public job listings and reads each posting from its
 * public page. Logged in, it uses the full site (more results per search).
 *
 * Output is the same JSON shape as the Indeed scraper, so the pipeline treats
 * both sources identically. LinkedIn changes its markup often — if scraping
 * starts returning "thin" jobs, run --probe on a job page and adjust the
 * selectors in extractJob().
 */
import { readFile } from 'node:fs/promises';
import { launchBrowser, firstPage, loginFlow, humanHelper, emit } from './browser.mjs';

export const jobIdOf = (url) => (/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/.exec(url) || /currentJobId=(\d+)/.exec(url) || /jobPosting[:/](\d+)/.exec(url) || [])[1] || '';
// LinkedIn's public (logged-out) view of one job posting.
const guestUrl = (id) => `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;
export const viewUrl = (id) => `https://www.linkedin.com/jobs/view/${id}/`;

async function classifyBlock(page) {
  const i = await page.evaluate(() => ({ u: location.href, t: document.title, b: (document.body?.innerText || '').slice(0, 400) }))
    .catch(() => ({ u: '', t: '', b: '' }));
  if (/\/authwall|\/login|\/uas\/login|\/checkpoint|\/challenge/i.test(i.u)) return 'login';
  if (/^sign in|log in|join linkedin/i.test(i.t) || /sign in to (view|continue|see)/i.test(i.b)) return 'login';
  if (/verify|security check|unusual activity/i.test(i.b)) return 'captcha';
  return null;
}

/** Collect job IDs for one query, scrolling the lazy results list and paging by 25. */
async function discover(page, query, location, fromageDays, maxJobs, skip) {
  const ids = new Set();
  const secs = Math.max(1, Number(fromageDays) || 1) * 86400;
  for (let start = 0; start < 1000 && ids.size < maxJobs; start += 25) {
    const params = new URLSearchParams({ keywords: query, location: location || 'United States', f_TPR: `r${secs}`, sortBy: 'DD', start: String(start) });
    await page.goto(`https://www.linkedin.com/jobs/search/?${params}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    if (await classifyBlock(page)) { console.error('  LinkedIn wants a sign-in — run: npm run login:linkedin'); break; }
    let prev = -1;
    for (let s = 0; s < 12; s++) {
      const n = await page.evaluate(() => {
        const list = document.querySelector('.jobs-search-results-list, .scaffold-layout__list, ul.jobs-search__results-list') || document.scrollingElement;
        list.scrollBy(0, 1200);
        return document.querySelectorAll('[data-job-id], [data-occludable-job-id], a[href*="/jobs/view/"]').length;
      }).catch(() => 0);
      await page.waitForTimeout(600);
      if (n === prev) break;
      prev = n;
    }
    const pageIds = await page.evaluate(() => {
      const out = new Set();
      for (const el of document.querySelectorAll('[data-job-id]')) { const v = el.getAttribute('data-job-id'); if (/^\d+$/.test(v)) out.add(v); }
      for (const el of document.querySelectorAll('[data-occludable-job-id]')) { const v = el.getAttribute('data-occludable-job-id'); if (/^\d+$/.test(v)) out.add(v); }
      for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) { const m = /\/jobs\/view\/(\d+)/.exec(a.getAttribute('href') || ''); if (m) out.add(m[1]); }
      return [...out];
    }).catch(() => []);
    if (!pageIds.length) break;
    const before = ids.size;
    for (const id of pageIds) if (ids.size < maxJobs && !skip.has(`linkedin:${id}`)) ids.add(id);
    console.error(`  [${location} / ${query}] start=${start}: ${pageIds.length} cards, ${ids.size} new so far`);
    if (ids.size === before) break;
    await page.waitForTimeout(1200 + Math.floor(Math.random() * 800));
  }
  return [...ids];
}

/** Guest mode: page through LinkedIn's public search results (25 per page). */
async function discoverGuest(page, query, location, fromageDays, maxJobs, skip) {
  const ids = new Set();
  const secs = Math.max(1, Number(fromageDays) || 1) * 86400;
  for (let start = 0; start < 500 && ids.size < maxJobs; start += 25) {
    const params = new URLSearchParams({ keywords: query, location: location || 'United States', f_TPR: `r${secs}`, sortBy: 'DD', start: String(start) });
    await page.goto(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const pageIds = await page.evaluate(() => {
      const out = new Set();
      for (const el of document.querySelectorAll('[data-entity-urn]')) { const m = /jobPosting:(\d+)/.exec(el.getAttribute('data-entity-urn') || ''); if (m) out.add(m[1]); }
      for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) { const m = /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/.exec(a.getAttribute('href') || ''); if (m) out.add(m[1]); }
      return [...out];
    }).catch(() => []);
    if (!pageIds.length) break;
    const before = ids.size;
    for (const id of pageIds) if (ids.size < maxJobs && !skip.has(`linkedin:${id}`)) ids.add(id);
    console.error(`  [${location} / ${query}] guest start=${start}: ${pageIds.length} cards, ${ids.size} new so far`);
    if (ids.size === before) break;
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
  }
  return [...ids];
}

async function signedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return !(await classifyBlock(page));
}

/**
 * Run the LinkedIn searches from search.json. Returns [{ url, tier }] for new jobs.
 * Uses the logged-in site when there is a session, guest mode otherwise.
 */
export async function searchLinkedIn(page, cfg, skip = new Set()) {
  const found = new Map();
  const loggedIn = await signedIn(page);
  if (!loggedIn) console.error('  LinkedIn: no session — using guest mode (npm run login:linkedin for more results)');
  for (const location of cfg.locations || ['United States']) {
    for (const q of cfg.queries || []) {
      const ids = await (loggedIn ? discover : discoverGuest)(page, q, location, cfg.fromageDays ?? 1, cfg.maxPerQuery ?? 25, skip);
      for (const id of ids) if (!found.has(id)) found.set(id, location);
    }
  }
  return [...found].map(([id, location]) => ({ url: viewUrl(id), tier: `LinkedIn ${location}` }));
}

async function waitForJobPage(page, maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({
      title: document.querySelector('h1')?.innerText?.length || 0,
      desc: (document.querySelector('#job-details, .jobs-description__content, .jobs-box__html-content, .show-more-less-html__markup, .description__text')?.innerText || '').length,
    })).catch(() => ({ title: 0, desc: 0 }));
    if (s.title > 0 && s.desc > 80) return true;
  }
  return false;
}

async function extractJob(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('button.jobs-description__footer-button, button[aria-label*="see more" i], button[aria-label*="show more" i]');
    if (btn) btn.click();
  }).catch(() => {});
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const pick = (...ss) => { for (const s of ss) { const e = document.querySelector(s); const t = e?.innerText || e?.textContent || ''; if (t.trim()) return t.trim(); } return ''; };
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Logged-in selectors first, then the public (guest) page's.
    const title = pick('h1.job-details-jobs-unified-top-card__job-title', '.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title', '.top-card-layout__title', 'h2.topcard__title', 'h1');
    const company = clean(pick('.job-details-jobs-unified-top-card__company-name a', '.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name a', '.jobs-unified-top-card__company-name', '.topcard__org-name-link', '.top-card-layout__second-subline a'));
    const location = clean(pick('.job-details-jobs-unified-top-card__primary-description-container .tvm__text', '.job-details-jobs-unified-top-card__bullet', '.jobs-unified-top-card__bullet', '.topcard__flavor--bullet').split('·')[0]);
    let salary = '';
    for (const el of document.querySelectorAll('.job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight, li.jobs-details__salary, .salary, .compensation__salary')) {
      const t = (el.innerText || '').trim();
      if (/\$|£|€|salary|\/yr|\/hr|per hour|per year/i.test(t) && t.length < 80) { salary = clean(t); break; }
    }
    const body = pick('#job-details', '.jobs-description__content', '.jobs-box__html-content', 'article.jobs-description__container', '.show-more-less-html__markup', '.description__text');
    return { title: title.trim(), company, location, salary, body };
  });
}

/** Scrape LinkedIn job pages. Returns { jobs, blocked }. */
export async function scrapeLinkedIn(page, urls) {
  const waitForHuman = humanHelper('LinkedIn');
  let guest = false;
  const jobs = [];
  const blocked = [];
  for (const raw of urls) {
    const id = jobIdOf(raw);
    const url = id ? viewUrl(id) : raw;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      // Without a session, LinkedIn answers /jobs/view/ with a sign-up wall;
      // the public posting page has the same content, so go there instead.
      const target = guest && id ? guestUrl(id) : url;
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }); ok = await waitForJobPage(page, guest ? 15000 : 30000); }
      catch (e) { console.error(`  nav error ${target}: ${e.message}`); }
      if (!ok && !guest && id && (await classifyBlock(page)) === 'login') { guest = true; console.error('  LinkedIn: no session — switching to guest mode'); continue; }
      if (!ok) await page.waitForTimeout(2500);
    }
    if (!ok && !guest) {
      const reason = await classifyBlock(page);
      if (reason && await waitForHuman(page, reason, url, classifyBlock)) ok = await waitForJobPage(page);
    }
    if (!ok) { blocked.push(raw); console.error(`SKIP (blocked/empty): ${url}`); continue; }
    const data = await extractJob(page);
    if (!data.body || data.body.trim().length < 30 || !data.title) { blocked.push(raw); console.error(`SKIP (thin): ${url}`); continue; }
    jobs.push({ ...data, url, applyType: 'linkedin' });
    console.error(`OK   ${data.title} @ ${data.company}`);
    await page.waitForTimeout(1200 + Math.floor(Math.random() * 800));
  }
  return { jobs, blocked };
}

async function probe(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const c = (s) => document.querySelectorAll(s).length;
    const txt = (s) => (document.querySelector(s)?.innerText || '').slice(0, 80).replace(/\s+/g, ' ');
    return {
      url: location.href, title: document.title, h1: txt('h1'),
      jobDetails_len: (document.querySelector('#job-details')?.innerText || '').length,
      desc_content_len: (document.querySelector('.jobs-description__content')?.innerText || '').length,
      company: txt('.job-details-jobs-unified-top-card__company-name'),
      counts: { dataJobId: c('[data-job-id]'), viewLinks: c('a[href*="/jobs/view/"]') },
    };
  }).catch((e) => ({ err: String(e) }));
  console.log(JSON.stringify(info, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d = '') => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  if (args.includes('--login')) return loginFlow('https://www.linkedin.com/login', 'LinkedIn');

  const ctx = await launchBrowser();
  try {
    const page = await firstPage(ctx);
    if (args.includes('--probe')) return await probe(page, flag('--probe'));
    let urls;
    if (args.includes('--search')) {
      const found = await searchLinkedIn(page, {
        queries: [flag('--search')],
        locations: [flag('--location', 'United States')],
        fromageDays: Number(flag('--fromage-days', '1')),
        maxPerQuery: Number(flag('--limit', '25')),
      });
      urls = found.map((f) => f.url);
    } else if (args.includes('--urls-file')) {
      urls = (await readFile(flag('--urls-file'), 'utf8')).split('\n').map((s) => s.trim()).filter((u) => /^https?:\/\//.test(u));
    } else {
      console.error('usage: linkedin.mjs --login | --search "<q>" [--location L] [--limit N] [--out F] | --urls-file F [--out F] | --probe <url>');
      process.exitCode = 1;
      return;
    }
    const { jobs } = await scrapeLinkedIn(page, urls);
    await emit(jobs, flag('--out'));
    console.error(`scraped ${jobs.length}/${urls.length}`);
  } finally { await ctx.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
