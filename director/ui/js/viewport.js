// The big 3D view: splat rendering, navigation, path drawing/editing tools and the overlay (paths, keys, gizmo).
//
// Navigation never stalls near the middle (the web viewer's orbit zoom shrinks the distance to a pivot by a
// percentage, so it can never pass it). Here the scroll step is a share of the distance to whatever is under the
// cursor, with a floor, so you can fly straight through the scene:
//   left-drag orbit around the point under the cursor · right-drag look around (+ W A S D Q E to fly)
//   middle-drag or shift-drag pan · scroll / pinch move toward the cursor · double-click focus there
import * as THREE from 'three';
import * as GS from '/tools/viewer/lib/gaussian-splats-3d.module.js';
import { S, emit, on, commit, live, select, findPath, toast } from './state.js';
import * as M from './model.js';

const DEG = Math.PI / 180;
const el = document.getElementById('vp');
const canvas3d = document.createElement('canvas');
const overlay = document.createElement('canvas');
canvas3d.className = 'vp-gl';
overlay.className = 'vp-overlay';
el.prepend(canvas3d);
el.append(overlay);
const octx = overlay.getContext('2d');

export const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: false, preserveDrawingBuffer: true });
export const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 2000);
camera.position.set(0, 1.5, 5);
const nav = { yaw: 0, pitch: -10, pivot: new THREE.Vector3(0, 0.5, 0), flySpeed: 1 };
export const opts = { quality: Math.min(devicePixelRatio, 1.5), grid: true, standoff: 0.25 };
let viewer = null;
let loaded = [];          // splat ids in viewer scene order
let loading = null;
let needRender = true;

function makeViewer() {
  viewer = new GS.Viewer({
    renderer, camera, selfDrivenMode: false, useBuiltInControls: false, cameraUp: [0, 1, 0],
    dynamicScene: true,            // splats can be moved for alignment
    enableOptionalEffects: true,   // per-splat opacity, for before/after fades and onion-skin aligning
    sharedMemoryForWorkers: false, sphericalHarmonicsDegree: 2, antialiased: true,
    sceneRevealMode: GS.SceneRevealMode.Instant, logLevel: GS.LogLevel.None,
  });
  setQuality(opts.quality);
}

export function setQuality(q) {
  opts.quality = q;
  renderer.setPixelRatio(q);
  if (viewer) { viewer.devicePixelRatio = q; if (viewer.splatMesh) viewer.splatMesh.devicePixelRatio = q; }
  needRender = true;
}

// ---------- splats ----------

const FORMATS = { splat: GS.SceneFormat.Splat, ksplat: GS.SceneFormat.KSplat, ply: GS.SceneFormat.Ply };
const blobs = {};
async function fetchBlob(sp, onProgress) {
  if (blobs[sp.url]) return blobs[sp.url];
  const r = await fetch(sp.url);
  if (!r.ok) throw new Error(`Couldn't load ${sp.name} (${r.status})`);
  const total = +r.headers.get('Content-Length') || 0, reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress(total ? got / total : 0);
  }
  return (blobs[sp.url] = URL.createObjectURL(new Blob(parts)));
}

// Load or reload when the list of splats changed; otherwise just update their transforms and visibility.
export async function syncSplats() {
  const want = S.film.splats.map(s => s.id + '|' + s.url);
  const have = loaded.map(id => { const s = S.film.splats.find(x => x.id === id); return s ? s.id + '|' + s.url : '?'; });
  if (want.join() !== have.join() || loaded.length !== S.film.splats.length) {
    if (loading) { loading.again = true; return loading.p; }
    loading = { again: false };
    loading.p = (async () => {
      try {
        do {
          loading.again = false;
          const list = S.film.splats.slice();
          const urls = [];
          for (const [i, sp] of list.entries()) {
            urls.push(await fetchBlob(sp, f => emit('status', `Loading ${sp.name} (${i + 1}/${list.length})… ${Math.round(f * 100)}%`)));
          }
          emit('status', list.length ? 'Preparing splats…' : '');
          if (viewer) { await viewer.dispose(); }
          makeViewer();
          if (list.length) {
            await viewer.addSplatScenes(list.map((sp, i) => {
              const tr = M.splatTransform(sp);
              const ext = sp.url.split('?')[0].split('.').pop().toLowerCase();
              return { path: urls[i], format: FORMATS[ext] ?? GS.SceneFormat.Splat, splatAlphaRemovalThreshold: 5,
                       position: tr.position.toArray(), rotation: tr.quaternion.toArray(), scale: tr.scale.toArray() };
            }), false);
          }
          loaded = list.map(s => s.id);
        } while (loading.again);
      } catch (e) {
        console.error(e);
        toast(String(e.message || e));
      } finally {
        loading = null;
        emit('status', '');
        applySplatProps();
        emit('splatsLoaded');
      }
    })();
    return loading.p;
  }
  applySplatProps();
}

// visibleIds: which splats to show (null = each splat's own visible flag). opacityOverride: {id: opacity}
export function applySplatProps(visibleIds = null, opacityOverride = null) {
  if (!viewer || !viewer.splatMesh || loading) return;
  loaded.forEach((id, i) => {
    const sp = S.film.splats.find(s => s.id === id), sc = viewer.getSplatScene(i);
    if (!sp || !sc) return;
    const tr = M.splatTransform(sp);
    sc.position.copy(tr.position); sc.quaternion.copy(tr.quaternion); sc.scale.copy(tr.scale);
    sc.visible = visibleIds ? visibleIds.includes(id) : sp.visible !== false;
    sc.opacity = opacityOverride?.[id] ?? (visibleIds ? 1 : (sp.opacity ?? 1));
  });
  needRender = true;
}
export const ready = () => !!(viewer && viewer.splatMesh && viewer.splatRenderReady && !loading && loaded.length);
export const isLoading = () => !!loading;
export const sorting = () => !!viewer?.sortRunning;

// ---------- sizing ----------

let frameRect = null;  // in camera view: the output frame inside the viewport, {x, y, w, h}
export function layout() {
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  overlay.width = W * devicePixelRatio; overlay.height = H * devicePixelRatio;
  overlay.style.width = W + 'px'; overlay.style.height = H + 'px';
  if (exporting) return;
  if (S.view === 'camera') {
    const ar = S.film.width / S.film.height, w = Math.min(W, H * ar), h = w / ar;
    frameRect = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  } else frameRect = { x: 0, y: 0, w: W, h: H };
  renderer.setSize(Math.round(frameRect.w), Math.round(frameRect.h));
  canvas3d.style.left = frameRect.x + 'px'; canvas3d.style.top = frameRect.y + 'px';
  camera.aspect = frameRect.w / frameRect.h;
  camera.updateProjectionMatrix();
  needRender = true;
  emit('layout', frameRect);
}
new ResizeObserver(layout).observe(el);
export const getFrameRect = () => frameRect;

// ---------- rendering ----------

function applyNav() {
  camera.quaternion.setFromEuler(new THREE.Euler(nav.pitch * DEG, nav.yaw * DEG, 0, 'YXZ'));
  camera.updateMatrixWorld();
}
export function setPose(pos, quat, fov) {
  camera.position.copy(pos);
  camera.quaternion.copy(quat);
  if (fov && Math.abs(camera.fov - fov) > 1e-4) { camera.fov = fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}
export const freePose = () => ({ pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov });

// Draw the splats from the current camera. exact: wait for a full depth sort first (for export).
export async function renderSplats(exact = false) {
  if (!ready()) {
    // the viewer isn't ready until its first sort: keep it updating so that sort happens, and draw black
    if (viewer?.splatMesh && !loading) viewer.update();
    renderer.setClearColor(0x000000, 1); renderer.clear();
    return false;
  }
  viewer.update();
  if (exact) {
    await viewer.runSplatSort(true, true);
    while (viewer.sortRunning) await yieldTask();
    viewer.update();
  }
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  viewer.render();
  return true;
}
export const canvas = () => canvas3d;

// Let the sort worker's reply in. Unlike setTimeout this isn't slowed to once a second when the window is in
// the background, so an export keeps its speed while you do something else.
const chan = new MessageChannel(), waiting = [];
chan.port1.onmessage = () => waiting.shift()?.();
export const yieldTask = () => new Promise(r => { waiting.push(r); chan.port2.postMessage(0); });

// Free view frame: splats + overlay. Called by the app loop.
// The viewer re-sorts on every update in dynamic mode, so only update when something moved; once that sort
// lands, draw one more frame without updating (which would start yet another sort).
let sortPending = false;
export function drawFree(force) {
  if (!S.aimKey) { applyNav(); if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); } }
  if (force || needRender || flying()) {
    needRender = !renderSplats();
    sortPending = true;
  } else if (sortPending && viewer && !viewer.sortRunning) {
    sortPending = false;
    if (ready()) { renderer.setClearColor(0x000000, 1); renderer.clear(); viewer.render(); }
  }
  drawOverlay();
}
export const requestRender = () => { needRender = true; };

// ---------- projection helpers ----------

const tmp = new THREE.Vector3();
function project(v) {  // world -> overlay px; null when behind the camera
  tmp.copy(v).applyMatrix4(camera.matrixWorldInverse);
  if (tmp.z > -camera.near) return null;
  const z = -tmp.z;
  tmp.applyMatrix4(camera.projectionMatrix);
  return { x: frameRect.x + (tmp.x + 1) / 2 * frameRect.w, y: frameRect.y + (1 - tmp.y) / 2 * frameRect.h, z };
}
function rayAt(mx, my) {
  const ndc = new THREE.Vector2((mx - frameRect.x) / frameRect.w * 2 - 1, -((my - frameRect.y) / frameRect.h * 2 - 1));
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, camera);
  return rc.ray;
}
const pxSize = (p, px) => {  // world size of px pixels at point p
  const d = Math.max(0.01, tmp.copy(p).applyMatrix4(camera.matrixWorldInverse).z * -1);
  return px * 2 * d * Math.tan(camera.fov * DEG / 2) / frameRect.h;
};

// Splat surface under the mouse (null when nothing is hit).
const gsHits = [];
export function hitSplat(mx, my) {
  if (!ready()) return null;
  const rc = viewer.raycaster;
  rc.setFromCameraAndScreenPosition(camera, new THREE.Vector2(mx - frameRect.x, my - frameRect.y), new THREE.Vector2(frameRect.w, frameRect.h));
  gsHits.length = 0;
  rc.intersectSplatMesh(viewer.splatMesh, gsHits);
  // the library returns every splat the ray touches, faint floaters included: walk them front to back and
  // stop where enough opacity has built up to count as a solid surface
  let clear = 1;
  for (const h of gsHits) {
    viewer.splatMesh.getSplatColor(h.splatIndex, hitColor);
    clear *= 1 - Math.min(0.9, hitColor.w / 255 * 0.5);
    if (clear < 0.3) return h.origin.clone();
  }
  return gsHits.length > 8 ? gsHits[gsHits.length - 1].origin.clone() : null;
}
const hitColor = new THREE.Vector4();

// Where a click places a point: on the splat (pulled back toward the camera by the stand-off), or at the
// pivot's depth when the click misses.
function placeAt(mx, my, standoff = opts.standoff) {
  const ray = rayAt(mx, my), hit = hitSplat(mx, my);
  if (hit) {
    const d = Math.max(0.05, ray.origin.distanceTo(hit) - standoff);
    return ray.origin.clone().addScaledVector(ray.direction, d);
  }
  const d = Math.max(0.5, camera.position.distanceTo(nav.pivot));
  return ray.origin.clone().addScaledVector(ray.direction, d);
}

// ---------- overlay ----------

const C = { node: '#f2f2f2', sel: '#ffb35c', handle: '#9aa4b5', key: '#ffcf4a', target: '#ff5d73', cam: '#ffe066', gx: '#e5484d', gy: '#5fc95f', gz: '#4b8cf5' };
let gizmo = null;   // {origin, axes:[{dir, end, color, name}]} in screen space for picking
let hover = null;
let drawState = null;  // tool preview: {kind, a?, mouse}
let snapRing = null;

function polyline(pts, color, width, dash) {
  octx.strokeStyle = color; octx.lineWidth = width; octx.setLineDash(dash || []);
  octx.beginPath();
  let pen = false, prev = null;
  for (const p of pts) {
    const q = project(p);
    if (q && prev) { if (!pen) { octx.moveTo(prev.x, prev.y); pen = true; } octx.lineTo(q.x, q.y); }
    else if (!q) pen = false;
    prev = q;
  }
  octx.stroke();
  octx.setLineDash([]);
}
function dot(p, r, fill, stroke, square) {
  const q = project(p);
  if (!q) return null;
  octx.beginPath();
  if (square) octx.rect(q.x - r, q.y - r, 2 * r, 2 * r); else octx.arc(q.x, q.y, r, 0, 7);
  if (fill) { octx.fillStyle = fill; octx.fill(); }
  if (stroke) { octx.strokeStyle = stroke; octx.lineWidth = 1.5; octx.stroke(); }
  return q;
}
function frustum(pose, color, size = 0.18) {
  const f = Math.tan((pose.fov || 55) * DEG / 2), ar = S.film.width / S.film.height;
  const corner = (x, y) => new THREE.Vector3(x * f * ar * size, y * f * size, -size).applyQuaternion(pose.quat).add(pose.pos);
  const c = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  polyline([c[0], c[1], c[2], c[3], c[0]], color, 1.5);
  c.forEach(k => polyline([pose.pos, k], color, 1));
  const up = new THREE.Vector3(0, f * size * 1.5, -size).applyQuaternion(pose.quat).add(pose.pos);
  polyline([c[3], up, c[2]], color, 1.5);
}
function label(p, text, color) {
  const q = project(p);
  if (!q) return;
  octx.font = '600 11px -apple-system, sans-serif';
  octx.fillStyle = 'rgba(0,0,0,.6)';
  const w = octx.measureText(text).width + 8;
  octx.fillRect(q.x + 8, q.y - 18, w, 15);
  octx.fillStyle = color;
  octx.fillText(text, q.x + 12, q.y - 7);
}

export function selectionPoint() {
  const s = S.sel, p = findPath(s.pathId);
  if (s.kind === 'node' && p?.nodes[s.index]) return M.V(p.nodes[s.index].p);
  if (s.kind === 'handle' && p?.nodes[s.index]) {
    const h = M.handles(p)[s.index];
    return M.V(p.nodes[s.index].p).add(s.side === 'in' ? h.hin : h.hout);
  }
  if (s.kind === 'target') { const t = S.film.targets.find(x => x.id === s.id); return t && M.V(t.p); }
  if (s.kind === 'splat') { const sp = S.film.splats.find(x => x.id === s.id); return sp && M.V(sp.pos); }
  return null;
}

export function drawOverlay() {
  if (!frameRect) return;  // not laid out yet
  const W = overlay.width / devicePixelRatio, H = overlay.height / devicePixelRatio;
  octx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  octx.clearRect(0, 0, W, H);
  if (S.view === 'camera' && !S.aimKey) return;
  if (S.view === 'camera') { drawAimHud(); return; }
  const film = S.film;
  // ground grid on the floor plane (y = 0), every unit
  if (opts.grid) {
    for (let i = -10; i <= 10; i++) {
      const col = i === 0 ? null : 'rgba(255,255,255,.07)';
      polyline([new THREE.Vector3(i, 0, -10), new THREE.Vector3(i, 0, 10)], col || 'rgba(75,140,245,.55)', 1);
      polyline([new THREE.Vector3(-10, 0, i), new THREE.Vector3(10, 0, i)], col || 'rgba(229,72,77,.55)', 1);
    }
  }
  for (const path of film.paths) {
    const tb = M.table(path), active = S.sel.pathId === path.id || (S.sel.kind === 'path' && S.sel.id === path.id);
    polyline(tb.pts, active ? path.color : path.color + 'aa', active ? 3 : 2);
    const H = M.handles(path);
    path.nodes.forEach((n, i) => {
      const p = M.V(n.p), isSel = S.sel.pathId === path.id && S.sel.index === i;
      if (active && n.mode !== 'corner') {
        for (const side of ['in', 'out']) {
          const h = side === 'in' ? H[i].hin : H[i].hout;
          if (h.lengthSq() < 1e-10) continue;
          const hp = p.clone().add(h);
          polyline([p, hp], 'rgba(154,164,181,.8)', 1);
          const hs = S.sel.kind === 'handle' && isSel && S.sel.side === side;
          dot(hp, 3.5, hs ? C.sel : (n.mode === 'auto' ? '#5c6370' : C.handle));
        }
      }
      const end = i === 0 || i === path.nodes.length - 1;
      dot(p, isSel && S.sel.kind === 'node' ? 5.5 : 4, isSel && S.sel.kind === 'node' ? C.sel : (end ? path.color : C.node), '#000', true);
    });
    // camera keys: a little camera showing where that key aims
    path.keys.forEach((k, i) => {
      const pose = M.cameraAt(film, path, k.t);
      const isSel = S.sel.kind === 'key' && S.sel.id === k.id;
      frustum(pose, isSel ? C.sel : C.key, isSel ? 0.22 : 0.15);
      const q = dot(pose.pos, isSel ? 6 : 4.5, isSel ? C.sel : C.key, '#000');
      if (q) label(pose.pos, `${i + 1}`, isSel ? C.sel : C.key);
    });
    if (active) label(tb.pts[0] || new THREE.Vector3(), path.name, path.color);
  }
  for (const t of film.targets) {
    const isSel = S.sel.kind === 'target' && S.sel.id === t.id, q = project(M.V(t.p));
    if (!q) continue;
    octx.strokeStyle = isSel ? C.sel : C.target; octx.lineWidth = 2;
    octx.beginPath(); octx.arc(q.x, q.y, 7, 0, 7); octx.moveTo(q.x - 11, q.y); octx.lineTo(q.x + 11, q.y);
    octx.moveTo(q.x, q.y - 11); octx.lineTo(q.x, q.y + 11); octx.stroke();
    label(M.V(t.p), t.name, isSel ? C.sel : C.target);
  }
  // where the timeline camera is right now
  const pc = emitQuery('playheadPose');
  if (pc && pc.pos.distanceTo(camera.position) > 0.4) frustum(pc, C.cam, 0.3);  // (not when we're standing in it)
  // tool previews
  if (drawState?.kind === 'rubber') polyline([drawState.a, drawState.b], '#ffffffaa', 1.5, [5, 4]);
  if (drawState?.kind === 'arc') polyline(M.table({ nodes: M.arcNodes(drawState.a.toArray(), drawState.b.toArray(), drawState.up) }).pts, '#ffffffaa', 1.5, [5, 4]);
  if (snapRing) { const q = project(snapRing); if (q) { octx.strokeStyle = '#5fc95f'; octx.lineWidth = 2; octx.beginPath(); octx.arc(q.x, q.y, 11, 0, 7); octx.stroke(); } }
  drawGizmo();
  if (grab) drawGrabHud();
}

function drawGizmo() {
  gizmo = null;
  const p = selectionPoint();
  if (!p) return;
  const o = project(p);
  if (!o) return;
  const len = pxSize(p, 70);
  const axes = [['x', new THREE.Vector3(1, 0, 0), C.gx], ['y', new THREE.Vector3(0, 1, 0), C.gy], ['z', new THREE.Vector3(0, 0, 1), C.gz]];
  gizmo = { origin: o, world: p, axes: [] };
  for (const [name, dir, color] of axes) {
    const e = project(p.clone().addScaledVector(dir, len));
    if (!e) continue;
    const hot = hover?.kind === 'axis' && hover.axis === name || (grab && grab.axis === name) || (drag?.axis === name);
    octx.strokeStyle = color; octx.lineWidth = hot ? 4 : 2.5;
    octx.beginPath(); octx.moveTo(o.x, o.y); octx.lineTo(e.x, e.y); octx.stroke();
    const a = Math.atan2(e.y - o.y, e.x - o.x);
    octx.fillStyle = color; octx.beginPath();
    octx.moveTo(e.x + Math.cos(a) * 9, e.y + Math.sin(a) * 9);
    octx.lineTo(e.x + Math.cos(a + 2.4) * 7, e.y + Math.sin(a + 2.4) * 7);
    octx.lineTo(e.x + Math.cos(a - 2.4) * 7, e.y + Math.sin(a - 2.4) * 7);
    octx.fill();
    octx.font = '700 11px sans-serif'; octx.fillText(name.toUpperCase(), e.x + Math.cos(a) * 16 - 4, e.y + Math.sin(a) * 16 + 4);
    gizmo.axes.push({ name, dir, o, e });
  }
  octx.strokeStyle = hover?.kind === 'gizmo' ? '#fff' : '#ffffffaa'; octx.lineWidth = 1.5;
  octx.strokeRect(o.x - 6, o.y - 6, 12, 12);
}
function drawGrabHud() {
  octx.font = '600 12px -apple-system, sans-serif'; octx.fillStyle = '#fff';
  const d = grab.delta || new THREE.Vector3();
  octx.fillText(`Move ${grab.axis ? grab.axis.toUpperCase() + ' axis' : 'free'}   Δ ${d.x.toFixed(3)}, ${d.y.toFixed(3)}, ${d.z.toFixed(3)}   ·  X / Y / Z lock an axis · click or Enter to place · Esc cancel`, 12, overlay.height / devicePixelRatio - 14);
}
function drawAimHud() {
  octx.font = '600 12px -apple-system, sans-serif'; octx.fillStyle = '#ffcf4a';
  octx.fillText('Aiming key — drag to turn, scroll to zoom (FOV), Alt-drag to roll · Esc or Enter when done', frameRect.x + 12, frameRect.y + 20);
}

// other modules answer small questions through this (avoids circular imports)
const queries = {};
export const answer = (name, fn) => { queries[name] = fn; };
const emitQuery = (name, ...a) => queries[name]?.(...a);

// ---------- picking ----------

function distToSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? M.clamp(((px - a.x) * dx + (py - a.y) * dy) / L, 0, 1) : 0;
  return { d: Math.hypot(px - a.x - t * dx, py - a.y - t * dy), t };
}
function pick(mx, my) {
  if (gizmo) {
    for (const ax of gizmo.axes) if (distToSeg(mx, my, ax.o, ax.e).d < 7) return { kind: 'axis', axis: ax.name };
    if (Math.abs(mx - gizmo.origin.x) < 8 && Math.abs(my - gizmo.origin.y) < 8) return { kind: 'gizmo' };
  }
  const found = [];
  const take = (d, r, o) => { if (d < r) found.push({ ...o, d }); };
  const film = S.film;
  for (const path of film.paths) {
    const active = S.sel.pathId === path.id || (S.sel.kind === 'path' && S.sel.id === path.id);
    const H = M.handles(path);
    path.nodes.forEach((n, i) => {
      const q = project(M.V(n.p));
      if (q) take(Math.hypot(q.x - mx, q.y - my) - 2, 9, { kind: 'node', pathId: path.id, index: i });  // points win ties
      if (active && n.mode !== 'corner') for (const side of ['in', 'out']) {
        const h = side === 'in' ? H[i].hin : H[i].hout;
        if (h.lengthSq() < 1e-10) continue;
        const hq = project(M.V(n.p).add(h));
        if (hq) take(Math.hypot(hq.x - mx, hq.y - my) - 1, 8, { kind: 'handle', pathId: path.id, index: i, side });
      }
    });
    path.keys.forEach(k => {
      const q = project(M.pointAt(path, M.sAt(path, k.t)));
      if (q) take(Math.hypot(q.x - mx, q.y - my), 9, { kind: 'key', pathId: path.id, id: k.id });
    });
  }
  for (const t of film.targets) {
    const q = project(M.V(t.p));
    if (q) take(Math.hypot(q.x - mx, q.y - my), 11, { kind: 'target', id: t.id });
  }
  if (found.length) {
    found.sort((a, b) => a.d - b.d);
    // clicking again on what's already selected picks the next thing under the mouse (e.g. a key on a point)
    const same = o => o.kind === S.sel.kind && (o.id ? o.id === S.sel.id : o.pathId === S.sel.pathId && o.index === S.sel.index && o.side === S.sel.side);
    return found.length > 1 && same(found[0]) ? found[1] : found[0];
  }
  const c = curveAt(mx, my, 7);
  return c ? { kind: 'curve', ...c } : null;
}
// nearest point on any path curve to the mouse: {pathId, s, d}
function curveAt(mx, my, radius, onlyPath) {
  let best = null;
  for (const path of S.film.paths) {
    if (onlyPath && path.id !== onlyPath) continue;
    const tb = M.table(path);
    let prev = null;
    for (let i = 0; i < tb.pts.length; i++) {
      const q = project(tb.pts[i]);
      if (q && prev) {
        const { d, t } = distToSeg(mx, my, prev.q, q);
        if (d < radius && (!best || d < best.d)) best = { pathId: path.id, s: tb.s[prev.i] + (tb.s[i] - tb.s[prev.i]) * t, d };
      }
      prev = q ? { q, i } : null;
    }
  }
  return best;
}
function endpointNear(mx, my, exceptPath, r = 14) {
  let best = null;
  for (const path of S.film.paths) {
    if (path.id === exceptPath || path.nodes.length < 1) continue;
    for (const [end, i] of [['start', 0], ['end', path.nodes.length - 1]]) {
      const q = project(M.V(path.nodes[i].p));
      if (q) { const d = Math.hypot(q.x - mx, q.y - my); if (d < r && (!best || d < best.d)) best = { path, end, index: i, d }; }
    }
  }
  return best;
}

// ---------- moving things (drag and Blender-style G grab) ----------

function getPoint(sel) {
  const p = findPath(sel.pathId);
  if (sel.kind === 'node') return M.V(p.nodes[sel.index].p);
  if (sel.kind === 'handle') { const h = M.handles(p)[sel.index]; return M.V(p.nodes[sel.index].p).add(sel.side === 'in' ? h.hin : h.hout); }
  if (sel.kind === 'target') return M.V(S.film.targets.find(x => x.id === sel.id).p);
  if (sel.kind === 'splat') return M.V(S.film.splats.find(x => x.id === sel.id).pos);
}
function setPoint(sel, v, alt) {
  const film = S.film, p = findPath(sel.pathId);
  if (sel.kind === 'node') {
    p.nodes[sel.index].p = v.toArray();
    if (p.gen) delete p.gen;  // edited by hand: no longer a generated spiral
    M.fitKeysToLength(p);
  } else if (sel.kind === 'handle') {
    const n = p.nodes[sel.index];
    if (n.mode !== 'free') M.freezeNode(p, sel.index);
    const off = v.clone().sub(M.V(n.p));
    if (sel.side === 'in') n.hin = off.toArray(); else n.hout = off.toArray();
    if (!alt) {  // keep the curve smooth through the node: the other handle points the opposite way
      const other = sel.side === 'in' ? 'hout' : 'hin', len = M.V(n[other]).length();
      if (len > 1e-9 && off.lengthSq() > 1e-12) n[other] = off.clone().normalize().multiplyScalar(-len).toArray();
    }
    if (p.gen) delete p.gen;
    M.fitKeysToLength(p);
  } else if (sel.kind === 'target') film.targets.find(x => x.id === sel.id).p = v.toArray();
  else if (sel.kind === 'splat') { film.splats.find(x => x.id === sel.id).pos = v.toArray(); applySplatProps(); }
}
// new position for a move that started at `start` with the mouse at (mx0,my0), now at (mx,my)
function movedPoint(start, mx0, my0, mx, my, axis) {
  if (axis) {
    const dir = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[axis];
    const closest = ray => {  // parameter along the axis line nearest to the ray
      const w0 = start.clone().sub(ray.origin), b = dir.dot(ray.direction), d = dir.dot(w0), e = ray.direction.dot(w0);
      const den = 1 - b * b;
      return den < 1e-6 ? 0 : (b * e - d) / den;
    };
    return start.clone().addScaledVector(dir, closest(rayAt(mx, my)) - closest(rayAt(mx0, my0)));
  }
  const n = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, start);
  const a = rayAt(mx0, my0).intersectPlane(plane, new THREE.Vector3()), b = rayAt(mx, my).intersectPlane(plane, new THREE.Vector3());
  return a && b ? start.clone().add(b.sub(a)) : start.clone();
}

const held = new Set();      // keys held down right now (x/y/z lock an axis while dragging)
let drag = null;             // mouse interaction in progress
let grab = null;             // G-key modal move: {sel, start, mx0, my0, axis, delta}
const mouse = { x: 0, y: 0 };
export const isGrabbing = () => !!grab;

export function startGrab() {
  const p = selectionPoint();
  if (!p) { toast('Select a point, handle, target or splat first, then press G'); return false; }
  grab = { sel: { ...S.sel }, start: p.clone(), mx0: mouse.x, my0: mouse.y, axis: null };
  needRender = true;
  return true;
}
function updateGrab() {
  const v = movedPoint(grab.start, grab.mx0, grab.my0, mouse.x, mouse.y, grab.axis);
  grab.delta = v.clone().sub(grab.start);
  setPoint(grab.sel, v, held.has('alt'));
  live();
}
function endGrab(ok) {
  if (!grab) return;
  if (!ok) { setPoint(grab.sel, grab.start); live(); } else afterMove(grab.sel);
  grab = null;
  commit();
}
// after moving an end node near another path's end: join them
function afterMove(sel) {
  snapRing = null;
  if (sel.kind !== 'node') return;
  const p = findPath(sel.pathId);
  if (!p || (sel.index !== 0 && sel.index !== p.nodes.length - 1)) return;
  const q = project(M.V(p.nodes[sel.index].p));
  const near = q && endpointNear(q.x, q.y, p.id, 10);
  if (!near) return;
  p.nodes[sel.index].p = [...near.path.nodes[near.index].p];
  // keep the order you'd expect: dropping your start onto another path's end means that path comes first
  const [keep, gone] = sel.index === 0 ? [near.path, p] : [p, near.path];
  if (sel.index === 0) M.joinPaths(near.path, near.end, p, 'start');
  else M.joinPaths(p, 'end', near.path, near.end);
  M.fitKeysToLength(keep);
  S.film.paths = S.film.paths.filter(x => x !== gone);
  S.film.clips = S.film.clips.filter(c => !(c.type === 'shot' && c.ref === gone.id));  // its shot is part of this one now
  select('path', keep.id, { pathId: keep.id });
  toast(`Joined ${gone.name} onto ${keep.name} — ⌘Z to undo`);
}

// ---------- drawing tools ----------

let drawing = null;  // {pathId, mode, fromStart}
export const isDrawing = () => !!drawing;
function addDrawNode(p, mode, hout) {
  const film = S.film;
  if (!drawing) {
    const path = M.newPath(film, [M.node(p.toArray(), mode)]);
    film.paths.push(path);
    drawing = { pathId: path.id, mode };
    select('node', null, { pathId: path.id, index: 0 });
  } else {
    const path = findPath(drawing.pathId);
    path.nodes.push(M.node(p.toArray(), mode));
    select('node', null, { pathId: path.id, index: path.nodes.length - 1 });
  }
  const path = findPath(drawing.pathId), n = path.nodes[path.nodes.length - 1];
  if (hout) { n.mode = 'free'; n.hout = hout.toArray(); n.hin = hout.clone().negate().toArray(); }
  M.fitKeysToLength(path);
  live();
}
// continue drawing from the end of an existing path
function continueFrom(ep) {
  if (ep.end === 'start') M.reversePath(ep.path);
  drawing = { pathId: ep.path.id, mode: S.tool === 'line' ? 'corner' : 'auto', fromStart: ep.end === 'start', L0: M.pathLength(ep.path) };
  select('node', null, { pathId: ep.path.id, index: ep.path.nodes.length - 1 });
}
export function finishDrawing() {
  if (!drawing) return;
  const film = S.film, path = findPath(drawing.pathId);
  const d = drawing;
  drawing = null; drawState = null;
  if (!path) return;
  if (path.nodes.length < 2) {
    film.paths = film.paths.filter(p => p !== path);
    select(null, null);
  } else {
    if (!path.keys.length) { M.defaultKeys(film, path); emit('pathCreated', path); }
    else M.fitKeysToLength(path);
    if (d.fromStart) {  // drawn off the start: flip back, and the move now starts at the new start
      M.reversePath(path);
      const added = M.pathLength(path) - d.L0, K = path.keys, prof = M.speedProfile(path);
      const v0 = Math.max(film.baseSpeed * 0.25, Math.abs(prof.v[0] || film.baseSpeed)), dt = added / v0;
      K.forEach(k => { k.t += dt; });
      K[0].s = 0; K[0].t = 0;
    }
    select('path', path.id, { pathId: path.id });
  }
  commit();
}

// Add a path point exactly where the camera is (fly there, press P).
export function nodeAtCamera() {
  if (S.view !== 'free') return;
  if (!drawing) {
    const p = findPath(S.sel.pathId);
    if (p && S.sel.kind === 'node' && (S.sel.index === 0 || S.sel.index === p.nodes.length - 1)) continueFrom({ path: p, end: S.sel.index === 0 ? 'start' : 'end' });
  }
  addDrawNode(camera.position.clone(), drawing?.mode || (S.tool === 'line' ? 'corner' : 'auto'));
  toast('Point added at the camera. Fly on and press P again, Enter to finish.');
}

function spiralFrom(center) {
  const film = S.film, cp = camera.position;
  const dx = cp.x - center.x, dz = cp.z - center.z;
  const r = Math.max(0.3, Math.hypot(dx, dz));
  const gen = { center: [center.x, cp.y, center.z], r0: r, r1: r, turns: 1, rise: 0, a0: Math.atan2(dz, dx) / DEG, dir: 1 };
  const path = M.newPath(film, M.spiralNodes(gen), `Orbit ${film.paths.length + 1}`);
  path.gen = gen;
  film.paths.push(path);
  const tg = { id: M.uid('t'), name: `Target ${film.targets.length + 1}`, p: center.toArray() };
  film.targets.push(tg);
  M.defaultKeys(film, path);
  path.keys.forEach(k => { k.look = 'target'; k.target = tg.id; });
  emit('pathCreated', path);
  select('path', path.id, { pathId: path.id });
  commit();
  toast('Orbit made around that point, starting where you are. Change turns, radius and rise on the right.');
}

// ---------- mouse & keyboard ----------

const pos = e => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
let lastHit = null, lastHitAt = 0;
function cursorDepth(mx, my) {  // distance to whatever is under the cursor (throttled raycast)
  const now = performance.now();
  if (now - lastHitAt > 120) { lastHit = hitSplat(mx, my); lastHitAt = now; }
  return lastHit ? camera.position.distanceTo(lastHit) : null;
}

overlay.addEventListener('contextmenu', e => e.preventDefault());
overlay.addEventListener('pointerdown', e => {
  overlay.setPointerCapture(e.pointerId);
  const m = pos(e);
  mouse.x = m.x; mouse.y = m.y;
  el.focus({ preventScroll: true });
  if (grab) { endGrab(e.button === 0); return; }
  if (S.view === 'camera') {
    if (S.aimKey) { drag = { kind: 'aim', x: m.x, y: m.y, roll: e.altKey }; return; }
    if (e.button === 0 || e.button === 2) { emit('leaveCamera'); }  // touching the view means you want to fly again
    else return;
  }
  if (e.button === 2) { drag = { kind: 'look', x: m.x, y: m.y }; return; }
  if (e.button === 1 || (e.button === 0 && e.shiftKey && S.tool === 'select')) { drag = { kind: 'pan', x: m.x, y: m.y }; return; }
  if (e.button !== 0) return;

  const tool = S.tool;
  if (tool === 'line' || tool === 'curve') {
    if (!drawing) { const ep = endpointNear(m.x, m.y); if (ep) { continueFrom(ep); return; } }
    const p = placeAt(m.x, m.y);
    drag = { kind: 'pen', x: m.x, y: m.y, p, placed: false };
    return;
  }
  if (tool === 'arc') {
    const p = placeAt(m.x, m.y);
    if (!drawState?.a) drawState = { kind: 'arc', a: p, b: p, up: e.shiftKey };
    else {
      const path = M.newPath(S.film, M.arcNodes(drawState.a.toArray(), p.toArray(), e.shiftKey));
      if (e.altKey) M.reversePath(path);
      S.film.paths.push(path);
      M.defaultKeys(S.film, path);
      emit('pathCreated', path);
      drawState = null;
      select('path', path.id, { pathId: path.id });
      commit();
    }
    return;
  }
  if (tool === 'spiral') {
    const hit = hitSplat(m.x, m.y) || placeAt(m.x, m.y, 0);
    spiralFrom(hit);
    emit('tool', 'select');
    return;
  }
  if (tool === 'target') {
    const p = hitSplat(m.x, m.y) || placeAt(m.x, m.y, 0);
    const tg = { id: M.uid('t'), name: `Target ${S.film.targets.length + 1}`, p: p.toArray() };
    S.film.targets.push(tg);
    const key = S.sel.kind === 'key' && findKey(S.sel.id);
    if (key) { key.look = 'target'; key.target = tg.id; key.yaw = 0; key.pitch = 0; toast(`Key now keeps looking at ${tg.name}`); }
    else select('target', tg.id);
    commit();
    emit('tool', 'select');
    return;
  }
  if (tool === 'key') {
    const c = curveAt(m.x, m.y, 12, S.sel.pathId) || curveAt(m.x, m.y, 12);
    if (!c) { toast('Click on a path to add a camera key there'); return; }
    addKeyAt(findPath(c.pathId), c.s);
    return;
  }

  // select tool
  const h = pick(m.x, m.y);
  if (h?.kind === 'axis' || h?.kind === 'gizmo') {
    drag = { kind: 'move', sel: { ...S.sel }, start: selectionPoint(), x: m.x, y: m.y, axis: h.axis || null, moved: false };
    return;
  }
  if (h?.kind === 'node' || h?.kind === 'handle') {
    select(h.kind, null, { pathId: h.pathId, index: h.index, side: h.side });
    drag = { kind: 'move', sel: { ...S.sel }, start: selectionPoint(), x: m.x, y: m.y, axis: null, moved: false };
    return;
  }
  if (h?.kind === 'target') {
    select('target', h.id);
    drag = { kind: 'move', sel: { ...S.sel }, start: selectionPoint(), x: m.x, y: m.y, axis: null, moved: false };
    return;
  }
  if (h?.kind === 'key') {
    select('key', h.id, { pathId: h.pathId });
    emit('seekKey', h.pathId, h.id);
    drag = { kind: 'slideKey', pathId: h.pathId, id: h.id, x: m.x, y: m.y, moved: false };
    return;
  }
  if (h?.kind === 'curve') {
    if (e.detail >= 2) {  // double-click on a path: insert a point there
      const path = findPath(h.pathId), { seg, t } = M.segAt(path, h.s);
      const idx = M.splitSegment(path, seg, M.clamp(t, 0.02, 0.98));
      select('node', null, { pathId: path.id, index: idx });
      commit();
      return;
    }
    select('path', h.pathId, { pathId: h.pathId });
    drag = { kind: 'orbit', x: m.x, y: m.y, moved: false, clickClear: false };
    beginOrbit(m.x, m.y);
    return;
  }
  // empty space: orbit (a click without dragging clears the selection; double-click focuses)
  if (e.detail >= 2) { focusAt(m.x, m.y); return; }
  drag = { kind: 'orbit', x: m.x, y: m.y, moved: false, clickClear: true };
  beginOrbit(m.x, m.y);
});

function findKey(id) { for (const p of S.film.paths) { const k = p.keys.find(x => x.id === id); if (k) return k; } return null; }

export function addKeyAt(path, s) {
  const film = S.film, t = M.tAtS(path, s), cur = M.cameraAt(film, path, t);
  const prev = [...path.keys].reverse().find(k => k.t <= t) || path.keys[0];
  const k = M.newKey(film, s, t, { look: prev?.look || 'path', target: prev?.target || null, ramp: prev?.ramp ?? 0.6, fov: cur.fov });
  path.keys.push(k);
  M.sortKeys(path);
  if (path.keys.length > 1 && path.keys[path.keys.length - 1] === k) { delete path.keys[path.keys.length - 2].pin; k.pin = 'end'; }
  M.aimFromQuat(film, path, k, cur.quat);
  select('key', k.id, { pathId: path.id });
  commit();
  toast(`Key ${path.keys.indexOf(k) + 1} added. Aim it on the right, or press Aim to turn it with the mouse.`);
}

function beginOrbit(mx, my) {
  const hit = hitSplat(mx, my);
  if (hit) nav.pivot.copy(hit);
  else {  // keep orbiting at a sensible distance ahead
    const d = M.clamp(camera.position.distanceTo(nav.pivot), 0.5, 6);
    nav.pivot.copy(camera.position).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), d);
  }
}
function focusAt(mx, my) {
  const hit = hitSplat(mx, my);
  if (!hit) return;
  nav.pivot.copy(hit);
  const d = camera.position.distanceTo(hit), dir = hit.clone().sub(camera.position).normalize();
  const from = camera.position.clone(), to = hit.clone().addScaledVector(dir, -Math.min(d, 1.5));
  const [y0, p0] = [nav.yaw, nav.pitch], y1 = Math.atan2(-dir.x, -dir.z) / DEG, p1 = Math.asin(dir.y) / DEG;
  const t0 = performance.now();
  const step = () => {
    const f = M.smoother((performance.now() - t0) / 450);
    camera.position.lerpVectors(from, to, f);
    nav.yaw = y0 + (y1 + 360 * Math.round((y0 - y1) / 360) - y0) * f; nav.pitch = p0 + (p1 - p0) * f;
    applyNav();
    needRender = true;
    if (f < 1) requestAnimationFrame(step);
  };
  step();
}

overlay.addEventListener('pointermove', e => {
  const m = pos(e);
  mouse.x = m.x; mouse.y = m.y;
  if (grab) { updateGrab(); return; }
  if (!drag) {
    if (S.view === 'free') {
      const h = S.tool === 'select' ? pick(m.x, m.y) : null;
      if (JSON.stringify(h) !== JSON.stringify(hover)) { hover = h; }
      overlay.style.cursor = h ? (h.kind === 'curve' ? 'pointer' : 'grab') : (S.tool === 'select' ? 'default' : 'crosshair');
      if (drawing && (S.tool === 'line' || S.tool === 'curve')) {
        const path = findPath(drawing.pathId);
        drawState = { kind: 'rubber', a: M.V(path.nodes[path.nodes.length - 1].p), b: placeAt(m.x, m.y) };
      } else if (drawState?.kind === 'arc') { drawState.b = placeAt(m.x, m.y); drawState.up = e.shiftKey; }
    }
    return;
  }
  const dx = m.x - drag.x, dy = m.y - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.kind === 'orbit' && drag.moved) orbit(e.movementX, e.movementY);
  else if (drag.kind === 'look') look(e.movementX, e.movementY);
  else if (drag.kind === 'pan') pan(e.movementX, e.movementY);
  else if (drag.kind === 'aim') aimDrag(e.movementX, e.movementY, e.altKey);
  else if (drag.kind === 'move' && drag.moved) {
    const axis = drag.axis || ['x', 'y', 'z'].find(a => held.has(a)) || null;  // hold X, Y or Z to stay on that axis
    const v = movedPoint(drag.start, drag.x, drag.y, m.x, m.y, axis);
    drag.liveAxis = axis;
    setPoint(drag.sel, v, e.altKey);
    snapRing = null;
    if (drag.sel.kind === 'node') {
      const p = findPath(drag.sel.pathId);
      if (drag.sel.index === 0 || drag.sel.index === p.nodes.length - 1) {
        const q = project(v), near = q && endpointNear(q.x, q.y, p.id, 10);
        if (near) snapRing = M.V(near.path.nodes[near.index].p);
      }
    }
    live();
  } else if (drag.kind === 'slideKey' && drag.moved) {
    const c = curveAt(m.x, m.y, 60, drag.pathId);
    if (c) {
      const path = findPath(drag.pathId), k = path.keys.find(x => x.id === drag.id);
      k.s = c.s;  // slide the key along the path; its time stays, so the speed around it changes
      if (path.keys[path.keys.length - 1] === k) k.pin = Math.abs(c.s - M.pathLength(path)) < 1e-3 ? 'end' : undefined;
      live();
    }
  } else if (drag.kind === 'pen') {
    if (drag.moved && S.tool === 'curve') {
      if (!drag.placed) { addDrawNode(drag.p, 'auto'); drag.placed = true; }
      const out = movedPoint(drag.p, drag.x, drag.y, m.x, m.y, null).sub(drag.p);
      const path = findPath(drawing.pathId), n = path.nodes[path.nodes.length - 1];
      n.mode = 'free'; n.hout = out.toArray(); n.hin = out.clone().negate().toArray();
      live();
    }
  }
  needRender = true;
});

overlay.addEventListener('pointerup', e => {
  const m = pos(e);
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.kind === 'orbit' && !d.moved && d.clickClear) { select(null, null); }
  if (d.kind === 'move' && d.moved) { afterMove(d.sel); commit(); }
  if (d.kind === 'slideKey' && d.moved) { M.sortKeys(findPath(d.pathId)); commit(); }
  if (d.kind === 'aim') commit();
  if (d.kind === 'pen') {
    if (!d.placed) addDrawNode(d.p, S.tool === 'line' ? 'corner' : 'auto');
    if (e.detail >= 2) finishDrawing();
  }
  void m;
});

overlay.addEventListener('wheel', e => {
  e.preventDefault();
  if (S.view === 'camera') {
    if (S.aimKey) { aimZoom(e.deltaY); return; }
    emit('leaveCamera');
  }
  const m = pos(e);
  if (drag?.kind === 'look') {  // while flying: wheel sets the fly speed
    nav.flySpeed = M.clamp(nav.flySpeed * Math.pow(1.0015, -e.deltaY), 0.05, 20);
    toast(`Fly speed ${nav.flySpeed.toFixed(2)}×`);
    return;
  }
  // pinch arrives as ctrl+wheel; a two-finger trackpad scroll with mostly sideways motion pans
  if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && e.deltaMode === 0) { pan(-e.deltaX, 0); return; }
  const k = e.ctrlKey ? 0.012 : 0.0016;
  const depth = cursorDepth(m.x, m.y) ?? camera.position.distanceTo(nav.pivot);
  // step = share of the distance to what's under the cursor, but never less than a floor: no slowdown in the middle
  const step = -e.deltaY * k * Math.max(depth, 0.6) * (e.shiftKey ? 0.25 : 1);
  const dir = rayAt(m.x, m.y).direction;
  camera.position.addScaledVector(dir, step);
  // keep the orbit point in front of us after flying past it
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  if (nav.pivot.clone().sub(camera.position).dot(fwd) < 0.3) nav.pivot.copy(camera.position).addScaledVector(fwd, 1.2);
  needRender = true;
}, { passive: false });

function orbit(dx, dy) {
  const dyaw = -dx * 0.3, dp = M.clamp(nav.pitch - dy * 0.3, -89, 89) - nav.pitch;
  const off = camera.position.clone().sub(nav.pivot);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  off.applyAxisAngle(right, dp * DEG).applyAxisAngle(new THREE.Vector3(0, 1, 0), dyaw * DEG);
  camera.position.copy(nav.pivot).add(off);
  nav.yaw += dyaw; nav.pitch += dp;
  applyNav();
  needRender = true;
}
function look(dx, dy) {
  nav.yaw -= dx * 0.18;
  nav.pitch = M.clamp(nav.pitch - dy * 0.18, -89, 89);
  applyNav();
  needRender = true;
}
function pan(dx, dy) {
  const d = Math.max(0.4, new THREE.Vector3().subVectors(nav.pivot, camera.position).dot(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)));
  const k = 2 * d * Math.tan(camera.fov * DEG / 2) / frameRect.h;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const move = right.multiplyScalar(-dx * k).addScaledVector(up, dy * k);
  camera.position.add(move); nav.pivot.add(move);
  needRender = true;
}

// aiming a key with the mouse while looking through it
function aimDrag(dx, dy, roll) {
  const k = findKey(S.aimKey);
  if (!k) return;
  const f = camera.fov / 55;
  if (roll) k.roll += dx * 0.2;
  else { k.yaw -= dx * 0.15 * f; k.pitch = M.clamp(k.pitch - dy * 0.15 * f, -89, 89); }
  live();
}
function aimZoom(dy) {
  const k = findKey(S.aimKey);
  if (!k) return;
  k.fov = M.clamp(k.fov * Math.pow(1.001, dy), 8, 120);
  live();
  clearTimeout(aimZoom.t); aimZoom.t = setTimeout(commit, 400);
}

// fly with W A S D (forward/left/back/right) Q E (down/up) while the right mouse button is held
const flyKeys = { w: [0, 0, -1], s: [0, 0, 1], a: [-1, 0, 0], d: [1, 0, 0], q: [0, -1, 0], e: [0, 1, 0] };
const flying = () => drag?.kind === 'look' && [...held].some(k => flyKeys[k]);
export function tick(dt) {
  if (!flying()) return;
  const v = new THREE.Vector3();
  held.forEach(k => { if (flyKeys[k]) v.add(new THREE.Vector3(...flyKeys[k])); });
  if (v.lengthSq() === 0) return;
  const fast = held.has('shift') ? 3 : 1;
  const local = new THREE.Vector3(v.x, 0, v.z).applyQuaternion(camera.quaternion);
  local.y += v.y;
  camera.position.addScaledVector(local.normalize(), dt * 1.2 * nav.flySpeed * fast);
  needRender = true;
}

// keys: returns true when the viewport used the key
export function keyDown(e) {
  const k = e.key.toLowerCase();
  held.add(k === 'shift' || k === 'alt' ? k : k);
  if (drag?.kind === 'look' && flyKeys[k]) return true;
  if (grab) {
    if (['x', 'y', 'z'].includes(k)) { grab.axis = grab.axis === k ? null : k; updateGrab(); return true; }
    if (k === 'escape') { endGrab(false); return true; }
    if (k === 'enter') { endGrab(true); return true; }
    return true;
  }
  if (drag?.kind === 'move' && ['x', 'y', 'z'].includes(k)) return true;
  if (S.aimKey && (k === 'escape' || k === 'enter')) { emit('aimDone'); return true; }
  if (drawing && (k === 'enter' || k === 'escape')) { finishDrawing(); return true; }
  if (drawState && k === 'escape') { drawState = null; return true; }
  return false;
}
export function keyUp(e) { held.delete(e.key.toLowerCase()); }
addEventListener('blur', () => held.clear());

// frame the selection or the whole scene (F)
export function frameSelection() {
  let p = selectionPoint();
  const path = findPath(S.sel.pathId);
  let radius = 1.5;
  if (!p && path) { const tb = M.table(path); const box = new THREE.Box3().setFromPoints(tb.pts); p = box.getCenter(new THREE.Vector3()); radius = box.getSize(new THREE.Vector3()).length() * 0.7 + 0.5; }
  if (!p) p = new THREE.Vector3(0, 0.5, 0), radius = 4;
  nav.pivot.copy(p);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  camera.position.copy(p).addScaledVector(fwd, -radius);
  needRender = true;
}
export function setFreeFrom(pose) {  // leave the camera view at the camera's pose
  camera.position.copy(pose.pos);
  const e = new THREE.Euler().setFromQuaternion(pose.quat, 'YXZ');
  nav.yaw = e.y / DEG; nav.pitch = e.x / DEG;
  nav.pivot.copy(pose.pos).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quat), 1.5);
  applyNav();
  needRender = true;
}
export function startView(sp) {  // look from a splat's own first camera position
  if (!sp?.base?.start) return;
  const a = M.splatToWorld(sp, sp.base.start.pos), b = M.splatToWorld(sp, sp.base.start.look);
  camera.position.copy(a);
  const d = b.clone().sub(a).normalize();
  nav.yaw = Math.atan2(-d.x, -d.z) / DEG; nav.pitch = Math.asin(d.y) / DEG;
  nav.pivot.copy(b);
  applyNav();
  needRender = true;
}
export const navState = () => ({ pos: camera.position.toArray(), yaw: nav.yaw, pitch: nav.pitch, pivot: nav.pivot.toArray() });
export function setNavState(n) {
  if (!n) return;
  camera.position.fromArray(n.pos); nav.yaw = n.yaw; nav.pitch = n.pitch; nav.pivot.fromArray(n.pivot);
  applyNav();
  needRender = true;
}

// ---------- export rendering at full size ----------

let exporting = false;
export function beginExport(W, H) {
  exporting = true;
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  canvas3d.style.width = '100%'; canvas3d.style.height = 'auto';
  if (viewer) { viewer.devicePixelRatio = 1; viewer.splatMesh && (viewer.splatMesh.devicePixelRatio = 1); }
  // the viewer reads the canvas's on-screen size for its own math; give it the real output size
  canvas3d.style.width = W + 'px'; canvas3d.style.height = H + 'px';
  canvas3d.style.transformOrigin = '0 0';
  const s = Math.min(el.clientWidth / W, el.clientHeight / H);
  canvas3d.style.transform = `scale(${s})`;
  canvas3d.style.left = '0px'; canvas3d.style.top = '0px';
  camera.aspect = W / H; camera.updateProjectionMatrix();
}
export function endExport() {
  exporting = false;
  canvas3d.style.transform = '';
  setQuality(opts.quality);
  layout();
}

on('change', () => { needRender = true; });
on('live', () => { needRender = true; });
on('film', () => { drawing = null; drawState = null; grab = null; drag = null; });
