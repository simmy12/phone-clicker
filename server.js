// Phone clicker trivia
// Players sit in front of one screen and use any phone (including kosher phones) as a clicker:
// they call the number, hear a beep, and press 1-4 to answer. Many games can run in parallel.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const twilio = require('twilio');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.HOST_KEY || '1234';
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '+1 978 347 6882';
const LANG = process.env.LANG_CODE || 'he';
const SECRET = process.env.LINK_SECRET || ADMIN_KEY + (AUTH_TOKEN || 'dev');
const DATABASE_URL = process.env.DATABASE_URL || '';

const PUBLIC = path.join(__dirname, 'public');
const client = ACCOUNT_SID && AUTH_TOKEN ? twilio(ACCOUNT_SID, AUTH_TOKEN) : null;

const T = {                       // phase lengths in ms
  intro: 2800, introBonus: 4200, memory: 8000,
  reveal: 9000, board: 16000,
  demoLimit: 5 * 60 * 1000,       // a demo game ends by itself after 5 minutes
  resumeWindow: 24 * 3600 * 1000, // a started real game can be resumed for 24 hours
};
const DEMO_MAX = 8;
const STALE_MS = 30 * 1000;

// ---------------- themes ----------------
const themes = {};
function loadTheme(id) {
  if (themes[id]) return themes[id];
  const dir = path.join(PUBLIC, 'themes', id);
  if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(dir)) return null;
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  themes[id] = { id, ...read('theme.json'), questions: read('questions.json'), demo: read('demo.json') };
  return themes[id];
}

// ---------------- signed links (no password needed for the buyer) ----------------
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 22);
function makeToken(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  return body + '.' + sign(body);
}
function readToken(t) {
  if (!t || !String(t).includes('.')) return null;
  const [body, sig] = String(t).split('.');
  if (sign(body) !== sig) return null;
  try { const d = JSON.parse(Buffer.from(body, 'base64url').toString()); return d.exp > Date.now() ? d : null; }
  catch { return null; }
}

// ---------------- storage: Postgres if DATABASE_URL is set, otherwise a local file ----------------
const store = (() => {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    const ready = pool.query('create table if not exists games (id text primary key, data jsonb not null, updated_at timestamptz default now())')
      .catch(e => console.log('DB init failed:', e.message));
    return {
      kind: 'postgres',
      async get(id) { await ready; const r = await pool.query('select data from games where id=$1', [id]); return r.rows[0] ? r.rows[0].data : null; },
      async set(id, data) { await ready; await pool.query('insert into games (id, data, updated_at) values ($1,$2,now()) on conflict (id) do update set data=$2, updated_at=now()', [id, data]); },
      async list() { await ready; const r = await pool.query('select data from games order by updated_at desc limit 300'); return r.rows.map(x => x.data); },
    };
  }
  const file = path.join(__dirname, 'data', 'games.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let t = null;
  const flush = () => { clearTimeout(t); t = setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); }, 300); };
  return {
    kind: 'file',
    async get(id) { return db[id] || null; },
    async set(id, data) { db[id] = data; flush(); },
    async list() { return Object.values(db).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 300); },
  };
})();

// ---------------- phone numbers ----------------
function normPhone(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.length === 10 && d.startsWith('0')) return '+972' + d.slice(1);   // Israeli number (for testing)
  if (d.length === 10) return '+1' + d;                                    // US number
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d ? '+' + d : '';
}
const mask = p => '•••' + String(p).slice(-4);

// ---------------- games ----------------
const games = new Map();

const SIM_NAMES = ['שרה', 'מנחם', 'חיה', 'יוסי', 'רבקה', 'דוד', 'אהרן', 'לאה'];
function newGame(info) {
  if (info.k === 'preview') {
    const g = { ...baseGame(info), status: 'lobby', mode: 'auto', seconds: 15 };
    g.players = SIM_NAMES.slice(0, 6).map((name, i) => ({ name, phone: '+1000000000' + i, sim: true, skill: .45 + i * .08,
      connected: false, lastSeen: 0, callSid: '', answers: {} }));
    g.players.forEach((p, i) => setTimeout(() => { p.connected = true; p.lastSeen = Date.now(); }, 1500 + i * 1300));
    return g;
  }
  return baseGame(info);
}
function baseGame(info) {
  return {
    id: info.id, kind: info.k || 'real', theme: info.th || 'hanukkah', title: info.title || '',
    max: info.k === 'demo' ? DEMO_MAX : info.max, status: 'setup', phase: null, qIndex: -1,
    phaseEnd: 0, phaseLen: 0, paused: false, pausedLeft: 0, mode: 'auto', seconds: 20,
    players: [], used: false, startedAt: 0, finishedAt: 0, updatedAt: Date.now(), timer: null, limitTimer: null,
  };
}

function snapshot(g) {
  const { timer, limitTimer, ...rest } = g;
  rest.phaseLeft = g.phaseEnd ? Math.max(0, g.phaseEnd - Date.now()) : 0;
  rest.updatedAt = Date.now();
  return rest;
}
const saveTimers = new Map();
function save(g) {
  clearTimeout(saveTimers.get(g.id));
  saveTimers.set(g.id, setTimeout(() => store.set(g.id, snapshot(g)).catch(e => console.log('save failed', e.message)), 800));
}

async function getGame(info) {
  let g = games.get(info.id);
  if (g) return g;
  const saved = await store.get(info.id);
  g = saved ? { ...newGame(info), ...saved, timer: null, limitTimer: null } : newGame(info);
  if (saved && g.status === 'play') {           // server restarted mid-game: wait for the host to press "resume"
    g.paused = true; g.pausedLeft = saved.phaseLeft || 0; g.phaseEnd = 0; g.resumed = true;
  }
  if (g.status === 'play' && g.kind === 'real' && Date.now() - g.startedAt > T.resumeWindow) finish(g);
  games.set(g.id, g);
  return g;
}

const questionsOf = g => { const th = loadTheme(g.theme); return g.kind === 'demo' ? th.demo : th.questions; };
const roundSize = g => g.kind === 'demo' ? 999 : (loadTheme(g.theme).roundSize || 5);
const isConnected = p => p.connected && (p.sim || Date.now() - p.lastSeen < STALE_MS);
const isLive = g => g.status === 'lobby' || g.status === 'play';

function findPlayer(phone) {
  let best = null;
  for (const g of games.values()) {
    if (!isLive(g)) continue;
    const p = g.players.find(x => x.phone === phone);
    if (p && (!best || g.updatedAt > best.g.updatedAt)) best = { g, p };
  }
  return best;
}

// ----- phase engine -----
function clearTimer(g) { if (g.timer) { clearTimeout(g.timer); g.timer = null; } }

function setPhase(g, phase, len) {
  clearTimer(g);
  g.phase = phase; g.phaseLen = len || 0; g.phaseStartedAt = Date.now();
  g.phaseEnd = len ? Date.now() + len : 0;
  g.paused = false; g.resumed = false;
  if (len) g.timer = setTimeout(() => advance(g), len);
  if (phase === 'question' && g.kind === 'preview') simAnswers(g);
  g.updatedAt = Date.now();
  save(g);
}

function startQuestion(g, i) {
  g.qIndex = i;
  const q = questionsOf(g)[i];
  setPhase(g, 'intro', (q.bonus ? T.introBonus : T.intro) + (i === 0 ? 3600 : 0));   // first question: 3-2-1 countdown
}

function advance(g) {
  if (g.status !== 'play') return;
  const qs = questionsOf(g), q = qs[g.qIndex], auto = g.mode === 'auto';
  const more = g.qIndex + 1 < qs.length;
  switch (g.phase) {
    case 'intro': return q.image ? setPhase(g, 'memory', T.memory) : setPhase(g, 'question', auto ? g.seconds * 1000 : 0);
    case 'memory': return setPhase(g, 'question', auto ? g.seconds * 1000 : 0);
    case 'question': return setPhase(g, 'reveal', auto ? T.reveal : 0);
    case 'reveal':
      if (more && (g.qIndex + 1) % roundSize(g) === 0) return setPhase(g, 'board', auto ? T.board : 0);
      return more ? startQuestion(g, g.qIndex + 1) : finish(g);
    case 'board': return startQuestion(g, g.qIndex + 1);
  }
}

function finish(g) {
  clearTimer(g); clearTimeout(g.limitTimer);
  g.status = 'finished'; g.phase = null; g.finishedAt = Date.now(); g.updatedAt = Date.now();
  save(g);
}

function pause(g) {
  if (g.status !== 'play' || g.paused) return;
  g.pausedLeft = g.phaseEnd ? Math.max(0, g.phaseEnd - Date.now()) : 0;
  clearTimer(g); g.paused = true; g.pausedAt = Date.now(); g.phaseEnd = 0; save(g);
}
function resume(g) {
  if (g.status !== 'play' || !g.paused) return;
  g.paused = false; g.resumed = false;
  if (g.pausedAt) g.phaseStartedAt += Date.now() - g.pausedAt;
  if (g.pausedLeft) { g.phaseEnd = Date.now() + g.pausedLeft; g.timer = setTimeout(() => advance(g), g.pausedLeft); }
  else if (['intro', 'memory'].includes(g.phase)) advance(g);   // timed phases always move on
  save(g);
}

function recordAnswer(g, p, digit) {
  const q = questionsOf(g)[g.qIndex];
  const ms = Date.now() - (g.phaseStartedAt || Date.now());
  const limit = (g.mode === 'auto' ? g.seconds : 30) * 1000;
  const pts = digit === q.correct ? Math.round((500 + 500 * Math.max(0, 1 - ms / limit)) * (q.bonus ? 2 : 1)) : 0;
  p.answers[g.qIndex] = { digit, ms: Math.max(0, ms), points: pts };
  g.updatedAt = Date.now(); save(g);
  if (g.mode === 'manual' && allAnswered(g) && !g.paused) advance(g);   // with a timer, the timer always runs to the end
}
function simAnswers(g) {
  const qi = g.qIndex, q = questionsOf(g)[qi];
  g.players.filter(p => p.sim).forEach(p => setTimeout(() => {
    if (g.status !== 'play' || g.phase !== 'question' || g.qIndex !== qi || p.answers[qi] || g.paused) return;
    const digit = Math.random() < p.skill ? q.correct : 1 + Math.floor(Math.random() * q.options.length);
    recordAnswer(g, p, digit);
  }, 1500 + Math.random() * 9000));
}

function allAnswered(g) {
  const live = g.players.filter(isConnected);
  return live.length > 0 && live.every(p => p.answers[g.qIndex]);
}

function scoreOf(g, p, from = 0, to = Infinity) {
  let score = 0, correct = 0, ms = 0;
  questionsOf(g).forEach((q, i) => {
    if (i < from || i >= to) return;
    const a = p.answers[i];
    if (a && a.digit === q.correct) { correct++; score += a.points; ms += a.ms; }
  });
  return { name: p.name, score, correct, ms };
}
function ranking(g, upto = Infinity) {
  return g.players.map(p => scoreOf(g, p, 0, upto)).sort((a, b) => b.score - a.score || a.ms - b.ms);
}
function roundStats(g) {
  const size = roundSize(g), from = Math.floor(g.qIndex / size) * size, to = from + size;
  const s = g.players.map(p => scoreOf(g, p, from, to)).filter(x => x.correct > 0);
  if (!s.length) return null;
  const smart = [...s].sort((a, b) => b.correct - a.correct || a.ms / a.correct - b.ms / b.correct)[0];
  const fast = [...s].sort((a, b) => a.ms / a.correct - b.ms / b.correct || b.correct - a.correct)[0];
  return {
    smart: { name: smart.name, correct: smart.correct, of: Math.min(size, questionsOf(g).length - from) },
    fast: { name: fast.name, avg: +(fast.ms / fast.correct / 1000).toFixed(1) },
  };
}

// clean up old games from memory
setInterval(() => {
  for (const [id, g] of games) if (Date.now() - g.updatedAt > 12 * 3600 * 1000) { clearTimer(g); games.delete(id); }
}, 30 * 60 * 1000);

// load active games after a restart so phones can reconnect even before the screen reopens
store.list().then(list => list.filter(d => d.status === 'lobby' || d.status === 'play').forEach(d => {
  getGame({ id: d.id, k: d.kind, th: d.theme, title: d.title, max: d.max });
})).catch(() => {});

// ---------------- beeps for the phone (generated, no audio files needed) ----------------
function wav(notes) {
  const rate = 8000, s = [];
  for (const [f, ms] of notes) {
    const n = Math.round(rate * ms / 1000);
    for (let i = 0; i < n; i++) s.push(f ? Math.round(Math.sin(2 * Math.PI * f * i / rate) * 12000 * Math.min(1, i / 80, (n - i) / 80)) : 0);
  }
  const b = Buffer.alloc(44 + s.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + s.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(s.length * 2, 40);
  s.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2));
  return b;
}
const sounds = {
  join: wav([[660, 150], [0, 40], [880, 150], [0, 40], [1100, 250]]),
  ok:   wav([[1000, 180]]),
  no:   wav([[300, 350]]),
  end:  wav([[880, 200], [0, 50], [660, 200], [0, 50], [440, 400]]),
  bad:  wav([[300, 300], [0, 100], [300, 300], [0, 100], [300, 300]]),
};

// ---------------- web server ----------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(PUBLIC, { maxAge: '1h' }));

app.get('/audio/:name.wav', (req, res) => {
  const s = sounds[req.params.name];
  if (!s) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400').type('audio/wav').send(s);
});

const baseOf = req => `${(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0]}://${req.get('host')}`;

function twilioOnly(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const sig = req.headers['x-twilio-signature'];
  if (sig && twilio.validateRequest(AUTH_TOKEN, sig, baseOf(req) + req.originalUrl, req.body)) return next();
  res.status(403).send('Invalid signature');
}

function twiml(req, res, build) {
  const r = new twilio.twiml.VoiceResponse();
  build(r, (node, name) => node.play(`${baseOf(req)}/audio/${name}.wav`));
  res.type('text/xml').send(r.toString());
}

function touchCall(req) {
  const f = findPlayer(normPhone(req.body.From));
  if (f) { f.p.connected = true; f.p.lastSeen = Date.now(); f.p.callSid = req.body.CallSid; }
  return f;
}

// --- phone side ---
app.post('/voice', twilioOnly, (req, res) => {
  const f = touchCall(req);
  console.log('call from', req.body.From, f ? `-> game ${f.g.id} (${f.p.name})` : '-> not in any active game');
  if (f) save(f.g);
  twiml(req, res, (r, play) => {
    if (!f) { play(r, 'bad'); r.hangup(); return; }
    play(r, 'join');
    r.redirect({ method: 'POST' }, '/wait');
  });
});

app.post('/wait', twilioOnly, (req, res) => {
  const f = touchCall(req);
  twiml(req, res, (r, play) => {
    if (!f) { play(r, 'end'); r.hangup(); return; }
    r.gather({ numDigits: 1, timeout: 5, finishOnKey: '', action: '/answer', method: 'POST' });
    r.redirect({ method: 'POST' }, '/wait');
  });
});

app.post('/answer', twilioOnly, (req, res) => {
  const f = touchCall(req);
  const digit = parseInt(req.body.Digits, 10);
  twiml(req, res, (r, play) => {
    if (!f) { play(r, 'end'); r.hangup(); return; }
    const { g, p } = f, q = questionsOf(g)[g.qIndex];
    if (g.status === 'play' && g.phase === 'question' && !p.answers[g.qIndex] && digit >= 1 && digit <= q.options.length) {
      play(r, 'ok');
      recordAnswer(g, p, digit);
    } else {
      play(r, 'no');
    }
    r.redirect({ method: 'POST' }, '/wait');
  });
});

app.post('/status', twilioOnly, (req, res) => {
  const f = findPlayer(normPhone(req.body.From));
  if (f && f.p.callSid === req.body.CallSid && ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(req.body.CallStatus)) f.p.connected = false;
  res.sendStatus(200);
});

// --- game screen API (the link itself is the key) ---
async function withGame(req, res, next) {
  const info = readToken(req.query.t || req.body.t);
  if (!info) return res.status(403).json({ error: 'linkBad' });
  if (!loadTheme(info.th || 'hanukkah')) return res.status(500).json({ error: 'linkBad' });
  req.game = await getGame(info);
  next();
}

app.get('/api/game', withGame, (req, res) => {
  const g = req.game, th = loadTheme(g.theme), qs = questionsOf(g), q = qs[g.qIndex];
  const showQ = g.status === 'play' && ['memory', 'question', 'reveal'].includes(g.phase);
  const reveal = g.status === 'play' && g.phase === 'reveal';
  const left = g.paused ? g.pausedLeft : (g.phaseEnd ? Math.max(0, g.phaseEnd - Date.now()) : null);
  res.json({
    kind: g.kind, title: g.title, max: g.max, status: g.status, phase: g.phase, paused: g.paused, resumed: !!g.resumed,
    mode: g.mode, seconds: g.seconds, phone: PHONE_NUMBER, total: qs.length, qIndex: g.qIndex, roundSize: roundSize(g),
    remainingMs: left, phaseLen: g.phaseLen, used: g.used,
    theme: { id: th.id, title: th.title, subtitle: th.subtitle, decor: th.decor, bonusImage: th.bonusImage },
    question: showQ || (g.status === 'play' && g.phase === 'intro') ? {
      text: g.phase === 'memory' || g.phase === 'intro' ? null : q.text,
      options: g.phase === 'memory' || g.phase === 'intro' ? null : q.options,
      image: q.image || null, bonus: !!q.bonus, correct: reveal ? q.correct : null,
    } : null,
    counts: reveal ? q.options.map((_, i) => g.players.filter(p => p.answers[g.qIndex]?.digit === i + 1).length) : null,
    answeredCount: q ? g.players.filter(p => p.answers[g.qIndex]).length : 0,
    connectedCount: g.players.filter(isConnected).length,
    players: g.players.map(p => ({ name: p.name, phone: mask(p.phone), connected: isConnected(p) })),
    bonusRight: reveal && q.bonus ? g.players.filter(p => p.answers[g.qIndex]?.digit === q.correct).map(p => p.name) : null,
    ranking: g.phase === 'board' || g.status === 'finished' ? ranking(g) : null,
    prevRanking: g.phase === 'board' ? ranking(g, Math.floor(g.qIndex / roundSize(g)) * roundSize(g)) : null,
    round: reveal && roundSize(g) < 100 && g.qIndex % roundSize(g) === 2 ? roundStats(g) : null,   // once per round, beside a question
  });
});

app.post('/api/game/players', withGame, (req, res) => {
  const g = req.game;
  if (g.used || g.status === 'play' || g.status === 'finished') return res.status(400).json({ error: 'started' });
  const list = (req.body.players || [])
    .map(p => ({ name: String(p.name || '').trim().slice(0, 24), phone: normPhone(p.phone) }))
    .filter(p => p.name && p.phone.length >= 11);
  if (!list.length) return res.status(400).json({ error: 'noPlayers' });
  if (list.length > g.max) return res.status(400).json({ error: 'tooMany', max: g.max });
  if (new Set(list.map(p => p.phone)).size !== list.length) return res.status(400).json({ error: 'samePhone' });
  const old = new Map(g.players.map(p => [p.phone, p]));
  g.players = list.map(p => ({ ...p, connected: old.get(p.phone)?.connected || false, lastSeen: old.get(p.phone)?.lastSeen || 0, callSid: '', answers: {} }));
  g.mode = req.body.mode === 'manual' ? 'manual' : 'auto';
  g.seconds = Math.min(60, Math.max(8, parseInt(req.body.seconds, 10) || 20));
  g.status = 'lobby'; g.updatedAt = Date.now(); save(g);
  res.json({ ok: true });
});

app.post('/api/game/edit', withGame, (req, res) => {      // back from lobby to the player list
  const g = req.game;
  if (g.status === 'lobby') { g.status = 'setup'; save(g); }
  res.json({ ok: true });
});

app.post('/api/game/start', withGame, (req, res) => {
  const g = req.game;
  if (g.status !== 'lobby') return res.status(400).json({ error: 'notLobby' });
  if (g.kind === 'real' && g.used) return res.status(400).json({ error: 'linkUsed' });
  g.status = 'play'; g.used = true; g.startedAt = Date.now();
  g.players.forEach(p => { p.answers = {}; });
  if (g.kind === 'demo') { clearTimeout(g.limitTimer); g.limitTimer = setTimeout(() => finish(g), T.demoLimit); }
  startQuestion(g, 0);
  res.json({ ok: true });
});

app.post('/api/game/next', withGame, (req, res) => {
  const g = req.game;
  if (g.status === 'play') { if (g.paused) resume(g); else advance(g); }
  res.json({ ok: true });
});
app.post('/api/game/pause', withGame, (req, res) => { pause(req.game); res.json({ ok: true }); });
app.post('/api/game/resume', withGame, (req, res) => { resume(req.game); res.json({ ok: true }); });
app.post('/api/game/end', withGame, (req, res) => { if (req.game.status === 'play') finish(req.game); res.json({ ok: true }); });

app.post('/api/game/again', withGame, (req, res) => {     // only demo games can be played again
  const g = req.game;
  if (g.kind === 'real') return res.status(400).json({ error: 'linkUsed' });
  clearTimer(g); clearTimeout(g.limitTimer);
  Object.assign(g, { status: 'lobby', phase: null, qIndex: -1, paused: false, used: false });
  g.players.forEach(p => { p.answers = {}; });
  if (g.kind === 'preview') g.mode = 'auto';
  save(g); res.json({ ok: true });
});

// is the phone number pointed at this server? (checked at most every 5 minutes)
let lineCache = { at: 0, ok: null };
app.get('/api/health', async (req, res) => {
  if (client && Date.now() - lineCache.at > 5 * 60 * 1000) {
    lineCache.at = Date.now();
    try {
      const nums = await client.incomingPhoneNumbers.list({ limit: 20 });
      lineCache.ok = nums.some(n => (n.voiceUrl || '').startsWith(baseOf(req)) && n.voiceUrl.endsWith('/voice'));
    } catch { lineCache.ok = false; }
  }
  res.json({ server: true, line: client ? lineCache.ok : null, storage: store.kind });
});

// --- admin ---
function adminOnly(req, res, next) { if (req.body.key !== ADMIN_KEY) return res.status(401).json({ error: 'סיסמה שגויה' }); next(); }

app.post('/api/admin/create', adminOnly, (req, res) => {
  const theme = loadTheme(req.body.theme || 'hanukkah') ? (req.body.theme || 'hanukkah') : 'hanukkah';
  const id = crypto.randomBytes(5).toString('hex');
  const days = Math.min(365, Math.max(1, parseInt(req.body.days, 10) || 30));
  const base = { title: String(req.body.title || '').slice(0, 60), th: theme, exp: Date.now() + days * 86400000 };
  const real = makeToken({ ...base, id, k: 'real', max: Math.min(100, Math.max(1, parseInt(req.body.maxPlayers, 10) || 8)) });
  const demo = makeToken({ ...base, id: id + '-demo', k: 'demo', max: DEMO_MAX });
  store.set(id, snapshot(newGame({ id, k: 'real', th: theme, title: base.title, max: parseInt(req.body.maxPlayers, 10) || 8 }))).catch(() => {});
  res.json({ real: `${baseOf(req)}/play.html?t=${real}`, demo: `${baseOf(req)}/play.html?t=${demo}` });
});

app.post('/api/admin/preview', adminOnly, (req, res) => {   // a sample game with fake players, to see how it looks
  const t = makeToken({ id: 'preview-' + crypto.randomBytes(4).toString('hex'), k: 'preview', th: 'hanukkah', title: 'משחק לדוגמה', max: 8, exp: Date.now() + 86400000 });
  res.json({ link: `${baseOf(req)}/play.html?t=${t}` });
});

app.post('/api/admin/games', adminOnly, async (req, res) => {
  const list = await store.list();
  res.json(list.filter(g => g.kind === 'real').map(g => {
    const live = games.get(g.id) || g;
    return { title: live.title, status: live.status, used: live.used, players: live.players.length,
             connected: live.players.filter(p => p.connected && Date.now() - p.lastSeen < STALE_MS).length,
             startedAt: live.startedAt, max: live.max };
  }));
});

app.get('/', (req, res) => res.redirect('/admin.html'));

app.listen(PORT, () => console.log(`Clicker trivia on port ${PORT} (storage: ${store.kind}, language: ${LANG})`));
