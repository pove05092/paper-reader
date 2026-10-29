// app.js : 入口。画面の切り替え（#/ ライブラリ、#/paper/<id> リーダー、#/settings 設定、#/welcome 歓迎）と全体の配線。
import { SyncEngine, saveSettings } from './sync.js';
import { h, clear, toast } from './ui.js';
import { createSyncPill } from './syncpill.js';
import { renderLibrary } from './library.js';
import { renderSettings, renderWelcome } from './settings.js';
import { startUpload } from './upload.js';
import { Reader } from './viewer.js';
import { nowIso } from './logic.js';

const engine = new SyncEngine();
const appEl = document.getElementById('app');
let current = null, navCount = 0, currentHash = null, routeSeq = 0;

// ---------- この端末の表示の好み（localStorage）----------
const prefs = {
  get() { try { return JSON.parse(localStorage.getItem('pr.ui') || '{}') || {}; } catch (e) { return {}; } },
  set(patch) { try { localStorage.setItem('pr.ui', JSON.stringify({ ...prefs.get(), ...patch })); } catch (e) { /* 保存できなくても動く */ } },
};

// ---------- 画面遷移 ----------
function go(hash, { replace = false } = {}) {
  if (replace) history.replaceState(history.state, '', hash);
  else { navCount++; history.pushState({ n: navCount }, '', hash); }
  route();
}
function back() { if (history.state && history.state.n > 0) history.back(); else go('#/', { replace: true }); }

async function route() {
  const hash = location.hash || '#/';
  currentHash = hash;
  const seq = ++routeSeq;
  if (current) { try { current.destroy(); } catch (e) { console.warn('[app] destroy', e); } current = null; }
  clear(appEl);
  document.title = '論文リーダー';
  const pill = () => createSyncPill(engine, { onSettings: () => go('#/settings') });

  if (hash === '#/welcome' || (!engine.configured && hash !== '#/settings')) { current = renderWelcome({ host: appEl, go }); return; }
  if (hash === '#/settings') { current = renderSettings({ engine, host: appEl, go, firstRun: !engine.configured }); return; }
  const m = /^#\/paper\/(.+)$/.exec(hash);
  if (m) { await openReader(decodeURIComponent(m[1]), seq, pill); return; }
  const p = pill();
  const lib = renderLibrary({ engine, host: appEl, go, prefs, pill: p, onFiles: (files, folderHint) => startUpload({ engine, files, folderHint }) });
  current = { destroy() { lib.destroy(); p.destroy(); } };
}

async function openReader(id, seq, makePill) {
  let paper = engine.library.papers.find(p => p.id === id);
  if (!paper && engine.configured) {
    appEl.append(h('div', { class: 'boot', text: '倉庫を確認しています…' }));
    await engine.refresh();
    if (seq !== routeSeq) return;
    clear(appEl);
    paper = engine.library.papers.find(p => p.id === id);
  }
  if (!paper) { toast('その論文が見つかりません', { kind: 'warn' }); go('#/', { replace: true }); return; }
  const pill = makePill();
  const reader = new Reader({ engine, paper, prefs, syncPill: pill.el, onBack: back, onRetry: () => route(),
    onSettingsChange: () => saveSettings(engine.settings) });
  reader.mount(appEl);
  window.__pr.reader = reader;
  document.title = `${paper.title} - 論文リーダー`;
  current = {
    destroy() {
      const ok = reader.pages.length > 0;
      const last = ok ? reader.currentPage() : null;
      reader.destroy(); pill.destroy();
      if (window.__pr.reader === reader) window.__pr.reader = null;
      if (ok) {
        engine.setField(id, 'lastPage', last, { silent: true });
        engine.flushLocal();
        engine.schedule(true);                       // 論文を閉じる時はすぐ送る（仕様 §4.4）
      }
    },
  };
  // 開いた記録（最近開いた順のため）。送るのは閉じる時にまとめて。（v3：開いたら「読書中」にする自動の状態変更はやめた）
  engine.setField(id, 'lastOpenedAt', nowIso(), { silent: true });
  await reader.load();
}

// ---------- 起動 ----------
window.__pr = { engine, reader: null, prefs, go, get hash() { return currentHash; } };   // 画面外からの状態確認用（トークンは持たない）
async function main() {
  engine.addEventListener('upload-failed', e => toast(`「${e.detail.title || e.detail.paperId}」は送れませんでした：${e.detail.message}`, { kind: 'error', ms: 9000 }));
  engine.addEventListener('storage-error', () => toast('この端末に保存できませんでした（空き容量を確かめてください）', { kind: 'error', ms: 7000 }));
  const told = new Set();
  engine.addEventListener('problem', e => {
    const err = e.detail;
    if (err && err.fatal && !told.has(err.kind)) { told.add(err.kind); toast(err.message, { kind: 'error', ms: 9000 }); }
    if (err && err.kind === 'rate') toast(err.message, { kind: 'warn', ms: 6000 });
  });
  engine.addEventListener('committed', e => { if (e.detail.parts.some(p => p.startsWith('upload:'))) toast('アップロードが完了しました'); });
  await engine.init();
  engine.attachWindowEvents();
  window.addEventListener('popstate', () => { navCount = (history.state && history.state.n) || 0; route(); });
  window.addEventListener('hashchange', () => { if ((location.hash || '#/') !== currentHash) route(); });
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('[app] sw の登録に失敗', e && e.message); }
  }
  await route();
  document.documentElement.dataset.ready = '1';
}
main().catch(e => {
  console.error('[app] 起動に失敗', e);
  appEl.textContent = '起動に失敗しました：' + (e && e.message ? e.message : e);
});
