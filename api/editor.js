// Backend for editor.html: password login, and a narrow GitHub proxy so the
// GitHub token stays on the server and never reaches the browser.
//
// Vercel environment variables:
//   EDITOR_PASSWORD      the editor password (at least 12 characters)
//   EDITOR_GITHUB_TOKEN  fine-grained GitHub token, Contents read/write on the repos below
const crypto = require('crypto');

const ALLOWED_REPOS = new Set([
  'stevedhawley-create/islanddreamcollective.com',
  'stevedhawley-create/balivillabookings.com',
  'stevedhawley-create/hostopz-landing',
]);
const GITHUB_API = process.env.EDITOR_GITHUB_API || 'https://api.github.com';
const COOKIE = 'ed_session';
const SESSION_SECONDS = 12 * 60 * 60;
const MIN_PASSWORD_LENGTH = 12;

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

// Sessions are signed with a key derived from both secrets, so changing either one signs everybody out.
function signingKey() { return sha256(process.env.EDITOR_PASSWORD + '\n' + process.env.EDITOR_GITHUB_TOKEN); }
function sign(exp) { return crypto.createHmac('sha256', signingKey()).update(String(exp)).digest('hex'); }

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function validSession(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < Date.now() / 1000) return false;
  const a = Buffer.from(m[2], 'hex'), b = Buffer.from(sign(exp), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// Only these GitHub calls are allowed: repo info, the file list, and reading or saving a file.
function allowedGithubCall(method, path) {
  const m = path.match(/^\/repos\/([^/]+)\/([^/?]+)(\/git\/trees\/[^/?]+\?recursive=1|\/contents\/[^?]+(\?ref=[^&]+)?)?$/);
  if (!m || !ALLOWED_REPOS.has(`${m[1]}/${m[2]}`.toLowerCase())) return false;
  if (/(^|\/)\.\.?(\/|$)|%2e%2e/i.test(path)) return false;
  if (method === 'PUT') return !!(m[3] && m[3].startsWith('/contents/'));
  return method === 'GET';
}

module.exports = async function handler(req, res) {
  const { EDITOR_PASSWORD, EDITOR_GITHUB_TOKEN } = process.env;
  if (!EDITOR_PASSWORD || !EDITOR_GITHUB_TOKEN || EDITOR_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    return send(res, 503, { error: 'The editor is not set up yet. Add EDITOR_PASSWORD (12+ characters) and EDITOR_GITHUB_TOKEN in Vercel, then redeploy.' });
  }
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action');

  // Blocks other websites from making requests on the owner's behalf.
  if (req.method !== 'GET' && req.headers['x-editor'] !== '1') return send(res, 403, { error: 'Forbidden' });

  if (action === 'session') return send(res, 200, { signedIn: validSession(req) });

  if (action === 'login' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'Bad request' }); }
    const ok = crypto.timingSafeEqual(sha256(body.password || ''), sha256(EDITOR_PASSWORD));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 1500)); // slows down password guessing
      return send(res, 401, { error: 'Wrong password' });
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    res.setHeader('Set-Cookie', cookieHeader(`${exp}.${sign(exp)}`, SESSION_SECONDS));
    return send(res, 200, { signedIn: true });
  }

  if (action === 'logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    return send(res, 200, { signedIn: false });
  }

  if (action === 'gh') {
    if (!validSession(req)) return send(res, 401, { error: 'Please sign in again' });
    const path = url.searchParams.get('path') || '';
    if (!allowedGithubCall(req.method, path)) return send(res, 403, { error: 'Not allowed' });
    let body;
    if (req.method === 'PUT') {
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'Bad request' }); }
      const { message, content, sha, branch } = body;
      body = JSON.stringify({ message, content, sha, branch });
    }
    const upstream = await fetch(GITHUB_API + path, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${EDITOR_GITHUB_TOKEN}`,
        Accept: req.headers['x-gh-accept'] === 'raw' ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'site-editor',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    return send(res, upstream.status, buf, upstream.headers.get('content-type') || 'application/octet-stream');
  }

  return send(res, 404, { error: 'Not found' });
};
