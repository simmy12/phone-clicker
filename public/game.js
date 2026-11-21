// Game screen: shown on the big screen in the room. Polls the server and animates every phase.
(() => {
const $ = id => document.getElementById(id);
const TOKEN = new URLSearchParams(location.search).get('t');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
let L = {}, S = null, prevKey = '', prevS = null, fetchedAt = 0;

// ---------- 1920x1080 stage scaled to any screen ----------
function fit() { const s = Math.min(innerWidth / 1920, innerHeight / 1080); $('stage').style.transform = `translate(-50%, -50%) scale(${s})`; }
addEventListener('resize', fit); fit();

// ---------- text ----------
function t(key, vars = {}) { let s = L[key] ?? key; for (const k in vars) s = s.replace(`{${k}}`, vars[k]); return s; }
function applyTexts() {
  document.documentElement.lang = L.lang || 'he'; document.documentElement.dir = L.dir || 'rtl';
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
}

// ---------- server ----------
async function api(path, body) {
  const r = await fetch(path + (body ? '' : '?t=' + encodeURIComponent(TOKEN)), body ? { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ t: TOKEN, ...body }) } : {});
  return r.json();
}
async function act(a, extra = {}) { audio.unlock(); const r = await api('/api/game/' + a, extra); if (r.error) showErr(r); poll(); return r; }
function showErr(r) {
  const map = { tooMany: t('errTooMany', { max: r.max }), samePhone: t('errSamePhone'), noPlayers: t('errNoPlayers'), started: t('errStarted'), linkUsed: t('linkUsed') };
  $('setupErr').textContent = map[r.error] || r.error;
}

// ---------- audio: real files if present, otherwise generated sounds ----------
const audio = (() => {
  const live = new Set(); let ac = null, on = true, music = null, musicName = '', synthLoop = null, unlocked = false, want = '';
  const files = {}, missing = new Set();
  const theme = () => (S && S.theme.id) || 'hanukkah';
  function unlock() {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    if (!unlocked) { unlocked = true; if (on && want) start(want); }
  }
  function file(name) {
    if (missing.has(name)) return null;
    if (!files[name]) {
      const a = new Audio(); a.preload = 'auto';
      a.onerror = () => { missing.add(name); if (musicName === name) { music = null; synthMusic(name); } };
      a.src = `sounds/${name}.mp3`; files[name] = a;
    }
    return files[name];
  }
  function tone(f, start, dur, type = 'triangle', vol = .16) {
    if (!ac || !on) return;
    const o = ac.createOscillator(), g = ac.createGain(), t0 = ac.currentTime + start;
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + .02); g.gain.exponentialRampToValueAtTime(.001, t0 + dur);
    o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur + .05);
  }
  function noise(start, dur, vol = .12) {
    if (!ac || !on) return;
    const b = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = ac.createBufferSource(), g = ac.createGain(), f = ac.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 3000; s.buffer = b; g.gain.value = vol;
    s.connect(f).connect(g).connect(ac.destination); s.start(ac.currentTime + start);
  }
  const SYN = {
    join: () => { tone(784, 0, .1); tone(1175, .09, .25); },
    coin: () => { tone(1568, 0, .08, 'square', .05); tone(2093, .07, .2, 'square', .05); },
    tick: () => tone(1000, 0, .06, 'square', .06),
    whoosh: () => noise(0, .45, .1),
    reveal: () => { tone(659, 0, .12); tone(784, .1, .12); tone(1047, .2, .5); },
    bonus: () => [523,659,784,1047,1319,1568].forEach((f, i) => tone(f, i * .07, .25, 'sine', .12)),
    drumroll: () => { for (let i = 0; i < 26; i++) noise(i * .07, .06, .05 + i * .004); },
    countdown: () => { let t0 = 0; for (let i = 0; i < 14; i++) { const gap = .22 - i * .012; tone(i % 2 ? 1180 : 880, t0, .05, 'square', .035 + i * .002); t0 += gap; } },
    applause: () => { for (let i = 0; i < 40; i++) noise(Math.random() * 2, .05, .05); },
  };
  const NO_FILE = new Set(['countdown']);
  function sfx(name) {
    if (!on || !unlocked) return;
    if (NO_FILE.has(name)) { (SYN[name] || (() => {}))(); return; }
    const a = file(name);
    if (a && a.readyState >= 2) { const c = a.cloneNode(); c.volume = .8; live.add(c); c.onended = () => live.delete(c); c.play().catch(() => {}); return; }
    (SYN[name] || (() => {}))();
  }
  const LOOPS = {   // generated fallback music
    lobby: { bpm: 128, mel: [659,0,784,659,587,0,523,587,659,784,880,784,659,587,523,0], bass: [131,196,147,196] },
    think: { bpm: 110, mel: [440,0,0,523,0,0,494,0,440,0,0,392,0,0,415,0], bass: [110,110,104,104] },
    board: { bpm: 132, mel: [523,659,784,1047,784,659,784,0,587,698,880,1175,880,698,880,0], bass: [131,175,196,131] },
    final: { bpm: 120, mel: [784,0,784,880,1047,0,880,784,698,0,698,784,880,0,1047,0], bass: [131,175,196,262] },
  };
  function synthMusic(name) {
    clearInterval(synthLoop); synthLoop = null;
    const L2 = LOOPS[name]; if (!L2 || !on) return;
    let i = 0; const step = 60000 / L2.bpm / 2;
    synthLoop = setInterval(() => {
      const m = L2.mel[i % 16]; if (m) tone(m, 0, .16, 'square', .035);
      if (i % 4 === 0) { tone(L2.bass[(i / 4) % 4], 0, .3, 'triangle', .11); tone(60, 0, .12, 'sine', .25); }
      if (i % 4 === 2) noise(0, .05, .04);
      i++;
    }, step);
  }
  const VOL = { lobby: .6, final: .65, game1: .38, game2: .38, game3: .38, game4: .38 };
  const SYN_OF = { game1: 'think', game2: 'think', game3: 'think', game4: 'think' };
  function duck(ms) {
    if (!music) return;
    const v = VOL[musicName] || .5, m = music; m.volume = v * .2;
    clearTimeout(duck.t); duck.t = setTimeout(() => { if (m === music) m.volume = v; }, ms);
  }
  function play(name) {          // the track this moment should have
    want = name;
    if (musicName === name && (music ? !music.paused : synthLoop)) return;
    start(name);
  }
  function start(name) {
    stop(); if (!name || !on || !unlocked) return;
    musicName = name;
    const a = file(name);
    if (!a) return synthMusic(SYN_OF[name] || name);
    music = a; a.loop = true; a.volume = VOL[name] || .5; a.currentTime = 0;
    a.play().catch(() => {});
    setTimeout(() => { if (musicName === name && missing.has(name)) synthMusic(SYN_OF[name] || name); }, 2500);
  }
  function stop() { if (music) { music.pause(); music = null; } clearInterval(synthLoop); synthLoop = null; musicName = ''; }
  function toggle() {
    on = !on;
    if (on) { unlock(); if (ac) ac.resume(); start(want); }
    else {
      stop(); live.forEach(c => c.pause()); live.clear();
      try { speechSynthesis.cancel(); } catch {}
      if (ac) ac.suspend();   // cuts generated sounds that are already playing
    }
    return on;
  }
  function say(name, text) {   // announcer: a recorded file if there is one, otherwise the computer voice
    if (!on) return;
    const a = file(name);
    duck(3500);
    if (a && a.readyState >= 2) { const c = a.cloneNode(); c.volume = 1; live.add(c); c.onended = () => live.delete(c); c.play().catch(() => {}); return; }
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'he-IL'; u.rate = .9; u.pitch = .8; u.volume = 1; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {}
  }
  return { unlock, sfx, play, stop, toggle, duck, say, preload: names => names.forEach(file), get on() { return on; } };
})();
document.addEventListener('pointerdown', () => audio.unlock());
// welcome note: one click turns on sound and full screen
$('endYes').onclick = () => { $('confirmEnd').classList.add('hidden'); act('end'); };
$('endNo').onclick = () => $('confirmEnd').classList.add('hidden');
$('welcomeOk').onclick = () => {
  audio.unlock();
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  $('welcome').classList.add('hidden');
};

// ---------- particles: gold dust, confetti, fireworks ----------
const fx = (() => {
  const c = $('fx'), x = c.getContext('2d'); let parts = [];
  for (let i = 0; i < 70; i++) parts.push(dust());
  function dust() { return { k: 'dust', x: Math.random() * 1920, y: Math.random() * 1080, vx: (Math.random() - .5) * .2, vy: -.15 - Math.random() * .35, r: 1 + Math.random() * 2.2, a: Math.random() }; }
  const COLORS = ['#ffcf4d', '#38e1ff', '#a855f7', '#f472d0', '#4ade80', '#ffffff'];
  function confetti(n = 220) {
    for (let i = 0; i < n; i++) parts.push({ k: 'conf', x: Math.random() * 1920, y: -20 - Math.random() * 400, vx: (Math.random() - .5) * 3, vy: 2 + Math.random() * 4,
      w: 10 + Math.random() * 10, h: 6 + Math.random() * 8, rot: Math.random() * 6, vr: (Math.random() - .5) * .3, c: COLORS[i % COLORS.length], life: 600 });
  }
  function firework(cx, cy) {
    const col = COLORS[Math.floor(Math.random() * 5)];
    for (let i = 0; i < 90; i++) { const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 7;
      parts.push({ k: 'spark', x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s, c: col, life: 70 + Math.random() * 40 }); }
  }
  function show(n = 6, every = 450) { for (let i = 0; i < n; i++) setTimeout(() => firework(300 + Math.random() * 1320, 150 + Math.random() * 400), i * every); }
  let lightsOn = false;
  function lights(v) { lightsOn = v; }
  function drawLights(tm) {
    const cols = ['255,220,120', '140,235,255', '200,140,255', '255,220,120'];
    x.save(); x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const ox = 260 + i * 460, ang = Math.sin(tm / 1400 + i * 1.7) * .45, len = 1250;
      const tx = ox + Math.sin(ang) * len, ty = Math.cos(ang) * len, w = 170;
      const g = x.createLinearGradient(ox, 0, tx, ty);
      g.addColorStop(0, `rgba(${cols[i]},.42)`); g.addColorStop(1, `rgba(${cols[i]},0)`);
      x.fillStyle = g; x.beginPath(); x.moveTo(ox - 14, -10); x.lineTo(ox + 14, -10);
      x.lineTo(tx + w * Math.cos(ang), ty - w * Math.sin(ang)); x.lineTo(tx - w * Math.cos(ang), ty + w * Math.sin(ang)); x.closePath(); x.fill();
    }
    x.restore();
  }
  function frame(tm) {
    x.clearRect(0, 0, 1920, 1080);
    if (lightsOn) drawLights(tm || 0);
    parts = parts.filter(p => {
      if (p.k === 'dust') {
        p.x += p.vx; p.y += p.vy; p.a += .02; if (p.y < -10) { p.y = 1090; p.x = Math.random() * 1920; }
        x.globalAlpha = .35 + Math.sin(p.a) * .3; x.fillStyle = '#ffe9a8'; x.beginPath(); x.arc(p.x, p.y, p.r, 0, 7); x.fill(); return true;
      }
      if (p.k === 'conf') {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--;
        x.globalAlpha = 1; x.save(); x.translate(p.x, p.y); x.rotate(p.rot); x.fillStyle = p.c; x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2))); x.restore();
        return p.y < 1120 && p.life > 0;
      }
      p.x += p.vx; p.y += p.vy; p.vy += .08; p.vx *= .985; p.life--;
      x.globalAlpha = Math.max(0, p.life / 90); x.fillStyle = p.c; x.beginPath(); x.arc(p.x, p.y, 3, 0, 7); x.fill();
      return p.life > 0;
    });
    x.globalAlpha = 1; requestAnimationFrame(frame);
  }
  frame();
  return { confetti, show, firework, lights };
})();

// ---------- helpers ----------
const gameTrack = () => 'game' + ((Math.floor(Math.max(0, S.qIndex) / Math.min(S.roundSize, 5)) % 4) + 1);
function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + id)); }
function flash() { const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
function setBg(gold) {
  const th = S.theme.id;
  $('bg').style.backgroundImage = `url(themes/${th}/bg-main.webp)`;
  $('bg2').style.backgroundImage = `url(themes/${th}/bg-gold.webp)`;
  $('bg2').style.opacity = gold ? 1 : 0;
}
function push() { const st = $('stage'); st.classList.add('push'); clearTimeout(push.t); push.t = setTimeout(() => st.classList.remove('push'), 1300); }
let decorDone = false;
function decor() {
  if (decorDone || !S.theme.decor) return; decorDone = true;
  const spots = [[60, 40, 150, -12], [1720, 60, 160, 10], [40, 860, 150, 8], [1740, 880, 130, -8]];
  $('decor').innerHTML = S.theme.decor.map((f, i) => { const [l, tp, w, r] = spots[i % 4];
    return `<img src="themes/${S.theme.id}/${f}" style="left:${l}px;top:${tp}px;width:${w}px;--r:${r}deg;animation-delay:${-i * 1.5}s" alt="">`; }).join('');
}
function preload() {
  if (preload.done) return; preload.done = true;
  const th = S.theme.id, imgs = ['bg-main', 'bg-gold'].map(n => `themes/${th}/${n}.webp`)
    .concat(['trophy-gold','trophy-silver','trophy-bronze','badge-fast','badge-smart','podium','coin'].map(n => `themes/base/${n}.webp`));
  imgs.forEach(src => { const i = new Image(); i.src = src; });
  audio.preload(['applause', 'game1', 'final', 'announce-leaders', 'announce-winners']);
}

// ---------- marquee light bulbs ----------
function layoutBulbs(el) {
  el.querySelectorAll('.bulb').forEach(b => b.remove());
  const w = el.offsetWidth, h = el.offsetHeight, m = 16, step = 34, r = 30, pts = [];
  const line = (x1, y1, x2, y2) => { const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step)); for (let i = 0; i < n; i++) pts.push([x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n]); };
  line(m + r, m, w - m - r, m); line(w - m, m + r, w - m, h - m - r); line(w - m - r, h - m, m + r, h - m); line(m, h - m - r, m, m + r);
  pts.forEach(([x, y], i) => { const b = document.createElement('i'); b.className = 'bulb'; b.style.left = x + 'px'; b.style.top = y + 'px'; b.dataset.i = i; el.appendChild(b); });
}
let chase = 0;
setInterval(() => { chase++; document.querySelectorAll('.bulb').forEach(b => b.classList.toggle('lit', (+b.dataset.i + chase) % 3 !== 0)); }, 240);

// ---------- setup ----------
function buildRows() {
  const saved = JSON.parse(localStorage.getItem('roster-' + TOKEN) || '[]');
  let h = '';
  for (let i = 0; i < S.max; i++) {
    const p = saved[i] || {};
    h += `<div class="rrow"><span class="n">${i + 1}</span><input class="nm" placeholder="${t('name')}" value="${esc(p.name || '')}">
          <input class="ph" placeholder="${t('phone')}" dir="ltr" value="${esc(p.phone || '')}"></div>`;
  }
  $('rows').innerHTML = h;
  $('mode').value = S.mode; $('seconds').value = S.seconds; $('secWrap').classList.toggle('hidden', S.mode !== 'auto');
  $('setupTitle').textContent = (S.kind === 'demo' ? t('setupTitleDemo') + ' · ' : '') + (S.title || S.theme.title);
  $('demoSteps').classList.toggle('hidden', S.kind !== 'demo');
  $('demoSteps').innerHTML = (L.demoSteps || []).map((s, i) => `<div><b>${i + 1}</b><span>${esc(s)}</span></div>`).join('');
}
$('mode').onchange = () => $('secWrap').classList.toggle('hidden', $('mode').value !== 'auto');
$('toLobby').onclick = async () => {
  const names = [...document.querySelectorAll('#rows .nm')], phones = [...document.querySelectorAll('#rows .ph')];
  const players = names.map((n, i) => ({ name: n.value.trim(), phone: phones[i].value.trim() })).filter(p => p.name || p.phone);
  if (players.some(p => !p.name || !p.phone)) { $('setupErr').textContent = t('errNamePhone'); return; }
  localStorage.setItem('roster-' + TOKEN, JSON.stringify(players));
  const r = await act('players', { players, mode: $('mode').value, seconds: $('seconds').value });
  if (!r.error) $('setupErr').textContent = '';
};
$('editBtn').onclick = () => act('edit');
$('startBtn').onclick = () => act('start');
$('resumeBtn').onclick = () => act('resume');

// ---------- toolbar + keyboard ----------
function doAct(a) {
  if (a === 'next') act('next');
  if (a === 'pause') act(S.paused ? 'resume' : 'pause');
  if (a === 'full') { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); else document.exitFullscreen(); }
  if (a === 'sound') $('tbSound').classList.toggle('muted', !audio.toggle());
  if (a === 'end') $('confirmEnd').classList.remove('hidden');
}
$('toolbar').onclick = e => { const b = e.target.closest('button'); if (b) doAct(b.dataset.act); };
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || !S) return;
  const k = e.key.toLowerCase();
  if (S.status === 'play' && [' ', 'arrowleft', 'enter', 'pagedown'].includes(k)) { e.preventDefault(); act('next'); }
  if (k === 'p' && S.status === 'play') doAct('pause');
  if (k === 'f') doAct('full');
  if (k === 'm') doAct('sound');
});
let idleT; document.addEventListener('mousemove', () => { $('toolbar').classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => $('toolbar').classList.add('idle'), 3000); });

// ---------- health lights ----------
async function health() {
  try { const h = await (await fetch('/api/health')).json();
    $('lineWarn').classList.toggle('hidden', h.line !== false);   // shown only when something is wrong
  } catch { $('lineWarn').classList.remove('hidden'); }
}

// ---------- render ----------
function render() {
  const s = S, key = [s.status, s.phase, s.qIndex].join('|'), changed = key !== prevKey;
  $('toolbar').classList.toggle('hidden', !['lobby', 'play'].includes(s.status));
  $('tbInfo').textContent = s.status === 'play' ? t('questionOf', { n: s.qIndex + 1, total: s.total }) : '';
  $('tbPause').classList.toggle('paused', !!s.paused);
  $('pausedOverlay').classList.toggle('hidden', !s.paused);
  $('pausedTitle').textContent = s.resumed ? t('resumeGame') : t('paused');
  setBg(s.phase === 'board' || s.status === 'finished');
  decor(); preload();

  if (s.status === 'setup') { if (changed) { buildRows(); show('setup'); audio.play('lobby'); } }
  else if (s.status === 'lobby') renderLobby(changed);
  else if (s.status === 'finished') { if (changed) renderFinal(); }
  else if (s.phase === 'intro') { if (changed) renderIntro(); }
  else if (s.phase === 'memory') { if (changed) renderMemory(); }
  else if (s.phase === 'question') renderQuestion(changed);
  else if (s.phase === 'reveal') { if (changed) renderReveal(); }
  else if (s.phase === 'board') { if (changed) renderBoard(); }
  if (s.status !== 'finished') fx.lights(s.phase === 'board');
  prevKey = key;
}

function renderLobby(changed) {
  if (changed) { show('lobby'); audio.play('lobby'); health(); $('editBtn').classList.toggle('hidden', s().kind === 'preview'); }
  $('logo').textContent = s().title || s().theme.title;
  $('subRibbon').textContent = s().kind === 'demo' ? t('demoBadge') : s().theme.subtitle;
  $('phoneNum').textContent = s().phone;
  const on = s().players.filter(p => p.connected).length;
  const before = prevS && prevS.status === 'lobby' ? prevS.players.filter(p => p.connected).length : on;
  if (on > before) audio.sfx('join');
  $('lobbyOn').textContent = on; $('lobbyTotal').textContent = s().players.length;
  $('startBtn').disabled = on === 0;
  const html = s().players.map(p => `<span class="pchip ${p.connected ? 'on' : ''}"><b>${p.connected ? '✓' : '…'}</b>${esc(p.name)}<small>${p.connected ? t('connected') : t('waiting')}</small></span>`).join('');
  if ($('lobbyChips').dataset.h !== html) { $('lobbyChips').innerHTML = html; $('lobbyChips').dataset.h = html; }
}
const s = () => S;

function renderIntro() {
  const q = S.question, bonus = q && q.bonus;
  show('intro'); flash(); push(); $('s-intro').classList.toggle('bonus', !!bonus);
  audio.play(gameTrack()); audio.sfx(bonus ? 'bonus' : 'whoosh');
  if (S.qIndex === 0 && !bonus && (S.remainingMs || 0) > 4000) return countdown321();
  $('introTxt').textContent = bonus ? t('bonus') : t('question', { n: S.qIndex + 1 });
  $('introSub').textContent = bonus ? t('bonusSub') : ((S.qIndex % S.roundSize === 0 && S.roundSize < 100) ? t('roundOf', { n: Math.floor(S.qIndex / S.roundSize) + 1 }) : '');
  $('introBonusImg').classList.toggle('hidden', !bonus);
  if (bonus) { $('introBonusImg').src = `themes/${S.theme.id}/${S.theme.bonusImage}`; fx.show(3, 350); }
  // preload the memory image so it shows instantly
  if (q && q.image) { const i = new Image(); i.src = `themes/${S.theme.id}/${q.image}`; }
}

function countdown321() {
  const el = $('introTxt'); $('introSub').textContent = ''; $('introBonusImg').classList.add('hidden');
  ['3', '2', '1'].forEach((n, i) => setTimeout(() => {
    el.textContent = n; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    el.classList.add('count'); flash(); audio.sfx('tick'); fx.firework(500 + Math.random() * 920, 250 + Math.random() * 300);
  }, i * 1100));
  setTimeout(() => {
    el.classList.remove('count'); el.textContent = t('question', { n: 1 });
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    flash(); push(); audio.sfx('whoosh'); fx.show(3, 250); fx.confetti(120);
    $('introSub').textContent = t('roundOf', { n: 1 });
  }, 3400);
}

function renderMemory() {
  show('memory'); audio.play(gameTrack()); audio.sfx('whoosh');
  $('memImg').src = `themes/${S.theme.id}/${S.question.image}`;
  const bar = $('memBar'), left = S.remainingMs || 8000;
  bar.style.transition = 'none'; bar.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = `width ${left}ms linear`; bar.style.width = '0%'; }));
}

let jarCount = 0;
function renderQuestion(changed) {
  const q = S.question;
  if (changed) {
    show('quiz'); audio.play(gameTrack());
    const sq = $('s-quiz'); sq.classList.remove('enter'); void sq.offsetWidth; sq.classList.add('enter');
    $('qBadge').textContent = (q.bonus ? '⭐ ' + t('bonus') + ' ⭐ · ' : '') + t('questionOf', { n: S.qIndex + 1, total: S.total });
    $('qBadge').classList.toggle('bonus', q.bonus);
    $('qText').textContent = q.text;
    $('tiles').classList.remove('reveal');
    $('tiles').innerHTML = q.options.map((o, i) => `<div class="tile t${i + 1} flip" style="animation-delay:${.35 + i * .22}s"><div class="meter"></div><div class="k">${i + 1}</div><div class="tx${o.length > 16 ? ' long' : ''}">${esc(o)}</div><div class="pct"></div></div>`).join('');
    q.options.forEach((_, i) => setTimeout(() => audio.sfx('tick'), 350 + i * 220));
    $('jarCoins').innerHTML = ''; jarCount = 0;
    $('jarTotal').textContent = S.players.length;
    $('bonusNames').classList.add('hidden');
    $('timer').classList.toggle('hidden', S.mode !== 'auto' || !S.phaseLen);
    $('jar').classList.remove('hidden'); document.querySelector('.press-hint').classList.remove('hidden');
  }
  $('jarNum').textContent = S.answeredCount;
  while (jarCount < S.answeredCount) {   // a coin drops into the jar for every answer (who answered stays secret)
    const img = document.createElement('img'); img.src = 'themes/base/coin.webp';
    img.style.left = (12 + Math.random() * 110) + 'px'; img.style.bottom = (8 + Math.min(jarCount, 14) * 13) + 'px'; img.style.rotate = (Math.random() * 40 - 20) + 'deg';
    $('jarCoins').appendChild(img); jarCount++; audio.sfx('coin');
  }
}

function tick() {   // smooth timer between polls
  if (!S || S.status !== 'play' || S.phase !== 'question' || !S.phaseLen || S.remainingMs == null) return;
  const left = S.paused ? S.remainingMs : Math.max(0, S.remainingMs - (Date.now() - fetchedAt));
  const sec = Math.ceil(left / 1000);
  $('tNum').textContent = sec;
  $('ring').style.strokeDashoffset = 540.4 * (1 - left / S.phaseLen);
  $('timer').classList.toggle('hurry', sec <= 5 && sec > 0);
  if (sec !== tick.last && sec <= 5 && sec > 0 && !S.paused) audio.sfx('tick');
  tick.last = sec;
}
setInterval(tick, 100);

function renderReveal() {
  const st = S, q = st.question;
  if (!$('s-quiz').classList.contains('on')) renderQuestion(true);
  show('quiz'); audio.play(gameTrack()); audio.duck(3000); audio.sfx('countdown');
  $('timer').classList.add('hidden'); document.querySelector('.press-hint').classList.add('hidden');
  const total = st.counts.reduce((a, b) => a + b, 0);
  setTimeout(() => {
    flash(); audio.sfx('reveal');
    const tiles = [...document.querySelectorAll('#tiles .tile')];
    tiles.forEach((el, i) => { el.classList.remove('flip'); el.classList.add(q.correct === i + 1 ? 'win' : 'dim'); });
    // coins fly from the jar into the answer meters
    const stage = $('stage'), jr = $('jar').getBoundingClientRect(), sr = stage.getBoundingClientRect(), k = sr.width / 1920;
    let n = 0;
    st.counts.forEach((c, i) => {
      const tr = tiles[i].getBoundingClientRect();
      for (let j = 0; j < Math.min(c, 12); j++, n++) {
        const coin = document.createElement('img'); coin.src = 'themes/base/coin.webp'; coin.className = 'flycoin';
        const x0 = (jr.left - sr.left) / k + 60, y0 = (jr.top - sr.top) / k + 100;
        coin.style.left = x0 + 'px'; coin.style.top = y0 + 'px'; stage.appendChild(coin);
        const x1 = (tr.left - sr.left) / k + 40 + Math.random() * ((tr.width / k) - 120), y1 = (tr.top - sr.top) / k + 50;
        setTimeout(() => { coin.style.transform = `translate(${x1 - x0}px, ${y1 - y0}px) rotate(540deg)`; coin.style.opacity = '0'; audio.sfx('coin'); }, 80 + n * 70);
        setTimeout(() => coin.remove(), 2200 + n * 70);
      }
    });
    $('jarCoins').innerHTML = '';
    setTimeout(() => {
      $('tiles').classList.add('reveal');
      tiles.forEach((el, i) => {
        const p = total ? Math.round(st.counts[i] / total * 100) : 0;
        el.querySelector('.meter').style.width = p + '%';
        el.querySelector('.pct').textContent = t('pct', { p });
      });
    }, 500 + n * 70);
    if (q.bonus) {
      const names = st.bonusRight || [];
      $('bonusNames').innerHTML = `<h3>${names.length ? t('rightNames') : t('nobodyRight')}</h3>` + names.map((nm, i) => `<span class="nm" style="animation-delay:${1.5 + i * .15}s">${esc(nm)}</span>`).join('');
      $('bonusNames').className = 'bonus-names glass';
      if (names.length) setTimeout(() => { fx.confetti(140); audio.sfx('applause'); }, 1500);
    }
    setTimeout(() => $('jar').classList.add('hidden'), 1600);
    if (st.round) showRoundCards(st.round, 3200);
  }, 2400);
}

function showRoundCards(rs, delay) {
  const box = $('sideCards');
  box.innerHTML = `<div class="side-card smart"><img src="themes/base/badge-smart.webp" alt=""><div><h4>${t('roundSmart')}</h4><b>${esc(rs.smart.name)}</b><span>${t('correctOf', { n: rs.smart.correct })}</span></div></div>
    <div class="side-card fast"><img src="themes/base/badge-fast.webp" alt=""><div><h4>${t('roundFast')}</h4><b>${esc(rs.fast.name)}</b><span>${t('avgSec', { s: rs.fast.avg })}</span></div></div>`;
  box.className = '';
  setTimeout(() => { box.className = 'in'; audio.sfx('bonus'); }, delay);
  setTimeout(() => { box.className = 'out'; }, delay + 5200);
}

function renderBoard() {
  $('sideCards').className = 'out';
  show('board'); audio.play('final'); flash(); push();
  setTimeout(() => audio.say('announce-leaders', t('leaders')), 500);
  const r = S.ranking.slice(0, 5), H = 124, trophy = ['trophy-gold', 'trophy-silver', 'trophy-bronze'];
  const prev = (S.prevRanking || []).map(p => p.name), first = S.qIndex + 1 <= S.roundSize;
  const prevScore = n => (S.prevRanking.find(x => x.name === n) || {}).score || 0;
  $('boardRows').innerHTML = r.map((p, i) => {
    let from = prev.indexOf(p.name); if (from < 0 || from > 5) from = 5;
    return `<div class="brow ${first ? 'r' + (i + 1) : (from < 3 ? 'r' + (from + 1) : '')}" data-from="${from}" data-i="${i}" style="top:${i * H}px">
      <span class="rk">${first ? i + 1 : from + 1}</span>${i < 3 ? `<img src="themes/base/${trophy[i]}.webp" alt="">` : ''}
      <span class="nm">${esc(p.name)}</span>${i === 0 ? '<img class="crown" src="themes/base/crown.webp" alt="" onerror="this.outerHTML=\'<span class=crown>👑</span>\'">' : ''}
      <span class="up">▲</span><span class="sc" data-from="${first ? 0 : prevScore(p.name)}" data-to="${p.score}">${first ? 0 : prevScore(p.name)}</span></div>`;
  }).join('');
  const rows = [...document.querySelectorAll('.brow')];
  if (first) {   // first time: reveal from 5th place up to 1st
    rows.slice().reverse().forEach((el, k) => setTimeout(() => {
      el.classList.add('show'); spot(el); countUp(el.querySelector('.sc'), 0, +el.querySelector('.sc').dataset.to, 700, 0);
      audio.sfx(k === rows.length - 1 ? 'reveal' : 'whoosh');
      if (k === rows.length - 1) { el.classList.add('crowned'); fx.confetti(220); fx.show(4, 400); audio.sfx('applause'); }
    }, 1800 + k * 900));
    return;
  }
  // later rounds: show the old order, then everyone slides to the new place
  rows.forEach(el => { el.style.transform = `translateY(${(+el.dataset.from - +el.dataset.i) * H}px)`; el.classList.add('show', 'still'); });
  setTimeout(() => {
    rows.forEach(el => {
      el.classList.remove('still', 'r1', 'r2', 'r3'); el.style.transform = '';
      if (+el.dataset.i < 3) el.classList.add('r' + (+el.dataset.i + 1));
      el.querySelector('.rk').textContent = +el.dataset.i + 1;
      if (+el.dataset.from > +el.dataset.i) el.classList.add('moved');
      countUp(el.querySelector('.sc'), +el.querySelector('.sc').dataset.from, +el.querySelector('.sc').dataset.to, 1400, 0);
    });
    audio.sfx('whoosh');
    if (rows.some(el => +el.dataset.from > +el.dataset.i)) setTimeout(() => audio.sfx('bonus'), 500);
  }, 2600);
  setTimeout(() => { rows[0].classList.add('crowned'); spot(rows[0]); fx.confetti(220); fx.show(4, 400); audio.sfx('applause'); }, 4300);
}
function spot(el) {   // a spotlight drops onto the row as it appears
  const sp = document.createElement('div'); sp.className = 'row-spot';
  sp.style.top = (el.offsetTop - 600) + 'px'; el.parentNode.appendChild(sp);
  setTimeout(() => sp.remove(), 1400);
}
function countUp(el, from, to, dur, delay) {
  setTimeout(() => { const t0 = performance.now();
    (function step(now) { const k = Math.min(1, (now - t0) / dur); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); })(t0);
  }, delay);
}

function renderFinal() {
  $('sideCards').className = 'out';
  show('final'); audio.play('final'); fx.lights(true); flash();
  setTimeout(() => audio.say('announce-winners', t('winners')), 600);
  clearInterval(renderFinal.t); renderFinal.t = setInterval(() => { if (S && S.status === 'finished') { fx.show(2, 500); fx.confetti(40); } else clearInterval(renderFinal.t); }, 4000);
  const r = S.ranking, tr = { 1: 'trophy-gold', 2: 'trophy-silver', 3: 'trophy-bronze' };
  [1, 2, 3].forEach(n => {
    const p = r[n - 1], el = $('pod' + n); el.classList.remove('in');
    el.innerHTML = p ? `<img src="themes/base/${tr[n]}.webp" alt=""><div class="who">${esc(p.name)}</div><div class="pts">${p.score} ${t('points')}</div>` : '';
  });
  $('finalRest').innerHTML = r.slice(3, 12).map((p, i) => `<div><span>${i + 4}. ${esc(p.name)}</span><span>${p.score}</span></div>`).join('');
  $('finalRest').className = 'final-rest' + (r.length > 3 ? ' glass' : '');
  $('finalRest').style.padding = r.length > 3 ? '16px' : '0';
  const steps = [[3, 1500], [2, 2900], [1, 4500]];
  steps.forEach(([n, at]) => setTimeout(() => {
    if (!r[n - 1]) return;
    $('pod' + n).classList.add('in'); flash();
    if (n === 1) { audio.sfx('applause'); fx.show(10, 380); fx.confetti(300); } else audio.sfx('reveal');
  }, at));
  $('finalFoot').innerHTML = S.kind === 'demo'
    ? `${esc(t('demoDone'))}<br><button class="btn gold" id="againBtn">${esc(t('demoAgain'))}</button>`
    : esc(t('finalSub'));
  const ab = $('againBtn'); if (ab) ab.onclick = () => act('again');
}

// ---------- polling ----------
async function poll() {
  try {
    const st = await api('/api/game');
    if (st.error) { $('msgTitle').textContent = t(st.error); $('msgSub').textContent = t('askOrganizer'); show('msg'); return; }
    fetchedAt = Date.now(); prevS = S; S = st; render();
  } catch (e) { /* server waking up */ }
}

(async () => {
  try { L = await (await fetch('lang/' + (document.documentElement.lang || 'he') + '.json')).json(); } catch { L = {}; }
  applyTexts();
  $('msgTitle').textContent = t('connecting'); show('msg');
  if (!TOKEN) { $('msgTitle').textContent = t('linkBad'); return; }
  poll(); setInterval(poll, 600);
})();
})();
