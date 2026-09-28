#!/usr/bin/env node
/**
 * sample-resume.mjs — build a resume from resume/templates/cv.example.json and
 * your profile, WITHOUT calling the AI. Use it to check your profile renders
 * nicely and that PDF output works on your machine.
 *
 *   npm run resume:sample      → data/sample/cv-<you>-acme-frontend-engineer-<date>.pdf
 */
import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, PATHS } from '../src/config.mjs';
import { buildCv } from '../resume/build-cv.mjs';

const dir = join(PATHS.data, 'sample');
await mkdir(dir, { recursive: true });
const cfg = join(dir, 'cv.json');
await copyFile(join(ROOT, 'resume', 'templates', 'cv.example.json'), cfg);
try {
  const { pdfPath } = await buildCv(cfg, { pdf: !process.argv.includes('--no-pdf') });
  console.log(`\nOpen ${pdfPath ?? dir} to see how your resume looks.`);
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
