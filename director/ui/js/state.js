// Shared app state, events, undo history and saving.
import { newFilm } from './model.js';

export const S = {
  film: newFilm('Untitled'),
  sel: { kind: null, id: null },  // kind: node|handle|key|path|target|splat|clip|transition ; plus pathId, index, side
  tool: 'select',                 // select|line|curve|arc|spiral|key|target
  playhead: 0,
  playing: false,
  view: 'free',                   // free | camera (look through the timeline camera)
  aimKey: null,                   // key id being aimed by mouse in camera view
  splatsInfo: [],                 // available splats from the server
  dirty: false,
  exporting: false,
};

const handlers = {};
export const on = (ev, fn) => (handlers[ev] ||= []).push(fn);
export const emit = (ev, ...a) => (handlers[ev] || []).forEach(f => f(...a));

// hooks.normalize runs before every change is shown (keeps derived values like clip lengths in step)
export const hooks = { normalize: null };

// ---- undo: a list of film snapshots, one per finished change ----
let history = [], at = -1;
export function resetHistory() { history = [JSON.stringify(S.film)]; at = 0; }
export function commit() {
  hooks.normalize?.();
  const snap = JSON.stringify(S.film);
  if (snap === history[at]) { emit('change'); return; }
  history = history.slice(0, at + 1);
  history.push(snap);
  if (history.length > 200) history.shift();
  at = history.length - 1;
  S.dirty = true;
  emit('change');
  scheduleSave();
}
function restore(i) {
  at = i;
  S.film = JSON.parse(history[at]);
  S.dirty = true;
  emit('film');
  emit('change');
  scheduleSave();
}
export const undo = () => at > 0 && restore(at - 1);
export const redo = () => at < history.length - 1 && restore(at + 1);
// live updates while dragging (no history entry yet)
export const live = () => { hooks.normalize?.(); emit('live'); };

// ---- saving: films are JSON files in app_data/director/films ----
let saveTimer = null;
export function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200); }
export async function save() {
  clearTimeout(saveTimer);
  const name = S.film.name || 'Untitled';
  const r = await fetch('/api/film?name=' + encodeURIComponent(name), { method: 'POST', body: JSON.stringify(S.film) });
  if (r.ok) { S.dirty = false; emit('saved', name); try { localStorage.setItem('director:last', name); } catch {} }
  else emit('toast', 'Could not save: ' + ((await r.json().catch(() => ({}))).error || r.status));
}

export function select(kind, id, extra = {}) {
  S.sel = { kind, id, ...extra };
  emit('select');
}
export const findPath = id => S.film.paths.find(p => p.id === id);
export const selPath = () => findPath(S.sel.pathId || (S.sel.kind === 'path' ? S.sel.id : null));
export const toast = msg => emit('toast', msg);
