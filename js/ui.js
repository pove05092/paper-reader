// ui.js : DOM 組み立て・ダイアログ・メニュー・トースト・簡易 Markdown。本人の入力は必ず textContent 経由（HTML を通さない）。
import { randomString } from './logic.js';
export const randomId = (n = 5) => randomString(n);

/** h('div', {class:'a', onclick:fn, dataset:{t:'x'}}, '文字', node, [..]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.flush = (...a) => { if (t) { clearTimeout(t); t = null; fn(...a); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

// ---------- アイコン（自作の簡単な図柄・静的文字列のみ） ----------
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>', settings: '<path d="M4 7h8M18 7h2M4 12h2M12 12h8M4 17h9M19 17h1"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="12" r="2.2"/><circle cx="16" cy="17" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  marker: '<path d="M4 20h7M14 4l6 6-8 8-6-6 8-8z"/><path d="M6 14l4 4"/>', pen: '<path d="M4 20l1-4L17 4l3 3L8 19l-4 1z"/><path d="M14 7l3 3"/>',
  eraser: '<path d="M4 15l8-9 8 8-5 5H8z"/><path d="M9 20h11M8 11l8 8"/>', note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5M8 9h8M8 13h4"/>',
  undo: '<path d="M9 6L4 11l5 5"/><path d="M4 11h10a6 6 0 010 12"/>', redo: '<path d="M15 6l5 5-5 5"/><path d="M20 11H10a6 6 0 000 12"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>', fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', check: '<path d="M5 12l5 5 9-10"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  cloud: '<path d="M7 18a4 4 0 010-8 5 5 0 019.6-1A4.5 4.5 0 0117 18z"/>', folder: '<path d="M3 7h6l2 2h10v10H3z"/>', upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  straight: '<path d="M4 18L20 6"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="6" r="1.5"/>', pin: '<path d="M12 21s-6-6.2-6-11a6 6 0 1112 0c0 4.8-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>', eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic ' + cls); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';   // 静的な自作文字列だけ（利用者の入力は通さない）
  return s;
}

// ---------- トースト ----------
export function toast(msg, { kind = 'info', ms = 3200 } = {}) {
  const layer = document.getElementById('layer');
  let box = layer.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); layer.append(box); }
  const t = h('div', { class: 'toast ' + kind, text: msg });
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

// ---------- ダイアログ ----------
/** body は Node。actions: [{label, primary, danger, onClick(close)->void|false}] */
export function openDialog({ title, body, actions = [], wide = false, onClose, sheet = false }) {
  const layer = document.getElementById('layer');
  const back = h('div', { class: 'backdrop' });
  const titleEl = h('h2', { class: 'dlg-title', text: title || '' });
  const bodyEl = h('div', { class: 'dlg-body' }, body);
  const foot = h('div', { class: 'dlg-foot' });
  const dlg = h('div', { class: 'dialog' + (wide ? ' wide' : '') + (sheet ? ' sheet' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' }, title ? titleEl : null, bodyEl, actions.length ? foot : null);
  let closed = false;
  const close = (result) => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    back.remove(); dlg.remove();
    if (onClose) onClose(result);
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close('esc'); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('click', () => close('backdrop'));
  for (const a of actions) {
    const b = h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), type: 'button', dataset: { t: a.id || '' }, text: a.label });
    b.addEventListener('click', async () => { const r = a.onClick ? await a.onClick(close, b) : undefined; if (r !== false && !a.keepOpen) close(a.label); });
    foot.append(b);
  }
  layer.append(back, dlg);
  const first = dlg.querySelector('input, textarea, select, button.primary');
  if (first && !sheet) setTimeout(() => first.focus?.(), 30);
  return { close, el: dlg, bodyEl, foot };
}
export function confirmDialog(message, { okLabel = 'OK', cancelLabel = 'キャンセル', danger = false, title = '確認' } = {}) {
  return new Promise(res => {
    let v = false;
    openDialog({ title, body: h('p', { class: 'dlg-msg', text: message }),
      actions: [{ label: cancelLabel, id: 'cancel' }, { label: okLabel, primary: !danger, danger, id: 'ok', onClick: () => { v = true; } }], onClose: () => res(v) });
  });
}
export function alertDialog(message, { title = 'お知らせ', okLabel = '閉じる' } = {}) {
  return new Promise(res => openDialog({ title, body: h('p', { class: 'dlg-msg', text: message }), actions: [{ label: okLabel, primary: true, id: 'ok' }], onClose: () => res() }));
}
export function promptDialog({ title, label, value = '', placeholder = '', okLabel = 'OK' }) {
  return new Promise(res => {
    const input = h('input', { type: 'text', class: 'input', value, placeholder, 'aria-label': label || title, dataset: { t: 'prompt-input' } });
    let v = null;
    const submit = close => { v = input.value.trim(); close(); };
    const d = openDialog({ title, body: h('label', { class: 'field' }, label ? h('span', { class: 'lbl', text: label }) : null, input),
      actions: [{ label: 'キャンセル', id: 'cancel' }, { label: okLabel, primary: true, id: 'ok', onClick: close => { v = input.value.trim(); } }], onClose: () => res(v) });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { v = input.value.trim(); d.close(); } });
  });
}

// ---------- メニュー（⋯ ボタンの下に出す） ----------
export function openMenu(anchor, items, { align = 'right' } = {}) {
  closeMenus();
  const layer = document.getElementById('layer');
  const menu = h('div', { class: 'menu', role: 'menu' });
  const back = h('div', { class: 'menu-back' });
  const close = () => { back.remove(); menu.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.heading) { menu.append(h('div', { class: 'menu-heading', text: it.heading })); continue; }
    const b = h('button', { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''), type: 'button', role: 'menuitem', disabled: it.disabled, dataset: { t: it.id || '' } },
      it.checked ? icon('check', 'mi-check') : h('span', { class: 'mi-gap' }), h('span', { text: it.label }));
    b.addEventListener('click', () => { close(); it.onClick?.(); });
    menu.append(b);
  }
  back.addEventListener('click', close);
  layer.append(back, menu);
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = clamp(left, 8, Math.max(8, vw - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > vh - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  menu.querySelector('button:not([disabled])')?.focus?.();
  return { close };
}
export function closeMenus() { document.querySelectorAll('#layer .menu, #layer .menu-back').forEach(n => n.remove()); }

// ---------- 簡単な Markdown（HTML は一切通さない。要約の表示用） ----------
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[2] != null) frag.append(h('strong', { text: m[2] }));
    else if (m[3] != null) frag.append(h('em', { text: m[3] }));
    else if (m[4] != null) frag.append(h('code', { text: m[4] }));
    else frag.append(h('a', { href: m[6], target: '_blank', rel: 'noopener noreferrer', text: m[5] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
export function renderMarkdown(md) {
  const root = h('div', { class: 'md' });
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  let list = null, para = [];
  const flushPara = () => { if (para.length) { root.append(h('p', null, inline(para.join(' ')))); para = []; } };
  const flushList = () => { list = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flushPara(); flushList(); root.append(h('h' + Math.min(6, m[1].length + 2), null, inline(m[2]))); continue; }
    if ((m = /^\s*[-*・]\s+(.*)$/.exec(line))) { flushPara(); if (!list || list.tagName !== 'UL') { list = h('ul'); root.append(list); } list.append(h('li', null, inline(m[1]))); continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); if (!list || list.tagName !== 'OL') { list = h('ol'); root.append(list); } list.append(h('li', null, inline(m[1]))); continue; }
    if (/^※/.test(line)) { flushPara(); flushList(); root.append(h('p', { class: 'md-note' }, inline(line))); continue; }
    flushList(); para.push(line.trim());
  }
  flushPara();
  return root;
}

// ---------- 小物 ----------
export function fmtDateTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'たった今';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  return `${Math.floor(s / 3600)} 時間前`;
}
export const COLOR_NAMES = [['#ffd400', '黄'], ['#ff6fa8', 'ピンク'], ['#46d37a', '緑'], ['#4fc3f7', '水色'], ['#ff9f1c', '橙'], ['#a46bff', '紫']];
export function colorName(hex) {
  const f = COLOR_NAMES.find(c => c[0].toLowerCase() === String(hex).toLowerCase());
  return f ? f[1] : String(hex);
}
