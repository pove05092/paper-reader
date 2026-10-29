// settings.js : 設定（接続・トークン案内・表示・キャッシュ）と、初回の歓迎画面。仕様 §3.6。
import * as S from './store.js';
import { h, icon, clear, toast, confirmDialog, alertDialog } from './ui.js';
import { saveSettings, setToken, getToken, DEFAULT_SETTINGS, loadSettings } from './sync.js';
import { testConnection, GitHubError } from './github.js';
import { formatBytes } from './logic.js';

const TOKEN_NEW_URL = 'https://github.com/settings/personal-access-tokens/new';
/** 新規作成ページの事前入力（公式ドキュメントに載っている引数だけ：name・description・expires_in・<permission>）。倉庫の選択は事前入力できないので手順に書く */
export function tokenUrl(device) {
  const q = new URLSearchParams({ name: `論文リーダー（${device || 'この端末'}）`.slice(0, 40), description: '論文リーダー用。paper-library だけに使います。', expires_in: '365', contents: 'write' });
  return `${TOKEN_NEW_URL}?${q.toString()}`;
}

function guide(device, repoName = 'paper-library') {
  const a = h('a', { class: 'btn primary link-btn', href: tokenUrl(device), target: '_blank', rel: 'noopener noreferrer', dataset: { t: 'token-link' } }, icon('upload'), 'トークンの作成ページを開く（GitHub）');
  return h('details', { class: 'guide', open: true, dataset: { t: 'token-guide' } },
    h('summary', { text: 'トークン（合い言葉）の作り方' }),
    h('p', { class: 'hint', text: 'この端末から倉庫に読み書きするための、倉庫専用の「合い言葉」です。端末ごとに1本ずつ作ります（スマホとPCで別々）。' }),
    h('ol', null,
      h('li', null, 'GitHub にログインした状態で、下のボタンから作成ページを開く（Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token と同じ画面です）。名前と期限（1年）は入力済みです。'),
      h('li', null, h('b', { text: 'Repository access' }), ' で ', h('b', { text: 'Only select repositories' }), ' を選び、', h('b', { text: repoName }), ' だけを選ぶ。'),
      h('li', null, h('b', { text: 'Permissions → Repository permissions → Contents' }), ' を ', h('b', { text: 'Read and write' }), ' にする（Metadata: Read は自動で付きます。ほかは触らない）。'),
      h('li', null, h('b', { text: 'Generate token' }), ' を押し、表示された ', h('code', { text: 'github_pat_…' }), ' をコピーして、下の「トークン」欄に貼り付ける。'),
      h('li', null, '「接続テスト」で「書き込みできます」と出れば完了。')),
    a,
    h('p', { class: 'hint', text: 'トークンはこの端末のブラウザの中だけに保存され、ほかには送られません（送り先は GitHub の API だけ）。画面を人に見せる時は欄を隠してください。' }));
}

export function renderWelcome({ host, go }) {
  const root = h('div', { class: 'welcome', dataset: { t: 'welcome' } },
    h('div', { class: 'wl-card' },
      h('div', { class: 'wl-logo' }, icon('marker')),
      h('h1', { text: '論文リーダー' }),
      h('p', { class: 'lead', text: '左右対訳の論文PDFをためて、PC でもスマホでも読み、好きな色のマーカーとメモと要約を残すためのアプリです。' }),
      h('ul', { class: 'points' },
        h('li', null, h('b', { text: '読む：' }), '1ページが「左＝原文・右＝日本語」の見開き。両方／原文／日本語を切り替え、ピンチで拡大。'),
        h('li', null, h('b', { text: '書く：' }), '指やマウスで自由にマーカー・ペン・メモ。色に決まりはありません。'),
        h('li', null, h('b', { text: '残る：' }), '自分だけの非公開の倉庫（GitHub）に保存。PC とスマホで同じものが見えます。')),
      h('p', { class: 'hint', text: 'はじめに、この端末用のトークン（倉庫専用の合い言葉）を設定します。5 分ほどです。' }),
      h('button', { class: 'btn primary big', type: 'button', dataset: { t: 'welcome-start' }, onclick: () => go('#/settings') }, 'はじめる（トークンを設定）')));
  host.append(root);
  return { destroy() { root.remove(); } };
}

export function renderSettings({ engine, host, go, firstRun }) {
  const cur = loadSettings();
  const fields = {
    owner: h('input', { class: 'input', type: 'text', value: cur.owner, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', dataset: { t: 'set-owner' } }),
    repo: h('input', { class: 'input', type: 'text', value: cur.repo, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', dataset: { t: 'set-repo' } }),
    branch: h('input', { class: 'input', type: 'text', value: cur.branch, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', dataset: { t: 'set-branch' } }),
    device: h('input', { class: 'input', type: 'text', value: cur.device, placeholder: '例：Pixel／自宅PC', autocomplete: 'off', dataset: { t: 'set-device' } }),
    token: h('input', { class: 'input', type: 'password', value: getToken(), autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'github_pat_…', dataset: { t: 'set-token' } }),
    apiUrl: h('input', { class: 'input', type: 'text', value: cur.apiUrl, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', dataset: { t: 'set-api' } }),
    defaultView: h('select', { class: 'input', dataset: { t: 'set-view' } }, [['auto', '自動（画面が狭ければ日本語、広ければ両方）'], ['both', '両方（見開き）'], ['orig', '原文'], ['ja', '日本語']].map(([v, l]) => h('option', { value: v, text: l }))),
  };
  fields.defaultView.value = cur.defaultView || 'auto';
  const field = (label, el, note) => h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), el, note ? h('span', { class: 'note', text: note }) : null);
  const showTok = h('button', { class: 'btn small', type: 'button', dataset: { t: 'token-show' }, onclick: () => { const on = fields.token.type === 'password'; fields.token.type = on ? 'text' : 'password'; showTok.textContent = on ? '隠す' : '表示'; } }, '表示');
  const result = h('div', { class: 'test-result', role: 'status', dataset: { t: 'test-result' }, hidden: true });
  const current = () => ({ owner: fields.owner.value.trim(), repo: fields.repo.value.trim(), branch: fields.branch.value.trim() || 'main', device: fields.device.value.trim(),
    apiUrl: fields.apiUrl.value.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.apiUrl, token: fields.token.value.trim(), defaultView: fields.defaultView.value });

  async function runTest() {
    const c = current();
    result.hidden = false; result.className = 'test-result'; result.textContent = '確かめています…';
    if (!c.token) { result.className = 'test-result bad'; result.textContent = 'トークンが空です。'; return false; }
    try {
      const r = await testConnection(c);
      if (!r.push) { result.className = 'test-result warn'; result.textContent = `${r.fullName} に接続できましたが、読み取りだけです。トークンの Permissions → Contents を「Read and write」にして作り直してください。`; return false; }
      if (!r.branchOk) { result.className = 'test-result warn'; result.textContent = `${r.fullName} に接続できましたが、ブランチ「${c.branch}」が見つかりません。`; return false; }
      result.className = 'test-result ok'; result.textContent = `接続できました。${r.fullName}（${r.private ? '非公開' : '公開'}）に書き込みできます。`;
      return true;
    } catch (e) {
      result.className = 'test-result bad';
      result.textContent = e instanceof GitHubError ? e.message : '接続テストに失敗しました：' + (e && e.message ? e.message : e);
      return false;
    }
  }
  async function save() {
    const c = current();
    const prevKey = engine.repoKey();
    const next = { ...cur, owner: c.owner, repo: c.repo, branch: c.branch, device: c.device, apiUrl: c.apiUrl, defaultView: c.defaultView };
    const nextKey = `${next.apiUrl}|${next.owner}/${next.repo}@${next.branch}`;
    if (!c.token) { toast('トークンを入れてください', { kind: 'warn' }); return; }
    if (engine.configured && nextKey !== prevKey && engine.pendingCount()) {
      const ok = await confirmDialog(`接続先を変えると、この端末の未送信の変更 ${engine.pendingCount()} 件は破棄されます。続けますか？`, { okLabel: '破棄して切り替える', danger: true });
      if (!ok) return;
    }
    saveSettings(next); setToken(c.token);
    await engine.reconfigure();
    toast('設定を保存しました');
    go('#/', { replace: true });
  }

  // 端末のキャッシュ
  const cacheInfo = h('div', { class: 'cache-info', dataset: { t: 'cache-info' }, text: '計算中…' });
  async function refreshCache() {
    try {
      const total = await S.blobStore.totalSize(), n = (await S.blobStore.listMeta()).length, est = await S.storageEstimate();
      cacheInfo.textContent = `保存済みの PDF・サムネイル：${n} 件・${formatBytes(total)}` + (est ? `（この端末の使用量 ${formatBytes(est.usage)} ／ 上限の目安 ${formatBytes(est.quota)}）` : '');
    } catch (e) { cacheInfo.textContent = '調べられませんでした'; }
  }
  refreshCache();

  const root = h('div', { class: 'settings', dataset: { t: 'settings' } },
    h('header', { class: 'set-top' },
      h('button', { class: 'btn icon plain', type: 'button', 'aria-label': '戻る', dataset: { t: 'settings-back' }, onclick: () => (engine.configured ? go('#/', { replace: true }) : go('#/welcome', { replace: true })) }, icon('back')),
      h('h1', { text: '設定' })),
    h('div', { class: 'set-body' },
      firstRun ? h('p', { class: 'hint', text: 'はじめに、この端末用のトークンを設定してください。' }) : null,
      guide(fields.device.value),
      h('section', { class: 'set-sec' }, h('h2', { text: '接続' }),
        field('持ち主', fields.owner), field('倉庫', fields.repo), field('ブランチ', fields.branch),
        field('この端末の名前', fields.device, '保存の記録（コミットの説明）に付きます。'),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'トークン' }), h('div', { class: 'with-btn' }, fields.token, showTok)),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', dataset: { t: 'test-conn' }, onclick: runTest }, '接続テスト'), h('button', { class: 'btn primary', type: 'button', dataset: { t: 'save-settings' }, onclick: save }, '保存して使いはじめる')),
        result),
      h('section', { class: 'set-sec' }, h('h2', { text: '表示' }), field('見開き PDF の既定の表示', fields.defaultView, 'リーダーで切り替えると、この端末の既定として覚えます。')),
      h('section', { class: 'set-sec' }, h('h2', { text: 'この端末のキャッシュ' }), cacheInfo,
        h('p', { class: 'hint', text: '読んだ PDF はこの端末に保存され、2 回目からは通信しません（オフラインでも読めます）。消しても倉庫には残ります。未送信の変更は消えません。' }),
        h('button', { class: 'btn danger small', type: 'button', dataset: { t: 'clear-cache' }, onclick: async () => {
          if (await confirmDialog('この端末に保存した PDF とサムネイルをすべて消します。倉庫のデータと未送信の変更は消えません。', { okLabel: '消す', danger: true })) { await engine.clearCaches(); toast('消しました'); refreshCache(); }
        } }, 'キャッシュを全部消す')),
      h('section', { class: 'set-sec' }, h('h2', { text: '詳細' }), field('API の URL', fields.apiUrl, '通常は変えません（試験用にモックへ向ける時だけ）。'),
        h('button', { class: 'btn danger small', type: 'button', dataset: { t: 'forget' }, onclick: async () => {
          const msg = engine.pendingCount() ? `この端末の接続情報（トークン・設定）を消します。未送信の変更 ${engine.pendingCount()} 件は端末に残りますが、再接続するまで送れません。` : 'この端末の接続情報（トークン・設定）を消します。倉庫のデータは消えません。';
          if (await confirmDialog(msg, { okLabel: '接続情報を消す', danger: true })) {
            setToken(''); localStorage.removeItem('pr.settings'); localStorage.removeItem('pr.ui');
            await engine.reconfigure(); toast('接続情報を消しました'); go('#/welcome', { replace: true });
          }
        } }, icon('trash'), 'この端末から接続情報を消す'),
        h('p', { class: 'hint', text: '論文リーダー v1' }))));
  host.append(root);
  return { destroy() { root.remove(); } };
}
