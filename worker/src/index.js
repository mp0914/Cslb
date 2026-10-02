// cslb-api — study progress sync for the CSLB practice portal (c33.website).
//
// The site itself stays on GitHub Pages; this worker is only the database in
// front of D1. The browser keeps localStorage as its own source of truth and
// pushes here, so the app still works with no signal.
//
// Merge rule, per question: counters take the max (monotonic, never loses an
// increment), and the state fields follow whichever side answered more
// recently. Attempts are append-only and deduped on a client-generated uid,
// which makes a retried sync idempotent.

import { signJWT, verifyJWT, verifyPassphrase } from './crypto.js';

const USER = 'matt';
const EXAMS = ['c33', 'lawbiz'];

const ALLOWED_ORIGINS = [
  'https://c33.website',
  'https://www.c33.website',
  'http://localhost:3456',
  'http://127.0.0.1:3456',
];

const MAX_PROGRESS_ROWS = 4000;
const MAX_ATTEMPT_ROWS = 500;
const BATCH_SIZE = 100;

function corsHeaders(origin) {
  const h = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders(origin) });
}

async function authed(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.JWT_SECRET);
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function cleanStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// Drop anything malformed rather than failing the whole sync on one bad row.
function cleanProgress(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows.slice(0, MAX_PROGRESS_ROWS)) {
    if (!r || typeof r !== 'object') continue;
    const qid = cleanStr(r.qid, 64);
    const exam = cleanStr(r.exam, 16);
    if (!qid || !EXAMS.includes(exam)) continue;
    out.push({
      qid,
      exam,
      cat: cleanStr(r.cat, 40) || 'unknown',
      seen: clampInt(r.seen, 0, 1e6),
      wrong: clampInt(r.wrong, 0, 1e6),
      streak: clampInt(r.streak, 0, 1e4),
      last_ms: clampInt(r.last_ms, 0, 4e15),
      last_ok: r.last_ok ? 1 : 0,
    });
  }
  return out;
}

function cleanAttempts(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows.slice(0, MAX_ATTEMPT_ROWS)) {
    if (!r || typeof r !== 'object') continue;
    const uid = cleanStr(r.uid, 64);
    const exam = cleanStr(r.exam, 16);
    if (!uid || !EXAMS.includes(exam)) continue;
    out.push({
      uid,
      exam,
      mode: cleanStr(r.mode, 40) || 'all',
      total: clampInt(r.total, 0, 1e4),
      correct: clampInt(r.correct, 0, 1e4),
      ended_ms: clampInt(r.ended_ms, 0, 4e15),
    });
  }
  return out;
}

async function readState(env, exam) {
  const where = exam ? ' AND exam = ?' : '';
  const pArgs = exam ? [USER, exam] : [USER];
  const progress = await env.DB
    .prepare(`SELECT qid,exam,cat,seen,wrong,streak,last_ms,last_ok FROM progress WHERE user_id = ?${where}`)
    .bind(...pArgs).all();
  const attempts = await env.DB
    .prepare(`SELECT uid,exam,mode,total,correct,ended_ms FROM attempts WHERE user_id = ?${where} ORDER BY ended_ms DESC LIMIT 200`)
    .bind(...pArgs).all();
  return { progress: progress.results || [], attempts: attempts.results || [] };
}

async function runBatched(env, statements) {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

const UPSERT_PROGRESS = `
INSERT INTO progress (user_id,qid,exam,cat,seen,wrong,streak,last_ms,last_ok)
VALUES (?,?,?,?,?,?,?,?,?)
ON CONFLICT(user_id,qid) DO UPDATE SET
  cat     = excluded.cat,
  seen    = MAX(progress.seen,  excluded.seen),
  wrong   = MAX(progress.wrong, excluded.wrong),
  streak  = CASE WHEN excluded.last_ms >= progress.last_ms THEN excluded.streak  ELSE progress.streak  END,
  last_ok = CASE WHEN excluded.last_ms >= progress.last_ms THEN excluded.last_ok ELSE progress.last_ok END,
  last_ms = MAX(progress.last_ms, excluded.last_ms)`;

const INSERT_ATTEMPT = `
INSERT INTO attempts (uid,user_id,exam,mode,total,correct,ended_ms)
VALUES (?,?,?,?,?,?,?)
ON CONFLICT(user_id,uid) DO NOTHING`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (path === '/health') return json({ ok: true }, 200, origin);

    if (path === '/login' && request.method === 'POST') {
      if (!env.AUTH_HASH || !env.JWT_SECRET) {
        return json({ error: 'Server not configured' }, 500, origin);
      }
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400, origin); }
      const ok = await verifyPassphrase(String(body && body.passphrase || ''), env.AUTH_HASH);
      if (!ok) return json({ error: 'Wrong passphrase' }, 401, origin);
      return json({ token: await signJWT({ sub: USER }, env.JWT_SECRET) }, 200, origin);
    }

    const user = await authed(request, env);
    if (!user) return json({ error: 'Unauthorized' }, 401, origin);

    const examParam = url.searchParams.get('exam');
    const exam = EXAMS.includes(examParam) ? examParam : null;

    if (path === '/progress' && request.method === 'GET') {
      return json(await readState(env, exam), 200, origin);
    }

    if (path === '/sync' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400, origin); }

      const progress = cleanProgress(body && body.progress);
      const attempts = cleanAttempts(body && body.attempts);

      const statements = [];
      for (const r of progress) {
        statements.push(env.DB.prepare(UPSERT_PROGRESS)
          .bind(USER, r.qid, r.exam, r.cat, r.seen, r.wrong, r.streak, r.last_ms, r.last_ok));
      }
      for (const a of attempts) {
        statements.push(env.DB.prepare(INSERT_ATTEMPT)
          .bind(a.uid, USER, a.exam, a.mode, a.total, a.correct, a.ended_ms));
      }
      if (statements.length) await runBatched(env, statements);

      // Hand back the merged truth so the client can replace its local copy.
      return json(await readState(env, exam), 200, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};
