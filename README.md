<div align="center">

# Commit Ticket

**Your commits, itemized.**
Drop a public GitHub username → get a shareable, printable "receipt" of your last 90 days of activity, ranked against real public profiles.

[![Live demo](https://img.shields.io/badge/live%20demo-commit--ticket.vercel.app-ffa657?style=for-the-badge)](https://commit-ticket.vercel.app)

![Frontend](https://img.shields.io/badge/frontend-vanilla%20HTML%2FCSS%2FJS-3fb950?style=flat-square)
![Backend](https://img.shields.io/badge/proxy-Cloudflare%20Workers-f38020?style=flat-square)
![Hosting](https://img.shields.io/badge/hosting-Vercel-000000?style=flat-square)
![Sign-in](https://img.shields.io/badge/sign--in-none-8b949e?style=flat-square)

<br />

<img src="docs/screenshots/landing.png" alt="Commit Ticket landing page" width="640" />

</div>

---

## What is it?

Commit Ticket turns a public GitHub profile into a **ticket**: an activity percentile, a few diff-style stats, a 90-day heatmap, a rank stamp and a barcode — designed to be screenshotted, posted and shared.

No account, no OAuth, no database. Type a username, print the ticket.

<div align="center">
<img src="docs/screenshots/ticket.png" alt="Example Commit Ticket" width="360" />
</div>

## What's on the ticket

| Element | Description |
| --- | --- |
| **Activity percentile** | Your rank against public profiles over the last 90 days (see [How the percentile works](#how-the-percentile-works)) |
| **Rank stamp** | A stamp derived from the percentile (`WARMING UP`, `HEAVY SHIPPER`, …) |
| **Commits shipped** | Commit contributions in the 90-day window |
| **Day streak** | Longest run of consecutive active days in the window |
| **Top language** | Most frequent primary language across public, non-fork repositories |
| **Stars earned** | Total stars across public, non-fork repositories |
| **Days idle, longest gap** | Longest run of days with zero contributions (the one "deletion" line) |
| **Activity heatmap** | One cell per day, 90 days, GitHub-style green scale |
| **Serial number & barcode** | Deterministic, seeded from the username — decorative only, never a metric |
| **Generation timestamp** | So re-shared copies are dated |

### Rank stamps

| Percentile | Stamp |
| --- | --- |
| < 1 | `FIRST COMMIT` |
| 1 – 24 | `WARMING UP` |
| 25 – 49 | `STEADY HANDS` |
| 50 – 74 | `AHEAD OF QUEUE` |
| 75 – 94 | `HEAVY SHIPPER` |
| ≥ 95 | `TOP TIER SHIP` |

## Export

One click on **Save ticket** downloads three files:

1. **Story image** — `commit-ticket-<user>-story.png`, 1080 × 1920, ready for Instagram / TikTok / WhatsApp stories
2. **Ticket PNG** — `commit-ticket-<user>.png`, tightly cropped at 2× with transparent corners
3. **Ticket PDF** — `commit-ticket-<user>.pdf`, single page sized exactly to the ticket

Exports are rendered client-side with [html2canvas](https://html2canvas.hertzen.com/) and [jsPDF](https://github.com/parallax/jsPDF).

## How the percentile works

The percentile is **an estimate, not an official GitHub statistic.** It adapts the ranking method popularized by [github-readme-stats](https://github.com/anuraghazra/github-readme-stats): a weighted blend of exponential CDFs (for counts that grow quickly) and log-normal CDFs (for heavy-tailed metrics).

| Metric | Weight | Reference median | Curve |
| --- | :---: | :---: | --- |
| Commits | 2 | 65 | exponential |
| Pull requests | 3 | 12 | exponential |
| Issues | 1 | 6 | exponential |
| Stars | 4 | 50 | log-normal |
| Followers | 1 | 10 | log-normal |

Commit, PR and issue medians are scaled down from their annual baselines to fit the 90-day window. Code reviews are collected but not part of the score.

## Architecture

```
┌──────────────┐   GET /contrib/<user>   ┌─────────────────────┐   GraphQL   ┌────────────┐
│  index.html  │ ──────────────────────▶ │  Cloudflare Worker  │ ──────────▶ │ GitHub API │
│  (Vercel)    │ ◀────────────────────── │  github-proxy-worker│ ◀────────── │            │
└──────────────┘      compact JSON       └─────────────────────┘             └────────────┘
      │                                          │
      │ percentile, streak, heatmap,             │ server-side PAT (no scopes)
      │ ticket rendering, PNG/PDF export         │ 10-min edge cache per username
```

- **`index.html`** — the whole frontend in a single file: UI, stats computation, percentile, ticket rendering and export. No build step, no framework.
- **`github-proxy-worker.js`** — a Cloudflare Worker that queries GitHub's **GraphQL** API on behalf of the site and returns one compact JSON document per user.

### Why a proxy and GraphQL?

- Unauthenticated GitHub REST calls are capped at **60 requests/hour per IP**. The Worker uses a server-side token, so every visitor shares a much larger quota.
- The REST `events` endpoint only exposes the **last 300 events**, which for an active developer covers just a few days. GraphQL's contribution calendar gives the **real per-day counts** for the full 90 days — the same data as a profile's contribution graph.
- The token never reaches the browser.

### Worker API

`GET /contrib/<username>` (username: letters, digits and hyphens, up to 39 chars)

```jsonc
{
  "login": "octocat",
  "name": "The Octocat",
  "avatarUrl": "https://avatars.githubusercontent.com/...",
  "createdAt": "2011-01-25T18:44:36Z",
  "followers": 1000,
  "publicRepos": 8,
  "stars": 420,
  "topLanguage": "JavaScript",
  "windowDays": 90,
  "commits": 33,
  "prs": 4,
  "issues": 2,
  "reviews": 1,
  "totalContributions": 40,
  "days": [{ "date": "2026-07-20", "count": 3 }]
}
```

| Status | `error` | Meaning |
| :---: | --- | --- |
| 404 | `NOT_FOUND` | No public account with that username |
| 401 | `AUTH` | The Worker's GitHub token is invalid |
| 403 | `RATE_LIMIT` | GitHub rate limit reached (reset time exposed via `x-ratelimit-reset`) |
| 500 | `SERVER_TOKEN_MISSING` | `GITHUB_TOKEN` secret not configured |
| 502 | `UPSTREAM` | GitHub returned an unexpected error |

Responses include an `X-Cache: HIT | MISS` header.

## Privacy

- **No sign-in.** Only public GitHub data is read.
- **No database, no cookies, no analytics of your lookups.** The browser keeps a short in-memory cache (10 min) that disappears when you close the tab — nothing is written to `localStorage`.
- The Worker caches each response at Cloudflare's edge for **10 minutes** to save quota.
- Private repositories are never queried.

## Run it yourself

### 1. Deploy the proxy (Cloudflare Workers)

1. Create a new Worker and paste in [`github-proxy-worker.js`](./github-proxy-worker.js).
2. Create a GitHub **classic personal access token with no scopes ticked** (GraphQL requires an authenticated request; public data needs no scope).
3. In the Worker: **Settings → Variables and Secrets → add secret `GITHUB_TOKEN`** with that token.
4. Edit `ALLOWED_ORIGINS` at the top of the file so only your own domain can use the proxy:

   ```js
   const ALLOWED_ORIGINS = [
     'https://your-domain.vercel.app',
     'http://localhost:8000'
   ];
   ```

### 2. Point the frontend at your Worker

In `index.html`, set `API_BASE` to your Worker URL:

```js
const API_BASE = 'https://your-worker.your-subdomain.workers.dev';
```

Update `BRAND` and `REPO_URL` just above it with your own handle and repository.

### 3. Deploy the site

It's a static page — drop the repo on [Vercel](https://vercel.com) (or Netlify, GitHub Pages, any static host). No build command, no output directory.

### Local development

```bash
git clone https://github.com/ferdioaivision/commit-ticket.git
cd commit-ticket
python3 -m http.server 8000
# open http://localhost:8000
```

## Tech stack

- **Frontend:** vanilla HTML, CSS and JavaScript — no framework, no bundler
- **Fonts:** [Fira Code](https://fonts.google.com/specimen/Fira+Code) and [Special Elite](https://fonts.google.com/specimen/Special+Elite)
- **Export:** html2canvas 1.4.1, jsPDF 2.5.1 (via cdnjs)
- **Proxy:** Cloudflare Workers + GitHub GraphQL API
- **Hosting:** Vercel

## Accessibility

- Visible focus states and a labelled username input
- Live region for status and error messages
- Respects `prefers-reduced-motion` (no cursor blink, no ring animation)

## Roadmap ideas

- Configurable time window (30 / 90 / 365 days)
- Light theme and alternative ticket designs
- Shareable permalink (`/?u=username`)
- Compare two profiles side by side

## Contributing

Issues and pull requests are welcome. The codebase is intentionally small — three files — so it's easy to read end to end.

## Author

Built by **[Ferdio AI Vision](https://github.com/ferdioaivision)**.

---

<div align="center">
<sub>Percentile is estimated from public data and is not an official GitHub statistic. Not affiliated with GitHub, Inc.</sub>
</div>
