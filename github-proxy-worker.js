/**
 * github-proxy-worker.js
 * ----------------------------------------------------------------
 * Free Cloudflare Worker that proxies requests to api.github.com using
 * a server-side Personal Access Token (PAT).
 *
 * WHY THIS EXISTS
 * Unauthenticated requests to the GitHub API are capped at 60/hour,
 * PER NETWORK (i.e. shared by everyone behind the same IP — an office,
 * a campus wifi, a VPN). Once Commit Ticket gets any real traffic, that
 * ceiling gets hit constantly and visitors see "rate limit reached."
 * A request authenticated with a token gets 5,000/hour instead — and
 * because the token lives only on the Worker (never shipped to the
 * browser), it can't be stolen by reading the page source.
 *
 * DEPLOY (free tier, ~5 minutes)
 * 1. workers.cloudflare.com → sign up free → "Create Worker"
 * 2. Paste this whole file in, replacing the starter code → Deploy
 * 3. Worker → Settings → Variables → add an Environment Variable:
 *      name:  GITHUB_TOKEN
 *      value: a GitHub PAT (classic or fine-grained) with NO scopes
 *             checked — public read access doesn't need any
 *    Encrypt it (the "Encrypt" toggle) so it's a secret, not plaintext.
 * 4. Copy your Worker URL (something like
 *      https://commit-ticket-proxy.<your-subdomain>.workers.dev )
 * 5. In github_wrapped.html, set:
 *      const API_BASE = 'https://commit-ticket-proxy.<you>.workers.dev';
 *    That's the only change needed client-side — every fetch already
 *    builds its URL from API_BASE.
 *
 * This also fixes the "I'm testing repeatedly while filming and burn
 * my own 60/hour" problem, since 5,000/hour comfortably covers dozens
 * of takes plus real viewers hitting the page after the video goes up.
 *
 * COST: free. Cloudflare Workers' free tier is 100,000 requests/day,
 * and each ticket generation costs ~5 proxied requests — far more
 * headroom than the audience this is built for will ever need.
 * ----------------------------------------------------------------
 */

const GITHUB_API = 'https://api.github.com';

// Only forward requests under these path prefixes — keeps the proxy from
// being turned into an open relay for arbitrary GitHub API calls.
const ALLOWED_PREFIXES = ['/users/'];

// Lock the proxy to your own site so randoms can't piggyback on your quota.
// Set to '*' temporarily while testing locally from a file:// page, then
// tighten it once Commit Ticket is deployed to a real domain.
const ALLOWED_ORIGINS = [
  'https://ferdioaivision.dev',
  'http://localhost:8000',
  '*' // TODO: remove this line once deployed — keeping it open defeats the point of locking origins
];

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes('*') ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const isAllowed = ALLOWED_PREFIXES.some(p => url.pathname.startsWith(p));
    if (!isAllowed) {
      return new Response(JSON.stringify({ error: 'Path not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    const githubUrl = GITHUB_API + url.pathname + url.search;

    const githubRes = await fetch(githubUrl, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'commit-ticket-proxy',
        // env.GITHUB_TOKEN is set as an encrypted Worker secret — never
        // present in any response sent back to the browser.
        'Authorization': env.GITHUB_TOKEN ? `Bearer ${env.GITHUB_TOKEN}` : ''
      }
    });

    // Pass through GitHub's body and rate-limit headers untouched — the
    // front end already reads x-ratelimit-remaining / x-ratelimit-reset
    // from these to show "only N lookups left" and the exact reset time.
    const headers = new Headers(githubRes.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    headers.delete('content-encoding'); // avoid double-decoding issues through the proxy

    return new Response(githubRes.body, {
      status: githubRes.status,
      headers
    });
  }
};
