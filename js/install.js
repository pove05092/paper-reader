// install.js : 「アプリとしてこの端末（PC・スマホ）にインストール」の導線。論文リーダー site_v6・HTMLライブラリ site_v2 で同じ物を使う。
// Chrome／Edge は、インストールできる状態になると beforeinstallprompt を 1 回だけ投げる。早く来すぎて取りこぼさないよう、app.js の先頭で initInstall() を呼んで覚えておき、
// 設定画面・歓迎画面のボタンから prompt() で OS のインストール確認を出す。インストール後は独立した窓（display-mode: standalone）で開き、スタートメニュー・タスクバーに置ける。
import { h, toast } from './ui.js';

let deferred = null;       // 覚えておいた beforeinstallprompt
let installedNow = false;  // このページを開いている間にインストールされた
const watchers = new Set();
const notify = () => watchers.forEach(f => { try { f(); } catch (e) { /* 描画側の失敗は無視 */ } });

/** アプリの窓（インストール済みの窓）として開いているか */
export function isStandalone() {
  try {
    return ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'].some(m => window.matchMedia(`(display-mode: ${m})`).matches) || navigator.standalone === true;
  } catch (e) { return false; }
}

/** app.js の先頭で 1 回だけ呼ぶ */
export function initInstall() {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; installedNow = true; notify(); toast('インストールしました。スタートメニューから開けます'); });
}

/** ボタンを押した時：OS のインストール確認を出す */
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const ev = deferred;
  deferred = null;               // prompt() は 1 回しか使えない
  notify();
  try {
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    if (outcome !== 'accepted') toast('インストールをやめました（あとで設定からもう一度できます）');
    return outcome;
  } catch (e) { return 'error'; }
}

/**
 * 「アプリとしてインストール」の節。状態が変わると中身を作り直す。
 * @returns { el, destroy }
 */
export function installSection(appName) {
  const body = h('div', { class: 'install-body', dataset: { t: 'install-body' } });
  const el = h('section', { class: 'set-sec', dataset: { t: 'install-section' } }, h('h2', { text: 'アプリとしてインストール' }), body);
  const draw = () => {
    body.replaceChildren();
    if (installedNow || isStandalone()) {
      body.append(h('p', { class: 'hint', dataset: { t: 'install-state' }, text: `${appName}はインストール済みです（アプリの窓で開いています）。` }));
    } else if (deferred) {
      body.append(
        h('p', { class: 'hint', text: `この端末に${appName}をアプリとして入れます。ブラウザのタブとは別の窓で開き、PC ならスタートメニュー・タスクバー、スマホならホーム画面に置けます。` }),
        h('button', { class: 'btn primary', type: 'button', dataset: { t: 'install-btn' }, onclick: () => { promptInstall(); } }, 'アプリとしてインストール'));
    } else {
      body.append(h('p', { class: 'hint', dataset: { t: 'install-state' }, text: `Chrome か Edge（PC）でこのページを開き、アドレス欄の右端にあるインストールのアイコン、またはメニューの「${appName}をインストール」から入れられます。ここにボタンが出ないのは、すでに入れてある時か、そのブラウザが対応していない時です。` }));
    }
  };
  draw();
  watchers.add(draw);
  return { el, destroy() { watchers.delete(draw); el.remove(); } };
}

/** 歓迎画面用の小さなボタン（インストールできる時だけ出る） */
export function installChip(appName) {
  const btn = h('button', { class: 'btn', type: 'button', hidden: true, dataset: { t: 'install-chip' }, onclick: () => { promptInstall(); } }, `${appName}をアプリとしてインストール`);
  const draw = () => { btn.hidden = !(deferred && !installedNow && !isStandalone()); };
  draw();
  watchers.add(draw);
  return { el: btn, destroy() { watchers.delete(draw); btn.remove(); } };
}
