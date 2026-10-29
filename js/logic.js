// logic.js : 論文リーダーの純粋なロジック（DOM も通信も持たない）。ブラウザと Node の単体試験の両方から読む。
// 仕様書 §2（データ形式）・§4（同期の規則）に対応。

export const SCHEMA = 1;

// ---------- 時刻・乱数 ----------
export const nowIso = () => new Date().toISOString();
/** ISO 文字列 → ミリ秒。null・不正は「最古」扱い（合流で必ず負ける） */
export function tsOf(s) {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function randomString(n = 6) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < n; i++) s += B36[a[i] % 36];
  return s;
}
/** 線・メモ用の id（例 s-k3j9x2 / n-8f2k1q） */
export function makeItemId(prefix, rand = randomString) { return `${prefix}-${rand(6)}`; }

/** キー順を固定した JSON（合流の同点処理を、どちらの順でも同じ結果にするため） */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
/** 倉庫に書く JSON の書式（仕様 §2.3：差分が読めるよう両者で揃える） */
export const stringifyJson = obj => JSON.stringify(obj, null, 1) + '\n';

// ---------- ファイル名の解析・id 生成（仕様 §2.2 / §2.6） ----------
const JOURNALS = {
  ESS: 'Earth and Space Science', PSJ: 'The Planetary Science Journal',
  JGRPlanets: 'JGR Planets', JGR: 'JGR Planets',            // 仕様の表（Edwards+2011 の JGR は JGR Planets）
  Icarus: 'Icarus', PSS: 'Planetary and Space Science', EPSL: 'EPSL',
  NatCommun: 'Nature Communications', NatureCommun: 'Nature Communications',
  Nature: 'Nature', Science: 'Science', SciAdv: 'Science Advances', NatureAstro: 'Nature Astronomy',
  GRL: 'Geophysical Research Letters', SSR: 'Space Science Reviews', ApJ: 'The Astrophysical Journal',
  MNRAS: 'MNRAS', 'A&A': 'Astronomy & Astrophysics', 'USGS-SIM3292': 'USGS SIM 3292',
};
export function journalName(token, year) {
  if (!token) return '';
  if (JOURNALS[token]) return JOURNALS[token];
  const m = /^LPSC(\d+)$/.exec(token);
  if (m) return year ? `LPSC ${year}（要旨 #${m[1]}）` : `LPSC（要旨 #${m[1]}）`;
  return token;
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const TAIL_TOKENS = [/^v\d+$/i, /^(左右対訳|全訳|原文\+全訳|左原文右要約)$/];
const HEAD_RE = /^([A-Za-z][A-Za-z'’\-]*(?:\+[A-Za-z][A-Za-z'’\-]*)*)(\+)?((?:19|20)\d{2})([a-z])?$/;
const AUTHORS_ONLY_RE = /^[A-Za-z][A-Za-z'’\-]*(?:\+[A-Za-z][A-Za-z'’\-]*)*$/;
const YEAR_RE = /^((?:19|20)\d{2})([a-z])?$/;
const JOURNAL_TOKEN_RE = /^[A-Za-z][A-Za-z0-9&\-]*$/;

/**
 * ファイル名 → 推定。head が null なら「著者+年」の形ではない（id は paper-YYYYMMDD-xxxx にする）。
 * 返り値: { stem, head:{authorsRaw,year,suffix,journalToken}|null, idBase, title, authors, year, journal }
 */
export function parsePaperFilename(name) {
  const base = String(name).replace(/^.*[\\/]/, '').normalize('NFC');
  const stem = base.replace(/\.pdf$/i, '');
  let tokens = stem.split('_');
  while (tokens.length > 1 && TAIL_TOKENS.some(re => re.test(tokens[tokens.length - 1]))) tokens = tokens.slice(0, -1);
  let head = null, used = 0;
  const m = HEAD_RE.exec(tokens[0] || '');
  if (m) { head = { authorsRaw: m[1], plus: !!m[2], year: Number(m[3]), suffix: m[4] || '' }; used = 1; }
  else if (tokens.length >= 2 && AUTHORS_ONLY_RE.test(tokens[0]) && YEAR_RE.test(tokens[1])) {
    const y = YEAR_RE.exec(tokens[1]);
    head = { authorsRaw: tokens[0], plus: false, year: Number(y[1]), suffix: y[2] || '' }; used = 2;
  }
  let journalToken = '';
  if (head && tokens[used] && JOURNAL_TOKEN_RE.test(tokens[used])) { journalToken = tokens[used]; used++; }
  const rest = head ? tokens.slice(used) : tokens;
  const title = rest.length ? rest[0] + (rest.length > 1 ? '：' + rest.slice(1).join(' ') : '') : stem;
  let authors = '', idBase = null, year = null, journal = '';
  if (head) {
    const names = head.authorsRaw.split('+');
    authors = head.plus ? `${names[0]} et al.` : names.length > 1 ? names.join(' & ') : names[0];
    year = head.year;
    journal = journalName(journalToken, year);
    idBase = slug(head.authorsRaw) + head.year + head.suffix + (journalToken ? '-' + slug(journalToken) : '');
  }
  return { stem, head, idBase, title, authors, year, journal };
}
/** 衝突したら -2, -3 … */
export function uniqueId(base, existing) {
  const has = existing instanceof Set ? x => existing.has(x) : x => existing.includes(x);
  if (!has(base)) return base;
  for (let n = 2; ; n++) if (!has(`${base}-${n}`)) return `${base}-${n}`;
}
export function makePaperId(filename, existing, now = new Date(), rand = randomString) {
  const p = parsePaperFilename(filename);
  let base = p.idBase;
  if (!base) {
    const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    base = `paper-${d}-${rand(4)}`;
  }
  return uniqueId(base, existing);
}
/** 見開き判定（仕様 §2.3：幅/高さ > 1.3） */
export const guessLayout = (w, h) => (h > 0 && w / h > 1.3 ? 'spread' : 'single');
/** PDF メタデータの Title が「英文の題名として使える」か */
export function looksLikeEnglishTitle(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (s.length < 8 || s.length > 300) return false;
  if (/\.(pdf|docx?|tex|indd)$/i.test(s) || /^(untitled|microsoft word|slide \d|powerpoint)/i.test(s) || /_/.test(s)) return false;
  if (/&#x?[0-9a-f]+;/i.test(s) || /[ÂÃâ]/.test(s)) return false;   // 文字化け・HTML 実体の残り
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const nonAscii = (s.match(/[^\x00-\x7f]/g) || []).length;
  return letters >= 6 && nonAscii / s.length < 0.1 && /\s/.test(s);
}

// ---------- notes.json（仕様 §2.4） ----------
export function emptyNotes(paperId) {
  return { schema: SCHEMA, paperId, updatedAt: nowIso(), mySummary: '', mySummaryUpdatedAt: null, strokes: [], notes: [] };
}
/** 外から来た JSON を、落ちないように整える（未知のフィールドは残す） */
export function normalizeNotes(raw, paperId) {
  const n = raw && typeof raw === 'object' ? { ...raw } : {};
  n.schema = SCHEMA;
  n.paperId = n.paperId || paperId;
  n.updatedAt = typeof n.updatedAt === 'string' ? n.updatedAt : nowIso();
  n.mySummary = typeof n.mySummary === 'string' ? n.mySummary : '';
  n.mySummaryUpdatedAt = typeof n.mySummaryUpdatedAt === 'string' ? n.mySummaryUpdatedAt : null;
  n.strokes = (Array.isArray(n.strokes) ? n.strokes : []).filter(s => s && typeof s.id === 'string' && Array.isArray(s.points));
  n.notes = (Array.isArray(n.notes) ? n.notes : []).filter(s => s && typeof s.id === 'string');
  return n;
}
function pickNewer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = tsOf(a.updatedAt), tb = tsOf(b.updatedAt);
  if (ta !== tb) return ta > tb ? a : b;
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;      // 同時刻なら削除を優先（どちらの順でも同じ結果）
  return canon(a) >= canon(b) ? a : b;
}
function mergeById(la, lb) {
  const m = new Map();
  for (const x of [...(la || []), ...(lb || [])]) { if (x && x.id) m.set(x.id, pickNewer(m.get(x.id), x)); }
  return [...m.values()].sort((a, b) => {
    const d = tsOf(a.createdAt) - tsOf(b.createdAt);
    return Number.isNaN(d) || d === 0 ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : d;
  });
}
/** 合流（仕様 §2.4）：id ごとに updatedAt の新しい方。mySummary は mySummaryUpdatedAt の新しい方。a・b は壊さない */
export function mergeNotes(a, b) {
  if (!a && !b) return null;
  if (!a || !b) return structuredClone(a || b);
  const out = { ...structuredClone(b), ...structuredClone(a) };    // 未知のフィールドは両方から残す
  out.schema = SCHEMA;
  out.paperId = a.paperId || b.paperId;
  out.strokes = structuredClone(mergeById(a.strokes, b.strokes));
  out.notes = structuredClone(mergeById(a.notes, b.notes));
  const sa = tsOf(a.mySummaryUpdatedAt), sb = tsOf(b.mySummaryUpdatedAt);
  const sumA = a.mySummary || '', sumB = b.mySummary || '';
  const pickA = sa !== sb ? sa > sb : sumA >= sumB;
  out.mySummary = pickA ? sumA : sumB;
  out.mySummaryUpdatedAt = (pickA ? a.mySummaryUpdatedAt : b.mySummaryUpdatedAt) ?? null;
  out.updatedAt = tsOf(a.updatedAt) >= tsOf(b.updatedAt) ? a.updatedAt : b.updatedAt;
  return out;
}
/** 30 日より古い削除済みを掃除（保存時） */
export function pruneNotes(notes, nowMs = Date.now(), days = 30) {
  const limit = nowMs - days * 86400000;
  const keep = x => !(x.deleted && tsOf(x.updatedAt) < limit);
  return { ...notes, strokes: notes.strokes.filter(keep), notes: notes.notes.filter(keep) };
}
/** 内容が同じか（updatedAt の違いは無視せず、全体の正規化 JSON で比べる） */
export const sameJson = (a, b) => canon(a) === canon(b);

// ---- 編集操作（どれも updatedAt を更新する。端末間の合流のため削除は deleted:true） ----
export function addStroke(notes, s, now = nowIso()) {
  const st = { id: s.id || makeItemId('s'), page: s.page, tool: s.tool, color: s.color, alpha: s.alpha, width: s.width,
    points: s.points, createdAt: now, updatedAt: now, deleted: false };
  notes.strokes.push(st); notes.updatedAt = now; return st;
}
export function setStrokeDeleted(notes, id, deleted, now = nowIso()) {
  const s = notes.strokes.find(x => x.id === id);
  if (!s || !!s.deleted === !!deleted) return null;
  s.deleted = !!deleted; s.updatedAt = now; notes.updatedAt = now; return s;
}
export function addNote(notes, n, now = nowIso()) {
  const nn = { id: n.id || makeItemId('n'), page: n.page, x: n.x, y: n.y, text: n.text || '', color: n.color,
    createdAt: now, updatedAt: now, deleted: false };
  notes.notes.push(nn); notes.updatedAt = now; return nn;
}
export function updateNote(notes, id, patch, now = nowIso()) {
  const n = notes.notes.find(x => x.id === id);
  if (!n) return null;
  Object.assign(n, patch); n.updatedAt = now; notes.updatedAt = now; return n;
}
export function setNoteDeleted(notes, id, deleted, now = nowIso()) {
  const n = notes.notes.find(x => x.id === id);
  if (!n || !!n.deleted === !!deleted) return null;
  n.deleted = !!deleted; n.updatedAt = now; notes.updatedAt = now; return n;
}
export function setMySummary(notes, text, now = nowIso()) {
  notes.mySummary = text; notes.mySummaryUpdatedAt = now; notes.updatedAt = now;
}

// ---------- library.json（仕様 §2.3）とパッチ（§4.2） ----------
export const emptyLibrary = () => ({ schema: SCHEMA, updatedAt: nowIso(), folders: [], papers: [] });
export function normalizeLibrary(raw) {
  const l = raw && typeof raw === 'object' ? { ...raw } : {};
  l.schema = SCHEMA;
  l.updatedAt = typeof l.updatedAt === 'string' ? l.updatedAt : nowIso();
  l.folders = (Array.isArray(l.folders) ? l.folders : []).filter(f => f && typeof f.id === 'string');
  l.papers = (Array.isArray(l.papers) ? l.papers : []).filter(p => p && typeof p.id === 'string');
  return l;
}
/** 取り込み側（B）が更新してよい「機械的な欄」。addPaper が既存 id に当たった時はここだけ上書きする */
export const MACHINE_FIELDS = ['file', 'size', 'pages', 'layout', 'thumb', 'hasAiSummary', 'source', 'updatedAt'];

/** パッチ1件を適用（library は破壊的に変更。呼び出し側で複製しておく） */
export function applyPatch(lib, p) {
  const at = p.at || nowIso();
  switch (p.op) {
    case 'setField': {
      const paper = lib.papers.find(x => x.id === p.id);
      if (paper) { paper[p.key] = p.value; paper.updatedAt = at; }
      break;
    }
    case 'addPaper': {
      const cur = lib.papers.find(x => x.id === p.entry.id);
      if (cur) { for (const k of MACHINE_FIELDS) if (k in p.entry) cur[k] = p.entry[k]; }
      else lib.papers.push(structuredClone(p.entry));
      break;
    }
    case 'removePaper': lib.papers = lib.papers.filter(x => x.id !== p.id); break;
    case 'addFolder': {
      if (!lib.folders.some(f => f.id === p.folder.id)) {
        const order = Math.max(-1, ...lib.folders.map(f => f.order ?? 0)) + 1;
        lib.folders.push({ order, ...p.folder });
      }
      break;
    }
    case 'renameFolder': { const f = lib.folders.find(x => x.id === p.id); if (f) f.name = p.name; break; }
    case 'deleteFolder': {
      lib.folders = lib.folders.filter(x => x.id !== p.id);
      for (const paper of lib.papers) if (paper.folderId === p.id) { paper.folderId = null; paper.updatedAt = at; }
      break;
    }
    default: break;   // 知らない操作は無視（将来の版が積んだものを壊さない）
  }
  lib.updatedAt = at;
  return lib;
}
export function applyPatches(lib, patches) {
  const out = structuredClone(lib);
  for (const p of patches) applyPatch(out, p);
  return out;
}
/** 積んであるパッチの整理：同じ (id,key) の setField は新しい方だけ残す（間に add/remove があれば残す） */
export function coalescePatches(patches, next) {
  if (next.op !== 'setField') return [...patches, next];
  const out = [...patches];
  for (let i = out.length - 1; i >= 0; i--) {
    const q = out[i];
    if ((q.op === 'addPaper' && q.entry.id === next.id) || (q.op === 'removePaper' && q.id === next.id)) break;
    if (q.op === 'setField' && q.id === next.id && q.key === next.key) { out.splice(i, 1); break; }
  }
  out.push(next);
  return out;
}

// ---------- 一覧の絞り込み・並べ替え ----------
export function searchMatch(p, q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [p.title, p.titleOriginal, p.authors, p.journal, String(p.year ?? ''), ...(p.tags || [])].join('\n').toLowerCase();
  return terms.every(t => hay.includes(t));
}
export function filterPapers(papers, { folder = 'all', status = 'all', q = '', tags = [] } = {}) {
  return papers.filter(p =>
    (folder === 'all' || (folder === 'none' ? !p.folderId : p.folderId === folder)) &&
    (status === 'all' || p.status === status) && hasAllTags(p, tags) && searchMatch(p, q));
}

// ---------- タグ（v2・2026-10-29） ----------
// 保存の形は今までどおり、論文の tags 欄（文字列の配列）。タグという別の台帳は持たない＝名前を変える・消すは「付いている論文の tags を書き換える」操作。
export const TAG_MAX_LEN = 30;
/** 付ける名前の整え方：空白をそろえて前後を落とし、30 字まで */
export const cleanTag = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX_LEN);
/** 同じタグとみなす鍵：全角半角・大文字小文字・空白の違いは無視（「Mars」と「mars」、「ＣＴＸ」と「CTX」） */
export const tagKey = s => cleanTag(String(s ?? '').normalize('NFKC')).toLowerCase();
/** 入力欄の文字列をタグに割る（カンマ「,」「、」「，」と改行で区切る） */
export const parseTagInput = str => uniqueTags(String(str ?? '').split(/[,、，\n]/));
/** 整えて、同じタグ（tagKey が同じ）の重複を落とす。先に出た表記を残す */
export function uniqueTags(list) {
  const seen = new Set(), out = [];
  for (const t of list || []) { const c = cleanTag(t), k = tagKey(c); if (!k || seen.has(k)) continue; seen.add(k); out.push(c); }
  return out;
}
export const hasTag = (p, name) => (p.tags || []).some(t => tagKey(t) === tagKey(name));
export const hasAllTags = (p, names) => !names || !names.length || names.every(n => hasTag(p, n));
/** 全論文のタグの一覧 [{ name, count }]。表記ゆれは一つにまとめ、名前は一番多い表記（同数なら先に出た方）。多い順→五十音順 */
export function tagList(papers) {
  const m = new Map();
  for (const p of papers) {
    for (const t of uniqueTags(p.tags)) {
      const k = tagKey(t); let e = m.get(k);
      if (!e) { e = { count: 0, forms: new Map() }; m.set(k, e); }
      e.count++; e.forms.set(t, (e.forms.get(t) || 0) + 1);
    }
  }
  const out = [];
  for (const e of m.values()) {
    let best = null, bn = -1;
    for (const [f, n] of e.forms) if (n > bn) { best = f; bn = n; }
    out.push({ name: best, count: e.count });
  }
  return out.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'ja'));
}
/** 既にある同じタグの表記があればそれに合わせる（「mars」と打っても既存の「Mars」になる）。無ければ整えた名前 */
export function canonicalTag(papers, name) {
  const c = cleanTag(name), k = tagKey(c);
  const f = tagList(papers).find(t => tagKey(t.name) === k);
  return f ? f.name : c;
}
/** 以下は「論文ごとの新しい tags」のリスト [{ id, tags }] を返す（変わる論文だけ）。適用は engine.setTags で1件ずつ */
export function addTagChanges(papers, ids, name) {
  const n = canonicalTag(papers, name); if (!tagKey(n)) return [];
  const want = new Set(ids), out = [];
  for (const p of papers) if (want.has(p.id) && !hasTag(p, n)) out.push({ id: p.id, tags: uniqueTags([...(p.tags || []), n]) });
  return out;
}
export function removeTagChanges(papers, ids, name) {
  const want = ids ? new Set(ids) : null, out = [];
  for (const p of papers) if ((!want || want.has(p.id)) && hasTag(p, name)) out.push({ id: p.id, tags: uniqueTags((p.tags || []).filter(t => tagKey(t) !== tagKey(name))) });
  return out;
}
/** 名前の変更。変更先が別の既存タグと同じなら統合（その表記に合わせる）。大文字小文字だけの変更は、打った表記にする */
export function renameTagChanges(papers, from, to) {
  const fk = tagKey(from), c = cleanTag(to); if (!tagKey(c)) return [];
  const toName = tagKey(c) === fk ? c : canonicalTag(papers, c), out = [];
  for (const p of papers) {
    if (!hasTag(p, from)) continue;
    const next = uniqueTags((p.tags || []).map(t => (tagKey(t) === fk ? toName : t)));
    if (JSON.stringify(next) !== JSON.stringify(p.tags || [])) out.push({ id: p.id, tags: next });
  }
  return out;
}
export const deleteTagChanges = (papers, name) => removeTagChanges(papers, null, name);
export function sortPapers(papers, key = 'recent') {
  const a = [...papers];
  const t = s => tsOf(s);
  const title = (x, y) => String(x.title || '').localeCompare(String(y.title || ''), 'ja');
  if (key === 'added') a.sort((x, y) => (t(y.addedAt) - t(x.addedAt)) || title(x, y));
  else if (key === 'year') a.sort((x, y) => ((y.year || 0) - (x.year || 0)) || title(x, y));
  else if (key === 'title') a.sort(title);
  else a.sort((x, y) => {
    const ox = t(x.lastOpenedAt), oy = t(y.lastOpenedAt);
    if (ox !== oy) return oy > ox ? 1 : -1;                // 最近開いた順（未オープンは後ろ）
    return (t(y.addedAt) - t(x.addedAt)) || title(x, y);
  });
  return a;
}
export const folderCounts = (lib) => {
  const c = { all: lib.papers.length, none: 0 };
  for (const f of lib.folders) c[f.id] = 0;
  for (const p of lib.papers) { if (p.folderId && p.folderId in c) c[p.folderId]++; else c.none++; }
  return c;
};

// ---------- 送信のタイミング（仕様 §4.4） ----------
export const TIMING = { quietMs: 10000, gapMs: 60000, writeGapMs: 1000, pollMs: 60000 };
/** 次に送るまでの待ち時間(ms)。urgent（画面を離れる・閉じる・手動）は待たない */
export function computeSendDelay({ now, lastChangeAt, lastCommitAt, urgent = false, quietMs = TIMING.quietMs, gapMs = TIMING.gapMs }) {
  if (urgent) return 0;
  const q = lastChangeAt == null ? 0 : lastChangeAt + quietMs - now;
  const g = lastCommitAt == null ? 0 : lastCommitAt + gapMs - now;
  return Math.max(0, q, g);
}

// ---------- 表示用 ----------
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}
export const paperPathOf = id => `papers/${id}`;
/** base64 を 3 バイト単位で分割するときの 1 片の大きさ（3 の倍数なので連結して正しい base64 になる） */
export const B64_CHUNK = 3 * 1024 * 1024;
