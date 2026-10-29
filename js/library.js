// library.js : ライブラリ（ホーム）。フォルダ・絞り込み・並べ替え・カード・複数選択・追加。仕様 §3.1。
import * as L from './logic.js';
import { h, icon, clear, debounce, openMenu, openDialog, confirmDialog, promptDialog, toast, randomId } from './ui.js';
import * as T from './tags.js';

// v3：「未読・読書中・読了」の状態は画面から外した（本人「要素としてなくていい。タグを自分で作るので」）。論文データの status 欄は触らず残す（読まない・書かない）
const SORTS = [['recent', '最近開いた'], ['added', '追加日'], ['year', '発行年'], ['title', '題名']];

export function renderLibrary({ engine, host, go, prefs, pill, onFiles }) {
  const saved = prefs.get().lib || {};
  const ui = { folder: saved.folder || 'all', sort: saved.sort || 'recent', tags: Array.isArray(saved.tags) ? saved.tags : [], q: '', selecting: false, selected: new Set() };
  const persist = () => prefs.set({ lib: { folder: ui.folder, sort: ui.sort, tags: ui.tags } });
  const filterOpts = () => ({ folder: ui.folder, q: ui.q, tags: ui.tags });
  let destroyed = false, cached = new Set(), gridSig = '';

  // ---------- 骨組み ----------
  const search = h('input', { class: 'input search', type: 'search', placeholder: '題名・著者・誌名・タグ・年で検索', 'aria-label': '検索', dataset: { t: 'search' } });
  search.addEventListener('input', debounce(() => { ui.q = search.value; renderGrid(); }, 120));
  const settingsB = h('button', { class: 'btn icon plain', type: 'button', 'aria-label': '設定', dataset: { t: 'open-settings' }, onclick: () => go('#/settings') }, icon('settings'));
  const topEl = h('header', { class: 'lib-top' }, h('h1', { class: 'app-name', text: '論文リーダー' }), h('div', { class: 'search-wrap' }, icon('search'), search), pill.el, settingsB);
  const folderEl = h('nav', { class: 'folders', 'aria-label': 'フォルダ', dataset: { t: 'folders' } });
  const toolsEl = h('div', { class: 'lib-tools' });
  const tagbarEl = h('div', { class: 'tagbar', role: 'group', 'aria-label': 'タグで絞り込み', dataset: { t: 'tagbar' } });
  const bannerEl = h('div', { class: 'banner', hidden: true, dataset: { t: 'banner' } });
  const gridEl = h('div', { class: 'grid', dataset: { t: 'grid' } });
  const selBar = h('div', { class: 'selbar', hidden: true, dataset: { t: 'selbar' } });
  const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true, dataset: { t: 'file-input' } });
  fileInput.addEventListener('change', () => { const f = [...fileInput.files]; fileInput.value = ''; if (f.length) onFiles(f, ui.folder !== 'all' && ui.folder !== 'none' ? ui.folder : null); });
  const fab = h('button', { class: 'fab', type: 'button', 'aria-label': '論文を追加', dataset: { t: 'add-fab' }, onclick: () => fileInput.click() }, icon('plus'), h('span', { text: '論文を追加' }));
  const mainEl = h('main', { class: 'lib-main' }, toolsEl, tagbarEl, bannerEl, gridEl);
  const root = h('div', { class: 'library' }, topEl, h('div', { class: 'lib-body' }, folderEl, mainEl), selBar, fab, fileInput);
  host.append(root);

  // ---------- フォルダ ----------
  function renderFolders() {
    const lib = engine.library, counts = L.folderCounts(lib);
    if (ui.folder !== 'all' && ui.folder !== 'none' && !lib.folders.some(f => f.id === ui.folder)) ui.folder = 'all';
    clear(folderEl);
    const item = (id, label, n) => h('button', { class: 'folder' + (ui.folder === id ? ' on' : ''), type: 'button', dataset: { t: 'folder', f: id }, 'aria-current': ui.folder === id ? 'true' : null,
      onclick: () => { ui.folder = id; persist(); renderFolders(); renderGrid(); } }, h('span', { class: 'f-name', text: label }), h('span', { class: 'f-n', text: String(n) }));
    folderEl.append(item('all', 'すべて', counts.all), item('none', '未分類', counts.none));
    for (const f of [...lib.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) folderEl.append(item(f.id, f.name, counts[f.id] ?? 0));
    folderEl.append(h('button', { class: 'folder add', type: 'button', dataset: { t: 'folder-manage' }, onclick: () => manageFolders() }, icon('folder'), h('span', { class: 'f-name', text: 'フォルダを編集' })));
  }

  // ---------- タグの絞り込み帯（v2）：押すとそのタグの論文だけ。複数押すと、全部に当てはまるものだけ ----------
  function renderTagBar() {
    const tags = L.tagList(engine.library.papers), keys = new Set(tags.map(t => L.tagKey(t.name)));
    const kept = ui.tags.filter(t => keys.has(L.tagKey(t)));
    if (kept.length !== ui.tags.length) { ui.tags = kept; persist(); }                          // 消えたタグで絞り込んだままにしない
    T.fillTagBar(tagbarEl, { tags, selected: ui.tags,
      onToggle: name => { ui.tags = ui.tags.some(t => L.tagKey(t) === L.tagKey(name)) ? ui.tags.filter(t => L.tagKey(t) !== L.tagKey(name)) : [...ui.tags, name]; persist(); renderTagBar(); renderGrid(); },
      onClear: () => { ui.tags = []; persist(); renderTagBar(); renderGrid(); },
      onManage: () => T.openTagManager({ engine }) });
  }

  // ---------- 道具（絞り込み・並べ替え・選択・追加） ----------
  function renderTools() {
    clear(toolsEl);
    const sort = h('select', { class: 'input sort', 'aria-label': '並べ替え', dataset: { t: 'sort' } }, SORTS.map(([v, l]) => h('option', { value: v, text: '並べ替え：' + l })));
    sort.value = ui.sort;
    sort.addEventListener('change', () => { ui.sort = sort.value; persist(); renderGrid(); });
    const selB = h('button', { class: 'btn small' + (ui.selecting ? ' primary' : ''), type: 'button', dataset: { t: 'select-toggle' }, 'aria-pressed': String(ui.selecting),
      onclick: () => { ui.selecting = !ui.selecting; ui.selected.clear(); renderTools(); renderGrid(); renderSelBar(); } }, icon('check'), ui.selecting ? '選択を終える' : '選択');
    const addB = h('button', { class: 'btn primary small add-btn', type: 'button', dataset: { t: 'add-paper' }, onclick: () => fileInput.click() }, icon('plus'), '論文を追加');
    toolsEl.append(h('span', { class: 'sp' }), sort, selB, addB);
  }

  // ---------- カード ----------
  function makeCard(p) {
    const img = h('img', { class: 'thumb-img', alt: '', decoding: 'async', draggable: 'false' });
    img.hidden = true;
    const ph = h('div', { class: 'thumb-ph' }, icon('folder'));
    engine.thumbUrl(p).then(u => { if (u && !destroyed) { img.src = u; img.hidden = false; ph.hidden = true; } }).catch(() => {});
    const prog = p.pages ? Math.min(100, Math.round(((p.lastPage || 1) / p.pages) * 100)) : 0;
    const pending = engine.uploadIds.has(p.id);
    const meta = [p.authors, p.year].filter(Boolean).join('・');
    const bar = h('div', { class: 'progress', title: `${p.lastPage || 1} / ${p.pages ?? '?'}` }, h('div', { class: 'fill' }));
    bar.firstChild.style.width = prog + '%';
    const main = h('button', { class: 'card-main', type: 'button', dataset: { t: 'card', id: p.id }, 'aria-label': p.title,
      onclick: () => { if (ui.selecting) toggleSel(p.id); else go('#/paper/' + encodeURIComponent(p.id)); } },
      h('div', { class: 'thumb' }, ph, img),
      h('div', { class: 'info' },
        h('div', { class: 'c-title', text: p.title || '(題名なし)' }),
        h('div', { class: 'c-meta', text: meta }),
        p.journal ? h('div', { class: 'c-journal', text: p.journal }) : null,
        (p.tags && p.tags.length) ? h('div', { class: 'c-tags' }, p.tags.map(t => h('span', { class: 'tag', text: t }))) : null,
        h('div', { class: 'c-row' }, p.hasAiSummary ? h('span', { class: 'badge sum', text: '要約あり' }) : null, pending ? h('span', { class: 'badge pend', text: '未送信' }) : null, h('span', { class: 'badge saved', hidden: !cached.has(engine.base?.files[p.file]?.sha) && !pending, dataset: { saved: p.id }, text: '端末に保存済み' })),
        bar));
    const menuB = h('button', { class: 'card-menu', type: 'button', 'aria-label': 'メニュー', dataset: { t: 'card-menu', id: p.id }, onclick: e => { e.stopPropagation(); cardMenu(e.currentTarget, p); } }, icon('more'));
    const check = h('span', { class: 'card-check', 'aria-hidden': 'true' }, icon('check'));
    return h('article', { class: 'card' + (ui.selected.has(p.id) ? ' sel' : '') + (ui.selecting ? ' selecting' : ''), dataset: { id: p.id } }, main, menuB, check);
  }
  async function renderGrid() {
    if (destroyed) return;
    const lib = engine.library;
    try { cached = await engine.cachedShaSet(); } catch (e) { cached = new Set(); }
    const list = L.sortPapers(L.filterPapers(lib.papers, filterOpts()), ui.sort);
    // 見える内容が前回と同じなら描き直さない（描き直すと、押そうとしたカードが指の下で入れ替わりうる）
    const sig = JSON.stringify([engine.configured, !!engine.base, engine.err ? engine.err.message : null, ui.selecting, [...ui.selected].sort(), lib.papers.length,
      list.map(p => [p, cached.has(engine.base?.files[p.file]?.sha), engine.uploadIds.has(p.id)])]);
    if (sig === gridSig && gridEl.childElementCount) { renderSelBar(); return; }
    gridSig = sig;
    clear(gridEl);
    if (!list.length && engine.configured && !engine.base && engine.err) {            // 倉庫を一度も読めていない：理由と「もう一度」を出す
      gridEl.append(h('div', { class: 'empty-state', dataset: { t: 'empty' } },
        h('p', { class: 'big', text: '倉庫に接続できませんでした' }),
        h('p', { dataset: { t: 'empty-reason' }, text: engine.err.message }),
        h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', { class: 'btn primary', type: 'button', dataset: { t: 'retry-load' }, onclick: () => { engine.err = null; engine.setStatus(); engine.refresh(); renderGrid(); } }, 'もう一度'),
          h('button', { class: 'btn', type: 'button', onclick: () => go('#/settings') }, '設定を開く'))));
    } else if (!list.length) {
      const loading = engine.configured && !engine.base && !engine.err;
      gridEl.append(h('div', { class: 'empty-state', dataset: { t: 'empty' } },
        h('p', { class: 'big', text: loading ? '倉庫を読み込み中…' : lib.papers.length ? '条件に合う論文がありません' : 'まだ論文がありません' }),
        loading ? null : h('p', { text: lib.papers.length ? '検索や絞り込みを変えてみてください。' : '「論文を追加」から左右対訳 PDF を入れてください。母艦の取り込みで入れた論文も、ここに出ます。' })));
    } else gridEl.append(...list.map(makeCard));
    renderSelBar();
  }
  function toggleSel(id) {
    if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
    const el = gridEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`); if (el) el.classList.toggle('sel', ui.selected.has(id));
    renderSelBar();
  }
  function renderSelBar() {
    selBar.hidden = !ui.selecting;
    root.classList.toggle('selecting', ui.selecting);
    if (!ui.selecting) return;
    clear(selBar);
    const n = ui.selected.size;
    const visible = () => L.filterPapers(engine.library.papers, filterOpts());
    selBar.append(
      h('span', { class: 'sel-n', dataset: { t: 'sel-count' }, text: `${n} 件選択` }),
      h('button', { class: 'btn small', type: 'button', onclick: () => { for (const p of visible()) ui.selected.add(p.id); renderGrid(); }, dataset: { t: 'sel-all' } }, '全部'),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn small', type: 'button', disabled: !n, dataset: { t: 'sel-move' }, onclick: async () => {
        const fid = await pickFolder({ title: `${n} 件をフォルダへ移動`, current: undefined });
        if (fid === undefined) return;
        for (const id of ui.selected) engine.setField(id, 'folderId', fid);
        toast(`${n} 件を移動しました`); ui.selected.clear(); ui.selecting = false; renderTools(); renderGrid();
      } }, icon('folder'), 'まとめて移動'),
      h('button', { class: 'btn small', type: 'button', disabled: !n, dataset: { t: 'sel-tags' }, onclick: () => T.openBulkTagDialog({ engine, ids: [...ui.selected] }) }, icon('plus'), 'まとめてタグ'));
  }

  // ---------- カードのメニュー ----------
  function cardMenu(anchor, p) {
    const sha = engine.base?.files[p.file]?.sha;
    openMenu(anchor, [
      { label: 'フォルダへ移動…', id: 'm-move', onClick: async () => { const fid = await pickFolder({ title: 'フォルダへ移動', current: p.folderId || null }); if (fid !== undefined) { engine.setField(p.id, 'folderId', fid); renderFolders(); } } },
      { label: 'タグを編集…', id: 'm-tags', onClick: () => T.openTagDialog({ engine, paperId: p.id }) },
      { sep: true },
      { label: '情報の編集…', id: 'm-info', onClick: () => editInfo(p) },
      { label: 'この端末から削除（キャッシュ）', id: 'm-cache', disabled: !sha || !cached.has(sha), onClick: async () => { await engine.dropCache(p); toast('この端末の保存を消しました（倉庫には残っています）'); renderGrid(); } },
      { label: '倉庫から削除…', id: 'm-delete', danger: true, onClick: async () => {
        const ok = await confirmDialog(`「${p.title}」を倉庫から削除します。PDF・マーカー・メモ・要約がすべて消えます。この操作は元に戻せません。`, { okLabel: '倉庫から削除', danger: true, title: '倉庫から削除' });
        if (ok) { await engine.removePaper(p.id); toast('削除を予約しました（次の送信で倉庫から消えます）'); }
      } },
    ]);
  }
  function editInfo(p) {
    const f = (label, key, type = 'text') => { const i = h('input', { class: 'input', type, value: p[key] ?? '', dataset: { t: 'edit-' + key } }); return { i, el: h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), i) }; };
    const fs = { title: f('題名', 'title'), titleOriginal: f('原題', 'titleOriginal'), authors: f('著者', 'authors'), year: f('発行年', 'year', 'number'), journal: f('誌名', 'journal') };
    openDialog({ title: '情報の編集', body: h('div', { class: 'form' }, Object.values(fs).map(x => x.el)), actions: [{ label: 'キャンセル' }, { label: '保存', primary: true, id: 'save', onClick: () => {
      for (const [k, x] of Object.entries(fs)) {
        let v = x.i.value.trim(); if (k === 'year') v = v ? Number(v) : null;
        if (v !== (p[k] ?? (k === 'year' ? null : ''))) engine.setField(p.id, k, v);
      }
    } }] });
  }

  // ---------- フォルダの選択・管理 ----------
  /** 返り値: フォルダ id／null（未分類）／undefined（取り消し） */
  function pickFolder({ title, current }) {
    return new Promise(res => {
      let chosen; const lib = engine.library;
      const list = h('div', { class: 'pick-list', role: 'listbox' });
      const mk = (id, label) => h('button', { class: 'pick' + (current === id ? ' cur' : ''), type: 'button', role: 'option', dataset: { t: 'pick-folder', f: id ?? 'none' },
        onclick: () => { chosen = id; d.close(); } }, icon('folder'), h('span', { text: label }));
      list.append(mk(null, '未分類'), ...[...lib.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(f => mk(f.id, f.name)));
      const input = h('input', { class: 'input', type: 'text', placeholder: '新しいフォルダの名前', dataset: { t: 'pick-new-name' }, 'aria-label': '新しいフォルダの名前' });
      const addB = h('button', { class: 'btn small', type: 'button', dataset: { t: 'pick-new' }, onclick: () => {
        const name = input.value.trim(); if (!name) return;
        const id = 'f-' + randomId(5);
        engine.patch({ op: 'addFolder', folder: { id, name } });
        chosen = id; d.close();
      } }, icon('plus'), '作って移動');
      const d = openDialog({ title, body: h('div', null, list, h('div', { class: 'pick-new' }, input, addB)), actions: [{ label: 'キャンセル', id: 'cancel' }], onClose: () => res(chosen) });
    });
  }
  function manageFolders() {
    const body = h('div', { class: 'fm' });
    const fill = () => {
      clear(body);
      const lib = engine.library, counts = L.folderCounts(lib);
      for (const f of [...lib.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        body.append(h('div', { class: 'fm-row', dataset: { f: f.id } }, h('span', { class: 'fm-name', text: f.name }), h('span', { class: 'f-n', text: String(counts[f.id] ?? 0) }),
          h('button', { class: 'btn small', type: 'button', dataset: { t: 'fm-rename' }, onclick: async () => { const n = await promptDialog({ title: 'フォルダ名を変更', label: '名前', value: f.name }); if (n) { engine.patch({ op: 'renameFolder', id: f.id, name: n }); fill(); } } }, '名前を変える'),
          h('button', { class: 'btn small danger', type: 'button', dataset: { t: 'fm-delete' }, onclick: async () => {
            const ok = await confirmDialog(`フォルダ「${f.name}」を削除します。中の ${counts[f.id] ?? 0} 件は「未分類」になります（論文は消えません）。`, { okLabel: '削除', danger: true });
            if (ok) { engine.patch({ op: 'deleteFolder', id: f.id }); fill(); }
          } }, '削除')));
      }
      if (!lib.folders.length) body.append(h('p', { class: 'empty', text: 'フォルダはまだありません。' }));
      const input = h('input', { class: 'input', type: 'text', placeholder: '新しいフォルダの名前', dataset: { t: 'fm-new-name' }, 'aria-label': '新しいフォルダの名前' });
      const add = () => { const n = input.value.trim(); if (!n) return; engine.patch({ op: 'addFolder', folder: { id: 'f-' + randomId(5), name: n } }); fill(); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) add(); });
      body.append(h('div', { class: 'pick-new' }, input, h('button', { class: 'btn small primary', type: 'button', dataset: { t: 'fm-add' }, onclick: add }, icon('plus'), '追加')));
    };
    fill();
    openDialog({ title: 'フォルダを編集', body, actions: [{ label: '閉じる', primary: true, id: 'close' }] });
  }

  // ---------- 通知（アップロード中などの帯）----------
  function renderBanner() {
    const s = engine.status;
    const txt = s.kind === 'sending' && s.progress ? s.progress.text : null;
    bannerEl.hidden = !txt; bannerEl.textContent = txt || '';
  }

  // ---------- イベント ----------
  const rerender = debounce(() => { renderFolders(); renderTagBar(); renderGrid(); }, 60);
  const onLib = () => rerender();
  const onStatus = () => { renderBanner(); if (!engine.base) rerender(); };      // 倉庫をまだ読めていない間は、状態の変化（読み込み中→エラー）に合わせて描き直す
  const onCache = () => { rerender(); };
  engine.addEventListener('library', onLib); engine.addEventListener('status', onStatus); engine.addEventListener('cache', onCache);
  renderFolders(); renderTools(); renderTagBar(); renderGrid(); renderBanner();
  return {
    destroy() { destroyed = true; engine.removeEventListener('library', onLib); engine.removeEventListener('status', onStatus); engine.removeEventListener('cache', onCache); rerender.cancel(); root.remove(); },
  };
}
