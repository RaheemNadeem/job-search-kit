# How to use Job Search Kit

This guide walks you from a fresh clone to a job search that runs itself. Plan
on about 30 minutes, most of it spent filling in your profile.

- [1. Install](#1-install)
- [2. Fill in your profile](#2-fill-in-your-profile)
- [3. Choose an AI provider](#3-choose-an-ai-provider)
- [4. Check your setup](#4-check-your-setup)
- [5. Start the dashboard](#5-start-the-dashboard)
- [6. Install the browser extension](#6-install-the-browser-extension)
- [7. Log in to Indeed (LinkedIn is optional)](#7-log-in-to-indeed-linkedin-is-optional)
- [8. Search for jobs](#8-search-for-jobs)
- [9. Scores and resumes](#9-scores-and-resumes)
- [10. Automate it with n8n](#10-automate-it-with-n8n)
- [11. Day-to-day workflow](#11-day-to-day-workflow)
- [12. Command reference](#12-command-reference)
- [13. Troubleshooting](#13-troubleshooting)
- [14. Privacy: what stays on your machine](#14-privacy-what-stays-on-your-machine)

---

## 1. Install

You need **Node.js 20+** and **Python 3**.

```bash
git clone <this repo> job-search-kit
cd job-search-kit
npm install
npx playwright install chromium     # renders resume PDFs
pip install pypdf                   # checks resume PDFs are readable by applicant-tracking systems
npm run setup
```

`npm run setup` creates four files for you. It never overwrites a file that
already exists, so it's safe to run again.

| File | What it's for |
|---|---|
| `profile/profile.yml` | Everything about you: contact details, work history, skills, what you want |
| `profile/search.json` | The Indeed and LinkedIn searches to run |
| `profile/context.md` | Optional free-form notes about you for the AI |
| `.env` | Your AI key and settings (a random dashboard token is added for you) |

All four are **git-ignored**, so your details are never committed.

## 2. Fill in your profile

Open `profile/profile.yml`. It's filled in with a made-up person, **Jordan
Example**, so you can see the format. Replace every section with your own
details.

**This file is the only truth the AI knows about you.** When it tailors a
resume, it reorders and emphasises what's here, but it never invents
employers, titles, numbers or skills. The more real detail you put in (bullets
with measurable results, the technologies you actually used), the better your
scores and resumes will be.

What each section does:

- **`name`, `email`, `phone`, `links`:** the resume header. `links` takes an
  `icon` of `linkedin`, `github` or `web`.
- **`location` / `location_note`:** where you live, and the pill shown on the
  resume (e.g. "Open to Relocation / Remote").
- **`work_authorization`:** `summary` tells the AI your status, so jobs needing
  a visa or clearance you don't have score low. `show_on_resume` and
  `note_on_resume` decide whether `resume_text` appears on the resume at all.
- **`experience`:** your jobs, most recent first. Give each a short, unique
  `id` (`current`, `previous`, `acme`, …). The AI may **retitle** a role to fit
  the job, e.g. "Software Engineer, Frontend (React)" instead of "Software
  Engineer". It never changes the company or the dates. Turn retitling off with
  `tailoring.retitle_roles: false`.
- **`projects`, `education`, `recognition`, `proof_points`:** printed as they
  are on every resume. Leave a list empty (`[]`) to hide that section.
- **`skills`:** your baseline skill rows. The AI regroups them for each job.
- **`preferences`:** how jobs are scored:
  - `core_stack`: the technologies you're strongest in. Matching these is what
    scores highest.
  - `mismatched_stacks`: stacks you don't work in. Jobs built mainly on them
    score 2 or lower, even if some keywords overlap.
  - `dealbreakers`: things that rule a job out, e.g. "security clearance
    required".
  - `locations`, `remote_ok`, `open_to_relocation`
- **`tailoring`:** how resumes are written: the seniority framing, US Letter or
  A4 paper, and any extra rules in plain English.

Next, open `profile/search.json` and set what to search for:

```json
{
  "indeed": {
    "queries": ["react developer", "full stack developer (react OR node)"],
    "tiers": [
      { "label": "Austin", "l": "Austin, TX", "radius": 25 },
      { "label": "Remote", "l": "Remote" }
    ],
    "fromageDays": 1,
    "maxPerRun": 40
  },
  "linkedin": {
    "queries": ["react developer"],
    "locations": ["United States"],
    "fromageDays": 1,
    "maxPerQuery": 25
  }
}
```

- **Indeed:** every query runs in every tier. List tiers most specific first:
  each job is tagged with the first tier that finds it, so you can tell local
  jobs from nationwide ones. For another country, add
  `"domain": "uk.indeed.com"` (or `ca.`, `au.`, …) to a tier. Queries accept
  `AND`, `OR`, parentheses and quotes.
- **`fromageDays`:** only jobs posted in the last N days. Use 1 when searching
  several times a day.
- **`maxPerRun` / `maxPerQuery`:** caps on how many new jobs each run
  collects. Anything past the cap is picked up on the next run.
- To turn a site off, set `"enabled": false` on it.

## 3. Choose an AI provider

Any service with an OpenAI-compatible API works. Set it in `.env`:

| Provider | `LLM_BASE_URL` | `LLM_MODEL` example | Notes |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` | Very cheap, good quality |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4.5` | One key, many models |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5:14b` | Free and private; leave `LLM_API_KEY` empty |

```ini
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-chat
```

Scoring needs a lot of small requests and resume writing needs a few bigger
ones. You can use a cheap model for scoring and a stronger one for resumes:

```ini
LLM_RATING_MODEL=deepseek-chat
LLM_RESUME_MODEL=deepseek-reasoner
```

If your provider returns an error about `response_format`, add
`LLM_JSON_MODE=0`.

## 4. Check your setup

```bash
npm run doctor            # checks files, profile, AI settings, PDF tools
npm run doctor -- --llm   # also sends one tiny test request to your AI provider
npm run resume:sample     # renders a sample resume from your profile, no AI needed
```

Open the PDF that `resume:sample` prints. This is the quickest way to check how
your profile looks on a resume. Edit `profile.yml` and run it again until
you're happy.

## 5. Start the dashboard

```bash
npm start
```

Open **http://localhost:7867**. Keep this terminal running while you use the
kit: the extension, the pipeline and n8n all talk to this server.

On the dashboard you can:

- **Filter** by status (pending / done / submitted / skipped) or score, and
  search by company or role.
- **Rate unrated** to score every job that has no score yet.
- **CV create / CV regen** to write a tailored resume for a job (about 30–90
  seconds). **📄 Resume PDF** opens it.
- **Tick the checkbox** once you've applied, which marks the job as submitted.
- **Skip** a job with a note on why (e.g. "needs 10 years of Go").
- **+ Add JD** to paste in a job description from any site.
- **Click a job** to read the full description and see why it got its score.

Every job is a plain folder you can open yourself:

```
data/jobs/042-acme-frontend-engineer/
  jd.txt                                       the job description
  score.json                                   { "score": 4.3, "reasons": [...] }
  cv.json                                      the tailored resume content
  cv-jordan-example-acme-frontend-engineer-2026-01-15.pdf
```

## 6. Install the browser extension

The extension adds a **→ Save job** button to Indeed and LinkedIn job pages. One
click saves the job to your dashboard and starts scoring it.

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. Open any Indeed job or LinkedIn job page and click **→ Save job**.

The extension talks to `http://localhost:7867`. If you change `DASHBOARD_PORT`,
update the port in `extension/manifest.json` and at the top of
`extension/content.js`.

This is the most reliable way to bring jobs in: it reads the page you already
have open, so it never runs into captchas.

## 7. Log in to Indeed (LinkedIn is optional)

The scrapers use a real, visible browser with its own saved session, kept in
`data/browser-profile/`.

**Indeed: log in once.** Indeed sits behind Cloudflare, which lets a normal
logged-in browser through far more reliably than an anonymous one.

```bash
npm run login:indeed
```

A browser window opens. Sign in, then press **Enter** in the terminal or close
the window. For a country-specific Indeed site: `node scrapers/indeed.mjs --login uk.indeed.com`.

**LinkedIn: no login needed.** Without a session, the LinkedIn scraper runs in
**guest mode**: it searches LinkedIn's public job listings and reads each job
from its public page, the same pages anyone sees logged out. That's enough for
most people, and it keeps your LinkedIn account out of automation entirely.
Logging in (`npm run login:linkedin`) gives you more results per search, but
LinkedIn is strict about automated use of real accounts, so it's your call.

**On a server with no screen**, run the scrapers under a virtual display:
`sudo apt install xvfb`, then prefix commands with `xvfb-run`. You won't be
able to solve captchas by hand that way, so log in to Indeed from a desktop
session, e.g. over remote desktop.

## 8. Search for jobs

```bash
npm run search              # Indeed + LinkedIn, using profile/search.json
npm run search:indeed       # only Indeed
npm run search:linkedin     # only LinkedIn
npm run add -- "https://www.indeed.com/viewjob?jk=..."   # import specific job links
```

A run works like this:

1. **Search:** collect the job links, skipping any you've already saved.
2. **Scrape:** open each job and save its full description to `data/jobs/`.
3. **Score:** have the AI rate each new job against your profile.
4. **Resume (optional):** with `AUTO_RESUME=1`, write a tailored resume for
   every new job scoring at least `RESUME_MIN_SCORE`.
5. **Notify (optional):** send a summary to your notifications webhook.

**Captchas and sign-in walls:** if a site challenges the browser, the run
pauses and sends an "Action needed" notification. Solve the challenge in the
open browser window and the run carries on by itself. If nobody solves it within
`CAPTCHA_WAIT_MIN` minutes (default 10), the blocked jobs are listed in the
summary so you can save them with the extension instead.

Only one run happens at a time, because runs share one browser session. A
second run started while one is going exits straight away.

## 9. Scores and resumes

**Scores** run from 0 to 5 and come with reasons. The rubric comes from
`preferences` in your profile:

- A match on your `core_stack` counts most. A matching job scores 4–5 even if
  it asks for more years of experience than you have.
- Jobs built mainly on a stack in `mismatched_stacks` score 2 or lower.
- Dealbreakers, work authorization you don't have, and a required clearance or
  licence pull the score right down.

If the scores look off, tighten `core_stack` and `mismatched_stacks`, then
re-score:

```bash
npm run rate -- --all          # re-score everything
npm run rate -- --below 3      # re-score only jobs currently under 3
```

**Resumes** are written in two steps:

1. The AI writes `cv.json`, the tailored content: title, tagline, summary, role
   titles, "What I Bring" cards, key skills, and relevant achievements.
2. `resume/build-cv.mjs` combines it with your fixed profile details and renders
   HTML and a one-page PDF. It then checks the PDF has a real text layer and
   still contains your name and email, which applicant-tracking systems need to
   read it.

```bash
npm run resume -- --folder 042-acme-frontend-engineer    # one job
npm run resume -- --min-score 4                          # every 4+ job without a resume
npm run resume -- --folder 042-acme-frontend-engineer --force   # rewrite it
```

**To fix a resume by hand**, edit that job's `cv.json` and rebuild it without
calling the AI:

```bash
node resume/build-cv.mjs data/jobs/042-acme-frontend-engineer/cv.json
```

**To change the design**, edit `resume/templates/cv-template.html`. The styling
uses Tailwind classes, loaded from a CDN when the PDF is rendered, so rendering
needs an internet connection. The `{{PLACEHOLDERS}}` are filled in by
`build-cv.mjs`.

## 10. Automate it with n8n

[n8n](https://n8n.io) runs the kit on a schedule. Install it however you like,
for example `npx n8n`, or Docker.

### Connect n8n to the dashboard

- **n8n on the same computer (`npx n8n`):** the dashboard URL is
  `http://localhost:7867`. Nothing else to change.
- **n8n in Docker:** the container reaches your computer at
  `http://host.docker.internal:7867`, but the dashboard only listens on
  `127.0.0.1` by default. In `.env`, set `DASHBOARD_HOST=0.0.0.0` and make sure
  `DASHBOARD_TOKEN` is set (`npm run setup` generates one). On Linux, start
  n8n with `--add-host=host.docker.internal:host-gateway`.

The dashboard only accepts requests from other machines when they carry the
token, so setting `DASHBOARD_HOST=0.0.0.0` doesn't open your data to your
network.

### Import the workflows

In n8n, go to **Workflows → Import from file** and import each file in `n8n/`.
Every workflow starts with a **Settings** node: set `dashboardUrl` and paste
your `DASHBOARD_TOKEN`.

| Workflow | What it does | You need to |
|---|---|---|
| `1-scheduled-search.json` | Runs the Indeed + LinkedIn search every 2 hours | Adjust the schedule if you like |
| `2-email-import.json` | Reads unread Indeed/LinkedIn job-alert emails and queues every job link in them | Add an **IMAP** credential for the mailbox that gets your job alerts (Gmail: use an App Password) |
| `3-daily-digest.json` | Every morning, emails you the new jobs scoring 4+ | Add an **SMTP** credential; set From/To |
| `4-notifications.json` | Emails you import summaries and "captcha needs solving" alerts | Add an **SMTP** credential; set `NOTIFY_WEBHOOK_URL` in `.env` to this workflow's production webhook URL |

Then switch each workflow to **Active**.

**Tip:** set up job alerts on Indeed and LinkedIn themselves and send them to
the mailbox that `2-email-import` reads. Job-site alerts plus the email import
bring in a steady flow of jobs without scraping search pages at all, which is
the gentlest option.

**The scheduled search needs a display.** It opens a real browser, so the
computer running the dashboard needs an active desktop session (or Xvfb, see
step 7).

### API reference (for your own automations)

Requests from another machine need `Authorization: Bearer <DASHBOARD_TOKEN>`.

| Method | Path | Body / query | Does |
|---|---|---|---|
| POST | `/api/search` | `{"source": "all"\|"indeed"\|"linkedin"}` | Starts a search run (409 if one is running) |
| POST | `/api/queue` | `{"urls": [...], "source": "email", "subject": "..."}` | Queues job links and starts processing |
| GET | `/api/status` | | `{ busy: true/false }` |
| GET | `/api/top` | `?min=4&hours=24` | New jobs scoring ≥ min, best first |
| GET | `/api/jobs` | | Every job with its status |
| POST | `/api/generate-cv` | `?folder=042-…` | Writes and renders a resume |
| POST | `/jd` | `{title, company, location, salary, url, body}` | Saves one job (what the extension uses) |

## 11. Day-to-day workflow

1. **Morning:** read the digest email, or open the dashboard and filter
   **★ Top ≥4**.
2. **Open a job**, read why it scored as it did, and click **CV create** (or
   turn on `AUTO_RESUME=1` so it's already done).
3. **Open the PDF** and give it a quick read. Hand-edit `cv.json` and rebuild if
   anything needs fixing.
4. **Apply** with **↗ Apply**, then tick the job as submitted.
5. **Skip** jobs you won't apply to, with a short reason, so they drop out of
   your list.
6. **While browsing** Indeed or LinkedIn, click **→ Save job** on anything
   interesting.

## 12. Command reference

| Command | Does |
|---|---|
| `npm run setup` | Create your profile/search/.env files from the examples |
| `npm run doctor` | Check the setup (`-- --llm` also tests the AI) |
| `npm start` | Run the dashboard + API on http://localhost:7867 |
| `npm run login:indeed` | Save a logged-in Indeed session |
| `npm run login:linkedin` | Optional: log in to LinkedIn (guest mode works without it) |
| `npm run search` | Search Indeed + LinkedIn, scrape, score |
| `npm run search:indeed` / `search:linkedin` | One site only |
| `npm run queue` | Process job links waiting in `data/queue/` |
| `npm run add -- <url> …` | Import specific job links |
| `npm run rate` | Score unrated jobs (`-- --all`, `-- --below 3`, `-- --folder X`) |
| `npm run resume` | Resumes for good matches (`-- --folder X`, `-- --min-score 4`, `-- --force`) |
| `npm run resume:sample` | Render a sample resume from your profile without the AI |
| `npm test` | Run the unit tests |

Debugging LinkedIn selectors: `node scrapers/linkedin.mjs --probe <job url>`.

## 13. Troubleshooting

**"LLM not configured"**: set `LLM_API_KEY` in `.env`. For Ollama, set
`LLM_BASE_URL` to `http://localhost:11434/v1`; no key is needed.

**Every Indeed job gets skipped as "blocked"**: your session has expired or
Indeed is showing a captcha. Run `npm run login:indeed` again, then run a search
while you're at the computer so you can solve any challenge.

**Indeed jobs are saved with an empty description, or skipped as "thin"**:
Indeed has changed its page layout again. It currently serves two layouts, and
both are handled in `scrapers/indeed.mjs` (the selector lists in
`scrapeIndeed()`) and `extension/content.js` (`extractIndeed()`). Open a job
page, find the element holding the description in your browser's developer
tools, and add its selector to both lists.

**LinkedIn jobs come back "thin"**: LinkedIn has changed its page layout. Run
`node scrapers/linkedin.mjs --probe <a job url>` to see which selectors still
match, then update `extractJob()` in `scrapers/linkedin.mjs`. It holds
selectors for both the logged-in and the public (guest) layouts.

**"PDF verification failed"**: run `pip install pypdf` (or install
`poppler-utils`). If it reports the wrong page count, your content is longer
than one page. Shorten the profile bullets, or set `"expected_pages": 2` in
that job's `cv.json`.

**The PDF uses the wrong fonts or no styling**: rendering loads Tailwind from a
CDN, so check the internet connection. For a system Chrome instead of
Playwright's, set `CHROME_PATH`.

**n8n gets "remote access is off" or "missing or wrong token"**: set
`DASHBOARD_TOKEN` in `.env`, restart `npm start`, and paste the same token into
the workflow's **Settings** node.

**n8n in Docker can't connect**: set `DASHBOARD_HOST=0.0.0.0`, and on Linux add
`--add-host=host.docker.internal:host-gateway` to the n8n container.

**"another pipeline run is in progress"**: a search is still running, which is
expected. If none is running, delete `data/.pipeline.lock`.

## 14. Privacy: what stays on your machine

- `profile/profile.yml`, `profile/search.json`, `profile/context.md` and `.env`
  are **git-ignored**.
- Everything in `data/` (jobs, resumes, the queue, your saved browser logins) is
  **git-ignored**.
- The only thing sent anywhere is the **job description plus your profile
  text**, which goes to your AI provider for scoring and resume writing. Use
  Ollama if you want that to stay local too.
- The dashboard listens on `127.0.0.1` only by default. Other websites open in
  your browser can't call it: only the dashboard page itself and Indeed or
  LinkedIn pages (to save a job) are allowed.

**Before you push a fork anywhere, check you aren't committing personal
files:**

```bash
git status --ignored     # your profile, .env and data/ should show as ignored
```
