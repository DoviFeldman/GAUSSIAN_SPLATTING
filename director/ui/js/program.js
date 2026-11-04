// The program output: what the timeline shows at a moment (splat shots, video clips, transitions), live
// playback with music, and the frame-exact export to mp4.
import { S, on, emit, findPath, toast } from './state.js';
import * as M from './model.js';
import * as VP from './viewport.js';

const vp = document.getElementById('vp');
const prog = document.createElement('canvas');
prog.className = 'vp-program';
vp.append(prog);
const pctx = prog.getContext('2d');
const bufA = document.createElement('canvas'), bufB = document.createElement('canvas');

const videos = new Map();  // media name -> <video>
const audios = new Map();  // clip id -> <audio>
let dirty = true, settle = false;
export const markDirty = () => { dirty = true; };

const mediaUrl = name => S.film.media.find(m => m.name === name)?.url;
function videoEl(name) {
  let v = videos.get(name);
  if (!v) {
    v = document.createElement('video');
    v.src = mediaUrl(name); v.preload = 'auto'; v.playsInline = true; v.muted = true;
    v.addEventListener('seeked', markDirty);
    v.addEventListener('loadeddata', markDirty);
    videos.set(name, v);
  }
  return v;
}

// Camera pose of a shot clip at its local time.
export function shotPose(clip, local) {
  const path = findPath(clip.ref);
  if (!path) return null;
  return M.cameraAt(S.film, path, M.clamp(local, 0, M.shotDuration(path)));
}
export function playheadPose() {
  const p = M.programAt(S.film, S.playhead);
  const src = p && ((p.b && p.p >= 0.5) || !p.a ? p.b : p.a);
  return src && src.clip.type === 'shot' ? shotPose(src.clip, src.local) : null;
}
VP.answer('playheadPose', playheadPose);
// Which shot clip and path time the playhead is on, for the speed graph.
export function playheadShot() {
  const p = M.programAt(S.film, S.playhead);
  const src = p && ((p.b && p.p >= 0.5) || !p.a ? p.b : p.a);
  return src && src.clip.type === 'shot' ? { clip: src.clip, t: src.local, start: src.start } : null;
}

// Draw one source (a shot or a video clip) at its local time, scaled to fit W x H.
async function drawSource(src, ctx, W, H, exact) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!src) return;
  const { clip, local } = src;
  if (clip.type === 'shot') {
    const pose = shotPose(clip, local);
    if (!pose) return;
    VP.setPose(pose.pos, pose.quat, pose.fov);
    VP.applySplatProps(clip.splats && clip.splats.length ? clip.splats : null);
    await VP.renderSplats(exact);
    ctx.drawImage(VP.canvas(), 0, 0, W, H);
  } else if (clip.type === 'video') {
    const v = videoEl(clip.ref), t = M.clamp(local, 0, (v.duration || 1e9) - 0.001);
    if (exact) await seekExact(v, t);
    else if (!S.playing && Math.abs(v.currentTime - t) > 0.5 / S.film.fps && !v.seeking) v.currentTime = t;
    if (v.readyState >= 2 && v.videoWidth) {
      const s = Math.min(W / v.videoWidth, H / v.videoHeight), w = v.videoWidth * s, h = v.videoHeight * s;
      ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
    }
  }
}
function seekExact(v, t) {
  return new Promise(res => {
    const go = () => {
      if (Math.abs(v.currentTime - t) < 1e-3 && !v.seeking) return res();
      const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
      const to = setTimeout(done, 4000);
      v.addEventListener('seeked', done);
      v.currentTime = t;
    };
    if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
  });
}
const sized = (c, W, H) => { if (c.width !== W || c.height !== H) { c.width = W; c.height = H; } return c.getContext('2d'); };

// Composite the program at a given moment into ctx.
export async function composite(p, ctx, W, H, exact) {
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!p) { ctx.restore(); return; }
  if (!p.tr) { await drawSource(p.a, ctx, W, H, exact); ctx.restore(); return; }
  const tr = p.tr, x = p.p, color = tr.color || '#000000';
  const a = sized(bufA, W, H), b = sized(bufB, W, H);
  if (p.a) await drawSource(p.a, a, W, H, exact); else { a.fillStyle = tr.type === 'dip' ? color : '#000'; a.fillRect(0, 0, W, H); }
  if (p.b) await drawSource(p.b, b, W, H, exact); else { b.fillStyle = tr.type === 'dip' ? color : '#000'; b.fillRect(0, 0, W, H); }
  const blurMax = W * 0.02;
  if (tr.type === 'dissolve') {
    ctx.drawImage(bufA, 0, 0);
    ctx.globalAlpha = M.smoother(x); ctx.drawImage(bufB, 0, 0);
  } else if (tr.type === 'blur') {   // blur out of A while it dissolves into B, which comes into focus
    const e = M.smoother(x);
    ctx.filter = `blur(${(blurMax * Math.sin(Math.PI * x) * 0.6 + blurMax * e * (1 - e)).toFixed(1)}px)`;
    ctx.drawImage(bufA, 0, 0);
    ctx.globalAlpha = e; ctx.drawImage(bufB, 0, 0);
  } else if (tr.type === 'dip') {    // through a colour (black, white, ...)
    ctx.drawImage(x < 0.5 ? bufA : bufB, 0, 0);
    ctx.globalAlpha = 1 - Math.abs(x - 0.5) * 2;
    ctx.fillStyle = color; ctx.fillRect(0, 0, W, H);
  } else if (tr.type === 'flash') {  // quick cross with a bright flash at the cut
    ctx.drawImage(x < 0.5 ? bufA : bufB, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.pow(1 - Math.abs(x - 0.5) * 2, 1.5);
    ctx.drawImage(x < 0.5 ? bufB : bufA, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color === '#000000' ? '#ffffff' : color; ctx.globalAlpha *= 0.6; ctx.fillRect(0, 0, W, H);
  } else ctx.drawImage(x < 0.5 ? bufA : bufB, 0, 0);
  ctx.restore();
}

// ---------- live preview ----------

export function showProgram(on) { prog.style.display = on ? 'block' : 'none'; markDirty(); }
on('layout', r => {
  prog.style.left = r.x + 'px'; prog.style.top = r.y + 'px';
  prog.style.width = r.w + 'px'; prog.style.height = r.h + 'px';
  prog.width = Math.round(r.w * VP.opts.quality); prog.height = Math.round(r.h * VP.opts.quality);
  markDirty();
});
on('change', markDirty);
on('live', markDirty);
on('seek', markDirty);

let busy = false;
export function drawPreview() {
  if (busy) return;
  // after the last change, draw once more when that frame's depth sort has landed
  if (!S.playing && !dirty) {
    if (settle && !VP.sorting()) { settle = false; dirty = true; } else return;
    if (!dirty) return;
  } else settle = true;
  dirty = false;
  busy = true;
  composite(M.programAt(S.film, S.playhead), pctx, prog.width, prog.height, false).finally(() => {
    busy = false;
    if (!VP.ready() && S.film.splats.length) dirty = true;  // splats still getting ready: try again
  });
}

// playback clock
let clock = null;
export function play() {
  if (S.playing) return pause();
  const dur = M.filmDuration(S.film);
  if (!dur) { toast('Add a shot or a video to the timeline first'); return; }
  if (S.playhead >= dur - 1e-3) S.playhead = 0;
  S.playing = true;
  clock = { t0: performance.now(), p0: S.playhead };
  emit('playing', true);
}
export function pause() {
  S.playing = false;
  clock = null;
  for (const v of videos.values()) v.pause();
  for (const a of audios.values()) a.pause();
  emit('playing', false);
  markDirty();
}
export function tickPlayback() {
  if (!S.playing || !clock) return;
  const dur = M.filmDuration(S.film);
  S.playhead = clock.p0 + (performance.now() - clock.t0) / 1000;
  if (S.playhead >= dur) { S.playhead = dur; pause(); }
  syncMedia();
  emit('time');
}
// keep video and music elements in step with the playhead
function syncMedia() {
  const film = S.film, T = S.playhead, p = M.programAt(film, T);
  const activeVideos = new Map();
  for (const [src, w] of [[p?.a, p?.b ? 1 - p.p : 1], [p?.b, p?.p ?? 1]]) {
    if (src?.clip.type === 'video') activeVideos.set(src.clip.ref, { local: src.local, vol: src.clip.volume * w });
  }
  for (const [name, v] of videos) {
    const a = activeVideos.get(name);
    if (a && S.playing) {
      v.muted = false; v.volume = M.clamp(a.vol, 0, 1);
      if (Math.abs(v.currentTime - a.local) > 0.25) v.currentTime = a.local;
      if (v.paused) v.play().catch(() => {});
    } else if (!v.paused) v.pause();
  }
  for (const clip of film.clips.filter(c => c.type === 'audio')) {
    let a = audios.get(clip.id);
    if (!a) { a = new Audio(mediaUrl(clip.ref)); a.preload = 'auto'; audios.set(clip.id, a); }
    const local = clip.in + (T - clip.start);
    if (S.playing && T >= clip.start && T < clip.start + clip.dur) {
      a.volume = M.clamp(clip.volume * fadeGain(clip, T - clip.start), 0, 1);
      if (Math.abs(a.currentTime - local) > 0.25) a.currentTime = local;
      if (a.paused) a.play().catch(() => {});
    } else if (!a.paused) a.pause();
  }
}
function fadeGain(c, x) {
  let g = 1;
  if (c.fadeIn > 0 && x < c.fadeIn) g *= x / c.fadeIn;
  if (c.fadeOut > 0 && x > c.dur - c.fadeOut) g *= Math.max(0, (c.dur - x) / c.fadeOut);
  return g;
}
on('film', () => { for (const a of audios.values()) a.pause(); audios.clear(); for (const v of videos.values()) v.pause(); videos.clear(); });

// ---------- export ----------

let cancelExport = false;
export const abortExport = () => { cancelExport = true; };
export async function exportFilm(onProgress) {
  const film = S.film, W = film.width, H = film.height, fps = film.fps;
  const dur = M.filmDuration(film), N = Math.max(1, Math.round(dur * fps));
  if (!dur) throw new Error('The timeline is empty');
  if (film.clips.some(c => c.type === 'shot') && !VP.ready()) throw new Error('The splats are still loading');
  cancelExport = false;
  pause();
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  const r = await (await fetch(`/api/render/start?name=${encodeURIComponent(film.name)}&fps=${fps}&w=${W}&h=${H}`, { method: 'POST' })).json();
  if (r.error) throw new Error(r.error);
  const job = r.job;
  VP.beginExport(W, H);
  try {
    // the very first splat render after a resize can come out black: warm up on the first frame
    for (let k = 0; k < 3; k++) { await composite(M.programAt(film, 0), ctx, W, H, true); for (let j = 0; j < 30; j++) await VP.yieldTask(); }
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      if (cancelExport) throw new Error('cancelled');
      await composite(M.programAt(film, i / fps), ctx, W, H, true);
      const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.93));
      const fr = await fetch(`/api/render/frame?job=${job}`, { method: 'POST', body: blob });
      if (!fr.ok) throw new Error('The encoder stopped: ' + ((await fr.json().catch(() => ({}))).error || fr.status));
      const el = (performance.now() - t0) / 1000;
      onProgress({ frame: i + 1, frames: N, eta: el / (i + 1) * (N - i - 1), preview: i % 10 === 0 ? out : null });
    }
    onProgress({ frame: N, frames: N, eta: 0, stage: 'Mixing sound…' });
    const wav = await mixAudio(dur);
    onProgress({ frame: N, frames: N, eta: 0, stage: 'Writing the mp4…' });
    const res = await (await fetch(`/api/render/finish?job=${job}`, { method: 'POST', body: wav || new Blob([]) })).json();
    if (res.error) throw new Error(res.error);
    return res;
  } catch (e) {
    fetch(`/api/render/cancel?job=${job}`, { method: 'POST' });
    throw e;
  } finally {
    VP.endExport();
    markDirty();
  }
}

// All sound (music tracks + the videos' own sound) mixed offline into one WAV.
const decoded = new Map();
export async function mixAudio(dur) {
  const film = S.film, sr = 48000;
  const items = film.clips.filter(c => c.type === 'audio').map(c => ({ c, start: c.start }));
  for (const r of M.layoutV1(film)) if (r.clip.type === 'video' && r.clip.volume > 0) items.push({ c: r.clip, start: r.start });
  if (!items.length) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  let any = false;
  for (const { c, start } of items) {
    let buf = decoded.get(c.ref);
    if (buf === undefined) {
      try { buf = await ctx.decodeAudioData(await (await fetch(mediaUrl(c.ref))).arrayBuffer()); }
      catch { buf = null; }  // a video without sound
      decoded.set(c.ref, buf);
    }
    if (!buf) continue;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf;
    src.connect(g).connect(ctx.destination);
    const end = start + c.dur, vol = c.volume ?? 1;
    g.gain.setValueAtTime(c.fadeIn > 0 ? 0 : vol, start);
    if (c.fadeIn > 0) g.gain.linearRampToValueAtTime(vol, start + c.fadeIn);
    if (c.fadeOut > 0) { g.gain.setValueAtTime(vol, Math.max(start, end - c.fadeOut)); g.gain.linearRampToValueAtTime(0, end); }
    src.start(start, c.in, c.dur);
    any = true;
  }
  if (!any) return null;
  const out = await ctx.startRendering();
  return wav(out);
}
function wav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true); data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { data.setInt16(o, M.clamp(chans[c][i], -1, 1) * 32767, true); o += 2; }
  return new Blob([data], { type: 'audio/wav' });
}
