// tags.js : タグの画面部品（v2・2026-10-29）。タグの付け外し（チップ＋候補）・一覧の絞り込み帯・まとめて付ける・タグの管理（名前変更／統合／削除）。
// 保存の形は論文の tags 欄のまま（logic.js の「タグ」の節）。名前の変更・削除は「付いている論文の tags を書き換える」操作。本人の入力は必ず textContent 経由。
import * as L from './logic.js';
import { h, icon, clear, openDialog, confirmDialog, promptDialog, toast } from './ui.js';

const SUGGEST_MAX = 30;

/** タグを付け外しする部品。getTags()＝今のタグ・onChange(新しいタグの配列)。付けたら入力欄に残ってキーボードも出たままなので、続けて打てる */
export function tagEditor({ engine, getTags, onChange, placeholder = 'タグの名前を入力（Enter で追加）' }) {
  const chipsEl = h('div', { class: 'te-chips', dataset: { t: 'te-chips' } });
  const input = h('input', { class: 'input', type: 'text', placeholder, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'タグの名前', dataset: { t: 'te-input' } });
  const addB = h('button', { class: 'btn small primary', type: 'button', dataset: { t: 'te-add' }, onclick: () => add(input.value) }, icon('plus'), '追加');
  const sugEl = h('div', { class: 'te-suggest', dataset: { t: 'te-suggest' } });
  const el = h('div', { class: 'tag-editor', dataset: { t: 'tag-editor' } }, chipsEl, h('div', { class: 'te-add' }, input, addB), sugEl);

  function commit(next) { onChange(L.uniqueTags(next)); render(); }
  function add(raw) {
    const names = String(raw ?? '').split(/[,、，\n]/).map(s => L.canonicalTag(engine.library.papers, s)).filter(s => L.tagKey(s));
    if (!names.length) return;
    input.value = '';
    commit([...getTags(), ...names]);
    input.focus();
  }
  function render() {
    const tags = getTags();
    clear(chipsEl);
    if (!tags.length) chipsEl.append(h('span', { class: 'te-none', text: 'タグはまだ付いていません' }));
    for (const t of tags) {
      chipsEl.append(h('span', { class: 'te-pill', dataset: { t: 'te-pill', tag: t } }, h('span', { text: t }),
        h('button', { type: 'button', 'aria-label': `タグ「${t}」を外す`, dataset: { t: 'te-remove' }, onclick: () => commit(getTags().filter(x => L.tagKey(x) !== L.tagKey(t))) }, icon('close'))));
    }
    renderSuggest();
  }
  function renderSuggest() {
    clear(sugEl);
    const have = new Set(getTags().map(L.tagKey));
    const q = L.tagKey(input.value.split(/[,、，]/).pop());
    const cands = L.tagList(engine.library.papers).filter(t => !have.has(L.tagKey(t.name)) && (!q || L.tagKey(t.name).includes(q))).slice(0, SUGGEST_MAX);
    if (!cands.length) return;
    sugEl.append(h('span', { class: 'te-suggest-label', text: q ? '候補：' : '既存のタグ（押すと付きます）：' }),
      ...cands.map(t => h('button', { class: 'chip suggest', type: 'button', dataset: { t: 'te-suggest-item', tag: t.name }, onclick: () => add(t.name) }, h('span', { text: t.name }), h('span', { class: 'n', text: String(t.count) }))));
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(input.value); } });
  input.addEventListener('input', () => { if (/[,、，]$/.test(input.value)) add(input.value); else renderSuggest(); });   // 「,」「、」を打った時点でも追加
  render();
  return { el, refresh: render, input };
}

/** 1 本の論文のタグを編集するダイアログ（カードのメニュー用） */
export function openTagDialog({ engine, paperId }) {
  const paper = () => engine.library.papers.find(p => p.id === paperId);
  const p0 = paper(); if (!p0) return null;
  const ed = tagEditor({ engine, getTags: () => (paper()?.tags || []), onChange: tags => { if (paper()) engine.setTags(paperId, tags); } });
  return openDialog({ title: 'タグを編集', body: h('div', null, h('p', { class: 'dlg-sub', text: p0.title || '' }), ed.el), actions: [{ label: '閉じる', primary: true, id: 'close' }] });
}

/** 絞り込みの帯（ライブラリ）。tags＝tagList の結果・selected＝選んだタグ名の配列 */
export function fillTagBar(host, { tags, selected, onToggle, onClear, onManage }) {
  clear(host);
  const sel = new Set(selected.map(L.tagKey));
  host.append(h('span', { class: 'tb-label', text: 'タグ' }));
  if (selected.length) host.append(h('button', { class: 'chip clear', type: 'button', dataset: { t: 'tag-clear' }, onclick: onClear }, '解除'));    // 狭い画面でも見えるよう、先頭に置く
  if (!tags.length) host.append(h('span', { class: 'tb-hint', text: 'まだありません。カードの「⋯」→「タグを編集」で付けられます' }));
  for (const t of tags) {
    const on = sel.has(L.tagKey(t.name));
    host.append(h('button', { class: 'chip tagchip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), dataset: { t: 'tagchip', tag: t.name }, onclick: () => onToggle(t.name) },
      h('span', { text: t.name }), h('span', { class: 'n', text: String(t.count) })));
  }
  host.append(h('button', { class: 'chip manage', type: 'button', dataset: { t: 'tag-manage' }, onclick: onManage }, '管理'));
}

/** 選んだ論文に、まとめてタグを付ける／外す。押すたびにすぐ反映 */
export function openBulkTagDialog({ engine, ids }) {
  const body = h('div', { class: 'bulk-tags' });
  const papers = () => engine.library.papers.filter(p => ids.includes(p.id));
  const input = h('input', { class: 'input', type: 'text', placeholder: '付けるタグの名前（Enter で追加）', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': '付けるタグの名前', dataset: { t: 'bulk-input' } });
  const addNamed = raw => {
    const names = String(raw ?? '').split(/[,、，\n]/).map(s => L.cleanTag(s)).filter(Boolean);
    let n = 0; for (const name of names) n += engine.applyTagChanges(L.addTagChanges(engine.library.papers, ids, name));
    input.value = ''; fill(); input.focus(); if (names.length) toast(n ? `${names.join('・')} を ${n} 件に付けました` : '全部にもう付いています');
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addNamed(input.value); } });
  function fill() {
    clear(body);
    const mine = L.tagList(papers()), all = L.tagList(engine.library.papers);
    body.append(h('p', { class: 'dlg-sub', text: `${ids.length} 件を選んでいます` }),
      h('div', { class: 'te-add' }, input, h('button', { class: 'btn small primary', type: 'button', dataset: { t: 'bulk-add' }, onclick: () => addNamed(input.value) }, icon('plus'), '付ける')));
    const cands = all.filter(t => papers().some(p => !L.hasTag(p, t.name))).slice(0, SUGGEST_MAX);     // 選んだ論文のどれかに、まだ付いていないタグ
    if (cands.length) body.append(h('div', { class: 'te-suggest' }, h('span', { class: 'te-suggest-label', text: '既存のタグを付ける（全部に付きます）：' }),
      ...cands.map(t => h('button', { class: 'chip suggest', type: 'button', dataset: { t: 'bulk-suggest', tag: t.name }, onclick: () => addNamed(t.name) }, h('span', { text: t.name })))));
    if (mine.length) body.append(h('div', { class: 'te-suggest' }, h('span', { class: 'te-suggest-label', text: '付いているタグを外す（選んだ全部から外れます）：' }),
      ...mine.map(t => h('button', { class: 'chip suggest rm', type: 'button', dataset: { t: 'bulk-remove', tag: t.name }, onclick: () => {
        const n = engine.applyTagChanges(L.removeTagChanges(engine.library.papers, ids, t.name)); fill(); toast(`${t.name} を ${n} 件から外しました`);
      } }, h('span', { text: t.name }), h('span', { class: 'n', text: `${t.count}/${ids.length}` })))));
  }
  fill();
  return openDialog({ title: 'まとめてタグ', body, actions: [{ label: '閉じる', primary: true, id: 'close' }] });
}

/** タグの管理：名前の変更（同じ名前の既存タグがあれば統合）・削除。論文自体は消えない */
export function openTagManager({ engine }) {
  const body = h('div', { class: 'tm', dataset: { t: 'tag-manager' } });
  function fill() {
    clear(body);
    const list = L.tagList(engine.library.papers);
    if (!list.length) body.append(h('p', { class: 'empty', text: 'タグはまだありません。' }));
    for (const t of list) {
      body.append(h('div', { class: 'fm-row tm-row', dataset: { tag: t.name } }, h('span', { class: 'fm-name', text: t.name }), h('span', { class: 'f-n', text: `${t.count} 件` }),
        h('button', { class: 'btn small', type: 'button', dataset: { t: 'tm-rename' }, onclick: () => rename(t) }, '名前を変える'),
        h('button', { class: 'btn small danger', type: 'button', dataset: { t: 'tm-delete' }, onclick: () => del(t) }, '削除')));
    }
  }
  async function rename(t) {
    const to = await promptDialog({ title: `タグ「${t.name}」の名前を変更`, label: '新しい名前（既にあるタグの名前にすると、まとめて一つになります）', value: t.name });
    if (to == null) return;
    const c = L.cleanTag(to); if (!c || c === t.name) return;
    const merge = L.tagKey(c) !== L.tagKey(t.name) && L.tagList(engine.library.papers).some(x => L.tagKey(x.name) === L.tagKey(c));
    if (merge && !(await confirmDialog(`「${t.name}」を、すでにあるタグ「${L.canonicalTag(engine.library.papers, c)}」にまとめます。${t.count} 件の論文のタグが付け替わります。`, { okLabel: 'まとめる', title: 'タグを統合' }))) return;
    const n = engine.applyTagChanges(L.renameTagChanges(engine.library.papers, t.name, c));
    toast(merge ? `${n} 件を統合しました` : `${n} 件のタグ名を変えました`); fill();
  }
  async function del(t) {
    if (!(await confirmDialog(`タグ「${t.name}」を、付いている ${t.count} 件の論文から外します（論文は消えません）。`, { okLabel: '削除', danger: true, title: 'タグを削除' }))) return;
    const n = engine.applyTagChanges(L.deleteTagChanges(engine.library.papers, t.name));
    toast(`${n} 件から「${t.name}」を外しました`); fill();
  }
  fill();
  return openDialog({ title: 'タグの管理', body, actions: [{ label: '閉じる', primary: true, id: 'close' }] });
}
