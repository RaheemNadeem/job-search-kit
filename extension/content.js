(function () {
  const ENDPOINT = 'http://localhost:7867/jd';

  const HOST = window.location.hostname;
  const IS_LINKEDIN = /(^|\.)linkedin\.com$/i.test(HOST);
  const IS_INDEED = /(^|\.)indeed\.com$/i.test(HOST);

  function pickText(...selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const txt = el?.innerText?.trim();
      if (txt) return txt;
    }
    return '';
  }

  function pickAttr(selector, attr) {
    const el = document.querySelector(selector);
    return el?.getAttribute?.(attr)?.trim() || '';
  }

  function clean(s = '') {
    return s.replace(/\s+/g, ' ').trim();
  }

  // ---------- INDEED ----------

  // Returns 'indeed' (Apply-with-Indeed / Smart Apply), 'company' (external
  // site), or 'unknown'. Indeed switches between several apply-button shapes
  // -- inspect text, ids, hrefs, and aria-labels to be resilient to redesigns.
  function detectIndeedApplyType() {
    const applyEls = document.querySelectorAll(
      '[id*="apply" i], [data-testid*="apply" i], [aria-label*="apply" i], [class*="apply" i]'
    );
    let sawIndeed = false;
    let sawCompany = false;
    for (const el of applyEls) {
      const text = (el.innerText || el.textContent || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const href = (el.getAttribute('href') || '').toLowerCase();

      const companyHit =
        text.includes('apply on company site') ||
        text.includes('apply on company website') ||
        aria.includes('company site') ||
        aria.includes('company website') ||
        (href && /^https?:\/\//i.test(href) && !/indeed\.com/i.test(href));

      const indeedHit =
        text.includes('apply with indeed') ||
        text.includes('apply on indeed') ||
        id === 'indeedapplybutton' ||
        id.includes('indeedapply') ||
        href.includes('smartapply.indeed.com');

      if (companyHit) sawCompany = true;
      if (indeedHit) sawIndeed = true;
    }
    // External link wins -- it's the most reliable signal that the apply
    // flow leaves Indeed. Indeed sometimes shows both surfaces, and in those
    // cases the "company site" path is what the user will actually use.
    if (sawCompany) return 'company';
    if (sawIndeed) return 'indeed';
    return 'unknown';
  }

  // Indeed's newer layout puts company and location as lines in one block.
  function indeedMetaLines() {
    const el = document.querySelector('[data-testid="company-info-metadata"]');
    return (el?.innerText || '').split('\n').map(l => l.trim())
      .filter(l => l && l !== '·' && !/^\d(\.\d)?$/.test(l));
  }

  // Pay from this job's own details, never from the "similar jobs" sidebar.
  function indeedDetailsPay() {
    const el = document.querySelector('#jobDetailsSection');
    return (el?.innerText || '').split('\n').map(l => l.trim())
      .find(l => /[$£€₹][\d,.]+.*\b(year|hour|month|week|day)\b/i.test(l) && l.length < 80) || '';
  }

  function extractIndeed() {
    const title = pickText(
      'h1[data-testid="jobsearch-JobInfoHeader-title"]',
      'h2[data-testid="jobsearch-JobInfoHeader-title"]',
      '.jobsearch-JobInfoHeader-title',
      'h1.jobsearch-JobInfoHeader-title',
      '[data-testid="simpler-jobTitle"]',
      '[data-testid="vj-job-title"]',
      'h1'
    ).replace(/\s+-\s*job\s*post\s*$/i, '').trim();

    const company = pickText(
      '[data-testid="inlineHeader-companyName"] a',
      '[data-testid="inlineHeader-companyName"]',
      '[data-company-name="true"]',
      '.jobsearch-InlineCompanyRating + div a',
      '[data-testid="jobsearch-CompanyInfoContainer"] a'
    ) || indeedMetaLines()[0] || '';

    const location = pickText(
      '[data-testid="inlineHeader-companyLocation"]',
      '[data-testid="job-location"]',
      '[data-testid="jobsearch-JobInfoHeader-companyLocation"]'
    ) || (indeedMetaLines().length > 1 ? indeedMetaLines().slice(-1)[0] : '');

    const salary = pickText(
      '#salaryInfoAndJobType',
      '[id*="salary" i]',
      '[data-testid*="salary" i]'
    ) || indeedDetailsPay();

    const body = pickText(
      '#jobDescriptionText',
      '.simple-job-description-html',
      '.jobsearch-JobComponent-description',
      '[data-testid="jobsearch-JobComponent-description"]'
    );

    return {
      source: 'indeed',
      title: clean(title),
      company: clean(company),
      location: clean(location),
      salary: clean(salary),
      applyType: detectIndeedApplyType(),
      body,
      url: window.location.href,
    };
  }

  // ---------- LINKEDIN ----------

  /**
   * Attempt to expand truncated JD by clicking LinkedIn's "Show more" button/link.
   * LinkedIn hides long descriptions behind a toggle. They use different elements
   * depending on the page surface: <button>, <a>, or <span> with "...more" text.
   * On /jobs/view/ pages, the DOM uses hashed/minified classes with no semantic names,
   * and the "more" trigger is often a bare <span> inside main#workspace.
   */
  function clickShowMoreIfPresent() {
    // Phase 1: Try known CSS selectors for the expand trigger
    const showMoreSelectors = [
      'button.show-more-less-html__button--more',
      '.show-more-less-html__button--more',
      '.jobs-description__footer-button',
      'button[aria-label="Show more"]',
      'button[aria-label="show more"]',
      'button[data-tracking-control-name="public_jobs_show-more-html-btn"]',
      // Anchor-based "more" links
      'a.show-more-less-html__button--more',
      'a[data-tracking-control-name="public_jobs_show-more-html-btn"]',
    ];
    for (const sel of showMoreSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        el.click();
        return true;
      }
    }

    // Phase 2: Scan all clickable elements (button, a, span) by text content
    const clickables = document.querySelectorAll('button, a, span[role="button"], span.show-more-less-html__button, span');
    for (const el of clickables) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if ((txt === 'show more' || txt === 'see more' || txt === '...more' || txt === '\u2026more' || txt === 'more') && el.offsetParent !== null) {
        // On /jobs/view/ pages, the DOM uses hashed classes and main#workspace.
        // Accept the click if the element is inside ANY known JD-related container
        // OR inside main#workspace (the /jobs/view/ page layout).
        const parent = el.closest(
          '[class*="jobs-description"], [class*="job-details"], [class*="job-view"], .show-more-less-html, article, .scaffold-layout__detail, main#workspace, main'
        );
        if (parent) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }

  function extractLinkedIn() {
    // LinkedIn uses different DOM trees for /jobs/view/<id>/ vs /jobs/search/?currentJobId=<id>.
    // Try the unified-top-card selectors first (search/collection panel), then fall back to
    // the standalone job page selectors.
    let title = pickText(
      '.job-details-jobs-unified-top-card__job-title h1',
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title h1',
      '.jobs-unified-top-card__job-title',
      // Search results panel (2025-2026 DOM)
      '.job-details-jobs-unified-top-card__job-title-link',
      '.jobs-details__main-content h1',
      '.jobs-details-top-card__job-title',
      // Public/logged-out views
      '.topcard__title',
      '.top-card-layout__title',
      'h1.t-24',
      'h1'
    );

    let company = pickText(
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name a',
      '.jobs-unified-top-card__company-name',
      // Search results panel (2025-2026 DOM)
      '.jobs-details-top-card__company-info a',
      '.job-details-jobs-unified-top-card__primary-description-container a',
      // Public/logged-out views
      '.topcard__org-name-link',
      '.topcard__flavor a',
      '.top-card-layout__card .topcard__flavor'
    );

    // --- FALLBACK: Parse from document.title ---
    // On /jobs/view/ pages with hashed classes, CSS selectors fail.
    // document.title is always: "Job Title | Company Name | LinkedIn"
    if (!title || !company) {
      const docTitle = document.title || '';
      const parts = docTitle.split('|').map(s => s.trim());
      if (parts.length >= 3 && parts[parts.length - 1] === 'LinkedIn') {
        if (!title) title = parts[0];
        if (!company) company = parts[1];
      }
    }

    // --- FALLBACK: Company from /company/ link ---
    if (!company) {
      const companyLink = document.querySelector('a[href*="/company/"]');
      if (companyLink) {
        const linkText = (companyLink.textContent || '').trim();
        if (linkText && linkText.length < 100) company = linkText;
      }
    }

    // LinkedIn packs location, posted-date, applicant-count into one container separated by middots.
    // Take the first non-empty bullet as location.
    let location = '';
    const primaryDesc =
      document.querySelector('.job-details-jobs-unified-top-card__primary-description-container') ||
      document.querySelector('.job-details-jobs-unified-top-card__primary-description') ||
      document.querySelector('.jobs-unified-top-card__primary-description') ||
      document.querySelector('.jobs-details-top-card__company-info') ||
      document.querySelector('.topcard__flavor-row');
    if (primaryDesc) {
      const text = primaryDesc.innerText || '';
      const parts = text.split(/[·•|]/).map(s => s.trim()).filter(Boolean);
      // First part is typically location (e.g., "Ashburn, VA")
      if (parts.length) location = parts[0];
    }
    if (!location) {
      location = pickText(
        '.jobs-unified-top-card__bullet',
        '.topcard__flavor--bullet',
        '.job-details-jobs-unified-top-card__workplace-type'
      );
    }

    // --- FALLBACK: Location from subtitle text on /jobs/view/ pages ---
    // The subtitle line is typically: "Company Name • City, ST (Type) • Time ago • N applicants"
    // LinkedIn uses either • (bullet) or · (middot) as separators.
    if (!location) {
      // Strategy 1: Find elements containing the company name + bullet separator
      // The subtitle is the element that contains both the company name and a bullet/middot
      const companyName = (company || '').toLowerCase();
      const allEls = document.querySelectorAll('div, span, p');
      for (const el of allEls) {
        const txt = (el.textContent || '').trim();
        // Must contain a separator and be reasonably short (subtitle, not container)
        if (txt.length < 10 || txt.length > 400) continue;
        if (!txt.includes('•') && !txt.includes('·') && !txt.includes('|')) continue;
        // Split on all common separators
        const parts = txt.split(/[·•|]/).map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) continue;
        // Check if any part looks like a location
        for (const part of parts) {
          if (/[A-Z][a-z]+.*,\s*[A-Z]{2}/i.test(part) || /\(on-?site\)|\(remote\)|\(hybrid\)/i.test(part)) {
            location = part;
            break;
          }
        }
        if (location) break;
      }
    }

    // --- FALLBACK: Extract location from page meta or structured data ---
    if (!location) {
      // LinkedIn sometimes has structured data in meta tags
      const metaLoc = document.querySelector('meta[property="og:description"], meta[name="description"]');
      if (metaLoc) {
        const content = metaLoc.getAttribute('content') || '';
        const locMatch = content.match(/(?:in|at|location[:\s]*)\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z]{2})/i);
        if (locMatch) location = locMatch[1];
      }
    }

    // Salary: LinkedIn shows it as a "salary insight" pill or inside the job-insights container.
    let salary = pickText(
      '.jobs-details__salary-main-rail-card .compensation__salary',
      '.compensation__salary',
      '.job-details-preferences-and-skills__pill .artdeco-button__text',
      '[class*="salary" i] .artdeco-button__text',
      '[class*="salary" i]'
    );
    // Fallback: scan the job-insights pills for anything that looks like a $ amount.
    if (!salary) {
      const insightPills = document.querySelectorAll(
        '.job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight, .job-details-preferences-and-skills__pill'
      );
      for (const pill of insightPills) {
        const txt = (pill.innerText || '').trim();
        if (/\$[\d,.]/.test(txt) || /\b(hour|hr|year|yr|month|mo)\b/i.test(txt)) {
          salary = txt;
          break;
        }
      }
    }

    // --- JD BODY EXTRACTION ---
    // LinkedIn ships many different DOM trees for the JD container depending on the
    // surface (/jobs/view/, /jobs/search/, /jobs/search-results/, /jobs/collections/).
    // They also A/B test class renames constantly. Strategy:
    // 1. Try scrolling the right panel to trigger lazy rendering
    // 2. Try the most specific, known selectors first
    // 3. Fallback to broad class-prefix matches
    // 4. Final fallback: scan the entire page for the longest text block

    // Scroll the right panel to ensure lazy-loaded JD content is rendered
    const scrollTarget = document.querySelector(
      '.scaffold-layout__detail, .jobs-search__job-details, .jobs-search__right-rail'
    );
    if (scrollTarget) {
      scrollTarget.scrollTop = 0; // Reset to top first
      scrollTarget.scrollTop = 300; // Trigger lazy load
      scrollTarget.scrollTop = 0; // Back to top
    }

    let body = pickText(
      // Primary selectors (stable across 2024-2026)
      '#job-details',
      '.jobs-description',
      'article.jobs-description__container',
      '.jobs-description__container',
      '.jobs-description-content__text--stretch',
      '.jobs-description-content__text',
      '.jobs-description__content .jobs-description-content__text',
      '.jobs-description__content',
      '.jobs-box__html-content',
      '.jobs-search__job-details--container .jobs-description',
      '.show-more-less-html__markup',
      '.description__text',
      // Search-results panel (2025-2026 variations)
      '.jobs-search__job-details .jobs-box__html-content',
      '.jobs-search__job-details--wrapper .jobs-box__html-content',
      '.jobs-details__main-content .jobs-box__html-content',
      '.job-view-layout .jobs-description__container',
      '.job-view-layout .jobs-box__html-content',
      '.jobs-search__job-details--container .jobs-box__html-content',
      // Right panel in search results
      '.scaffold-layout__detail .jobs-description',
      '.scaffold-layout__detail .jobs-description__container',
      '.scaffold-layout__detail .jobs-box__html-content',
      '.scaffold-layout__detail .show-more-less-html__markup',
      '.scaffold-layout__detail #job-details',
      // Deep nested variants
      '[class*="scaffold-layout__detail"] [class*="jobs-description"]',
      '[class*="scaffold-layout__detail"] .show-more-less-html__markup',
      // "About the job" section container
      '.jobs-description__container .show-more-less-html',
      '.jobs-description .show-more-less-html'
    );

    // Fallback 1: scan any node whose class contains JD-related keywords
    // and pick the one with the most text. Handles A/B-test class renames.
    if (!body || body.length < 80) {
      const candidates = document.querySelectorAll(
        '[class*="jobs-description" i], [class*="job-details" i], [class*="description__text" i], ' +
        '[class*="job-view" i], [class*="jobs-box__html" i], ' +
        'article[class*="jobs"], section[class*="jobs"], ' +
        '[role="document"], [role="article"], ' +
        '.show-more-less-html, .show-more-less-html__markup'
      );
      let best = '';
      for (const node of candidates) {
        const txt = (node.innerText || '').trim();
        // Use lower threshold (80 chars) to catch truncated JDs behind "...more"
        if (txt.length > best.length && txt.length > 80) best = txt;
      }
      if (best) body = best;
    }

    // Fallback 1.5: HEADING-BASED extraction for /jobs/view/ pages.
    // On standalone job pages, LinkedIn uses hashed/minified class names with NO semantic
    // selectors like .jobs-description. The only reliable anchor is the "About the job"
    // heading text. Find it, then grab the text content of its parent container.
    if (!body || body.length < 80) {
      // Find all heading-like elements
      const headings = document.querySelectorAll('h1, h2, h3, h4, [class*="title"], [role="heading"]');
      for (const h of headings) {
        const hText = (h.textContent || '').trim().toLowerCase();
        if (hText === 'about the job' || hText === 'job description') {
          // Found the JD heading. The JD text is typically in the parent or a sibling container.
          // Walk up to find the section-level container that holds both the heading and content.
          let container = h.parentElement;
          // Walk up a few levels to find a container with substantial text
          for (let i = 0; i < 5 && container; i++) {
            const txt = (container.innerText || '').trim();
            // Subtract the heading text and check if there's enough JD content
            const contentText = txt.replace(/^about the job\s*/i, '').trim();
            if (contentText.length > 100) {
              body = contentText;
              break;
            }
            container = container.parentElement;
          }
          if (body && body.length >= 80) break;

          // Alternative: grab ALL sibling elements after the heading
          let sibling = h.nextElementSibling;
          let siblingText = '';
          while (sibling) {
            const sText = (sibling.innerText || '').trim();
            // Stop if we hit another major heading (like "About the company")
            if (sibling.tagName?.match(/^H[1-4]$/) || sText.toLowerCase().startsWith('about the company')) break;
            siblingText += sText + '\n';
            sibling = sibling.nextElementSibling;
          }
          if (siblingText.trim().length > 80) {
            body = siblingText.trim();
            break;
          }
        }
      }
    }

    // Fallback 2: find the single largest text block in the right panel
    // IMPORTANT: exclude navigation, header, and sidebar elements to avoid grabbing page chrome
    if (!body || body.length < 80) {
      const rightPanel = document.querySelector(
        '.scaffold-layout__detail, .jobs-search__right-rail, [class*="detail-pane"], .jobs-search__job-details'
      );
      if (rightPanel) {
        const allChildren = rightPanel.querySelectorAll('div, section, article, span');
        let best = '';
        for (const node of allChildren) {
          // Skip nav, header, footer, and sidebar elements
          if (node.closest('nav, header, footer, [role="navigation"], [role="banner"]')) continue;
          // Skip the "Simplify" extension overlay if present
          if (node.closest('[class*="simplify" i]')) continue;
          const txt = (node.innerText || '').trim();
          // Require reasonable size: more than 80 chars but less than 8000 (avoid grabbing entire panel)
          if (txt.length > best.length && txt.length > 80 && txt.length < 8000) best = txt;
        }
        if (best) body = best;
      }
    }

    // Fallback 3 (nuclear): scan the ENTIRE page for the largest text block
    // that looks like a JD. Much stricter filtering to avoid grabbing nav/page chrome.
    if (!body || body.length < 80) {
      const allBlocks = document.querySelectorAll('div, section, article');
      let best = '';
      for (const node of allBlocks) {
        // EXCLUDE navigation, header, footer, and sidebars
        if (node.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="complementary"]')) continue;
        if (node.closest('[class*="simplify" i], [class*="global-nav" i], [class*="navbar" i]')) continue;
        // Skip the job list panel on the left side
        if (node.closest('.scaffold-layout__list, .jobs-search-results-list')) continue;

        const txt = (node.innerText || '').trim();
        // Strict: 200-8000 chars, must contain 3+ JD signal keywords
        if (txt.length > 200 && txt.length > best.length && txt.length < 8000) {
          const lower = txt.toLowerCase();
          const jdSignals = ['experience', 'requirements', 'responsibilities', 'qualifications',
                             'about the job', 'job description', 'what you', 'skills',
                             'we are looking', 'the role', 'position'];
          const matches = jdSignals.filter(s => lower.includes(s)).length;
          if (matches >= 3) {  // Require 3+ signals (was 2, too loose)
            best = txt;
          }
        }
      }
      if (best) body = best;
    }

    // Build a canonical URL. If the user is in the search/collection panel, the address bar shows
    // ...?currentJobId=<id>. Convert it to the public /jobs/view/<id>/ form for cleanliness.
    let url = window.location.href;
    const currentJobId =
      new URLSearchParams(window.location.search).get('currentJobId') ||
      pickAttr('a.job-card-list__title', 'href')?.match(/\/jobs\/view\/(\d+)/)?.[1] ||
      window.location.pathname.match(/\/jobs\/view\/(\d+)/)?.[1];
    if (currentJobId) {
      url = `https://www.linkedin.com/jobs/view/${currentJobId}/`;
    }

    return {
      source: 'linkedin',
      title: clean(title),
      company: clean(company),
      location: clean(location),
      salary: clean(salary),
      body,
      url,
    };
  }

  function extract() {
    if (IS_LINKEDIN) return extractLinkedIn();
    if (IS_INDEED) return extractIndeed();
    return { source: 'unknown', title: '', company: '', location: '', salary: '', body: '', url: window.location.href };
  }

  function toast(msg, ok = true) {
    document.querySelectorAll('.jd-bridge-toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = 'jd-bridge-toast' + (ok ? '' : ' error');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  let btn;

  /**
   * Wait-and-retry extraction for lazy-loaded LinkedIn panels.
   * LinkedIn loads the right-side JD panel asynchronously after clicking a job card.
   * The first extraction attempt might fail because the DOM hasn't rendered yet.
   * This function retries up to MAX_RETRIES times with a delay between attempts.
   */
  async function extractWithRetry() {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // On LinkedIn, try to expand "Show more" before each extraction attempt
      if (IS_LINKEDIN) {
        clickShowMoreIfPresent();
        // Give the DOM a moment to expand after clicking
        await new Promise(r => setTimeout(r, 200));
      }

      const data = extract();

      if (data.body && data.body.length >= 30) {
        return data;
      }

      // If we have retries left, wait and try again
      if (attempt < MAX_RETRIES) {
        toast(`Loading JD... (attempt ${attempt + 2}/${MAX_RETRIES + 1})`, true);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    // All retries exhausted -- return whatever we have (likely empty)
    return extract();
  }

  async function send() {
    const data = await extractWithRetry();

    if (!data.body || data.body.length < 30) {
      if (IS_LINKEDIN) {
        // Detect if this is an external job posting (no JD on LinkedIn)
        const pageText = (document.body?.innerText || '').toLowerCase();
        const isExternal = pageText.includes('responses managed off linkedin') ||
                          pageText.includes('promoted by hirer');
        toast(
          isExternal
            ? 'External job -- no JD on LinkedIn. Click "Apply" to view JD on the company site, then copy-paste it.'
            : 'No JD found. Click a job card, wait for it to load, then try again.',
          false
        );
      } else {
        toast('No job description found on this page', false);
      }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Sending...';

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const json = await res.json();
      if (json.ok) {
        toast(`✓ Saved as #${json.num} — ${json.folder}`);
        btn.textContent = `✓ ${json.num}`;
        setTimeout(resetBtn, 2500);
      } else if (res.status === 409 && json.duplicate) {
        toast(`Already on board as #${json.num} — ${json.folder}`, false);
        btn.textContent = `#${json.num} exists`;
        setTimeout(resetBtn, 3000);
      } else {
        toast('Server error: ' + (json.error || 'unknown'), false);
        resetBtn();
      }
    } catch (err) {
      toast('Server unreachable. Is the dashboard running (npm start)?', false);
      resetBtn();
    }
  }

  function resetBtn() {
    btn.disabled = false;
    btn.textContent = '→ Save job';
  }

  // On LinkedIn, only show the button on actual job pages (search panel with a selected job,
  // or /jobs/view/<id>/). Suppress on /jobs/ landing or empty search states.
  function shouldMount() {
    if (IS_INDEED) return true;
    if (IS_LINKEDIN) {
      const path = window.location.pathname;
      if (/^\/jobs\/view\//.test(path)) return true;
      // LinkedIn ships several panel surfaces: /jobs/search/, /jobs/search-results/,
      // /jobs/collections/, /jobs/recommended/. All use ?currentJobId=<id> for the active job.
      if (/^\/jobs\/(search|search-results|collections|recommended)/.test(path)) {
        return !!new URLSearchParams(window.location.search).get('currentJobId');
      }
      return false;
    }
    return false;
  }

  function mount() {
    const existing = document.querySelector('.jd-bridge-btn');
    if (!shouldMount()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    btn = document.createElement('button');
    btn.className = 'jd-bridge-btn';
    btn.textContent = '→ Save job';
    btn.title = `Send this ${IS_LINKEDIN ? 'LinkedIn' : 'Indeed'} JD to your Job Search Kit dashboard`;
    btn.addEventListener('click', send);
    document.body.appendChild(btn);
  }

  mount();

  // Both Indeed and LinkedIn are SPAs -- re-mount when the active job changes (URL or DOM).
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
    }
    mount();
  }).observe(document.body, { childList: true, subtree: true });
})();
