// textsel.js : 文字層（透明な文字）を紙面に重ねて、普通のサイトのように文字を選択・コピーできるようにする（v4）。
//  - 文字は PDF にもともと入っている文字データ（pdf.js の TextLayer が透明な span に起こす）。画面に見えるのは選択の色だけ。
//  - ページの空白の上までドラッグした時に、選択が別の場所へ飛ばないよう「.endOfContent」を選択の端のすぐ隣へ動かす
//    （pdf.js 本家 web/text_layer_builder.js と同じ考え方。Firefox と Chromium 148 以降では不要＝本家もそこでは何もしない）。
//  - 文字層ごとに登録して、全部外れたらイベントも外す。
const layers = new Map();          // .textLayer の div → その中の .endOfContent
let abort = null;

const reset = (end, layer) => {
  layer.append(end);
  end.style.width = ''; end.style.height = ''; end.style.userSelect = '';
  layer.classList.remove('selecting');
};
export function resetTextSelectionState() { layers.forEach(reset); }
/** 選択を消す（道具を切り替える時・ページの空白を押した時） */
export function clearSelection() {
  try { window.getSelection()?.removeAllRanges(); } catch (e) { /* 無視 */ }
  resetTextSelectionState();
}

export function registerTextLayer(layer, end) {
  layers.set(layer, end);
  layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
  install();
}
export function unregisterTextLayer(layer) {
  layers.delete(layer);
  if (!layers.size && abort) { abort.abort(); abort = null; }
}

function install() {
  if (abort) return;
  abort = new AbortController();
  const { signal } = abort;
  let isPointerDown = false, prevRange = null, needsEndMove;
  document.addEventListener('pointerdown', () => { isPointerDown = true; }, { signal });
  document.addEventListener('pointerup', () => { isPointerDown = false; layers.forEach(reset); }, { signal });
  window.addEventListener('blur', () => { isPointerDown = false; layers.forEach(reset); }, { signal });
  document.addEventListener('keyup', () => { if (!isPointerDown) layers.forEach(reset); }, { signal });
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) { layers.forEach(reset); return; }
    const active = new Set();
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      if (range.collapsed && !isPointerDown) continue;              // クリックの selectionchange は pointerup の後に届くことがある。その空の範囲で selecting を戻さない
      for (const div of layers.keys()) if (!active.has(div) && range.intersectsNode(div)) active.add(div);
    }
    for (const [div, end] of layers) { if (active.has(div)) div.classList.add('selecting'); else reset(end, div); }
    needsEndMove ??= (() => {
      if (getComputedStyle(layers.values().next().value).getPropertyValue('-moz-user-select') === 'none') return false;        // Firefox
      const v = /Chrome\/(\d+)/.exec(navigator.userAgent);
      return !(v && parseInt(v[1], 10) >= 148);                                                                                  // Chromium 148 以降は不要
    })();
    if (!needsEndMove) return;
    // それ以外のブラウザ：空白の上に来ると選択が .endOfContent まで広がる。.endOfContent を選択の端の隣に置いて、広がり方を 1 つの span の範囲に抑える
    const range = sel.getRangeAt(0);
    const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0) {
      do {
        while (!anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor.previousSibling;
      } while (!anchor.childNodes.length);
    }
    const layer = anchor.parentElement && anchor.parentElement.closest('.textLayer');
    const end = layers.get(layer);
    if (end) {
      end.style.width = layer.style.width; end.style.height = layer.style.height; end.style.userSelect = 'text';
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    prevRange = range.cloneRange();
  }, { signal });
}
