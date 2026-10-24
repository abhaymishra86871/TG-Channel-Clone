'use strict';
/**
 * Telegram channel -> channel copier.
 *  - Two modes, chosen per run from the control panel:
 *      bot  : Bot API token  (bot must be admin in source AND destination)
 *      user : your own account session (admin only needed in destination)
 *  - Controlled over HTTP from a GitHub Pages panel (CORS-locked + 4-digit PIN).
 *  - Crash-safe: progress saved after every message (local file) and every few
 *    messages to Upstash Redis (optional). Credentials are encrypted at rest with ENC_KEY.
 *  - Respects Telegram limits: paced requests, honours flood-wait / retry_after.
 * The user mode needs the `telegram` (GramJS) package; bot mode needs no dependency.
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// ---------- config ----------
const ENV_BOT_TOKEN = process.env.BOT_TOKEN || ''; // optional default for bot mode
const PIN = process.env.PIN;
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT) || 3000;
const BASE_DELAY = Math.max(500, Number(process.env.DELAY_MS) || 3000);
const MAX_DELAY = 15000;
const SKIP_DELAY = 400;
const STATE_FILE = process.env.STATE_FILE || './state.json';
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UP_KEY = process.env.UPSTASH_KEY || 'copybot:state';
const TG_API = process.env.TG_API || 'https://api.telegram.org';
const ENC_KEY = process.env.ENC_KEY || '';

if (!PIN || !ALLOWED_ORIGIN) {
  console.error('Missing env: PIN and ALLOWED_ORIGIN are required.');
  process.exit(1);
}
if (!/^\d{4}$/.test(PIN)) {
  console.error('PIN must be exactly 4 digits (e.g. 4827).');
  process.exit(1);
}
if (ENC_KEY && ENC_KEY.length < 12) {
  console.error('ENC_KEY must be at least 12 characters (use a long random string).');
  process.exit(1);
}
const encKey = ENC_KEY ? crypto.scryptSync(ENC_KEY, 'tgcopier-v1', 32) : null;

// ---------- encryption of stored credentials ----------
function enc(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function dec(s) {
  const b = Buffer.from(s, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
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

const nap = (ms) => new Promise((r) => setTimeout(r, ms)); // plain sleep, not interrupted by Stop
const secrets = new Set(); // never let these reach the logs
function addSecrets(c) {
  [c && c.token, c && c.session, c && c.apiHash].forEach((s) => { if (s && String(s).length > 8) secrets.add(String(s)); });
}
const logs = [];
function log(msg) {
  let m = String(msg);
  for (const s of secrets) m = m.split(s).join('***');
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 60) logs.shift();
}

class Fatal extends Error {}
const errText = (e) => String((e && (e.errorMessage || e.message)) || e);

// ---------- state + persistence ----------
let state = {
  status: 'idle', // idle | running | stopped | done | error
  mode: null, // bot | user
  source: null, dest: null, from: null, to: null,
  sourceTitle: null, destTitle: null, accountName: null,
  next: null, copied: 0, skipped: 0,
  lastError: null, startedAt: null, updatedAt: 0,
  srcOpt: null, dstOpt: null, // {group, forum, topic}
  baseDelay: null, notifyUserId: null, notifySaved: false, progressMsgId: null,
  creds: null, // never sent to the browser
};

function serialize() {
  const { creds, ...rest } = state;
  const out = { ...rest };
  if (creds) { if (encKey) out.credsEnc = enc(creds); else out.creds = creds; }
  return JSON.stringify(out);
}
function hydrate(o) {
  if (o.credsEnc) {
    if (!encKey) throw new Error('state has encrypted credentials but ENC_KEY is not set');
    o.creds = dec(o.credsEnc);
    delete o.credsEnc;
  }
  return o;
}

function saveLocal() {
  if (state.status === 'done') return; // a finished job leaves nothing on disk
  try {
    state.updatedAt = now();
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, serialize(), { mode: 0o600 });
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
  if (!UP_URL || !UP_TOKEN || state.status === 'done') return;
  lastRemoteAt = now(); sinceRemote = 0;
  try { await upstash(['SET', UP_KEY, serialize()]); }
  catch (e) { log('remote save failed: ' + e.message); }
}

function persist(force) {
  saveLocal();
  sinceRemote++;
  if (force || sinceRemote >= 5 || now() - lastRemoteAt > 20000) saveRemote();
}

async function loadState() {
  const cands = [];
  try { cands.push(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch {}
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await upstash(['GET', UP_KEY]);
      if (r && r.result) cands.push(JSON.parse(r.result));
    } catch (e) { log('remote load failed: ' + e.message); }
  }
  cands.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const best = cands[0];
  if (!best) return;
  try { state = { ...state, ...hydrate(best) }; }
  catch (e) {
    delete best.credsEnc; state = { ...state, ...best, creds: null };
    state.status = 'error';
    state.lastError = 'Saved credentials cannot be decrypted (ENC_KEY changed?). Start a new job.';
  }
  addSecrets(state.creds);
  log(`state loaded: ${state.status}, next=${state.next}`);
}

// ---------- pacing ----------
let baseDelay = BASE_DELAY; // per job, chosen on the panel
let delay = BASE_DELAY, lastCallAt = 0, okStreak = 0, lastWasSkip = false;
async function pace() {
  const need = (lastWasSkip ? Math.min(driver && driver.mode === 'user' ? 1000 : SKIP_DELAY, delay) : delay) - (now() - lastCallAt);
  if (need > 0) await sleep(need);
  lastCallAt = now();
}

// ---------- driver: Bot API ----------
const SKIP_RE = /message to copy not found|message can't be copied|message_id_invalid|message not found/i;
const FATAL_RE = /chat not found|not enough rights|forbidden|kicked|need administrator|write_forbidden|bot was blocked|peer_id_invalid|have no rights|bot is not a member|chat_admin_required|channel_private|thread not found|topic_closed|topic_deleted|topic_id_invalid/i;

function botDriver(creds) {
  const call = async (method, params) => {
    const r = await fetch(`${TG_API}/bot${creds.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(30000),
    });
    return r.json(); // Telegram always replies JSON, even on errors
  };
  return {
    mode: 'bot',
    call,
    async init() {},
    async copy(id) {
      let res;
      const params = { chat_id: state.dest, from_chat_id: state.source, message_id: id };
      if (state.dstOpt && state.dstOpt.topic) params.message_thread_id = state.dstOpt.topic; // send into a forum topic
      try { res = await call('copyMessage', params); }
      catch (e) { return { kind: 'transient', msg: e.message }; }
      if (res.ok) return { kind: 'copied' };
      const code = res.error_code, desc = res.description || '';
      if (code === 429) return { kind: 'flood', seconds: (res.parameters && res.parameters.retry_after) || 30 };
      if (code >= 500) return { kind: 'transient', msg: `Telegram ${code} ${desc}` };
      if (code === 400 && SKIP_RE.test(desc)) return { kind: 'skipped' };
      if (code === 401 || code === 403 || code === 404 || FATAL_RE.test(desc)) return { kind: 'fatal', msg: `${code} ${desc}` };
      return { kind: 'skipped', msg: `${code} ${desc}` }; // odd message: don't hang the whole job
    },
    // progress message to a Telegram user who has already pressed Start on the bot
    async notify(text) {
      const uid = state.notifyUserId;
      if (!uid) return;
      if (state.progressMsgId) {
        const r = await call('editMessageText', { chat_id: uid, message_id: state.progressMsgId, text });
        const d = r.description || '';
        if (r.ok || /not modified/i.test(d)) return;
        if (!/message to edit not found|can't be edited|message_id_invalid/i.test(d)) throw new Error(d);
      }
      const r = await call('sendMessage', { chat_id: uid, text, disable_notification: true });
      if (!r.ok) throw new Error(r.description || 'sendMessage failed');
      state.progressMsgId = r.result.message_id;
    },
    async clearNotify() {
      const uid = state.notifyUserId;
      if (!uid || !state.progressMsgId) return;
      try { await call('deleteMessage', { chat_id: uid, message_id: state.progressMsgId }); } catch {}
      state.progressMsgId = null;
    },
    async close() {},
  };
}

// ---------- driver: user account (GramJS / MTProto) ----------
function gram() {
  try { return { ...require('telegram'), Sessions: require('telegram/sessions'), Helpers: require('telegram/Helpers') }; }
  catch (e) { throw new Fatal('The "telegram" npm package is not installed on the server (run npm install).'); }
}

async function connectUser(creds) {
  const g = gram();
  const client = new g.TelegramClient(new g.Sessions.StringSession(creds.session), Number(creds.apiId), creds.apiHash, {
    connectionRetries: 5,
    floodSleepThreshold: 0, // we handle flood waits ourselves
  });
  try { client.setLogLevel('error'); } catch {}
  await client.connect();
  let authed = true;
  try { authed = typeof client.checkAuthorization === 'function' ? await client.checkAuthorization() : true; } catch {}
  if (!authed) { try { await client.disconnect(); } catch {} throw new Fatal('Session is not logged in or was revoked. Generate a new session.'); }
  return client;
}

async function findDialogs(client, ids) {
  const want = new Set(ids.map(String)), found = {};
  for await (const d of client.iterDialogs({ limit: 3000 })) {
    const id = String(d.id);
    if (want.has(id)) {
      found[id] = { title: d.title || (d.entity && d.entity.title) || id, input: d.inputEntity, entity: d.entity };
      if (Object.keys(found).length === want.size) break;
    }
  }
  return found;
}

async function userRole(client, chat) {
  const g = gram();
  const ent = chat.entity || {};
  const isGroup = ent.className === 'Chat' || !!ent.megagroup;
  const bannedSend = !!(ent.defaultBannedRights && ent.defaultBannedRights.sendMessages);
  if (ent.className === 'Chat') { // basic group: no channel-participant API
    const role = ent.creator ? 'creator' : (ent.adminRights ? 'admin' : 'member');
    return { role, canPost: role !== 'member' || !bannedSend };
  }
  try {
    const r = await client.invoke(new g.Api.channels.GetParticipant({ channel: chat.input, participant: new g.Api.InputPeerSelf() }));
    const p = r.participant, cls = p && p.className;
    if (cls === 'ChannelParticipantCreator') return { role: 'creator', canPost: true };
    if (cls === 'ChannelParticipantAdmin') {
      const rights = p.adminRights || {};
      return { role: 'admin', canPost: !!rights.postMessages || !!ent.megagroup };
    }
    if (cls === 'ChannelParticipantBanned') { // restricted member
      const br = p.bannedRights || {};
      return { role: p.left ? 'none' : 'restricted', canPost: !p.left && !br.sendMessages };
    }
    return { role: 'member', canPost: isGroup && !bannedSend };
  } catch (e) {
    if (/USER_NOT_PARTICIPANT/.test(errText(e))) return { role: 'none', canPost: false };
    throw e;
  }
}

// topic a message belongs to in a forum group (1 = General)
function topicOfMsg(m) {
  const rt = m && m.replyTo;
  if (rt && rt.forumTopic) return Number(rt.replyToTopId || rt.replyToMsgId) || 1;
  return 1;
}

function mapUserError(e) {
  const m = errText(e);
  if ((e && Number(e.seconds) > 0) || /FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT/.test(m)) {
    return { kind: 'flood', seconds: Number(e && e.seconds) || Number((m.match(/(\d+)/) || [])[1]) || 60 };
  }
  if (/MESSAGE_ID_INVALID|MESSAGE_ID_REQUIRED|MSG_ID_INVALID/.test(m)) return { kind: 'skipped' };
  if (/CHAT_FORWARDS_RESTRICTED|CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|TOPIC_[A-Z_]+|CHAT_SEND_.*FORBIDDEN/.test(m)) {
    return { kind: 'fatal', msg: m };
  }
  if (e && e.errorMessage) return { kind: 'skipped', msg: m }; // unknown RPC error on one message
  return { kind: 'transient', msg: m }; // network / disconnected
}

function userDriver(creds) {
  let client = null, src = null, dst = null;
  const topicCache = new Map(); // id -> topic (0 = deleted), filled 100 ids at a time
  const self = {
    mode: 'user',
    session: creds.session,
    get client() { return client; },
    async init() {
      if (client) await self.close();
      client = await connectUser(creds);
      topicCache.clear();
      const f = await findDialogs(client, [state.source, state.dest]);
      if (!f[state.source]) throw new Fatal('Source channel not found in this account (join it first).');
      if (!f[state.dest]) throw new Fatal('Destination channel not found in this account.');
      src = f[state.source].input; dst = f[state.dest].input;
    },
    // true = skip this id without any pause (deleted, or belongs to another topic than the one wanted)
    async preSkip(id) {
      const want = state.srcOpt && state.srcOpt.topic;
      if (!want || !client) return false;
      if (!topicCache.has(id)) {
        const ids = [];
        for (let i = id; i <= Math.min(state.to, id + 99); i++) ids.push(i);
        const msgs = await client.getMessages(src, { ids });
        // match results by message id (not by list position): deleted ids may be missing or shifted
        const byId = new Map();
        for (const m of msgs || []) if (m && m.className !== 'MessageEmpty' && m.id != null) byId.set(Number(m.id), m);
        ids.forEach((x) => { const m = byId.get(x); topicCache.set(x, m ? topicOfMsg(m) : 0); });
      }
      const t = topicCache.get(id); topicCache.delete(id);
      return t !== want;
    },
    async copy(id) {
      const g = gram();
      try {
        const fwd = {
          fromPeer: src, toPeer: dst, id: [id],
          randomId: [g.Helpers.generateRandomBigInt()],
          dropAuthor: true, // no "Forwarded from" header
        };
        if (state.dstOpt && state.dstOpt.topic) fwd.topMsgId = state.dstOpt.topic; // into a forum topic
        const res = await client.invoke(new g.Api.messages.ForwardMessages(fwd));
        const ups = (res && res.updates) || [];
        const ok = ups.some((u) => u && ['UpdateMessageID', 'UpdateNewChannelMessage', 'UpdateNewMessage'].includes(u.className));
        return ok ? { kind: 'copied' } : { kind: 'skipped' };
      } catch (e) { return mapUserError(e); }
    },
    // progress message in the account's own "Saved Messages"
    async notify(text) {
      if (!state.notifySaved || !client) return;
      if (state.progressMsgId) {
        try { await client.editMessage('me', { message: state.progressMsgId, text }); return; }
        catch (e) {
          const m = errText(e);
          if (/MESSAGE_NOT_MODIFIED/.test(m)) return;
          if (!/MESSAGE_ID_INVALID|MESSAGE_NOT_FOUND|MESSAGE_EDIT_TIME_EXPIRED/.test(m)) throw e;
        }
      }
      const msg = await client.sendMessage('me', { message: text, silent: true });
      state.progressMsgId = msg.id;
    },
    async clearNotify() {
      if (!state.progressMsgId || !client) return;
      try { await client.deleteMessages('me', [state.progressMsgId], { revoke: true }); } catch {}
      state.progressMsgId = null;
    },
    async close() {
      const c = client; client = null;
      if (c) { try { await c.disconnect(); } catch {} try { if (c.destroy) await c.destroy(); } catch {} }
    },
  };
  return self;
}

// ---------- copy loop ----------
let driver = null;

// ----- progress message (edited in place, never spammed) -----
const withTimeout = (p, ms = 8000) => Promise.race([Promise.resolve(p), nap(ms)]);
function progressText(extra) {
  const total = state.to - state.from + 1;
  const done = Math.max(0, Math.min(total, state.next - state.from));
  const pct = total > 0 ? ((done / total) * 100).toFixed(1) : '0.0';
  return [
    '📋 Channel copy',
    `${state.sourceTitle || state.source} → ${state.destTitle || state.dest}`,
    `Now at message ${Math.min(state.next, state.to)}  (range ${state.from}–${state.to})`,
    `Done: ${pct}%  ·  copied ${state.copied}, skipped ${state.skipped}`,
    extra || 'Status: running',
    `Updated ${new Date().toISOString().slice(11, 19)} UTC`,
  ].join('\n');
}
let notifying = false, lastNotify = 0, lastNotifyErr = 0;
function notify(force, extra) {
  if (!driver || !driver.notify || notifying) return Promise.resolve();
  if (!force && now() - lastNotify < 15000) return Promise.resolve();
  lastNotify = now(); notifying = true;
  const before = state.progressMsgId;
  return Promise.resolve()
    .then(() => driver.notify(progressText(extra)))
    .then(() => { if (state.progressMsgId !== before) persist(true); })
    .catch((e) => { if (now() - lastNotifyErr > 60000) { lastNotifyErr = now(); log('progress message failed: ' + errText(e)); } })
    .finally(() => { notifying = false; });
}
async function notifyFinal(extra) { // wait for any in-flight update, then send the last one
  for (let i = 0; i < 50 && notifying; i++) await nap(100);
  await withTimeout(notify(true, extra));
}

// a successfully finished job leaves nothing behind: no credentials, no state file, no Redis key
async function finishCleanup() {
  state.creds = null; state.progressMsgId = null; state.notifyUserId = null; state.notifySaved = false;
  secrets.clear();
  try { fs.unlinkSync(STATE_FILE); } catch {}
  if (UP_URL && UP_TOKEN) { try { await upstash(['DEL', UP_KEY]); } catch (e) { log('redis cleanup failed: ' + e.message); } }
}

async function copyOne(id) {
  let fails = 0;
  if (stopRequested || shuttingDown) return 'stopped';
  if (driver.preSkip) {
    // topic filter: if the lookup fails we must NOT copy blindly (it could be another topic's message), so retry
    for (let t = 0; ; t++) {
      try { if (await driver.preSkip(id)) return 'skipped'; break; }
      catch (e) {
        const m = mapUserError(e);
        if (m.kind === 'fatal') throw new Fatal(m.msg);
        const w = m.kind === 'flood' ? (m.seconds + 1) * 1000 : Math.min(60000, 2000 * 2 ** Math.min(t + 1, 5));
        log(`topic lookup failed (${errText(e)}); retry in ${Math.round(w / 1000)}s`);
        await sleep(w);
        if (stopRequested || shuttingDown) return 'stopped';
      }
    }
  }
  for (;;) {
    if (stopRequested || shuttingDown) return 'stopped';
    await pace();
    if (stopRequested || shuttingDown) return 'stopped';
    const r = await driver.copy(id);
    if (r.kind === 'copied') {
      lastWasSkip = false;
      if (++okStreak >= 100) { okStreak = 0; delay = Math.max(baseDelay, Math.round(delay * 0.9)); }
      return 'copied';
    }
    if (r.kind === 'skipped') {
      if (r.msg) log(`skipping id ${id}: ${r.msg}`);
      lastWasSkip = true;
      return 'skipped';
    }
    if (r.kind === 'flood') {
      okStreak = 0;
      delay = Math.min(MAX_DELAY, Math.round(delay * 1.3) + 200);
      log(`flood limit: waiting ${r.seconds + 1}s, then retrying id ${id} (delay now ${delay}ms)`);
      persist(true);
      notify(true, `⏳ Telegram flood limit: waiting ${r.seconds + 1}s`);
      await sleep((r.seconds + 1) * 1000);
      continue;
    }
    if (r.kind === 'transient') {
      fails++;
      const w = Math.min(60000, 2000 * 2 ** Math.min(fails, 5));
      log(`temporary error (${r.msg}); retry in ${w / 1000}s`);
      await sleep(w);
      if (driver.mode === 'user' && fails % 5 === 0) {
        try { await driver.init(); log('reconnected'); } catch (e) { if (e instanceof Fatal) throw e; }
      }
      continue;
    }
    throw new Fatal(r.msg); // fatal
  }
}

let running = false;
async function runJob() {
  if (running) return;
  running = true; stopRequested = false;
  try {
    if (!state.creds) throw new Fatal('No saved credentials. Start a new job.');
    addSecrets(state.creds);
    baseDelay = state.baseDelay || BASE_DELAY; delay = baseDelay; okStreak = 0; lastWasSkip = false; lastNotify = 0;
    driver = state.creds.mode === 'user' ? userDriver(state.creds) : botDriver(state.creds);
    log(`job running (${state.creds.mode}): ${state.source} -> ${state.dest}, ids ${state.next}..${state.to}`);
    state.status = 'running'; state.lastError = null; persist(true);
    for (;;) { // connect (with retry for network problems)
      try { await driver.init(); break; }
      catch (e) {
        if (e instanceof Fatal) throw e;
        log('connect failed: ' + errText(e) + ' - retrying in 15s');
        await sleep(15000);
        if (stopRequested || shuttingDown) break;
      }
    }
    while (state.next <= state.to) {
      const r = await copyOne(state.next);
      if (r === 'stopped') {
        if (stopRequested) state.status = 'stopped'; // shutdown keeps 'running' => auto-resume on boot
        break;
      }
      if (r === 'copied') state.copied++; else state.skipped++;
      state.next++;
      persist(false);
      notify(false);
    }
    if (state.next > state.to) { state.status = 'done'; log(`done. copied=${state.copied} skipped=${state.skipped}`); }
  } catch (e) {
    state.status = 'error'; state.lastError = errText(e);
    log('STOPPED with error: ' + errText(e));
  } finally {
    running = false;
    const d = driver;
    try {
      if (d && state.status === 'done') await withTimeout(d.clearNotify && d.clearNotify()); // delete the progress message
      else if (d && state.status === 'stopped') await notifyFinal('⏹ Stopped. Press Resume on the page to continue.');
      else if (d && state.status === 'error') await notifyFinal('❌ Stopped with error: ' + String(state.lastError).slice(0, 300));
    } catch {}
    driver = null;
    if (d) { try { await d.close(); } catch {} }
    if (state.status === 'done') await finishCleanup(); else persist(true);
  }
}

// watchdog: if a job should be running but isn't (unexpected bug), restart it
setInterval(() => {
  if (state.status === 'running' && !running && !shuttingDown) { log('watchdog: restarting job'); runJob(); }
}, 30000).unref();

// ---------- setup check ----------
async function checkBot(token, source, dest, notifyUserId, srcOpt, dstOpt) {
  const drv = botDriver({ token });
  const me = await drv.call('getMe');
  if (!me.ok) throw new Error('Bot token rejected by Telegram: ' + (me.description || 'invalid'));
  const account = { name: me.result.first_name, username: me.result.username ? '@' + me.result.username : '', id: me.result.id };
  const one = async (id, needPost, opt) => {
    const o = { id, title: null, ok: false, role: null, kind: null, forum: false, note: '' };
    const c = await drv.call('getChat', { chat_id: id });
    if (!c.ok) { o.note = c.description || 'cannot access'; return o; }
    o.title = c.result.title || String(id);
    const isGroup = c.result.type !== 'channel';
    o.kind = isGroup ? 'group' : 'channel'; o.forum = !!c.result.is_forum;
    if (opt.group !== isGroup) { o.note = isGroup ? 'This is a group, not a channel. Tick "is a group".' : 'This is a channel, not a group. Untick "is a group".'; return o; }
    if (opt.forum && !o.forum) { o.note = 'Topics are not enabled in this group.'; return o; }
    const m = await drv.call('getChatMember', { chat_id: id, user_id: me.result.id });
    if (!m.ok) { o.note = m.description || 'cannot read membership'; return o; }
    const st = m.result.status; o.role = st;
    if (needPost) {
      if (isGroup) {
        const canSendDefault = !(c.result.permissions && c.result.permissions.can_send_messages === false);
        o.ok = st === 'creator' || st === 'administrator' || (st === 'member' && canSendDefault) || (st === 'restricted' && m.result.can_send_messages === true);
        if (!o.ok) o.note = 'Bot cannot post in this group (not a member, or muted).';
      } else if (st === 'creator') o.ok = true;
      else if (st === 'administrator') { o.ok = m.result.can_post_messages !== false; if (!o.ok) o.note = 'Admin, but "Post messages" is off'; }
      else o.note = 'Bot must be ADMIN here';
      if (o.ok && o.forum && !opt.topic) o.note = 'Topics are on: messages will go to the General topic.';
    } else {
      o.ok = ['creator', 'administrator', 'member'].includes(st);
      if (!o.ok) o.note = isGroup ? 'Bot is not in this group (add it)' : 'Bot is not in this channel (add it as admin)';
    }
    return o;
  };
  const out = { account, source: await one(source, false, srcOpt), dest: await one(dest, true, dstOpt) };
  if (notifyUserId) {
    const u = await drv.call('getChat', { chat_id: notifyUserId });
    out.notify = u.ok
      ? { ok: true, name: [u.result.first_name, u.result.last_name].filter(Boolean).join(' ') || String(notifyUserId), note: '' }
      : { ok: false, name: String(notifyUserId), note: 'Bot cannot message this user. Open the bot in Telegram and press Start first (or check the ID).' };
  }
  return out;
}

async function checkUser(creds, source, dest, srcOpt, dstOpt) {
  // reuse the running job's connection if it is the same session (avoid two connections)
  const reuse = driver && driver.mode === 'user' && driver.session === creds.session && driver.client;
  const client = reuse ? driver.client : await connectUser(creds);
  try {
    const me = await client.getMe();
    const account = {
      name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || String(me.id),
      username: me.username ? '@' + me.username : '', id: String(me.id),
    };
    const f = await findDialogs(client, [source, dest]);
    const one = async (id, needPost, opt) => {
      const o = { id, title: null, ok: false, role: null, kind: null, forum: false, note: '' };
      const chat = f[id];
      if (!chat) { o.note = 'This account has not joined this chat (or the ID is wrong)'; return o; }
      o.title = chat.title;
      const ent = chat.entity || {};
      if (ent.className) {
        const isGroup = ent.className === 'Chat' || !!ent.megagroup;
        o.kind = isGroup ? 'group' : 'channel'; o.forum = !!ent.forum;
        if (opt.group !== isGroup) { o.note = isGroup ? 'This is a group, not a channel. Tick "is a group".' : 'This is a channel, not a group. Untick "is a group".'; return o; }
        if (opt.forum && !o.forum) { o.note = 'Topics are not enabled in this group.'; return o; }
      }
      const r = await userRole(client, chat);
      o.role = r.role;
      if (needPost) {
        o.ok = r.canPost;
        if (!o.ok) o.note = r.role === 'admin' ? 'Admin, but "Post messages" is off' : (o.kind === 'group' ? 'Account cannot post in this group' : 'Account must be ADMIN here');
        else if (o.forum && !opt.topic) o.note = 'Topics are on: messages will go to the General topic.';
      } else o.ok = r.role !== 'none';
      if (!o.ok && !o.note) o.note = 'Account is not in this chat';
      return o;
    };
    return { account, source: await one(source, false, srcOpt), dest: await one(dest, true, dstOpt) };
  } finally {
    if (!reuse) { try { await client.disconnect(); } catch {} try { if (client.destroy) await client.destroy(); } catch {} }
  }
}

const ID_RE = /^-\d{5,}$/;
function parseCreds(body) {
  const mode = body.mode === 'user' ? 'user' : 'bot';
  if (mode === 'bot') {
    const token = String(body.token || ENV_BOT_TOKEN || '').trim();
    if (!/^\d{5,}:[\w-]{20,}$/.test(token)) throw new Error('Enter a valid bot token (looks like 123456:ABC-DEF...)');
    return { mode, token };
  }
  if (!encKey) throw new Error('Set the ENC_KEY environment variable on Render first (needed to store the session safely).');
  const apiId = String(body.apiId || '').trim(), apiHash = String(body.apiHash || '').trim(), session = String(body.session || '').trim();
  if (!/^\d{3,12}$/.test(apiId)) throw new Error('API ID must be a number (from my.telegram.org)');
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) throw new Error('API hash must be 32 hex characters (from my.telegram.org)');
  if (session.length < 20) throw new Error('Enter the session string (use "Generate session")');
  return { mode, apiId, apiHash, session };
}
function parseIds(body) {
  const source = String(body.source || '').trim(), dest = String(body.dest || '').trim();
  if (!ID_RE.test(source) || !ID_RE.test(dest)) throw new Error('Chat IDs must look like -1001234567890');
  if (source === dest) throw new Error('Source and destination are the same');
  const side = (p, label) => {
    const group = !!body[p + 'Group'];
    const forum = group && !!body[p + 'Forum'];
    const raw = String(body[p + 'Topic'] || '').trim();
    let topic = null;
    if (forum && raw) {
      if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1) throw new Error(label + ' topic ID must be a positive number');
      topic = Number(raw);
    }
    return { group, forum, topic };
  };
  const src = side('src', 'Source'), dst = side('dst', 'Destination');
  if (dst.topic === 1) dst.topic = null; // topic 1 is "General": send without a thread id
  return { source, dest, src, dst };
}
// Telegram limits as given: bot -> group 20/min (3 s), bot -> channel/chat 1/s, account 1/s
const minDelayMs = (mode, dstGroup) => (mode === 'user' ? 1000 : dstGroup ? 3000 : 1000);
async function runCheck(body) {
  const creds = parseCreds(body);
  const { source, dest, src, dst } = parseIds(body);
  if (creds.mode === 'bot' && src.topic) throw new Error('Bot mode cannot filter by source topic (it copies every topic in the ID range). Clear the source topic ID or use account mode.');
  const nid = String(body.notifyUserId || '').trim();
  if (creds.mode === 'bot' && nid && !/^\d{5,}$/.test(nid)) throw new Error('Progress user ID must be a number (e.g. 123456789)');
  addSecrets(creds);
  const r = creds.mode === 'bot'
    ? await checkBot(creds.token, source, dest, nid || null, src, dst)
    : await checkUser(creds, source, dest, src, dst);
  if (creds.mode === 'user' && body.notifySaved === true) r.notify = { ok: true, name: 'Saved Messages (your account)', note: '' };
  return { mode: creds.mode, ...r, opts: { src, dst }, ok: r.source.ok && r.dest.ok && (!r.notify || r.notify.ok), creds };
}

// ---------- user-account login (OTP) ----------
let pending = null;
function cancelPending() {
  if (pending) { const c = pending.client; pending = null; try { c.disconnect(); } catch {} }
}
setInterval(() => { if (pending && now() - pending.createdAt > 10 * 60e3) cancelPending(); }, 30000).unref();

const pubPending = (p) => ({ state: p.state, error: p.error, session: p.state === 'done' ? p.session : undefined });
async function waitPending(p, seq, ms = 45000) {
  const end = now() + ms;
  while (p.seq === seq && now() < end) await new Promise((r) => setTimeout(r, 200));
  const out = pubPending(p);
  if (p.state === 'done' || p.state === 'error') { if (pending === p) pending = null; }
  return out;
}

async function sessionStart(body) {
  if (!encKey) throw new Error('Set the ENC_KEY environment variable on Render first (needed to store the session safely).');
  const apiId = String(body.apiId || '').trim(), apiHash = String(body.apiHash || '').trim(), phone =String(body.phone || '').replace(/[\s-]/g, '');
  if (!/^\d{3,12}$/.test(apiId)) throw new Error('API ID must be a number (from my.telegram.org)');
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) throw new Error('API hash must be 32 hex characters');
  if (!/^\+\d{7,15}$/.test(phone)) throw new Error('Phone must include country code, e.g. +919876543210');
  const g = gram();
  cancelPending();
  const client = new g.TelegramClient(new g.Sessions.StringSession(''), Number(apiId), apiHash, { connectionRetries: 3, floodSleepThreshold: 0 });
  try { client.setLogLevel('error'); } catch {}
  const p = { client, state: 'starting', seq: 0, error: null, session: null, lastErr: null, resolveCode: null, resolvePass: null, createdAt: now() };
  pending = p;
  const set = (st, err) => { p.state = st; p.error = err || null; p.seq++; };
  client.start({
    phoneNumber: async () => phone,
    phoneCode: () => new Promise((res) => { p.resolveCode = res; const e = p.lastErr; p.lastErr = null; set('need_code', e); }),
    password: () => new Promise((res) => { p.resolvePass = res; const e = p.lastErr; p.lastErr = null; set('need_password', e); }),
    onError: async (e) => {
      const m = errText(e);
      if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/.test(m)) { p.lastErr = 'Wrong code, try again'; return false; }
      if (/PASSWORD_HASH_INVALID/.test(m)) { p.lastErr = 'Wrong password, try again'; return false; }
      set('error', m);
      return true; // stop
    },
  }).then(async () => {
    p.session = client.session.save();
    addSecrets({ session: p.session });
    set('done');
    try { await client.disconnect(); } catch {}
  }).catch((e) => { if (p.state !== 'error') set('error', errText(e)); });
  return waitPending(p, 0);
}
async function sessionStep(kind, value) {
  const p = pending;
  if (!p) throw new Error('No login in progress (it expires after 10 minutes). Start again.');
  if (kind === 'code') {
    if (p.state !== 'need_code') throw new Error('Not waiting for a code');
    const seq = p.seq; p.resolveCode(String(value || '').replace(/\s/g, '')); return waitPending(p, seq);
  }
  if (p.state !== 'need_password') throw new Error('Not waiting for a password');
  const seq = p.seq; p.resolvePass(String(value || '')); return waitPending(p, seq);
}

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
  if (origin && origin === ALLOWED_ORIGIN) { h['Access-Control-Allow-Origin'] = origin; h['Vary'] = 'Origin'; }
  res.writeHead(code, h);
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 20000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const snapshot = () => {
  const { creds, ...rest } = state;
  return { ...rest, running, delayMs: delay, encrypted: !!encKey, envBotToken: !!ENV_BOT_TOKEN, defaultDelaySec: BASE_DELAY / 1000, logs: logs.slice(-25) };
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const path = (req.url || '').split('?')[0];

  if (path === '/health' || path === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (req.method === 'OPTIONS') { // CORS preflight
    if (origin !== ALLOWED_ORIGIN) { res.writeHead(403); return res.end(); }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin',
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

    if (path === '/check') {
      const { creds, ...out } = await runCheck(body);
      return send(res, 200, out, origin);
    }

    if (path === '/session/start') return send(res, 200, await sessionStart(body), origin);
    if (path === '/session/code') return send(res, 200, await sessionStep('code', body.code), origin);
    if (path === '/session/password') return send(res, 200, await sessionStep('password', body.password), origin);
    if (path === '/session/cancel') { cancelPending(); return send(res, 200, { ok: true }, origin); }

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
      const from = Number(body.from), to = Number(body.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        return send(res, 400, { error: 'Message IDs: whole numbers, start >= 1 and end >= start' }, origin);
      }
      const c = await runCheck(body); // same checks as the popup
      if (!c.ok) {
        const bad = [c.source.ok ? '' : 'Source: ' + c.source.note, c.dest.ok ? '' : 'Destination: ' + c.dest.note].filter(Boolean).join(' | ');
        return send(res, 400, { error: 'Setup check failed. ' + bad }, origin);
      }
      const secs = body.delaySec === '' || body.delaySec == null ? NaN : Number(body.delaySec);
      const floorMs = minDelayMs(c.mode, c.opts.dst.group); // never faster than the Telegram limit
      const baseMs = Math.min(60000, Math.max(floorMs, Number.isFinite(secs) ? Math.round(secs * 1000) : BASE_DELAY));
      const nid = String(body.notifyUserId || '').trim();
      state = {
        baseDelay: baseMs, srcOpt: c.opts.src, dstOpt: c.opts.dst,
        notifyUserId: c.mode === 'bot' && nid ? nid : null,
        notifySaved: c.mode === 'user' && body.notifySaved === true,
        progressMsgId: null,
        status: 'running', mode: c.mode, source: String(body.source).trim(), dest: String(body.dest).trim(), from, to,
        sourceTitle: c.source.title, destTitle: c.dest.title, accountName: c.account.name,
        next: from, copied: 0, skipped: 0, lastError: null, startedAt: now(), updatedAt: now(), creds: c.creds,
      };
      persist(true);
      runJob();
      return send(res, 200, { ok: true, delayMs: baseMs }, origin);
    }

    return send(res, 404, { error: 'Not found' }, origin);
  } catch (e) {
    return send(res, 400, { error: errText(e) }, origin);
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
