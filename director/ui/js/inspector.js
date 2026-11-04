// Right panel: the speed (retime) graph for the active path, and settings for whatever is selected.
import { S, on, emit, commit, live, select, findPath, toast } from './state.js';
import * as M from './model.js';
import * as VP from './viewport.js';
import * as P from './program.js';
import { seek } from './timeline.js';

const root = document.getElementById('inspector');
let updaters = [];

// ---------- small widgets ----------

// Number field you can drag on its label (like Resolve's inspector) or type into.
function num(label, get, set, o = {}) {
  const row = document.createElement('div');
  row.className = 'f';
  row.innerHTML = `<label title="Drag left/right to change">${label}</label><input type="text" spellcheck="false">${o.unit ? `<span class="u">${o.unit}</span>` : ''}`;
  const lab = row.querySelector('label'), inp = row.querySelector('input');
  const digits = o.digits ?? 2, step = o.step ?? 0.01;
  const show = () => { if (document.activeElement !== inp) { const v = get(); inp.value = v == null || isNaN(v) ? '' : (+v).toFixed(digits); } };
  const apply = v => { if (o.min != null) v = Math.max(o.min, v); if (o.max != null) v = Math.min(o.max, v); set(v); };
  lab.onpointerdown = e => {
    lab.setPointerCapture(e.pointerId);
    let x = e.clientX, v = +get() || 0;
    const mv = ev => { v += (ev.clientX - x) * step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1); x = ev.clientX; apply(v); live(); };
    const up = () => { lab.removeEventListener('pointermove', mv); lab.removeEventListener('pointerup', up); commit(); };
    lab.addEventListener('pointermove', mv); lab.addEventListener('pointerup', up);
  };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = ''; inp.blur(); } };
  inp.onchange = () => { const v = parseFloat(inp.value); if (!isNaN(v)) { apply(v); commit(); } show(); };
  inp.onblur = show;
  show();
  updaters.push(show);
  return row;
}
function xyz(label, get, set, o = {}) {
  const box = document.createElement('div');
  box.className = 'xyz';
  box.innerHTML = `<div class="xyz-l">${label}</div>`;
  ['X', 'Y', 'Z'].forEach((a, i) => {
    const f = num(a, () => get()?.[i], v => { const p = [...get()]; p[i] = v; set(p); }, { step: o.step ?? 0.005, digits: o.digits ?? 3 });
    f.classList.add('ax' + a.toLowerCase());
    box.append(f);
  });
  return box;
}
function seg(label, options, get, set) {
  const row = document.createElement('div');
  row.className = 'f';
  row.innerHTML = `<label>${label}</label><div class="seg"></div>`;
  const s = row.querySelector('.seg');
  for (const [val, text, title] of options) {
    const b = document.createElement('button');
    b.textContent = text; if (title) b.title = title;
    b.onclick = () => { set(val); commit(); };
    s.append(b);
  }
  const show = () => [...s.children].forEach((b, i) => b.classList.toggle('on', get() === options[i][0]));
  show(); updaters.push(show);
  return row;
}
function btns(...list) {
  const row = document.createElement('div');
  row.className = 'btns';
  for (const [text, fn, cls, title] of list) {
    const b = document.createElement('button');
    b.textContent = text; if (cls) b.className = cls; if (title) b.title = title;
    b.onclick = fn;
    row.append(b);
  }
  return row;
}
function text(label, get, set) {
  const row = document.createElement('div');
  row.className = 'f';
  row.innerHTML = `<label>${label}</label><input type="text" class="wide" spellcheck="false">`;
  const inp = row.querySelector('input');
  inp.value = get();
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
  inp.onchange = () => { set(inp.value.trim() || get()); commit(); };
  return row;
}
function section(title, ...children) {
  const s = document.createElement('div');
  s.className = 'sec';
  s.innerHTML = `<div class="sec-h">${title}</div>`;
  s.append(...children.filter(Boolean));
  root.append(s);
  return s;
}
const note = html => { const d = document.createElement('div'); d.className = 'note'; d.innerHTML = html; return d; };

// ---------- speed graph ----------

const graph = { canvas: document.createElement('canvas'), path: null, hover: null, drag: null };
graph.canvas.className = 'speed-graph';
const G = { l: 34, r: 10, t: 14, b: 22 };

function graphScale(path) {
  const prof = M.speedProfile(path), W = graph.canvas.clientWidth, H = graph.canvas.clientHeight;
  const T = Math.max(0.5, prof.T), vmax = Math.max(S.film.baseSpeed * 1.2, ...prof.v.map(v => Math.abs(v) * 1.25));
  return { prof, W, H, T, vmax, x: t => G.l + t / T * (W - G.l - G.r), y: v => H - G.b - Math.abs(v) / vmax * (H - G.t - G.b),
           t: x => (x - G.l) / (W - G.l - G.r) * T, v: y => (H - G.b - y) / (H - G.t - G.b) * vmax };
}
const pct = v => Math.round(Math.abs(v) / S.film.baseSpeed * 100);

function drawGraph() {
  const path = graph.path, c = graph.canvas;
  if (!path || !c.isConnected) return;
  const dpr = devicePixelRatio, W = c.clientWidth, H = c.clientHeight;
  if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#161618'; g.fillRect(0, 0, W, H);
  if (path.keys.length < 2) { g.fillStyle = '#888'; g.fillText('This path needs two keys', 10, 20); return; }
  const sc = graphScale(path), { prof } = sc;
  // grid: 100% line and time ticks
  g.font = '10px -apple-system, sans-serif';
  g.strokeStyle = '#2a2a2e'; g.fillStyle = '#77777f'; g.lineWidth = 1;
  for (const p of [50, 100, 200, 300, 400].filter(p => p / 100 * S.film.baseSpeed < sc.vmax)) {
    const y = sc.y(p / 100 * S.film.baseSpeed);
    g.beginPath(); g.moveTo(G.l, y + .5); g.lineTo(W - G.r, y + .5); g.stroke();
    g.fillText(p + '%', 4, y + 3);
  }
  const tick = [0.5, 1, 2, 5, 10, 30].find(s => sc.x(s) - sc.x(0) > 40) || 60;
  for (let t = 0; t <= sc.T + 1e-6; t += tick) { g.fillText(t.toFixed(tick < 1 ? 1 : 0) + 's', sc.x(t) - 6, H - 6); }
  // the speed curve
  const grad = g.createLinearGradient(0, G.t, 0, H - G.b);
  grad.addColorStop(0, 'rgba(232,129,58,.45)'); grad.addColorStop(1, 'rgba(232,129,58,.03)');
  g.beginPath(); g.moveTo(sc.x(0), sc.y(0));
  const N = 300;
  for (let i = 0; i <= N; i++) { const t = sc.T * i / N; g.lineTo(sc.x(t), sc.y(M.speedAt(prof, t))); }
  g.lineTo(sc.x(sc.T), sc.y(0)); g.closePath();
  g.fillStyle = grad; g.fill();
  g.beginPath();
  for (let i = 0; i <= N; i++) { const t = sc.T * i / N; g[i ? 'lineTo' : 'moveTo'](sc.x(t), sc.y(M.speedAt(prof, t))); }
  g.strokeStyle = '#e8813a'; g.lineWidth = 2; g.stroke();
  // keys, ramps, stretch handles
  const K = path.keys;
  K.forEach((k, i) => {
    const x = sc.x(k.t), sel = S.sel.kind === 'key' && S.sel.id === k.id;
    g.strokeStyle = sel ? '#ffb35c' : '#ffcf4a88'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x + .5, G.t); g.lineTo(x + .5, H - G.b); g.stroke(); g.setLineDash([]);
    g.fillStyle = sel ? '#ffb35c' : '#ffcf4a';
    g.beginPath(); g.arc(x, H - G.b, 6, 0, 7); g.fill();
    g.fillStyle = '#111'; g.font = '700 9px sans-serif'; g.fillText(i + 1, x - (i + 1 > 9 ? 5 : 2.5), H - G.b + 3);
    const h = prof.h[i];
    if (h > 0) for (const side of [-1, 1]) {
      const t = k.t + side * h, y = sc.y(M.speedAt(prof, t));
      const hot = graph.hover?.kind === 'ramp' && graph.hover.i === i;
      g.fillStyle = hot ? '#fff' : '#bbb';
      g.beginPath(); g.moveTo(sc.x(t), y - 5); g.lineTo(sc.x(t) + 4, y); g.lineTo(sc.x(t), y + 5); g.lineTo(sc.x(t) - 4, y); g.fill();
    }
  });
  g.font = '600 10px -apple-system, sans-serif';
  prof.v.forEach((v, i) => {
    const a = K[i].t + (i === 0 ? prof.Rs : prof.h[i]), b = K[i + 1].t - (i === K.length - 2 ? prof.Re : prof.h[i + 1]);
    const y = sc.y(v), hot = graph.hover?.kind === 'stretch' && graph.hover.i === i;
    if (b > a) {
      g.strokeStyle = hot ? '#fff' : 'rgba(255,255,255,.35)'; g.lineWidth = hot ? 3 : 1.5;
      g.beginPath(); g.moveTo(sc.x(a), y); g.lineTo(sc.x(b), y); g.stroke();
    }
    g.fillStyle = hot ? '#fff' : '#d8d8de';
    const label = Math.abs(prof.ds[i]) < 1e-6 ? 'hold' : pct(v) + '%';
    g.fillText(label, (sc.x(K[i].t) + sc.x(K[i + 1].t)) / 2 - 12, Math.max(G.t + 8, y - 6));
  });
  // playhead
  const ps = P.playheadShot();
  if (ps && ps.clip.ref === path.id) {
    const x = sc.x(ps.t);
    g.strokeStyle = '#e23b3b'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
}

function graphHit(e) {
  const path = graph.path, r = graph.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (!path || path.keys.length < 2) return null;
  const sc = graphScale(path), { prof } = sc, K = path.keys;
  for (let i = 1; i < K.length - 1; i++) for (const side of [-1, 1]) {
    const t = K[i].t + side * Math.max(prof.h[i], 0.0001);
    if (prof.h[i] > 0 && Math.hypot(sc.x(t) - mx, sc.y(M.speedAt(prof, t)) - my) < 8) return { kind: 'ramp', i, mx, my, sc };
  }
  for (let i = 0; i < K.length; i++) if (Math.abs(sc.x(K[i].t) - mx) < 7 && my > sc.H - G.b - 12) return { kind: 'key', i, mx, my, sc };
  for (let i = 0; i < prof.v.length; i++) {
    if (mx > sc.x(K[i].t) && mx < sc.x(K[i + 1].t) && Math.abs(sc.y(prof.v[i]) - my) < 9 && Math.abs(prof.ds[i]) > 1e-6) return { kind: 'stretch', i, mx, my, sc };
  }
  for (let i = 0; i < K.length; i++) if (Math.abs(sc.x(K[i].t) - mx) < 5) return { kind: 'key', i, mx, my, sc };
  return { kind: 'bg', mx, my, sc, t: M.clamp(sc.t(mx), 0, sc.T) };
}
graph.canvas.onpointermove = e => {
  if (graph.drag) return dragGraph(e);
  const h = graphHit(e);
  graph.hover = h;
  graph.canvas.style.cursor = !h ? 'default' : h.kind === 'stretch' ? 'ns-resize' : (h.kind === 'key' || h.kind === 'ramp') ? 'ew-resize' : 'crosshair';
  graph.canvas.title = !h ? '' : h.kind === 'stretch' ? 'Drag up/down to change the speed of this stretch' :
    h.kind === 'ramp' ? 'Drag to make the speed change more gradual or more sudden' :
    h.kind === 'key' ? 'Drag to change when the camera reaches this key' : 'Click to move the playhead · double-click to add a key';
  drawGraph();
};
graph.canvas.onpointerleave = () => { graph.hover = null; drawGraph(); };
graph.canvas.onpointerdown = e => {
  const h = graphHit(e), path = graph.path;
  if (!h) return;
  graph.canvas.setPointerCapture(e.pointerId);
  if (h.kind === 'key') { select('key', path.keys[h.i].id, { pathId: path.id }); seekPath(path, path.keys[h.i].t); }
  if (h.kind === 'bg') {
    if (e.detail >= 2) { VP.addKeyAt(path, M.sAt(path, h.t)); return; }
    seekPath(path, h.t);
    return;
  }
  graph.drag = { ...h, keys: JSON.parse(JSON.stringify(path.keys)), y0: e.clientY, x0: e.clientX };
};
graph.canvas.onpointerup = () => { if (graph.drag) { graph.drag = null; M.sortKeys(graph.path); commit(); } };
function dragGraph(e) {
  const d = graph.drag, path = graph.path, K = path.keys, sc = d.sc;
  path.keys = JSON.parse(JSON.stringify(d.keys));
  const k = path.keys;
  if (d.kind === 'stretch') {
    const prof = M.speedProfile(path), v0 = prof.v[d.i], v = Math.max(0.02 * S.film.baseSpeed, sc.v(sc.y(v0) + (e.clientY - d.y0)));
    M.setSegmentSpeed(path, d.i, v * Math.sign(v0 || 1));
  } else if (d.kind === 'key') {
    if (d.i === 0) return;
    const t = sc.t(sc.x(k[d.i].t) + (e.clientX - d.x0));
    const lo = k[d.i - 1].t + 0.05, hi = d.i < k.length - 1 ? k[d.i + 1].t - 0.05 : 1e9;
    k[d.i].t = M.clamp(t, lo, hi);
  } else if (d.kind === 'ramp') {
    const t = sc.t(d.mx + (e.clientX - d.x0));
    k[d.i].ramp = Math.max(0, Math.abs(t - k[d.i].t) * 2);
  }
  void K;
  live();
}
// move the playhead to a moment of this path's move, if a clip of it is on the timeline
function seekPath(path, t) {
  const r = M.layoutV1(S.film).find(r => r.clip.type === 'shot' && r.clip.ref === path.id && t >= r.clip.in - 1e-6 && t <= r.clip.in + r.clip.dur + 1e-6);
  if (r) seek(r.start + (t - r.clip.in));
  else toast('This part of the move is not on the timeline');
}

// ---------- panels ----------

const activePath = () => {
  const p = findPath(S.sel.pathId) || (S.sel.kind === 'path' && findPath(S.sel.id));
  if (p) return p;
  if (S.sel.kind === 'clip') { const c = S.film.clips.find(c => c.id === S.sel.id); if (c?.type === 'shot') return findPath(c.ref); }
  const ps = P.playheadShot();
  return ps ? findPath(ps.clip.ref) : null;
};
const findKey = id => { for (const p of S.film.paths) { const k = p.keys.find(x => x.id === id); if (k) return [p, k]; } return []; };

function speedSection(path) {
  graph.path = path;
  const prof = M.speedProfile(path);
  const list = document.createElement('div');
  list.className = 'stretches';
  prof.v.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'stretch';
    row.innerHTML = `<span class="st-n">${i + 1}→${i + 2}</span>`;
    if (Math.abs(prof.ds[i]) > 1e-6) row.append(num('Speed', () => pct(M.speedProfile(path).v[i]), x => M.setSegmentSpeed(path, i, x / 100 * S.film.baseSpeed * Math.sign(prof.v[i] || 1)), { step: 1, digits: 0, unit: '%', min: 2 }));
    else row.append(note('hold'));
    row.append(num('Time', () => path.keys[i + 1].t - path.keys[i].t, x => M.setSegmentDuration(path, i, x), { step: 0.02, digits: 2, unit: 's', min: 0.05 }));
    list.append(row);
  });
  const s = section(`Speed — ${esc(path.name)}`, graph.canvas,
    note('Drag a stretch <b>up/down</b> for speed · drag the ◆ handles for how <b>smoothly</b> it changes · double-click to add a key'),
    list,
    num('Ease in', () => path.easeIn, x => { path.easeIn = x; }, { step: 0.02, unit: 's', min: 0 }),
    num('Ease out', () => path.easeOut, x => { path.easeOut = x; }, { step: 0.02, unit: 's', min: 0 }),
    num('100% =', () => S.film.baseSpeed, x => { S.film.baseSpeed = x; }, { step: 0.005, digits: 3, unit: 'u/s', min: 0.01 }),
    btns(['Even speed', () => { M.evenSpeed(path); commit(); }, '', 'Same speed the whole way, same total time'],
         ['Slower ×½', () => { scaleTime(path, 2); }, '', 'Take twice as long'],
         ['Faster ×2', () => { scaleTime(path, 0.5); }, '', 'Take half as long']));
  s.classList.add('speed');
  requestAnimationFrame(drawGraph);
}
function scaleTime(path, f) { path.keys.forEach(k => { k.t *= f; k.ramp *= Math.min(1, f); }); commit(); }

function pathSection(path) {
  const film = S.film;
  const kids = [
    text('Name', () => path.name, v => { path.name = v; }),
    note(`${path.nodes.length} points · ${M.pathLength(path).toFixed(2)} units long · ${M.shotDuration(path).toFixed(2)} s · ${path.keys.length} camera keys`),
    seg('Aim all', [['path', 'Along path'], ['target', 'At target'], ['world', 'Fixed']], () => {
      const m = new Set(path.keys.map(k => k.look)); return m.size === 1 ? [...m][0] : null;
    }, v => {
      const tg = v === 'target' ? (path.keys.find(k => k.target)?.target || film.targets[0]?.id) : null;
      if (v === 'target' && !tg) { toast('Add a target first (T, then click the splat)'); return; }
      path.keys.forEach(k => { k.look = v; if (tg) k.target = tg; k.yaw = 0; k.pitch = 0; });
    }),
  ];
  if (path.gen) {
    const g = path.gen, regen = () => { path.nodes = M.spiralNodes(g); M.fitKeysToLength(path); };
    kids.push(note('Spiral / orbit: these stay editable until you move its points by hand.'),
      num('Turns', () => g.turns, v => { g.turns = v; regen(); }, { step: 0.01, min: 0.05 }),
      num('Radius start', () => g.r0, v => { g.r0 = v; regen(); }, { step: 0.005, digits: 3, min: 0.02 }),
      num('Radius end', () => g.r1, v => { g.r1 = v; regen(); }, { step: 0.005, digits: 3, min: 0.02 }),
      num('Rise', () => g.rise, v => { g.rise = v; regen(); }, { step: 0.005, digits: 3 }),
      num('Start angle', () => g.a0, v => { g.a0 = v; regen(); }, { step: 0.5, digits: 1, unit: '°' }),
      seg('Direction', [[1, '↺ Left'], [-1, '↻ Right']], () => g.dir, v => { g.dir = v; regen(); }),
      xyz('Centre', () => g.center, v => { g.center = v; regen(); }));
  }
  const onTl = film.clips.some(c => c.type === 'shot' && c.ref === path.id);
  kids.push(btns(
    [onTl ? 'Add again to timeline' : 'Add to timeline', () => emit('addShot', path)],
    ['Reverse', () => { M.reversePath(path); commit(); }, '', 'Fly the other way'],
    ['Delete path', () => {
      film.paths = film.paths.filter(p => p !== path);
      film.clips = film.clips.filter(c => !(c.type === 'shot' && c.ref === path.id));
      select(null, null); commit();
    }, 'danger']));
  section('Path', ...kids);
}

function nodeSection(path, i) {
  const n = path.nodes[i], end = i === 0 || i === path.nodes.length - 1;
  let extendBase = null;
  const kids = [
    note(`Point ${i + 1} of ${esc(path.name)} · drag it, or press <b>G</b> then <b>X/Y/Z</b> to move on one axis`),
    xyz('Position', () => path.nodes[i]?.p, v => { path.nodes[i].p = v; delete path.gen; M.fitKeysToLength(path); }),
    seg('Shape', [['auto', 'Smooth', 'Curve through it automatically'], ['free', 'Bezier', 'Own handles you can drag'], ['corner', 'Corner', 'Straight lines in and out']],
      () => path.nodes[i]?.mode, v => { if (v === 'free') M.freezeNode(path, i); else path.nodes[i].mode = v; delete path.gen; M.fitKeysToLength(path); }),
  ];
  if (n.mode === 'free') kids.push(xyz('Handle in', () => path.nodes[i]?.hin, v => { path.nodes[i].hin = v; delete path.gen; }), xyz('Handle out', () => path.nodes[i]?.hout, v => { path.nodes[i].hout = v; delete path.gen; }));
  if (end) {
    const atStart = i === 0;
    const ext = num('Extend ↔', () => 0, v => {
      if (!extendBase) extendBase = JSON.stringify(path);
      Object.assign(path, JSON.parse(extendBase));
      M.extendPath(path, v, atStart);
      M.fitKeysToLength(path);
      S.sel.index = atStart ? 0 : path.nodes.length - 1;
    }, { step: 0.01, digits: 2 });
    ext.querySelector('label').addEventListener('pointerup', () => { extendBase = null; });
    kids.push(note(`Drag <b>Extend</b> right to continue the path the way it's already heading (it keeps curving the same way), left to pull it back.`), ext,
      btns(['− Shorter', () => { M.extendPath(path, -0.25, atStart); M.fitKeysToLength(path); S.sel.index = atStart ? 0 : path.nodes.length - 1; commit(); }],
           ['+ Longer', () => { M.extendPath(path, 0.25, atStart); M.fitKeysToLength(path); S.sel.index = atStart ? 0 : path.nodes.length - 1; commit(); }]),
      note('To join paths: drag this end point onto the end of another path.'));
  }
  kids.push(btns(['Delete point', () => {
    if (path.nodes.length <= 2) { toast('A path needs at least 2 points. Delete the path instead.'); return; }
    path.nodes.splice(i, 1); delete path.gen; M.fitKeysToLength(path); select('path', path.id, { pathId: path.id }); commit();
  }, 'danger']));
  section('Point', ...kids);
}

function keySection(path, k) {
  const film = S.film, idx = path.keys.indexOf(k);
  const kids = [
    note(`Camera key ${idx + 1} of ${path.keys.length} on ${esc(path.name)} · drag it along the path in the view to slide it`),
    num('At time', () => k.t, v => {
      const lo = idx ? path.keys[idx - 1].t + 0.05 : 0, hi = idx < path.keys.length - 1 ? path.keys[idx + 1].t - 0.05 : 1e9;
      if (idx === 0) return;
      k.t = M.clamp(v, lo, hi);
    }, { step: 0.02, unit: 's' }),
    num('Along path', () => k.s, v => { k.s = M.clamp(v, 0, M.pathLength(path)); }, { step: 0.005, digits: 3, unit: 'u' }),
    seg('Aim', [['path', 'Along path', 'Look where the path goes'], ['target', 'At target', 'Keep looking at a point'], ['world', 'Fixed', 'Keep this exact direction']], () => k.look, v => {
      if (v === 'target' && !film.targets.length) { toast('Add a target first: press T and click the splat'); return; }
      const pose = M.cameraAt(film, path, k.t);
      k.look = v;
      if (v === 'target' && !k.target) k.target = film.targets[0].id;
      M.aimFromQuat(film, path, k, pose.quat);  // switching mode keeps the view
      if (v === 'target') { k.yaw = 0; k.pitch = 0; }
    }),
  ];
  if (k.look === 'target') {
    const row = document.createElement('div');
    row.className = 'f';
    row.innerHTML = `<label>Target</label><select>${film.targets.map(t => `<option value="${t.id}" ${t.id === k.target ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`;
    row.querySelector('select').onchange = e => { k.target = e.target.value; commit(); };
    kids.push(row);
  }
  kids.push(
    num('Yaw', () => k.yaw, v => { k.yaw = v; }, { step: 0.25, digits: 1, unit: '°' }),
    num('Pitch', () => k.pitch, v => { k.pitch = v; }, { step: 0.25, digits: 1, unit: '°', min: -89, max: 89 }),
    num('Roll / tilt', () => k.roll, v => { k.roll = v; }, { step: 0.25, digits: 1, unit: '°' }),
    num('Zoom (FOV)', () => k.fov, v => { k.fov = v; }, { step: 0.2, digits: 1, unit: '°', min: 8, max: 120 }),
    num('Ramp', () => k.ramp, v => { k.ramp = v; }, { step: 0.01, digits: 2, unit: 's', min: 0 }),
    note('<b>Ramp</b>: how long the speed takes to change at this key. 0 = sudden, bigger = smoother.'),
    btns(['Aim with mouse', () => emit('aimKey', k.id), 'primary', 'Look through this key and drag to aim it'],
         ['Use current view', () => { M.aimFromQuat(film, path, k, VP.freePose().quat); k.fov = VP.freePose().fov; commit(); toast('Key now looks where the view looks'); }, '', 'Aim it the way the free view is looking']),
    btns(['Hold 1 s here', () => {
      const h = M.newKey(film, k.s, k.t + 1, { look: k.look, target: k.target, yaw: k.yaw, pitch: k.pitch, roll: k.roll, fov: k.fov, ramp: k.ramp });
      path.keys.forEach(o => { if (o.t > k.t) o.t += 1; });
      path.keys.splice(idx + 1, 0, h);
      if (k.pin === 'end') { delete k.pin; h.pin = 'end'; }
      commit();
    }, '', 'Camera stops here for a second (with eased stop and start)'],
    ['Delete key', () => {
      if (path.keys.length <= 2) { toast('A move needs at least two keys'); return; }
      path.keys.splice(idx, 1);
      if (idx === path.keys.length && path.keys.length) path.keys[path.keys.length - 1].pin = 'end';
      if (idx === 0) path.keys[0].t = 0;
      select('path', path.id, { pathId: path.id }); commit();
    }, 'danger']));
  section('Camera key', ...kids);
}

function targetSection(t) {
  section('Target',
    text('Name', () => t.name, v => { t.name = v; }),
    xyz('Position', () => t.p, v => { t.p = v; }),
    note('Keys set to <b>Aim: At target</b> keep turning to look at this point as the camera moves.'),
    btns(['Delete target', () => {
      const film = S.film;
      film.targets = film.targets.filter(x => x !== t);
      film.paths.forEach(p => p.keys.forEach(k => { if (k.target === t.id) { k.look = 'path'; k.target = null; } }));
      select(null, null); commit();
    }, 'danger']));
}

function splatSection(sp) {
  section('Splat',
    text('Name', () => sp.name, v => { sp.name = v; }),
    seg('Show', [[true, 'Visible'], [false, 'Hidden']], () => sp.visible !== false, v => { sp.visible = v; VP.applySplatProps(); }),
    num('Opacity', () => (sp.opacity ?? 1) * 100, v => { sp.opacity = v / 100; VP.applySplatProps(); }, { step: 1, digits: 0, unit: '%', min: 0, max: 100 }),
    note('To line up a before/after: lower one splat\'s opacity, then move it with the arrows or <b>G</b> + <b>X/Y/Z</b>, and turn it below.'),
    xyz('Position', () => sp.pos, v => { sp.pos = v; VP.applySplatProps(); }),
    xyz('Rotation °', () => sp.rot, v => { sp.rot = v; VP.applySplatProps(); }, { step: 0.1, digits: 2 }),
    num('Scale', () => sp.scale, v => { sp.scale = v; VP.applySplatProps(); }, { step: 0.002, digits: 3, min: 0.01 }),
    btns(['Reset alignment', () => { sp.pos = [0, 0, 0]; sp.rot = [0, 0, 0]; sp.scale = 1; VP.applySplatProps(); commit(); }],
         ['Solo', () => { S.film.splats.forEach(o => { o.visible = o === sp; }); VP.applySplatProps(); commit(); }, '', 'Hide the others'],
         ['Its own view', () => VP.startView(sp), '', 'Look from the first camera of the original video']),
    btns(['Remove from film', () => {
      S.film.splats = S.film.splats.filter(o => o !== sp);
      S.film.clips.forEach(c => { if (c.splats) c.splats = c.splats.filter(id => id !== sp.id); });
      select(null, null); commit(); VP.syncSplats();
    }, 'danger']));
}

function clipSection(c) {
  const film = S.film, src = M.sourceDuration(film, c);
  const kids = [note(`${c.type === 'shot' ? 'Shot' : c.type === 'video' ? 'Video' : 'Music'} · ${esc(c.type === 'shot' ? findPath(c.ref)?.name || '' : c.ref)} · source ${src.toFixed(2)} s`)];
  if (c.track !== 'V1') kids.push(num('Starts at', () => c.start, v => { c.start = Math.max(0, v); }, { step: 0.02, unit: 's' }));
  kids.push(
    num('Source in', () => c.in, v => { c.in = M.clamp(v, 0, src - 0.04); c.dur = Math.min(c.dur, src - c.in); c.full = false; }, { step: 0.02, unit: 's' }),
    num('Duration', () => c.dur, v => { c.dur = M.clamp(v, 1 / film.fps, src - c.in); c.full = c.type === 'shot' && Math.abs(c.dur - (src - c.in)) < 1e-3; }, { step: 0.02, unit: 's' }));
  if (c.type === 'shot') {
    const box = document.createElement('div');
    box.className = 'f col';
    box.innerHTML = `<label>Splats in this shot</label>` + (film.splats.length ? film.splats.map(sp =>
      `<label class="chk"><input type="checkbox" value="${sp.id}" ${!c.splats?.length || c.splats.includes(sp.id) ? 'checked' : ''}> ${esc(sp.name)}</label>`).join('') : '<div class="note">No splats in this film yet</div>');
    box.querySelectorAll('input').forEach(i => i.onchange = () => {
      const on = [...box.querySelectorAll('input:checked')].map(x => x.value);
      c.splats = on.length === film.splats.length ? null : on;
      commit();
    });
    kids.push(box, note('Before/after: put the same path on V1 twice, give each clip a different splat, and add a dissolve between them.'),
      btns(['Edit this path', () => { select('path', c.ref, { pathId: c.ref }); emit('frameSelection'); }],
           ['Full length', () => { c.in = 0; c.dur = src; c.full = true; commit(); }]));
  } else {
    kids.push(num('Volume', () => c.volume * 100, v => { c.volume = v / 100; }, { step: 1, digits: 0, unit: '%', min: 0, max: 200 }));
    if (c.type === 'audio') kids.push(num('Fade in', () => c.fadeIn, v => { c.fadeIn = v; }, { step: 0.02, unit: 's', min: 0 }),
                                      num('Fade out', () => c.fadeOut, v => { c.fadeOut = v; }, { step: 0.02, unit: 's', min: 0 }));
  }
  kids.push(btns(['Delete clip', () => { film.clips = film.clips.filter(x => x !== c); select(null, null); commit(); }, 'danger']));
  section('Clip', ...kids);
}

function transitionSection(c, side) {
  const tr = c[side === 'out' ? 'tout' : 'tin'];
  if (!tr) return;
  const first = M.layoutV1(S.film)[0]?.clip === c;
  section(side === 'out' ? 'Fade out' : first ? 'Fade in' : 'Transition',
    seg('Type', [['dissolve', 'Dissolve'], ['blur', 'Blur'], ['dip', 'Dip to colour'], ['flash', 'Flash'], ['none', 'Cut']], () => tr.type, v => { tr.type = v; }),
    num('Length', () => tr.frames, v => { tr.frames = Math.round(v); }, { step: 0.25, digits: 0, unit: 'frames', min: 1, max: 600 }),
    btns(...[1, 2, 3, 4, 6, 8, 12, 24].map(f => [f + 'f', () => { tr.frames = f; commit(); }])),
    (() => { const r = document.createElement('div'); r.className = 'f'; r.innerHTML = `<label>Colour</label><input type="color" value="${tr.color || '#000000'}">`;
             r.querySelector('input').onchange = e => { tr.color = e.target.value; commit(); }; return r; })(),
    note(`${(tr.frames / S.film.fps).toFixed(3)} s at ${S.film.fps} fps. Very short (2–4 frames) blur or flash transitions make snappy cuts.`),
    btns(['Remove', () => { c[side === 'out' ? 'tout' : 'tin'] = null; select(null, null); commit(); }, 'danger']));
}

function filmSection() {
  const film = S.film;
  section('Film',
    text('Name', () => film.name, v => { emit('rename', v); }),
    seg('Size', [['1920x1080', '1080p'], ['3840x2160', '4K'], ['1080x1920', 'Vertical'], ['1080x1080', 'Square']], () => `${film.width}x${film.height}`,
      v => { [film.width, film.height] = v.split('x').map(Number); VP.layout(); }),
    seg('Frame rate', [[24, '24'], [25, '25'], [30, '30'], [60, '60']], () => film.fps, v => { film.fps = v; }),
    num('100% speed', () => film.baseSpeed, v => { film.baseSpeed = v; }, { step: 0.005, digits: 3, unit: 'u/s', min: 0.01 }));
  section('View',
    seg('Preview', [[1, 'Fast'], [Math.min(devicePixelRatio, 1.5), 'Balanced'], [devicePixelRatio, 'Sharp']], () => VP.opts.quality, v => { VP.setQuality(v); VP.layout(); render(); }),
    seg('Floor grid', [[true, 'On'], [false, 'Off']], () => VP.opts.grid, v => { VP.opts.grid = v; VP.requestRender(); render(); }),
    num('Stand-off', () => VP.opts.standoff, v => { VP.opts.standoff = v; }, { step: 0.005, digits: 2, unit: 'u', min: 0 }),
    note('<b>Stand-off</b>: clicking on the splat puts path points this far in front of the surface.'));
  section('How to',
    note(`<b>Move around</b>: drag = orbit the spot under the mouse · scroll = fly toward the mouse (goes right through) · right-drag = look, and hold it + <b>WASD/QE</b> to fly · shift-drag = pan · double-click = focus<br>
      <b>Paths</b>: L line · B curve (drag while clicking for handles) · A half circle · S orbit/spiral · P adds a point where the camera is · Enter finishes<br>
      <b>Move points</b>: drag, hold <b>X/Y/Z</b> to lock an axis, or <b>G</b> then X/Y/Z like Blender<br>
      <b>Camera</b>: K adds a key on a path · T drops a target to look at · 0 looks through the timeline camera<br>
      <b>Timeline</b>: Space play · ←/→ frame · ⌘B split · ⌘T dissolve · ⌘Z undo`));
}

const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function render() {
  if (root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') { updaters.forEach(u => u()); return; }
  root.innerHTML = '';
  updaters = [];
  const film = S.film, s = S.sel, path = activePath();
  if (path) speedSection(path);
  if (s.kind === 'node' && findPath(s.pathId)?.nodes[s.index]) nodeSection(findPath(s.pathId), s.index);
  else if (s.kind === 'handle' && findPath(s.pathId)) nodeSection(findPath(s.pathId), s.index);
  else if (s.kind === 'key') { const [p, k] = findKey(s.id); if (k) keySection(p, k); }
  else if (s.kind === 'target') { const t = film.targets.find(x => x.id === s.id); if (t) targetSection(t); }
  else if (s.kind === 'splat') { const sp = film.splats.find(x => x.id === s.id); if (sp) splatSection(sp); }
  else if (s.kind === 'clip') { const c = film.clips.find(x => x.id === s.id); if (c) clipSection(c); }
  else if (s.kind === 'transition') { const c = film.clips.find(x => x.id === s.id); if (c) transitionSection(c, s.side); }
  if (path && (s.kind === 'path' || s.kind === 'node' || s.kind === 'handle' || s.kind === 'key')) pathSection(path);
  if (!s.kind) filmSection();
}
on('select', render);
on('change', render);
on('film', render);
on('live', () => { updaters.forEach(u => u()); drawGraph(); });
// the graph follows the shot under the playhead when nothing else picks the path
const follow = () => { drawGraph(); if (activePath() !== graph.path) render(); };
on('time', follow);
on('seek', follow);
new ResizeObserver(drawGraph).observe(root);
