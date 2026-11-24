'use strict';

/* =========================================================================
   HR Watch — connects to a Bluetooth heart rate strap (e.g. Polar H10)
   using Web Bluetooth and shows live BPM, session stats and a chart.
   Everything runs in the browser; nothing is sent anywhere.
   ========================================================================= */

const $ = (id) => document.getElementById(id);
const els = {
  connectBtn: $('connectBtn'),
  demoBtn: $('demoBtn'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  battery: $('battery'),
  unsupported: $('unsupported'),
  bpmValue: $('bpmValue'),
  heart: $('heart'),
  contact: $('contact'),
  statMax: $('statMax'),
  statAvg: $('statAvg'),
  statMin: $('statMin'),
  statTime: $('statTime'),
  windowPicker: $('windowPicker'),
  resetBtn: $('resetBtn'),
  chart: $('chart'),
};

/* -------------------------------------------- checks for outside data */
// Readings from imported files or browser storage are checked before use.
// Besides rejecting junk, the limits keep the charts' drawing loops small,
// so a crafted file can't freeze the page with absurd values.
const MIN_TIME = Date.UTC(2000, 0, 1);
const MAX_TIME = Date.UTC(2100, 0, 1);
const isValidTime = (t) => Number.isFinite(t) && t >= MIN_TIME && t <= MAX_TIME;
const isValidHr = (hr) => Number.isInteger(hr) && hr >= 20 && hr <= 300;   // bpm
const isValidRr = (ms) => Number.isFinite(ms) && ms >= 150 && ms <= 3000;  // ms between beats

/** Keep only well-formed [time, bpm] rows, as { t, hr } sorted by time. */
function cleanSamples(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => Array.isArray(p) && isValidTime(p[0]) && isValidHr(p[1]))
    .map(([t, hr]) => ({ t, hr }))
    .sort((a, b) => a.t - b.t);
}

/** Keep only well-formed [time, ms] beat-interval rows, as { t, ms }. */
function cleanRr(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => Array.isArray(p) && isValidTime(p[0]) && isValidRr(p[1]))
    .map(([t, ms]) => ({ t, ms }));
}

const GAP_MS = 5000;                            // chart line breaks on gaps longer than this

const state = {
  // conn: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'demo'
  conn: 'idle',
  device: null,
  userDisconnect: false,

  samples: [],       // { t: ms timestamp, hr: bpm } — whole session
  rr: [],            // { t, ms } — beat-to-beat intervals, whole session
  lastSampleAt: 0,
  windowMin: 5,

  stats: { max: null, min: null, sum: 0, count: 0, start: null },

  zoneTime: [0, 0, 0, 0, 0, 0], // ms spent per zone; index 0 = below Zone 1

  restored: false,  // true while showing a session restored after a reload
};

/* ================================================================ settings */
// Each setting is saved in localStorage as "hrwatch.<name>" (JSON) the moment it changes.

const isBool = (v) => v === true || v === false;
const intIn = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;

const SETTINGS = {
  age:            { def: null,      valid: (v) => v === null || intIn(10, 100)(v) },
  formula:        { def: 'classic', valid: (v) => v === 'classic' || v === 'tanaka' },
  maxOverride:    { def: null,      valid: (v) => v === null || intIn(100, 240)(v) },
  keepAwake:      { def: true,      valid: isBool },
  pulse:          { def: true,      valid: isBool },
  avgLine:        { def: true,      valid: isBool },
  staleSec:       { def: 5,         valid: intIn(2, 60) },
  reconnectTries: { def: 10,        valid: intIn(0, 50) },
  resumeMin:      { def: 1,         valid: intIn(0, 1440) },
  saveLocal:      { def: true,      valid: isBool },
  csvSep:         { def: ',',       valid: (v) => v === ',' || v === ';' },
  theme:          { def: null,      valid: (v) => v === null || v === 'light' || v === 'dark' }, // null = follow device
};

const settings = {};
for (const [key, spec] of Object.entries(SETTINGS)) {
  settings[key] = spec.def;
  try {
    const raw = localStorage.getItem(`hrwatch.${key}`);
    if (raw !== null) {
      const v = JSON.parse(raw);
      if (spec.valid(v)) settings[key] = v;
    }
  } catch { /* storage unavailable or bad value — keep the default */ }
}

try {
  const saved = Number(localStorage.getItem('hrwatch.windowMin'));
  if ([1, 5, 10, 30].includes(saved)) state.windowMin = saved;
} catch { /* storage unavailable — use defaults */ }

/** Change a setting: validate, save, apply. Returns false if the value isn't allowed. */
function setSetting(key, value) {
  if (!SETTINGS[key].valid(value)) return false;
  settings[key] = value;
  try {
    if (value === null) localStorage.removeItem(`hrwatch.${key}`);
    else localStorage.setItem(`hrwatch.${key}`, JSON.stringify(value));
  } catch { /* storage unavailable — still applies for this visit */ }
  applySetting(key);
  return true;
}

function applySetting(key) {
  const live = state.conn === 'connected' || state.conn === 'demo';
  switch (key) {
    case 'age':
    case 'formula':
    case 'maxOverride':
      if (state.samples.length) recomputeStats(state.stats.start); // zone times depend on max HR
      syncAgeInputs();
      renderMaxUsed();
      renderLive();
      break;
    case 'keepAwake':
      if (settings.keepAwake && live) requestWakeLock(); else releaseWakeLock();
      break;
    case 'pulse':
    case 'staleSec':
      renderLive();
      requestDraw();
      break;
    case 'avgLine':
      requestDraw();
      break;
    case 'theme':
      applyTheme();
      break;
    case 'saveLocal':
      if (settings.saveLocal) saveWholeSession();
      else {
        unsaved.samples = [];
        unsaved.rr = [];
        sessionStore.clear().catch((e) => console.warn('Could not clear saved session', e));
      }
      break;
  }
  // let other parts (e.g. Explore) react
  document.dispatchEvent(new CustomEvent('hrwatch:settings', { detail: key }));
}

const staleMs = () => settings.staleSec * 1000; // no data for this long = "--"

/* ======================================================= Bluetooth (BLE) */

// Standard Web Bluetooth, or the WebBLE Safari extension on iOS (fallback, untested).
// Checked each time because an extension may add it after the page has loaded.
const getBluetooth = () => navigator.bluetooth || navigator.webble || null;

async function connect() {
  stopDemo();
  state.userDisconnect = false;
  setConn('connecting', 'Choose your strap…');
  try {
    const device = await getBluetooth().requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['battery_service'],
    });
    state.device = device;
    // Manual connect = new session, unless it's a just-restored session that's recent enough
    // (auto-reconnect after a signal drop never gets here, so it always keeps the session)
    if (!canResumeRestored()) resetSession();
    state.restored = false;
    device.addEventListener('gattserverdisconnected', onDisconnected);
    await setupGatt(device);
  } catch (err) {
    console.warn(err);
    // Closing the picker without choosing is not an error; anything else is shown
    let msg = /cancelled/i.test(err.message) ? 'Not connected' : `Error: ${err.message}`;
    if (/globally disabled/i.test(err.message)) {
      msg = 'Bluetooth is off in this browser. In Brave, enable brave://flags/#brave-web-bluetooth-api, or use Chrome/Edge.';
    }
    setConn('idle', msg);
  }
}

async function setupGatt(device) {
  setConn(state.conn === 'reconnecting' ? 'reconnecting' : 'connecting',
          `Connecting to ${device.name || 'sensor'}…`);
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService('heart_rate');
  const hrChar = await service.getCharacteristic('heart_rate_measurement');
  hrChar.addEventListener('characteristicvaluechanged', onHeartRateNotification);
  await hrChar.startNotifications();

  if (state.stats.start === null) state.stats.start = Date.now();
  setConn('connected', device.name || 'Connected');
  readBattery(server);
  requestWakeLock();
}

function disconnect() {
  state.userDisconnect = true;
  if (state.device && state.device.gatt.connected) state.device.gatt.disconnect();
  else setConn('idle', 'Not connected');
}

async function onDisconnected() {
  els.battery.hidden = true;
  if (state.userDisconnect || !state.device) {
    setConn('idle', 'Disconnected');
    releaseWakeLock();
    return;
  }
  if (state.conn === 'reconnecting') return; // a reconnect loop is already running
  // Signal dropped — try to reconnect with growing delays (number of tries is a setting).
  const tries = settings.reconnectTries;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (state.userDisconnect) return;
    setConn('reconnecting', `Signal lost — reconnecting (${attempt}/${tries})…`);
    await sleep(Math.min(1000 * attempt, 8000));
    if (state.userDisconnect) return;
    try {
      await setupGatt(state.device);
      return;
    } catch (err) {
      console.warn('Reconnect failed', err);
    }
  }
  setConn('idle', 'Disconnected — press Connect to retry');
  releaseWakeLock();
}

async function readBattery(server) {
  try {
    const svc = await server.getPrimaryService('battery_service');
    const ch = await svc.getCharacteristic('battery_level');
    const show = (dv) => {
      els.battery.textContent = `🔋 ${dv.getUint8(0)}%`;
      els.battery.hidden = false;
    };
    show(await ch.readValue());
    try {
      ch.addEventListener('characteristicvaluechanged', (e) => show(e.target.value));
      await ch.startNotifications();
    } catch { /* battery notifications are optional */ }
  } catch {
    els.battery.hidden = true; // strap doesn't expose battery level
  }
}

function onHeartRateNotification(event) {
  const m = parseHeartRate(event.target.value);
  if (m) addReading(m.hr, m.rr, m.contact); // malformed packets are skipped
}

/**
 * Decode the standard Heart Rate Measurement characteristic (0x2A37).
 * Byte 0 is a flags field telling us what follows.
 */
function parseHeartRate(dv) {
  // too short to hold the flags + BPM it claims → ignore it (returns null)
  if (dv.byteLength < 2) return null;
  const flags = dv.getUint8(0);
  if ((flags & 0x01) && dv.byteLength < 3) return null;
  let i = 1;
  let hr;
  if (flags & 0x01) { hr = dv.getUint16(i, true); i += 2; } // 16-bit BPM
  else { hr = dv.getUint8(i); i += 1; }                     // 8-bit BPM

  const contactSupported = (flags & 0x04) !== 0;
  const contactDetected = (flags & 0x02) !== 0;

  if (flags & 0x08) i += 2; // energy expended field — skip it

  const rr = [];
  if (flags & 0x10) {
    // RR intervals come in units of 1/1024 s
    while (i + 1 < dv.byteLength) {
      rr.push((dv.getUint16(i, true) * 1000) / 1024);
      i += 2;
    }
  }
  return { hr, rr, contact: contactSupported ? contactDetected : true };
}

/* ============================================================ demo mode */

let demoTimer = null;
let demoHr = 72;
let demoT = 0;

function startDemo() {
  if (state.conn !== 'idle') return;
  resetSession();
  state.stats.start = Date.now();
  setConn('demo', 'Demo mode — simulated data');
  demoTimer = setInterval(() => {
    demoT += 1;
    // slow "workout" wave + random drift
    const target = 110 + 45 * Math.sin(demoT / 40) + 10 * Math.sin(demoT / 7);
    demoHr += (target - demoHr) * 0.08 + (Math.random() - 0.5) * 3;
    const hr = Math.round(demoHr);
    const rr = [60000 / hr + (Math.random() - 0.5) * 30];
    addReading(hr, rr, true);
  }, 1000);
}

function stopDemo() {
  if (!demoTimer) return;
  clearInterval(demoTimer);
  demoTimer = null;
  setConn('idle', 'Not connected');
}

/* ======================================================= data + stats */

function addReading(hr, rrList, contact) {
  const now = Date.now();
  els.contact.hidden = contact;

  // H10 reports 0 BPM when it has no skin contact — ignore those
  if (hr > 0) {
    // time in zone: credit the time since the previous reading to that reading's zone
    const prev = state.samples[state.samples.length - 1];
    const max = hrMax();
    if (prev && max) state.zoneTime[zoneOf(prev.hr, max).z] += Math.min(now - prev.t, 3000);

    state.samples.push({ t: now, hr });
    if (shouldSave()) unsaved.samples.push([now, hr]);
    state.lastSampleAt = now;
    const s = state.stats;
    if (s.start === null) s.start = now;
    s.max = s.max === null ? hr : Math.max(s.max, hr);
    s.min = s.min === null ? hr : Math.min(s.min, hr);
    s.sum += hr;
    s.count += 1;
  }
  for (const ms of rrList) {
    state.rr.push({ t: now, ms });
    if (shouldSave()) unsaved.rr.push([now, Math.round(ms * 10) / 10]);
  }

  renderLive();
  requestDraw();
}

function resetSession() {
  state.samples = [];
  state.rr = [];
  state.lastSampleAt = 0;
  state.stats = { max: null, min: null, sum: 0, count: 0, start: null };
  state.zoneTime = [0, 0, 0, 0, 0, 0];
  state.restored = false;
  if (state.conn === 'connected' || state.conn === 'demo') state.stats.start = Date.now();
  // forget the saved copy too
  unsaved.samples = [];
  unsaved.rr = [];
  sessionStore.clear().catch((e) => console.warn('Could not clear saved session', e));
  renderLive();
  requestDraw();
}

/* ================================================ saving + restoring */
// The live session is saved in IndexedDB (storage.js) every few seconds,
// so a page reload doesn't lose it.

const SAVE_EVERY_MS = 5000;
const unsaved = { samples: [], rr: [] }; // readings not written to the database yet

// demo data is never saved, and nothing is saved when the setting is off
const shouldSave = () => settings.saveLocal && state.conn !== 'demo';

/** Write the whole current session from scratch (used when saving is switched back on). */
function saveWholeSession() {
  unsaved.samples = [];
  unsaved.rr = [];
  const samples = state.conn === 'demo' ? [] : state.samples.map((p) => [p.t, p.hr]);
  const rr = state.conn === 'demo' ? [] : state.rr.map((r) => [r.t, Math.round(r.ms * 10) / 10]);
  sessionStore.clear()
    .then(() => (samples.length ? sessionStore.append(state.stats.start ?? samples[0][0], samples, rr) : null))
    .catch((e) => console.warn('Could not save session', e));
}

function saveNow() {
  if (!unsaved.samples.length && !unsaved.rr.length) return;
  const samples = unsaved.samples;
  const rr = unsaved.rr;
  unsaved.samples = [];
  unsaved.rr = [];
  sessionStore.append(state.stats.start ?? samples[0]?.[0] ?? Date.now(), samples, rr)
    .catch((e) => console.warn('Could not save session', e));
}

setInterval(saveNow, SAVE_EVERY_MS);
// also save right away when the tab is hidden, closed or reloaded
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', saveNow);

/** Recalculate max/avg/min and time in zones from the readings. */
function recomputeStats(start) {
  const s = { max: null, min: null, sum: 0, count: 0, start };
  const zt = [0, 0, 0, 0, 0, 0];
  const max = hrMax();
  state.samples.forEach((p, i) => {
    s.max = s.max === null ? p.hr : Math.max(s.max, p.hr);
    s.min = s.min === null ? p.hr : Math.min(s.min, p.hr);
    s.sum += p.hr;
    s.count += 1;
    const prev = state.samples[i - 1];
    if (prev && max) zt[zoneOf(prev.hr, max).z] += Math.min(p.t - prev.t, 3000);
  });
  state.stats = s;
  state.zoneTime = zt;
}

function canResumeRestored() {
  return state.restored && state.samples.length > 0
    && Date.now() - state.lastSampleAt < settings.resumeMin * 60 * 1000;
}

async function restoreSession() {
  try {
    const saved = await sessionStore.load();
    if (!saved || state.samples.length) return; // nothing saved, or already recording
    // check saved data like an imported file: other pages on the same site share this storage
    const samples = cleanSamples(saved.samples);
    if (!samples.length) return;
    state.samples = samples;
    state.rr = cleanRr(saved.rr);
    recomputeStats(isValidTime(saved.start) ? saved.start : samples[0].t);
    state.lastSampleAt = state.samples[state.samples.length - 1].t;
    state.restored = true;

    const from = new Date(state.stats.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setConn('idle', canResumeRestored()
      ? `Session from ${from} restored. Press Connect to continue it.`
      : `Session from ${from} restored. Connect will start a new one.`);
    requestDraw();
  } catch (e) {
    console.warn('Could not restore session', e);
  }
}

/* ============================================================== UI */

function setConn(conn, text) {
  state.conn = conn;
  els.statusText.textContent = text;
  els.statusDot.className = 'dot ' + ({
    connected: 'connected', connecting: 'busy', reconnecting: 'busy', demo: 'demo',
  }[conn] || '');

  const bleActive = conn === 'connected' || conn === 'connecting' || conn === 'reconnecting';
  els.connectBtn.textContent = bleActive ? 'Disconnect' : 'Connect';
  els.connectBtn.dataset.tip = bleActive
    ? 'Disconnect the strap. The session stays until you connect again.'
    : 'Pair with your heart rate strap. Starts a new session.';
  els.demoBtn.dataset.tip = conn === 'demo'
    ? 'Stop the simulated data.'
    : 'Play simulated heart rate data to try the app without the strap.';
  els.connectBtn.disabled = !getBluetooth() || conn === 'connecting';
  els.demoBtn.textContent = conn === 'demo' ? 'Stop demo' : 'Demo';
  els.demoBtn.classList.toggle('active', conn === 'demo');
  els.demoBtn.disabled = bleActive;
  renderLive();
}

function renderLive() {
  const now = Date.now();
  const fresh = state.lastSampleAt && now - state.lastSampleAt < staleMs();
  const last = state.samples[state.samples.length - 1];
  const showing = !!(fresh && last);

  els.bpmValue.classList.toggle('idle', !showing);
  els.heart.classList.toggle('live', showing);                     // red heart
  els.heart.classList.toggle('beating', showing && settings.pulse); // pulsing (setting)
  if (showing) {
    els.bpmValue.textContent = last.hr;
    document.documentElement.style.setProperty('--beat', `${(60 / last.hr).toFixed(3)}s`);
  } else {
    els.bpmValue.textContent = '--';
  }

  const s = state.stats;
  els.statMax.textContent = s.max ?? '--';
  els.statMin.textContent = s.min ?? '--';
  els.statAvg.textContent = s.count ? Math.round(s.sum / s.count) : '--';

  const live = state.conn === 'connected' || state.conn === 'demo' || state.conn === 'reconnecting';
  const end = live ? now : (state.lastSampleAt || s.start);
  els.statTime.textContent = s.start ? formatDuration(end - s.start) : '0:00';

  renderZones();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/* ============================================================ chart */

// Chart colors come from the CSS variables, re-read when switching light/dark mode.
const css = getComputedStyle(document.documentElement);
const colors = {};
function refreshColors() {
  for (const name of ['accent', 'muted', 'grid', 'text', 'bg', 'surface']) {
    colors[name] = css.getPropertyValue(`--${name}`).trim();
  }
}
refreshColors();

/** '#rrggbb' + opacity → 'rgba(…)' */
function withAlpha(hex, a) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

let drawPending = false;
function requestDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(drawChart);
}

// x-axis tick spacing for each window size
const TICK_SEC = { 1: 15, 5: 60, 10: 120, 30: 300 };

function drawChart() {
  drawPending = false;
  const canvas = els.chart;
  if (!canvas.offsetParent) return; // hidden (other tab)

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 38, r: 12, t: 12, b: 24 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const now = Date.now();
  const span = state.windowMin * 60 * 1000;
  const t0 = now - span;

  // visible points (+1 before the window so the line enters from the edge)
  let startIdx = state.samples.findIndex((p) => p.t >= t0);
  if (startIdx === -1) startIdx = state.samples.length;
  const pts = state.samples.slice(Math.max(0, startIdx - 1));
  const inView = state.samples.slice(startIdx);

  // y range: fit visible data with some headroom, at least 30 bpm tall
  let lo = 50, hi = 150;
  if (inView.length) {
    let mn = Infinity, mx = -Infinity;
    for (const p of inView) { if (p.hr < mn) mn = p.hr; if (p.hr > mx) mx = p.hr; }
    lo = Math.floor((mn - 5) / 10) * 10;
    hi = Math.ceil((mx + 5) / 10) * 10;
    if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 15) / 10) * 10; hi = lo + 30; }
  }
  const x = (t) => pad.l + ((t - t0) / span) * pw;
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;

  // grid + y labels
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  const yStep = hi - lo > 80 ? 20 : 10;
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, Math.round(y(v)) + 0.5);
    ctx.lineTo(w - pad.r, Math.round(y(v)) + 0.5);
    ctx.stroke();
    ctx.fillStyle = colors.muted;
    ctx.fillText(v, pad.l - 6, y(v));
  }

  // x labels: "now" at right, then -1m, -2m … (or seconds for the 1m window)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const tick = TICK_SEC[state.windowMin] * 1000;
  for (let back = 0; back <= span; back += tick) {
    const tx = x(now - back);
    const label = back === 0 ? 'now'
      : back < 60000 ? `-${back / 1000}s` : `-${back / 60000}m`;
    ctx.fillStyle = colors.muted;
    ctx.textAlign = back === 0 ? 'right' : back === span ? 'left' : 'center';
    ctx.fillText(label, tx, h - pad.b + 8);
  }

  // clip drawing to the plot area
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, pw, ph);
  ctx.clip();

  // split into segments where data has gaps
  const segments = [];
  let seg = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && pts[i].t - pts[i - 1].t > GAP_MS) { segments.push(seg); seg = []; }
    seg.push(pts[i]);
  }
  if (seg.length) segments.push(seg);

  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  grad.addColorStop(0, withAlpha(colors.accent, 0.3));
  grad.addColorStop(1, withAlpha(colors.accent, 0));

  for (const s of segments) {
    if (s.length < 2) continue;
    // area fill
    ctx.beginPath();
    ctx.moveTo(x(s[0].t), pad.t + ph);
    for (const p of s) ctx.lineTo(x(p.t), y(p.hr));
    ctx.lineTo(x(s[s.length - 1].t), pad.t + ph);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // line
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.hr)) : ctx.moveTo(x(p.t), y(p.hr))));
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // session average as a dashed line
  const st = state.stats;
  if (st.count && settings.avgLine) {
    const avg = st.sum / st.count;
    if (avg >= lo && avg <= hi) {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = colors.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, y(avg));
      ctx.lineTo(w - pad.r, y(avg));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colors.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`avg ${Math.round(avg)}`, pad.l + 6, y(avg) - 3);
    }
  }

  // dot on the latest reading
  const last = state.samples[state.samples.length - 1];
  if (last && now - last.t < staleMs()) {
    ctx.beginPath();
    ctx.arc(x(last.t), y(last.hr), 4, 0, Math.PI * 2);
    ctx.fillStyle = colors.accent;
    ctx.fill();
  }
  ctx.restore();

  if (!inView.length) {
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText(
      state.conn === 'idle' ? 'Connect your strap or press Demo' : 'Waiting for data…',
      pad.l + pw / 2, pad.t + ph / 2);
  }
}

/* ================================================== zones (Zone Mode) */
// Standard 5-zone model as % of max heart rate (from age + formula, or the override setting).

const ZONES = [
  { name: 'Very light', from: 0.5, to: 0.6, color: 'var(--z1)' },
  { name: 'Light',      from: 0.6, to: 0.7, color: 'var(--z2)' },
  { name: 'Moderate',   from: 0.7, to: 0.8, color: 'var(--z3)' },
  { name: 'Hard',       from: 0.8, to: 0.9, color: 'var(--z4)' },
  { name: 'Maximum',    from: 0.9, to: 1.0, color: 'var(--z5)' },
];

/** Max HR estimated from an age with the chosen formula. */
function maxFromAge(age) {
  if (!age) return null;
  return settings.formula === 'tanaka' ? Math.round(208 - 0.7 * age) : 220 - age;
}

/** Max HR used for the live session: the override if set, otherwise from your age. */
function hrMax() { return settings.maxOverride || maxFromAge(settings.age); }

function zoneBounds(max) {
  return ZONES.map((z) => ({ lo: Math.round(max * z.from), hi: Math.round(max * z.to) }));
}

/** Which zone a BPM falls in (0 = below Zone 1) and how far through that zone (0..1). */
function zoneOf(hr, max) {
  const b = zoneBounds(max);
  if (hr < b[0].lo) return { z: 0, pct: 0 };
  for (let i = ZONES.length - 1; i >= 0; i--) {
    if (hr >= b[i].lo) {
      return { z: i + 1, pct: Math.min(1, (hr - b[i].lo) / (b[i].hi - b[i].lo)) };
    }
  }
}

const zoneEls = [];   // index 0 = Zone 1
let lastActive = -1;  // bar index the cursor was in on the previous update

function buildZones() {
  const wrap = $('zones');
  for (let i = 0; i < ZONES.length; i++) { // Zone 1 on the left
    const el = document.createElement('div');
    el.className = 'zone';
    el.style.setProperty('--zc', ZONES[i].color);
    // short label shows on narrow (inactive) columns, full name on the active one
    el.innerHTML = `
      <div class="zone-fill"></div>
      <div class="zone-cursor"></div>
      <div class="zone-content">
        <div class="zone-label">
          <span class="zone-short">Z${i + 1}</span>
          <span class="zone-name">Zone ${i + 1} · ${ZONES[i].name}</span>
          <span class="zone-range"></span>
        </div>
        <span class="zone-bpm"></span>
        <span class="zone-time">0:00</span>
      </div>`;
    wrap.appendChild(el);
    zoneEls[i] = {
      el,
      range: el.querySelector('.zone-range'),
      time: el.querySelector('.zone-time'),
      bpm: el.querySelector('.zone-bpm'),
    };
  }
}

function renderZones() {
  const max = hrMax();
  $('hrMaxValue').textContent = max ?? '--';
  $('zonesHint').hidden = !!max;

  const bounds = max ? zoneBounds(max) : null;
  const last = state.samples[state.samples.length - 1];
  const fresh = last && Date.now() - state.lastSampleAt < staleMs();
  const cur = max && fresh ? zoneOf(last.hr, max) : null;
  $('zones').classList.toggle('no-data', !cur);

  // Below Zone 1 the cursor rests at the start of the Zone 1 bar
  const active = cur ? Math.max(cur.z, 1) - 1 : -1;
  const pct = cur ? cur.pct : 0;

  // Entering a different bar: place its cursor on the side we came from, then slide
  if (active !== -1 && lastActive !== -1 && active !== lastActive) {
    const el = zoneEls[active].el;
    const start = active > lastActive ? '0%' : '100%';
    el.classList.add('no-anim');
    el.style.setProperty('--pos', start);
    el.style.setProperty('--fill', start);
    void el.offsetWidth; // apply the start position instantly
    el.classList.remove('no-anim');
  }
  lastActive = active;

  zoneEls.forEach((z, i) => {
    z.range.textContent = bounds
      ? `${bounds[i].lo}–${bounds[i].hi} bpm`
      : `${ZONES[i].from * 100}–${ZONES[i].to * 100}% of max`;
    z.time.textContent = formatDuration(state.zoneTime[i + 1]);

    const isActive = i === active;
    z.el.classList.toggle('active', isActive);
    // zones below the current one are full, the current one fills up to the cursor
    const fill = active === -1 ? 0 : i < active ? 100 : isActive ? pct * 100 : 0;
    z.el.style.setProperty('--fill', `${fill}%`);
    if (isActive) {
      z.el.style.setProperty('--pos', `${pct * 100}%`);
      // built as plain text (never HTML), so a reading can't inject markup
      const unit = document.createElement('small');
      unit.textContent = 'bpm';
      z.bpm.replaceChildren(String(last.hr), unit);
    }
  });

  // headline above the bars
  const head = $('zoneNow');
  if (!cur) {
    head.textContent = max ? 'Waiting for data…' : 'Heart rate zones';
    head.style.removeProperty('--zone-now-color');
  } else {
    const ofMax = `<small>${Math.round((last.hr / max) * 100)}% of max</small>`;
    head.innerHTML = cur.z === 0 ? `Rest ${ofMax}` : `Zone ${cur.z} · ${ZONES[cur.z - 1].name} ${ofMax}`;
    head.style.setProperty('--zone-now-color', cur.z === 0 ? 'var(--muted)' : ZONES[cur.z - 1].color);
  }
}

// Age appears in two places (Zone Mode and Settings); both edit the same setting.
const ageInput = $('ageInput');
const setAgeInput = $('setAge');

function syncAgeInputs() {
  for (const el of [ageInput, setAgeInput]) {
    if (document.activeElement !== el) el.value = settings.age ?? '';
  }
}

ageInput.addEventListener('input', () => {
  const v = Number(ageInput.value);
  setSetting('age', ageInput.value !== '' && Number.isInteger(v) && v >= 10 && v <= 100 ? v : null);
});

/* ========================================================= light / dark */

const themeBtn = $('themeBtn');
const systemLight = matchMedia('(prefers-color-scheme: light)');

/** The mode in use: your choice, or the device's setting if you haven't chosen. */
function currentTheme() {
  return settings.theme || (systemLight.matches ? 'light' : 'dark');
}

function applyTheme() {
  const theme = currentTheme();
  document.documentElement.dataset.theme = theme;
  refreshColors();
  // phone status bar color
  document.querySelector('meta[name="theme-color"]').content = colors.bg;
  // the button offers the other mode
  const next = theme === 'dark' ? 'light' : 'dark';
  themeBtn.textContent = next === 'light' ? '☀︎' : '☾︎';
  themeBtn.setAttribute('aria-label', `Switch to ${next} mode`);
  themeBtn.dataset.tip = `Switch to ${next} mode.`;
  requestDraw();
}

themeBtn.addEventListener('click', () => {
  setSetting('theme', currentTheme() === 'dark' ? 'light' : 'dark');
});
// follow the device when it switches, unless you've picked a mode
systemLight.addEventListener('change', () => {
  if (!settings.theme) {
    applyTheme();
    document.dispatchEvent(new CustomEvent('hrwatch:settings', { detail: 'theme' }));
  }
});

/* ======================================================= screen wake lock */
// Keeps the screen from sleeping while you're watching your heart rate.

let wakeLock = null;
async function requestWakeLock() {
  if (!settings.keepAwake) return; // setting
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or denied — fine */ }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (state.conn === 'connected' || state.conn === 'demo')) {
    requestWakeLock();
  }
});

/* ============================================================ wiring */

els.connectBtn.addEventListener('click', () => {
  if (['connected', 'connecting', 'reconnecting'].includes(state.conn)) disconnect();
  else connect();
});

els.demoBtn.addEventListener('click', () => {
  if (state.conn === 'demo') { stopDemo(); releaseWakeLock(); }
  else { startDemo(); requestWakeLock(); }
});

els.resetBtn.addEventListener('click', resetSession);

/* ------------------------------------------------------ settings panel */

const settingsDialog = $('settingsDialog');

/** Show the current values in the panel's fields. */
function fillSettingsForm() {
  syncAgeInputs();
  $('setMaxOverride').value = settings.maxOverride ?? '';
  $('setKeepAwake').checked = settings.keepAwake;
  $('setPulse').checked = settings.pulse;
  $('setAvgLine').checked = settings.avgLine;
  $('setStale').value = settings.staleSec;
  $('setReconnect').value = settings.reconnectTries;
  $('resumeInput').value = settings.resumeMin;
  $('setSaveLocal').checked = settings.saveLocal;
  for (const r of document.querySelectorAll('input[name="setFormula"]')) r.checked = r.value === settings.formula;
  for (const r of document.querySelectorAll('input[name="setCsvSep"]')) r.checked = r.value === settings.csvSep;
  renderMaxUsed();
}

/** "Max HR used: 185 (from age 35, 220 − age)" line under the override field. */
function renderMaxUsed() {
  const el = $('setMaxUsed');
  const max = hrMax();
  if (!max) { el.textContent = 'Enter your age or a max heart rate to calculate your zones.'; return; }
  const how = settings.maxOverride
    ? 'your override'
    : `age ${settings.age}, ${settings.formula === 'tanaka' ? '208 − 0.7 × age' : '220 − age'}`;
  el.innerHTML = `Max heart rate used: <strong>${max} bpm</strong> (${how})`;
}

/** Number field → setting. Invalid values snap back to the current one. */
function bindNumber(id, key, allowEmpty = false) {
  const el = $(id);
  el.addEventListener('change', () => {
    const raw = el.value.trim();
    const v = raw === '' ? null : Math.round(Number(raw));
    if ((raw === '' && !allowEmpty) || !setSetting(key, v)) el.value = settings[key] ?? '';
    else el.value = v ?? '';
  });
}
function bindCheckbox(id, key) {
  $(id).addEventListener('change', (e) => setSetting(key, e.target.checked));
}
function bindRadios(name, key) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
    r.addEventListener('change', () => { if (r.checked) setSetting(key, r.value); });
  }
}

bindNumber('setAge', 'age', true);
bindRadios('setFormula', 'formula');
bindNumber('setMaxOverride', 'maxOverride', true);
bindCheckbox('setKeepAwake', 'keepAwake');
bindCheckbox('setPulse', 'pulse');
bindCheckbox('setAvgLine', 'avgLine');
bindNumber('setStale', 'staleSec');
bindNumber('setReconnect', 'reconnectTries');
bindNumber('resumeInput', 'resumeMin');
bindCheckbox('setSaveLocal', 'saveLocal');
bindRadios('setCsvSep', 'csvSep');

$('settingsBtn').addEventListener('click', () => {
  fillSettingsForm();
  settingsDialog.showModal();
});
$('settingsClose').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) settingsDialog.close(); });

// "Delete saved data": saved session + every hrwatch.* setting, then start fresh
$('deleteDataBtn').addEventListener('click', async () => {
  if (!confirm('Delete the saved session and all settings from this browser?\nThe app will reload and the current session will be lost.')) return;
  settings.saveLocal = false; // stop any save from running while we clear
  unsaved.samples = [];
  unsaved.rr = [];
  try { await sessionStore.clear(); } catch (e) { console.warn('Could not clear saved session', e); }
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('hrwatch.')) localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
  location.reload();
});

function syncWindowPicker() {
  for (const b of els.windowPicker.querySelectorAll('button')) {
    b.classList.toggle('active', Number(b.dataset.min) === state.windowMin);
  }
}
els.windowPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.windowMin = Number(btn.dataset.min);
  try { localStorage.setItem('hrwatch.windowMin', state.windowMin); } catch { /* ignore */ }
  syncWindowPicker();
  requestDraw();
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    for (const t of document.querySelectorAll('.tab')) {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
    }
    for (const m of ['1', '2', '3']) $(`mode${m}`).hidden = mode !== m;
    requestDraw();
  });
}

new ResizeObserver(requestDraw).observe(els.chart.parentElement);

// once a second: scroll the chart, update timer, catch stale data
setInterval(() => { renderLive(); requestDraw(); }, 1000);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ============================================================ start */

if (!getBluetooth()) els.unsupported.hidden = false;
// re-check once everything (including browser extensions) has loaded
window.addEventListener('load', () => {
  els.unsupported.hidden = !!getBluetooth();
  setConn(state.conn, els.statusText.textContent);
});
applyTheme();
buildZones();
syncAgeInputs();
syncWindowPicker();
setConn('idle', 'Not connected');
requestDraw();
restoreSession();
