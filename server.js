'use strict';
/**
 * Telegram channel -> channel copier.
 * - Zero dependencies (Node 18+).
 * - Controlled over HTTP from a GitHub Pages panel (CORS-locked + PIN).
 * - Crash-safe: progress saved after every message (local file) and
 *   every few messages to Upstash Redis (optional, survives Render restarts).
 * - Respects Telegram limits: paced requests, honours retry_after on 429.
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// ---------- config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const PIN = process.env.PIN;
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT) || 3000;
const BASE_DELAY = Math.max(500, Number(process.env.DELAY_MS) || 3000); // ms between copies
const MAX_DELAY = 15000;
const SKIP_DELAY = 400; // missing/deleted ids are cheap, go faster
const STATE_FILE = process.env.STATE_FILE || './state.json';
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UP_KEY = process.env.UPSTASH_KEY || 'copybot:state';
const TG_API = process.env.TG_API || 'https://api.telegram.org';

if (!BOT_TOKEN || !PIN || !ALLOWED_ORIGIN) {
  console.error('Missing env: BOT_TOKEN, PIN and ALLOWED_ORIGIN are all required.');
  process.exit(1);
}
if (!/^\d{4}$/.test(PIN)) {
  console.error('PIN must be exactly 4 digits (e.g. 4827).');
  process.exit(1);
}

// ---------- tiny helpers ----------
const now = () => Date.now();
let stopRequested = false;   // user pressed Stop
let shuttingDown = false;    // Render is stopping the container
const sleep = async (ms) => {
  const end = now() + ms;
  while (now() < end && !stopRequested && !shuttingDown) {
    await new Promise((r) => setTimeout(r, Math.min(1000, end - now())));
  }
};

const logs = [];
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 60) logs.shift();
}

class Fatal extends Error {}

// ---------- state + persistence ----------
let state = {
  status: 'idle', // idle | running | stopped | done | error
  source: null, dest: null, from: null, to: null,
  next: null, copied: 0, skipped: 0,
  lastError: null, startedAt: null, updatedAt: 0,
};

function saveLocal() {
  try {
    state.updatedAt = now();
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE); // atomic: never a half-written file
  } catch (e) { log('local save failed: ' + e.message); }
}

async function upstash(cmd) {
  const r = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

let lastRemoteAt = 0, sinceRemote = 0;
async function saveRemote() {
  if (!UP_URL || !UP_TOKEN) return;
  lastRemoteAt = now(); sinceRemote = 0;
  try { await upstash(['SET', UP_KEY, JSON.stringify(state)]); }
  catch (e) { log('remote save failed: ' + e.message); }
}

function persist(force) {
  saveLocal();
  sinceRemote++;
  if (force || sinceRemote >= 5 || now() - lastRemoteAt > 20000) saveRemote();
}

async function loadState() {
  let local = null, remote = null;
  try { local = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await upstash(['GET', UP_KEY]);
      if (r && r.result) remote = JSON.parse(r.result);
    } catch (e) { log('remote load failed: ' + e.message); }
  }
  const best = [local, remote].filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (best) { state = { ...state, ...best }; log(`state loaded: ${state.status}, next=${state.next}`); }
}

// ---------- Telegram ----------
async function tg(method, params) {
  const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(30000),
  });
  return r.json(); // Telegram always replies JSON, even on errors
}

// pacing + adaptive slow-down
let delay = BASE_DELAY, lastCallAt = 0, okStreak = 0, lastWasSkip = false;
async function pace() {
  const need = (lastWasSkip ? Math.min(SKIP_DELAY, delay) : delay) - (now() - lastCallAt);
  if (need > 0) await sleep(need);
  lastCallAt = now();
}

const SKIP_RE = /message to copy not found|message can't be copied|message_id_invalid|message not found/i;
const FATAL_RE = /chat not found|not enough rights|forbidden|kicked|need administrator|write_forbidden|bot was blocked|peer_id_invalid|have no rights|bot is not a member|chat_admin_required|channel_private/i;

async function copyOne(id) {
  let fails = 0;
  for (;;) {
    if (stopRequested || shuttingDown) return 'stopped';
    await pace();
    if (stopRequested || shuttingDown) return 'stopped';
    let res;
    try {
      res = await tg('copyMessage', { chat_id: state.dest, from_chat_id: state.source, message_id: id });
    } catch (e) { // network down, timeout, bad JSON ...
      fails++;
      const w = Math.min(60000, 2000 * 2 ** Math.min(fails, 5));
      log(`network error (${e.message}); retry in ${w / 1000}s`);
      await sleep(w);
      continue;
    }
    if (res.ok) {
      lastWasSkip = false;
      if (++okStreak >= 100) { okStreak = 0; delay = Math.max(BASE_DELAY, Math.round(delay * 0.9)); }
      return 'copied';
    }
    const code = res.error_code, desc = res.description || '';
    if (code === 429) {
      const ra = (res.parameters && res.parameters.retry_after) || 30;
      okStreak = 0;
      delay = Math.min(MAX_DELAY, Math.round(delay * 1.3) + 200);
      log(`429 flood limit: waiting ${ra + 1}s, then retrying id ${id} (delay now ${delay}ms)`);
      persist(true);
      await sleep((ra + 1) * 1000);
      continue;
    }
    if (code >= 500) {
      fails++;
      const w = Math.min(60000, 2000 * 2 ** Math.min(fails, 5));
      log(`Telegram ${code} (${desc}); retry in ${w / 1000}s`);
      await sleep(w);
      continue;
    }
    if (code === 400 && SKIP_RE.test(desc)) { lastWasSkip = true; return 'skipped'; }
    if (code === 401 || code === 403 || code === 404 || FATAL_RE.test(desc)) {
      throw new Fatal(`${code} ${desc}`);
    }
    // any other 400: don't hang the whole job on one odd message
    log(`skipping id ${id}: ${code} ${desc}`);
    lastWasSkip = true;
    return 'skipped';
  }
}

// ---------- job runner ----------
let running = false;
async function runJob() {
  if (running) return;
  running = true; stopRequested = false;
  log(`job running: ${state.source} -> ${state.dest}, ids ${state.next}..${state.to}`);
  try {
    state.status = 'running'; state.lastError = null; persist(true);
    while (state.next <= state.to) {
      const r = await copyOne(state.next);
      if (r === 'stopped') {
        if (stopRequested) state.status = 'stopped'; // shutdown keeps 'running' => auto-resume on boot
        break;
      }
      if (r === 'copied') state.copied++; else state.skipped++;
      state.next++;
      persist(false);
    }
    if (state.next > state.to) { state.status = 'done'; log(`done. copied=${state.copied} skipped=${state.skipped}`); }
  } catch (e) {
    state.status = 'error'; state.lastError = e.message;
    log('STOPPED with error: ' + e.message);
  } finally {
    running = false; persist(true);
  }
}

// watchdog: if a job should be running but isn't (unexpected bug), restart it
setInterval(() => {
  if (state.status === 'running' && !running && !shuttingDown) {
    log('watchdog: restarting job'); runJob();
  }
}, 30000).unref();

// ---------- auth ----------
let fails = 0, lockedUntil = 0, lockLevel = 0;
function checkPin(pin) {
  const t = now();
  if (t < lockedUntil) return { ok: false, locked: Math.ceil((lockedUntil - t) / 1000) };
  const a = Buffer.from(String(pin == null ? '' : pin)), b = Buffer.from(PIN);
  const good = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (good) { fails = 0; lockLevel = 0; return { ok: true }; }
  if (++fails >= 5) { // 5 wrong PINs -> lock 15min, doubling each time (max 24h)
    fails = 0; lockLevel++;
    lockedUntil = t + Math.min(24 * 3600e3, 15 * 60e3 * 2 ** (lockLevel - 1));
  }
  return { ok: false };
}

// ---------- HTTP ----------
function send(res, code, obj, origin) {
  const h = { 'Content-Type': 'application/json' };
  if (origin && origin === ALLOWED_ORIGIN) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Vary'] = 'Origin';
  }
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 10000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const snapshot = () => ({ ...state, running, delayMs: delay, logs: logs.slice(-25) });

let botId = null;
async function verifyChats(source, dest) {
  if (!botId) {
    const me = await tg('getMe');
    if (!me.ok) throw new Error('Bot token rejected by Telegram: ' + me.description);
    botId = me.result.id;
  }
  const s = await tg('getChatMember', { chat_id: source, user_id: botId });
  if (!s.ok) throw new Error('Source channel: ' + s.description + ' (add the bot to the source channel as admin)');
  if (['left', 'kicked'].includes(s.result.status)) throw new Error('Bot is not in the source channel');
  const d = await tg('getChatMember', { chat_id: dest, user_id: botId });
  if (!d.ok) throw new Error('Destination channel: ' + d.description);
  if (!['administrator', 'creator'].includes(d.result.status)) throw new Error('Bot must be ADMIN in the destination channel');
  if (d.result.status === 'administrator' && d.result.can_post_messages === false) {
    throw new Error('Bot is admin in destination but lacks the "Post messages" permission');
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const path = (req.url || '').split('?')[0];

  if (path === '/health' || path === '/') { // for UptimeRobot, no secrets
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (req.method === 'OPTIONS') { // CORS preflight
    if (origin !== ALLOWED_ORIGIN) { res.writeHead(403); return res.end(); }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    return res.end();
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (origin !== ALLOWED_ORIGIN) return send(res, 403, { error: 'Forbidden origin' });

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'Bad JSON' }, origin); }

  const auth = checkPin(body.pin);
  if (!auth.ok) {
    if (auth.locked) return send(res, 429, { error: `Too many wrong PINs. Locked for ${auth.locked}s.` }, origin);
    return send(res, 401, { error: 'Wrong PIN' }, origin);
  }

  try {
    if (path === '/status') return send(res, 200, snapshot(), origin);

    if (path === '/stop') {
      stopRequested = true;
      if (!running && state.status === 'running') { state.status = 'stopped'; persist(true); }
      return send(res, 200, { ok: true }, origin);
    }

    if (path === '/resume') {
      if (running) return send(res, 409, { error: 'Already running' }, origin);
      if (!state.source || state.next == null) return send(res, 400, { error: 'Nothing to resume' }, origin);
      if (state.next > state.to) return send(res, 400, { error: 'Job already finished' }, origin);
      runJob();
      return send(res, 200, { ok: true }, origin);
    }

    if (path === '/start') {
      if (running) return send(res, 409, { error: 'A job is already running. Stop it first.' }, origin);
      const idRe = /^-\d{6,}$/;
      const source = String(body.source || '').trim(), dest = String(body.dest || '').trim();
      const from = Number(body.from), to = Number(body.to);
      if (!idRe.test(source) || !idRe.test(dest)) return send(res, 400, { error: 'Channel IDs must look like -1001234567890' }, origin);
      if (source === dest) return send(res, 400, { error: 'Source and destination are the same' }, origin);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        return send(res, 400, { error: 'Message IDs: whole numbers, start >= 1 and end >= start' }, origin);
      }
      await verifyChats(source, dest);
      state = {
        status: 'running', source, dest, from, to, next: from,
        copied: 0, skipped: 0, lastError: null, startedAt: now(), updatedAt: now(),
      };
      delay = BASE_DELAY; okStreak = 0; lastWasSkip = false;
      persist(true);
      runJob();
      return send(res, 200, { ok: true }, origin);
    }

    return send(res, 404, { error: 'Not found' }, origin);
  } catch (e) {
    return send(res, 400, { error: e.message }, origin);
  }
});

// ---------- boot / shutdown ----------
process.on('uncaughtException', (e) => log('uncaughtException: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack || e)));

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig}: saving progress and exiting`);
  for (let i = 0; i < 80 && running; i++) await new Promise((r) => setTimeout(r, 100));
  saveLocal();
  await saveRemote();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  await loadState();
  server.listen(PORT, '0.0.0.0', () => log(`listening on ${PORT}`));
  if (state.status === 'running') { log('resuming interrupted job'); runJob(); }
})();
