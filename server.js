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
    max: info.k === 'demo' ? Math.min(DEMO_MAX, info.max || DEMO_MAX) : info.max, status: 'setup', phase: null, qIndex: -1,
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

const langOf = g => (g.lang === 'en' ? 'en' : 'he');
const questionsOf = g => { const L = loadTheme(g.theme).lang[langOf(g)]; return g.kind === 'demo' ? L.demo : L.questions; };
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
    lang: langOf(g), theme: { id: th.id, title: th.lang[langOf(g)].title, subtitle: th.lang[langOf(g)].subtitle, decor: th.decor, bonusImage: th.bonusImage },
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
  res.json({ server: true, line: client ? lineCache.ok : null, storage: store.kind });
});

// --- admin ---
function adminOnly(req, res, next) { if (req.body.key !== ADMIN_KEY) return res.status(401).json({ error: 'סיסמה שגויה' }); next(); }

app.post('/api/admin/create', adminOnly, (req, res) => {
  const theme = loadTheme(req.body.theme || 'hanukkah') ? (req.body.theme || 'hanukkah') : 'hanukkah';
  const id = crypto.randomBytes(5).toString('hex');
  const days = Math.min(365, Math.max(1, parseInt(req.body.days, 10) || 30));
  const base = { title: String(req.body.title || '').slice(0, 60), th: theme, lg: req.body.lang === 'en' ? 'en' : 'he', exp: Date.now() + days * 86400000 };
  const max = Math.min(100, Math.max(1, parseInt(req.body.maxPlayers, 10) || 8));
  const real = makeToken({ ...base, id, k: 'real', max });
  const demo = makeToken({ ...base, id: id + '-demo', k: 'demo', max: Math.min(DEMO_MAX, max) });
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
const TRIVIA_RE = /trivia|טריוויה|family|משפח|party|מסיב/i;
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
  const [sheet, manual, page, metas] = await Promise.all([sheetOrders(force), store.byKind('morder'), store.byKind('order'), store.byKind('ometa')]);
  const meta = Object.fromEntries(metas.map(m => [m.key, m]));
  const list = [
    ...sheet.data,
    ...manual.map(o => ({ src: 'manual', key: o.id, orderNo: '', date: o.createdAt, name: o.name, phone: o.phone, email: o.email || '', pkg: '', notes: o.notes || '', total: '', players: o.players || 8 })),
    ...page.map(o => ({ src: 'page', key: 'p-' + o.id, orderNo: '', date: o.createdAt, name: o.name, phone: o.phone, email: o.email || '', pkg: o.pkg || '', notes: [o.night, o.city, o.notes].filter(Boolean).join(' · '), total: '', players: 8 })),
  ];
  const out = [];
  for (const o of list) {
    const m = meta[o.key] || null;
    let game = null;
    if (m && m.gameId) {
      const g = games.get(m.gameId) || await store.get(m.gameId);
      if (g) game = { id: g.id, status: g.status, used: !!g.used, finishedAt: g.finishedAt || 0, title: g.title, max: g.max, lang: g.lang, scoreTable: !!g.scoreTable };
    }
    const played = game && (game.status === 'finished' || game.used);
    const status = !m || !m.gameId ? 'new' : played ? 'played' : m.sent ? 'sent' : 'created';
    out.push({ ...o, status, sent: !!(m && m.sent), links: m && m.gameId ? { real: m.realLink, demo: m.demoLink } : null, game });
  }
  const rank = { new: 0, created: 1, sent: 2, played: 3 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || (b.date || 0) - (a.date || 0));
  return { orders: out, sheetError: sheet.error, sheetAt: sheet.at };
}
function newGameLinks(req, { title, lang, max, days, scoreTable, orderKey }) {
  const id = crypto.randomBytes(5).toString('hex');
  const base = { title: String(title || '').slice(0, 60), th: 'hanukkah', lg: lang === 'he' ? 'he' : 'en', exp: Date.now() + Math.min(365, Math.max(1, parseInt(days, 10) || 30)) * 86400000 };
  max = Math.min(100, Math.max(1, parseInt(max, 10) || 8));
  const real = `${baseOf(req)}/play.html?t=${makeToken({ ...base, id, k: 'real', max })}`;
  const demo = `${baseOf(req)}/play.html?t=${makeToken({ ...base, id: id + '-demo', k: 'demo', max: Math.min(DEMO_MAX, max) })}`;
  const g = newGame({ id, k: 'real', th: 'hanukkah', lg: base.lg, title: base.title, max });
  Object.assign(g, { scoreTable: !!scoreTable, orderKey: orderKey || '', links: { real, demo }, createdAt: Date.now() });
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
  const b = req.body, made = newGameLinks(req, { title: b.title, lang: b.lang, max: b.players, days: b.days, scoreTable: b.scoreTable, orderKey: key });
  await store.set(metaId(key), { id: metaId(key), kind: 'ometa', key, gameId: made.id, realLink: made.real, demoLink: made.demo, sent: false, concept: 'chanukah', createdAt: Date.now(), updatedAt: Date.now() });
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
  const dUpd = { title: upd.title, lang: upd.lang, max: Math.min(DEMO_MAX, max), updatedAt: Date.now() };
  if (d) { Object.assign(d, dUpd); if (games.has(demoId)) save(d); else await store.set(demoId, { ...d, ...dUpd }); }
  else await store.set(demoId, snapshot(newGame({ id: demoId, k: 'demo', th: g.theme, lg: upd.lang, title: upd.title, max: dUpd.max })));
  res.json({ ok: true });
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


app.listen(PORT, () => console.log(`Clicker trivia on port ${PORT} (storage: ${store.kind}, language: ${LANG})`));
