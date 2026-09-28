/**
 * browser.mjs — the stealth browser shared by the Indeed and LinkedIn scrapers.
 *
 * Indeed (Cloudflare) and LinkedIn block headless and datacenter traffic, so
 * scraping runs a VISIBLE browser with a persistent profile you have logged
 * into once (npm run login:indeed / npm run login:linkedin). Cookies live in
 * data/browser-profile/ and never leave your machine.
 *
 *   BROWSER_ENGINE=cloakbrowser  (default) stealth Chromium
 *   BROWSER_ENGINE=camoufox      stealth Firefox — npm i camoufox-js && npx camoufox-js fetch
 */
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS, SETTINGS, ENV } from '../src/config.mjs';
import { notify } from '../src/notify.mjs';

export const engineName = (ENV.BROWSER_ENGINE || 'cloakbrowser').toLowerCase();
const LOGIN_SIGNAL = join(PATHS.browserProfile, '.login-done');

export async function launchBrowser() {
  await mkdir(PATHS.browserProfile, { recursive: true });
  const opts = {
    userDataDir: PATHS.browserProfile,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    viewport: null,
  };
  if (engineName === 'camoufox') {
    const { firefox } = await import('playwright-core');
    let launchOptions;
    try { ({ launchOptions } = await import('camoufox-js')); }
    catch { throw new Error("BROWSER_ENGINE=camoufox needs: npm i camoufox-js && npx camoufox-js fetch"); }
    const cam = await launchOptions({ headless: false, humanize: true });
    return firefox.launchPersistentContext(PATHS.browserProfile, { ...cam, viewport: null });
  }
  const { launchPersistentContext } = await import('cloakbrowser');
  return launchPersistentContext(opts);
}

export async function firstPage(ctx) {
  return ctx.pages()[0] || ctx.newPage();
}

/**
 * Open a sign-in page and wait until you finish logging in. Finish by closing
 * the browser window, pressing Enter in the terminal, or (for remote setups)
 * creating data/browser-profile/.login-done. Gives up after 15 minutes.
 */
export async function loginFlow(url, siteName) {
  await unlink(LOGIN_SIGNAL).catch(() => {});
  const ctx = await launchBrowser();
  const page = await firstPage(ctx);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log(`\n${siteName}: sign in in the browser window.`);
  console.log('When you are done, press Enter here (or just close the browser window).\n');

  let done = false;
  const finish = () => { done = true; };
  ctx.on('close', finish);
  if (process.stdin.isTTY) { process.stdin.resume(); process.stdin.once('data', finish); }
  const deadline = Date.now() + 15 * 60 * 1000;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try { await stat(LOGIN_SIGNAL); done = true; } catch { /* keep waiting */ }
  }
  await ctx.close().catch(() => {});     // a clean close flushes cookies to disk
  await unlink(LOGIN_SIGNAL).catch(() => {});
  if (process.stdin.isTTY) process.stdin.pause();
  console.log(`${siteName}: session saved to data/browser-profile/.`);
}

/**
 * When a page is stuck on a captcha or sign-in wall, notify once and poll
 * until a person clears it in the visible browser. After one timeout the rest
 * of the run stops waiting and just skips blocked jobs.
 */
export function humanHelper(siteName) {
  let notified = false;
  let gaveUp = false;
  const waitMs = SETTINGS.captchaWaitMin * 60 * 1000;
  return async function waitForHuman(page, reason, url, classify) {
    if (waitMs <= 0 || gaveUp) return false;
    if (!notified) {
      notified = true;
      await notify('action-needed', {
        subject: `Action needed: ${siteName} ${reason === 'login' ? 'sign-in' : 'captcha'} (scrape paused)`,
        text: `${siteName} is showing a ${reason === 'login' ? 'sign-in page' : 'captcha'} at ${url}. Clear it in the open browser window; the scrape resumes by itself (waiting up to ${SETTINGS.captchaWaitMin} min).`,
        url,
      });
    }
    console.error(`  paused for a human (${reason})…`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(4000);
      if (!(await classify(page))) { console.error('  cleared'); return true; }
    }
    gaveUp = true;
    console.error('  wait timed out; skipping blocked jobs for the rest of this run');
    return false;
  };
}

/** Write a JSON array of scraped jobs to a file or stdout. */
export async function emit(jobs, outFile) {
  const json = JSON.stringify(jobs, null, 2);
  if (outFile) await writeFile(outFile, json, 'utf8'); else process.stdout.write(json + '\n');
}
