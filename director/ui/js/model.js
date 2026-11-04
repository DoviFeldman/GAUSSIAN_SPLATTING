// Film data model and the math behind it. No DOM here.
//
// A film (saved as JSON) holds:
//   splats   [{id, name, url, visible, opacity, pos, rot (deg, YXZ), scale, base: {up, center}}]
//            base = auto-alignment from the splat's camera_path.json: its "up" becomes +Y and its centre the origin
//   paths    [{id, name, color, nodes: [{p, hin, hout, mode}], keys: [...], easeIn, easeOut, gen?}]
//            a path is a chain of cubic Bezier segments. mode: auto (smooth), corner (straight), free (own handles)
//            keys = camera keys: {id, s (distance along the path), t (seconds into the shot), look: path|target|world,
//                                 yaw, pitch, roll (deg), fov, target, ramp (seconds of speed blending around the key)}
//   targets  [{id, name, p}]   points a camera key can keep looking at
//   clips    [{id, track: V1|A1|A2, type: shot|video|audio, ref, in, dur, start (audio only), splats, volume, tin, tout}]
//            V1 is magnetic: clips play back to back in array order. tin = transition from the previous clip.
//   media    [{name, url, kind, duration}]
import * as THREE from 'three';

export const uid = p => p + Math.random().toString(36).slice(2, 8);
export const V = a => new THREE.Vector3().fromArray(a);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const smoother = x => (x = clamp(x, 0, 1), x * x * x * (x * (x * 6 - 15) + 10));
const DEG = Math.PI / 180;

export const PATH_COLORS = ['#e8813a', '#4fb3d9', '#9b7be8', '#5cc98a', '#e8c13a', '#e85a8a'];

export function newFilm(name) {
  return { version: 1, name, fps: 30, width: 1920, height: 1080, baseSpeed: 0.4,
           splats: [], paths: [], targets: [], clips: [], media: [] };
}

// ---------- splats ----------

// Quaternion turning the splat's own "up" into +Y.
export function baseQuat(up) {
  if (!up) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(V(up).normalize(), new THREE.Vector3(0, 1, 0));
}

// Scene transform for the viewer: world = T(pos) R(rot) S(scale) R(base) T(-centre)
export function splatTransform(sp) {
  const q0 = baseQuat(sp.base?.up);
  const qr = new THREE.Quaternion().setFromEuler(new THREE.Euler(sp.rot[0] * DEG, sp.rot[1] * DEG, sp.rot[2] * DEG, 'YXZ'));
  const q = qr.multiply(q0);
  const c = sp.base?.center ? V(sp.base.center) : new THREE.Vector3();
  const position = V(sp.pos).sub(c.applyQuaternion(q).multiplyScalar(sp.scale));
  return { position, quaternion: q, scale: new THREE.Vector3(sp.scale, sp.scale, sp.scale) };
}

// A point given in a splat's own coordinates, in world space.
export function splatToWorld(sp, a) {
  const { position, quaternion, scale } = splatTransform(sp);
  return V(a).multiply(scale).applyQuaternion(quaternion).add(position);
}

// ---------- paths ----------

export function newPath(film, nodes, name) {
  const n = film.paths.length;
  return { id: uid('p'), name: name || `Path ${n + 1}`, color: PATH_COLORS[n % PATH_COLORS.length],
           nodes, keys: [], easeIn: 0.6, easeOut: 0.6 };
}
export const node = (p, mode = 'auto', hin = [0, 0, 0], hout = [0, 0, 0]) => ({ p: [...p], hin: [...hin], hout: [...hout], mode });

// Handles as actually used (auto nodes get theirs from the neighbours).
export function handles(path) {
  const N = path.nodes;
  return N.map((n, i) => {
    if (n.mode === 'free') return { hin: V(n.hin), hout: V(n.hout) };
    if (n.mode === 'corner' || N.length < 2) return { hin: new THREE.Vector3(), hout: new THREE.Vector3() };
    const p = V(n.p), prev = i > 0 ? V(N[i - 1].p) : null, next = i < N.length - 1 ? V(N[i + 1].p) : null;
    if (prev && next) {
      const d = next.clone().sub(prev).normalize();
      return { hin: d.clone().multiplyScalar(-p.distanceTo(prev) / 3), hout: d.multiplyScalar(p.distanceTo(next) / 3) };
    }
    if (next) return { hin: new THREE.Vector3(), hout: next.sub(p).multiplyScalar(1 / 3) };
    return { hin: prev.sub(p).multiplyScalar(1 / 3), hout: new THREE.Vector3() };
  });
}

export function bez(P, t, out = new THREE.Vector3()) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return out.set(P[0].x * a + P[1].x * b + P[2].x * c + P[3].x * d,
                 P[0].y * a + P[1].y * b + P[2].y * c + P[3].y * d,
                 P[0].z * a + P[1].z * b + P[2].z * c + P[3].z * d);
}

export function segments(path, H = handles(path)) {
  const N = path.nodes, out = [];
  for (let i = 0; i < N.length - 1; i++) {
    const a = V(N[i].p), b = V(N[i + 1].p);
    out.push([a, a.clone().add(H[i].hout), b.clone().add(H[i + 1].hin), b]);
  }
  return out;
}

// Arc-length table, cached per path object and rebuilt whenever its nodes change.
const SAMPLES = 64;
const tables = new WeakMap();
export function table(path) {
  const sig = JSON.stringify(path.nodes);
  let tb = tables.get(path);
  if (tb && tb.sig === sig) return tb;
  const segs = segments(path), pts = [], seg = [], tt = [], s = [];
  let total = 0, prev = null;
  segs.forEach((P, i) => {
    for (let k = i ? 1 : 0; k <= SAMPLES; k++) {
      const p = bez(P, k / SAMPLES);
      if (prev) total += p.distanceTo(prev);
      pts.push(p); seg.push(i); tt.push(k / SAMPLES); s.push(total);
      prev = p;
    }
  });
  if (!pts.length && path.nodes.length) { pts.push(V(path.nodes[0].p)); seg.push(0); tt.push(0); s.push(0); }
  tb = { sig, segs, pts, seg, t: tt, s, length: total };
  tables.set(path, tb);
  return tb;
}
export const pathLength = path => table(path).length;

function locate(tb, s) {
  s = clamp(s, 0, tb.length);
  let lo = 0, hi = tb.s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tb.s[m] <= s) lo = m; else hi = m; }
  const span = tb.s[hi] - tb.s[lo], f = span > 0 ? (s - tb.s[lo]) / span : 0;
  if (tb.seg[lo] !== tb.seg[hi]) return { seg: tb.seg[hi], t: tb.t[hi] * f };  // hi is the first sample of the next segment
  return { seg: tb.seg[lo], t: tb.t[lo] + (tb.t[hi] - tb.t[lo]) * f };
}
export const segAt = (path, s) => locate(table(path), s);
export function pointAt(path, s) {
  const tb = table(path);
  if (!tb.segs.length) return tb.pts[0]?.clone() || new THREE.Vector3();
  const { seg, t } = locate(tb, s);
  return bez(tb.segs[seg], t);
}
export function tangentAt(path, s) {
  const L = pathLength(path), d = Math.max(0.02, Math.min(0.15, L / 50));
  const a = pointAt(path, clamp(s - d, 0, L)), b = pointAt(path, clamp(s + d, 0, L));
  const v = b.sub(a);
  return v.lengthSq() > 1e-12 ? v.normalize() : new THREE.Vector3(0, 0, -1);
}

// Reverse direction (nodes, handles and the camera move).
export function reversePath(path) {
  const L = pathLength(path), T = shotDuration(path);
  path.nodes.reverse().forEach(n => { [n.hin, n.hout] = [n.hout, n.hin]; });
  path.keys.forEach(k => { k.s = L - k.s; k.t = T - k.t; });
  path.keys.reverse();
}

// Turn a node's auto/corner handles into stored ones, so moving its neighbours no longer changes it.
export function freezeNode(path, i) {
  const h = handles(path)[i], n = path.nodes[i];
  n.hin = h.hin.toArray(); n.hout = h.hout.toArray(); n.mode = 'free';
}

// Split segment i at parameter t (de Casteljau). Returns the index of the new node.
export function splitSegment(path, i, t) {
  const P = segments(path)[i];
  if (path.nodes[i].mode === 'corner' && path.nodes[i + 1].mode === 'corner') {
    path.nodes.splice(i + 1, 0, node(bez(P, t).toArray(), 'corner'));
    return i + 1;
  }
  freezeNode(path, i); freezeNode(path, i + 1);
  const l = (a, b) => a.clone().lerp(b, t);
  const a = l(P[0], P[1]), b = l(P[1], P[2]), c = l(P[2], P[3]), d = l(a, b), e = l(b, c), m = l(d, e);
  path.nodes[i].hout = a.sub(P[0]).toArray();
  path.nodes[i + 1].hin = c.sub(P[3]).toArray();
  path.nodes.splice(i + 1, 0, node(m.toArray(), 'free', d.sub(m).toArray(), e.sub(m).toArray()));
  return i + 1;
}

// Make a path longer by continuing the shape it already has at its end (a line stays a line, an arc keeps
// curving the same way), or shorter (negative amount). atStart works on the other end.
export function extendPath(path, amount, atStart = false) {
  if (atStart) reversePath(path);
  const L = pathLength(path);
  if (amount < 0) {
    const keep = Math.max(0.05, L + amount);
    const tb = table(path), { seg, t } = locate(tb, keep);
    if (t > 1e-4 && t < 1 - 1e-4) splitSegment(path, seg, t);
    const lastKeep = t <= 1e-4 ? seg : seg + 1;
    path.nodes.splice(lastKeep + 1);
    path.keys = path.keys.filter(k => k.s <= keep + 1e-6 || k.pin === 'end');  // the end key comes along
  } else if (amount > 0) {
    const d = Math.max(0.01, Math.min(L / 4, 0.3));
    const p2 = pointAt(path, L), p1 = pointAt(path, L - d), p0 = pointAt(path, L - 2 * d);
    const T = tangentAt(path, L);
    // circle through the last three samples, or straight when they're in line
    const a = p0.clone().sub(p2), b = p1.clone().sub(p2), n = a.clone().cross(b);
    const last = path.nodes.length - 1, mode = path.nodes[last].mode;
    if (n.length() < 1e-6 * d * d || mode === 'corner') {
      path.nodes.push(node(p2.clone().addScaledVector(T, amount).toArray(), mode === 'corner' ? 'corner' : 'auto'));
    } else {
      const ab = a.clone().cross(b), na = ab.lengthSq();
      const center = p2.clone().add(b.clone().multiplyScalar(a.lengthSq()).sub(a.clone().multiplyScalar(b.lengthSq())).cross(ab).multiplyScalar(1 / (2 * na)));
      const R = center.distanceTo(p2), axis = n.normalize();
      // turn the way the path is already turning: a small turn of the end point must move along the tangent
      const r0 = p2.clone().sub(center);
      if (r0.clone().applyAxisAngle(axis, 0.01).sub(r0).dot(T) < 0) axis.negate();
      if (R > 200 * d) {
        path.nodes.push(node(p2.clone().addScaledVector(T, amount).toArray(), 'auto'));
      } else {
        freezeNode(path, last);
        const total = amount / R, steps = Math.ceil(Math.abs(total) / (Math.PI / 2)), step = total / steps;
        const k = 4 / 3 * Math.tan(step / 4) * R;
        path.nodes[last].hout = T.clone().multiplyScalar(k).toArray();
        for (let i = 1; i <= steps; i++) {
          const q = new THREE.Quaternion().setFromAxisAngle(axis, step * i);
          const p = p2.clone().sub(center).applyQuaternion(q).add(center);
          const tan = T.clone().applyQuaternion(q);
          path.nodes.push(node(p.toArray(), 'free', tan.clone().multiplyScalar(-k).toArray(), tan.clone().multiplyScalar(k).toArray()));
        }
        path.nodes[path.nodes.length - 1].hout = [0, 0, 0];
      }
    }
  }
  if (atStart) reversePath(path);
}

// Shapes. All return node lists; afterwards they are ordinary editable paths.
export function arcNodes(a, b, bulgeUp = false) {
  const A = V(a), B = V(b), C = A.clone().add(B).multiplyScalar(0.5), r = A.distanceTo(B) / 2;
  const u = A.clone().sub(C).normalize(), up = new THREE.Vector3(0, 1, 0);
  let v = bulgeUp ? up.clone().addScaledVector(u, -u.dot(up)) : up.clone().cross(u);
  if (v.lengthSq() < 1e-8) v = new THREE.Vector3(1, 0, 0).cross(u);
  v.normalize();
  const k = 4 / 3 * Math.tan(Math.PI / 8) * r;
  return [0, 90, 180].map(deg => {
    const th = deg * DEG, p = C.clone().addScaledVector(u, r * Math.cos(th)).addScaledVector(v, r * Math.sin(th));
    const d = u.clone().multiplyScalar(-Math.sin(th)).addScaledVector(v, Math.cos(th)).normalize();
    return node(p.toArray(), 'free', d.clone().multiplyScalar(deg ? -k : 0).toArray(), d.multiplyScalar(deg < 180 ? k : 0).toArray());
  });
}

// gen = {center, r0, r1, turns, rise, a0 (deg), dir (+1 counter-clockwise seen from above, -1 clockwise)}
export function spiralNodes(g) {
  const C = V(g.center), total = g.turns * 2 * Math.PI, steps = Math.max(2, Math.ceil(g.turns * 4)), da = total / steps;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps, a = (g.a0 * DEG) + g.dir * da * i, r = g.r0 + (g.r1 - g.r0) * f;
    const p = C.clone().add(new THREE.Vector3(r * Math.cos(a), g.rise * f, r * Math.sin(a)));
    // derivative with respect to the angle travelled
    const dr = (g.r1 - g.r0) / total, dy = g.rise / total;
    const d = new THREE.Vector3(-r * Math.sin(a) * g.dir + dr * Math.cos(a), dy, r * Math.cos(a) * g.dir + dr * Math.sin(a));
    const k = 4 / 3 * Math.tan(da / 4);
    out.push(node(p.toArray(), 'free', d.clone().multiplyScalar(i ? -k : 0).toArray(), d.multiplyScalar(i < steps ? k : 0).toArray()));
  }
  return out;
}

// Join path b onto path a where their ends meet (b is removed by the caller). Keys keep their timing.
export function joinPaths(a, aEnd, b, bEnd) {
  if (aEnd === 'start') reversePath(a);
  if (bEnd === 'end') reversePath(b);
  const La = pathLength(a), Ta = shotDuration(a);
  const first = b.nodes[0], last = a.nodes[a.nodes.length - 1];
  if (last.mode === 'free' || first.mode === 'free') {
    const ha = handles(a)[a.nodes.length - 1], hb = handles(b)[0];
    last.hin = ha.hin.toArray(); last.hout = hb.hout.toArray(); last.mode = 'free';
  }
  a.nodes.push(...b.nodes.slice(1));
  let keys = b.keys.map(k => ({ ...k, s: k.s + La, t: k.t + Ta }));
  if (a.keys.length && keys.length && Math.abs(keys[0].s - La) < 1e-3 && Math.abs(a.keys[a.keys.length - 1].s - La) < 1e-3) keys = keys.slice(1);
  a.keys.push(...keys);
  if (a.keys.length) a.keys[a.keys.length - 1].pin = 'end';
}

// ---------- camera keys and speed ----------

export function newKey(film, s, t, extra = {}) {
  return { id: uid('k'), s, t, look: 'path', yaw: 0, pitch: 0, roll: 0, fov: film.fov || 55, target: null, ramp: 0.6, ...extra };
}

// Give a new path its first and last key (constant speed at the film's base speed).
export function defaultKeys(film, path) {
  const L = pathLength(path), T = Math.max(1, L / film.baseSpeed);
  path.keys = [newKey(film, 0, 0), newKey(film, L, T, { pin: 'end' })];
}

// After the path's shape changed: a key pinned to the end follows it and keeps its segment's speed.
export function fitKeysToLength(path) {
  const L = pathLength(path), K = path.keys;
  if (!K.length) return;
  const lastK = K[K.length - 1];
  if (lastK.pin === 'end' && K.length > 1 && Math.abs(lastK.s - L) > 1e-6) {
    const prev = K[K.length - 2], v = (lastK.s - prev.s) / Math.max(1e-3, lastK.t - prev.t);
    lastK.s = L;
    if (Math.abs(v) > 1e-6) lastK.t = prev.t + Math.max(0.1, (L - prev.s) / v);
  }
  K.forEach(k => { k.s = clamp(k.s, 0, L); });
}

export const sortKeys = path => path.keys.sort((a, b) => a.t - b.t);
export const shotDuration = path => path.keys.length ? path.keys[path.keys.length - 1].t : 0;

// The speed profile, DaVinci-retime style: each stretch between two keys has a constant speed, and around every key
// the speed blends smoothly (smootherstep) from one to the next over the key's ramp. Because the blend is symmetric,
// the camera still passes each key's spot on time; ease-in/out start and end from a stop.
export function speedProfile(path) {
  const K = path.keys, n = K.length;
  if (n < 2) return { n, v: [], h: [], Rs: 0, Re: 0, T: 0, K };
  const dt = [], ds = [];
  for (let i = 0; i < n - 1; i++) { dt.push(Math.max(1e-3, K[i + 1].t - K[i].t)); ds.push(K[i + 1].s - K[i].s); }
  const h = K.map((k, i) => (i === 0 || i === n - 1) ? 0 : Math.min((k.ramp || 0) / 2, dt[i - 1] / 2, dt[i] / 2));
  const Rs = Math.min(path.easeIn || 0, dt[0] - h[1]), Re = Math.min(path.easeOut || 0, dt[n - 2] - (n > 2 ? h[n - 2] : Rs));
  const v = dt.map((d, i) => ds[i] / Math.max(1e-3, d - (i === 0 ? Rs / 2 : 0) - (i === n - 2 ? Re / 2 : 0)));
  return { n, v, h, Rs: Math.max(0, Rs), Re: Math.max(0, Re), T: K[n - 1].t, K, dt, ds };
}

export function speedAt(prof, t) {
  const { K, n, v, h, Rs, Re, T } = prof;
  if (n < 2 || t <= 0 || t >= T) return 0;
  if (Rs > 0 && t < Rs) return v[0] * smoother(t / Rs);
  if (Re > 0 && t > T - Re) return v[n - 2] * smoother((T - t) / Re);
  let i = 0;
  while (i < n - 2 && t >= K[i + 1].t) i++;
  if (i + 1 < n - 1 && h[i + 1] > 0 && t > K[i + 1].t - h[i + 1]) {
    const k = i + 1;
    return v[k - 1] + (v[k] - v[k - 1]) * smoother((t - K[k].t + h[k]) / (2 * h[k]));
  }
  if (i > 0 && h[i] > 0 && t < K[i].t + h[i]) {
    return v[i - 1] + (v[i] - v[i - 1]) * smoother((t - K[i].t + h[i]) / (2 * h[i]));
  }
  return v[i];
}

// Position along the path over time, integrated from the speed profile (cached per path object).
const motions = new WeakMap();
const STEP = 1 / 240;
export function motion(path) {
  const sig = JSON.stringify([path.keys.map(k => [k.s, k.t, k.ramp]), path.easeIn, path.easeOut]);
  let m = motions.get(path);
  if (m && m.sig === sig) return m;
  const prof = speedProfile(path), N = Math.ceil(prof.T / STEP) + 1, s = new Float64Array(N + 1);
  s[0] = prof.n ? prof.K[0].s : 0;
  let k = 1;
  for (let i = 1; i <= N; i++) {
    const t0 = (i - 1) * STEP, t1 = i * STEP;
    s[i] = s[i - 1] + (speedAt(prof, t0) + 4 * speedAt(prof, (t0 + t1) / 2) + speedAt(prof, t1)) / 6 * STEP;  // Simpson
    // land exactly on each key once its ramp is over (removes the tiny numeric drift)
    while (k < prof.n && prof.K[k].t + (prof.h[k] || 0) <= t1 + 1e-9) {
      if (prof.K[k].t + (prof.h[k] || 0) > t0) s[i] = prof.K[k].s + (t1 - prof.K[k].t) * (prof.v[k] ?? 0);
      k++;
    }
  }
  m = { sig, prof, s };
  motions.set(path, m);
  return m;
}
export function sAt(path, t) {
  const m = motion(path);
  if (!m.prof.n) return 0;
  const x = clamp(t, 0, m.prof.T) / STEP, i = Math.floor(x), f = x - i;
  return i >= m.s.length - 1 ? m.s[m.s.length - 1] : m.s[i] + (m.s[i + 1] - m.s[i]) * f;
}
// When the camera passes distance s (first time), for placing new keys without changing the motion.
export function tAtS(path, s) {
  const m = motion(path), K = path.keys;
  if (!K.length) return 0;
  for (let i = 1; i < m.s.length; i++) {
    if ((m.s[i - 1] - s) * (m.s[i] - s) <= 0 && m.s[i] !== m.s[i - 1]) return (i - 1 + (s - m.s[i - 1]) / (m.s[i] - m.s[i - 1])) * STEP;
  }
  return s <= K[0].s ? 0 : K[K.length - 1].t;
}

// Change the speed of the stretch after key i; later keys slide in time (ripple), like Resolve's retime.
export function setSegmentSpeed(path, i, v) {
  const prof = speedProfile(path), K = path.keys;
  if (i < 0 || i >= K.length - 1 || Math.abs(prof.ds[i]) < 1e-6) return;
  const loss = (i === 0 ? prof.Rs / 2 : 0) + (i === K.length - 2 ? prof.Re / 2 : 0);
  const newDt = Math.max(0.05, Math.abs(prof.ds[i] / Math.max(1e-4, Math.abs(v))) + loss);
  const shift = newDt - (K[i + 1].t - K[i].t);
  for (let j = i + 1; j < K.length; j++) K[j].t += shift;
}
export function setSegmentDuration(path, i, d) {
  const K = path.keys, shift = Math.max(0.05, d) - (K[i + 1].t - K[i].t);
  for (let j = i + 1; j < K.length; j++) K[j].t += shift;
}
// Same speed everywhere, keeping the total time.
export function evenSpeed(path) {
  const K = path.keys, n = K.length;
  if (n < 3) return;
  const T = K[n - 1].t, total = K.reduce((a, k, i) => i ? a + Math.abs(k.s - K[i - 1].s) : 0, 0);
  if (total < 1e-6) return;
  let acc = 0;
  for (let i = 1; i < n - 1; i++) { acc += Math.abs(K[i].s - K[i - 1].s); K[i].t = T * acc / total; }
}

// ---------- camera pose ----------

const yawPitch = d => [Math.atan2(-d.x, -d.z) / DEG, Math.asin(clamp(d.y, -1, 1)) / DEG];
const wrapNear = (a, ref) => a + 360 * Math.round((ref - a) / 360);

// Each key's absolute aim (yaw, pitch, roll, fov) as seen from position pos.
function keyAim(film, path, k, pos, s) {
  let base = [0, 0];
  if (k.look === 'path') base = yawPitch(tangentAt(path, s));
  else if (k.look === 'target') {
    const tg = film.targets.find(x => x.id === k.target);
    if (tg) { const d = V(tg.p).sub(pos); if (d.lengthSq() > 1e-10) base = yawPitch(d.normalize()); }
  }
  return [base[0] + k.yaw, base[1] + k.pitch, k.roll, k.fov];
}

// Monotone cubic (Fritsch-Carlson) through (x, y): smooth, never overshoots between keys.
function monotone(xs, ys, x) {
  const n = xs.length;
  if (n === 1) return ys[0];
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const d = [], m = [];
  for (let j = 0; j < n - 1; j++) d.push((ys[j + 1] - ys[j]) / Math.max(1e-6, xs[j + 1] - xs[j]));
  for (let j = 0; j < n; j++) {
    if (j === 0 || j === n - 1) m.push(0);  // start and finish a turn gently
    else m.push(d[j - 1] * d[j] <= 0 ? 0 : (d[j - 1] + d[j]) / 2);
  }
  for (let j = 1; j < n - 1; j++) {  // limit slopes so the curve stays monotone per stretch
    if (d[j - 1] === 0 || d[j] === 0) { m[j] = 0; continue; }
    m[j] = Math.sign(m[j]) * Math.min(Math.abs(m[j]), 3 * Math.abs(d[j - 1]), 3 * Math.abs(d[j]));
  }
  const hx = xs[i + 1] - xs[i], t = clamp((x - xs[i]) / Math.max(1e-6, hx), 0, 1), t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hx * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hx * m[i + 1];
}

// Camera at time t (seconds into the shot): {pos, quat, fov, s, aim:[yaw, pitch, roll]}
export function cameraAt(film, path, t) {
  const K = path.keys;
  const s = sAt(path, t), pos = pointAt(path, s);
  let aim = [0, 0, 0, film.fov || 55];
  if (K.length) {
    const aims = K.map(k => keyAim(film, path, k, pos, s));
    for (let i = 1; i < aims.length; i++) aims[i][0] = wrapNear(aims[i][0], aims[i - 1][0]);  // turn the short way
    const xs = K.map(k => k.t);
    aim = [0, 1, 2, 3].map(c => monotone(xs, aims.map(a => a[c]), clamp(t, xs[0], xs[xs.length - 1])));
  }
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(aim[1] * DEG, aim[0] * DEG, aim[2] * DEG, 'YXZ'));
  return { pos, quat, fov: aim[3], s, aim };
}

// Key offsets that make the camera look the way `quat` does from the key's spot.
export function aimFromQuat(film, path, k, quat) {
  const e = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
  const abs = [e.y / DEG, e.x / DEG, e.z / DEG];
  const pos = pointAt(path, k.s), base = keyAim(film, path, { ...k, yaw: 0, pitch: 0, roll: 0 }, pos, k.s);
  k.yaw = wrapNear(abs[0] - base[0], 0);
  k.pitch = abs[1] - base[1];
  k.roll = abs[2];
}

// ---------- timeline ----------

export const clipTrackClips = (film, track) => film.clips.filter(c => c.track === track);

// V1 back to back: [{clip, start, end}]
export function layoutV1(film) {
  let t = 0;
  return clipTrackClips(film, 'V1').map(clip => {
    const r = { clip, start: t, end: t + clip.dur };
    t += clip.dur;
    return r;
  });
}
export function filmDuration(film) {
  const v = layoutV1(film), end = v.length ? v[v.length - 1].end : 0;
  const a = film.clips.filter(c => c.track !== 'V1').reduce((m, c) => Math.max(m, c.start + c.dur), 0);
  return Math.max(end, v.length ? 0 : a);
}
export const transitionSeconds = (film, tr) => tr && tr.type !== 'none' ? Math.max(1, tr.frames) / film.fps : 0;

// What V1 shows at time T: {a: {clip, local}, b?: {clip, local}, p (0..1 progress of the transition), tr}
export function programAt(film, T) {
  const L = layoutV1(film);
  if (!L.length) return null;
  const local = (r, T) => ({ clip: r.clip, local: r.clip.in + (T - r.start), start: r.start });
  for (let i = 0; i < L.length; i++) {
    const r = L[i], next = L[i + 1];
    // transition into this clip (centred on the cut), or a fade from colour at the very start
    const d = Math.min(transitionSeconds(film, r.clip.tin), r.clip.dur, i ? L[i - 1].clip.dur : r.clip.dur * 2);
    if (d > 0) {
      const a = i ? r.start - d / 2 : r.start, b = i ? r.start + d / 2 : r.start + d;
      if (T >= a && T < b) {
        const p = (T - a) / (b - a);
        return i ? { a: local(L[i - 1], T), b: local(r, T), p, tr: r.clip.tin } : { a: null, b: local(r, T), p, tr: r.clip.tin };
      }
    }
    const dOut = !next ? Math.min(transitionSeconds(film, r.clip.tout), r.clip.dur) : 0;
    if (dOut > 0 && T >= r.end - dOut && T < r.end) return { a: local(r, T), b: null, p: (T - (r.end - dOut)) / dOut, tr: r.clip.tout };
    if (T >= r.start && (T < r.end || (!next && T <= r.end + 1e-9))) return { a: local(r, T), p: 0, tr: null };
  }
  return null;
}

export function newClip(film, type, ref, dur, extra = {}) {
  return { id: uid('c'), track: type === 'audio' ? 'A1' : 'V1', type, ref, in: 0, dur, start: 0, splats: null,
           volume: 1, fadeIn: 0, fadeOut: 0, tin: null, tout: null, ...extra };
}
// How long a clip's source is (shots: the camera move; media: the file).
export function sourceDuration(film, clip) {
  if (clip.type === 'shot') { const p = film.paths.find(x => x.id === clip.ref); return p ? shotDuration(p) : 0; }
  const m = film.media.find(x => x.name === clip.ref);
  return m?.duration || clip.dur;
}
