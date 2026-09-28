# Job Search Kit

A self-hosted job search pipeline you run on your own computer:

- **Finds jobs:** searches Indeed and LinkedIn on a schedule and imports the jobs from your job-alert emails.
- **Saves jobs in one click:** a browser extension saves any Indeed or LinkedIn posting you're looking at.
- **Scores every job 0–5** against your profile with the AI model of your choice, with the reasons listed.
- **Writes a tailored one-page resume PDF** for the jobs worth applying to, using only facts from your profile.
- **Tracks everything** in a local dashboard: filter by score, open resumes, mark jobs as submitted or skipped.
- **Runs on autopilot with n8n:** scheduled searches, email imports, a daily digest of the best matches, and alerts.

Your data never leaves your machine, apart from the job text sent to your AI provider for scoring and resume writing. Your profile, jobs and browser logins are all in git-ignored files.

```
 Indeed / LinkedIn searches ─┐
 Job-alert emails (n8n) ─────┼──► queue ──► scraper ──► data/jobs/NNN-company-role/
 Browser extension ──────────┘                            ├─ jd.txt      the job description
                                                          ├─ score.json  AI fit score + reasons
                                                          └─ cv-*.pdf    tailored resume
                                                                  │
                                         Dashboard (localhost:7867) ◄──┘ ──► n8n daily digest
```

## Quick start

```bash
git clone <this repo> job-search-kit && cd job-search-kit
npm install
npx playwright install chromium   # used to render resume PDFs
npm run setup                     # creates your private profile, search and .env files
```

Then:

1. Fill in `profile/profile.yml`: who you are, your work history, and what you're looking for.
2. Fill in `profile/search.json`: the job searches to run.
3. Put your AI provider key in `.env`. DeepSeek, OpenAI, OpenRouter and a local Ollama all work.
4. Run `npm run doctor` and fix anything it flags.
5. Run `npm run resume:sample` to see your resume rendered, without using the AI.
6. Run `npm start` and open http://localhost:7867.

**Read [docs/USAGE.md](docs/USAGE.md) for the full guide.** It covers logging in to the job sites, installing the extension, setting up n8n, and the day-to-day workflow.

## What's inside

| Folder | What it is |
|---|---|
| `profile/` | Your details (fill in the `.example` files); your filled-in copies are git-ignored |
| `dashboard/` | Local web dashboard and the API that everything else talks to |
| `extension/` | Chrome/Edge extension: a "Save job" button on Indeed and LinkedIn |
| `scrapers/` | Indeed and LinkedIn search + job-page scrapers (stealth browser) |
| `resume/` | AI resume tailoring, HTML template, PDF rendering and PDF checks |
| `src/` | Pipeline, job store, AI scoring, AI client, notifications |
| `n8n/` | Importable n8n workflows: scheduled search, email import, digest, alerts |
| `scripts/` | `setup`, `doctor`, `resume:sample` |

## Requirements

- Node.js 20+
- Python 3 with `pip install pypdf` (or `poppler-utils`), used to check that resume PDFs are readable by applicant-tracking systems
- A desktop session for scraping: Indeed blocks headless browsers. On a server, use a virtual display (`xvfb-run`).
- An Indeed login for Indeed scraping. LinkedIn works without logging in (guest mode).
- An API key for any OpenAI-compatible AI provider, or a local Ollama
- Optional: [n8n](https://n8n.io) for automation

## A note on scraping

Scraping job sites may break their terms of service, and both sites change their pages often. The scrapers go slowly, use your own logged-in session, and pause for you to solve captchas instead of evading them. Use them for your own job search, at a gentle pace. The browser extension and the email import don't scrape search pages at all, and they're the safest way to bring jobs in.

## Credits

Built on ideas and code from [career-ops](https://github.com/santifer/career-ops) by Santiago Fernández de Valderrama (MIT). MIT licensed; see [LICENSE](LICENSE).
