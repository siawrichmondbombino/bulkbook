// Bulkbook server (Cloudflare Worker).
//
// What runs here, and why it is not in the browser:
//   GET    /api/config       -> the PUBLIC settings the browser needs (Clerk publishable key, Supabase URL + publishable key).
//                               They are kept in Worker secrets instead of in files, so nothing is committed to the code.
//   POST   /api/staff        -> OWNER ONLY. Creates an employee login in Clerk and the matching profile row in Supabase.
//   DELETE /api/staff/:id    -> OWNER ONLY. Deletes the employee's Clerk login and marks the profile deleted.
//   scheduled (cron)         -> runs the clean-up of old, fully paid receipts once a day.
// Everything else is served from the /public folder (static files).
//
// Secrets (never sent to the browser): CLERK_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY.
// Set them with `wrangler secret put NAME` (see README).

import { createClerkClient, verifyToken } from '@clerk/backend';

const SECURITY_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- Supabase (REST, with the service role key: this bypasses RLS, so it is only ever used here on the server) ----
async function supabase(env, fetchImpl, path, { method = 'GET', body } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, 'content-type': 'application/json', prefer: 'return=representation' };
  // Legacy service_role keys are JWTs and go in the Authorization header too. New-style secret keys (sb_secret_...)
  // are sent in the apikey header only. [Unverified for new-style keys: test once after setup, see README.]
  if (!key.startsWith('sb_')) headers.authorization = `Bearer ${key}`;
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ---- Check that the caller is the signed-in owner ----
async function requireOwner(request, env, deps) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(401, 'Please sign in again.');
  let payload;
  try {
    const opts = { secretKey: env.CLERK_SECRET_KEY };
    if (env.APP_ORIGIN) opts.authorizedParties = [env.APP_ORIGIN];
    const res = await deps.verifyToken(token, opts);
    // Different versions of @clerk/backend return either the payload or { data, errors }.
    if (res && (res.errors || res.error)) throw new Error('invalid');
    payload = res && res.data ? res.data : res;
  } catch {
    throw new HttpError(401, 'Please sign in again.');
  }
  if (!payload || !payload.sub) throw new HttpError(401, 'Please sign in again.');
  const rows = await supabase(env, deps.fetch, `/profiles?clerk_user_id=eq.${encodeURIComponent(payload.sub)}&select=role,status,full_name`);
  const me = rows && rows[0];
  if (!me || me.status !== 'active' || me.role !== 'owner') throw new HttpError(403, 'Only the owner can do this.');
  return { id: payload.sub, name: me.full_name };
}

const log = (env, deps, actor, action, detail) =>
  supabase(env, deps.fetch, '/activity_log', { method: 'POST', body: { actor_name: actor, action, detail } }).catch(() => {});

// ---- Create employee ----
async function createStaff(request, env, deps) {
  const owner = await requireOwner(request, env, deps);
  let input;
  try { input = await request.json(); } catch { throw new HttpError(400, 'Send name, login and password.'); }
  const name = String(input.name || '').trim();
  const login = String(input.login || '').trim().toLowerCase();
  const password = String(input.password || '');
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Enter the full name (2 to 80 characters).');
  // A login is either a login name (username) or an email address. Email is the fallback if the Clerk plan
  // does not offer username sign-in in production.
  const isEmail = login.includes('@');
  const loginOk = isEmail ? login.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(login) : /^[a-z0-9._-]{3,30}$/.test(login);
  if (!loginOk) throw new HttpError(400, 'Login: a login name (3 to 30 letters, numbers, dots or dashes, no spaces) or an email address.');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'The password needs 8 to 128 characters.');

  const clerk = deps.createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const [firstName, ...rest] = name.split(/\s+/);
  let user;
  try {
    user = await clerk.users.createUser({
      ...(isEmail ? { emailAddress: [login] } : { username: login }),
      password,
      firstName,
      lastName: rest.join(' ') || undefined,
      publicMetadata: { role: 'employee' }, // only informational: the real role lives in Supabase (profiles table)
    });
  } catch (e) {
    const first = e && e.errors && e.errors[0];
    throw new HttpError(422, (first && (first.longMessage || first.message)) || 'The login could not be created.');
  }
  try {
    await supabase(env, deps.fetch, '/profiles', {
      method: 'POST',
      body: { clerk_user_id: user.id, full_name: name, login_name: login, role: 'employee', status: 'active' },
    });
  } catch (e) {
    await clerk.users.deleteUser(user.id).catch(() => {}); // do not leave a login that has no profile
    throw e;
  }
  await log(env, deps, owner.name, 'Created login', name);
  return json({ id: user.id, name, login }, 201);
}

// ---- Delete employee ----
async function deleteStaff(request, env, deps, id) {
  const owner = await requireOwner(request, env, deps);
  if (!/^user_[A-Za-z0-9]+$/.test(id)) throw new HttpError(400, 'Invalid employee.');
  if (id === owner.id) throw new HttpError(400, 'You cannot delete your own login.');
  const rows = await supabase(env, deps.fetch, `/profiles?clerk_user_id=eq.${encodeURIComponent(id)}&select=role,status,full_name`);
  const target = rows && rows[0];
  if (!target) throw new HttpError(404, 'Employee not found.');
  if (target.role === 'owner') throw new HttpError(400, 'The owner login cannot be deleted here.');
  const clerk = deps.createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try { await clerk.users.deleteUser(id); }
  catch (e) { if (!(e && e.status === 404)) throw new HttpError(502, 'The login could not be deleted. Try again.'); }
  // The profile row is kept (status "deleted") so old receipts keep the employee's name.
  await supabase(env, deps.fetch, `/profiles?clerk_user_id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'deleted' } });
  await log(env, deps, owner.name, 'Deleted login', target.full_name);
  return json({ ok: true });
}

// ---- Scheduled clean-up ----
async function purge(env, deps) {
  const n = await supabase(env, deps.fetch, '/rpc/_purge_old_receipts', { method: 'POST', body: { p_actor: 'Automatic clean-up' } });
  return n;
}

export function createHandler(deps) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      try {
        if (url.pathname === '/api/config' && request.method === 'GET') {
          if (!env.CLERK_PUBLISHABLE_KEY || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) throw new HttpError(500, 'The server is not set up yet. See README step 7.');
          return json({
            clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
            supabaseUrl: env.SUPABASE_URL,
            supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY,
          });
        }
        if (url.pathname === '/api/staff' && request.method === 'POST') return await createStaff(request, env, deps);
        const m = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
        if (m && request.method === 'DELETE') return await deleteStaff(request, env, deps, decodeURIComponent(m[1]));
        return json({ error: 'Not found.' }, 404);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error(e && e.message);
        return json({ error: 'Something went wrong. Try again.' }, 500);
      }
    },
    async scheduled(event, env, ctx) {
      ctx.waitUntil(purge(env, deps).catch((e) => console.error('clean-up failed', e && e.message)));
    },
  };
}

export default createHandler({ verifyToken, createClerkClient, fetch: (...a) => fetch(...a) });
