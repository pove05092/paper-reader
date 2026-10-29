// sync.js : ローカル優先の同期エンジン（仕様 §4）。
//  書き込みはまず IndexedDB に入れて「未送信」とし、10 秒静かになったら（コミットの間は 60 秒空けて）1 コミット複数ファイルで送る。
//  競合（fast-forward でない）は、新しい head を読み直して notes は id ごとに合流・library はパッチを掛け直してやり直す。
import * as L from './logic.js';
import * as S from './store.js';
import { Api, GitHubError } from './github.js';

const SETTINGS_KEY = 'pr.settings', TOKEN_KEY = 'pr.token', DEV_KEY = 'pr.dev';
export const DEFAULT_SETTINGS = { owner: 'pove05092', repo: 'paper-library', branch: 'main', device: '', apiUrl: 'https://api.github.com', defaultView: 'auto' };

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS };
  try { Object.assign(s, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* 壊れていたら既定 */ }
  return s;
}
export function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function loadDev() { try { return JSON.parse(localStorage.getItem(DEV_KEY) || '{}') || {}; } catch (e) { return {}; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const utf8Len = s => new TextEncoder().encode(s).length;

export class SyncEngine extends EventTarget {
  constructor() {
    super();
    this.settings = loadSettings();
    this.token = getToken();
    this.timing = { ...L.TIMING };
    this.api = null;
    this.base = null;                 // { repoKey, headSha, commitTree, files:{path:{sha,size}}, libSha, library }
    this.patches = [];                // 未送信のライブラリ操作
    this.recs = new Map();            // paperId → メモの記録 {paperId, notes, dirty, rev, remoteSha}
    this.dirtyIds = new Set();
    this.uploadIds = new Set();
    this.library = L.emptyLibrary();  // 画面に出す版（base + patches）
    this.online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    this.err = null;                  // {kind, message, retryAt}
    this.sending = null; this.refreshing = null; this.again = false;
    this.lastChangeAt = null; this.lastCommitAt = null; this.lastRefreshAt = null; this.retryAt = null; this.failures = 0;
    this.timer = null; this.pollTimer = null; this.nextSendAt = null;
    this.opened = new Set();
    this.progress = null;             // {text}
    this.textCache = new Map();
    this.thumbUrls = new Map(); this.thumbQueue = []; this.thumbActive = 0;
    this._persistQ = Promise.resolve();
    this._notesTimers = new Map();
    this.status = { kind: 'unconfigured', pending: 0, message: '' };
  }

  // ---------- 状態 ----------
  get configured() { return !!(this.token && this.settings.owner && this.settings.repo); }
  get device() { return this.settings.device || 'web'; }
  repoKey() { const s = this.settings; return `${s.apiUrl}|${s.owner}/${s.repo}@${s.branch}`; }
  pendingCount() { return this.dirtyIds.size + this.patches.length + this.uploadIds.size; }
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  computeStatus() {
    const pending = this.pendingCount(), now = Date.now();
    let kind;
    if (!this.configured) kind = 'unconfigured';
    else if (this.sending) kind = 'sending';
    else if (this.err && this.err.kind === 'rate') kind = 'waiting';
    else if (this.err && !['offline', 'network'].includes(this.err.kind) && this.err.fatal) kind = 'error';
    else if (!this.online || (this.err && this.err.kind === 'offline')) kind = 'offline';
    else if (this.err) kind = 'error';
    else if (pending > 0) kind = 'pending';
    else kind = 'saved';
    this.status = { kind, pending, message: this.err ? this.err.message : '', retryAt: this.err?.retryAt ?? null, nextSendAt: this.nextSendAt, lastCommitAt: this.lastCommitAt,
      lastRefreshAt: this.lastRefreshAt, head: this.base?.headSha || null, progress: this.progress, now };
    return this.status;
  }
  setStatus() { this.computeStatus(); this.emit('status', this.status); }

  // ---------- 起動 ----------
  async init() {
    this.settings = loadSettings(); this.token = getToken();
    this.timing = { ...L.TIMING };
    const dev = loadDev();
    for (const k of Object.keys(this.timing)) if (Number.isFinite(dev[k])) this.timing[k] = dev[k];   // 試験用の短縮（localStorage pr.dev）。既定は 10 秒・60 秒・1 秒・60 秒
    this.api = this.configured ? new Api({ ...this.settings, token: this.token, writeGapMs: this.timing.writeGapMs }) : null;
    try {
      const base = await S.kv.get('base');
      if (base && base.repoKey === this.repoKey()) this.base = base;
      else if (base) { await S.clearAll(); }               // 別の倉庫のキャッシュは混ぜない
      this.patches = (await S.kv.get('patches')) || [];
      for (const id of await S.notesDb.ids()) { const rec = await S.notesDb.get(id); if (rec && rec.dirty) { this.recs.set(id, rec); this.dirtyIds.add(id); } }
      for (const id of await S.uploadsDb.ids()) this.uploadIds.add(id);
    } catch (e) {
      console.warn('[sync] 端末内の保存を読めませんでした', e && e.name);
      this.err = { kind: 'internal', message: '端末内の保存領域を開けませんでした（プライベートモードなど）。変更は保存されません。', fatal: true };
    }
    this.rebuildView();
    this.setStatus();
    S.requestPersistence();
    if (this.configured) {
      this.startPolling();
      this.refresh().then(() => { if (this.pendingCount()) this.schedule(); });
    }
  }
  attachWindowEvents() {
    window.addEventListener('online', () => { this.online = true; if (this.err && ['offline', 'network'].includes(this.err.kind)) this.err = null; this.setStatus(); this.refresh(); this.schedule(true); });
    window.addEventListener('offline', () => { this.online = false; this.setStatus(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { this.flushLocal(); this.schedule(true); }
      else this.refresh();
    });
    window.addEventListener('pagehide', () => { this.flushLocal(); this.schedule(true); });
  }
  startPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => { if (document.visibilityState === 'visible') this.refresh({ quiet: true }); }, this.timing.pollMs);
  }
  /** 設定を変えた後に作り直す */
  async reconfigure() {
    await this.flushLocal();
    this.epoch = (this.epoch || 0) + 1;
    clearTimeout(this.timer); clearInterval(this.pollTimer);
    this.err = null; this.base = null; this.patches = []; this.recs.clear(); this.dirtyIds.clear(); this.uploadIds.clear(); this.textCache.clear();
    this.revokeThumbs();
    await this.init();
  }

  // ---------- ライブラリ（表示用 = base + 未送信パッチ） ----------
  rebuildView() {
    const lib = this.base ? this.base.library : L.emptyLibrary();
    this.library = L.applyPatches(lib, this.patches);
    const sig = JSON.stringify(this.library);
    if (sig === this._libSig) return;               // 中身が変わっていない時は通知しない（一覧が指の下で描き直されて、押したカードがずれるのを避ける）
    this._libSig = sig;
    this.emit('library', this.library);
  }
  patch(op, { silent = false } = {}) {
    const p = { pid: L.makeItemId('p'), at: L.nowIso(), ...op };
    this.patches = L.coalescePatches(this.patches, p);
    this.persistPatches();
    this.rebuildView();
    if (!silent) this.noteChange(); else this.setStatus();
  }
  persistPatches() {
    const snap = this.patches;
    this._persistQ = this._persistQ.then(() => S.kv.set('patches', snap)).catch(e => this.storageFailed(e));
  }
  storageFailed(e) {
    console.warn('[sync] 端末内に保存できませんでした', e && e.name);
    this.emit('storage-error', e);
  }
  setField(id, key, value, opts) { this.patch({ op: 'setField', id, key, value }, opts); }

  // ---------- メモ（線・付箋・自分の要約） ----------
  /** 論文を開いた時：端末内の写し＋倉庫の notes.json を合流して返す。返した rec を直接編集して touchNotes(rec) を呼ぶ */
  async openNotes(paperId) {
    let rec = this.recs.get(paperId) || await S.notesDb.get(paperId) || null;
    const remoteSha = this.base?.files[`papers/${paperId}/notes.json`]?.sha || null;
    if (remoteSha && (!rec || rec.remoteSha !== remoteSha)) {
      try {
        const remote = L.normalizeNotes(JSON.parse(await this.textBlob(remoteSha)), paperId);
        const merged = rec ? L.mergeNotes(rec.notes, remote) : remote;
        const differs = !L.sameJson(merged, remote);
        rec = { paperId, notes: merged, dirty: !!(rec && rec.dirty) || differs, rev: (rec ? rec.rev : 0) + 1, remoteSha };
        this.recs.set(paperId, rec);
        if (rec.dirty) this.dirtyIds.add(paperId);
        await S.notesDb.put(rec).catch(e => this.storageFailed(e));
      } catch (e) {
        if (e instanceof GitHubError && !rec) throw e;               // 端末内に何も無くて読めないなら開けない
        if (!(e instanceof GitHubError)) throw e;
      }
    }
    if (!rec) rec = { paperId, notes: L.emptyNotes(paperId), dirty: false, rev: 0, remoteSha: null };
    rec.notes = L.normalizeNotes(rec.notes, paperId);
    this.recs.set(paperId, rec);
    this.opened.add(paperId);
    return rec;
  }
  closeNotes(paperId) { this.opened.delete(paperId); this.flushLocal(); }
  touchNotes(rec) {
    rec.rev++; rec.dirty = true;
    this.dirtyIds.add(rec.paperId); this.recs.set(rec.paperId, rec);
    clearTimeout(this._notesTimers.get(rec.paperId));
    this._notesTimers.set(rec.paperId, setTimeout(() => this.persistNotes(rec), 200));
    this.noteChange();
  }
  persistNotes(rec) {
    clearTimeout(this._notesTimers.get(rec.paperId)); this._notesTimers.delete(rec.paperId);
    const snap = { ...rec, notes: structuredClone(rec.notes) };
    this._persistQ = this._persistQ.then(() => S.notesDb.put(snap)).catch(e => this.storageFailed(e));
    return this._persistQ;
  }
  /** 画面を離れる前など：保留中の端末内保存をすぐ書く */
  flushLocal() {
    for (const [id] of [...this._notesTimers]) { const rec = this.recs.get(id); if (rec) this.persistNotes(rec); }
    return this._persistQ;
  }

  // ---------- アップロード・削除 ----------
  async queueUpload(job, entry) {
    await S.uploadsDb.put(job);
    this.uploadIds.add(job.paperId);
    this.patch({ op: 'addPaper', entry });
  }
  async removePaper(id) {
    const paper = this.library.papers.find(p => p.id === id);
    if (this.uploadIds.has(id)) { await S.uploadsDb.del(id); this.uploadIds.delete(id); }
    this.dirtyIds.delete(id); this.recs.delete(id); await S.notesDb.del(id).catch(() => {});
    if (paper) await this.dropCache(paper);
    this.patch({ op: 'removePaper', id });
  }
  async dropCache(paper) {
    for (const path of [paper.file, paper.thumb]) {
      const sha = this.base?.files[path]?.sha;
      if (sha) { await S.blobStore.del(sha).catch(() => {}); const u = this.thumbUrls.get(sha); if (u) { URL.revokeObjectURL(u); this.thumbUrls.delete(sha); } }
    }
    this.emit('cache');
  }
  async clearCaches() {
    await S.blobStore.clear(); this.revokeThumbs(); this.textCache.clear(); this.emit('cache');
  }
  revokeThumbs() { for (const u of this.thumbUrls.values()) URL.revokeObjectURL(u); this.thumbUrls.clear(); }

  // ---------- 読み込み ----------
  async textBlob(sha) {
    if (this.textCache.has(sha)) return this.textCache.get(sha);
    const t = await this.api.getBlobText(sha);
    this.textCache.set(sha, t);
    if (this.textCache.size > 200) this.textCache.delete(this.textCache.keys().next().value);
    return t;
  }
  async _pull(headSha) {
    const api = this.api;
    const commit = await api.getCommit(headSha);
    const tree = await api.getTree(commit.tree.sha);
    if (tree.truncated) throw new GitHubError('validation', '倉庫のファイルが多すぎて一覧が切り詰められました。', { fatal: true });
    const files = {};
    for (const e of tree.tree) if (e.type === 'blob') files[e.path] = { sha: e.sha, size: e.size };
    const libSha = files['library.json']?.sha || null;
    let library = this.base && this.base.libSha === libSha && this.base.library ? this.base.library : null;
    if (!library) {
      library = libSha ? L.normalizeLibrary(JSON.parse(await this.textBlob(libSha))) : L.emptyLibrary();
      if (library.schema > L.SCHEMA) throw new GitHubError('schema', 'この倉庫の形式は、このアプリより新しい版です。', { fatal: true });
    }
    this.base = { repoKey: this.repoKey(), headSha, commitTree: commit.tree.sha, files, libSha, library, fetchedAt: Date.now() };
    await S.kv.set('base', this.base).catch(e => this.storageFailed(e));
    this.rebuildView();
  }
  /** 起動時・定期・画面に戻った時：head を確かめ、変わっていれば読み直す（読むだけ） */
  refresh() {
    if (!this.configured || !this.online) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const head = await this.api.getRef();
        if (!this.base || this.base.headSha !== head) { await this._pull(head); await this.mergeOpenedNotes(); }
        this.lastRefreshAt = Date.now();
        if (this.err && ['network', 'offline', 'server'].includes(this.err.kind)) this.err = null;
        this.setStatus();
      } catch (e) { this.handleError(e, 'read'); }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  /** 開いている論文の notes を、他端末の更新とも合流する */
  async mergeOpenedNotes() {
    for (const id of this.opened) {
      const rec = this.recs.get(id); if (!rec) continue;
      const sha = this.base?.files[`papers/${id}/notes.json`]?.sha;
      if (!sha || rec.remoteSha === sha) continue;
      try {
        const remote = L.normalizeNotes(JSON.parse(await this.textBlob(sha)), id);
        const merged = L.mergeNotes(rec.notes, remote);
        rec.remoteSha = sha;
        if (!L.sameJson(merged, rec.notes)) {
          rec.notes = merged; rec.rev++;
          if (!L.sameJson(merged, remote)) { rec.dirty = true; this.dirtyIds.add(id); }
          this.persistNotes(rec);
          this.emit('notes', id);
        }
      } catch (e) { if (!(e instanceof GitHubError)) console.warn('[sync] notes の合流に失敗', e); }
    }
  }
  async getPdfBlob(paper, onProgress) {
    const job = this.uploadIds.has(paper.id) ? await S.uploadsDb.get(paper.id) : null;
    const f = job && job.files.find(x => x.path === paper.file);
    if (f) return f.blob;
    const ent = this.base?.files[paper.file];
    if (!ent) throw new GitHubError('notfound', '倉庫にこの論文のファイルがまだありません（取り込み中かもしれません。少し待って「最新を読み込む」を押してください）。');
    const cached = await S.blobStore.get(ent.sha).catch(() => null);
    if (cached) return cached;
    if (!this.online) throw new GitHubError('offline', 'オフラインで、この端末にもまだ保存されていません。');
    const blob = await this.api.getBlobRaw(ent.sha, { onProgress, total: ent.size });
    try { await S.blobStore.put(ent.sha, blob, 'pdf'); this.emit('cache'); } catch (e) { this.storageFailed(e); }   // 保存できなくても開ける
    return blob;
  }
  async isCached(paper) {
    if (this.uploadIds.has(paper.id)) return true;
    const sha = this.base?.files[paper.file]?.sha;
    return sha ? S.blobStore.has(sha) : false;
  }
  async cachedShaSet() { return new Set((await S.blobStore.listMeta()).map(m => m.sha)); }
  async getSummaryText(paper) {
    const ent = this.base?.files[`papers/${paper.id}/summary_ai.md`];
    if (!ent) return null;
    return this.textBlob(ent.sha);
  }
  /** サムネイルの URL（無ければ null）。取得は同時 3 本まで */
  thumbUrl(paper) {
    return new Promise(async resolve => {
      try {
        const job = this.uploadIds.has(paper.id) ? await S.uploadsDb.get(paper.id) : null;
        const f = job && job.files.find(x => x.path === paper.thumb);
        if (f) return resolve(URL.createObjectURL(f.blob));
        const ent = this.base?.files[paper.thumb];
        if (!ent) return resolve(null);
        if (this.thumbUrls.has(ent.sha)) return resolve(this.thumbUrls.get(ent.sha));
        const cached = await S.blobStore.get(ent.sha).catch(() => null);
        if (cached) { const u = URL.createObjectURL(cached); this.thumbUrls.set(ent.sha, u); return resolve(u); }
        if (!this.online || !this.api) return resolve(null);
        this.thumbQueue.push({ ent, resolve });
        this.pumpThumbs();
      } catch (e) { resolve(null); }
    });
  }
  pumpThumbs() {
    while (this.thumbActive < 3 && this.thumbQueue.length) {
      const { ent, resolve } = this.thumbQueue.shift();
      if (this.thumbUrls.has(ent.sha)) { resolve(this.thumbUrls.get(ent.sha)); continue; }
      this.thumbActive++;
      this.api.getBlobRaw(ent.sha).then(async b => {
        await S.blobStore.put(ent.sha, b, 'thumb').catch(() => {});
        const u = URL.createObjectURL(b); this.thumbUrls.set(ent.sha, u); resolve(u);
      }).catch(() => resolve(null)).finally(() => { this.thumbActive--; this.pumpThumbs(); });
    }
  }

  // ---------- 送信のスケジュール ----------
  noteChange() { this.lastChangeAt = Date.now(); this.schedule(false); this.setStatus(); }
  schedule(urgent = false) {
    if (!this.configured) return;
    if (this.pendingCount() === 0) { this.setStatus(); return; }
    const now = Date.now();
    let delay = L.computeSendDelay({ now, lastChangeAt: this.lastChangeAt, lastCommitAt: this.lastCommitAt, urgent, quietMs: this.timing.quietMs, gapMs: this.timing.gapMs });
    if (this.retryAt) delay = Math.max(delay, this.retryAt - now);        // 回数制限・失敗後の待ちは緊急でも守る
    clearTimeout(this.timer);
    this.nextSendAt = now + delay;
    this.timer = setTimeout(() => { this.nextSendAt = null; this.flush(); }, delay);
    this.setStatus();
  }
  /** 今すぐ送る（手動の「今すぐ送信」）。回数制限の待ち中は待つ */
  flushNow() {
    if (!(this.err && this.err.kind === 'rate')) { this.err = null; this.retryAt = null; }     // 回数制限の待ちだけは守る
    if (this.pendingCount()) this.schedule(true);
    return this.sending || Promise.resolve();
  }
  /** アップロードなど：静かになるのを待たずに送りたい（ただしコミットの間は 60 秒空ける） */
  requestSoon() { this.lastChangeAt = null; this.schedule(false); }
  async flush() {
    clearTimeout(this.timer); this.nextSendAt = null;
    if (!this.configured || this.pendingCount() === 0) { this.setStatus(); return; }
    if (this.sending) { this.again = true; return this.sending; }
    if (!this.online) { this.setStatus(); return; }
    this.sending = (async () => { await this.flushLocal(); await this._sendLoop(); })().finally(() => {
      this.sending = null; this.progress = null;
      if ((this.again || this.pendingCount() > 0) && !this.err) { this.again = false; this.schedule(false); }
      this.setStatus();
    });
    this.setStatus();
    return this.sending;
  }
  async _sendLoop() {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this._sendOnce();
        this.err = null; this.retryAt = null; this.failures = 0;
        return;
      } catch (e) {
        if (e instanceof GitHubError && e.kind === 'conflict' && attempt < 3) { await sleep(600 * (attempt + 1)); continue; }
        if (e instanceof GitHubError && e.kind === 'retry') continue;
        this.handleError(e, 'write');
        return;
      }
    }
  }
  handleError(e, mode) {
    if (!(e instanceof GitHubError)) { console.error('[sync] 想定外のエラー', e && e.message); e = new GitHubError('internal', '想定外のエラーが起きました：' + (e && e.message ? e.message : e)); }
    const now = Date.now();
    const err = { kind: e.kind, message: e.message, retryAt: null, fatal: ['auth', 'forbidden', 'notfound', 'schema', 'toolarge'].includes(e.kind) || !!e.fatal };
    if (e.kind === 'rate') { err.retryAt = now + e.waitSec * 1000; this.retryAt = err.retryAt; }
    else if (!err.fatal && ['network', 'offline', 'server', 'conflict', 'internal', 'validation'].includes(e.kind)) {
      this.failures++;
      const wait = e.kind === 'offline' ? 0 : Math.min(120, 10 * 2 ** (this.failures - 1)) * 1000;
      if (wait) { err.retryAt = now + wait; this.retryAt = err.retryAt; }
    }
    this.err = err;
    if (mode === 'write' && err.retryAt && this.pendingCount()) {
      clearTimeout(this.timer); this.nextSendAt = err.retryAt;
      this.timer = setTimeout(() => { this.err = null; this.retryAt = null; this.nextSendAt = null; this.flush(); }, Math.max(0, err.retryAt - now));
    }
    if (mode === 'read' && err.retryAt) { /* 読み取りの失敗は次の定期読み込みで直る */ err.retryAt = null; }
    this.setStatus();
    this.emit('problem', err);
  }

  // ---------- 1 回の送信（1 コミット・複数ファイル）----------
  async _sendOnce() {
    const api = this.api, epoch = this.epoch || 0;
    const patches = [...this.patches];
    const dirtyIds = [...this.dirtyIds];
    const jobs = (await Promise.all([...this.uploadIds].map(id => S.uploadsDb.get(id)))).filter(Boolean);
    if (!patches.length && !dirtyIds.length && !jobs.length) return;
    this.progress = { text: '最新の状態を確認中…' }; this.setStatus();

    // 1) 最新の head（古ければ library と tree を読み直す）
    const headSha = await api.getRef();
    if (!this.base || this.base.headSha !== headSha) { await this._pull(headSha); await this.mergeOpenedNotes(); }
    const base = this.base;

    // 2) library：パッチを最新の library に掛け直す
    const files = [];                                   // {path, text|blob, job?}
    const deletes = [];
    const parts = [];
    await this._resolveUploadCollisions(base, jobs, patches);
    let newLib = null;
    if (patches.length || jobs.length) {
      newLib = L.applyPatches(base.library, patches);
      const before = new Set(base.library.papers.map(p => p.id)), after = new Set(newLib.papers.map(p => p.id));
      for (const id of before) if (!after.has(id)) {            // 倉庫から消す論文：フォルダ内の全ファイルを削除
        for (const path of Object.keys(base.files)) if (path.startsWith(`papers/${id}/`)) deletes.push(path);
        parts.push(`delete: ${id}`);
      }
      newLib.updatedAt = L.nowIso();
      files.push({ path: 'library.json', text: L.stringifyJson(newLib) });
    }
    const liveIds = new Set((newLib || base.library).papers.map(p => p.id));
    for (const job of jobs) if (liveIds.has(job.paperId)) parts.push(`upload: ${job.paperId}`);
    const libraryOnly = patches.filter(p => !(p.op === 'addPaper' && jobs.some(j => j.paperId === p.entry.id)) && p.op !== 'removePaper');
    if (libraryOnly.length) parts.push(`library: ${libraryOnly.length}件`);

    // 3) notes：倉庫側と合流（id ごとに新しい方）
    const noteResults = [];
    for (const id of dirtyIds) {
      const rec = this.recs.get(id); if (!rec) { this.dirtyIds.delete(id); continue; }
      if (!liveIds.has(id)) { this.dirtyIds.delete(id); continue; }
      const path = `papers/${id}/notes.json`;
      const snapshot = structuredClone(rec.notes), rev = rec.rev;
      const remoteSha = base.files[path]?.sha;
      let remote = null, merged = snapshot;
      if (remoteSha) { remote = L.normalizeNotes(JSON.parse(await this.textBlob(remoteSha)), id); merged = L.mergeNotes(snapshot, remote); }
      merged = L.pruneNotes(merged);
      const text = L.stringifyJson(merged);
      noteResults.push({ id, rev, merged, remoteSha, same: !!remote && text === L.stringifyJson(L.pruneNotes(remote)) });
      if (!(remote && text === L.stringifyJson(L.pruneNotes(remote)))) { files.push({ path, text }); parts.push(`notes: ${id}`); }
    }
    for (const job of jobs) {
      if (!liveIds.has(job.paperId)) continue;
      for (const f of job.files) {
        if (f.path.endsWith('/notes.json') && (this.dirtyIds.has(job.paperId))) continue;     // 本物のメモが先
        files.push({ path: f.path, blob: f.blob, text: f.text, job });
      }
    }

    // 4) blob を作る（直列・書き込みの間は 1 秒）
    const entries = [], sizes = {};
    let i = 0;
    for (const f of files) {
      i++;
      this.progress = { text: `ファイルを送信中… ${i}/${files.length}${f.blob ? `（${f.path.split('/').pop()} ${(f.blob.size / 1048576).toFixed(1)}MB）` : ''}` }; this.setStatus();
      let sha = f.job?.shas?.[f.path];
      if (!sha) {
        try {
          sha = f.blob ? await api.createBlobBase64(f.blob) : await api.createBlobText(f.text);
        } catch (e) {
          if (e instanceof GitHubError && e.kind === 'toolarge' && f.job) {      // 大きすぎて断られた論文は取り消して、ほかの変更は送り続ける
            await this._failUpload(f.job, e);
            throw new GitHubError('retry', 'アップロードを取り消して続けます');
          }
          throw e;
        }
        if (f.job) { (f.job.shas ||= {})[f.path] = sha; await S.uploadsDb.put(f.job).catch(() => {}); }
      }
      f.sha = sha; f.size = f.blob ? f.blob.size : utf8Len(f.text);
      if (base.files[f.path]?.sha === sha) continue;                  // 倉庫と同じ中身は送らない
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha });
      sizes[f.path] = f.size;
    }
    for (const path of new Set(deletes)) if (base.files[path]) entries.push({ path, mode: '100644', type: 'blob', sha: null });

    // 5) tree → commit → ref
    let commitSha = headSha, treeSha = base.commitTree;
    if (entries.length) {
      this.progress = { text: 'コミットを作成中…' }; this.setStatus();
      treeSha = await api.createTree(base.commitTree, entries);
      const message = (parts.length ? parts.join(' / ') : 'sync') + `（${this.device}）`;
      commitSha = await api.createCommit(message, treeSha, [headSha]);
      await api.updateRef(commitSha);                                // 競合なら GitHubError('conflict') → 呼び出し側が最初からやり直す
    }

    // 6) 後始末：base を新しい状態に、送った分を未送信から外す（途中で設定が変わっていたら、新しい設定の状態を壊さないよう何もしない）
    if ((this.epoch || 0) !== epoch) return;
    const newFiles = { ...base.files };
    for (const e of entries) { if (e.sha === null) delete newFiles[e.path]; else newFiles[e.path] = { sha: e.sha, size: sizes[e.path] }; }
    const libEntry = files.find(f => f.path === 'library.json');
    this.base = { ...base, headSha: commitSha, commitTree: treeSha, files: newFiles, libSha: libEntry ? libEntry.sha : base.libSha, library: newLib || base.library, fetchedAt: Date.now() };
    await S.kv.set('base', this.base).catch(e => this.storageFailed(e));
    const sent = new Set(patches.map(p => p.pid));
    this.patches = this.patches.filter(p => !sent.has(p.pid));
    this.persistPatches();
    for (const r of noteResults) {
      const rec = this.recs.get(r.id); if (!rec) continue;
      rec.remoteSha = newFiles[`papers/${r.id}/notes.json`]?.sha || r.remoteSha;
      if (rec.rev === r.rev) { rec.dirty = false; this.dirtyIds.delete(r.id); }
      if (!L.sameJson(rec.notes, r.merged)) {
        const again = L.mergeNotes(rec.notes, r.merged);                 // 送信中に増えた分を残して他端末の分を取り込む
        const changed = !L.sameJson(again, rec.notes); rec.notes = again;
        if (changed) this.emit('notes', r.id);
      }
      this.persistNotes(rec);
    }
    for (const job of jobs) {
      if (!liveIds.has(job.paperId)) { await S.uploadsDb.del(job.paperId).catch(() => {}); this.uploadIds.delete(job.paperId); continue; }
      for (const f of files.filter(x => x.job === job && x.blob)) await S.blobStore.put(f.sha, f.blob, f.path.endsWith('.pdf') ? 'pdf' : 'thumb').catch(() => {});
      await S.uploadsDb.del(job.paperId).catch(() => {});
      this.uploadIds.delete(job.paperId);
    }
    this.lastCommitAt = Date.now();
    this.rebuildView();
    this.emit('cache');
    this.emit('committed', { head: commitSha, parts });
  }

  /** 送れなかったアップロードを取り消す（ライブラリからも外す） */
  async _failUpload(job, e) {
    await S.uploadsDb.del(job.paperId).catch(() => {}); this.uploadIds.delete(job.paperId);
    this.patches = this.patches.filter(p => !(p.op === 'addPaper' && p.entry.id === job.paperId));
    this.persistPatches(); this.rebuildView();
    this.emit('upload-failed', { paperId: job.paperId, title: job.entry && job.entry.title, message: e.message });
  }

  /** 別の端末が同じ id で別の論文を先に入れていたら、こちらの id を付け替える（上書き事故を防ぐ） */
  async _resolveUploadCollisions(base, jobs, patches) {
    const taken = new Set([...base.library.papers.map(p => p.id), ...jobs.map(j => j.paperId)]);
    for (const job of jobs) {
      const pdfPath = `papers/${job.paperId}/paper.pdf`;
      const remote = base.files[pdfPath]; if (!remote) continue;
      if (job.shas && job.shas[pdfPath] === remote.sha) continue;       // 自分の前回の送信が通っていた（同じ中身）
      if (base.library.papers.some(p => p.id === job.paperId && p.source === job.entry.source)) continue;
      const taken2 = new Set([...taken]); taken2.delete(job.paperId);
      const newId = L.uniqueId(job.paperId.replace(/-\d+$/, ''), new Set([...taken2, ...base.library.papers.map(p => p.id)]));
      if (newId === job.paperId) continue;
      const oldId = job.paperId;
      await S.uploadsDb.del(oldId); this.uploadIds.delete(oldId);
      job.paperId = newId; job.shas = {};
      job.files = job.files.map(f => ({ ...f, path: f.path.replace(`papers/${oldId}/`, `papers/${newId}/`) }));
      job.entry = { ...job.entry, id: newId, file: `papers/${newId}/paper.pdf`, thumb: `papers/${newId}/thumb.jpg` };
      await S.uploadsDb.put(job); this.uploadIds.add(newId);
      for (const p of patches) if (p.op === 'addPaper' && p.entry.id === oldId) p.entry = job.entry;
      this.patches = this.patches.map(p => (p.op === 'addPaper' && p.entry.id === oldId) ? { ...p, entry: job.entry } : p);
      this.persistPatches();
      taken.add(newId);
    }
  }
}
