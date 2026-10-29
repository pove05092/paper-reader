// ink.js : 書き込みの道具（マーカー・ペン・消しゴム・メモ）と元に戻す/やり直す。仕様 §3.3。
//  座標はページ全体（見開きなら見開き全体）に対する比 0〜1。表示が半分（原文/日本語）のときは reader.frac / reader.offset で変換する。
//  マーカーは別のキャンバス（CSS mix-blend-mode: multiply）に描き、文字が透けて見えるようにする。
import * as L from './logic.js';
import { simplify, roundPoints, straighten, strokeHit } from './geom.js';
import { h, icon, clamp, clear, debounce } from './ui.js';

export const PALETTE = [['#ffd400', '黄'], ['#ff6fa8', 'ピンク'], ['#46d37a', '緑'], ['#4fc3f7', '水色'], ['#ff9f1c', '橙'], ['#a46bff', '紫']];
export const WIDTHS = { marker: { thin: 0.006, mid: 0.010, thick: 0.016 }, pen: { thin: 0.0015, mid: 0.0025, thick: 0.004 } };
export const MARKER_ALPHA = 0.4;
const INK_MAX_PX = 8_000_000;

/** ピクセル座標の点列から、二次曲線でなめらかな経路を作る */
function tracePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) { ctx.lineTo(pts[0][0] + 0.01, pts[0][1]); return; }
  if (pts.length === 2) { ctx.lineTo(pts[1][0], pts[1][1]); return; }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
}

export class Ink {
  constructor(reader, prefs = {}) {
    this.reader = reader;
    this.tool = 'move'; this.lastDraw = 'marker';
    this.color = prefs.color || PALETTE[0][0];
    this.size = { marker: prefs.markerSize || 'mid', pen: prefs.penSize || 'mid' };
    this.straight = !!prefs.straight;
    this.undoStack = []; this.redoStack = [];
    this.cur = null; this.group = null; this.editor = null;
    this.listeners = new Set();
    this.liveRaf = 0;
  }
  get notes() { return this.reader.rec.notes; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  fire(what) { for (const f of this.listeners) f(what); }
  touch() { this.reader.engine.touchNotes(this.reader.rec); this.fire('notes'); }

  // ---------- 道具 ----------
  setTool(t) {
    if (this.cur) this.cancel();
    this.closeEditor();
    this.tool = t;
    if (t === 'marker' || t === 'pen') this.lastDraw = t;
    this.reader.root.dataset.tool = t;
    this.fire('tool');
  }
  setColor(c) { this.color = c; this.fire('prefs'); }
  setSize(tool, s) { this.size[tool] = s; this.fire('prefs'); }
  setStraight(v) { this.straight = !!v; this.fire('prefs'); }
  /** ペン入力は「移動」のままでも直前の描く道具で描く（仕様 §3.3） */
  effectiveTool(e) { return (e.pointerType === 'pen' && this.tool === 'move') ? this.lastDraw : this.tool; }
  get drawing() { return this.tool === 'marker' || this.tool === 'pen'; }

  // ---------- 座標 ----------
  pagePoint(e, pv) {
    const r = pv.el.getBoundingClientRect();
    const nx = (e.clientX - r.left) / (r.width || 1), ny = (e.clientY - r.top) / (r.height || 1);
    return [clamp(this.reader.offset + nx * this.reader.frac, 0, 1), clamp(ny, 0, 1)];
  }
  fullW(pv) { return pv.cssW / this.reader.frac; }

  // ---------- 線を引く ----------
  begin(e, pv, tool) {
    this.closeEditor();
    this.cur = { pv, tool, pts: [this.pagePoint(e, pv)], t0: performance.now(), moved: 0 };
    this.ensureLive(pv, tool);
    this.scheduleLive();
  }
  move(e) {
    const c = this.cur; if (!c) return;
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    const W = this.fullW(c.pv), H = c.pv.cssH;
    for (const ev of evs) {
      const p = this.pagePoint(ev, c.pv), last = c.pts[c.pts.length - 1];
      const d = Math.hypot((p[0] - last[0]) * W, (p[1] - last[1]) * H);
      if (this.straight) { c.pts = [c.pts[0], p]; c.moved = Math.max(c.moved, Math.hypot((p[0] - c.pts[0][0]) * W, (p[1] - c.pts[0][1]) * H)); }
      else if (d > 0.6) { c.pts.push(p); c.moved += d; }
    }
    this.scheduleLive();
  }
  end() {
    const c = this.cur; if (!c) return;
    this.cur = null;
    cancelAnimationFrame(this.liveRaf);
    const { pv, tool } = c;
    const dur = performance.now() - c.t0;
    if (c.moved < 3 && dur < 120) { this.removeLive(pv); return; }          // ちょん と触れただけの点は作らない
    const W = this.fullW(pv), H = pv.cssH;
    let pts = (this.straight && c.pts.length >= 2) ? straighten([c.pts[0], c.pts[c.pts.length - 1]], W, H, 5) : simplify(c.pts, W, H, 0.5);
    pts = roundPoints(pts, 4);
    const st = L.addStroke(this.notes, { page: pv.index, tool, color: this.color, alpha: tool === 'marker' ? MARKER_ALPHA : 1, width: WIDTHS[tool][this.size[tool]], points: pts });
    this.pushUndo({ kind: 'add-stroke', ids: [st.id], pages: [pv.index] });
    this.renderPage(pv);
    this.removeLive(pv);
    this.touch();
  }
  cancel() {
    const c = this.cur; if (!c) return;
    this.cur = null; cancelAnimationFrame(this.liveRaf);
    this.removeLive(c.pv);
  }
  ensureLive(pv, tool) {
    this.removeLive(pv);
    const { w, h: ph } = this.inkSize(pv);
    const c = document.createElement('canvas');
    c.className = 'c-live' + (tool === 'marker' ? ' blend' : '');
    c.width = w; c.height = ph;
    pv.el.insertBefore(c, pv.pins);
    pv.live = c;
  }
  removeLive(pv) { if (pv.live) { pv.live.width = pv.live.height = 0; pv.live.remove(); pv.live = null; } }
  scheduleLive() { if (this.liveRaf) return; this.liveRaf = requestAnimationFrame(() => { this.liveRaf = 0; this.drawLive(); }); }
  drawLive() {
    const c = this.cur; if (!c || !c.pv.live) return;
    const cv = c.pv.live, ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    this.drawStroke(ctx, { points: c.pts, color: this.color, alpha: c.tool === 'marker' ? MARKER_ALPHA : 1, width: WIDTHS[c.tool][this.size[c.tool]] }, cv.width, cv.height);
  }

  // ---------- 描画（ページ単位） ----------
  inkSize(pv) {
    let r = Math.min(window.devicePixelRatio || 1, 2);
    const area = pv.cssW * pv.cssH * r * r;
    if (area > INK_MAX_PX) r *= Math.sqrt(INK_MAX_PX / area);
    return { w: Math.max(1, Math.round(pv.cssW * r)), h: Math.max(1, Math.round(pv.cssH * r)) };
  }
  drawStroke(ctx, s, W, H) {
    const { frac, offset } = this.reader;
    if (!s.points.length) return;
    const pts = s.points.map(p => [(p[0] - offset) / frac * W, p[1] * H]);
    ctx.save();
    ctx.globalAlpha = s.alpha ?? 1; ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(1, s.width * W / frac);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    tracePath(ctx, pts); ctx.stroke();
    ctx.restore();
  }
  /** そのページの線を描き直す（ズーム・表示切替・合流・元に戻す・消しゴムの後） */
  renderPage(pv) {
    if (!pv.active) return;
    const { frac, offset } = this.reader;
    const visible = s => s.points.some(p => p[0] >= offset - 0.02 && p[0] <= offset + frac + 0.02);
    const all = this.notes.strokes.filter(s => s.page === pv.index && !s.deleted && visible(s));
    this.paintLayer(pv, 'mCanvas', 'c-ink-m', all.filter(s => s.tool === 'marker'));
    this.paintLayer(pv, 'pCanvas', 'c-ink-p', all.filter(s => s.tool !== 'marker'));
    this.renderPins(pv);
  }
  paintLayer(pv, prop, cls, list) {
    let c = pv[prop];
    if (!list.length) { if (c) { c.width = c.height = 0; c.remove(); pv[prop] = null; } return; }
    const { w, h: ph } = this.inkSize(pv);
    if (!c) { c = document.createElement('canvas'); c.className = cls; pv.el.insertBefore(c, pv.pins); pv[prop] = c; }
    if (c.width !== w || c.height !== ph) { c.width = w; c.height = ph; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    for (const s of list) this.drawStroke(ctx, s, c.width, c.height);
  }
  renderPins(pv) {
    clear(pv.pins);
    const { frac, offset } = this.reader;
    for (const n of this.notes.notes) {
      if (n.page !== pv.index || n.deleted) continue;
      const x = (n.x - offset) / frac;
      if (x < -0.005 || x > 1.005) continue;
      const b = h('button', { class: 'pin' + (n.text ? '' : ' empty'), type: 'button', dataset: { id: n.id }, 'aria-label': 'メモ' + (n.text ? '：' + n.text.slice(0, 20) : '（空）') }, icon('pin'));
      b.style.left = (x * 100) + '%'; b.style.top = (n.y * 100) + '%'; b.style.setProperty('--pin', n.color || '#ffd400');
      pv.pins.append(b);
    }
  }
  rerenderAll() { for (const pv of this.reader.pages) this.renderPage(pv); }

  // ---------- 消しゴム ----------
  eraseBegin() { this.group = { kind: 'del-stroke', ids: [], pages: [], noteIds: [] }; }
  eraseAt(e, pv) {
    if (!this.group) this.eraseBegin();
    const p = this.pagePoint(e, pv), W = this.fullW(pv), H = pv.cssH;
    const radius = e.pointerType === 'touch' ? 14 : 8, { frac, offset } = this.reader;
    const list = this.notes.strokes.filter(s => s.page === pv.index && !s.deleted && s.points.some(q => q[0] >= offset - 0.02 && q[0] <= offset + frac + 0.02)).reverse();
    for (const s of list) {
      if (strokeHit(s, p[0], p[1], W, H, radius)) {
        L.setStrokeDeleted(this.notes, s.id, true);
        this.group.ids.push(s.id); if (!this.group.pages.includes(pv.index)) this.group.pages.push(pv.index);
        this.renderPage(pv); this.touch();
        return true;                                      // 1 回の接触で 1 本ずつ消す
      }
    }
    return false;
  }
  eraseNote(id) {
    const n = L.setNoteDeleted(this.notes, id, true);
    if (!n) return;
    this.pushUndo({ kind: 'del-note', ids: [id], pages: [n.page] });
    this.closeEditor();
    const pv = this.reader.pages[n.page - 1]; if (pv) this.renderPage(pv);
    this.touch();
  }
  eraseEnd() {
    const g = this.group; this.group = null;
    if (g && g.ids.length) this.pushUndo(g);
  }

  // ---------- メモ（付箋のピン） ----------
  addNoteAt(e, pv) {
    this.closeEditor();
    const [x, y] = this.pagePoint(e, pv);
    const n = L.addNote(this.notes, { page: pv.index, x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4, text: '', color: this.color });
    this.pushUndo({ kind: 'add-note', ids: [n.id], pages: [pv.index] });
    this.renderPage(pv); this.touch();
    this.openEditor(n.id, true);
  }
  openEditor(id, isNew = false) {
    this.closeEditor();
    const n = this.notes.notes.find(x => x.id === id); if (!n || n.deleted) return;
    const ta = h('textarea', { class: 'input ne-text', rows: 4, placeholder: 'メモを書く…', 'aria-label': 'メモの本文', dataset: { t: 'note-text' } });
    ta.value = n.text || '';
    const colors = h('div', { class: 'ne-colors' });
    const paintColors = () => {
      clear(colors);
      for (const [hex, name] of PALETTE) colors.append(h('button', { class: 'dot' + (hex === n.color ? ' on' : ''), type: 'button', title: name, 'aria-label': name,
        onclick: () => { L.updateNote(this.notes, id, { color: hex }); this.afterNoteEdit(n); paintColors(); } }, null));
      colors.querySelectorAll('.dot').forEach((d, i) => d.style.setProperty('--c', PALETTE[i][0]));
    };
    paintColors();
    const save = debounce(() => { L.updateNote(this.notes, id, { text: ta.value }); this.afterNoteEdit(n); }, 250);
    ta.addEventListener('input', () => { n.text = ta.value; save(); });
    const del = h('button', { class: 'btn danger small', type: 'button', dataset: { t: 'note-delete' }, onclick: () => this.eraseNote(id) }, icon('trash'), '削除');
    const closeB = h('button', { class: 'btn small primary', type: 'button', dataset: { t: 'note-close' }, onclick: () => this.closeEditor() }, '閉じる');
    const box = h('div', { class: 'note-editor', role: 'dialog', 'aria-label': 'メモ', dataset: { id } },
      h('div', { class: 'ne-head' }, h('span', { class: 'ne-title', text: `p.${n.page} のメモ` }), colors), ta, h('div', { class: 'ne-foot' }, del, closeB));
    this.reader.bodyEl.append(box);
    this.editor = { id, box, ta, save, isNew };
    this.placeEditor(box, n);
    ta.focus({ preventScroll: true });
    this._outside = ev => {
      if (!this.editor || box.contains(ev.target) || ev.target.closest('.pin')) return;
      this.closeEditor();
    };
    setTimeout(() => document.addEventListener('pointerdown', this._outside, true), 0);
  }
  afterNoteEdit(n) {
    const pv = this.reader.pages[n.page - 1]; if (pv) this.renderPins(pv);
    this.touch();
  }
  placeEditor(box, n) {
    const pv = this.reader.pages[n.page - 1]; if (!pv) return;
    const body = this.reader.bodyEl.getBoundingClientRect(), pr = pv.el.getBoundingClientRect();
    if (this.reader.isPhone) { box.classList.add('dock'); box.style.left = '8px'; box.style.right = '8px'; return; }
    const x = pr.left + ((n.x - this.reader.offset) / this.reader.frac) * pr.width - body.left, y = pr.top + n.y * pr.height - body.top;
    const w = 300, hh = 200;
    box.style.width = w + 'px';
    box.style.left = clamp(x - w / 2, 8, Math.max(8, body.width - w - 8)) + 'px';
    box.style.top = clamp(y + 14, 8, Math.max(8, body.height - hh - 8)) + 'px';
  }
  closeEditor() {
    const ed = this.editor; if (!ed) return;
    this.editor = null;
    document.removeEventListener('pointerdown', this._outside, true);
    ed.save.flush();
    const n = this.notes.notes.find(x => x.id === ed.id);
    let dropped = false;
    if (n && !n.deleted && !(n.text || '').trim() && ed.isNew) {          // 空のまま閉じた新しい付箋は捨てる
      L.setNoteDeleted(this.notes, n.id, true); dropped = true;
      this.undoStack = this.undoStack.filter(o => !(o.kind === 'add-note' && o.ids[0] === n.id));
      this.fire('undo');
    }
    ed.box.remove();
    if (n) { const pv = this.reader.pages[n.page - 1]; if (pv) this.renderPage(pv); if (dropped) this.touch(); }
  }

  // ---------- 元に戻す／やり直す ----------
  pushUndo(op) { this.undoStack.push(op); if (this.undoStack.length > 300) this.undoStack.shift(); this.redoStack = []; this.fire('undo'); }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo() { const op = this.undoStack.pop(); if (!op) return; this.apply(op, true); this.redoStack.push(op); this.fire('undo'); }
  redo() { const op = this.redoStack.pop(); if (!op) return; this.apply(op, false); this.undoStack.push(op); this.fire('undo'); }
  apply(op, inverse) {
    this.closeEditor();
    for (const id of op.ids) {
      if (op.kind === 'add-stroke') L.setStrokeDeleted(this.notes, id, inverse);
      else if (op.kind === 'del-stroke') L.setStrokeDeleted(this.notes, id, !inverse);
      else if (op.kind === 'add-note') L.setNoteDeleted(this.notes, id, inverse);
      else if (op.kind === 'del-note') L.setNoteDeleted(this.notes, id, !inverse);
    }
    for (const p of op.pages || []) { const pv = this.reader.pages[p - 1]; if (pv) this.renderPage(pv); }
    this.touch();
  }
}
