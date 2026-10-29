// github.js : GitHub REST API の薄い包み（Git Data API だけを使う）。仕様 §4.1・§4.3・§4.4。
//  - トークンはここ以外に出さない（ログ・エラー表示・URL に載せない）。
//  - GET は必ず cache:"no-store"（API の応答は max-age=60 で、ブラウザに古い版が残るため）。
//  - 書き込み（POST/PATCH）は直列で、前の書き込みから writeGapMs（既定 1 秒）空ける（公式のベストプラクティス）。
import { B64_CHUNK } from './logic.js';

export class GitHubError extends Error {
  /** kind: network | offline | auth | forbidden | notfound | rate | conflict | toolarge | validation | server | schema | internal */
  constructor(kind, message, extra = {}) { super(message); this.name = 'GitHubError'; this.kind = kind; Object.assign(this, extra); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const encPath = s => s.split('/').map(encodeURIComponent).join('/');

/** 応答 → 待ち時間(秒)。retry-after が先、無ければ x-ratelimit-remaining=0 の reset、どちらも無ければ 60 秒（公式の指示） */
export function waitSecondsFrom(headers, fallback = 60) {
  const ra = headers.get('retry-after');
  if (ra && /^\d+$/.test(ra.trim())) return Math.max(1, Number(ra));
  const rem = headers.get('x-ratelimit-remaining'), reset = headers.get('x-ratelimit-reset');
  if (rem === '0' && reset && /^\d+$/.test(reset)) return Math.max(1, Number(reset) - Math.floor(Date.now() / 1000));
  return fallback;
}
/** HTTP の失敗 → GitHubError（本文のメッセージは GitHub のもので、トークンは含まれない） */
export function classifyError(status, body, headers) {
  const msg = (body && typeof body.message === 'string') ? body.message : '';
  const info = { status, apiMessage: msg };
  if (status === 401) return new GitHubError('auth', 'トークンが無効か、期限が切れています。設定で作り直してください。', info);
  if (status === 429 || (status === 403 && (/rate limit|abuse/i.test(msg) || headers.get('retry-after') || headers.get('x-ratelimit-remaining') === '0'))) {
    const sec = waitSecondsFrom(headers);
    return new GitHubError('rate', `GitHub の回数制限です。${sec} 秒ほど待ってから自動でやり直します。`, { ...info, waitSec: sec });
  }
  if (status === 403) return new GitHubError('forbidden', 'このトークンには、この倉庫への書き込み（Contents: Read and write）の権限がありません。', info);
  if (status === 404) return new GitHubError('notfound', '倉庫またはブランチが見つかりません（トークンの対象に倉庫が入っているか、持ち主・倉庫名・ブランチを確かめてください）。', info);
  if (status === 409) return new GitHubError('validation', '倉庫が空か、競合しています：' + msg, info);
  if (status === 413) return new GitHubError('toolarge', 'ファイルが大きすぎて GitHub に断られました。PC から黒コに頼んでください。', info);
  if (status === 422) {
    if (/not a fast forward/i.test(msg)) return new GitHubError('conflict', '別の端末が先に保存していました。合流してやり直します。', info);
    if (/too.?large|exceeds|size/i.test(msg) || (body && JSON.stringify(body.errors || '').match(/too.?large|size/i))) return new GitHubError('toolarge', 'ファイルが大きすぎて GitHub に断られました。PC から黒コに頼んでください。', info);
    return new GitHubError('validation', 'GitHub に断られました：' + (msg || '入力が正しくありません'), info);
  }
  if (status >= 500) return new GitHubError('server', `GitHub 側の一時的な不調です（${status}）。あとでやり直します。`, info);
  return new GitHubError('validation', `GitHub から想定外の応答です（${status}）${msg ? '：' + msg : ''}`, info);
}

export class Api {
  constructor({ apiUrl = 'https://api.github.com', owner, repo, branch = 'main', token, writeGapMs = 1000 }) {
    this.base = `${String(apiUrl).replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    this.branch = branch; this.token = token; this.writeGapMs = writeGapMs; this.lastWriteEnd = 0;
    this.stats = { reads: 0, writes: 0 };
  }
  async _gate() {
    const wait = this.lastWriteEnd + this.writeGapMs - Date.now();
    if (wait > 0) await sleep(wait);
  }
  async request(method, path, { json, body, accept = 'application/vnd.github+json', signal } = {}) {
    const isRead = method === 'GET';
    const headers = { Authorization: `Bearer ${this.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
    let payload;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = body; }
    if (!isRead) await this._gate();
    let res;
    try {
      res = await fetch(this.base + path, { method, headers, body: payload, signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new GitHubError(navigator.onLine === false ? 'offline' : 'network',
        navigator.onLine === false ? 'オフラインです。つながったら自動で送ります。' : '通信できませんでした（回線・GitHub の状態・CORS を確かめてください）。', {});
    } finally {
      if (!isRead) this.lastWriteEnd = Date.now();
    }
    if (isRead) this.stats.reads++; else this.stats.writes++;
    if (!res.ok) {
      let b = null; try { b = await res.clone().json(); } catch (e) { /* 本文が JSON でない */ }
      throw classifyError(res.status, b, res.headers);
    }
    return res;
  }
  async getRepo() { return (await this.request('GET', '')).json(); }
  async getRef() { const j = await (await this.request('GET', `/git/ref/heads/${encPath(this.branch)}`)).json(); return j.object.sha; }
  async getCommit(sha) { return (await this.request('GET', `/git/commits/${sha}`)).json(); }
  async getTree(sha) { return (await this.request('GET', `/git/trees/${sha}?recursive=1`)).json(); }
  /** blob の生バイト。総量が分かれば進み具合を通知（total は tree の size を渡す） */
  async getBlobRaw(sha, { onProgress, total, signal } = {}) {
    const res = await this.request('GET', `/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', signal });
    const len = total || Number(res.headers.get('content-length')) || 0;
    if (!res.body || !onProgress) return res.blob();
    const reader = res.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length; onProgress(got, len);
    }
    return new Blob(chunks);
  }
  async getBlobText(sha) { return (await this.getBlobRaw(sha)).text(); }
  async createBlobText(text) {
    const j = await (await this.request('POST', '/git/blobs', { json: { content: text, encoding: 'utf-8' } })).json();
    return j.sha;
  }
  /** 大きいファイルは base64 を 3MiB ずつ作って Blob をつなぐ（巨大な文字列を作らずメモリを抑える） */
  async createBlobBase64(blob, onProgress) {
    let acc = new Blob(['{"content":"']);
    for (let off = 0; off < blob.size; off += B64_CHUNK) {
      const end = Math.min(blob.size, off + B64_CHUNK);
      acc = new Blob([acc, await blobToBase64(blob.slice(off, end))]);
      onProgress?.(end / blob.size);
    }
    const body = new Blob([acc, '","encoding":"base64"}'], { type: 'application/json' });
    const j = await (await this.request('POST', '/git/blobs', { body })).json();
    return j.sha;
  }
  /** entries: {path, mode, type:'blob', sha|null}。sha:null でそのファイルを削除（公式の書き方）。無いファイルの削除は誤りになる */
  async createTree(baseTree, entries) {
    const j = await (await this.request('POST', '/git/trees', { json: { base_tree: baseTree, tree: entries } })).json();
    return j.sha;
  }
  async createCommit(message, tree, parents) {
    const j = await (await this.request('POST', '/git/commits', { json: { message, tree, parents } })).json();
    return j.sha;
  }
  /** fast-forward のみ（force:false）。違えば GitHubError('conflict') */
  async updateRef(sha) {
    await this.request('PATCH', `/git/refs/heads/${encPath(this.branch)}`, { json: { sha, force: false } });
  }
}

function blobToBase64(b) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const s = r.result; res(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

/** 設定画面の「接続テスト」。push 権限まで確かめる。 */
export async function testConnection({ apiUrl, owner, repo, branch, token }) {
  const api = new Api({ apiUrl, owner, repo, branch, token });
  const info = await api.getRepo();
  const out = { fullName: info.full_name, private: !!info.private, push: !!(info.permissions && info.permissions.push), branchOk: false, head: null, writeChecked: false };
  if (out.push) {                         // permissions.push は表示だけのことがあるので、実際に書けるかを無害な blob 1 つで確かめる（同じ内容は同じ sha＝倉庫は汚れない）
    try { await api.createBlobText('paper-reader connection test\n'); out.writeChecked = true; }
    catch (e) { if (e instanceof GitHubError && (e.kind === 'forbidden' || e.kind === 'auth')) out.push = false; else throw e; }
  }
  try { out.head = await api.getRef(); out.branchOk = true; } catch (e) { if (!(e instanceof GitHubError)) throw e; out.branchError = e.kind; }
  return out;
}
