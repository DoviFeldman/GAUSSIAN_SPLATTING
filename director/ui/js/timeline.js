// Timeline: V1 holds shots and videos back to back (drag to reorder), A1/A2 hold music placed anywhere.
// Transitions sit on the cuts between V1 clips; they can be as short as one frame.
import { S, on, emit, commit, live, select, findPath, toast } from './state.js';
import * as M from './model.js';

const root = document.getElementById('timeline');
root.innerHTML = `
  <div class="tl-bar">
    <div class="tl-transport">
      <button data-act="start" title="Go to start (Home)">⏮</button>
      <button data-act="back" title="Back one frame (←)">◀︎</button>
      <button data-act="play" class="tl-play" title="Play / pause (Space)">▶</button>
      <button data-act="fwd" title="Forward one frame (→)">▶︎</button>
      <button data-act="end" title="Go to end (End)">⏭</button>
    </div>
    <div class="tl-tc" id="tc">00:00:00:00</div>
    <div class="tl-tools">
      <button data-act="split" title="Split the clip under the playhead (⌘B)">Split</button>
      <button data-act="dissolve" title="Dissolve at the cut nearest the playhead (⌘T)">+ Dissolve</button>
      <button data-act="delete" title="Delete the selected clip or transition (Delete)">Delete</button>
      <span class="tl-sep"></span>
      <label title="Zoom">⊖<input type="range" id="tlZoom" min="8" max="400" value="60">⊕</label>
    </div>
  </div>
  <div class="tl-body">
    <div class="tl-heads"><div class="tl-rulerhead"></div>
      <div class="tl-head v">V1<small>Shots &amp; video</small></div>
      <div class="tl-head a">A1<small>Music</small></div>
      <div class="tl-head a">A2<small>Music</small></div></div>
    <div class="tl-scroll" id="tlScroll">
      <div class="tl-inner" id="tlInner">
        <canvas class="tl-ruler" id="tlRuler"></canvas>
        <div class="tl-track" data-track="V1"></div>
        <div class="tl-track" data-track="A1"></div>
        <div class="tl-track" data-track="A2"></div>
        <div class="tl-playhead" id="tlPlayhead"><div class="tl-ph-cap"></div></div>
        <div class="tl-insert" id="tlInsert"></div>
      </div>
    </div>
  </div>`;

const $ = s => root.querySelector(s);
const scroll = $('#tlScroll'), inner = $('#tlInner'), ruler = $('#tlRuler'), ph = $('#tlPlayhead'), ins = $('#tlInsert');
const tracks = { V1: root.querySelector('[data-track=V1]'), A1: root.querySelector('[data-track=A1]'), A2: root.querySelector('[data-track=A2]') };
let pps = 60;  // pixels per second
const X = t => t * pps;
const T = x => Math.max(0, x / pps);

export function timecode(t, fps = S.film.fps) {
  const f = Math.round(t * fps), ff = f % fps, s = Math.floor(f / fps);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

function clipName(c) {
  if (c.type === 'shot') return findPath(c.ref)?.name || 'missing path';
  return c.ref;
}

// speed curve drawn inside a shot clip, so ramps are visible on the timeline
function sparkline(c, w) {
  const path = findPath(c.ref);
  if (!path || w < 30) return '';
  const prof = M.speedProfile(path), max = Math.max(1e-6, ...prof.v.map(Math.abs));
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = c.in + c.dur * i / 40;
    pts.push(`${(i / 40 * w).toFixed(1)},${(24 - Math.abs(M.speedAt(prof, t)) / max * 18).toFixed(1)}`);
  }
  return `<svg class="tl-spark" width="${w}" height="26"><polyline points="${pts.join(' ')}"/></svg>`;
}

export function render() {
  const film = S.film, dur = M.filmDuration(film);
  const width = Math.max(scroll.clientWidth, X(dur + 20));
  inner.style.width = width + 'px';
  for (const t of Object.values(tracks)) t.innerHTML = '';
  const L = M.layoutV1(film);
  L.forEach((r, i) => {
    const c = r.clip, d = div(c, r.start);
    tracks.V1.append(d);
    // transition markers on the cut before this clip (or a fade in for the first one)
    const tr = c.tin, td = M.transitionSeconds(film, tr);
    if (td > 0) {
      const t = document.createElement('div');
      t.className = 'tl-trans' + (S.sel.kind === 'transition' && S.sel.id === c.id && S.sel.side === 'in' ? ' sel' : '');
      const a = i ? r.start - td / 2 : r.start;
      t.style.left = X(a) + 'px'; t.style.width = Math.max(6, X(td)) + 'px';
      t.title = `${tr.type} · ${tr.frames} frame${tr.frames > 1 ? 's' : ''}`;
      t.innerHTML = `<span>${tr.frames}f</span>`;
      t.onpointerdown = e => { e.stopPropagation(); select('transition', c.id, { side: 'in' }); };
      tracks.V1.append(t);
    } else {
      const plus = document.createElement('button');
      plus.className = 'tl-cutplus'; plus.textContent = '+';
      plus.title = i ? 'Add a transition here' : 'Fade in from black';
      plus.style.left = (X(r.start) - 8) + 'px';
      plus.onpointerdown = e => { e.stopPropagation(); addTransition(c, 'in'); };
      tracks.V1.append(plus);
    }
    if (i === L.length - 1) {
      const to = c.tout, od = M.transitionSeconds(film, to);
      if (od > 0) {
        const t = document.createElement('div');
        t.className = 'tl-trans' + (S.sel.kind === 'transition' && S.sel.id === c.id && S.sel.side === 'out' ? ' sel' : '');
        t.style.left = X(r.end - od) + 'px'; t.style.width = Math.max(6, X(od)) + 'px';
        t.innerHTML = `<span>${to.frames}f</span>`;
        t.title = 'Fade out';
        t.onpointerdown = e => { e.stopPropagation(); select('transition', c.id, { side: 'out' }); };
        tracks.V1.append(t);
      } else {
        const plus = document.createElement('button');
        plus.className = 'tl-cutplus'; plus.textContent = '+'; plus.title = 'Fade out to black';
        plus.style.left = (X(r.end) - 8) + 'px';
        plus.onpointerdown = e => { e.stopPropagation(); addTransition(c, 'out'); };
        tracks.V1.append(plus);
      }
    }
  });
  for (const c of film.clips.filter(c => c.track !== 'V1')) tracks[c.track]?.append(div(c, c.start));
  drawRuler(width);
  placePlayhead();
}

function div(c, start) {
  const d = document.createElement('div');
  d.className = `tl-clip ${c.type}` + (S.sel.kind === 'clip' && S.sel.id === c.id ? ' sel' : '');
  d.style.left = X(start) + 'px';
  const w = Math.max(4, X(c.dur));
  d.style.width = w + 'px';
  const sp = c.type === 'shot' && c.splats?.length ? ' · ' + c.splats.map(id => S.film.splats.find(s => s.id === id)?.name || '?').join(', ') : '';
  d.innerHTML = `<div class="tl-name">${c.type === 'shot' ? '🎥 ' : c.type === 'video' ? '🎞 ' : '♪ '}${esc(clipName(c))}${esc(sp)}</div>
    <div class="tl-dur">${c.dur.toFixed(2)}s</div>${c.type === 'shot' ? sparkline(c, w) : ''}
    ${c.fadeIn > 0 ? `<div class="tl-fade in" style="width:${X(c.fadeIn)}px"></div>` : ''}
    ${c.fadeOut > 0 ? `<div class="tl-fade out" style="width:${X(c.fadeOut)}px"></div>` : ''}
    <div class="tl-edge l"></div><div class="tl-edge r"></div>`;
  d.onpointerdown = e => clipDown(e, c, d);
  d.ondblclick = () => { if (c.type === 'shot') { select('path', c.ref, { pathId: c.ref }); emit('frameSelection'); } };
  return d;
}
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function drawRuler(width) {
  const dpr = devicePixelRatio, h = 22;
  ruler.width = width * dpr; ruler.height = h * dpr; ruler.style.width = width + 'px';
  const g = ruler.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = '#1f1f22'; g.fillRect(0, 0, width, h);
  const steps = [1 / S.film.fps, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 300];
  const major = steps.find(s => s * pps >= 70) || 600, minor = steps.filter(s => s < major && s * pps >= 8).pop() || major;
  g.strokeStyle = '#555'; g.fillStyle = '#9a9aa2'; g.font = '10px -apple-system, sans-serif';
  g.beginPath();
  for (let t = 0; X(t) < width; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    g.moveTo(X(t) + 0.5, isMajor ? 8 : 15); g.lineTo(X(t) + 0.5, h);
    if (isMajor) g.fillText(timecode(t).slice(3), X(t) + 3, 10);
  }
  g.stroke();
}

export function placePlayhead() {
  ph.style.left = X(S.playhead) + 'px';
  $('#tc').textContent = timecode(S.playhead);
  if (S.playing) {  // keep the playhead in view
    const x = X(S.playhead) - scroll.scrollLeft;
    if (x > scroll.clientWidth - 40 || x < 0) scroll.scrollLeft = X(S.playhead) - 80;
  }
}

// ---------- interactions ----------

export function seek(t) {
  const f = S.film.fps;
  S.playhead = Math.max(0, Math.round(t * f) / f);
  placePlayhead();
  emit('seek');
}
const xOf = e => e.clientX - inner.getBoundingClientRect().left;

inner.addEventListener('pointerdown', e => {
  if (e.target.closest('.tl-clip, .tl-trans, .tl-cutplus')) return;
  inner.setPointerCapture(e.pointerId);
  if (S.playing) emit('pause');
  seek(T(xOf(e)));
  const move = ev => seek(T(xOf(ev)));
  const up = () => { inner.removeEventListener('pointermove', move); inner.removeEventListener('pointerup', up); };
  inner.addEventListener('pointermove', move);
  inner.addEventListener('pointerup', up);
  if (!e.target.closest('.tl-ruler')) select(null, null);
});

function clipDown(e, c, d) {
  e.stopPropagation();
  if (e.button !== 0) return;
  select('clip', c.id);
  const edge = e.target.classList.contains('tl-edge') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
  const x0 = e.clientX, y0 = e.clientY, orig = { ...c }, src = M.sourceDuration(S.film, c), frame = 1 / S.film.fps;
  let moved = false;
  d.setPointerCapture(e.pointerId);
  const move = ev => {
    const dt = (ev.clientX - x0) / pps;
    if (Math.abs(ev.clientX - x0) > 3 || Math.abs(ev.clientY - y0) > 3) moved = true;
    if (!moved) return;
    if (edge === 'l') {  // trim the head
      const nin = M.clamp(orig.in + dt, 0, orig.in + orig.dur - frame);
      c.in = nin; c.dur = orig.dur - (nin - orig.in); c.full = false;
      if (c.track !== 'V1') c.start = orig.start + (nin - orig.in);
    } else if (edge === 'r') {  // trim the tail
      c.dur = M.clamp(orig.dur + dt, frame, Math.max(frame, src - c.in)); c.full = c.type === 'shot' && Math.abs(c.dur - (src - c.in)) < 1e-3;
    } else if (c.track === 'V1') {  // reorder: show where it will land
      const at = insertIndex(ev, c);
      const L = M.layoutV1(S.film);
      ins.style.display = 'block';
      ins.style.left = X(at < L.length ? L[at].start : (L.length ? L[L.length - 1].end : 0)) + 'px';
      ins.style.top = tracks.V1.offsetTop + 'px';
      d.style.transform = `translateX(${ev.clientX - x0}px)`; d.style.opacity = .7;
      return;
    } else {  // music: slide in time, snapping to the playhead, 0 and clip edges; drag up/down to change track
      let s = Math.max(0, orig.start + dt);
      const snaps = [0, S.playhead, ...S.film.clips.filter(o => o !== c).flatMap(o => o.track === 'V1' ? [] : [o.start, o.start + o.dur]),
                     ...M.layoutV1(S.film).flatMap(r => [r.start, r.end])];
      for (const sn of snaps) { if (Math.abs(X(sn) - X(s)) < 8) s = sn; if (Math.abs(X(sn) - X(s + c.dur)) < 8) s = sn - c.dur; }
      c.start = Math.max(0, s);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tl-track');
      if (over && over.dataset.track !== 'V1') c.track = over.dataset.track;
    }
    live();
  };
  const up = ev => {
    d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up);
    ins.style.display = 'none';
    if (moved && c.track === 'V1' && !edge) {
      const at = insertIndex(ev, c), v1 = S.film.clips.filter(x => x.track === 'V1' && x !== c);
      v1.splice(at > M.layoutV1(S.film).findIndex(r => r.clip === c) ? at - 1 : at, 0, c);
      S.film.clips = [...v1, ...S.film.clips.filter(x => x.track !== 'V1')];
    }
    if (moved) commit(); else render();
  };
  d.addEventListener('pointermove', move);
  d.addEventListener('pointerup', up);
}
function insertIndex(ev, c) {
  const x = T(xOf(ev)), L = M.layoutV1(S.film);
  let i = 0;
  while (i < L.length && (L[i].start + L[i].end) / 2 < x) i++;
  void c;
  return i;
}

export function addTransition(c, side = 'in', type = 'dissolve', frames = 8) {
  c[side === 'in' ? 'tin' : 'tout'] = { type: M.layoutV1(S.film)[0]?.clip === c && side === 'in' ? 'dip' : (side === 'out' ? 'dip' : type), frames, color: '#000000' };
  select('transition', c.id, { side });
  commit();
}
export function dissolveAtPlayhead() {
  const L = M.layoutV1(S.film);
  if (L.length < 2) { toast('A dissolve needs two clips on V1'); return; }
  let best = L[1];
  for (const r of L.slice(1)) if (Math.abs(r.start - S.playhead) < Math.abs(best.start - S.playhead)) best = r;
  addTransition(best.clip, 'in', 'dissolve', 8);
}
export function splitAtPlayhead() {
  const film = S.film, t = S.playhead;
  let target = null, start = 0;
  const sel = S.sel.kind === 'clip' && film.clips.find(c => c.id === S.sel.id);
  if (sel && sel.track !== 'V1' && t > sel.start && t < sel.start + sel.dur) { target = sel; start = sel.start; }
  if (!target) { const r = M.layoutV1(film).find(r => t > r.start + 1e-6 && t < r.end - 1e-6); if (r) { target = r.clip; start = r.start; } }
  if (!target) { toast('Put the playhead over a clip to split it'); return; }
  const cut = t - start, b = { ...target, id: M.uid('c'), in: target.in + cut, dur: target.dur - cut, start: target.start + cut, tin: null, fadeIn: 0, full: false };
  target.dur = cut; target.tout = null; target.fadeOut = 0; target.full = false;
  film.clips.splice(film.clips.indexOf(target) + 1, 0, b);
  select('clip', b.id);
  commit();
}
export function deleteSelected() {
  const film = S.film, s = S.sel;
  if (s.kind === 'clip') { film.clips = film.clips.filter(c => c.id !== s.id); select(null, null); commit(); return true; }
  if (s.kind === 'transition') { const c = film.clips.find(c => c.id === s.id); if (c) c[s.side === 'out' ? 'tout' : 'tin'] = null; select(null, null); commit(); return true; }
  return false;
}

// drops from the media pool: {type: shot|video|audio, ref}
for (const [name, tr] of Object.entries(tracks)) {
  tr.addEventListener('dragover', e => { e.preventDefault(); tr.classList.add('over'); });
  tr.addEventListener('dragleave', () => tr.classList.remove('over'));
  tr.addEventListener('drop', e => {
    e.preventDefault(); tr.classList.remove('over');
    let item;
    try { item = JSON.parse(e.dataTransfer.getData('text/x-director')); } catch { return; }
    emit('dropItem', item, name === 'V1' ? (item.type === 'audio' ? 'A1' : 'V1') : (item.type === 'audio' ? name : 'V1'), T(xOf(e)), insertIndex(e));
  });
}

root.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
  const a = b.dataset.act, f = 1 / S.film.fps;
  if (a === 'play') emit('togglePlay');
  if (a === 'start') seek(0);
  if (a === 'end') seek(M.filmDuration(S.film));
  if (a === 'back') seek(S.playhead - f);
  if (a === 'fwd') seek(S.playhead + f);
  if (a === 'split') splitAtPlayhead();
  if (a === 'dissolve') dissolveAtPlayhead();
  if (a === 'delete') deleteSelected();
});
$('#tlZoom').oninput = e => setZoom(+e.target.value);
function setZoom(v, anchorX) {
  const ax = anchorX ?? X(S.playhead) - scroll.scrollLeft, t = (scroll.scrollLeft + ax) / pps;
  pps = M.clamp(v, 8, 400);
  $('#tlZoom').value = pps;
  render();
  scroll.scrollLeft = t * pps - ax;
}
scroll.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) {  // pinch or ⌥-scroll zooms the timeline around the mouse
    e.preventDefault();
    setZoom(pps * Math.pow(1.01, -e.deltaY), e.clientX - scroll.getBoundingClientRect().left);
  }
}, { passive: false });

on('change', render);
on('live', render);
on('select', render);
on('film', render);
on('time', placePlayhead);
on('seek', placePlayhead);
on('playing', p => { $('.tl-play').textContent = p ? '❚❚' : '▶'; });
new ResizeObserver(render).observe(scroll);
