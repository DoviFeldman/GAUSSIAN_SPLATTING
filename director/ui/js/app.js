// Splat Director: wires the panels together, owns the frame loop, shortcuts, media pool, films and export.
import { S, on, emit, commit, select, undo, redo, save, resetHistory, hooks, findPath, toast } from './state.js';
import * as M from './model.js';
import * as VP from './viewport.js';
import * as P from './program.js';
import * as TL from './timeline.js';
import * as INS from './inspector.js';

const $ = id => document.getElementById(id);

// ---------- derived values ----------
hooks.normalize = () => {
  const film = S.film;
  for (const c of film.clips) {
    if (c.type === 'shot' && c.full !== false) { const p = findPath(c.ref); if (p) c.dur = Math.max(1 / film.fps, M.shotDuration(p) - c.in); }
  }
  film.clips = film.clips.filter(c => c.type !== 'shot' || findPath(c.ref));
  const dur = M.filmDuration(film);
  if (S.playhead > dur) S.playhead = dur;
};

// ---------- tools ----------
const TOOLS = [
  ['select', 'V', '⬚', 'Select & move'], ['line', 'L', '╱', 'Line (click points)'], ['curve', 'B', '∿', 'Bezier curve (click, drag for handles)'],
  ['arc', 'A', '◠', 'Half circle (two clicks; Shift = upward)'], ['spiral', 'S', '◎', 'Orbit / spiral around the clicked point'],
  ['key', 'K', '◆', 'Camera key (click a path)'], ['target', 'T', '⊕', 'Target to look at (click the splat)'],
];
const toolbar = $('tools');
toolbar.innerHTML = TOOLS.map(([id, key, icon, title]) => `<button data-tool="${id}" title="${title} (${key})"><span class="ic">${icon}</span><span class="k">${key}</span></button>`).join('')
  + `<span class="sep"></span><button id="atCam" title="Add a path point where the camera is (P)"><span class="ic">⌖</span><span class="k">P</span></button>`
  + `<button id="frameBtn" title="Frame the selection (F)"><span class="ic">⛶</span><span class="k">F</span></button>`;
function setTool(t) {
  if (VP.isDrawing() && t !== S.tool) VP.finishDrawing();
  S.tool = t;
  toolbar.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  const hint = { line: 'Click to place points (on the splat, or in the air). P adds one at the camera. Enter or double-click to finish.',
                 curve: 'Click to place smooth points; drag while clicking to pull out Bezier handles. Enter to finish.',
                 arc: 'Click the start, then the end of a half circle. Shift = bulge upward, Alt = reverse.',
                 spiral: 'Click what to orbit around. The orbit starts where your camera is now.',
                 key: 'Click on a path to add a camera key there.', target: 'Click the splat where the camera should look.' }[t];
  $('vpHint').textContent = hint || '';
  $('vpHint').style.display = hint ? 'block' : 'none';
}
toolbar.addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
$('atCam').onclick = () => { if (S.view !== 'free') setView('free'); VP.nodeAtCamera(); };
$('frameBtn').onclick = () => VP.frameSelection();
on('tool', setTool);
setTool('select');

// ---------- view mode ----------
// Like Blender: going back to the free view returns to where you were, except when you grab the view while
// looking through the camera; then you carry on flying from the camera's spot.
let freeNav = null;
function setView(v, fromCamera = false) {
  if (v === 'camera' && S.view === 'free') freeNav = VP.navState();
  if (v === 'free' && S.view === 'camera') {
    const pose = fromCamera && P.playheadPose();
    if (pose) VP.setFreeFrom(pose); else if (freeNav) VP.setNavState(freeNav);
  }
  S.view = v;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  P.showProgram(v === 'camera' && !S.aimKey);
  VP.layout();
  VP.requestRender();
  $('vp').classList.toggle('camera', v === 'camera');
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { if (S.aimKey) emit('aimDone'); setView(b.dataset.view); });
on('leaveCamera', () => setView('free', true));
let aimReturn = 'free';
on('aimKey', id => {
  const [path, k] = keyById(id);
  if (!k) return;
  aimReturn = S.view;
  S.aimKey = id;
  select('key', id, { pathId: path.id });
  setView('camera');
});
on('aimDone', () => { S.aimKey = null; commit(); setView(aimReturn); });
const keyById = id => { for (const p of S.film.paths) { const k = p.keys.find(x => x.id === id); if (k) return [p, k]; } return []; };

// ---------- the frame loop ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);  // first, so one bad frame can't stop the loop
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (S.exporting) return;  // the export drives the camera itself; touching it here mixed your view into the video
  VP.tick(dt);
  P.tickPlayback();
  if (S.aimKey) {
    const [path, k] = keyById(S.aimKey);
    if (path) {
      const pose = M.cameraAt(S.film, path, k.t);
      VP.setPose(pose.pos, pose.quat, pose.fov);
      VP.applySplatProps();
      VP.renderSplats();
    }
    VP.drawOverlay();
  } else if (S.view === 'camera') {
    P.drawPreview();
    VP.drawOverlay();
  } else VP.drawFree();
}
requestAnimationFrame(frame);

on('togglePlay', () => togglePlay());
on('pause', () => P.pause());
function togglePlay() {
  if (!S.playing && S.view !== 'camera') setView('camera');
  P.play();
}

// ---------- media pool ----------
const pool = $('pool');
function poolRender() {
  const film = S.film;
  const item = (o) => `<div class="pi ${o.sel ? 'sel' : ''}" draggable="${!!o.drag}" data-k="${o.k}" data-id="${esc(o.id)}" title="${esc(o.title || '')}">
      ${o.dot ? `<span class="dot" style="background:${o.dot}"></span>` : `<span class="pic">${o.icon}</span>`}
      <span class="pn">${esc(o.name)}</span><span class="pm">${o.meta || ''}</span>${o.eye != null ? `<button class="eye ${o.eye ? '' : 'off'}" data-eye="${esc(o.id)}" title="Show / hide">${o.eye ? '◉' : '○'}</button>` : ''}</div>`;
  pool.innerHTML = `
    <div class="ph">Films <button id="newFilmBtn" title="Start a new, empty film">+ New</button></div>
    ${filmList.map(f => `<div class="pi film ${f.name === film.name ? 'sel' : ''}" data-k="film" data-id="${esc(f.name)}" title="${f.name === film.name ? 'Open now' : 'Click to open'} · ${esc(f.splats.join(', ') || 'no splats')} · ${f.clips} clips">
        <span class="pic">${f.name === film.name ? '▶' : '🎬'}</span><span class="pn">${esc(f.name)}</span>
        <span class="fa"><button data-fa="dup" title="Duplicate: make a copy and edit that">⧉</button><button data-fa="ren" title="Rename">✎</button><button data-fa="del" title="Delete (kept in films/.trash)">✕</button></span></div>`).join('')}
    <div class="ph">Splats <button id="addSplat" title="Add a splat from your projects">+ Add</button></div>
    ${film.splats.map(sp => item({ k: 'splat', id: sp.id, name: sp.name, icon: '✦', meta: '', eye: sp.visible !== false, sel: S.sel.kind === 'splat' && S.sel.id === sp.id })).join('') || '<div class="pe">No splats yet. Click + Add.</div>'}
    <div class="ph">Paths <span class="phm">drag to timeline</span></div>
    ${film.paths.map(p => item({ k: 'path', id: p.id, name: p.name, dot: p.color, meta: M.shotDuration(p).toFixed(1) + 's', drag: true, sel: (S.sel.pathId || S.sel.id) === p.id })).join('') || '<div class="pe">Draw one with L, B, A or S.</div>'}
    ${film.targets.length ? `<div class="ph">Targets</div>` + film.targets.map(t => item({ k: 'target', id: t.id, name: t.name, icon: '⊕', sel: S.sel.kind === 'target' && S.sel.id === t.id })).join('') : ''}
    <div class="ph">Video &amp; music <button id="addMedia" title="Import video or music files">+ Import</button></div>
    ${film.media.map(m => item({ k: 'media', id: m.name, name: m.name, icon: m.kind === 'audio' ? '♪' : '🎞', meta: m.duration ? m.duration.toFixed(1) + 's' : '', drag: true, title: 'Drag to the timeline, or double-click to add it' })).join('') || '<div class="pe">Import clips or songs, or drop files here.</div>'}`;
  $('addSplat').onclick = splatPicker;
  $('newFilmBtn').onclick = () => askName('New film', `Film ${filmList.length + 1}`, async n => { await save(); await newFilm(n); });
  $('addMedia').onclick = () => $('fileIn').click();
}
pool.addEventListener('click', e => {
  const fa = e.target.closest('[data-fa]'), fi = e.target.closest('.pi.film');
  if (fi) { filmAction(fa?.dataset.fa || 'open', fi.dataset.id); return; }
  const eye = e.target.closest('[data-eye]');
  if (eye) { const sp = S.film.splats.find(s => s.id === eye.dataset.eye); sp.visible = sp.visible === false; VP.applySplatProps(); commit(); return; }
  const it = e.target.closest('.pi');
  if (!it) return;
  const { k, id } = it.dataset;
  if (k === 'splat') select('splat', id);
  if (k === 'path') { select('path', id, { pathId: id }); }
  if (k === 'target') select('target', id);
});
pool.addEventListener('dblclick', e => {
  const it = e.target.closest('.pi');
  if (!it) return;
  const { k, id } = it.dataset;
  if (k === 'path') { addShot(findPath(id)); }
  if (k === 'media') { const m = S.film.media.find(x => x.name === id); addMedia(m, m.kind === 'audio' ? 'A1' : 'V1', S.playhead); }
  if (k === 'splat' || k === 'target') VP.frameSelection();
});
pool.addEventListener('dragstart', e => {
  const it = e.target.closest('.pi');
  if (!it) return;
  const { k, id } = it.dataset;
  const m = k === 'media' && S.film.media.find(x => x.name === id);
  e.dataTransfer.setData('text/x-director', JSON.stringify(k === 'path' ? { type: 'shot', ref: id } : { type: m.kind, ref: id }));
});

function addShot(path, index) {
  const film = S.film, c = M.newClip(film, 'shot', path.id, M.shotDuration(path), { full: true });
  const v1 = film.clips.filter(x => x.track === 'V1'), rest = film.clips.filter(x => x.track !== 'V1');
  v1.splice(index ?? v1.length, 0, c);
  film.clips = [...v1, ...rest];
  select('clip', c.id);
  commit();
}
function addMedia(m, track, at, index) {
  const film = S.film, dur = m.duration || 5;
  if (m.kind === 'audio' || track !== 'V1') {
    const c = M.newClip(film, 'audio', m.name, dur, { track: m.kind === 'audio' ? (track === 'V1' ? 'A1' : track) : 'A1', start: at || 0 });
    if (m.kind !== 'audio') c.type = 'audio';
    film.clips.push(c);
    select('clip', c.id);
  } else {
    const c = M.newClip(film, 'video', m.name, dur);
    const v1 = film.clips.filter(x => x.track === 'V1'), rest = film.clips.filter(x => x.track !== 'V1');
    v1.splice(index ?? v1.length, 0, c);
    film.clips = [...v1, ...rest];
    select('clip', c.id);
  }
  commit();
}
on('addShot', p => addShot(p));
on('dropItem', (item, track, t, index) => {
  if (item.type === 'shot') { const p = findPath(item.ref); if (p) addShot(p, index); return; }
  const m = S.film.media.find(x => x.name === item.ref);
  if (m) addMedia(m, track, t, index);
});
on('pathCreated', path => {  // new paths go straight onto the timeline so you can play them
  const film = S.film;
  film.clips = [...film.clips.filter(x => x.track === 'V1'), M.newClip(film, 'shot', path.id, M.shotDuration(path), { full: true }), ...film.clips.filter(x => x.track !== 'V1')];
});
on('frameSelection', () => VP.frameSelection());

// splats from the projects folder
async function splatPicker() {
  const list = await (await fetch('/api/splats')).json();
  S.splatsInfo = list;
  const dlg = $('dialog');
  dlg.innerHTML = `<div class="dlg"><h3>Add a splat</h3><p class="note">From your Splat Studio projects. Add a second one to line up a before & after.</p>
    <div class="splat-list">${list.map((s, i) => `<button class="splat-opt" data-i="${i}">${s.thumb ? `<img src="${s.thumb}">` : '<span class="noimg">✦</span>'}
      <span><b>${esc(s.name)}</b><small>${esc(s.project)}/${esc(s.file)} · ${s.mb} MB${s.up ? '' : ' · no camera info'}</small></span></button>`).join('') || '<p>No splats found in projects/.</p>'}</div>
    <p class="note">Or drop a .splat / .ply file onto the window.</p>
    <div class="btns"><button id="dlgClose">Cancel</button></div></div>`;
  dlg.style.display = 'grid';
  $('dlgClose').onclick = () => { dlg.style.display = 'none'; };
  dlg.querySelectorAll('.splat-opt').forEach(b => b.onclick = () => { dlg.style.display = 'none'; addSplat(list[+b.dataset.i]); });
}
function addSplat(info) {
  const film = S.film, first = !film.splats.length;
  const sp = { id: M.uid('s'), name: info.name, url: info.url, visible: true, opacity: 1, pos: [0, 0, 0], rot: [0, 0, 0], scale: 1,
               base: { up: info.up || null, center: info.center || null, start: info.start || null } };
  film.splats.push(sp);
  if (first && info.fov) film.fov = info.fov;
  if (first && info.start && info.center) {  // splat units are arbitrary: make 100% speed suit this scene's size
    const d = Math.hypot(...info.start.pos.map((v, i) => v - info.center[i]));
    film.baseSpeed = +Math.max(0.05, d * 0.25).toFixed(2);
  }
  select('splat', sp.id);
  commit();
  VP.syncSplats().then(() => { if (first) VP.startView(sp); navReady = true; });
}

// importing files (button or drag & drop onto the window)
$('fileIn').onchange = e => { importFiles([...e.target.files]); e.target.value = ''; };
addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
addEventListener('drop', e => {
  document.body.classList.remove('dropping');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  importFiles([...e.dataTransfer.files]);
});
async function importFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    toast(`Importing ${f.name}…`);
    const r = await fetch('/api/media?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    const res = await r.json();
    if (res.error) { toast(res.error); continue; }
    const m = res.media;
    if (['splat', 'ply', 'ksplat'].includes(ext)) { addSplat({ name: f.name.replace(/\.\w+$/, ''), url: m.url }); continue; }
    m.duration = await probeDuration(m.url, m.kind);
    if (!m.duration) { toast(`Couldn't read ${f.name} as video or audio`); continue; }
    S.film.media.push(m);
    commit();
    toast(`${m.name} imported — drag it to the timeline`);
  }
}
function probeDuration(url, kind) {
  return new Promise(res => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => res(isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => res(0);
    el.src = url;
  });
}

// ---------- films ----------
async function openFilm(name) {
  const r = await fetch('/api/film?name=' + encodeURIComponent(name));
  if (!r.ok) { toast(`Couldn't open ${name}`); return; }
  S.film = await r.json();
  afterLoad();
}
function afterLoad() {
  S.playhead = 0;
  select(null, null);
  resetHistory();
  hooks.normalize();
  emit('film');
  emit('change');
  $('filmName').textContent = S.film.name;
  try { localStorage.setItem('director:last', S.film.name); } catch {}
  navReady = false;
  VP.syncSplats().then(() => {
    navReady = true;
    let nav = null;
    try { nav = JSON.parse(localStorage.getItem('director:nav:' + S.film.name)); } catch {}
    if (nav) VP.setNavState(nav); else if (S.film.splats[0]) VP.startView(S.film.splats[0]);
    if (nav?.playhead) TL.seek(Math.min(nav.playhead, M.filmDuration(S.film)));  // back where you left off
  });
  VP.layout();
}
let navReady = false;  // don't save the camera before the film's view has been set up
setInterval(() => { if (navReady) try { localStorage.setItem('director:nav:' + S.film.name, JSON.stringify({ ...VP.navState(), playhead: S.playhead })); } catch {} }, 3000);
async function newFilm(name) {
  S.film = M.newFilm(name);
  afterLoad();
  await save();
}
// ---------- the film list (left panel): open, duplicate, rename, delete ----------
let filmList = [];
async function refreshFilms() {
  try { filmList = await (await fetch('/api/films')).json(); } catch { return; }
  poolRender();
}
const cleanName = v => v.replace(/[^A-Za-z0-9 _.-]+/g, '_').trim().slice(0, 60);
function askName(title, value, done) {
  const dlg = $('dialog');
  dlg.innerHTML = `<div class="dlg"><h3>${esc(title)}</h3><div class="f"><label>Name</label><input id="askIn" class="wide" value="${esc(value)}"></div>
    <div class="btns"><button id="askOk" class="primary">OK</button><button id="askNo">Cancel</button></div></div>`;
  dlg.style.display = 'grid';
  const inp = $('askIn');
  inp.focus(); inp.select();
  const ok = async () => {
    const n = cleanName(inp.value);
    if (!n) return;
    if (filmList.some(f => f.name === n)) { toast('A film with that name already exists'); return; }
    dlg.style.display = 'none';
    await done(n);
    refreshFilms();
  };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') dlg.style.display = 'none'; };
  $('askOk').onclick = ok;
  $('askNo').onclick = () => { dlg.style.display = 'none'; };
}
function moveLocal(from, to) {  // per-film view memory follows a rename
  try { for (const k of ['nav']) { const v = localStorage.getItem(`director:${k}:${from}`); if (v) localStorage.setItem(`director:${k}:${to}`, v); } } catch {}
}
async function renameFilm(from, to) {
  if (from === S.film.name) await save();
  const r = await (await fetch(`/api/film/rename?name=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: 'POST' })).json();
  if (r.error) { toast(r.error); return; }
  moveLocal(from, to);
  if (from === S.film.name) { S.film.name = to; $('filmName').textContent = to; try { localStorage.setItem('director:last', to); } catch {} }
}
async function filmAction(act, name) {
  if (act === 'open') { if (name !== S.film.name) { await save(); await openFilm(name); } return; }
  if (act === 'ren') return askName(`Rename "${name}"`, name, n => renameFilm(name, n));
  if (act === 'dup') return askName(`Duplicate "${name}"`, `${name} copy`, async n => {
    if (name === S.film.name) await save();
    const r = await (await fetch(`/api/film/duplicate?name=${encodeURIComponent(name)}&to=${encodeURIComponent(n)}`, { method: 'POST' })).json();
    if (r.error) { toast(r.error); return; }
    moveLocal(name, n);
    await openFilm(n);  // you now edit the copy; the original stays as it was
    toast(`Now editing the copy "${n}". "${name}" is unchanged.`);
  });
  if (act === 'del') {
    const dlg = $('dialog');
    dlg.innerHTML = `<div class="dlg"><h3>Delete "${esc(name)}"?</h3><p class="note">It's moved to app_data/director/films/.trash, so it can still be recovered by hand.</p>
      <div class="btns"><button id="delOk" class="danger">Delete</button><button id="delNo">Cancel</button></div></div>`;
    dlg.style.display = 'grid';
    $('delNo').onclick = () => { dlg.style.display = 'none'; };
    $('delOk').onclick = async () => {
      dlg.style.display = 'none';
      await fetch(`/api/film/delete?name=${encodeURIComponent(name)}`, { method: 'POST' });
      filmList = filmList.filter(f => f.name !== name);
      if (name === S.film.name) {
        S.dirty = false;
        if (filmList[0]) await openFilm(filmList[0].name); else await newFilm('My first film');
      }
      refreshFilms();
    };
  }
}
on('rename', v => { const n = cleanName(v); if (n && n !== S.film.name) { if (filmList.some(f => f.name === n)) toast('A film with that name already exists'); else renameFilm(S.film.name, n).then(refreshFilms); } });
on('saved', () => { if (!filmList.some(f => f.name === S.film.name)) refreshFilms(); });
on('film', refreshFilms);
$('filmBtn').onclick = async () => {
  const films = await (await fetch('/api/films')).json();
  const dlg = $('dialog');
  dlg.innerHTML = `<div class="dlg"><h3>Films</h3>
    <div class="film-list">${films.map(f => `<button class="film-opt" data-n="${esc(f.name)}"><b>${esc(f.name)}</b><small>${new Date(f.modified * 1000).toLocaleString()}</small></button>`).join('')}</div>
    <div class="f"><label>New film</label><input id="newName" class="wide" placeholder="Name" value="Film ${films.length + 1}"></div>
    <div class="btns"><button id="dlgNew" class="primary">Create</button><button id="dlgClose">Cancel</button></div></div>`;
  dlg.style.display = 'grid';
  $('dlgClose').onclick = () => { dlg.style.display = 'none'; };
  $('newName').onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') $('dlgNew').click(); };
  $('dlgNew').onclick = async () => {
    const n = $('newName').value.replace(/[^A-Za-z0-9 _.-]+/g, '_').trim();
    if (!n) return;
    if (films.some(f => f.name === n)) { toast('That name is taken'); return; }
    dlg.style.display = 'none';
    await save();
    newFilm(n);
  };
  dlg.querySelectorAll('.film-opt').forEach(b => b.onclick = async () => { dlg.style.display = 'none'; await save(); openFilm(b.dataset.n); });
};
on('saved', () => { $('saveState').textContent = 'Saved'; });
on('change', () => { if (S.dirty) $('saveState').textContent = 'Saving…'; });

// ---------- export ----------
$('exportBtn').onclick = async () => {
  const film = S.film, dur = M.filmDuration(film);
  if (!dur) { toast('Put something on the timeline first'); return; }
  const dlg = $('dialog');
  const frames = Math.round(dur * film.fps);
  dlg.innerHTML = `<div class="dlg wide"><h3>Export</h3>
    <p class="note">${film.width}×${film.height} · ${film.fps} fps · ${TL.timecode(dur)} (${frames} frames). Saved to ~/Movies/Splat Director.
    Every frame waits for a full depth sort, so it is slower than the preview but has no flicker.</p>
    <canvas id="expPrev" width="480" height="270"></canvas>
    <div class="bar"><div id="expBar"></div></div><div id="expMsg" class="note">Starting…</div>
    <div class="btns"><button id="expCancel">Cancel</button></div></div>`;
  dlg.style.display = 'grid';
  const prev = $('expPrev').getContext('2d');
  let done = false;
  $('expCancel').onclick = () => { if (done) dlg.style.display = 'none'; else P.abortExport(); };
  await save();
  const nav = VP.navState();
  try {
    const res = await P.exportFilm(p => {
      $('expBar').style.width = (p.frame / p.frames * 100).toFixed(1) + '%';
      $('expMsg').textContent = p.stage || `Frame ${p.frame} / ${p.frames} · about ${fmtTime(p.eta)} left`;
      if (p.preview) prev.drawImage(p.preview, 0, 0, 480, 270);
    });
    done = true;
    VP.setNavState(nav);
    $('expMsg').innerHTML = `Done: <b>${esc(res.path)}</b>`;
    $('expCancel').textContent = 'Close';
    const show = document.createElement('button');
    show.className = 'primary'; show.textContent = 'Show in Finder';
    show.onclick = () => fetch('/api/reveal?path=' + encodeURIComponent(res.path), { method: 'POST' });
    $('expCancel').before(show);
  } catch (e) {
    done = true;
    VP.setNavState(nav);
    $('expMsg').textContent = e.message === 'cancelled' ? 'Cancelled.' : 'Export failed: ' + e.message;
    $('expCancel').textContent = 'Close';
  }
};
const fmtTime = s => s > 90 ? Math.round(s / 60) + ' min' : Math.round(s) + ' s';

// ---------- keyboard ----------
addEventListener('keydown', e => {
  if (e.target.closest?.('input, select, textarea')) return;
  if ($('dialog').style.display === 'grid') { if (e.key === 'Escape') $('dialog').style.display = 'none'; return; }
  if (VP.keyDown(e)) { e.preventDefault(); return; }
  const k = e.key.toLowerCase(), cmd = e.metaKey || e.ctrlKey, f = 1 / S.film.fps;
  if (cmd && k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
  if (cmd && k === 'y') { e.preventDefault(); redo(); return; }
  if (cmd && k === 's') { e.preventDefault(); save(); return; }
  if (cmd && k === 'b') { e.preventDefault(); TL.splitAtPlayhead(); return; }
  if (cmd && k === 't') { e.preventDefault(); TL.dissolveAtPlayhead(); return; }
  if (cmd) return;
  if (k === ' ') { e.preventDefault(); togglePlay(); return; }
  if (k === 'arrowleft') { e.preventDefault(); P.pause(); TL.seek(S.playhead - (e.shiftKey ? 1 : f)); return; }
  if (k === 'arrowright') { e.preventDefault(); P.pause(); TL.seek(S.playhead + (e.shiftKey ? 1 : f)); return; }
  if (k === 'home') { TL.seek(0); return; }
  if (k === 'end') { TL.seek(M.filmDuration(S.film)); return; }
  if (k === '0' || k === '`') { setView(S.view === 'camera' ? 'free' : 'camera'); return; }
  if (k === 'escape') { if (S.tool !== 'select') setTool('select'); else select(null, null); return; }
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); return; }
  if (k === 'g') { if (S.view === 'free') VP.startGrab(); return; }
  if (k === 'p') { if (S.view !== 'free') setView('free'); VP.nodeAtCamera(); return; }
  if (k === 'f') { if (S.view !== 'free') setView('free'); VP.frameSelection(); return; }
  const tool = TOOLS.find(t => t[1].toLowerCase() === k);
  if (tool) { if (S.view !== 'free') setView('free'); setTool(tool[0]); }
});
addEventListener('keyup', e => VP.keyUp(e));

function deleteSelection() {
  const film = S.film, s = S.sel, path = findPath(s.pathId);
  if (TL.deleteSelected()) return;
  if (s.kind === 'node' && path) {
    if (path.nodes.length <= 2) { toast('A path needs 2 points. Select the path to delete it.'); return; }
    path.nodes.splice(s.index, 1); delete path.gen; M.fitKeysToLength(path); select('path', path.id, { pathId: path.id }); commit();
  } else if (s.kind === 'key' && path) {
    if (path.keys.length <= 2) { toast('A move needs at least two keys'); return; }
    const i = path.keys.findIndex(k => k.id === s.id);
    path.keys.splice(i, 1);
    if (i === 0) path.keys[0].t = 0;
    path.keys[path.keys.length - 1].pin = 'end';
    select('path', path.id, { pathId: path.id }); commit();
  } else if (s.kind === 'path' && path) {
    film.paths = film.paths.filter(p => p !== path);
    film.clips = film.clips.filter(c => !(c.type === 'shot' && c.ref === path.id));
    select(null, null); commit();
  } else if (s.kind === 'target') {
    film.targets = film.targets.filter(t => t.id !== s.id);
    film.paths.forEach(p => p.keys.forEach(k => { if (k.target === s.id) { k.look = 'path'; k.target = null; } }));
    select(null, null); commit();
  }
}

// ---------- status, toasts ----------
on('status', msg => {
  $('vpStatus').textContent = msg; $('vpStatus').style.display = msg && !splashUp ? 'block' : 'none';
  if (splashUp && msg) {
    $('splashMsg').textContent = msg;
    const pct = msg.match(/(\d+)%/);
    $('splashBar').style.width = pct ? (+pct[1] * 0.85) + '%' : (/Preparing/.test(msg) ? '92%' : $('splashBar').style.width);
  }
});

// ---------- loading screen: up until the film and its splats are ready ----------
export const VERSION = '0.9';
$('ver').textContent = 'v' + VERSION;
$('splashVer').textContent = 'version ' + VERSION;
let splashUp = true;
function hideSplash() {
  if (!splashUp) return;
  splashUp = false;
  $('splashBar').style.width = '100%';
  setTimeout(() => $('splash').classList.add('gone'), 150);
  setTimeout(() => $('splash').remove(), 600);
}
on('splatsLoaded', () => setTimeout(hideSplash, 250));

// ---------- quick tooltips (the browser's own take over a second to appear) ----------
const tip = $('tip');
let tipEl = null, tipTimer = null;
function tipFor(el) {
  if (el.title) { el.dataset.tip = el.title; el.removeAttribute('title'); }  // keep the slow native one from showing too
  return el.dataset.tip;
}
addEventListener('mouseover', e => {
  const el = e.target.closest?.('[title], [data-tip]');
  if (el === tipEl) return;
  clearTimeout(tipTimer); tip.classList.remove('show'); tipEl = el;
  if (!el || !tipFor(el)) return;
  tipTimer = setTimeout(() => {
    tip.textContent = el.dataset.tip;
    const r = el.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px'; tip.classList.add('show');
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2)) + 'px';
    tip.style.top = (r.bottom + h + 10 < innerHeight ? r.bottom + 6 : r.top - h - 6) + 'px';
  }, 150);
});
addEventListener('mousemove', e => {  // elements that change their hint as you move (the speed graph)
  if (tipEl && tipEl.title && tipEl.contains(e.target)) { tip.textContent = tipFor(tipEl); }
});
addEventListener('pointerdown', () => { clearTimeout(tipTimer); tip.classList.remove('show'); tipEl = null; }, true);
let toastTimer = null;
on('toast', msg => {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
});
on('change', poolRender);
on('select', poolRender);
on('film', poolRender);
on('splatsLoaded', () => VP.requestRender());
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// ---------- lifecycle: same rules as Splat Studio (closing the window stops the server) ----------
const beat = () => fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
beat(); setInterval(beat, 30000);
addEventListener('pagehide', () => {
  // closing the window: write the film and where you were, so the next start opens right here
  if (S.dirty) navigator.sendBeacon('/api/film?name=' + encodeURIComponent(S.film.name), new Blob([JSON.stringify(S.film)]));
  try { if (navReady) localStorage.setItem('director:nav:' + S.film.name, JSON.stringify({ ...VP.navState(), playhead: S.playhead })); } catch {}
  navigator.sendBeacon('/api/bye');
});
addEventListener('beforeunload', () => { if (S.dirty) save(); });

// ---------- start ----------
(async () => {
  const films = await (await fetch('/api/films')).json();
  let last = null;
  try { last = localStorage.getItem('director:last'); } catch {}
  const pick = films.find(f => f.name === last) || films[0];
  setTimeout(hideSplash, 120000);  // never leave the loading screen up forever
  if (pick) { await openFilm(pick.name); if (!S.film.splats.length) hideSplash(); return; }
  // first run: a film with the newest splat already in it
  await newFilm('My first film');
  const list = await (await fetch('/api/splats')).json();
  if (list[0]) { addSplat(list[0]); await save(); }
})();
void INS;
window.__director = { S, VP, M, P, TL };  // handy from the browser console when debugging
