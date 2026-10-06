// Quick safety check for a deployed Bulkbook site.   Usage:  node scripts/check-live.mjs https://your-site.example
// It checks the things that can be checked without signing in. It does not replace the sign-in checks in README section 7.
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) { console.error('Give the site address, for example: node scripts/check-live.mjs https://bulkbook.example.workers.dev'); process.exit(2); }

let failed = 0;
const say = (ok, text, extra) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}${!ok && extra ? '  [' + extra + ']' : ''}`); };
const get = async (path, init) => { const r = await fetch(base + path, { redirect: 'manual', ...init }); return { r, text: await r.text() }; };

// Secrets must never appear in anything the browser can download.
const SECRET = /sk_(?:test|live)_[A-Za-z0-9]{8,}|sb_secret_[A-Za-z0-9_-]{8,}/;
function looksLikeServiceJwt(s) {
  for (const m of s.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g) || []) {
    try { const p = JSON.parse(Buffer.from(m.split('.')[1], 'base64url').toString()); if (p.role === 'service_role') return true; } catch { /* not a JWT */ }
  }
  return false;
}

try {
  const cfg = await get('/api/config');
  let j = {}; try { j = JSON.parse(cfg.text); } catch { /* checked below */ }
  say(cfg.r.status === 200, '/api/config answers 200', 'got ' + cfg.r.status + ' ' + cfg.text.slice(0, 120));
  const keys = Object.keys(j).sort().join(',');
  say(keys === 'clerkPublishableKey,supabasePublishableKey,supabaseUrl', '/api/config returns exactly the 3 public values', keys);
  say(String(j.clerkPublishableKey || '').startsWith('pk_'), 'Clerk key is a publishable key (pk_...)');
  say(!SECRET.test(cfg.text) && !looksLikeServiceJwt(cfg.text), '/api/config contains no secret key');
  say((cfg.r.headers.get('cache-control') || '').includes('no-store'), '/api/config is not cached');

  for (const p of ['/', '/app.js', '/styles.css', '/manifest.json']) {
    const f = await get(p);
    say(f.r.status === 200, `${p} loads`, 'status ' + f.r.status);
    say(!SECRET.test(f.text) && !looksLikeServiceJwt(f.text), `${p} contains no secret key`);
  }
  const home = await get('/');
  say(home.r.headers.get('x-content-type-options') === 'nosniff', 'security header: x-content-type-options');
  say(!!home.r.headers.get('x-frame-options'), 'security header: x-frame-options');
  say((await get('/_headers')).r.status === 404, 'the _headers file itself is not downloadable');

  const body = JSON.stringify({ name: 'Check Person', login: 'checkperson', password: 'not-a-real-pass-1' });
  const hdr = { 'content-type': 'application/json' };
  say((await get('/api/staff', { method: 'POST', headers: hdr, body })).r.status === 401, 'creating an employee without signing in is refused (401)');
  say((await get('/api/staff', { method: 'POST', headers: { ...hdr, authorization: 'Bearer abc.def.ghi' }, body })).r.status === 401, 'creating an employee with a fake token is refused (401)');
  say((await get('/api/staff/user_abc', { method: 'DELETE' })).r.status === 401, 'deleting an employee without signing in is refused (401)');
  say((await get('/api/nothing')).r.status === 404, 'unknown /api paths give 404');
} catch (e) {
  say(false, 'could not reach the site', e.message);
}
console.log(failed ? `\n${failed} check(s) FAILED. Do not use the site for real data until fixed.` : '\nAll checks passed. Now do the sign-in checks in README section 7.');
process.exit(failed ? 1 : 0);
