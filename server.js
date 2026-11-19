// Phone clicker quiz - basic technical version
// Participants call a Twilio phone number and answer with the keypad.
// The host controls the quiz from /host in a browser.

const express = require('express');
const path = require('path');
const fs = require('fs');
const twilio = require('twilio');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || '1234';
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const VOICE = process.env.VOICE || 'Polly.Joanna';
const LANG = process.env.VOICE_LANG || 'en-US';
const STALE_MS = 60 * 1000; // no contact for 60s => considered disconnected

const client = ACCOUNT_SID && AUTH_TOKEN ? twilio(ACCOUNT_SID, AUTH_TOKEN) : null;
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

// ---------------- state (in memory) ----------------
let baseUrl = process.env.PUBLIC_URL || '';
const participants = new Map(); // phone -> participant
let nextId = 1;
const quiz = { qIndex: -1, status: 'lobby', openedAt: 0, version: 0 };
// status: lobby | open | closed | finished

function newParticipant(phone, callSid, simulated = false) {
  const p = {
    id: nextId++, phone, callSid, simulated,
    connected: true, lastSeen: Date.now(),
    heardVersion: -1, answers: {},
  };
  participants.set(phone, p);
  return p;
}

function isConnected(p) {
  if (p.simulated) return p.connected;
  return p.connected && Date.now() - p.lastSeen < STALE_MS;
}

function score(p) {
  let correct = 0, ms = 0;
  questions.forEach((q, i) => {
    const a = p.answers[i];
    if (a && a.digit === q.correct) { correct++; ms += a.ms; }
  });
  return { correct, ms };
}

function leaderboard() {
  return [...participants.values()]
    .map(p => ({ id: p.id, phone: maskPhone(p.phone), simulated: p.simulated, ...score(p) }))
    .sort((a, b) => b.correct - a.correct || a.ms - b.ms);
}

function maskPhone(phone) {
  if (!phone) return '';
  if (phone.startsWith('SIM')) return phone;
  return '•••' + phone.slice(-4);
}

// ---------------- helpers ----------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function rememberBase(req) {
  if (baseUrl) return;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  baseUrl = `${proto}://${req.get('host')}`;
}

// Verify that phone webhooks really come from Twilio (when credentials are set)
function twilioOnly(req, res, next) {
  rememberBase(req);
  if (!AUTH_TOKEN) return next();
  const sig = req.headers['x-twilio-signature'];
  const ok = sig && twilio.validateRequest(AUTH_TOKEN, sig, baseUrl + req.originalUrl, req.body);
  if (!ok) return res.status(403).send('Invalid signature');
  next();
}

function twiml(res, build) {
  const r = new twilio.twiml.VoiceResponse();
  build(r);
  res.type('text/xml').send(r.toString());
}
const say = (node, text) => node.say({ voice: VOICE, language: LANG }, text);

function touch(req) {
  const phone = req.body.From || 'unknown';
  let p = participants.get(phone);
  if (!p) p = newParticipant(phone, req.body.CallSid);
  p.callSid = req.body.CallSid || p.callSid;
  p.connected = true;
  p.lastSeen = Date.now();
  return p;
}

// Push live calls to /wait right away so they hear the change immediately.
// Without credentials, calls still catch up within a few seconds via the wait loop.
async function pushToCalls() {
  if (!client || !baseUrl) return;
  const live = [...participants.values()].filter(p => !p.simulated && isConnected(p) && p.callSid);
  for (let i = 0; i < live.length; i += 10) {
    await Promise.all(live.slice(i, i + 10).map(p =>
      client.calls(p.callSid).update({ url: baseUrl + '/wait', method: 'POST' })
        .catch(err => console.log('push failed', p.id, err.message))));
  }
}

// ---------------- phone webhooks ----------------
app.post('/voice', twilioOnly, (req, res) => {
  const p = touch(req);
  console.log(`call in: participant ${p.id} ${maskPhone(p.phone)}`);
  twiml(res, r => {
    say(r, `Welcome to the quiz. You are participant number ${p.id}.`);
    r.redirect({ method: 'POST' }, '/wait');
  });
});

app.post('/wait', twilioOnly, (req, res) => {
  const p = touch(req);
  twiml(res, r => {
    if (p.heardVersion !== quiz.version) {
      p.heardVersion = quiz.version;
      const q = questions[quiz.qIndex];
      if (quiz.status === 'open' && !p.answers[quiz.qIndex]) {
        const g = r.gather({ numDigits: 1, timeout: 10, finishOnKey: '', action: '/answer', method: 'POST' });
        say(g, `Question ${quiz.qIndex + 1}. ${q.text}`);
        q.options.forEach((opt, i) => say(g, `Press ${i + 1} for ${opt}.`));
      } else if (quiz.status === 'open') {
        say(r, 'Your answer was received. Please wait.');
      } else if (quiz.status === 'closed') {
        const a = p.answers[quiz.qIndex];
        say(r, 'Time is up.');
        if (a) say(r, a.digit === q.correct ? 'Your answer is correct!' : `The correct answer was ${q.correct}.`);
        else say(r, `You did not answer. The correct answer was ${q.correct}.`);
      } else if (quiz.status === 'finished') {
        const s = score(p);
        say(r, `The quiz is over. You answered ${s.correct} out of ${questions.length} correctly. Thank you for playing. Goodbye.`);
        r.hangup();
        return;
      } else {
        say(r, 'Please wait for the next question.');
      }
    }
    // Waiting loop: silently listen for a key, then check again.
    r.gather({ numDigits: 1, timeout: 5, finishOnKey: '', action: '/answer', method: 'POST' });
    r.redirect({ method: 'POST' }, '/wait');
  });
});

app.post('/answer', twilioOnly, (req, res) => {
  const p = touch(req);
  const digit = parseInt(req.body.Digits, 10);
  const q = questions[quiz.qIndex];
  twiml(res, r => {
    if (req.body.Digits === '*') {           // * = repeat the current announcement
      p.heardVersion = -1;
    } else if (quiz.status !== 'open') {
      say(r, 'There is no open question right now.');
    } else if (p.answers[quiz.qIndex]) {
      say(r, 'You already answered this question.');
    } else if (!(digit >= 1 && digit <= q.options.length)) {
      say(r, `Please press a number from 1 to ${q.options.length}.`);
      p.heardVersion = -1; // repeat the question
    } else {
      p.answers[quiz.qIndex] = { digit, ms: Date.now() - quiz.openedAt };
      console.log(`answer: participant ${p.id} q${quiz.qIndex + 1} = ${digit}`);
      say(r, `Got it. You pressed ${digit}.`);
    }
    r.redirect({ method: 'POST' }, '/wait');
  });
});

// Optional: set as "Call status changes" URL in Twilio to detect hang-ups instantly
app.post('/status', twilioOnly, (req, res) => {
  const p = participants.get(req.body.From);
  if (p && ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(req.body.CallStatus)) {
    p.connected = false;
  }
  res.sendStatus(200);
});

// ---------------- host API ----------------
function hostOnly(req, res, next) {
  if (req.headers['x-host-key'] !== HOST_KEY) return res.status(401).json({ error: 'wrong key' });
  next();
}

app.get('/api/state', hostOnly, (req, res) => {
  const q = questions[quiz.qIndex];
  const all = [...participants.values()];
  const counts = q ? q.options.map((_, i) => all.filter(p => p.answers[quiz.qIndex]?.digit === i + 1).length) : [];
  res.json({
    quiz, total: questions.length,
    question: q ? { text: q.text, options: q.options, correct: quiz.status === 'open' ? null : q.correct } : null,
    counts,
    answered: q ? all.filter(p => p.answers[quiz.qIndex]).length : 0,
    connected: all.filter(isConnected).length,
    participants: all.map(p => ({ id: p.id, phone: maskPhone(p.phone), connected: isConnected(p), answered: !!p.answers[quiz.qIndex] })),
    leaderboard: leaderboard().slice(0, 10),
    pushEnabled: !!client,
  });
});

app.post('/api/next', hostOnly, async (req, res) => {
  if (quiz.qIndex + 1 >= questions.length) return res.status(400).json({ error: 'no more questions' });
  quiz.qIndex++; quiz.status = 'open'; quiz.openedAt = Date.now(); quiz.version++;
  simulateAnswers();
  res.json({ ok: true });
  pushToCalls();
});

app.post('/api/close', hostOnly, (req, res) => {
  if (quiz.status !== 'open') return res.status(400).json({ error: 'no open question' });
  quiz.status = 'closed'; quiz.version++;
  res.json({ ok: true });
  pushToCalls();
});

app.post('/api/finish', hostOnly, (req, res) => {
  quiz.status = 'finished'; quiz.version++;
  res.json({ ok: true });
  pushToCalls();
});

app.post('/api/reset', hostOnly, (req, res) => {
  participants.forEach(p => { p.answers = {}; });
  for (const [k, p] of participants) if (p.simulated || !isConnected(p)) participants.delete(k);
  Object.assign(quiz, { qIndex: -1, status: 'lobby', openedAt: 0, version: quiz.version + 1 });
  res.json({ ok: true });
  pushToCalls();
});

// Test helper: add fake participants that answer randomly
app.post('/api/simulate', hostOnly, (req, res) => {
  const n = Math.min(parseInt(req.body.count, 10) || 10, 200);
  for (let i = 0; i < n; i++) newParticipant(`SIM-${nextId}`, null, true);
  res.json({ ok: true });
});

function simulateAnswers() {
  const qi = quiz.qIndex, q = questions[qi];
  for (const p of participants.values()) {
    if (!p.simulated) continue;
    setTimeout(() => {
      if (quiz.qIndex !== qi || quiz.status !== 'open' || p.answers[qi]) return;
      const digit = Math.random() < 0.6 ? q.correct : 1 + Math.floor(Math.random() * q.options.length);
      p.answers[qi] = { digit, ms: Date.now() - quiz.openedAt };
    }, 1000 + Math.random() * 9000);
  }
}

app.get('/', (req, res) => res.redirect('/host'));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'host.html')));

app.listen(PORT, () => console.log(`Clicker server on port ${PORT}. Host screen: /host`));
