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
const DEMO_MAX = 8;               // only for old practice links that carry no player count; new ones allow as many players as the order
const STALE_MS = 30 * 1000;

// ---------------- themes ----------------
const themes = {};
function loadTheme(id) {
  if (themes[id]) return themes[id];
  const dir = path.join(PUBLIC, 'themes', id);
  if (!/^[a-z0-9-]+$/.test(id) || !fs.existsSync(dir)) return null;
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const opt = f => fs.existsSync(path.join(dir, f)) ? read(f) : null;
  const th = read('theme.json');
  themes[id] = { id, ...th,
    lang: { he: { questions: read('questions.json'), demo: read('demo.json'), title: th.title, subtitle: th.subtitle },
            en: { questions: opt('questions.en.json') || read('questions.json'), demo: opt('demo.en.json') || read('demo.json'),
                  title: th.titleEn || th.title, subtitle: th.subtitleEn || th.subtitle } } };
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
      async orders() { await ready; const r = await pool.query("select data from games where data->>'kind'='order' order by updated_at desc limit 500"); return r.rows.map(x => x.data); },
      async byKind(kind) { await ready; const r = await pool.query("select data from games where data->>'kind'=$1 order by updated_at desc limit 2000", [kind]); return r.rows.map(x => x.data); },
      async del(id) { await ready; await pool.query('delete from games where id=$1', [id]); },
    };
  }
  const file = path.join(__dirname, 'data', 'games.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let t = null;
  const writeNow = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); };
  const flush = () => { clearTimeout(t); t = setTimeout(writeNow, 300); };
  ['SIGTERM', 'SIGINT'].forEach(sig => process.once(sig, () => { clearTimeout(t); try { writeNow(); } catch {} process.exit(0); }));
  return {
    kind: 'file',
    async get(id) { return db[id] || null; },
    async set(id, data) { db[id] = data; flush(); },
    async list() { return Object.values(db).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 300); },
    async orders() { return Object.values(db).filter(o => o.kind === 'order'); },
    async byKind(kind) { return Object.values(db).filter(o => o.kind === kind).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); },
    async del(id) { delete db[id]; flush(); },
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

const DEMO_PLAYS = 2;   // a practice link can be played this many times
const SIM_NAMES = ['שרה', 'מנחם', 'חיה', 'יוסי', 'רבקה', 'דוד', 'אהרן', 'לאה'];
function newGame(info) {
  if (info.k === 'preview') {
    const g = { ...baseGame(info), status: 'lobby', mode: 'auto', seconds: 15 };
    const names = info.lg === 'en' ? ['Sarah', 'Menachem', 'Chaya', 'Yossi', 'Rivka', 'Dovid'] : SIM_NAMES;
    g.players = names.slice(0, 6).map((name, i) => ({ name, phone: '+1000000000' + i, sim: true, skill: .45 + i * .08,
      connected: false, lastSeen: 0, callSid: '', answers: {} }));
    g.players.forEach((p, i) => setTimeout(() => { p.connected = true; p.lastSeen = Date.now(); setTimeout(() => { p.tested = true; }, 1800); }, 1500 + i * 1300));
    return g;
  }
  return baseGame(info);
}
function baseGame(info) {
  return {
    id: info.id, kind: info.k || 'real', theme: info.th || 'hanukkah', title: info.title || '', lang: info.lg === 'en' ? 'en' : 'he',
    max: info.k === 'demo' ? (info.max || DEMO_MAX) : info.max, status: 'setup', phase: null, qIndex: -1,
    phaseEnd: 0, phaseLen: 0, paused: false, pausedLeft: 0, mode: 'auto', seconds: 20,
    players: [], used: false, startedAt: 0, finishedAt: 0, updatedAt: Date.now(), timer: null, limitTimer: null,
    ...(info.pk ? { pack: info.pk } : {}),
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
  if (!g.pack && info.pk) g.pack = info.pk;
  if (g.pack) await loadPack(g.pack);
  if (g.status === 'play' && g.kind === 'real' && Date.now() - g.startedAt > T.resumeWindow) finish(g);
  games.set(g.id, g);
  return g;
}

const langOf = g => (g.lang === 'en' ? 'en' : 'he');
// custom question sets ("packs"), edited in the admin. A game with g.pack plays the pack instead of the theme questions.
const packs = new Map();
async function loadPack(id) {
  if (!id) return null;
  if (!packs.has(id)) { const p = await store.get(id); if (p) packs.set(id, compilePack(p)); }
  return packs.get(id) || null;
}
function compilePack(p) {
  let round = 0;
  const qs = (p.questions || []).map((q, i) => {
    if (i === 0 || q.newRound) round++;
    const opts = (q.options || []).map(o => String(o || '').trim()).filter(Boolean).slice(0, 4);
    return { text: String(q.text || ''), options: opts, correct: q.type === 'poll' ? null : Math.min(opts.length, Math.max(1, +q.correct || 1)),
             bonus: q.type === 'bonus', poll: q.type === 'poll', image: q.type === 'image' && q.image ? q.image : null, round };
  }).filter(q => q.text && q.options.length >= 2);
  const demo = qs.filter(q => !q.poll).slice(0, 3).map(q => ({ ...q, round: 1, bonus: false }));
  return { ...p, compiled: qs, demo };
}
const questionsOf = g => {
  const pk = g.pack && packs.get(g.pack);
  if (pk && pk.compiled.length) return g.kind === 'demo' ? pk.demo : pk.compiled;
  const L = loadTheme(g.theme).lang[langOf(g)]; return g.kind === 'demo' ? L.demo : L.questions;
};
const roundSize = g => g.kind === 'demo' ? 999 : (loadTheme(g.theme).roundSize || 5);
// rounds: a question may name its round ("round": 2); otherwise every roundSize questions make a round
const roundOfIdx = (g, i) => { const q = questionsOf(g)[i]; return q && q.round ? q.round - 1 : Math.floor(i / roundSize(g)); };
function roundRange(g, i) {
  const qs = questionsOf(g), r = roundOfIdx(g, i);
  let from = i, to = i + 1;
  while (from > 0 && roundOfIdx(g, from - 1) === r) from--;
  while (to < qs.length && roundOfIdx(g, to) === r) to++;
  return { from, to, no: r + 1 };
}
// "round genius / fastest" cards appear once per round, beside the 3rd real (non-poll) question
function cardIdx(g, i) {
  const { from, to } = roundRange(g, i), qs = questionsOf(g), real = [];
  for (let k = from; k < to; k++) if (!qs[k].poll) real.push(k);
  return real[Math.min(2, real.length - 1)];
}
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
      if (more && roundSize(g) < 100 && roundOfIdx(g, g.qIndex + 1) !== roundOfIdx(g, g.qIndex)) return setPhase(g, 'board', auto ? T.board : 0);
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
  const pts = !q.poll && digit === q.correct ? Math.round((500 + 500 * Math.max(0, 1 - ms / limit)) * (q.bonus ? 2 : 1)) : 0;
  p.answers[g.qIndex] = { digit, ms: Math.max(0, ms), points: pts };
  g.updatedAt = Date.now(); save(g);
  if (g.mode === 'manual' && allAnswered(g) && !g.paused) advance(g);   // with a timer, the timer always runs to the end
}
function simAnswers(g) {
  const qi = g.qIndex, q = questionsOf(g)[qi];
  g.players.filter(p => p.sim).forEach(p => setTimeout(() => {
    if (g.status !== 'play' || g.phase !== 'question' || g.qIndex !== qi || p.answers[qi] || g.paused) return;
    const digit = !q.poll && Math.random() < p.skill ? q.correct : 1 + Math.floor(Math.random() * q.options.length);
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
    if (a && !q.poll && a.digit === q.correct) { correct++; score += a.points; ms += a.ms; }
  });
  return { name: p.name, score, correct, ms };
}
function ranking(g, upto = Infinity) {
  return g.players.map(p => scoreOf(g, p, 0, upto)).sort((a, b) => b.score - a.score || a.ms - b.ms);
}
function roundStats(g) {
  const { from, to } = roundRange(g, g.qIndex), qs = questionsOf(g);
  const realCount = qs.slice(from, to).filter(q => !q.poll).length;
  const s = g.players.map(p => scoreOf(g, p, from, to)).filter(x => x.correct > 0);
  if (!s.length) return null;
  const smart = [...s].sort((a, b) => b.correct - a.correct || a.ms / a.correct - b.ms / b.correct)[0];
  const fast = [...s].sort((a, b) => a.ms / a.correct - b.ms / b.correct || b.correct - a.correct)[0];
  return {
    smart: { name: smart.name, correct: smart.correct, of: realCount },
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
app.use(express.json({ limit: '8mb' }));
// code and text files are always checked for a newer version (so an update shows up right away); pictures and sounds are cached for an hour
app.use(express.static(PUBLIC, { maxAge: '1h', setHeaders: (res, file) => { if (/\.(html|js|css|json)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); } }));

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

function findBySid(sid) {
  for (const g of games.values()) {
    if (!isLive(g)) continue;
    const p = g.players.find(x => x.callSid === sid);
    if (p) return { g, p };
  }
  return null;
}
function claimRobot(sid) {          // a load-test robot call: give it the next free seat
  for (const g of games.values()) {
    if (g.kind !== 'load' || !isLive(g)) continue;
    const p = g.players.find(x => !x.callSid);
    if (p) { p.callSid = sid; return { g, p }; }
  }
  return null;
}
function touchCall(req) {
  let f = findPlayer(normPhone(req.body.From)) || findBySid(req.body.CallSid);
  if (!f && loadtest.number && normPhone(req.body.From) === loadtest.number) f = claimRobot(req.body.CallSid);
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
    if (g.status === 'lobby' && req.body.Digits) {          // line check in the waiting room: any key counts
      p.tested = true; g.updatedAt = Date.now(); save(g);
      play(r, 'ok');
    } else if (g.status === 'play' && g.phase === 'question' && !p.answers[g.qIndex] && digit >= 1 && digit <= q.options.length) {
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
    qNo: q && !q.poll ? qs.slice(0, g.qIndex + 1).filter(x => !x.poll).length : null, qTotal: qs.filter(x => !x.poll).length,
    roundNo: q && roundSize(g) < 100 ? roundRange(g, g.qIndex).no : 1, roundStart: !!q && roundSize(g) < 100 && roundRange(g, g.qIndex).from === g.qIndex,
    remainingMs: left, phaseLen: g.phaseLen, used: g.used, playsLeft: g.kind === 'demo' ? Math.max(0, DEMO_PLAYS - (g.plays || 0)) : null,
    lang: langOf(g), theme: themeView(g, th),
    question: showQ || (g.status === 'play' && g.phase === 'intro') ? {
      text: g.phase === 'memory' || g.phase === 'intro' ? null : q.text,
      options: g.phase === 'memory' || g.phase === 'intro' ? null : q.options,
      image: q.image || null, bonus: !!q.bonus, poll: !!q.poll, correct: reveal && !q.poll ? q.correct : null,
    } : null,
    counts: reveal ? q.options.map((_, i) => g.players.filter(p => p.answers[g.qIndex]?.digit === i + 1).length) : null,
    answeredCount: q ? g.players.filter(p => p.answers[g.qIndex]).length : 0,
    connectedCount: g.players.filter(isConnected).length,
    players: g.players.map(p => ({ name: p.name, phone: mask(p.phone), connected: isConnected(p), tested: !!p.tested })),
    bonusRight: reveal && q.bonus ? g.players.filter(p => p.answers[g.qIndex]?.digit === q.correct).map(p => p.name) : null,
    ranking: g.phase === 'board' || g.status === 'finished' ? ranking(g) : null,
    prevRanking: g.phase === 'board' ? ranking(g, roundRange(g, g.qIndex).from) : null,
    round: reveal && roundSize(g) < 100 && !q.poll && cardIdx(g, g.qIndex) === g.qIndex ? roundStats(g) : null,   // once per round, beside a question
  });
});

function themeView(g, th) {
  const L = th.lang[langOf(g)], pk = g.pack && packs.get(g.pack);
  const decor = th.decor.map((f, i) => { const own = pk && pk.decor && pk.decor[i]; return own === 'none' ? '' : own || `themes/${th.id}/${f}`; });   // '' = no object in that corner
  const plain = pk && pk.bg === 'plain';
  return { id: th.id, title: plain ? (langOf(g) === 'en' ? 'Trivia Game Show' : 'שעשועון טריוויה') : L.title,
           subtitle: L.subtitle, decor, bgDir: plain ? 'themes/base' : `themes/${th.id}`, bonusImage: th.bonusImage };
}

app.post('/api/game/players', withGame, (req, res) => {
  const g = req.game;
  if (g.used || g.status === 'play' || g.status === 'finished') return res.status(400).json({ error: 'started' });
  const list = (req.body.players || [])
    .map(p => ({ name: String(p.name || '').trim().slice(0, 24), phone: normPhone(p.phone) }))
    .filter(p => p.name && p.phone.length >= 11);
  if (!list.length) return res.status(400).json({ error: 'noPlayers' });
  if (list.length > g.max) return res.status(400).json({ error: 'tooMany', max: g.max });
  if (new Set(list.map(p => p.phone)).size !== list.length) return res.status(400).json({ error: 'samePhone' });
  for (const other of games.values()) {
    if (other.id === g.id || !isLive(other) || other.kind === 'preview' || other.kind === 'load') continue;
    const clash = list.find(p => other.players.some(o => o.phone === p.phone));
    if (clash) return res.status(400).json({ error: 'phoneBusy', name: clash.name });
  }
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
  if (g.kind === 'demo' && (g.plays || 0) >= DEMO_PLAYS) return res.status(400).json({ error: 'demoUsed' });
  if (g.kind === 'demo') g.plays = (g.plays || 0) + 1;
  g.status = 'play'; g.used = true; g.startedAt = Date.now();
  g.players.forEach(p => { p.answers = {}; });
  if (g.kind === 'demo') { clearTimeout(g.limitTimer); g.limitTimer = setTimeout(() => finish(g), T.demoLimit); }
  startQuestion(g, 0);
  res.json({ ok: true });
});

app.post('/api/game/next', withGame, (req, res) => {
  const g = req.game;
  if (Date.now() - (g.lastNext || 0) < 1500) return res.json({ ok: true, ignored: true });   // two screens / double click
  g.lastNext = Date.now();
  if (g.status === 'play') { if (g.paused) resume(g); else advance(g); }
  res.json({ ok: true });
});
app.post('/api/game/pause', withGame, (req, res) => { pause(req.game); res.json({ ok: true }); });
app.post('/api/game/resume', withGame, (req, res) => { resume(req.game); res.json({ ok: true }); });
app.post('/api/game/end', withGame, (req, res) => { if (req.game.status === 'play') finish(req.game); res.json({ ok: true }); });

app.post('/api/game/again', withGame, (req, res) => {     // only demo games can be played again
  const g = req.game;
  if (g.kind === 'real') return res.status(400).json({ error: 'linkUsed' });   // the real game plays once; demo and preview can repeat
  if (g.kind === 'demo' && (g.plays || 0) >= DEMO_PLAYS) return res.status(400).json({ error: 'demoUsed' });
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
  res.json({ server: true, line: client ? lineCache.ok : null, storage: store.kind, pay: pay.enabled ? (pay.test ? 'test' : 'live') : 'off' });
});

// --- admin ---
function adminOnly(req, res, next) { if (req.body.key !== ADMIN_KEY) return res.status(401).json({ error: 'סיסמה שגויה' }); next(); }
const pay = require('./payments')(app, { store, adminOnly, baseOf, secret: SECRET, getBase: () => publicBase, onPaid: id => fulfill(id) });   // card payments (off until RIVHIT_GROUP_TOKEN is set)

app.post('/api/admin/create', adminOnly, (req, res) => {
  const theme = loadTheme(req.body.theme || 'hanukkah') ? (req.body.theme || 'hanukkah') : 'hanukkah';
  const id = crypto.randomBytes(5).toString('hex');
  const days = Math.min(365, Math.max(1, parseInt(req.body.days, 10) || 30));
  const base = { title: String(req.body.title || '').slice(0, 60), th: theme, lg: req.body.lang === 'en' ? 'en' : 'he', exp: Date.now() + days * 86400000 };
  const max = Math.min(100, Math.max(1, parseInt(req.body.maxPlayers, 10) || 8));
  const real = makeToken({ ...base, id, k: 'real', max });
  const demo = makeToken({ ...base, id: id + '-demo', k: 'demo', max: max });
  const links = { real: `${baseOf(req)}/play.html?t=${real}`, demo: `${baseOf(req)}/play.html?t=${demo}` };
  store.set(id, snapshot(Object.assign(newGame({ id, k: 'real', th: theme, lg: base.lg, title: base.title, max }), { links, createdAt: Date.now(), scoreTable: !!req.body.scoreTable }))).catch(() => {});
  res.json(links);
});

app.post('/api/admin/preview', adminOnly, (req, res) => {   // a sample game with fake players, to see how it looks
  const en = req.body.lang === 'en';
  const t = makeToken({ id: 'preview-' + crypto.randomBytes(4).toString('hex'), k: 'preview', th: 'hanukkah', lg: en ? 'en' : 'he', title: en ? 'Sample Game' : 'משחק לדוגמה', max: 8, exp: Date.now() + 86400000 });
  res.json({ link: `${baseOf(req)}/play.html?t=${t}` });
});

// ================= order management (admin) =================
// Orders come from three places: the Google Sheet of the Chanukah site (read only, trivia orders only),
// orders typed in by hand in the admin ("morder"), and the old order page ("order").
// Everything the admin marks (game created, links, sent, score table) lives here, never in the sheet.
const TRIVIA_RE = /trivia|טריוויה|טריויה/i;   // only packages that say trivia (kits named family/party are not trivia)
const TRIVIA_PKG_HE = 'טריוויה (קליקרים)';
async function getSettings() { return (await store.get('settings')) || { id: 'settings', kind: 'settings' }; }
function playersFor(pkg, qty, participants) {
  const n = parseInt(participants, 10);
  if (n > 0) return Math.min(100, n);
  const q = Math.max(1, parseInt(qty, 10) || 1);
  if (/party|מסיב/i.test(pkg)) return Math.min(100, 8 * q);
  return 8;
}
function toMs(d) {
  if (typeof d === 'number') return d;
  const t = Date.parse(d); if (!isNaN(t)) return t;
  const m = String(d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);   // dd/MM/yyyy HH:mm
  return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime() : 0;
}
let sheetCache = { at: 0, data: [], error: '' };
async function sheetOrders(force) {
  if (!force && Date.now() - sheetCache.at < 45000) return sheetCache;
  const st = await getSettings();
  if (!st.sheetUrl) return (sheetCache = { at: Date.now(), data: [], error: 'notConnected' });
  try {
    const u = new URL(st.sheetUrl); u.searchParams.set('key', st.sheetKey || '');
    const r = await fetch(u, { redirect: 'follow' });
    const j = JSON.parse(await r.text());
    if (j.error) throw new Error(j.error);
    const data = (j.orders || []).filter(o => TRIVIA_RE.test(o.pkg || '')).map(o => ({
      src: 'sheet', key: 's-' + o.id, orderNo: String(o.id || ''), date: toMs(o.date), name: o.name || '', phone: o.phone || '',
      email: o.email || '', pkg: o.pkg || '', notes: o.notes || '', total: o.total || '', players: playersFor(o.pkg, o.qty, o.participants),
    }));
    sheetCache = { at: Date.now(), data, error: '' };
  } catch (e) { sheetCache = { ...sheetCache, at: Date.now(), error: String(e.message || e).slice(0, 200) }; }
  return sheetCache;
}
const metaId = key => 'om-' + key;
async function allOrders(force) {
  const [sheet, manual, page, metas, pays] = await Promise.all([sheetOrders(force), store.byKind('morder'), store.byKind('order'), store.byKind('ometa'), pay.byOrder()]);
  const meta = Object.fromEntries(metas.map(m => [m.key, m]));
  const inSheet = new Set(sheet.data.map(o => o.key));
  const web = Object.values(pays).filter(p => p.source === 'web' && p.status === 'paid' && p.order && p.order.pkgKey === 'trivia' && !inSheet.has(p.orderKey))
    .map(p => ({ src: 'web', key: p.orderKey, orderNo: p.order.orderId, date: p.paidAt, name: p.order.name, phone: p.order.phone, email: p.order.email,
                 pkg: TRIVIA_PKG_HE, notes: p.order.notes || '', total: p.amount, players: p.order.players }));
  const list = [
    ...sheet.data, ...web,
    ...manual.map(o => ({ src: 'manual', key: o.id, orderNo: '', date: o.createdAt, name: o.name, phone: o.phone, email: o.email || '', pkg: '', notes: o.notes || '', total: '', players: o.players || 8 })),
    ...page.map(o => ({ src: 'page', key: 'p-' + o.id, orderNo: '', date: o.createdAt, name: o.name, phone: o.phone, email: o.email || '', pkg: o.pkg || '', notes: [o.night, o.city, o.notes].filter(Boolean).join(' · '), total: '', players: 8 })),
  ];
  const out = [];
  for (const o of list) {
    const m = meta[o.key] || null;
    let game = null;
    if (m && m.gameId) {
      const g = games.get(m.gameId) || await store.get(m.gameId);
      if (g) game = { id: g.id, status: g.status, used: !!g.used, finishedAt: g.finishedAt || 0, title: g.title, max: g.max, lang: g.lang, scoreTable: !!g.scoreTable, pack: g.pack || null };
    }
    const played = game && (game.status === 'finished' || game.used);
    const status = !m || !m.gameId ? 'new' : played ? 'played' : m.sent ? 'sent' : 'created';
    out.push({ ...o, status, sent: !!(m && m.sent), links: m && m.gameId ? { real: m.realLink, demo: m.demoLink } : null, game,
               draft: m && !m.gameId && m.draftPack ? m.draftPack : null,
               pay: pays[o.key] ? { status: pays[o.key].status, amount: pays[o.key].amount, link: `${publicBase}/pay/${pays[o.key].id}`, doc: pays[o.key].docNum || '', error: pays[o.key].fulfillErr || pays[o.key].lastError || '' } : null });
  }
  const rank = { new: 0, created: 1, sent: 2, played: 3 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || (b.date || 0) - (a.date || 0));
  return { orders: out, sheetError: sheet.error, sheetAt: sheet.at };
}
function newGameLinks(req, { title, lang, max, days, scoreTable, orderKey, pack }) {   // req can also be the site address itself
  const id = crypto.randomBytes(5).toString('hex'), site = typeof req === 'string' ? req : baseOf(req);
  const base = { title: String(title || '').slice(0, 60), th: 'hanukkah', lg: lang === 'he' ? 'he' : 'en', exp: Date.now() + Math.min(365, Math.max(1, parseInt(days, 10) || 30)) * 86400000 };
  if (pack) base.pk = pack;
  max = Math.min(100, Math.max(1, parseInt(max, 10) || 8));
  const real = `${site}/play.html?t=${makeToken({ ...base, id, k: 'real', max })}`;
  const demo = `${site}/play.html?t=${makeToken({ ...base, id: id + '-demo', k: 'demo', max: max })}`;
  const g = newGame({ id, k: 'real', th: 'hanukkah', lg: base.lg, title: base.title, max, pk: pack });
  Object.assign(g, { pack: pack || undefined, scoreTable: !!scoreTable, orderKey: orderKey || '', links: { real, demo }, createdAt: Date.now() });
  games.set(id, g);
  store.set(id, snapshot(g)).catch(() => {});
  return { id, real, demo };
}

app.post('/api/admin/orders', adminOnly, async (req, res) => res.json(await allOrders(!!req.body.refresh)));

app.post('/api/admin/order/game', adminOnly, async (req, res) => {
  const key = String(req.body.orderKey || '');
  if (!key) return res.status(400).json({ error: 'חסרה הזמנה' });
  const old = await store.get(metaId(key));
  if (old && old.gameId) return res.status(400).json({ error: 'כבר נוצר משחק להזמנה הזאת' });
  const b = req.body;
  let pack = null;
  if (b.packId) {
    pack = await store.get(String(b.packId));
    if (!pack || pack.kind !== 'qpack' || pack.template) return res.status(400).json({ error: 'השאלות לא נמצאו' });
    if (pack.gameId) return res.status(400).json({ error: 'השאלות האלה כבר שייכות למשחק אחר' });
    const err = packProblem(pack); if (err) return res.status(400).json({ error: err });
  }
  const made = newGameLinks(req, { title: b.title, lang: b.lang, max: b.players, days: b.days, scoreTable: b.scoreTable, orderKey: key, pack: pack && pack.id });
  if (pack) { pack.gameId = made.id; pack.updatedAt = Date.now(); await store.set(pack.id, pack); packs.set(pack.id, compilePack(pack)); }
  await store.set(metaId(key), { id: metaId(key), kind: 'ometa', key, gameId: made.id, realLink: made.real, demoLink: made.demo, sent: false, concept: pack ? 'custom' : 'chanukah', createdAt: Date.now(), updatedAt: Date.now() });
  res.json({ ok: true, real: made.real, demo: made.demo });
});

async function liveOrStored(id) { return games.get(id) || await store.get(id); }
app.post('/api/admin/order/edit-game', adminOnly, async (req, res) => {
  const m = await store.get(metaId(String(req.body.orderKey || '')));
  if (!m || !m.gameId) return res.status(404).json({ error: 'לא נמצא משחק' });
  const g = await liveOrStored(m.gameId);
  if (!g) return res.status(404).json({ error: 'לא נמצא משחק' });
  if (g.used || g.status === 'play' || g.status === 'finished') return res.status(400).json({ error: 'המשחק כבר התחיל, אי אפשר לערוך' });
  const max = Math.min(100, Math.max(1, parseInt(req.body.players, 10) || g.max));
  if ((g.players || []).length > max) return res.status(400).json({ error: `כבר נרשמו ${g.players.length} שחקנים. אי אפשר להוריד מתחת למספר הזה` });
  const upd = { title: String(req.body.title ?? g.title).slice(0, 60), lang: req.body.lang === 'he' ? 'he' : 'en', max, scoreTable: !!req.body.scoreTable, updatedAt: Date.now() };
  Object.assign(g, upd);
  if (games.has(g.id)) save(g); else await store.set(g.id, { ...g, ...upd });
  const demoId = g.id + '-demo', d = await liveOrStored(demoId);   // the practice game follows the same settings
  const dUpd = { title: upd.title, lang: upd.lang, max: max, updatedAt: Date.now() };
  if (d) { Object.assign(d, dUpd); if (games.has(demoId)) save(d); else await store.set(demoId, { ...d, ...dUpd }); }
  else await store.set(demoId, snapshot(newGame({ id: demoId, k: 'demo', th: g.theme, lg: upd.lang, title: upd.title, max: dUpd.max, pk: g.pack })));
  res.json({ ok: true });
});

// ---- custom question sets (packs) ----
function seedFromTheme(lang) {
  const th = loadTheme('hanukkah'), qs = th.lang[lang === 'he' ? 'he' : 'en'].questions;
  let prev = 0;
  return qs.map((q, i) => {
    const r = q.round || Math.floor(i / (th.roundSize || 5)) + 1, newRound = i > 0 && r !== prev; prev = r;
    const type = q.poll ? 'poll' : q.bonus ? 'bonus' : q.image ? 'image' : 'regular';
    const options = [...q.options]; while (options.length < 4) options.push('');
    return { type, text: q.text, options, correct: q.correct || 1, image: q.image ? `/themes/hanukkah/${q.image}` : null, newRound };
  });
}
function cleanQuestions(list) {
  return (Array.isArray(list) ? list : []).slice(0, 80).map(q => {
    const options = [0, 1, 2, 3].map(i => String((q.options || [])[i] || '').slice(0, 90));
    const type = ['regular', 'image', 'poll', 'bonus'].includes(q.type) ? q.type : 'regular';
    const image = typeof q.image === 'string' && /^\/(pimg|themes)\/[\w\-./]+$/.test(q.image) ? q.image : null;
    return { type, text: String(q.text || '').slice(0, 220), options, correct: Math.min(4, Math.max(1, parseInt(q.correct, 10) || 1)), image, newRound: !!q.newRound };
  });
}
function packProblem(p) {
  const qs = p.questions || [];
  if (!qs.filter(q => q.type !== 'poll').length) return 'צריך לפחות שאלה אחת שאינה סקר';
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i], n = i + 1, filled = q.options.filter(o => o.trim());
    if (!q.text.trim()) return `בשאלה ${n} חסר טקסט`;
    if (filled.length < 2) return `בשאלה ${n} צריך לפחות 2 תשובות`;
    if (q.type !== 'poll' && !String(q.options[q.correct - 1] || '').trim()) return `בשאלה ${n} התשובה הנכונה ריקה`;
    if (q.type === 'image' && !q.image) return `בשאלה ${n} (שאלת תמונה) חסרה תמונה`;
  }
  return '';
}
const cleanDecor = d => [0, 1, 2, 3].map(i => { const v = (d || [])[i]; return v === 'none' || (typeof v === 'string' && /^\/pimg\/[\w-]+$/.test(v)) ? v : null; });   // 'none' = this corner stays empty
const packView = p => ({ id: p.id, name: p.name || '', template: !!p.template, lang: p.lang, bg: p.bg || 'chanukah', decor: cleanDecor(p.decor), questions: p.questions, gameId: p.gameId || null, settings: p.settings || null });
function cleanSettings(x) {
  if (!x || typeof x !== 'object') return null;
  return { title: String(x.title || '').slice(0, 60), lang: x.lang === 'he' ? 'he' : 'en', players: Math.min(100, Math.max(1, parseInt(x.players, 10) || 8)),
           days: Math.min(365, Math.max(1, parseInt(x.days, 10) || 30)), scoreTable: !!x.scoreTable };
}

app.post('/api/admin/pack/new', adminOnly, async (req, res) => {
  const lang = req.body.lang === 'he' ? 'he' : 'en';
  let src = { questions: seedFromTheme(lang), bg: 'chanukah', decor: [null, null, null, null] };
  if (req.body.from && req.body.from !== 'chanukah') {
    const t = await store.get(String(req.body.from));
    if (!t || t.kind !== 'qpack') return res.status(404).json({ error: 'התבנית לא נמצאה' });
    src = t;
  }
  const p = { id: 'pk-' + crypto.randomBytes(5).toString('hex'), kind: 'qpack', template: false, lang, bg: src.bg || 'chanukah', decor: cleanDecor(src.decor),
              questions: cleanQuestions(src.questions), settings: cleanSettings(req.body.settings), createdAt: Date.now(), updatedAt: Date.now() };
  const orderKey = String(req.body.orderKey || '');
  if (orderKey) {   // the draft stays with the order, so closing the editor never loses work
    const m = (await store.get(metaId(orderKey))) || { id: metaId(orderKey), kind: 'ometa', key: orderKey, sent: false, createdAt: Date.now() };
    if (m.gameId) return res.status(400).json({ error: 'כבר נוצר משחק להזמנה הזאת' });
    m.draftPack = p.id; m.updatedAt = Date.now(); await store.set(m.id, m);
    p.orderKey = orderKey;
  }
  await store.set(p.id, p); res.json(packView(p));
});
app.post('/api/admin/pack/get', adminOnly, async (req, res) => {
  const p = await store.get(String(req.body.id || ''));
  if (!p || p.kind !== 'qpack') return res.status(404).json({ error: 'לא נמצא' });
  res.json(packView(p));
});
app.post('/api/admin/pack/save', adminOnly, async (req, res) => {
  const p = await store.get(String(req.body.id || ''));
  if (!p || p.kind !== 'qpack') return res.status(404).json({ error: 'לא נמצא' });
  if (p.gameId) {
    const g = await liveOrStored(p.gameId);
    if (g && (g.used || g.status === 'play' || g.status === 'finished')) return res.status(400).json({ error: 'המשחק כבר התחיל, אי אפשר לשנות שאלות' });
  }
  p.questions = cleanQuestions(req.body.questions); p.bg = req.body.bg === 'plain' ? 'plain' : 'chanukah'; p.decor = cleanDecor(req.body.decor);
  if (req.body.name != null) p.name = String(req.body.name).slice(0, 60);
  if (req.body.settings) p.settings = cleanSettings(req.body.settings);
  const err = req.body.check ? packProblem(p) : '';
  if (err) return res.status(400).json({ error: err });
  p.updatedAt = Date.now(); await store.set(p.id, p); packs.set(p.id, compilePack(p));
  res.json({ ok: true });
});
app.post('/api/admin/pack/preview', adminOnly, async (req, res) => {   // see a custom game with fake players, no phones
  const p = await store.get(String(req.body.id || ''));
  if (!p || p.kind !== 'qpack') return res.status(404).json({ error: 'לא נמצא' });
  packs.set(p.id, compilePack(p));
  if (!packs.get(p.id).compiled.length) return res.status(400).json({ error: 'אין עדיין שאלות שלמות לתצוגה' });
  const st = p.settings || {}, lg = (st.lang || p.lang) === 'he' ? 'he' : 'en';
  const t = makeToken({ id: 'preview-' + crypto.randomBytes(4).toString('hex'), k: 'preview', th: 'hanukkah', lg, pk: p.id,
                        title: st.title || (lg === 'en' ? 'Preview' : 'תצוגה מקדימה'), max: 8, exp: Date.now() + 86400000 });
  res.json({ link: `${baseOf(req)}/play.html?t=${t}` });
});
app.post('/api/admin/pack/template', adminOnly, async (req, res) => {   // save a copy as a reusable template
  const p = await store.get(String(req.body.id || ''));
  if (!p || p.kind !== 'qpack') return res.status(404).json({ error: 'לא נמצא' });
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'צריך לתת שם לתבנית' });
  const t = { ...p, id: 'pk-' + crypto.randomBytes(5).toString('hex'), template: true, name, gameId: null, createdAt: Date.now(), updatedAt: Date.now() };
  await store.set(t.id, t); res.json({ ok: true, id: t.id });
});
app.post('/api/admin/pack/templates', adminOnly, async (req, res) => {
  const list = (await store.byKind('qpack')).filter(p => p.template);
  res.json(list.map(p => ({ id: p.id, name: p.name, lang: p.lang, count: (p.questions || []).length, updatedAt: p.updatedAt })));
});
app.post('/api/admin/pack/template/delete', adminOnly, async (req, res) => {
  const p = await store.get(String(req.body.id || ''));
  if (!p || !p.template) return res.status(400).json({ error: 'אפשר למחוק רק תבנית' });
  await store.del(p.id); res.json({ ok: true });
});
app.post('/api/admin/img', adminOnly, async (req, res) => {   // pictures for image questions and logos
  const m = String(req.body.dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'קובץ תמונה לא תקין' });
  if (m[2].length > 4 * 1024 * 1024) return res.status(400).json({ error: 'התמונה גדולה מדי' });
  const id = 'img-' + crypto.randomBytes(6).toString('hex');
  await store.set(id, { id, kind: 'pimg', mime: m[1], data: m[2], updatedAt: Date.now() });
  res.json({ url: '/pimg/' + id });
});
app.get('/pimg/:id', async (req, res) => {
  const im = /^img-[a-f0-9]+$/.test(req.params.id) ? await store.get(req.params.id) : null;
  if (!im || im.kind !== 'pimg') return res.status(404).end();
  res.set('Content-Type', im.mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(im.data, 'base64'));
});

app.post('/api/admin/order/sent', adminOnly, async (req, res) => {
  const m = await store.get(metaId(String(req.body.orderKey || '')));
  if (!m) return res.status(404).json({ error: 'לא נמצאה הזמנה' });
  m.sent = !!req.body.sent; m.updatedAt = Date.now();
  await store.set(m.id, m); res.json({ ok: true });
});

app.post('/api/admin/morder', adminOnly, async (req, res) => {   // add or change an order typed in by hand
  const b = req.body, clip = (v, n) => String(v || '').trim().slice(0, n);
  const id = b.id && String(b.id).startsWith('m-') ? String(b.id) : 'm-' + crypto.randomBytes(5).toString('hex');
  const old = (await store.get(id)) || { createdAt: Date.now() };
  const o = { ...old, id, kind: 'morder', name: clip(b.name, 80), phone: clip(b.phone, 30), email: clip(b.email, 120),
    players: Math.min(100, Math.max(1, parseInt(b.players, 10) || 8)), notes: clip(b.notes, 500), updatedAt: Date.now() };
  if (!o.name) return res.status(400).json({ error: 'צריך לכתוב שם' });
  await store.set(id, o); res.json({ ok: true, id });
});
app.post('/api/admin/morder/delete', adminOnly, async (req, res) => {
  const id = String(req.body.id || '');
  if (!id.startsWith('m-')) return res.status(400).json({ error: 'אפשר למחוק רק הזמנה ידנית' });
  await store.del(id); await store.del(metaId(id)); res.json({ ok: true });
});

app.post('/api/admin/results', adminOnly, async (req, res) => {   // final scores, for the score picture
  const g = await liveOrStored(String(req.body.gameId || ''));
  if (!g) return res.status(404).json({ error: 'לא נמצא משחק' });
  const list = ranking(g).map((p, i) => ({ place: i + 1, name: p.name, score: p.score, correct: p.correct }));
  const real = questionsOf(g).filter(q => !q.poll).length;
  res.json({ title: g.title, lang: langOf(g), finishedAt: g.finishedAt, startedAt: g.startedAt, questions: real, ranking: list });
});

app.post('/api/admin/settings', adminOnly, async (req, res) => {   // connect the Google Sheet (or read the current setting)
  const st = await getSettings();
  if (req.body.save) {
    st.sheetUrl = String(req.body.sheetUrl || '').trim(); if (req.body.sheetKey) st.sheetKey = String(req.body.sheetKey).trim();
    st.updatedAt = Date.now(); await store.set('settings', st);
    const r = await sheetOrders(true);
    return res.json({ ok: !r.error, error: r.error, count: r.data.length, sheetUrl: st.sheetUrl, hasKey: !!st.sheetKey });
  }
  res.json({ sheetUrl: st.sheetUrl || '', hasKey: !!st.sheetKey });
});

// --- orders from the public order page (/order.html) ---
const orderHits = new Map();
app.post('/api/order', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip).split(',')[0];
  const now = Date.now(), last = orderHits.get(ip) || [];
  const recent = last.filter(x => now - x < 3600000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Too many orders from this connection. Please text us instead.' });
  const b = req.body || {}, clip = (v, n) => String(v || '').trim().slice(0, n);
  const o = { id: 'order-' + crypto.randomBytes(5).toString('hex'), kind: 'order', name: clip(b.name, 80), phone: clip(b.phone, 30),
    email: clip(b.email, 120), pkg: clip(b.pkg, 30), night: clip(b.night, 40), lang: b.lang === 'he' ? 'he' : 'en',
    city: clip(b.city, 60), code: clip(b.code, 30).toUpperCase(), notes: clip(b.notes, 500), createdAt: now, updatedAt: now };
  if (!o.name || o.phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please enter your name and a 10-digit phone number.' });
  recent.push(now); orderHits.set(ip, recent);
  await store.set(o.id, o);
  console.log('NEW ORDER', o.pkg, o.night, mask(o.phone));
  res.json({ ok: true });
});
// --- public demo: a sample game with fake players, no phone calls, no cost ---
const demoHits = new Map();
app.get('/demo', (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip).split(',')[0], now = Date.now();
  const recent = (demoHits.get(ip) || []).filter(x => now - x < 3600000);
  if (recent.length >= 10) return res.status(429).send('Please try again later.');
  recent.push(now); demoHits.set(ip, recent);
  const he = req.query.lang === 'he';
  const t = makeToken({ id: 'preview-' + crypto.randomBytes(4).toString('hex'), k: 'preview', th: 'hanukkah', lg: he ? 'he' : 'en', title: he ? 'משחק לדוגמה' : 'Sample Game', max: 8, exp: now + 3 * 3600000 });
  res.redirect(`/play.html?t=${t}`);
});
app.get('/order', (req, res) => res.sendFile(path.join(PUBLIC, 'order.html')));

app.post('/api/admin/balance', adminOnly, async (req, res) => {
  if (!client) return res.json({ balance: null });
  try { const b = await client.balance.fetch(); res.json({ balance: +b.balance, currency: b.currency }); }
  catch (e) { res.json({ balance: null, error: e.message }); }
});

app.post('/api/admin/games', adminOnly, async (req, res) => {
  const list = await store.byKind('real');
  res.json(list.map(g => {
    const live = games.get(g.id) || g;
    return { id: live.id, title: live.title, status: live.status, used: live.used, players: live.players.length,
             connected: live.players.filter(p => p.connected && Date.now() - p.lastSeen < STALE_MS).length,
             startedAt: live.startedAt, finishedAt: live.finishedAt || 0, createdAt: live.createdAt || 0, max: live.max, lang: live.lang,
             scoreTable: !!live.scoreTable, orderKey: live.orderKey || '', links: live.links || null };
  }));
});

// --- load test: Twilio calls our own number many times; robots press random keys ---
const loadtest = { number: '', sids: [], placed: 0, requested: 0, errors: 0, lastError: '', running: false };
app.post('/api/admin/loadtest', adminOnly, async (req, res) => {
  if (!client) return res.status(400).json({ error: 'חסרים פרטי Twilio בשרת' });
  if (loadtest.running) return res.status(400).json({ error: 'בדיקה כבר רצה' });
  const count = Math.min(100, Math.max(1, parseInt(req.body.count, 10) || 20));
  const nGames = Math.min(20, Math.max(1, parseInt(req.body.games, 10) || 1));
  try {
    const nums = await client.incomingPhoneNumbers.list({ limit: 1 });
    loadtest.number = nums[0] ? normPhone(nums[0].phoneNumber) : '';
  } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!loadtest.number) return res.status(400).json({ error: 'לא נמצא מספר ב-Twilio' });
  const links = [];
  for (let k = 0; k < nGames; k++) {
    const size = Math.floor(count / nGames) + (k < count % nGames ? 1 : 0);
    const id = 'load-' + crypto.randomBytes(4).toString('hex');
    const g = { ...baseGame({ id, k: 'load', th: 'hanukkah', title: `בדיקת עומס ${k + 1}`, max: size }), status: 'lobby', mode: 'auto', seconds: 15 };
    g.players = Array.from({ length: size }, (_, i) => ({ name: `רובוט ${k + 1}-${i + 1}`, phone: `robot-${id}-${i}`, connected: false, lastSeen: 0, callSid: '', answers: {} }));
    games.set(id, g);
    links.push(`${baseOf(req)}/play.html?t=${makeToken({ id, k: 'load', th: 'hanukkah', title: g.title, max: size, exp: Date.now() + 86400000 })}`);
  }
  Object.assign(loadtest, { sids: [], placed: 0, requested: count, errors: 0, lastError: '', running: true });
  res.json({ links });
  for (let i = 0; i < count && loadtest.running; i++) {
    try {
      const c = await client.calls.create({ to: loadtest.number, from: loadtest.number, url: baseOf(req) + '/bot', method: 'POST', timeLimit: 1800 });
      loadtest.sids.push(c.sid); loadtest.placed++;
    } catch (e) { loadtest.errors++; loadtest.lastError = e.message; }
    await new Promise(r => setTimeout(r, 1100));   // Twilio's default: about one new call per second
  }
  loadtest.running = false;
});
app.post('/api/admin/loadtest/stop', adminOnly, async (req, res) => {
  loadtest.running = false; res.json({ ok: true });
  for (const sid of loadtest.sids) await client.calls(sid).update({ status: 'completed' }).catch(() => {});
  loadtest.sids = [];
  for (const g of games.values()) if (g.kind === 'load' && isLive(g)) finish(g);
});
app.post('/api/admin/loadtest/status', adminOnly, (req, res) => {
  const lg = [...games.values()].filter(g => g.kind === 'load' && isLive(g));
  res.json({ ...loadtest, sids: undefined, connected: lg.reduce((n, g) => n + g.players.filter(isConnected).length, 0) });
});
// the robot's side of the call: wait a few seconds, press a random key, repeat
app.post('/bot', twilioOnly, (req, res) => {
  const r = new twilio.twiml.VoiceResponse();
  r.pause({ length: 3 + Math.floor(Math.random() * 6) });
  r.play({ digits: 'w' + (1 + Math.floor(Math.random() * 4)) });
  r.redirect({ method: 'POST' }, '/bot');
  res.type('text/xml').send(r.toString());
});



// ================= new-order emails =================
// Emails go out through a small Google Apps Script in the business Gmail (Render's free plan blocks normal email ports).
// Every few minutes the server looks for orders it has not announced yet and emails the people on the list.
// The very first check only remembers the existing orders, so old orders are never announced.
const DEFAULT_NOTIFY = ['racheli0534124182@gmail.com', 'simi0527@gmail.com', 'lechter68@gmail.com'];
const NOTIFY_ID = 'notify-state';
let publicBase = process.env.RENDER_EXTERNAL_URL || '';
app.use((req, res, next) => { if (!publicBase && req.get('host') && !/localhost|127\.0\.0\.1/.test(req.get('host'))) publicBase = baseOf(req); next(); });
const notifyTo = st => (Array.isArray(st.notifyTo) && st.notifyTo.length ? st.notifyTo : DEFAULT_NOTIFY);

const custMail = st => st.custMailUrl && st.custMailKey ? { mailUrl: st.custMailUrl, mailKey: st.custMailKey } : st;   // the customers' email script, or the main one
async function sendMail(st, { to, subject, html }) {
  if (!st.mailUrl || !st.mailKey) throw new Error('notConnected');
  const r = await fetch(st.mailUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'follow',
    body: JSON.stringify({ key: st.mailKey, to, subject, html }) });
  const txt = await r.text(); let j;
  try { j = JSON.parse(txt); } catch { throw new Error('התשובה מהסקריפט לא תקינה. בדקי שהפריסה היא Web app עם גישה ל-Anyone'); }
  if (j.error) throw new Error(j.error === 'bad key' ? 'המפתח לא תואם למפתח שבסקריפט' : j.error);
  return j;
}
const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function orderMail(o) {
  const rows = [['שם', o.name], ['טלפון', o.phone], ['מייל', o.email], ['חבילה', o.pkg], ['משתתפים', o.players], ['סכום', o.total],
    ['מספר הזמנה', o.orderNo], ['הערות', o.notes]].filter(r => r[1] !== '' && r[1] != null);
  const admin = publicBase ? `${publicBase}/admin.html` : '';
  return {
    subject: `🎉 הזמנת טריוויה חדשה: ${o.name || 'ללא שם'}${o.players ? ` (${o.players} משתתפים)` : ''}`,
    html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;color:#1d1b3a">
      <h2 style="margin:0 0 12px">נכנסה הזמנה חדשה של טריוויה</h2>
      <table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:5px 12px 5px 0;color:#6b6890">${k}</td><td style="padding:5px 0;font-weight:bold">${escH(v)}</td></tr>`).join('')}</table>
      ${admin ? `<p style="margin-top:18px"><a href="${admin}" style="background:#5b3fd6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">פתיחת מערכת הניהול</a></p>` : ''}
      <p style="color:#8b88a3;font-size:12px;margin-top:20px">נשלח אוטומטית מ-Tricky Trivia</p></div>`,
  };
}
let notifyBusy = false;
async function checkNewOrders() {
  if (notifyBusy) return; notifyBusy = true;
  try {
    const st = await getSettings();
    if (!st.mailUrl || !st.mailKey || st.notifyOff) return;
    const { orders } = await allOrders(true);
    const state = (await store.get(NOTIFY_ID)) || { id: NOTIFY_ID, kind: 'notify', seen: [], log: [] };
    state.init = state.init || {};
    const seen = new Set(state.seen);
    // each source starts by quietly remembering the orders it already has; a sheet that can't be read right now is skipped
    const sources = { sheet: !sheetCache.error, page: true, web: true };   // web = website orders paid by card (the same order from the sheet is not announced twice)
    let list = [];
    for (const [src, ok] of Object.entries(sources)) {
      if (!ok) continue;
      const mine = orders.filter(o => o.src === src);
      if (!state.init[src]) { mine.forEach(o => seen.add(o.key)); state.init[src] = Date.now(); state.started = state.started || Date.now(); }
      else list = list.concat(mine);
    }
    const fresh = list.filter(o => !seen.has(o.key)).slice(0, 10);
    for (const o of fresh) {
      try {
        await sendMail(st, { to: notifyTo(st), ...orderMail(o) });
        seen.add(o.key); state.log.unshift({ at: Date.now(), key: o.key, name: o.name, ok: true });
      } catch (e) {
        const tries = (state.tries = state.tries || {})[o.key] = ((state.tries || {})[o.key] || 0) + 1;
        state.log.unshift({ at: Date.now(), key: o.key, name: o.name, ok: false, error: String(e.message || e).slice(0, 160) });
        if (tries >= 5) seen.add(o.key);   // give up after 5 tries so one bad order does not block the rest
      }
    }
    state.seen = [...seen].slice(-3000); state.log = state.log.slice(0, 30); state.updatedAt = Date.now();
    await store.set(NOTIFY_ID, state);
  } catch (e) { console.log('order emails:', e.message); }
  finally { notifyBusy = false; }
}
const NOTIFY_EVERY = +process.env.NOTIFY_MS || 3 * 60 * 1000;   // how often to look for new orders
setInterval(checkNewOrders, NOTIFY_EVERY); setTimeout(checkNewOrders, Math.min(20000, NOTIFY_EVERY));

app.post('/api/admin/mail', adminOnly, async (req, res) => {   // email settings: script link, key, who gets the emails
  const st = await getSettings();
  if (req.body.save) {
    st.mailUrl = String(req.body.mailUrl || '').trim();
    if (req.body.mailKey) st.mailKey = String(req.body.mailKey).trim();
    const to = String(req.body.notifyTo || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (to.length) st.notifyTo = [...new Set(to)].slice(0, 10);
    st.notifyOff = !!req.body.off; st.updatedAt = Date.now(); await store.set('settings', st);
  }
  if (req.body.saveCust) {   // a separate email script for customers (the links email). Empty = the same script as above
    st.custMailUrl = String(req.body.custMailUrl || '').trim();
    if (req.body.custMailKey) st.custMailKey = String(req.body.custMailKey).trim();
    if (!st.custMailUrl) st.custMailKey = '';
    st.updatedAt = Date.now(); await store.set('settings', st);
  }
  if (req.body.testCust) {
    try {
      await sendMail(custMail(st), { to: notifyTo(st), subject: '✓ בדיקה: המייל ללקוחות של Tricky Trivia',
        html: '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">זה מייל בדיקה מהסקריפט של המיילים ללקוחות. שימי לב מאיזו כתובת הוא הגיע: מהכתובת הזאת הלקוחות יקבלו את הקישורים.</div>' });
    } catch (e) { return res.json({ ok: false, error: String(e.message || e) === 'notConnected' ? 'קודם צריך להדביק את כתובת הסקריפט ואת המפתח' : String(e.message || e) }); }
    return res.json({ ok: true, to: notifyTo(st) });
  }
  if (req.body.test) {
    try {
      await sendMail(st, { to: notifyTo(st), subject: '✓ בדיקה: המיילים של Tricky Trivia עובדים',
        html: '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">זה מייל בדיקה. מעכשיו, כשתיכנס הזמנה חדשה של טריוויה, יגיע לכאן מייל עם כל הפרטים.</div>' });
    } catch (e) { return res.json({ ok: false, error: String(e.message || e) === 'notConnected' ? 'קודם צריך להדביק את כתובת הסקריפט ואת המפתח' : String(e.message || e) }); }
    return res.json({ ok: true, to: notifyTo(st) });
  }
  const state = (await store.get(NOTIFY_ID)) || {};
  res.json({ ok: true, mailUrl: st.mailUrl || '', hasKey: !!st.mailKey, notifyTo: notifyTo(st), off: !!st.notifyOff, log: state.log || [], started: !!state.started,
             custMailUrl: st.custMailUrl || '', hasCustKey: !!st.custMailKey });
});

// ================= after a website order is paid =================
// 1. the order goes into the sheet, with "paid" (and "receipt sent" when iCredit made the receipt)
// 2. trivia: the game is created   3. the customer gets an English email with both links   4. "links sent" (J) is marked in the sheet
// A step that fails is tried again every 2 minutes, up to 5 times. Then the order simply stays "not created" / "not sent"
// in the admin, nothing more is marked in the sheet, and the people on the email list get one warning email.
const SHEET_WRITE_URL = process.env.SHEET_WRITE_URL || '', SHEET_WRITE_KEY = process.env.SHEET_WRITE_KEY || '';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'Landsyitzur@gmail.com';
async function sheetCall(body) {
  const r = await fetch(SHEET_WRITE_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'follow', body: JSON.stringify({ ...body, key: SHEET_WRITE_KEY }) });
  const txt = await r.text(); let j;
  try { j = JSON.parse(txt); } catch { throw new Error('התשובה מהטבלה לא תקינה'); }
  if (!j.ok) throw new Error(j.error === 'bad key' ? 'המפתח לא תואם למפתח שבסקריפט של הטבלה' : (j.error || 'שגיאה בטבלה'));
  return j;
}
// the receipt by itself: after a payment link you sent by hand, or a kit order
function receiptMail(p) {
  const first = escH(String(p.name || '').split(/\s+/)[0] || 'there');
  return {
    subject: 'Your Tricky Trivia receipt',
    html: `<div style="background:#f3f1fb;padding:24px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden">
  <tr><td style="background:#0b1433;padding:26px 28px;text-align:center">
    <div style="font:bold 24px Arial,sans-serif;color:#e9b949">Tricky Trivia</div></td></tr>
  <tr><td style="padding:28px">
    <div style="font:bold 20px Arial,sans-serif;color:#1d1b3a">Thank you, ${first}!</div>
    <div style="font:16px/1.55 Arial,sans-serif;color:#6b6890;margin-top:8px">We received your payment of <b style="color:#1d1b3a">$${p.amount}</b>. Your receipt is ready:</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 4px"><tr><td style="background:#e9b949;border-radius:12px">
      <a href="${escH(p.docUrl)}" style="display:inline-block;padding:14px 26px;font:bold 16px Arial,sans-serif;color:#0b1433;text-decoration:none">View your receipt</a></td></tr></table>
    <div style="font:14px/1.5 Arial,sans-serif;color:#6b6890;margin-top:18px">Questions? Write to us at <a href="mailto:${CONTACT_EMAIL}" style="color:#5b3fd6">${CONTACT_EMAIL}</a>.</div></td></tr>
  <tr><td style="background:#0b1433;padding:16px;text-align:center;font:14px Arial,sans-serif;color:#e9b949">Happy Chanukah! ✨</td></tr>
</table></div>`,
  };
}
function linksMail(o, m, docUrl) {
  // A table layout with inline styles, so it looks the same in Gmail, Outlook and on phones.
  const first = escH(String(o.name || '').split(/\s+/)[0] || 'there');
  const NAVY = '#0b1433', GOLD = '#e9b949', INK = '#1d1b3a', MUTED = '#6b6890';
  const button = (href, txt, bg, fg) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 0"><tr><td style="background:${bg};border-radius:12px">
      <a href="${href}" style="display:inline-block;padding:14px 26px;font:bold 16px Arial,sans-serif;color:${fg};text-decoration:none;border-radius:12px">${txt}</a></td></tr></table>`;
  const card = (badge, title, text, href, txt, bg, fg) => `<tr><td style="padding:0 28px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e3f3;border-radius:14px"><tr><td style="padding:20px 22px">
        <div style="font:bold 12px Arial,sans-serif;letter-spacing:1px;color:${MUTED};text-transform:uppercase">${badge}</div>
        <div style="font:bold 19px Arial,sans-serif;color:${INK};margin-top:4px">${title}</div>
        <div style="font:15px/1.5 Arial,sans-serif;color:${MUTED};margin-top:6px">${text}</div>
        ${button(href, txt, bg, fg)}</td></tr></table></td></tr>`;
  const step = (n, t) => `<tr><td width="34" valign="top" style="padding:0 0 12px"><div style="width:26px;height:26px;border-radius:13px;background:${GOLD};color:${NAVY};font:bold 14px/26px Arial,sans-serif;text-align:center">${n}</div></td>
      <td valign="top" style="padding:3px 0 12px;font:15px/1.5 Arial,sans-serif;color:${INK}">${t}</td></tr>`;
  return {
    subject: `Your Tricky Trivia game is ready 🎉 (order ${o.orderId})`,
    html: `<div style="background:#f3f1fb;padding:24px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden">
  <tr><td style="background:${NAVY};padding:30px 28px;text-align:center">
    <div style="font-size:34px;line-height:1">🕎</div>
    <div style="font:bold 26px Arial,sans-serif;color:${GOLD};margin-top:10px">Tricky Trivia</div>
    <div style="font:15px Arial,sans-serif;color:#dfe5ff;margin-top:6px">The Chanukah phone game show</div></td></tr>
  <tr><td style="padding:28px 28px 8px">
    <div style="font:bold 22px Arial,sans-serif;color:${INK}">Hi ${first}, your game is ready!</div>
    <div style="font:16px/1.55 Arial,sans-serif;color:${MUTED};margin-top:8px">Thank you for your order. Your game is set for up to <b style="color:${INK}">${o.players} players</b>. Here are your two links:</div></td></tr>
  <tr><td style="height:12px"></td></tr>
  ${card('Step 1 · Try it out', 'Practice game', 'See how everything works before the big night. You can use this link up to 2 times.', m.demoLink, 'Open the practice game', '#e9e5ff', NAVY)}
  ${card('Step 2 · The real thing', 'Your game', 'Use this link for the real game. It works <b>one time</b> and is valid for 30 days.', m.realLink, 'Open your game →', GOLD, NAVY)}
  <tr><td style="padding:10px 28px 4px"><div style="font:bold 18px Arial,sans-serif;color:${INK}">How to play</div></td></tr>
  <tr><td style="padding:10px 28px 8px"><table role="presentation" cellpadding="0" cellspacing="0">
    ${step(1, 'Open the game link on a computer, ideally connected to a big screen.')}
    ${step(2, "Type in the players' names and phone numbers.")}
    ${step(3, `Everyone calls <b>${escH(PHONE_NUMBER)}</b> from their own phone. Kosher phones work too.`)}
    ${step(4, 'A question appears on the screen. Press 1, 2, 3 or 4 on your phone. Right and fast wins more points!')}
  </table></td></tr>
  ${docUrl ? `<tr><td style="padding:4px 28px 10px;font:15px/1.5 Arial,sans-serif;color:${INK}">🧾 Your receipt: <a href="${escH(docUrl)}" style="color:#5b3fd6;font-weight:bold">View your receipt</a></td></tr>` : ''}
  <tr><td style="padding:8px 28px 28px"><div style="background:#fbf6ea;border-radius:12px;padding:16px 18px;font:14px/1.5 Arial,sans-serif;color:${INK}">
    Questions? Write to us at <a href="mailto:${CONTACT_EMAIL}" style="color:#5b3fd6">${CONTACT_EMAIL}</a>.</div></td></tr>
  <tr><td style="background:${NAVY};padding:18px;text-align:center;font:14px Arial,sans-serif;color:${GOLD}">Happy Chanukah! ✨</td></tr>
</table></div>`,
  };
}
const fulfilling = new Set();
async function fulfill(id) {
  if (fulfilling.has(id)) return; fulfilling.add(id);
  try {
    const p = await store.get(id);
    if (!p || p.status !== 'paid') return;
    const o = p.order || {}, steps = p.steps = p.steps || {}, errs = [];
    const saveP = () => { p.updatedAt = Date.now(); return store.set(p.id, p); };
    // the receipt by email: a payment link you sent by hand, or a website order with no game (a kit).
    // A trivia order from the website gets the receipt inside the links email instead.
    if ((p.source !== 'web' || o.pkgKey !== 'trivia') && !steps.receipt) {
      if (!p.email || !p.docUrl) steps.receipt = 'none';
      else try { await sendMail(custMail(await getSettings()), { to: [p.email], ...receiptMail(p) }); steps.receipt = Date.now(); }
      catch (e) { errs.push('מייל קבלה ללקוח: ' + (e.message === 'notConnected' ? 'המיילים לא מחוברים בהגדרות' : e.message)); }
      await saveP();
    }
    if (p.source !== 'web' || !p.order) return finish();
    if (!steps.sheet) {
      if (!SHEET_WRITE_URL) steps.sheet = 'off';
      else try { await sheetCall({ action: 'paidOrder', order: o, receipt: !!p.docNum }); steps.sheet = true; } catch (e) { errs.push('טבלה: ' + e.message); }
      await saveP();
    }
    if (o.pkgKey === 'trivia') {
      let m = await store.get(metaId(p.orderKey));
      if (!m || (!m.gameId && !m.draftPack)) {
        try {
          if (!publicBase) throw new Error('חסרה כתובת השרת');
          const made = newGameLinks(publicBase, { title: `Tricky Trivia · ${o.name}`.slice(0, 60), lang: o.lang, max: o.players, days: 30, orderKey: p.orderKey });
          m = { id: metaId(p.orderKey), kind: 'ometa', key: p.orderKey, gameId: made.id, realLink: made.real, demoLink: made.demo, sent: false,
                concept: 'chanukah', auto: true, createdAt: Date.now(), updatedAt: Date.now() };
          await store.set(m.id, m); steps.game = true; await saveP();
        } catch (e) { errs.push('יצירת משחק: ' + e.message); }
      }
      if (m && m.gameId && m.auto && !steps.game) steps.game = true;
      if (m && (m.gameId || m.draftPack) && !m.auto) { steps.game = steps.mail = steps.mark = 'manual'; await saveP(); }   // you took it over by hand
      // the email goes out only for a game made here automatically, never for one you made by hand
      if (m && m.gameId && m.auto && !steps.mail) {
        try {
          await sendMail(custMail(await getSettings()), { to: [o.email], ...linksMail(o, m, p.docUrl) });
          steps.mail = Date.now(); await saveP();
          m.sent = true; m.updatedAt = Date.now(); await store.set(m.id, m);
        } catch (e) { errs.push('מייל ללקוחה: ' + (e.message === 'notConnected' ? 'המיילים לא מחוברים בהגדרות' : e.message)); }
      }
      if (steps.mail && !steps.mark) {
        if (!SHEET_WRITE_URL) steps.mark = 'off';
        else if (steps.sheet === true) try { await sheetCall({ action: 'mark', orderId: o.orderId, col: 'link' }); steps.mark = true; } catch (e) { errs.push('סימון J: ' + e.message); }
        await saveP();
      }
    }
    return finish();
    async function finish() {
      p.fulfillErr = errs.join(' · ');
      if (errs.length) p.fulfillTries = (p.fulfillTries || 0) + 1;
      if (errs.length && p.fulfillTries >= 5 && !p.alerted) {
        p.alerted = true;
        const st = await getSettings();
        const who = o.name || p.name || '', ref = o.orderId ? ` ${o.orderId}` : '';
        sendMail(st, { to: notifyTo(st), subject: `⚠️ הזמנה שולמה אבל לא הושלמה: ${who}`,
          html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">הזמנה${escH(ref)} של ${escH(who)} שולמה ($${p.amount}), אבל משהו לא הצליח אחרי התשלום:<br><b>${escH(p.fulfillErr)}</b><br><br>
            ${publicBase ? `<a href="${publicBase}/admin.html">פתחי את מערכת הניהול</a> ` : ''}והמשיכי משם ידנית, כמו בהזמנה רגילה.</div>` }).catch(() => {});
      }
      await saveP();
    }
  } finally { fulfilling.delete(id); }
}
function needsWork(p) {
  if (p.kind !== 'payment' || p.status !== 'paid' || (p.fulfillTries || 0) >= 5) return false;
  if (Date.now() - (p.paidAt || 0) > 3 * 86400000) return false;
  const s = p.steps || {}, o = p.order || {};
  if ((p.source !== 'web' || o.pkgKey !== 'trivia') && !s.receipt) return true;
  if (p.source !== 'web' || !p.order) return false;
  return !s.sheet || (o.pkgKey === 'trivia' && (!s.game || !s.mail || !s.mark));
}
setInterval(async () => {
  try { for (const p of (await store.byKind('payment')).filter(needsWork)) await fulfill(p.id); } catch (e) { console.log('retry:', e.message); }
}, 2 * 60 * 1000);

// ================= money: income and expenses =================
// Typed in by hand in the admin. Each entry: income or expense, date, amount, currency, category, note.
app.post('/api/admin/money', adminOnly, async (req, res) => {
  const b = req.body;
  if (b.add) {
    const amount = Math.round(parseFloat(String(b.amount).replace(/[^\d.\-]/g, '')) * 100) / 100;
    if (!(amount > 0)) return res.status(400).json({ error: 'צריך לכתוב סכום גדול מ-0' });
    const date = Date.parse(b.date) || Date.now();
    const e = { id: b.id && String(b.id).startsWith('mn-') ? String(b.id) : 'mn-' + crypto.randomBytes(5).toString('hex'), kind: 'money',
      type: b.type === 'out' ? 'out' : 'in', date, amount, cur: b.cur === 'ILS' ? 'ILS' : 'USD',
      cat: String(b.cat || '').trim().slice(0, 40), note: String(b.note || '').trim().slice(0, 200), updatedAt: Date.now() };
    const old = await store.get(e.id); if (old && old.kind === 'money') e.createdAt = old.createdAt; else e.createdAt = Date.now();
    await store.set(e.id, e); return res.json({ ok: true, entry: e });
  }
  if (b.del) {
    const e = await store.get(String(b.del));
    if (!e || e.kind !== 'money') return res.status(404).json({ error: 'לא נמצא' });
    await store.del(e.id); return res.json({ ok: true });
  }
  const list = (await store.byKind('money')).sort((x, y) => y.date - x.date || y.createdAt - x.createdAt);
  res.json({ ok: true, entries: list });
});

app.listen(PORT, () => console.log(`Clicker trivia on port ${PORT} (storage: ${store.kind}, language: ${LANG})`));
