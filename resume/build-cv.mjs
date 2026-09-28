#!/usr/bin/env node
/**
 * build-cv.mjs — render a tailored resume from a job's cv.json + your profile.
 *
 *   node resume/build-cv.mjs data/jobs/042-acme-frontend-engineer/cv.json [--no-pdf]
 *
 * Your fixed facts (name, contact, employers, dates, bullets, projects,
 * education) come from profile/profile.yml. The per-job cv.json only carries
 * what is tailored for that job: title, tagline, summary, role titles, fit
 * cards, competencies, skills. The schema is in resume/templates/cv.example.json.
 *
 * Writes next to cv.json:
 *   cv-<your-name>-<slug>-<date>.html
 *   cv-<your-name>-<slug>-<date>.pdf   (one long page; --no-pdf skips it)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadProfile } from '../src/config.mjs';
import { slugify } from '../src/jobs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const escAttr = (s = '') => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, '') + new URL(url).pathname.replace(/\/$/, ''); } catch { return url; } };

const ICONS = {
  linkedin: { bg: '#0a66c2', path: '<path fill="#fff" d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V8.99h3.42v1.57h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.32 7.42a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12Zm1.78 13.03H3.54V8.99H7.1v11.46Z"/>' },
  github: { bg: '#181717', path: '<path fill="#fff" fill-rule="evenodd" d="M12 2.3c-5.36 0-9.7 4.35-9.7 9.71 0 4.29 2.78 7.92 6.64 9.2.49.09.66-.21.66-.47v-1.65c-2.7.59-3.27-1.16-3.27-1.16-.44-1.12-1.08-1.42-1.08-1.42-.88-.6.07-.59.07-.59.97.07 1.48 1 1.48 1 .87 1.48 2.27 1.05 2.82.8.09-.63.34-1.05.62-1.3-2.16-.25-4.43-1.08-4.43-4.8 0-1.06.38-1.93 1-2.61-.1-.25-.43-1.24.1-2.57 0 0 .81-.26 2.67 1a9.2 9.2 0 0 1 4.86 0c1.85-1.26 2.66-1 2.66-1 .53 1.33.2 2.32.1 2.57.62.68 1 1.55 1 2.61 0 3.73-2.28 4.55-4.44 4.79.35.3.66.89.66 1.8v2.66c0 .26.18.57.67.47A9.72 9.72 0 0 0 21.7 12c0-5.36-4.35-9.71-9.7-9.71Z" clip-rule="evenodd"/>' },
  web: { bg: 'linear-gradient(135deg, #127b77 0%, #15918c 60%, #b98612 100%)', path: '<path fill="#fff" d="M12 2.25a9.75 9.75 0 1 0 0 19.5 9.75 9.75 0 0 0 0-19.5Zm6.94 8.73h-3.21a15.2 15.2 0 0 0-1.13-5.1 8.29 8.29 0 0 1 4.34 5.1Zm-5.16 0h-3.56c.18-2.07.76-4.03 1.78-5.98 1.02 1.95 1.6 3.91 1.78 5.98Zm-3.56 2.04h3.56c-.18 2.07-.76 4.03-1.78 5.98-1.02-1.95-1.6-3.91-1.78-5.98Zm-.82-7.14a15.2 15.2 0 0 0-1.13 5.1H5.06a8.29 8.29 0 0 1 4.34-5.1Zm-4.34 7.14h3.21a15.2 15.2 0 0 0 1.13 5.1 8.29 8.29 0 0 1-4.34-5.1Zm9.54 5.1a15.2 15.2 0 0 0 1.13-5.1h3.21a8.29 8.29 0 0 1-4.34 5.1Z"/>' },
};

function fill(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
    console.warn(`  ⚠️  Unfilled placeholder: ${m}`);
    return '';
  });
}

const noDashes = (html) => html.replace(/&mdash;|&#8212;|&#x2014;/gi, '-').replace(/—/g, '-');

function contactRow(p) {
  const parts = [];
  const plain = [p.email, p.phone].filter(Boolean).map((t) => `      <span class="px-0 py-[2px]">${t}</span>`);
  parts.push(plain.join('\n      <span class="text-faint">|</span>\n'));
  for (const link of p.links || []) {
    const icon = ICONS[link.icon] || ICONS.web;
    const label = link.label || hostOf(link.url);
    parts.push(`      <a class="cv-link inline-flex items-center gap-1.5 border border-faint rounded-full bg-white text-[8.25px] font-bold leading-none pl-[3px] pr-[7px] py-[2px] shadow-chip" href="${escAttr(link.url)}">
        <span class="inline-grid place-items-center w-[13px] h-[13px] rounded-full" style="background:${icon.bg};"><svg viewBox="0 0 24 24" class="w-[8.5px] h-[8.5px]" aria-hidden="true">${icon.path}</svg></span>
        ${label}
        <span class="text-[7.6px] font-extrabold">&#8599;</span>
      </a>`);
  }
  return parts.filter(Boolean).join('\n');
}

const pill = (text) => `      <span class="rounded-sm text-[8.5px] font-bold px-[7px] py-[2px] border" style="background:#e6f4f3;border-color:#c4e6e4;color:#0c5451;">${text}</span>`;

function pills(p, cfg) {
  const out = [];
  const loc = cfg.location_note || p.location_note || p.location;
  if (loc) out.push(pill(loc));
  const auth = p.work_authorization || {};
  if (auth.show_on_resume && auth.resume_text && !cfg.hide_auth_pill) {
    out.push(`      <span class="auth-pill">${auth.resume_text}</span>`);
  }
  return out.join('\n');
}

function proofStrip(points = []) {
  if (!points.length) return '';
  const cols = Math.min(points.length, 4);
  const cards = points.slice(0, 4).map((pt) => `    <div class="rounded-md border bg-white px-2 py-1.5 min-h-[43px]" style="border-color:#c4e6e4;">
      <div class="font-display font-bold uppercase tracking-[0.08em] text-micro text-gold-500">${pt.label || ''}</div>
      <div class="font-display font-bold text-cv-md text-ink-700 mt-[1px]">${pt.title || ''}</div>
      <div class="text-[8.15px] text-ink-400 leading-[1.28] mt-[1px]">${pt.body || ''}</div>
    </div>`).join('\n');
  return `  <section class="grid grid-cols-${cols} gap-[7px] px-8 py-2.5 border-b border-faint" style="background: linear-gradient(90deg, #ffffff 0%, #f4faf9 100%);">
${cards}
  </section>`;
}

function experience(p, cfg) {
  const titles = cfg.role_titles || {};
  const list = p.experience || [];
  return list.map((e, i) => {
    const last = i === list.length - 1;
    const bullets = (cfg.role_bullets?.[e.id] || e.bullets || []).map((b) => `          <li>${b}</li>`).join('\n');
    return `      <article class="avoid-break${last ? '' : ' pb-2 mb-2.5 border-b border-faint'}">
        <div class="flex items-baseline justify-between gap-2.5">
          <span class="font-display font-bold text-cv-xl text-ink-700">${e.company}</span>
          <span class="text-2xs text-ink-400 whitespace-nowrap">${e.period || ''}</span>
        </div>
        <div class="font-bold text-accent-600 text-cv-sm mt-[1px]">${titles[e.id] || e.title || ''}</div>
${e.context ? `        <div class="italic text-ink-400 text-2xs mt-[1px] mb-[3px]">${e.context}</div>\n` : ''}        <ul class="cv-list">
${bullets}
        </ul>
      </article>`;
  }).join('\n\n');
}

function box(title, right, body, links = []) {
  const linkRow = links.length
    ? `\n        <div class="flex flex-wrap gap-2 mt-1 text-[8.5px] font-bold">${links.map((l) => `<a class="cv-link" href="${escAttr(l.url)}">${l.label || hostOf(l.url)} &nearr;</a>`).join(' ')}</div>`
    : '';
  return `      <div class="avoid-break rounded-md border border-faint bg-white px-2.5 py-1.5 mb-1.5">
        <div class="flex items-baseline justify-between flex-wrap gap-1.5 mb-[2px]">
          <span class="font-display font-bold text-ink-700 text-cv-sm">${title}</span>${right || ''}
        </div>
        ${body ? `<div class="text-[8.72px] leading-[1.38]">${body}</div>` : ''}${linkRow}
      </div>`;
}

function section(title, inner, extraClass = 'mb-3.5') {
  if (!inner) return '';
  return `    <section class="${extraClass}">
      <div class="cv-section-title"><span>${title}</span></div>
${inner}
    </section>`;
}

function projects(p, cfg) {
  let list = p.projects || [];
  if (Array.isArray(cfg.project_order) && cfg.project_order.length) {
    const byName = new Map(list.map((x) => [x.name, x]));
    list = cfg.project_order.map((n) => byName.get(n)).filter(Boolean);
  }
  const badge = (b) => (b ? `<span class="text-[8px] font-bold px-1.5 py-[1px] rounded-sm border" style="background:#e6f4f3;border-color:#c4e6e4;color:#0c5451;">${b}</span>` : '');
  return section('Selected Projects', list.map((x) => box(x.name, badge(x.badge), x.description, x.links || [])).join('\n'));
}

function education(p) {
  const list = p.education || [];
  return section('Education', list.map((ed) => box(
    `${ed.degree}${ed.school ? `, <span class="text-accent-600">${ed.school}</span>` : ''}`,
    ed.period ? `<span class="text-[8.1px] text-ink-400">${ed.period}</span>` : '',
    ed.description || '',
  )).join('\n'), 'avoid-break');
}

function recognition(p) {
  return section('Recognition', (p.recognition || []).map((r) => box(r.title, '', r.body, r.links || [])).join('\n'), 'avoid-break mb-3.5');
}

const paragraphs = (xs) => (Array.isArray(xs) ? xs.map((x) => `      <p>${x}</p>`).join('\n') : '');

const cards = (xs) => (Array.isArray(xs) ? xs.map(({ title, body }) => `      <div class="fit-card">
        <div class="fit-card-title">${title}</div>
        <div class="fit-card-body">${body}</div>
      </div>`).join('\n') : '');

const evidence = (xs) => (Array.isArray(xs) ? xs.map(({ title, body }) => `    <div class="evidence-block">
      <div class="evidence-title">${title}</div>
      <div class="evidence-body">${body}</div>
    </div>`).join('\n') : '');

const tags = (xs) => (Array.isArray(xs) ? xs.map((t) => `      <span class="competency-tag">${t}</span>`).join('\n') : '');

function skills(p, cfg) {
  const rows = Array.isArray(cfg.skills) && cfg.skills.length
    ? cfg.skills
    : Object.entries(p.skills || {}).map(([cat, body]) => ({ cat, body }));
  return rows.map(({ cat, body }) => `        <div class="skill-row"><span class="skill-cat">${cat}</span>${body}</div>`).join('\n');
}

function notes(cfg, p) {
  const list = [...(cfg.additional_notes || [])];
  const auth = p.work_authorization || {};
  if (auth.note_on_resume && auth.resume_text && !list.some((n) => n.includes(auth.resume_text))) list.unshift(auth.resume_text);
  if (!list.length) return '';
  return section('Additional Notes', `      <div class="space-y-1.5">\n${paragraphs(list)}\n      </div>`, 'avoid-break');
}

export async function buildCv(configPath, { pdf = true } = {}) {
  const cfgAbs = resolve(process.cwd(), configPath);
  const cfg = JSON.parse(await readFile(cfgAbs, 'utf8'));
  const p = loadProfile();

  for (const k of ['slug', 'date', 'title', 'tagline', 'summary']) {
    if (!cfg[k]) throw new Error(`Missing required field in ${configPath}: "${k}"`);
  }

  const template = await readFile(join(HERE, 'templates', 'cv-template.html'), 'utf8');
  const html = noDashes(fill(template, {
    NAME: p.name || 'Your Name',
    TITLE: cfg.title,
    TAGLINE: cfg.tagline,
    CONTACT_ROW: contactRow(p),
    PILLS: pills(p, cfg),
    PROOF_STRIP: proofStrip(cfg.proof_points || p.proof_points),
    SUMMARY: paragraphs(cfg.summary),
    EXPERIENCE: experience(p, cfg),
    PROJECTS: projects(p, cfg),
    SKILLS: skills(p, cfg),
    EDUCATION: education(p),
    FIT_TITLE: cfg.fit_title || 'What I Bring',
    FIT_CARDS: cards(cfg.fit_cards),
    EVIDENCE_TITLE: cfg.evidence_title || 'Relevant Expertise',
    EVIDENCE_BLOCKS: evidence(cfg.evidence_blocks),
    COMPETENCIES: tags(cfg.competencies),
    RECOGNITION: recognition(p),
    ADDITIONAL_NOTES: notes(cfg, p),
  }));

  const outDir = dirname(cfgAbs);
  const who = slugify(p.name || 'resume').split('-').slice(0, 2).join('-') || 'resume';
  const base = `cv-${who}-${cfg.slug}-${cfg.date}`;
  const htmlPath = join(outDir, `${base}.html`);
  const pdfPath = join(outDir, `${base}.pdf`);
  await writeFile(htmlPath, html, 'utf8');
  console.log(`✅ HTML: ${htmlPath}`);
  if (!pdf) return { htmlPath };

  const r = spawnSync(process.execPath,
    [join(HERE, 'generate-pdf.mjs'), htmlPath, pdfPath, `--format=${cfg.format || 'letter'}`, '--single-page'],
    { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('PDF generation failed');
  verifyPdf(pdfPath, cfg, p);
  return { htmlPath, pdfPath };
}

/**
 * A PDF that rendered is not the same as one an ATS can read. Check the file:
 * page count, a real text layer, and that your name/email survived into it.
 */
function verifyPdf(pdfPath, cfg, p) {
  const args = [join(HERE, 'verify_pdf.py'), pdfPath, '--pages', String(cfg.expected_pages ?? 1), '--min-chars', '800'];
  for (const v of [p.name, p.email].filter(Boolean)) args.push('--contains', v);
  const check = spawnSync('python3', args, { encoding: 'utf8' });
  if (check.error?.code === 'ENOENT') { console.warn('⚠️  python3 not found — skipping PDF verification'); return; }
  if (check.status !== 0) throw new Error(`PDF verification failed: ${(check.stderr || check.stdout || '').trim()}`);
  console.log(`✅ Verified: ${(check.stdout || '').trim()}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) { console.error('Usage: node resume/build-cv.mjs <cv.json> [--no-pdf]'); process.exit(1); }
  buildCv(configPath, { pdf: !args.includes('--no-pdf') }).catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
