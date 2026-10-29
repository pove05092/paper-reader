// upload.js : 論文の追加（アップロード）。ファイルを検査 → ページ数・見開き判定・サムネイル → 確認画面 → 端末内に積んで送信。仕様 §3.5。
import * as L from './logic.js';
import { h, icon, clear, openDialog, toast } from './ui.js';
import { loadPdfjs, openPdf } from './pdf.js';

export const MAX_BYTES = 95 * 1024 * 1024;          // GitHub は 100MiB 超を拒否 → 95MB 超は断る
export const WARN_BYTES = 40 * 1024 * 1024;         // 40MB 超は「スマホ回線だと重い」と注意

/** 1ページ目から幅 360px の JPEG（品質 0.75）。見開きは左半分（原文の1ページ目） */
async function makeThumb(pdf, spread) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const visW = spread ? base.width / 2 : base.width;
  const scale = 360 / visW;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = 360; canvas.height = Math.max(1, Math.round(vp.height));
  await page.render({ canvas, viewport: vp, background: 'rgb(255,255,255)' }).promise;
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.75));
  canvas.width = canvas.height = 0;
  page.cleanup();
  return blob;
}

async function analyze(file) {
  const pdf = await openPdf(file);
  try {
    const p1 = await pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 }); p1.cleanup();
    const layout = L.guessLayout(vp.width, vp.height);
    let metaTitle = '';
    try { const m = await pdf.getMetadata(); metaTitle = (m.info && m.info.Title) || ''; } catch (e) { /* メタデータ無し */ }
    const thumb = await makeThumb(pdf, layout === 'spread');
    return { pages: pdf.numPages, layout, metaTitle, thumb };
  } finally { try { await pdf.destroy(); } catch (e) { /* 無視 */ } }
}

/** files: File[]。folderHint: いま見ているフォルダ id（既定のフォルダ） */
export async function startUpload({ engine, files, folderHint = null }) {
  const pdfs = [], skipped = [];
  for (const f of files) {
    if (!(f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) { skipped.push(`${f.name}（PDF ではありません）`); continue; }
    if (f.size > MAX_BYTES) { skipped.push(`${f.name}（${L.formatBytes(f.size)}：95MB を超えるため、ここからは送れません。PC から黒コに頼んでください）`); continue; }
    if (f.size === 0) { skipped.push(`${f.name}（空のファイルです）`); continue; }
    pdfs.push(f);
  }
  if (skipped.length) toast('追加できなかったファイル：' + skipped.join(' / '), { kind: 'warn', ms: 7000 });
  if (!pdfs.length) return;

  // ---- 解析（進み具合つき）----
  const prog = h('div', { class: 'upl-prog' }, h('div', { class: 'spin' }), h('div', { class: 'msg', dataset: { t: 'upl-msg' }, text: '' }));
  const dlg0 = openDialog({ title: 'PDF を確認しています', body: prog, actions: [] });
  const taken = new Set([...engine.library.papers.map(p => p.id), ...engine.uploadIds]);
  const cands = [];
  try {
    await loadPdfjs();
    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      prog.querySelector('.msg').textContent = `${i + 1} / ${pdfs.length}　${file.name}`;
      let a;
      try { a = await analyze(file); }
      catch (e) { toast(`${file.name} を開けませんでした：${e && e.message ? e.message : e}`, { kind: 'error', ms: 7000 }); continue; }
      const parsed = L.parsePaperFilename(file.name);
      const id = L.makePaperId(file.name, taken); taken.add(id);
      const origTitle = L.looksLikeEnglishTitle(a.metaTitle) ? a.metaTitle.trim() : '';
      cands.push({ file, id, parsed, analysis: a, entry: {
        title: parsed.title, titleOriginal: origTitle, authors: parsed.authors, year: parsed.year, journal: parsed.journal, folderId: folderHint, tags: '',
      } });
    }
  } finally { dlg0.close(); }
  if (!cands.length) return;
  confirmScreen(engine, cands);
}

function confirmScreen(engine, cands) {
  const lib = engine.library;
  const blocks = cands.map((c, idx) => {
    const a = c.analysis, e = c.entry;
    const thumbUrl = URL.createObjectURL(a.thumb);
    const inp = (key, label, type = 'text', ph = '') => {
      const i = h('input', { class: 'input', type, value: e[key] ?? '', placeholder: ph, dataset: { t: 'up-' + key } });
      i.addEventListener('input', () => { e[key] = type === 'number' ? (i.value ? Number(i.value) : null) : i.value; });
      return h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), i);
    };
    const folder = h('select', { class: 'input', dataset: { t: 'up-folder' }, 'aria-label': 'フォルダ' }, h('option', { value: '', text: '未分類' }), lib.folders.map(f => h('option', { value: f.id, text: f.name })));
    folder.value = e.folderId || '';
    folder.addEventListener('change', () => { e.folderId = folder.value || null; });
    const warn = c.file.size > WARN_BYTES ? h('p', { class: 'warn', text: `${L.formatBytes(c.file.size)} あります。スマホ回線だと送信に時間がかかります（Wi-Fi 推奨）。` }) : null;
    const idInput = h('input', { class: 'input', type: 'text', value: c.id, dataset: { t: 'up-id' }, 'aria-label': 'id' });
    idInput.addEventListener('input', () => { c.idEdit = idInput.value; });
    return h('section', { class: 'up-item', dataset: { n: idx } },
      h('div', { class: 'up-head' }, h('img', { class: 'up-thumb', src: thumbUrl, alt: '' }),
        h('div', { class: 'up-facts' },
          h('div', { class: 'up-file', text: c.file.name }),
          h('div', { class: 'up-sub', dataset: { t: 'up-facts' }, text: `${a.pages} ページ・${a.layout === 'spread' ? '見開き（左＝原文・右＝日本語）' : '1ページずつ'}・${L.formatBytes(c.file.size)}` }),
          warn)),
      inp('title', '題名'), inp('titleOriginal', '原題（英文）'), inp('authors', '著者'),
      h('div', { class: 'row2' }, inp('year', '発行年', 'number'), inp('journal', '誌名')),
      h('div', { class: 'row2' }, h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'フォルダ' }), folder), inp('tags', 'タグ（カンマ区切り）')),
      h('label', { class: 'field small' }, h('span', { class: 'lbl', text: '倉庫での名前（id）' }), idInput));
  });
  const body = h('div', { class: 'up-confirm', dataset: { t: 'upload-confirm' } }, blocks);
  let sending = false;
  const d = openDialog({
    title: `${cands.length} 件を追加`, body, wide: true,
    onClose: () => { body.querySelectorAll('img.up-thumb').forEach(i => URL.revokeObjectURL(i.src)); },
    actions: [
      { label: 'キャンセル', id: 'up-cancel' },
      { label: `追加する（${cands.length} 件）`, primary: true, id: 'up-ok', onClick: async (close, btn) => {
        if (sending) return false; sending = true; btn.disabled = true;
        try {
          const taken = new Set([...engine.library.papers.map(p => p.id), ...engine.uploadIds]);
          let n = 0;
          for (const c of cands) {
            let id = (c.idEdit || c.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || c.id;
            if (taken.has(id)) id = L.uniqueId(id, taken);
            taken.add(id);
            const e = c.entry, now = L.nowIso();
            const entry = { id, title: (e.title || '').trim() || c.parsed.stem, titleOriginal: (e.titleOriginal || '').trim(), authors: (e.authors || '').trim(), year: e.year ?? null,
              journal: (e.journal || '').trim(), folderId: e.folderId || null, tags: L.parseTagInput(e.tags), status: 'unread',
              pages: c.analysis.pages, layout: c.analysis.layout, file: `papers/${id}/paper.pdf`, size: c.file.size, thumb: `papers/${id}/thumb.jpg`, hasAiSummary: false,
              addedAt: now, updatedAt: now, lastOpenedAt: null, lastPage: 1, source: 'upload:' + c.file.name };
            const job = { paperId: id, entry, createdAt: now, shas: {}, files: [
              { path: entry.file, blob: c.file }, { path: entry.thumb, blob: c.analysis.thumb }, { path: `papers/${id}/notes.json`, text: L.stringifyJson(L.emptyNotes(id)) }] };
            try { await engine.queueUpload(job, entry); n++; }
            catch (err) { toast(`「${entry.title}」を端末に保存できませんでした（空き容量を確かめてください）`, { kind: 'error', ms: 7000 }); }
          }
          if (n) { toast(`${n} 件を追加しました。まもなく倉庫へ送ります。`); engine.requestSoon(); }
        } finally { sending = false; }
      } },
    ],
  });
  return d;
}
