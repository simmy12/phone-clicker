// Phone clicker trivia - many games in parallel, no operator.
// Players sit in front of a screen and use their phones (any phone, including kosher phones)
// as clickers: they call the number, hear beeps, and press keys to answer.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const twilio = require('twilio');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.HOST_KEY || '1234';          // password for the admin page
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '+1 978 347 6882'; // shown on the game screen
const SECRET = process.env.LINK_SECRET || ADMIN_KEY + (AUTH_TOKEN || 'dev');

const REVEAL_SECONDS = 7;      // how long the answer is shown in automatic mode
const STALE_MS = 30 * 1000;    // a phone not heard from for 30s counts as disconnected
const GAME_TTL_MS = 8 * 3600 * 1000;

const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

// ---------------- game links (signed, no database needed) ----------------
const b64 = s => Buffer.from(s).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 22);

function makeToken({ title, maxPlayers, days }) {
  const body = b64(JSON.stringify({ id: crypto.randomBytes(5).toString('hex'), title, max: maxPlayers, exp: Date.now() + days * 86400000 }));
  return body + '.' + sign(body);
}
function readToken(t) {
  if (!t || !t.includes('.')) return null;
  const [body, sig] = t.split('.');
  if (sign(body) !== sig) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

// ---------------- phone numbers ----------------
function normPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.length === 10 && d.startsWith('0')) return '+972' + d.slice(1);  // Israeli number (for testing)
  if (d.length === 10) return '+1' + d;                                   // US number
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d ? '+' + d : '';
}

// ---------------- games (in memory) ----------------
const games = new Map(); // id -> game

function getGame(info) {
  let g = games.get(info.id);
  if (!g) {
    g = { id: info.id, title: info.title || '', max: info.max, status: 'setup', players: [],
          mode: 'auto', seconds: 20, qIndex: -1, qStart: 0, qEnd: 0, timer: null, touched: Date.now() };
    games.set(info.id, g);
  }
  g.touched = Date.now();
  return g;
}

const isActive = g => ['lobby', 'question', 'reveal'].includes(g.status);
const isConnected = p => p.connected && Date.now() - p.lastSeen < STALE_MS;

// find the newest active game that has this phone in its player list
function findPlayer(phone) {
  let best = null;
  for (const g of games.values()) {
    if (!isActive(g)) continue;
    const p = g.players.find(x => x.phone === phone);
    if (p && (!best || g.touched > best.g.touched)) best = { g, p };
  }
  return best;
}

function points(g, ms) {
  const limit = (g.mode === 'auto' ? g.seconds : 30) * 1000;
  return 500 + Math.round(500 * Math.max(0, 1 - ms / limit));
}

function totals(g) {
  return g.players.map(p => {
    let score = 0, correct = 0, ms = 0;
    questions.forEach((q, i) => {
      const a = p.answers[i];
      if (a && a.digit === q.correct) { correct++; score += a.points; ms += a.ms; }
    });
    return { name: p.name, score, correct, ms };
  }).sort((a, b) => b.score - a.score || a.ms - b.ms);
}

function clearTimer(g) { if (g.timer) { clearTimeout(g.timer); g.timer = null; } }

function startQuestion(g, i) {
  clearTimer(g);
  g.qIndex = i; g.status = 'question'; g.qStart = Date.now();
  g.qEnd = g.mode === 'auto' ? g.qStart + g.seconds * 1000 : 0;
  if (g.mode === 'auto') g.timer = setTimeout(() => reveal(g), g.seconds * 1000);
}

function reveal(g) {
  if (g.status !== 'question') return;
  clearTimer(g);
  g.status = 'reveal';
  if (g.mode === 'auto') g.timer = setTimeout(() => advance(g), REVEAL_SECONDS * 1000);
}

function advance(g) {
  clearTimer(g);
  if (g.qIndex + 1 < questions.length) startQuestion(g, g.qIndex + 1);
  else g.status = 'finished';
}

function allAnswered(g) {
  const live = g.players.filter(isConnected);
  return live.length > 0 && live.every(p => p.answers[g.qIndex]);
}

// remove old games
setInterval(() => {
  for (const [id, g] of games) if (Date.now() - g.touched > GAME_TTL_MS) { clearTimer(g); games.delete(id); }
}, 10 * 60 * 1000);

// ---------------- beep sounds (generated, no files needed) ----------------
function wav(notes) { // notes: [[freqHz, ms], ...]  freq 0 = silence
  const rate = 8000, samples = [];
  for (const [f, ms] of notes) {
    const n = Math.round(rate * ms / 1000);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 80, (n - i) / 80);
      samples.push(f ? Math.round(Math.sin(2 * Math.PI * f * i / rate) * 12000 * env) : 0);
    }
  }
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
  return buf;
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
  const play = (node, name) => node.play(`${baseOf(req)}/audio/${name}.wav`);
  build(r, play);
  res.type('text/xml').send(r.toString());
}

function touchCall(req) {
  const found = findPlayer(normPhone(req.body.From));
  if (found) {
    found.p.connected = true;
    found.p.lastSeen = Date.now();
    found.p.callSid = req.body.CallSid;
  }
  return found;
}

// --- phone side ---
app.post('/voice', twilioOnly, (req, res) => {
  const f = touchCall(req);
  console.log('call from', req.body.From, f ? `-> game ${f.g.id} (${f.p.name})` : '-> not in any active game');
  twiml(req, res, (r, play) => {
    if (!f) { play(r, 'bad'); r.hangup(); return; }
    play(r, 'join');
    r.redirect({ method: 'POST' }, '/wait');
  });
});

app.post('/wait', twilioOnly, (req, res) => {
  const f = touchCall(req);
  twiml(req, res, (r, play) => {
    if (!f) { play(r, 'end'); r.hangup(); return; }  // game finished or removed
    r.gather({ numDigits: 1, timeout: 5, finishOnKey: '', action: '/answer', method: 'POST' });
    r.redirect({ method: 'POST' }, '/wait');
  });
});

app.post('/answer', twilioOnly, (req, res) => {
  const f = touchCall(req);
  const digit = parseInt(req.body.Digits, 10);
  twiml(req, res, (r, play) => {
    if (!f) { play(r, 'end'); r.hangup(); return; }
    const { g, p } = f, q = questions[g.qIndex];
    if (g.status === 'question' && !p.answers[g.qIndex] && digit >= 1 && digit <= q.options.length) {
      const ms = Date.now() - g.qStart;
      p.answers[g.qIndex] = { digit, ms, points: digit === q.correct ? points(g, ms) : 0 };
      play(r, 'ok');
      if (allAnswered(g)) reveal(g);
    } else {
      play(r, 'no');
    }
    r.redirect({ method: 'POST' }, '/wait');
  });
});

app.post('/status', twilioOnly, (req, res) => {
  const f = findPlayer(normPhone(req.body.From));
  if (f && f.p.callSid === req.body.CallSid &&
      ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(req.body.CallStatus)) f.p.connected = false;
  res.sendStatus(200);
});

// --- game screen API (the link token is the key) ---
function withGame(req, res, next) {
  const info = readToken(req.query.t || req.body.t);
  if (!info) return res.status(403).json({ error: 'הקישור לא תקין או שפג תוקפו' });
  req.game = getGame(info);
  next();
}

app.get('/api/game', withGame, (req, res) => {
  const g = req.game, q = questions[g.qIndex];
  const showAnswer = g.status === 'reveal' || g.status === 'finished';
  res.json({
    title: g.title, max: g.max, status: g.status, mode: g.mode, seconds: g.seconds,
    phone: PHONE_NUMBER, total: questions.length, qIndex: g.qIndex,
    remainingMs: g.status === 'question' && g.qEnd ? Math.max(0, g.qEnd - Date.now()) : null,
    question: q && g.status !== 'lobby' ? { text: q.text, options: q.options, correct: showAnswer ? q.correct : null } : null,
    counts: q && showAnswer ? q.options.map((_, i) => g.players.filter(p => p.answers[g.qIndex]?.digit === i + 1).length) : null,
    players: g.players.map(p => {
      const a = p.answers[g.qIndex];
      return { name: p.name, phone: '•••' + p.phone.slice(-4), connected: isConnected(p), answered: !!a,
               right: showAnswer && a ? a.digit === q.correct : null, gained: showAnswer && a ? a.points : 0 };
    }),
    ranking: totals(g),
  });
});

app.post('/api/game/players', withGame, (req, res) => {
  const g = req.game;
  if (isActive(g)) return res.status(400).json({ error: 'המשחק כבר התחיל' });
  const list = (req.body.players || [])
    .map(p => ({ name: String(p.name || '').trim().slice(0, 30), phone: normPhone(p.phone) }))
    .filter(p => p.name && p.phone.length >= 11);
  if (!list.length) return res.status(400).json({ error: 'צריך להכניס לפחות שחקן אחד עם שם ומספר טלפון' });
  if (list.length > g.max) return res.status(400).json({ error: `אפשר עד ${g.max} שחקנים במשחק הזה` });
  if (new Set(list.map(p => p.phone)).size !== list.length) return res.status(400).json({ error: 'אותו מספר טלפון מופיע פעמיים' });
  g.players = list.map(p => ({ ...p, connected: false, lastSeen: 0, callSid: '', answers: {} }));
  g.mode = req.body.mode === 'manual' ? 'manual' : 'auto';
  g.seconds = Math.min(120, Math.max(5, parseInt(req.body.seconds, 10) || 20));
  g.status = 'lobby'; g.qIndex = -1;
  res.json({ ok: true });
});

app.post('/api/game/start', withGame, (req, res) => {
  const g = req.game;
  if (g.status !== 'lobby') return res.status(400).json({ error: 'not in lobby' });
  startQuestion(g, 0);
  res.json({ ok: true });
});

app.post('/api/game/next', withGame, (req, res) => {   // manual mode / "skip" button
  const g = req.game;
  if (g.status === 'question') reveal(g);
  else if (g.status === 'reveal') advance(g);
  res.json({ ok: true });
});

app.post('/api/game/end', withGame, (req, res) => {
  clearTimer(req.game); req.game.status = 'finished'; res.json({ ok: true });
});

app.post('/api/game/again', withGame, (req, res) => {   // back to player setup (same link)
  const g = req.game; clearTimer(g);
  g.status = 'setup'; g.qIndex = -1;
  g.players.forEach(p => { p.answers = {}; });
  res.json({ ok: true });
});

// --- admin: create game links ---
app.post('/api/admin/create', (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(401).json({ error: 'סיסמה שגויה' });
  const t = makeToken({
    title: String(req.body.title || '').slice(0, 60),
    maxPlayers: Math.min(100, Math.max(1, parseInt(req.body.maxPlayers, 10) || 8)),
    days: Math.min(365, Math.max(1, parseInt(req.body.days, 10) || 7)),
  });
  res.json({ link: `${baseOf(req)}/play?t=${t}` });
});

app.post('/api/admin/games', (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(401).json({ error: 'סיסמה שגויה' });
  res.json([...games.values()].map(g => ({
    title: g.title, status: g.status, players: g.players.length,
    connected: g.players.filter(isConnected).length,
  })));
});

app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'play.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, () => console.log(`Clicker trivia on port ${PORT}`));
