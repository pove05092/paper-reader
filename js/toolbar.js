// toolbar.js : 書き込みの道具のバー（PC は上、スマホは親指の届く下側）。色・太さ・まっすぐ・元に戻す/やり直す。
import { h, icon } from './ui.js';
import { PALETTE } from './ink.js';

const TOOLS = [['move', '移動', 'move'], ['marker', 'マーカー', 'marker'], ['pen', 'ペン', 'pen'], ['eraser', '消しゴム', 'eraser'], ['note', 'メモ', 'note']];
const SIZE_LABEL = { thin: '細', mid: '中', thick: '太' };

export function buildToolbar(reader, ink) {
  const toolBtns = TOOLS.map(([id, label, ic]) => h('button', { class: 'tool', type: 'button', dataset: { t: 'tool-' + id, tool: id }, 'aria-label': label, 'aria-pressed': 'false',
    onclick: () => ink.setTool(id) }, icon(ic), h('span', { class: 'tl', text: label })));
  const undoB = h('button', { class: 'tool small', type: 'button', dataset: { t: 'undo' }, 'aria-label': '元に戻す', onclick: () => ink.undo() }, icon('undo'), h('span', { class: 'tl', text: '戻す' }));
  const redoB = h('button', { class: 'tool small', type: 'button', dataset: { t: 'redo' }, 'aria-label': 'やり直す', onclick: () => ink.redo() }, icon('redo'), h('span', { class: 'tl', text: '進む' }));

  const dots = PALETTE.map(([hex, name]) => {
    const b = h('button', { class: 'dot', type: 'button', title: name, 'aria-label': name, 'aria-pressed': 'false', dataset: { t: 'color', c: hex }, onclick: () => ink.setColor(hex) });
    b.style.setProperty('--c', hex);
    return b;
  });
  const custom = h('input', { type: 'color', class: 'dot custom', title: '自由な色', 'aria-label': '自由な色', dataset: { t: 'color-custom' }, value: ink.color });
  custom.addEventListener('input', () => ink.setColor(custom.value));
  const colors = h('div', { class: 'colors', role: 'group', 'aria-label': '色' }, dots, custom);

  const sizeBtns = ['thin', 'mid', 'thick'].map(s => h('button', { class: 'seg-b', type: 'button', dataset: { t: 'size-' + s, size: s }, 'aria-pressed': 'false',
    onclick: () => ink.setSize(ink.tool === 'pen' ? 'pen' : 'marker', s) }, SIZE_LABEL[s]));
  const sizes = h('div', { class: 'seg widths', role: 'group', 'aria-label': '太さ' }, sizeBtns);
  const straight = h('button', { class: 'chip', type: 'button', dataset: { t: 'straight' }, 'aria-pressed': 'false', onclick: () => ink.setStraight(!ink.straight) }, icon('straight'), 'まっすぐ');

  const opts = h('div', { class: 'opts' }, colors, sizes, straight);
  const bar = h('div', { class: 'tools' }, toolBtns, h('span', { class: 'sp' }), undoB, redoB);
  const el = h('div', { class: 'rd-tools', role: 'toolbar', 'aria-label': '書き込みの道具' }, opts, bar);

  function sync() {
    const t = ink.tool;
    for (const b of toolBtns) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    el.dataset.tool = t;
    const sizeTool = t === 'pen' ? 'pen' : 'marker';
    for (const b of sizeBtns) b.setAttribute('aria-pressed', String(b.dataset.size === ink.size[sizeTool]));
    for (const d of dots) d.setAttribute('aria-pressed', String(d.dataset.c.toLowerCase() === ink.color.toLowerCase()));
    custom.value = /^#[0-9a-f]{6}$/i.test(ink.color) ? ink.color : '#ffd400';
    custom.classList.toggle('on', !PALETTE.some(p => p[0].toLowerCase() === ink.color.toLowerCase()));
    straight.setAttribute('aria-pressed', String(ink.straight));
    undoB.disabled = !ink.canUndo(); redoB.disabled = !ink.canRedo();
    opts.hidden = !(t === 'marker' || t === 'pen' || t === 'note');
    sizes.hidden = !(t === 'marker' || t === 'pen');
    straight.hidden = !(t === 'marker' || t === 'pen');
  }
  ink.onChange(w => { if (w === 'tool' || w === 'prefs' || w === 'undo') sync(); if (w === 'prefs') reader.savePrefs(); });
  sync();
  return { el, sync };
}
