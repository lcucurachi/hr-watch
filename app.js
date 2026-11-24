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

const STALE_MS = 5000;                           // no data for this long = "--"
const GAP_MS = 5000;                              // chart line breaks on gaps longer than this

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

  age: null,                    // used for max HR = 220 − age
  zoneTime: [0, 0, 0, 0, 0, 0], // ms spent per zone; index 0 = below Zone 1
};

/* ---------------------------------------------------------------- settings */
try {
  const saved = Number(localStorage.getItem('hrwatch.windowMin'));
  if ([1, 5, 10, 30].includes(saved)) state.windowMin = saved;
  const age = Number(localStorage.getItem('hrwatch.age'));
  if (age >= 10 && age <= 100) state.age = age;
} catch { /* storage unavailable — use defaults */ }

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
    resetSession(); // manual connect = new session (auto-reconnect keeps it)
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
  // Signal dropped — try to reconnect with growing delays.
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (state.userDisconnect) return;
    setConn('reconnecting', `Signal lost — reconnecting (${attempt}/10)…`);
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
  addReading(m.hr, m.rr, m.contact);
}

/**
 * Decode the standard Heart Rate Measurement characteristic (0x2A37).
 * Byte 0 is a flags field telling us what follows.
 */
function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
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
    state.lastSampleAt = now;
    const s = state.stats;
    if (s.start === null) s.start = now;
    s.max = s.max === null ? hr : Math.max(s.max, hr);
    s.min = s.min === null ? hr : Math.min(s.min, hr);
    s.sum += hr;
    s.count += 1;
  }
  for (const ms of rrList) state.rr.push({ t: now, ms });

  renderLive();
  requestDraw();
}

function resetSession() {
  state.samples = [];
  state.rr = [];
  state.lastSampleAt = 0;
  state.stats = { max: null, min: null, sum: 0, count: 0, start: null };
  state.zoneTime = [0, 0, 0, 0, 0, 0];
  if (state.conn === 'connected' || state.conn === 'demo') state.stats.start = Date.now();
  renderLive();
  requestDraw();
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
  const fresh = state.lastSampleAt && now - state.lastSampleAt < STALE_MS;
  const last = state.samples[state.samples.length - 1];

  els.bpmValue.classList.toggle('idle', !(fresh && last));
  if (fresh && last) {
    els.bpmValue.textContent = last.hr;
    els.heart.classList.add('beating');
    document.documentElement.style.setProperty('--beat', `${(60 / last.hr).toFixed(3)}s`);
  } else {
    els.bpmValue.textContent = '--';
    els.heart.classList.remove('beating');
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

const css = getComputedStyle(document.documentElement);
const colors = {
  accent: css.getPropertyValue('--accent').trim(),
  muted: css.getPropertyValue('--muted').trim(),
  grid: css.getPropertyValue('--grid').trim(),
  text: css.getPropertyValue('--text').trim(),
};

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
  grad.addColorStop(0, 'rgba(255, 77, 94, 0.30)');
  grad.addColorStop(1, 'rgba(255, 77, 94, 0)');

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
  if (st.count) {
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
  if (last && now - last.t < STALE_MS) {
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

/* ===================================================== zones (Mode 2) */
// Standard 5-zone model as % of max heart rate; max HR = 220 − age.

const ZONES = [
  { name: 'Very light', from: 0.5, to: 0.6, color: 'var(--z1)' },
  { name: 'Light',      from: 0.6, to: 0.7, color: 'var(--z2)' },
  { name: 'Moderate',   from: 0.7, to: 0.8, color: 'var(--z3)' },
  { name: 'Hard',       from: 0.8, to: 0.9, color: 'var(--z4)' },
  { name: 'Maximum',    from: 0.9, to: 1.0, color: 'var(--z5)' },
];

function hrMax() { return state.age ? 220 - state.age : null; }

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
  const fresh = last && Date.now() - state.lastSampleAt < STALE_MS;
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
      z.bpm.innerHTML = `${last.hr}<small>bpm</small>`;
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

const ageInput = $('ageInput');
if (state.age) ageInput.value = state.age;
ageInput.addEventListener('input', () => {
  const v = Number(ageInput.value);
  state.age = v >= 10 && v <= 100 ? v : null;
  try { if (state.age) localStorage.setItem('hrwatch.age', state.age); } catch { /* ignore */ }
  renderZones();
});

/* ======================================================= screen wake lock */
// Keeps the screen from sleeping while you're watching your heart rate.

let wakeLock = null;
async function requestWakeLock() {
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
buildZones();
syncWindowPicker();
setConn('idle', 'Not connected');
requestDraw();
