'use strict';

/* =========================================================================
   Explore tab — shows an imported file or a snapshot of the live session,
   kept completely separate from the live session itself.
   Uses helpers defined in app.js: $, state, ZONES, zoneBounds, zoneOf,
   formatDuration, colors, css, GAP_MS.
   ========================================================================= */

const ex = {
  data: null,   // { samples: [{t, hr}], rr: [{t, ms}], start, age, label }
  stats: null,  // whole-data stats
  view: null,   // { t0, t1 } — visible time range in the main chart
  hover: null,  // index of the sample under the pointer
  geom: null,   // main chart geometry from the last draw { l, pw }
};

const exEls = {
  importBtn: $('exImportBtn'),
  liveBtn: $('exLiveBtn'),
  jsonBtn: $('exJsonBtn'),
  csvBtn: $('exCsvBtn'),
  clearBtn: $('exClearBtn'),
  file: $('exFile'),
  source: $('exSource'),
  empty: $('exEmpty'),
  body: $('exBody'),
  dur: $('exDur'),
  avg: $('exAvg'),
  max: $('exMax'),
  min: $('exMin'),
  inView: $('exInView'),
  chartWrap: $('exChartWrap'),
  chart: $('exChart'),
  overview: $('exOverview'),
  zones: $('exZones'),
  zonesNote: $('exZonesNote'),
};

const MIN_SPAN = 30 * 1000; // can't zoom in closer than 30 seconds
// zone colors from CSS; re-read when switching light/dark mode
let zoneColors = [];
const readZoneColors = () => { zoneColors = [1, 2, 3, 4, 5].map((i) => css.getPropertyValue(`--z${i}`).trim()); };
readZoneColors();

/* ============================================================ helpers */

const pad2 = (n) => String(n).padStart(2, '0');

function fmtClock(t, withSec = false) {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSec ? `:${pad2(d.getSeconds())}` : ''}`;
}

function fmtDate(t) {
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${fmtClock(t)}`;
}

function fileStamp(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// withAlpha() lives in app.js

/** First index whose time is >= t (binary search; samples are sorted by time). */
function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Age used for zones: your age setting, otherwise the one saved in the file. */
function exAge() { return settings.age || (ex.data && ex.data.age) || null; }

/** Max HR for this data: your override if set, otherwise from the age with the chosen formula. */
function exMax() { return settings.maxOverride || maxFromAge(exAge()); }

function statsOf(s, i0 = 0, i1 = s.length) {
  if (i1 - i0 <= 0) return null;
  let sum = 0, max = -Infinity, min = Infinity, maxIdx = i0;
  for (let i = i0; i < i1; i++) {
    const v = s[i].hr;
    sum += v;
    if (v > max) { max = v; maxIdx = i; }
    if (v < min) min = v;
  }
  return { avg: sum / (i1 - i0), max, min, maxIdx, duration: s[i1 - 1].t - s[i0].t };
}

/** ms per zone (index 0 = below Zone 1), same rule as the live session. */
function zoneTimes(s, max) {
  const out = [0, 0, 0, 0, 0, 0];
  for (let i = 1; i < s.length; i++) {
    out[zoneOf(s[i - 1].hr, max).z] += Math.min(s[i].t - s[i - 1].t, 3000);
  }
  return out;
}

function fullRange() {
  const s = ex.data.samples;
  return { a: s[0].t, b: Math.max(s[s.length - 1].t, s[0].t + MIN_SPAN) };
}

/** Keep the view inside the data and between 30 s and the whole session wide. */
function clampView(t0, t1) {
  const { a, b } = fullRange();
  const span = Math.min(Math.max(t1 - t0, MIN_SPAN), b - a);
  t0 = Math.min(Math.max(t0, a), b - span);
  return { t0, t1: t0 + span };
}

/* ======================================================= load / clear */

function setData(d) {
  ex.data = d && d.samples.length ? d : null;
  ex.hover = null;
  ex.stats = ex.data ? statsOf(ex.data.samples) : null;
  if (ex.data) { const r = fullRange(); ex.view = { t0: r.a, t1: r.b }; }
  renderExplorer();
}

function loadLive() {
  if (!state.samples.length) {
    alert('No live data yet. Connect your strap or start Demo first.');
    return;
  }
  setData({
    samples: state.samples.map((p) => ({ t: p.t, hr: p.hr })),
    rr: state.rr.map((r) => ({ t: r.t, ms: r.ms })),
    start: state.stats.start ?? state.samples[0].t,
    age: settings.age,
    label: `Live session snapshot · taken at ${fmtClock(Date.now(), true)}`,
  });
}

async function importFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (!obj || obj.app !== 'hrwatch' || !Array.isArray(obj.samples)) {
      throw new Error('this is not an HR Watch export file');
    }
    const samples = obj.samples
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0)
      .map(([t, hr]) => ({ t, hr }))
      .sort((a, b) => a.t - b.t);
    if (!samples.length) throw new Error('the file has no heart rate readings');
    const rr = (Array.isArray(obj.rr) ? obj.rr : [])
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map(([t, ms]) => ({ t, ms }));
    const age = Number(obj.age);
    setData({
      samples,
      rr,
      start: Number.isFinite(obj.start) ? obj.start : samples[0].t,
      age: age >= 10 && age <= 100 ? age : null,
      label: `${file.name} · ${fmtDate(samples[0].t)}`,
    });
  } catch (err) {
    alert(`Couldn't import "${file.name}": ${err.message}`);
  } finally {
    exEls.file.value = ''; // allow picking the same file again
  }
}

/* ============================================================ export */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  const d = ex.data;
  if (!d) return;
  const out = {
    app: 'hrwatch',
    version: 1,
    exportedAt: new Date().toISOString(),
    start: d.start,
    age: exAge(),
    samples: d.samples.map((p) => [p.t, p.hr]),
    rr: d.rr.map((r) => [r.t, Math.round(r.ms * 10) / 10]),
  };
  download(`hrwatch-${fileStamp(d.samples[0].t)}.json`, JSON.stringify(out), 'application/json');
}

function exportCsv() {
  const d = ex.data;
  if (!d) return;
  const max = exMax();
  const sep = settings.csvSep; // comma, or semicolon for Excel with European settings
  const t0 = d.samples[0].t;
  const lines = [['time', 'elapsed_s', 'bpm', 'zone'].join(sep)];
  for (const p of d.samples) {
    const dt = new Date(p.t);
    const time = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${fmtClock(p.t, true)}`;
    lines.push([time, Math.round((p.t - t0) / 1000), p.hr, max ? zoneOf(p.hr, max).z : ''].join(sep));
  }
  download(`hrwatch-${fileStamp(t0)}.csv`, lines.join('\r\n'), 'text/csv');
}

/* ======================================================== page (DOM) */

function renderExplorer() {
  const d = ex.data;
  exEls.empty.hidden = !!d;
  exEls.body.hidden = !d;
  exEls.jsonBtn.disabled = exEls.csvBtn.disabled = exEls.clearBtn.disabled = !d;
  exEls.source.textContent = d ? d.label : '';
  if (!d) return;

  const st = ex.stats;
  exEls.dur.textContent = formatDuration(st.duration);
  exEls.avg.textContent = Math.round(st.avg);
  exEls.max.textContent = st.max;
  exEls.min.textContent = st.min;

  // time in zones
  const max = exMax();
  if (!max) {
    exEls.zonesNote.textContent = '';
    exEls.zones.innerHTML = '<div class="muted">Enter your age or max heart rate in ⚙ Settings to see time in zones.</div>';
  } else {
    const zt = zoneTimes(d.samples, max);
    const total = zt.reduce((a, b) => a + b, 0) || 1;
    exEls.zonesNote.textContent = settings.maxOverride
      ? `max HR ${max} (your override)`
      : `max HR ${max} (age ${exAge()}${settings.age ? '' : ', from file'})`;
    const row = (name, color, ms) => {
      const pct = (ms / total) * 100;
      return `<div class="ex-zone-row" style="--zc:${color}">
          <span class="ex-zone-name">${name}</span>
          <div class="ex-zone-track"><div class="ex-zone-bar" style="width:${pct}%"></div></div>
          <span class="ex-zone-val">${formatDuration(ms)} · ${Math.round(pct)}%</span>
        </div>`;
    };
    let html = ZONES.map((z, i) => row(`Z${i + 1} · ${z.name}`, z.color, zt[i + 1])).join('');
    if (zt[0] > 0) html += row('Below Z1', 'var(--muted)', zt[0]);
    exEls.zones.innerHTML = html;
  }
  requestExDraw();
}

/* ============================================================ drawing */

let exDrawPending = false;
function requestExDraw() {
  if (exDrawPending) return;
  exDrawPending = true;
  requestAnimationFrame(() => {
    exDrawPending = false;
    if (!ex.data || !exEls.chart.offsetParent) return; // nothing loaded or tab hidden
    drawExMain();
    drawExOverview();
  });
}

function prepCanvas(canvas) {
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
  return { ctx, w, h };
}

// x-axis tick spacing options (ms); the smallest that leaves ~80px between labels is used
const EX_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map((s) => s * 1000);

function drawExMain() {
  const { ctx, w, h } = prepCanvas(exEls.chart);
  const s = ex.data.samples;
  const pad = { l: 38, r: 12, t: 12, b: 24 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const { t0, t1 } = ex.view;
  const span = t1 - t0;
  ex.geom = { l: pad.l, pw };

  // readings inside the view, plus one on each side so lines run to the edges
  const v0 = lowerBound(s, t0);
  const v1 = lowerBound(s, t1 + 1);
  const i0 = Math.max(0, v0 - 1);
  const i1 = Math.min(s.length, v1 + 1);
  const vs = statsOf(s, v0, v1);

  // "in view" summary line
  exEls.inView.innerHTML = vs
    ? `In view <strong>${fmtClock(t0)}–${fmtClock(t1)}</strong> (${formatDuration(span)}) · ` +
      `avg <strong>${Math.round(vs.avg)}</strong> · max <strong>${vs.max}</strong> · min <strong>${vs.min}</strong>`
    : `In view ${fmtClock(t0)}–${fmtClock(t1)} · no readings`;

  // y range fits what's visible
  const ref = vs || ex.stats;
  let lo = Math.floor((ref.min - 5) / 10) * 10;
  let hi = Math.ceil((ref.max + 5) / 10) * 10;
  if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 15) / 10) * 10; hi = lo + 30; }
  const x = (t) => pad.l + ((t - t0) / span) * pw;
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;

  // zone color bands behind everything
  const max = exMax();
  if (max) {
    zoneBounds(max).forEach((z, i) => {
      const top = y(Math.min(z.hi, hi));
      const bot = y(Math.max(z.lo, lo));
      if (bot > top) {
        ctx.fillStyle = withAlpha(zoneColors[i], 0.09);
        ctx.fillRect(pad.l, top, pw, bot - top);
      }
    });
  }

  // horizontal grid + bpm labels
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

  // vertical grid + clock-time labels
  const step = EX_STEPS.find((st) => (pw * st) / span >= 80) || EX_STEPS[EX_STEPS.length - 1];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const tx = Math.round(x(t)) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(tx, pad.t);
    ctx.lineTo(tx, pad.t + ph);
    ctx.stroke();
    ctx.fillStyle = colors.muted;
    ctx.fillText(fmtClock(t, step < 60000), tx, h - pad.b + 8);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, pw, ph);
  ctx.clip();

  // heart rate line, broken where data has gaps
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  grad.addColorStop(0, withAlpha(colors.accent, 0.28));
  grad.addColorStop(1, withAlpha(colors.accent, 0));
  let segStart = i0;
  for (let i = i0 + 1; i <= i1; i++) {
    if (i === i1 || s[i].t - s[i - 1].t > GAP_MS) {
      if (i - segStart >= 2) {
        ctx.beginPath();
        ctx.moveTo(x(s[segStart].t), pad.t + ph);
        for (let k = segStart; k < i; k++) ctx.lineTo(x(s[k].t), y(s[k].hr));
        ctx.lineTo(x(s[i - 1].t), pad.t + ph);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        for (let k = segStart; k < i; k++) {
          k === segStart ? ctx.moveTo(x(s[k].t), y(s[k].hr)) : ctx.lineTo(x(s[k].t), y(s[k].hr));
        }
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
      segStart = i;
    }
  }

  // whole-session average (dashed)
  const avg = ex.stats.avg;
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

  // mark the session maximum if it's in view
  const mp = s[ex.stats.maxIdx];
  if (mp.t >= t0 && mp.t <= t1) {
    ctx.fillStyle = colors.text;
    ctx.beginPath();
    ctx.arc(x(mp.t), y(mp.hr), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = x(mp.t) > w - 70 ? 'right' : 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`max ${mp.hr}`, x(mp.t) + (ctx.textAlign === 'left' ? 6 : -6), y(mp.hr) - 4);
  }
  ctx.restore();

  // hover: crosshair + tooltip
  if (ex.hover !== null && ex.hover >= i0 && ex.hover < i1) {
    const p = s[ex.hover];
    const px = x(p.t);
    const py = y(p.hr);
    ctx.strokeStyle = withAlpha(colors.text, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, pad.t);
    ctx.lineTo(Math.round(px) + 0.5, pad.t + ph);
    ctx.stroke();
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();

    const z = max ? zoneOf(p.hr, max).z : null;
    const text = `${fmtClock(p.t, true)}  ·  ${p.hr} bpm${z ? `  ·  Z${z}` : z === 0 ? '  ·  below Z1' : ''}`;
    ctx.font = '600 12px system-ui, sans-serif';
    const bw = ctx.measureText(text).width + 16;
    const bh = 24;
    let bx = px + 10;
    if (bx + bw > w - pad.r) bx = px - 10 - bw;
    const by = Math.max(pad.t, Math.min(py - bh - 10, pad.t + ph - bh));
    ctx.fillStyle = withAlpha(colors.surface, 0.95);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 8, by + bh / 2);
  }
}

function drawExOverview() {
  const { ctx, w, h } = prepCanvas(exEls.overview);
  const s = ex.data.samples;
  const { a, b } = fullRange();
  const lo = ex.stats.min - 5;
  const hi = ex.stats.max + 5;
  const x = (t) => ((t - a) / (b - a)) * w;
  const y = (v) => 4 + (1 - (v - lo) / (hi - lo)) * (h - 8);

  // whole session, thinned out so very long sessions stay fast
  const every = Math.max(1, Math.floor(s.length / (w * 2)));
  ctx.strokeStyle = withAlpha(colors.accent, 0.8);
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let i = 0; i < s.length; i += every) {
    const gap = i > 0 && s[i].t - s[i - every].t > GAP_MS * every;
    i === 0 || gap ? ctx.moveTo(x(s[i].t), y(s[i].hr)) : ctx.lineTo(x(s[i].t), y(s[i].hr));
  }
  ctx.stroke();

  // dim everything outside the visible window, outline the window
  const vx0 = x(ex.view.t0);
  const vx1 = x(ex.view.t1);
  ctx.fillStyle = withAlpha(colors.bg, 0.7); // dims the parts outside the view
  ctx.fillRect(0, 0, vx0, h);
  ctx.fillRect(vx1, 0, w - vx1, h);
  ctx.strokeStyle = colors.text;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(vx0 + 0.75, 0.75, Math.max(vx1 - vx0 - 1.5, 2), h - 1.5);
}

/* ==================================================== chart interaction */

function timeAtX(px) {
  const { l, pw } = ex.geom;
  return ex.view.t0 + ((px - l) / pw) * (ex.view.t1 - ex.view.t0);
}

function setHoverAt(px) {
  if (!ex.geom) return; // chart hasn't been drawn yet
  const s = ex.data.samples;
  const t = timeAtX(px);
  let i = lowerBound(s, t);
  if (i > 0 && (i === s.length || t - s[i - 1].t < s[i].t - t)) i -= 1;
  const span = ex.view.t1 - ex.view.t0;
  const distPx = (Math.abs(s[i].t - t) / span) * ex.geom.pw;
  ex.hover = distPx < 40 ? i : null;
  requestExDraw();
}

function zoomAround(anchorT, factor) {
  const { t0, t1 } = ex.view;
  const span = t1 - t0;
  const newSpan = span * factor;
  const nt0 = anchorT - ((anchorT - t0) / span) * newSpan;
  ex.view = clampView(nt0, nt0 + newSpan);
  requestExDraw();
}

const pointers = new Map(); // active touches / mouse on the main chart
let gesture = null;         // { type: 'pan' | 'pinch', ... }
let lastTap = 0;

function startGesture() {
  const pts = [...pointers.values()];
  const view = { ...ex.view };
  if (pts.length === 1) {
    gesture = { type: 'pan', x: pts[0].x, startX: pts[0].x, view, moved: false };
  } else if (pts.length >= 2) {
    const mid = (pts[0].x + pts[1].x) / 2;
    gesture = { type: 'pinch', dist: Math.max(20, Math.abs(pts[0].x - pts[1].x)), anchor: timeAtX(mid), view, moved: true };
  }
}

const chart = exEls.chart;

chart.addEventListener('pointerdown', (e) => {
  if (!ex.data) return;
  chart.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, type: e.pointerType });
  startGesture();
  exEls.chartWrap.classList.add('dragging');
});

chart.addEventListener('pointermove', (e) => {
  if (!ex.data) return;
  if (pointers.has(e.pointerId)) pointers.get(e.pointerId).x = e.offsetX;

  if (!gesture) {
    if (e.pointerType === 'mouse') setHoverAt(e.offsetX);
    return;
  }
  const pts = [...pointers.values()];
  const span = gesture.view.t1 - gesture.view.t0;

  if (gesture.type === 'pan') {
    const dx = pts[0].x - gesture.x;
    if (Math.abs(pts[0].x - gesture.startX) > 4) gesture.moved = true;
    if (!gesture.moved) return;
    const dt = (-dx / ex.geom.pw) * span;
    ex.view = clampView(gesture.view.t0 + dt, gesture.view.t1 + dt);
    ex.hover = null;
  } else if (pts.length >= 2) {
    const dist = Math.max(20, Math.abs(pts[0].x - pts[1].x));
    const mid = (pts[0].x + pts[1].x) / 2;
    const newSpan = span * (gesture.dist / dist);
    const nt0 = gesture.anchor - ((mid - ex.geom.l) / ex.geom.pw) * newSpan;
    ex.view = clampView(nt0, nt0 + newSpan);
    ex.hover = null;
  }
  requestExDraw();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const wasTap = gesture && gesture.type === 'pan' && !gesture.moved;
  pointers.delete(e.pointerId);

  if (wasTap && e.pointerType !== 'mouse') {
    // tap shows the value; a quick double tap shows everything
    const now = Date.now();
    if (now - lastTap < 300) { resetView(); lastTap = 0; } else { setHoverAt(e.offsetX); lastTap = now; }
  }
  if (pointers.size) startGesture(); // e.g. one finger lifted after a pinch
  else { gesture = null; exEls.chartWrap.classList.remove('dragging'); }
}
chart.addEventListener('pointerup', endPointer);
chart.addEventListener('pointercancel', endPointer);
chart.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse' && !gesture) { ex.hover = null; requestExDraw(); }
});

chart.addEventListener('wheel', (e) => {
  if (!ex.data) return;
  e.preventDefault();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    // sideways trackpad swipe = move
    const span = ex.view.t1 - ex.view.t0;
    const dt = (e.deltaX / ex.geom.pw) * span;
    ex.view = clampView(ex.view.t0 + dt, ex.view.t1 + dt);
    requestExDraw();
  } else {
    zoomAround(timeAtX(e.offsetX), Math.exp(e.deltaY * 0.0015));
  }
}, { passive: false });

function resetView() {
  const r = fullRange();
  ex.view = { t0: r.a, t1: r.b };
  requestExDraw();
}
chart.addEventListener('dblclick', resetView);

/* overview strip: click to jump, drag to move the window */
const ov = exEls.overview;
let ovDrag = null;
function ovTimeAt(px) {
  const { a, b } = fullRange();
  return a + (px / ov.clientWidth) * (b - a);
}
ov.addEventListener('pointerdown', (e) => {
  if (!ex.data) return;
  ov.setPointerCapture(e.pointerId);
  const t = ovTimeAt(e.offsetX);
  const span = ex.view.t1 - ex.view.t0;
  if (t < ex.view.t0 || t > ex.view.t1) ex.view = clampView(t - span / 2, t + span / 2);
  ovDrag = { x: e.offsetX, view: { ...ex.view } };
  requestExDraw();
});
ov.addEventListener('pointermove', (e) => {
  if (!ovDrag) return;
  const { a, b } = fullRange();
  const dt = ((e.offsetX - ovDrag.x) / ov.clientWidth) * (b - a);
  ex.view = clampView(ovDrag.view.t0 + dt, ovDrag.view.t1 + dt);
  requestExDraw();
});
ov.addEventListener('pointerup', () => { ovDrag = null; });
ov.addEventListener('pointercancel', () => { ovDrag = null; });

/* ============================================================ wiring */

exEls.importBtn.addEventListener('click', () => exEls.file.click());
exEls.file.addEventListener('change', () => { if (exEls.file.files[0]) importFile(exEls.file.files[0]); });
exEls.liveBtn.addEventListener('click', loadLive);
exEls.jsonBtn.addEventListener('click', exportJson);
exEls.csvBtn.addEventListener('click', exportCsv);
exEls.clearBtn.addEventListener('click', () => setData(null));

// age changes in Mode 2 update zones here too
// age / formula / max HR changes in Settings or Mode 2 update zones here too
document.addEventListener('hrwatch:settings', (e) => {
  if (e.detail === 'theme') { readZoneColors(); requestExDraw(); }
  if (ex.data && ['age', 'formula', 'maxOverride'].includes(e.detail)) renderExplorer();
});

// redraw when the tab becomes visible or the window is resized
new ResizeObserver(requestExDraw).observe(exEls.chartWrap);
document.querySelector('.tab[data-mode="3"]').addEventListener('click', requestExDraw);

renderExplorer();
