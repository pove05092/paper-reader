// panel.js : 横のパネル（PC は右、スマホは下からのシート）。要約・メモ・情報の3タブ。仕様 §3.4。
import * as L from './logic.js';
import { h, icon, clear, debounce, renderMarkdown, colorName } from './ui.js';
import { tagEditor } from './tags.js';

export class Panel {
  constructor(reader) {
    this.reader = reader; this.engine = reader.engine; this.tab = 'summary';
    this.tabs = [['summary', '要約'], ['notes', 'メモ'], ['info', '情報']];
    this.tabBtns = this.tabs.map(([id, label]) => h('button', { class: 'tab', type: 'button', role: 'tab', dataset: { t: 'tab-' + id, tab: id }, 'aria-selected': 'false', onclick: () => this.setTab(id) }, label));
    this.bodyEl = h('div', { class: 'pn-body', role: 'tabpanel' });
    this.el = h('aside', { class: 'rd-panel', 'aria-label': 'パネル' },
      h('div', { class: 'pn-head' }, h('div', { class: 'tabs', role: 'tablist' }, this.tabBtns), h('button', { class: 'btn icon plain pn-close', type: 'button', 'aria-label': 'パネルを閉じる', dataset: { t: 'panel-close' }, onclick: () => reader.togglePanel(false) }, icon('close'))),
      this.bodyEl);
    this.summaryText = undefined;
    this.setTab('summary');
    const onNotes = () => { if (this.tab === 'notes') this.renderNotes(); if (this.tab === 'summary') this.syncMySummary(); };
    reader.ink.onChange(w => { if (w === 'notes') this.scheduleNotes(); });
    this.scheduleNotes = debounce(() => { if (this.tab === 'notes') this.renderNotes(); }, 250);
    this.onRemoteNotes = e => { if (e.detail === reader.paper.id) onNotes(); };
    this.engine.addEventListener('notes', this.onRemoteNotes);
    this.onLib = () => { if (this.tab === 'info' && !this.el.contains(document.activeElement)) this.renderInfo(); };
    this.engine.addEventListener('library', this.onLib);
  }
  destroy() { this.engine.removeEventListener('notes', this.onRemoteNotes); this.engine.removeEventListener('library', this.onLib); }
  get paper() { return this.engine.library.papers.find(p => p.id === this.reader.paper.id) || this.reader.paper; }
  setTab(t) {
    this.tab = t;
    for (const b of this.tabBtns) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    if (t === 'summary') this.renderSummary(); else if (t === 'notes') this.renderNotes(); else this.renderInfo();
  }

  // ---------- 要約 ----------
  async renderSummary() {
    const paper = this.paper;
    const ai = h('div', { class: 'ai-summary', dataset: { t: 'ai-summary' } }, h('p', { class: 'empty', text: '読み込み中…' }));
    const mine = h('textarea', { class: 'input my-summary', rows: 8, placeholder: '自分の要約・読んだ感想…（自動で保存されます）', 'aria-label': '自分の要約', dataset: { t: 'my-summary' } });
    mine.value = this.reader.rec.notes.mySummary || '';
    const save = debounce(() => {
      const notes = this.reader.rec.notes;
      if (notes.mySummary === mine.value) return;
      L.setMySummary(notes, mine.value); this.engine.touchNotes(this.reader.rec);
    }, 500);
    mine.addEventListener('input', save);
    mine.addEventListener('blur', () => save.flush());
    this.mineEl = mine;
    clear(this.bodyEl);
    this.bodyEl.append(
      h('section', { class: 'pn-sec' }, h('h3', { text: '黒コの要約' }), ai),
      h('section', { class: 'pn-sec' }, h('h3', { text: '自分の要約' }), mine));
    try {
      const text = await this.engine.getSummaryText(paper);          // 倉庫に summary_ai.md があれば hasAiSummary に関わらず出す
      clear(ai);
      if (text) ai.append(renderMarkdown(text));
      else ai.append(h('p', { class: 'empty', text: paper.hasAiSummary ? '要約を取り込み中です。少し待ってから「最新を読み込む」を押してください。' : 'まだありません（黒コに頼むと追加されます）' }));
    } catch (e) {
      clear(ai); ai.append(h('p', { class: 'empty', text: '要約を読み込めませんでした（オフラインかもしれません）。' }));
    }
  }
  syncMySummary() {
    if (this.mineEl && document.activeElement !== this.mineEl) this.mineEl.value = this.reader.rec.notes.mySummary || '';
  }

  // ---------- メモ一覧 ----------
  renderNotes() {
    const notes = this.reader.rec.notes;
    const items = [];
    for (const n of notes.notes) if (!n.deleted) items.push({ page: n.page, at: L.tsOf(n.createdAt), kind: 'note', n });
    for (const s of notes.strokes) if (!s.deleted) items.push({ page: s.page, at: L.tsOf(s.createdAt), kind: 'stroke', s });
    items.sort((a, b) => (a.page - b.page) || (a.at - b.at));
    clear(this.bodyEl);
    const nn = notes.notes.filter(n => !n.deleted).length, ns = items.length - nn;
    this.bodyEl.append(h('p', { class: 'pn-count', dataset: { t: 'notes-count' }, text: `メモ ${nn} 件・線 ${ns} 本` }));
    if (!items.length) { this.bodyEl.append(h('p', { class: 'empty', text: 'まだメモも線もありません。マーカーやメモの道具で書き込むと、ここに並びます。' })); return; }
    const list = h('ul', { class: 'note-list' });
    for (const it of items.slice(0, 400)) {
      let label, color, target;
      if (it.kind === 'note') { label = it.n.text ? it.n.text.split('\n')[0].slice(0, 80) : '（空のメモ）'; color = it.n.color; target = { page: it.n.page, x: it.n.x, y: it.n.y }; }
      else {
        const p = it.s.points; const mid = p[Math.floor(p.length / 2)] || p[0] || [0.5, 0.5];
        label = `${it.s.tool === 'marker' ? 'マーカー' : 'ペン'}（${colorName(it.s.color)}）`; color = it.s.color; target = { page: it.s.page, x: mid[0], y: mid[1] };
      }
      const dot = h('span', { class: 'dot sm' }); dot.style.setProperty('--c', color || '#ffd400');
      list.append(h('li', null, h('button', { class: 'note-item', type: 'button', dataset: { t: 'note-item', kind: it.kind }, onclick: () => this.reader.jumpTo(target) },
        h('span', { class: 'ni-page', text: `p.${it.page}` }), dot, h('span', { class: 'ni-text', text: label }))));
    }
    this.bodyEl.append(list);
    if (items.length > 400) this.bodyEl.append(h('p', { class: 'empty', text: `ほか ${items.length - 400} 件` }));
  }

  // ---------- 情報 ----------
  renderInfo() {
    const paper = this.paper, engine = this.engine, lib = engine.library;
    const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), input);
    const text = (key, label, type = 'text') => {
      const i = h('input', { class: 'input', type, value: paper[key] ?? '', dataset: { t: 'info-' + key } });
      i.addEventListener('change', () => {
        let v = i.value.trim();
        if (key === 'year') v = v ? Number(v) : null;
        engine.setField(paper.id, key, v);
      });
      return field(label, i);
    };
    const folderSel = h('select', { class: 'input', dataset: { t: 'info-folder' } }, h('option', { value: '', text: '未分類' }), lib.folders.map(f => h('option', { value: f.id, text: f.name })));
    folderSel.value = paper.folderId || '';
    folderSel.addEventListener('change', () => engine.setField(paper.id, 'folderId', folderSel.value || null));
    // タグ（v2）：チップ＋既存タグの候補。付け外しはすぐ保存の対象になる
    const tagEd = tagEditor({ engine, getTags: () => (this.paper.tags || []), onChange: tags => engine.setTags(paper.id, tags) });
    const tags = h('div', { class: 'field', dataset: { t: 'info-tags' } }, h('span', { class: 'lbl', text: 'タグ' }), tagEd.el);
    const ro = (k, v) => h('div', { class: 'ro' }, h('span', { class: 'lbl', text: k }), h('span', { class: 'val', text: v }));
    clear(this.bodyEl);
    this.bodyEl.append(h('form', { class: 'info-form', onsubmit: e => e.preventDefault() },
      text('title', '題名'), text('titleOriginal', '原題'), text('authors', '著者'), text('year', '発行年', 'number'), text('journal', '誌名'),
      field('フォルダ', folderSel), tags),
      h('div', { class: 'ro-list' },
        ro('ページ数', String(paper.pages ?? '')), ro('表示', paper.layout === 'spread' ? '見開き（左＝原文・右＝日本語）' : '1ページ'), ro('容量', L.formatBytes(paper.size)),
        ro('保存場所', paper.file || ''), ro('id', paper.id), ro('追加日', paper.addedAt ? paper.addedAt.slice(0, 10) : '')));
  }
}
