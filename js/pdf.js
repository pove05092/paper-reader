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
export const isCancelled = e => !!e && (e.name === 'RenderingCancelledException' || /cancel/i.test(String(e.message || '')));
