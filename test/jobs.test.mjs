// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'jsk-test-'));
process.env.DATA_DIR = dir;
const { canonicalJobKey, makeSlug, saveJob, parseJdHeader, jdText } = await import('../src/jobs.mjs');
const { parseJsonReply } = await import('../src/llm.mjs');

test('canonicalJobKey: Indeed jk and vjk are the same job', () => {
  assert.equal(canonicalJobKey('https://www.indeed.com/viewjob?jk=abc123&from=serp'), 'indeed:abc123');
  assert.equal(canonicalJobKey('https://www.indeed.com/jobs?q=x&vjk=abc123'), 'indeed:abc123');
});

test('canonicalJobKey: LinkedIn view and collection URLs match', () => {
  assert.equal(canonicalJobKey('https://www.linkedin.com/jobs/view/4012345678/?trk=x'), 'linkedin:4012345678');
  assert.equal(canonicalJobKey('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678'), 'linkedin:4012345678');
  assert.equal(canonicalJobKey('https://www.linkedin.com/jobs/view/react-developer-at-acme-4012345678?trk=x'), 'linkedin:4012345678');
  assert.equal(canonicalJobKey('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678'), 'linkedin:4012345678');
});

test('makeSlug drops seniority prefixes and keeps it short', () => {
  assert.equal(makeSlug('Acme Corp Inc', 'Senior Frontend Engineer (React)'), 'acme-corp-frontend-engineer-react');
});

test('jd.txt round-trips through the header parser', () => {
  const job = { title: 'Dev', company: 'Acme', location: 'Remote', url: 'https://x.test/1', applyType: 'indeed', body: 'Body text' };
  const parsed = parseJdHeader(jdText(job));
  assert.equal(parsed.title, 'Dev');
  assert.equal(parsed.company, 'Acme');
  assert.equal(parsed.body, 'Body text');
});

test('saveJob numbers folders and refuses duplicates', async () => {
  const body = 'A long enough job description for the save rule to accept it.';
  const a = await saveJob({ title: 'Dev', company: 'Acme', url: 'https://www.indeed.com/viewjob?jk=111', body });
  const b = await saveJob({ title: 'Dev', company: 'Acme', url: 'https://www.indeed.com/viewjob?jk=111&from=x', body });
  const c = await saveJob({ title: 'Dev', company: 'Acme', url: 'https://to.indeed.com/rotated', body });
  const d = await saveJob({ title: 'QA', company: 'Beta', url: 'https://www.linkedin.com/jobs/view/9/', body });
  assert.deepEqual([a.created, b.created, c.created, d.created], [true, false, false, true]);
  assert.equal(a.folder, '001-acme-dev');
  assert.equal(d.folder, '002-beta-qa');
  await assert.rejects(saveJob({ title: 'X', company: 'Y', body: 'short' }));
});

test('parseJsonReply tolerates code fences and chatter', () => {
  assert.deepEqual(parseJsonReply('```json\n{"score": 4}\n```'), { score: 4 });
  assert.deepEqual(parseJsonReply('Sure! {"score": 3.5} hope that helps'), { score: 3.5 });
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
