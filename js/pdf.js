// pdf.js : 同梱した pdf.js（pdfjs-dist）を読み込む入口。実行時に CDN は使わない。worker・cmaps・標準フォント・wasm もすべて同梱分を指す。
let lib = null;
export async function loadPdfjs() {
  if (lib) return lib;
  lib = await import('../vendor/pdfjs/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  return lib;
}
function docOptions() {
  const base = new URL('../vendor/pdfjs/', import.meta.url).href;
  return { cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/', verbosity: 0 };
}
/** Blob から PDF を開く（データは worker へ渡して手元には残さない。Blob は呼び出し側が持つ） */
export async function openPdf(blob) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data, ...docOptions() }).promise;
}
/** 文字層の倍率（PDF の 1pt を何 px で作るか）。大きめに作って CSS の変形で縮めると、小さい文字でも幅の合わせが崩れにくい */
export const TEXT_SCALE = 2;
/** 文字層（透明な文字）を作る準備。ページの全面（見開きなら両側）を倍率 TEXT_SCALE で作り、表示の倍率・半分表示は呼び出し側が CSS の変形で合わせる。
 *  返す layer の render() を呼ぶと container に span が並ぶ（途中で捨てる時は layer.cancel()）。width・height は倍率 1（PDF の pt） */
export async function makeTextLayer(page, container) {
  const pdfjs = await loadPdfjs();
  const viewport = page.getViewport({ scale: TEXT_SCALE });
  const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
  return { layer, width: viewport.width / TEXT_SCALE, height: viewport.height / TEXT_SCALE };
}
export const isCancelled = e => !!e && (e.name === 'RenderingCancelledException' || /cancel/i.test(String(e.message || '')));
