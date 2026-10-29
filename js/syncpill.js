// syncpill.js : 同期状態の表示（仕様 §4.6）。「保存済み」「未送信 n」「送信中…」「オフライン」「エラー（短い理由）」を常に見える所に。押すと詳細とやり直し。
import { h, append, openDialog, fmtDateTime, toast } from './ui.js';

const SHORT = { auth: 'トークン', forbidden: '権限', notfound: '倉庫が見つからない', server: 'GitHub不調', conflict: '競合', validation: '拒否された', toolarge: '大きすぎ', schema: '形式', internal: '不明', network: '通信', offline: 'オフライン' };

export function statusText(s) {
  switch (s.kind) {
    case 'unconfigured': return '未接続';
    case 'saved': return '保存済み';
    case 'pending': return `未送信 ${s.pending}`;
    case 'sending': return '送信中…';
    case 'offline': return s.pending ? `オフライン・未送信 ${s.pending}` : 'オフライン';
    case 'waiting': return `待機 ${Math.max(0, Math.ceil(((s.retryAt || 0) - Date.now()) / 1000))}秒`;
    case 'error': return `エラー（${SHORT[s.errKind] || '失敗'}）`;
    default: return '';
  }
}

export function createSyncPill(engine, { onSettings } = {}) {
  const dot = h('span', { class: 'st-dot' });
  const txt = h('span', { class: 'st-txt' });
  const btn = h('button', { class: 'sync-pill', type: 'button', dataset: { t: 'sync-pill' }, 'aria-live': 'polite', onclick: () => openDetails() }, dot, txt);
  let ticker = 0;
  const render = () => {
    const s = { ...engine.status, errKind: engine.err && engine.err.kind };
    btn.dataset.state = s.kind;
    txt.textContent = statusText(s);
    btn.title = s.message || txt.textContent;
    if ((s.kind === 'waiting' || (s.kind === 'pending' && s.nextSendAt)) && !ticker) ticker = setInterval(render, 1000);
    if (!(s.kind === 'waiting' || (s.kind === 'pending' && s.nextSendAt)) && ticker) { clearInterval(ticker); ticker = 0; }
  };
  const on = () => render();
  engine.addEventListener('status', on);
  render();

  function openDetails() {
    const s = engine.status, err = engine.err;
    const row = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }));
    const body = h('div', { class: 'sync-detail' });
    const fill = () => {
      body.textContent = '';
      const st = engine.status;
      append(body, [
        row('状態', statusText({ ...st, errKind: engine.err && engine.err.kind })),
        row('未送信', `${st.pending} 件（メモ・線 ${engine.dirtyIds.size}／ライブラリの変更 ${engine.patches.length}／アップロード ${engine.uploadIds.size}）`),
        row('最後に保存', st.lastCommitAt ? fmtDateTime(new Date(st.lastCommitAt).toISOString()) : 'まだありません'),
        row('最後に確認', st.lastRefreshAt ? fmtDateTime(new Date(st.lastRefreshAt).toISOString()) : 'まだありません'),
        row('倉庫', engine.configured ? `${engine.settings.owner}/${engine.settings.repo}（${engine.settings.branch}）` : '未設定'),
        row('この端末の名前', engine.device),
        st.progress ? row('いま', st.progress.text) : null,
        engine.err ? h('p', { class: 'sync-err', dataset: { t: 'sync-error' }, text: engine.err.message }) : null,
        h('p', { class: 'hint', text: '変更は端末に先に保存され、10 秒静かになったら（前回の保存から 60 秒あけて）まとめて倉庫へ送ります。' })]);
    };
    fill();
    const tick = setInterval(fill, 1000);
    const d = openDialog({
      title: '同期の状態', body, onClose: () => clearInterval(tick),
      actions: [
        { label: '閉じる', id: 'close' },
        { label: '設定', id: 'settings', keepOpen: false, onClick: () => { onSettings && onSettings(); } },
        { label: '最新を読み込む', id: 'refresh', keepOpen: true, onClick: async () => { await engine.refresh(); toast('確認しました'); fill(); return false; } },
        { label: '今すぐ送信', id: 'flush', primary: true, keepOpen: true, onClick: async () => {
          if (!engine.pendingCount()) { toast('送るものはありません'); return false; }
          engine.err = engine.err && engine.err.kind === 'rate' ? engine.err : null;
          engine.flushNow(); fill(); return false;
        } },
      ],
    });
    return d;
  }
  return { el: btn, destroy() { engine.removeEventListener('status', on); clearInterval(ticker); }, openDetails };
}
