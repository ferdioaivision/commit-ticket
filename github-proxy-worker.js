/**
 * github-proxy-worker.js
 * ----------------------------------------------------------------
 * Free Cloudflare Worker that talks to the GitHub API on behalf of
 * Commit Ticket, using a server-side Personal Access Token (PAT).
 *
 * TWO ROUTES
 *
 *   GET /contrib/<username>   (NEW — what the ticket uses)
 *     Queries GitHub's GraphQL API (the same source as the contribution
 *     graph on a GitHub profile) and returns ONE compact JSON document:
 *     real per-day contribution counts for the last 90 UTC days (today
 *     included), real totals (commits / PRs / issues / reviews), the count
 *     of private contributions (`restricted`, only non-zero when the user
 *     shows them on their profile), stars and top language computed
 *     over ALL public non-fork repos (paginated), followers, account age.
 *
 *     The old approach (the REST "events" endpoint) only ever returns the
 *     last 300 events, so for an active developer it covered a few days
 *     and the rest of the 90-day window looked empty. GraphQL has no such
 *     cap.
 *
 *   GET /verify?p=<proof>     (NEW — ticket authenticity check)
 *     Every /contrib answer carries a `proof`: the ticket's key numbers
 *     signed with HMAC-SHA256 using a secret only this Worker knows. The
 *     QR code on a downloaded ticket points to the site with that proof;
 *     the site calls /verify, which answers { valid: true, ticket: {...} }
 *     with the ORIGINAL signed numbers, or { valid: false } if the proof
 *     was forged or altered. Nobody can edit a number and keep a valid QR.
 *
 *   GET /users/...            (legacy passthrough, kept for compatibility)
 *
 * SETUP
 *   Worker -> Settings -> Variables and Secrets -> secret GITHUB_TOKEN
 *   = a GitHub PAT (classic) with NO scopes ticked. GraphQL requires an
 *   authenticated request, and the token only lives on the Worker.
 *
 *   NEW: add a second secret TICKET_SECRET = any long random string
 *   (40+ characters). Never change it afterwards, or every ticket issued
 *   before the change stops verifying. Without it the site still works,
 *   it just issues tickets without a proof.
 *
 * CACHE
 *   Each /contrib/<username> answer is cached at Cloudflare's edge for
 *   CACHE_SECONDS (10 min). Repeat lookups cost no GitHub quota.
 * ----------------------------------------------------------------
 */

const GITHUB_API = 'https://api.github.com';

// Legacy passthrough: only forward these REST path prefixes.
const ALLOWED_PREFIXES = ['/users/'];

// Lock the proxy to your own site so randoms can't piggyback on your quota.
const ALLOWED_ORIGINS = [
  'https://commit-ticket.vercel.app',
  'http://localhost:8000',
  '*' // TODO: remove this line once deployed — keeping it open defeats the point of locking origins
];

const WINDOW_DAYS = 90;      // activity window shown on the ticket
const MAX_REPO_PAGES = 10;   // 10 x 100 = up to 1000 repos scanned for stars / language
const CACHE_SECONDS = 600;   // edge cache per username

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes('*') ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Lets the browser read the rate-limit headers from our responses.
    'Access-Control-Expose-Headers': 'x-ratelimit-remaining, x-ratelimit-reset'
  };
}

function jsonResponse(body, status, cors, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors, ...(extraHeaders || {}) }
  });
}

// Thrown for any upstream problem; mapped to an HTTP status the front end understands:
//   404 NOT_FOUND, 401 AUTH, 403 RATE_LIMIT, 502 UPSTREAM
class UpstreamError extends Error {
  constructor(status, code, reset) {
    super(code);
    this.status = status;
    this.code = code;
    this.reset = reset || null;
  }
}

// ---------------- GraphQL ----------------

const PROFILE_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    login
    name
    avatarUrl
    createdAt
    followers { totalCount }
    allRepos: repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100, orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { stargazerCount primaryLanguage { name } }
      pageInfo { hasNextPage endCursor }
    }
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      restrictedContributionsCount
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

const MORE_REPOS_QUERY = `
query($login: String!, $after: String!) {
  user(login: $login) {
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100, after: $after, orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { stargazerCount primaryLanguage { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function graphql(env, query, variables, rate) {
  const res = await fetch(GITHUB_API + '/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'commit-ticket-proxy'
    },
    body: JSON.stringify({ query, variables })
  });

  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining !== null) { rate.remaining = remaining; rate.reset = reset; }

  if (res.status === 401) throw new UpstreamError(401, 'AUTH');
  if (res.status === 403 || res.status === 429) throw new UpstreamError(403, 'RATE_LIMIT', reset);
  if (!res.ok) throw new UpstreamError(502, 'UPSTREAM');

  const body = await res.json();
  if (body.errors && body.errors.length) {
    const types = body.errors.map(e => e.type);
    if (types.includes('NOT_FOUND')) throw new UpstreamError(404, 'NOT_FOUND');
    if (types.includes('RATE_LIMITED')) throw new UpstreamError(403, 'RATE_LIMIT', reset);
    throw new UpstreamError(502, 'UPSTREAM');
  }
  if (!body.data || !body.data.user) throw new UpstreamError(404, 'NOT_FOUND');
  return body.data.user;
}

function summarizeRepos(nodes) {
  let stars = 0;
  const langCounts = {};
  for (const r of nodes) {
    stars += r.stargazerCount || 0;
    if (r.primaryLanguage && r.primaryLanguage.name) {
      langCounts[r.primaryLanguage.name] = (langCounts[r.primaryLanguage.name] || 0) + 1;
    }
  }
  return { stars, langCounts };
}

// Longest run of consecutive days with at least one contribution.
function computeLongestStreak(days) {
  const active = days.filter(d => d.count > 0).map(d => d.date).sort();
  let longest = 0, current = 0, prev = null;
  for (const dateStr of active) {
    const day = new Date(dateStr + 'T00:00:00Z');
    current = prev && Math.round((day - prev) / 86400000) === 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    prev = day;
  }
  return longest;
}

// Longest run of fully inactive days inside the WINDOW_DAYS UTC days ending today.
function computeLongestGap(days, now) {
  const counts = new Map(days.map(d => [d.date, d.count]));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let longest = 0, current = 0;
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const key = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    if ((counts.get(key) || 0) === 0) { current++; longest = Math.max(longest, current); }
    else current = 0;
  }
  return longest;
}

// ---------------- Ticket proof (signed snapshot) ----------------
// proof = <fields joined by "."> + "." + <first 12 bytes of HMAC-SHA256>.
// Numbers are base36 to keep the QR code small. Fields (version 2):
//   version . login . issuedAt . commits . restricted . prs . issues . total . stars . followers . streak . gap . language
// Version 1 proofs (no restricted / total) are still accepted when verifying.

const PROOF_VERSION = '2';
const SIG_BYTES = 12;
const textEncoder = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(text)));
  return b64url(sig.slice(0, SIG_BYTES));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const n36 = n => Math.max(0, Math.floor(Number(n) || 0)).toString(36);

async function signTicket(d, secret) {
  const body = [
    PROOF_VERSION, d.login, n36(d.generatedAt), n36(d.commits), n36(d.restricted), n36(d.prs), n36(d.issues),
    n36(d.totalContributions), n36(d.stars), n36(d.followers), n36(d.streak), n36(d.longestGap),
    encodeURIComponent(d.topLanguage || '').replace(/\./g, '%2E')
  ].join('.');
  return body + '.' + await hmac(secret, body);
}

// Returns the signed numbers, or null if the proof is malformed or forged.
async function openProof(proof, secret) {
  if (typeof proof !== 'string' || proof.length === 0 || proof.length > 300) return null;
  const cut = proof.lastIndexOf('.');
  if (cut < 0) return null;
  const body = proof.slice(0, cut);
  const sig = proof.slice(cut + 1);
  if (!safeEqual(await hmac(secret, body), sig)) return null;

  const f = body.split('.');
  let t; // raw fields, normalised across proof versions
  if (f[0] === '2' && f.length === 13) {
    t = { commits: f[3], restricted: f[4], prs: f[5], issues: f[6], total: f[7],
          stars: f[8], followers: f[9], streak: f[10], gap: f[11], lang: f[12] };
  } else if (f[0] === '1' && f.length === 11) {
    t = { commits: f[3], restricted: null, prs: f[4], issues: f[5], total: null,
          stars: f[6], followers: f[7], streak: f[8], gap: f[9], lang: f[10] };
  } else {
    return null;
  }
  let lang;
  try { lang = decodeURIComponent(t.lang); } catch (e) { return null; }
  const num = s => parseInt(s, 36);
  const opt = s => (s === null ? null : num(s));
  return {
    login: f[1],
    issuedAt: new Date(num(f[2]) * 1000).toISOString(),
    commits: num(t.commits),
    restricted: opt(t.restricted),
    prs: num(t.prs),
    issues: num(t.issues),
    totalContributions: opt(t.total),
    stars: num(t.stars),
    followers: num(t.followers),
    streak: num(t.streak),
    longestGap: num(t.gap),
    topLanguage: lang || null
  };
}

async function handleVerify(url, env, cors) {
  if (!env.TICKET_SECRET) return jsonResponse({ error: 'VERIFY_NOT_CONFIGURED' }, 500, cors);
  const ticket = await openProof(url.searchParams.get('p'), env.TICKET_SECRET);
  return jsonResponse(ticket ? { valid: true, ticket } : { valid: false }, 200, cors);
}

async function buildContribution(login, env, rate) {
  const now = new Date();
  // Window = the last WINDOW_DAYS UTC dates, today included: it starts at 00:00 UTC
  // of (today - (WINDOW_DAYS - 1)). "now - 90 days" gave 91 calendar days and cut the
  // first day at the current time of day, so the typed totals (commits, PRs, ...) and
  // the per-day calendar did not cover exactly the same days.
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(todayUtc - (WINDOW_DAYS - 1) * 86400000);

  const user = await graphql(env, PROFILE_QUERY, {
    login,
    from: from.toISOString(),
    to: now.toISOString()
  }, rate);

  // Stars + top language over ALL public non-fork repos (paginated).
  let { stars, langCounts } = summarizeRepos(user.repositories.nodes);
  let pageInfo = user.repositories.pageInfo;
  let pages = 1;
  while (pageInfo.hasNextPage && pages < MAX_REPO_PAGES) {
    const more = await graphql(env, MORE_REPOS_QUERY, { login, after: pageInfo.endCursor }, rate);
    const s = summarizeRepos(more.repositories.nodes);
    stars += s.stars;
    for (const k in s.langCounts) langCounts[k] = (langCounts[k] || 0) + s.langCounts[k];
    pageInfo = more.repositories.pageInfo;
    pages++;
  }

  let topLanguage = null, max = 0;
  for (const lang in langCounts) {
    if (langCounts[lang] > max) { max = langCounts[lang]; topLanguage = lang; }
  }

  // Per-day counts, restricted to the exact 90-day window (UTC dates).
  const fromKey = from.toISOString().slice(0, 10);
  const toKey = now.toISOString().slice(0, 10);
  const days = [];
  for (const week of user.contributionsCollection.contributionCalendar.weeks) {
    for (const d of week.contributionDays) {
      if (d.date >= fromKey && d.date <= toKey) days.push({ date: d.date, count: d.contributionCount });
    }
  }

  const cc = user.contributionsCollection;
  return {
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
    followers: user.followers.totalCount,
    publicRepos: user.allRepos.totalCount,
    stars,
    topLanguage,
    windowDays: WINDOW_DAYS,
    commits: cc.totalCommitContributions,
    prs: cc.totalPullRequestContributions,
    issues: cc.totalIssueContributions,
    reviews: cc.totalPullRequestReviewContributions,
    restricted: cc.restrictedContributionsCount || 0,
    totalContributions: cc.contributionCalendar.totalContributions,
    streak: computeLongestStreak(days),
    longestGap: computeLongestGap(days, now),
    generatedAt: Math.floor(now.getTime() / 1000),
    days
  };
}

async function handleContrib(login, env, ctx, cors) {
  if (!env.GITHUB_TOKEN) {
    return jsonResponse({ error: 'SERVER_TOKEN_MISSING' }, 500, cors);
  }

  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const cacheKey = new Request(`https://commit-ticket-cache.invalid/v2/contrib/${login.toLowerCase()}`);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(await hit.text(), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...cors }
      });
    }
  }

  const rate = {};
  try {
    const data = await buildContribution(login, env, rate);
    if (env.TICKET_SECRET) data.proof = await signTicket(data, env.TICKET_SECRET);
    const body = JSON.stringify(data);

    if (cache && ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(cacheKey, new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` }
      })));
    }

    const extra = { 'X-Cache': 'MISS' };
    if (rate.remaining !== undefined) extra['x-ratelimit-remaining'] = rate.remaining;
    if (rate.reset) extra['x-ratelimit-reset'] = rate.reset;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', ...cors, ...extra } });
  } catch (err) {
    if (err instanceof UpstreamError) {
      const extra = {};
      if (err.reset) extra['x-ratelimit-reset'] = err.reset;
      if (rate.remaining !== undefined) extra['x-ratelimit-remaining'] = rate.remaining;
      return jsonResponse({ error: err.code }, err.status, cors, extra);
    }
    return jsonResponse({ error: 'UPSTREAM' }, 502, cors);
  }
}

// ---------------- Legacy REST passthrough ----------------

async function handleLegacy(url, env, cors) {
  const githubUrl = GITHUB_API + url.pathname + url.search;
  const baseHeaders = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'commit-ticket-proxy'
  };

  try {
    let githubRes = await fetch(githubUrl, {
      headers: env.GITHUB_TOKEN ? { ...baseHeaders, 'Authorization': `Bearer ${env.GITHUB_TOKEN}` } : baseHeaders
    });
    // Invalid / expired token: retry anonymously instead of breaking the site.
    if (githubRes.status === 401) {
      githubRes = await fetch(githubUrl, { headers: baseHeaders });
    }
    const headers = new Headers(githubRes.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    headers.delete('content-encoding');
    return new Response(githubRes.body, { status: githubRes.status, headers });
  } catch (e) {
    return jsonResponse({ error: 'UPSTREAM' }, 502, cors);
  }
}

// ---------------- Entry point ----------------

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === '/verify') {
      return handleVerify(url, env, cors);
    }

    const m = url.pathname.match(/^\/contrib\/([A-Za-z0-9-]{1,39})$/);
    if (m) {
      return handleContrib(m[1], env, ctx, cors);
    }

    const isAllowed = ALLOWED_PREFIXES.some(p => url.pathname.startsWith(p));
    if (!isAllowed) {
      return jsonResponse({ error: 'Path not allowed' }, 403, cors);
    }

    return handleLegacy(url, env, cors);
  }
};
