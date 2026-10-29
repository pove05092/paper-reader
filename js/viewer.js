// viewer.js : リーダー（縦連続スクロール・遅延描画・表示切替・ズーム・ジェスチャ）。仕様 §3.2。
//  - 見えている付近のページだけキャンバスを持ち、離れたら解放する（48MB の PDF でも落ちない）。
//  - レイアウトの寸法はすべて zoom に比例させる → ピンチ中の CSS 変形と、指を離した後の再レイアウトが一致する。
//  - タッチは touch-action:none で自前処理：1 本指＝描く/スクロール、2 本指＝ピンチ＋移動（描きかけは取り消す）。
import * as L from './logic.js';
import { h, icon, clamp, debounce, toast, openMenu, clear, promptDialog } from './ui.js';
import { openPdf, isCancelled } from './pdf.js';
import { Ink } from './ink.js';
import { buildToolbar } from './toolbar.js';
import { Panel } from './panel.js';

const ZMIN = 0.4, ZMAX = 6;
const MAX_CANVAS_PX = 16_000_000;
const PHONE_MAX = 899;

class PageView {
  constructor(reader, index, aspect) {
    this.reader = reader; this.index = index; this.aspect = aspect;       // aspect = 見開き全体の 高さ/幅
    this.label = h('div', { class: 'page-label', text: String(index) });
    this.pins = h('div', { class: 'pins' });
    this.el = h('div', { class: 'page', dataset: { p: index } }, this.label, this.pins);
    this.pdfCanvas = null; this.mCanvas = null; this.pCanvas = null; this.live = null;
    this.active = false; this.gen = 0; this.task = null; this.renderedKey = ''; this.failed = null;
    this.top = 0; this.cssW = 0; this.cssH = 0;
  }
  freeCanvases() {
    for (const k of ['pdfCanvas', 'mCanvas', 'pCanvas', 'live']) { const c = this[k]; if (c) { c.width = c.height = 0; c.remove(); this[k] = null; } }
    clear(this.pins);
    this.el.classList.remove('has-pdf', 'render-failed');
  }
}

export class Reader {
  /** opts: { engine, paper, prefs:{get,set}, onBack, syncPill:Element } */
  constructor(opts) {
    this.opts = opts; this.engine = opts.engine; this.paper = opts.paper;
    this.zoom = 1; this.view = 'both'; this.frac = 1; this.offset = 0; this.kind = 'spread';
    this.pages = []; this.pdf = null; this.rec = null; this.ink = null; this.panel = null; this.destroyed = false;
    this.renderHold = false; this.pumping = false; this.listeners = [];
    this.ptrs = new Map(); this.mode = 'idle'; this.tap = null; this.pan = null; this.pinch = null; this.flingRaf = 0;
    this.mq = window.matchMedia(`(max-width: ${PHONE_MAX}px)`);
    this.isPhone = this.mq.matches;
    this.build();
  }

  // ---------- DOM ----------
  build() {
    const p = this.paper;
    const spread = true;                 // 見開きかどうかは PDF を開いてから決まる（single なら .single で隠す）
    this.backB = h('button', { class: 'btn icon plain', type: 'button', 'aria-label': 'ライブラリへ戻る', dataset: { t: 'back' }, onclick: () => this.opts.onBack() }, icon('back'));
    this.titleEl = h('div', { class: 'rd-title', title: p.title, text: p.title });
    this.viewBtns = [['both', '両方'], ['orig', '原文'], ['ja', '日本語']].map(([v, l]) => h('button', { class: 'seg-b', type: 'button', dataset: { t: 'view-' + v, v }, 'aria-pressed': 'false', onclick: () => this.setView(v, true) }, l));
    this.viewSeg = h('div', { class: 'seg view-seg', role: 'group', 'aria-label': '表示' }, this.viewBtns);
    this.zoomLabel = h('button', { class: 'zoom-label', type: 'button', dataset: { t: 'zoom-label' }, title: '幅に合わせる', onclick: () => this.fitWidth() }, '100%');
    this.zoomBox = h('div', { class: 'zoombox', role: 'group', 'aria-label': '拡大縮小' },
      h('button', { class: 'btn icon plain', type: 'button', 'aria-label': '縮小', dataset: { t: 'zoom-out' }, onclick: () => this.zoomBy(1 / 1.25) }, icon('minus')),
      this.zoomLabel,
      h('button', { class: 'btn icon plain', type: 'button', 'aria-label': '拡大', dataset: { t: 'zoom-in' }, onclick: () => this.zoomBy(1.25) }, icon('plus')),
      h('button', { class: 'btn icon plain', type: 'button', 'aria-label': '幅に合わせる', dataset: { t: 'zoom-fit' }, onclick: () => this.fitWidth() }, icon('fit')));
    this.pageInput = h('input', { class: 'page-input', type: 'number', min: 1, value: 1, inputmode: 'numeric', 'aria-label': 'ページ番号', dataset: { t: 'page-input' } });
    this.pageInput.addEventListener('change', () => this.goto(Number(this.pageInput.value)));
    this.pageInput.addEventListener('keydown', e => { if (e.key === 'Enter') this.pageInput.blur(); });
    this.pageTotal = h('span', { class: 'page-total', text: '/ 1' });
    this.pageInd = h('div', { class: 'pageind', dataset: { t: 'pageind' } }, this.pageInput, this.pageTotal);
    this.viewMenuB = h('button', { class: 'btn plain small view-menu-b', type: 'button', dataset: { t: 'view-menu' }, onclick: e => this.openViewMenu(e.currentTarget) }, icon('eye'), '表示');
    this.panelB = h('button', { class: 'btn icon plain', type: 'button', 'aria-label': 'パネル', 'aria-pressed': 'false', dataset: { t: 'panel-toggle' }, onclick: () => this.togglePanel() }, icon('panel'));
    this.topEl = h('header', { class: 'rd-top' }, this.backB, this.titleEl, spread ? this.viewSeg : null, this.zoomBox, this.pageInd, this.opts.syncPill || null, spread ? this.viewMenuB : null, this.panelB);

    this.pagesEl = h('div', { class: 'pages', dataset: { t: 'pages' } });
    this.stage = h('div', { class: 'stage' }, this.pagesEl);
    this.scroller = h('div', { class: 'rd-scroll', tabindex: '0', dataset: { t: 'scroller' }, 'aria-label': '論文の本文' }, this.stage);
    this.loadingEl = h('div', { class: 'rd-loading', dataset: { t: 'loading' } }, h('div', { class: 'spin' }), h('div', { class: 'msg', text: '' }), h('div', { class: 'bar' }, h('div', { class: 'fill' })));
    this.pageBadge = h('button', { class: 'page-badge', type: 'button', dataset: { t: 'page-badge' }, 'aria-label': 'ページ番号（押すと移動）', onclick: () => this.promptPage() }, '1 / 1');
    this.bodyEl = h('div', { class: 'rd-body' }, this.scroller, this.pageBadge, this.loadingEl);
    this.root = h('div', { class: 'reader' + (this.isPhone ? ' phone' : ''), dataset: { tool: 'move' } }, this.topEl, this.bodyEl);
  }
  mount(host) {
    clear(host); host.append(this.root);
    this.on(window, 'resize', () => this.onResize());
    const ro = new ResizeObserver(() => this.onResize());
    ro.observe(this.scroller); this.ro = ro;
    this.on(this.mq, 'change', () => this.onResize());
    this.on(document, 'keydown', e => this.onKey(e));
  }
  on(target, type, fn, opts) { target.addEventListener(type, fn, opts); this.listeners.push(() => target.removeEventListener(type, fn, opts)); }
  setLoading(msg, ratio) {
    this.loadingEl.hidden = false;
    this.loadingEl.querySelector('.msg').textContent = msg || '';
    const bar = this.loadingEl.querySelector('.bar');
    bar.hidden = ratio == null;
    if (ratio != null) bar.firstChild.style.width = Math.round(clamp(ratio, 0, 1) * 100) + '%';
    this.loadingEl.classList.remove('err');
  }
  showLoadError(e) {
    this.loadingEl.hidden = false; this.loadingEl.classList.add('err');
    const msg = e && e.message ? e.message : String(e);
    clear(this.loadingEl);
    this.loadingEl.append(h('div', { class: 'msg', dataset: { t: 'load-error' }, text: '論文を開けませんでした：' + msg }),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => this.opts.onBack() }, 'ライブラリへ戻る'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => this.opts.onRetry?.() }, 'もう一度')));
  }

  // ---------- 読み込み ----------
  async load() {
    try {
      this.setLoading('論文を準備中…', null);
      if (this.engine.configured && this.engine.online) {             // 論文を開いた時は倉庫の head を確かめ、他の端末の最新から見せる（仕様 §4.5）。遅ければ待たずに進む
        await Promise.race([this.engine.refresh(), new Promise(r => setTimeout(r, 4000))]);
        this.paper = this.engine.library.papers.find(p => p.id === this.paper.id) || this.paper;
      }
      const blob = await this.engine.getPdfBlob(this.paper, (got, total) => {
        const mb = n => (n / 1048576).toFixed(1);
        this.setLoading(`ダウンロード中… ${mb(got)}${total ? ' / ' + mb(total) : ''} MB`, total ? got / total : null);
      });
      if (this.destroyed) return false;
      this.setLoading('メモを読み込み中…', null);
      this.rec = await this.engine.openNotes(this.paper.id);
      this.setLoading('PDF を開いています…', null);
      this.pdf = await openPdf(blob);
      if (this.destroyed) { this.pdf.destroy(); return false; }
      const p1 = await this.pdf.getPage(1);
      const vp = p1.getViewport({ scale: 1 }); p1.cleanup();
      this.kind = L.guessLayout(vp.width, vp.height);
      const aspect = vp.height / vp.width;
      this.numPages = this.pdf.numPages;
      this.pages = Array.from({ length: this.numPages }, (_, i) => new PageView(this, i + 1, aspect));
      this.pagesEl.append(...this.pages.map(pv => pv.el));
      this.ink = new Ink(this, this.opts.prefs.get());
      this.onRemoteNotes = e => { if (e.detail === this.paper.id && this.ink && !this.destroyed) this.ink.rerenderAll(); };   // 他の端末の書き込みを合流したら描き直す
      this.engine.addEventListener('notes', this.onRemoteNotes);
      this.toolbar = buildToolbar(this, this.ink);
      this.root.insertBefore(this.toolbar.el, this.bodyEl);
      this.panel = new Panel(this);
      this.bodyEl.append(this.panel.el);
      this.pageTotal.textContent = '/ ' + this.numPages; this.pageInput.max = this.numPages;
      this.view = this.resolveView(); this.applyViewState();
      this.root.classList.toggle('single', this.kind === 'single');
      this.bindScroll(); this.bindGestures();
      this.layout();
      if (this.opts.prefs.get().panel && !this.isPhone) this.togglePanel(true, true);
      this.loadingEl.hidden = true;
      this.goto(clamp(this.paper.lastPage || 1, 1, this.numPages), true);
      this.updateActive();
      this.updatePageIndicator();
      this.probeSizes();
      return true;
    } catch (e) {
      if (!this.destroyed) { console.warn('[reader] 開けませんでした', e && e.name, e && e.message); this.showLoadError(e); }
      return false;
    }
  }
  /** 見開き PDF の既定の表示：画面幅 700px 未満は日本語、それ以上は両方。端末ごとに覚える（設定の defaultView） */
  resolveView() {
    if (this.kind === 'single') return 'both';
    const d = this.engine.settings.defaultView;
    if (d === 'both' || d === 'orig' || d === 'ja') return d;
    return window.innerWidth < 700 ? 'ja' : 'both';
  }
  applyViewState() {
    this.frac = this.view === 'both' ? 1 : 0.5;
    this.offset = this.view === 'ja' ? 0.5 : 0;
    for (const b of this.viewBtns) b.setAttribute('aria-pressed', String(b.dataset.v === this.view));
    this.root.dataset.view = this.view;
  }
  /** 全ページの大きさを後ろで調べる（ページごとに違う PDF でも位置がずれないように） */
  async probeSizes() {
    let changed = false;
    for (let i = 2; i <= this.numPages && !this.destroyed; i++) {
      try {
        const pg = await this.pdf.getPage(i);
        const vp = pg.getViewport({ scale: 1 }); pg.cleanup();
        const a = vp.height / vp.width, pv = this.pages[i - 1];
        if (Math.abs(a - pv.aspect) / pv.aspect > 0.002) { pv.aspect = a; changed = true; }
      } catch (e) { return; }
      if (i % 6 === 0) await new Promise(r => setTimeout(r, 0));
    }
    if (changed && !this.destroyed) this.relayout();
  }

  // ---------- 寸法 ----------
  layout() {
    const sc = this.scroller, cw = sc.clientWidth || 360, z = this.zoom;
    const base = this.isPhone ? { pad: 6, gap: 8 } : { pad: 14, gap: 14 };
    const pad = base.pad * z, gap = base.gap * z;
    this.fitW = Math.max(160, cw - 2 * base.pad);
    const W = this.fitW * z;
    let y = pad;
    for (const pv of this.pages) {
      pv.cssW = W; pv.cssH = W * pv.aspect / this.frac;
      pv.el.style.width = W + 'px'; pv.el.style.height = pv.cssH + 'px';
      pv.top = y; y += pv.cssH + gap;
    }
    this.pad = pad; this.contentW = W + 2 * pad; this.contentH = y - gap + pad;
    Object.assign(this.pagesEl.style, { width: this.contentW + 'px', height: this.contentH + 'px', padding: pad + 'px', gap: gap + 'px' });
    Object.assign(this.stage.style, { width: Math.max(this.contentW, cw) + 'px', height: this.contentH + 'px' });
    this.zoomLabel.textContent = Math.round(z * 100) + '%';
    this.lastCW = cw;
  }
  pageAtY(y) {
    let lo = 0, hi = this.pages.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.pages[mid].top <= y) lo = mid; else hi = mid - 1; }
    return this.pages[lo];
  }
  anchor() {
    const sc = this.scroller, pv = this.pageAtY(sc.scrollTop + 1);
    return { index: pv.index, frac: (sc.scrollTop - pv.top) / Math.max(1, pv.cssH), left: sc.scrollLeft / Math.max(1, this.contentW) };
  }
  restoreAnchor(a) {
    const pv = this.pages[a.index - 1]; if (!pv) return;
    this.scroller.scrollTop = pv.top + a.frac * pv.cssH;
    this.scroller.scrollLeft = a.left * this.contentW;
  }
  /** 幅・表示・ページ寸法が変わった時：今見ている位置を保って組み直す */
  relayout() {
    if (!this.pages.length) return;
    const a = this.anchor();
    this.layout(); this.restoreAnchor(a);
    this.afterLayout();
  }
  afterLayout({ hold = false } = {}) {
    for (const pv of this.pages) if (pv.active) this.ink.renderPage(pv);
    if (hold) this.holdRender();
    this.updateActive(); this.updatePageIndicator();
  }
  onResize() {
    if (this.destroyed) return;
    const phone = this.mq.matches;
    if (phone !== this.isPhone) { this.isPhone = phone; this.root.classList.toggle('phone', phone); }
    if (this.scroller.clientWidth && Math.abs(this.scroller.clientWidth - (this.lastCW || 0)) > 1) { this.relayout(); }
    else if (this.pages.length) this.updateActive();
  }

  // ---------- 表示の切替・ズーム ----------
  setView(v, remember = false) {
    if (this.kind === 'single') v = 'both';
    if (v === this.view) return;
    this.view = v; this.applyViewState();
    if (remember) { this.engine.settings.defaultView = v; this.opts.onSettingsChange?.(); }
    this.ink.closeEditor();
    for (const pv of this.pages) {                       // 中身（半分/全体）が変わるので、古い絵は引き伸ばさずに捨てる
      pv.gen++;
      if (pv.task) { try { pv.task.cancel(); } catch (e) { /* 終了済み */ } pv.task = null; }
      if (pv.pdfCanvas) { pv.pdfCanvas.width = pv.pdfCanvas.height = 0; pv.pdfCanvas.remove(); pv.pdfCanvas = null; }
      pv.renderedKey = ''; pv.failed = null; pv.el.classList.remove('has-pdf');
    }
    this.relayout();
  }
  zoomBy(f) {
    const r = this.scroller.getBoundingClientRect();
    this.zoomAt(clamp(this.zoom * f, ZMIN, ZMAX), r.left + r.width / 2, r.top + r.height / 2);
  }
  fitWidth() {
    const r = this.scroller.getBoundingClientRect();
    this.zoomAt(1, r.left + r.width / 2, r.top + r.height / 2);
  }
  /** 画面上の点 (clientX, clientY) の下にある紙面の位置を動かさずに倍率を変える */
  zoomAt(z1, clientX, clientY, { hold = false } = {}) {
    if (z1 === this.zoom) return;
    const sc = this.scroller, r = sc.getBoundingClientRect(), cx = clientX - r.left, cy = clientY - r.top;
    const P0 = { x: cx + sc.scrollLeft - this.pagesEl.offsetLeft, y: cy + sc.scrollTop - this.pagesEl.offsetTop };
    this.commitZoom(z1, P0, cx, cy, { hold });
  }
  commitZoom(z1, P0, cx, cy, { hold = false } = {}) {
    const ratio = z1 / this.zoom, sc = this.scroller;
    this.zoom = z1; this.layout();
    sc.scrollLeft = this.pagesEl.offsetLeft + P0.x * ratio - cx;
    sc.scrollTop = this.pagesEl.offsetTop + P0.y * ratio - cy;
    this.afterLayout({ hold });
  }
  holdRender() {
    this.renderHold = true; clearTimeout(this._holdT);
    this._holdT = setTimeout(() => { this.renderHold = false; this.pump(); }, 180);
  }

  // ---------- 遅延描画 ----------
  pixelRatio(pv) {
    const dpr = window.devicePixelRatio || 1;
    const byArea = Math.sqrt(MAX_CANVAS_PX / Math.max(1, pv.cssW * pv.cssH));
    return Math.max(0.5, Math.min(dpr, byArea, 3));
  }
  keyFor(pv) { return `${this.view}|${Math.round(pv.cssW)}x${Math.round(pv.cssH)}|${this.pixelRatio(pv).toFixed(2)}`; }
  updateActive() {
    if (!this.pages.length) return;
    const sc = this.scroller, st = sc.scrollTop, ch = sc.clientHeight || 600;
    const margin = ch * (this.isPhone ? 0.8 : 1.0), lo = st - margin, hi = st + ch + margin, mid = st + ch / 2;
    const cand = this.pages.filter(pv => pv.top + pv.cssH >= lo && pv.top <= hi);
    cand.sort((a, b) => Math.abs(a.top + a.cssH / 2 - mid) - Math.abs(b.top + b.cssH / 2 - mid));
    const budget = this.isPhone ? 60e6 : 140e6;
    let used = 0; const keep = new Set();
    for (const pv of cand) {
      const r = this.pixelRatio(pv), px = pv.cssW * pv.cssH * r * r;
      const visible = pv.top + pv.cssH >= st && pv.top <= st + ch;
      if (visible || used + px <= budget) { keep.add(pv); used += px; }
    }
    for (const pv of this.pages) {
      if (keep.has(pv)) { if (!pv.active) this.activate(pv); }
      else if (pv.active) this.deactivate(pv);
    }
    this.pump();
  }
  activate(pv) { pv.active = true; this.ink.renderPage(pv); }
  deactivate(pv) {
    pv.active = false; pv.gen++;
    if (pv.task) { try { pv.task.cancel(); } catch (e) { /* 終了済み */ } pv.task = null; }
    pv.freeCanvases(); pv.renderedKey = ''; pv.failed = null;
  }
  nextToRender() {
    const sc = this.scroller, c = sc.scrollTop + (sc.clientHeight || 600) / 2;
    let best = null, bd = Infinity;
    for (const pv of this.pages) {
      if (!pv.active) continue;
      const k = this.keyFor(pv);
      if (pv.renderedKey === k || pv.failed === k) continue;
      const d = Math.abs(pv.top + pv.cssH / 2 - c);
      if (d < bd) { bd = d; best = pv; }
    }
    return best;
  }
  async pump() {
    if (this.pumping || this.renderHold || this.destroyed) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.destroyed || this.renderHold) break;
        const pv = this.nextToRender();
        if (!pv) break;
        await this.renderPage(pv);
      }
    } finally { this.pumping = false; }
  }
  async renderPage(pv) {
    const key = this.keyFor(pv), gen = ++pv.gen;
    const ratio = this.pixelRatio(pv);
    const pxW = Math.max(1, Math.round(pv.cssW * ratio)), pxH = Math.max(1, Math.round(pv.cssH * ratio));
    let page = null;
    try {
      page = await this.pdf.getPage(pv.index);
      if (gen !== pv.gen || !pv.active || this.destroyed) return;
      const baseVp = page.getViewport({ scale: 1 });
      const scale = pxW / (baseVp.width * this.frac);
      const vp = page.getViewport({ scale, offsetX: -this.offset * baseVp.width * scale });   // 半分表示は viewport の offsetX でずらして半分の幅のキャンバスに描く
      const canvas = document.createElement('canvas');
      canvas.width = pxW; canvas.height = pxH; canvas.className = 'c-pdf';
      const task = page.render({ canvas, viewport: vp, background: 'rgb(255,255,255)' });
      pv.task = task;
      await task.promise;
      pv.task = null;
      if (gen !== pv.gen || !pv.active || this.destroyed) { canvas.width = canvas.height = 0; return; }
      if (pv.pdfCanvas) { pv.pdfCanvas.width = pv.pdfCanvas.height = 0; pv.pdfCanvas.remove(); }
      pv.el.insertBefore(canvas, pv.el.firstChild);
      pv.pdfCanvas = canvas; pv.renderedKey = key; pv.failed = null;
      pv.el.classList.add('has-pdf'); pv.el.classList.remove('render-failed');
    } catch (e) {
      pv.task = null;
      if (isCancelled(e)) return;
      pv.failed = key; pv.el.classList.add('render-failed');
      console.warn('[reader] ページを描画できませんでした', pv.index, e && e.message);
    } finally {
      try { if (page) page.cleanup(); } catch (e) { /* 無視 */ }
    }
  }

  // ---------- スクロール・ページ ----------
  bindScroll() {
    let raf = 0;
    this.on(this.scroller, 'scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; if (this.destroyed) return; this.updateActive(); this.updatePageIndicator(); });
    }, { passive: true });
  }
  currentPage() {
    if (!this.pages.length) return 1;
    return this.pageAtY(this.scroller.scrollTop + (this.scroller.clientHeight || 600) * 0.35).index;
  }
  updatePageIndicator() {
    const n = this.currentPage();
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(n);
    this.pageBadge.textContent = `${n} / ${this.numPages || 1}`;
    this.curPage = n;
  }
  async promptPage() {
    const v = await promptDialog({ title: 'ページへ移動', label: `1 〜 ${this.numPages}`, value: String(this.currentPage()), okLabel: '移動' });
    if (v && /^\d+$/.test(v)) this.goto(Number(v));
  }
  goto(n, instant = false) {
    const pv = this.pages[clamp(Math.round(n) || 1, 1, this.numPages) - 1]; if (!pv) return;
    this.scroller.scrollTop = Math.max(0, pv.top - 6);
    this.scroller.scrollLeft = 0;
    this.updateActive(); this.updatePageIndicator();
  }
  /** メモ・マーカー一覧から飛ぶ：その場所を中央付近に出して一瞬光らせる */
  jumpTo({ page, x, y }) {
    const pv = this.pages[page - 1]; if (!pv) return;
    if (this.kind === 'spread' && this.view !== 'both' && x != null) {
      const want = x >= 0.5 ? 'ja' : 'orig';
      if (want !== this.view) this.setView(want);
    }
    const sc = this.scroller;
    sc.scrollTop = Math.max(0, pv.top + (y ?? 0) * pv.cssH - (sc.clientHeight || 600) * 0.4);
    if (x != null && this.contentW > sc.clientWidth + 2) {
      const xx = this.pagesEl.offsetLeft + this.pad + ((x - this.offset) / this.frac) * pv.cssW;
      sc.scrollLeft = Math.max(0, xx - sc.clientWidth / 2);
    }
    this.updateActive(); this.updatePageIndicator();
    if (x != null) {
      const ring = h('div', { class: 'flash' });
      ring.style.left = (((x - this.offset) / this.frac) * 100) + '%'; ring.style.top = ((y ?? 0) * 100) + '%';
      pv.el.append(ring); setTimeout(() => ring.remove(), 1500);
    }
    if (this.isPhone) this.togglePanel(false);
  }

  // ---------- パネル・メニュー ----------
  togglePanel(force, silent = false) {
    const open = force ?? !this.root.classList.contains('panel-open');
    this.root.classList.toggle('panel-open', open);
    this.panelB.setAttribute('aria-pressed', String(open));
    if (!silent && !this.isPhone) this.opts.prefs.set({ panel: open });
    if (this.pages.length && !this.isPhone) this.relayout();
    if (open && this.panel) this.panel.setTab(this.panel.tab);
  }
  openViewMenu(anchor) {
    openMenu(anchor, [
      { heading: '表示' },
      ...[['both', '両方（見開き）'], ['orig', '原文（左）'], ['ja', '日本語（右）']].map(([v, l]) => ({ label: l, checked: this.view === v, id: 'vm-' + v, onClick: () => this.setView(v, true) })),
      { sep: true }, { heading: '拡大縮小' },
      { label: '拡大', id: 'vm-in', onClick: () => this.zoomBy(1.25) }, { label: '縮小', id: 'vm-out', onClick: () => this.zoomBy(1 / 1.25) }, { label: '幅に合わせる', id: 'vm-fit', onClick: () => this.fitWidth() },
    ], { align: 'right' });
  }
  savePrefs() {
    const k = this.ink;
    this.opts.prefs.set({ color: k.color, markerSize: k.size.marker, penSize: k.size.pen, straight: k.straight });
  }

  // ---------- キーボード（PC） ----------
  onKey(e) {
    if (!this.ink) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? this.ink.redo() : this.ink.undo(); return; }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); this.ink.redo(); return; }
    if (mod || e.altKey) return;
    const map = { v: 'move', m: 'marker', p: 'pen', e: 'eraser', n: 'note' };
    if (map[k]) { this.ink.setTool(map[k]); return; }
    if (k === 'Escape') { if (this.ink.editor) this.ink.closeEditor(); else this.ink.setTool('move'); return; }
    if (k === 's') { this.ink.setStraight(!this.ink.straight); return; }
    if (k === '+' || k === '=') { this.zoomBy(1.25); return; }
    if (k === '-') { this.zoomBy(1 / 1.25); return; }
    if (k === '0') { this.fitWidth(); return; }
  }

  // ---------- ジェスチャ（ポインタ） ----------
  bindGestures() {
    const s = this.scroller;
    this.on(s, 'pointerdown', e => this.onDown(e));
    this.on(s, 'pointermove', e => this.onMove(e));
    this.on(s, 'pointerup', e => this.onUp(e, false));
    this.on(s, 'pointercancel', e => this.onUp(e, true));
    this.on(s, 'wheel', e => this.onWheel(e), { passive: false });
    this.on(s, 'contextmenu', e => e.preventDefault());
  }
  pageFromTarget(t) { const el = t && t.closest ? t.closest('.page') : null; return el ? this.pages[Number(el.dataset.p) - 1] : null; }
  pageAtPoint(x, y) {
    const r = this.scroller.getBoundingClientRect();
    const yy = y - r.top + this.scroller.scrollTop;
    const pv = this.pageAtY(yy);
    return (pv && yy >= pv.top - 4 && yy <= pv.top + pv.cssH + 4) ? pv : null;
  }
  stopFling() { if (this.flingRaf) { cancelAnimationFrame(this.flingRaf); this.flingRaf = 0; } }
  onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.stopFling();
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (this.ptrs.size === 1) {
      this.mode = 'idle'; this.tap = null;
      const tool = this.ink.effectiveTool(e);
      const pin = e.target.closest && e.target.closest('.pin');
      const pv = this.pageFromTarget(e.target);
      const now = performance.now();
      if (pin) { this.mode = 'tap'; this.tap = { pin: pin.dataset.id, x: e.clientX, y: e.clientY, t: now, type: e.pointerType }; return; }
      if ((tool === 'marker' || tool === 'pen') && pv) {
        this.mode = 'draw'; this.ink.begin(e, pv, tool);
        if (e.pointerType !== 'touch') try { this.scroller.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
        return;
      }
      if (tool === 'eraser' && pv) {
        this.mode = 'erase'; this.ink.eraseBegin(); this.ink.eraseAt(e, pv);
        if (e.pointerType !== 'touch') try { this.scroller.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
        return;
      }
      if (tool === 'note' && pv) { this.mode = 'tap'; this.tap = { note: pv, x: e.clientX, y: e.clientY, t: now, type: e.pointerType }; return; }
      this.startPan(e);
      if (e.pointerType === 'mouse') try { this.scroller.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
    } else if (this.ptrs.size === 2) {
      if (this.mode === 'draw') this.ink.cancel();
      if (this.mode === 'erase') this.ink.eraseEnd();
      this.beginPinch();
    }
  }
  startPan(e) { this.mode = 'pan'; this.pan = { lastX: e.clientX, lastY: e.clientY, samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }] }; }
  onMove(e) {
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    switch (this.mode) {
      case 'draw': this.ink.move(e); break;
      case 'erase': { const pv = this.pageAtPoint(e.clientX, e.clientY); if (pv) this.ink.eraseAt(e, pv); break; }
      case 'pan': this.doPan(e); break;
      case 'pinch': this.movePinch(); break;
      case 'tap':
        if (this.tap && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) > 10) {
          if (this.tap.type === 'mouse') this.tap = null;             // マウスで動いたら「クリック」ではない
          else { this.tap = null; this.startPan({ clientX: e.clientX, clientY: e.clientY }); }   // タッチは動かし始めたらスクロールへ
        }
        break;
      default: break;
    }
  }
  onUp(e, cancelled) {
    const p = this.ptrs.get(e.pointerId); if (!p) return;
    this.ptrs.delete(e.pointerId);
    const mode = this.mode;
    if (mode === 'draw') { cancelled ? this.ink.cancel() : this.ink.end(); this.mode = 'idle'; }
    else if (mode === 'erase') { this.ink.eraseEnd(); this.mode = 'idle'; }
    else if (mode === 'pan') { if (!cancelled && p.type !== 'mouse') this.startFling(); this.mode = 'idle'; }
    else if (mode === 'tap') { if (!cancelled && this.tap) this.finishTap(e); this.tap = null; this.mode = 'idle'; }
    else if (mode === 'pinch') { if (this.ptrs.size < 2) { this.endPinch(); this.mode = this.ptrs.size ? 'ignore' : 'idle'; } }
    if (this.ptrs.size === 0) this.mode = 'idle';
  }
  finishTap(e) {
    const tp = this.tap;
    if (Math.hypot(e.clientX - tp.x, e.clientY - tp.y) > 10 || performance.now() - tp.t > 800) return;
    if (tp.pin) { if (this.ink.tool === 'eraser') this.ink.eraseNote(tp.pin); else this.ink.openEditor(tp.pin); }
    else if (tp.note) this.ink.addNoteAt(e, tp.note);
  }
  doPan(e) {
    const pan = this.pan, sc = this.scroller;
    sc.scrollLeft -= e.clientX - pan.lastX; sc.scrollTop -= e.clientY - pan.lastY;
    pan.lastX = e.clientX; pan.lastY = e.clientY;
    const t = performance.now();
    pan.samples.push({ t, x: e.clientX, y: e.clientY });
    while (pan.samples.length > 2 && t - pan.samples[0].t > 100) pan.samples.shift();
  }
  startFling() {
    const s = this.pan && this.pan.samples; if (!s || s.length < 2) return;
    const a = s[0], b = s[s.length - 1], dt = b.t - a.t; if (dt < 8 || performance.now() - b.t > 60) return;
    let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;            // px/ms（指の向き）
    if (Math.hypot(vx, vy) < 0.15) return;
    let last = performance.now();
    const step = now => {
      const d = now - last; last = now;
      const f = Math.exp(-d / 325);
      this.scroller.scrollLeft -= vx * d; this.scroller.scrollTop -= vy * d;
      vx *= f; vy *= f;
      if (Math.hypot(vx, vy) > 0.02 && !this.destroyed) this.flingRaf = requestAnimationFrame(step); else this.flingRaf = 0;
    };
    this.flingRaf = requestAnimationFrame(step);
  }
  onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;                          // 通常のホイールは本来のスクロール
    e.preventDefault();
    const z = clamp(this.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022)), ZMIN, ZMAX);
    this.zoomAt(z, e.clientX, e.clientY, { hold: true });
  }

  // ---------- ピンチ（拡大中は CSS 変形、離したら高解像度で描き直す）----------
  pinchPoints() { const [a, b] = [...this.ptrs.values()]; return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; }
  beginPinch() {
    this.stopFling(); this.mode = 'pinch'; this.tap = null;
    const { mx, my, d } = this.pinchPoints();
    const sr = this.scroller.getBoundingClientRect(), pr = this.pagesEl.getBoundingClientRect();
    this.pinch = { z0: this.zoom, d0: d, P0: { x: mx - pr.left, y: my - pr.top }, o0: { x: pr.left - sr.left, y: pr.top - sr.top }, sr, s: 1, cx: mx - sr.left, cy: my - sr.top };
    this.pagesEl.style.transformOrigin = '0 0';
    this.pagesEl.style.willChange = 'transform';
  }
  movePinch() {
    const pc = this.pinch; if (!pc || this.ptrs.size < 2) return;
    const { mx, my, d } = this.pinchPoints();
    const z1 = clamp(pc.z0 * (d / pc.d0), ZMIN, ZMAX);
    const s = z1 / pc.z0;
    const cx = mx - pc.sr.left, cy = my - pc.sr.top;
    pc.s = s; pc.cx = cx; pc.cy = cy;
    this.pagesEl.style.transform = `translate(${cx - pc.o0.x - pc.P0.x * s}px, ${cy - pc.o0.y - pc.P0.y * s}px) scale(${s})`;
  }
  endPinch() {
    const pc = this.pinch; this.pinch = null; if (!pc) return;
    this.pagesEl.style.transform = ''; this.pagesEl.style.willChange = '';
    const z1 = clamp(pc.z0 * pc.s, ZMIN, ZMAX);
    if (Math.abs(z1 - this.zoom) > 1e-6) this.commitZoom(z1, pc.P0, pc.cx, pc.cy);
  }

  // ---------- 状態（試験・画面外からの確認用）----------
  state() {
    return {
      zoom: this.zoom, view: this.view, kind: this.kind, page: this.currentPage(), numPages: this.numPages, tool: this.ink && this.ink.tool,
      active: this.pages.filter(p => p.active).map(p => p.index),
      canvases: this.pages.filter(p => p.pdfCanvas).map(p => ({ i: p.index, w: p.pdfCanvas.width, h: p.pdfCanvas.height, cssW: Math.round(p.cssW), cssH: Math.round(p.cssH) })),
      liveCanvases: this.pages.reduce((n, p) => n + ['pdfCanvas', 'mCanvas', 'pCanvas', 'live'].filter(k => p[k]).length, 0),
      strokes: this.rec ? this.rec.notes.strokes.filter(s => !s.deleted).length : 0, notes: this.rec ? this.rec.notes.notes.filter(n => !n.deleted).length : 0,
      scroll: { top: this.scroller.scrollTop, left: this.scroller.scrollLeft, h: this.scroller.scrollHeight, w: this.scroller.scrollWidth, ch: this.scroller.clientHeight, cw: this.scroller.clientWidth },
    };
  }

  destroy() {
    this.destroyed = true;
    this.stopFling(); clearTimeout(this._holdT);
    for (const off of this.listeners) off();
    try { this.ro && this.ro.disconnect(); } catch (e) { /* 無視 */ }
    this.ink && this.ink.closeEditor();
    for (const pv of this.pages) { if (pv.task) { try { pv.task.cancel(); } catch (e) { /* 無視 */ } } pv.freeCanvases(); }
    this.panel && this.panel.destroy();
    if (this.onRemoteNotes) this.engine.removeEventListener('notes', this.onRemoteNotes);
    try { this.pdf && this.pdf.destroy(); } catch (e) { /* 無視 */ }
    this.pdf = null;
    this.engine.closeNotes(this.paper.id);
    this.root.remove();
  }
}
