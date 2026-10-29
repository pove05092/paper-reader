// geom.js : 線の幾何（簡略化・当たり判定・まっすぐ補正）。純粋関数。
// 点は [x, y]（ページ全体に対する比 0〜1）。距離は w×h（ページの実寸 px）に直して測る。

/** 点 p から線分 ab までの距離（px 空間） */
export function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker。epsPx 以内のずれの点を間引く（始点・終点は必ず残す） */
export function simplify(points, w, h, epsPx = 0.6) {
  const n = points.length;
  if (n < 3) return points.slice();
  const px = points.map(p => [p[0] * w, p[1] * h]);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSeg(px[i], px[s], px[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > epsPx) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

export const roundPoints = (points, digits = 4) => {
  const k = 10 ** digits;
  return points.map(p => [Math.round(p[0] * k) / k, Math.round(p[1] * k) / k]);
};

/** 始点と終点を結ぶ直線にする。水平から snapDeg 度以内なら水平にそろえる（仕様 §3.3） */
export function straighten(points, w, h, snapDeg = 5) {
  if (points.length < 2) return points.slice();
  const a = points[0];
  let b = points[points.length - 1];
  const dx = (b[0] - a[0]) * w, dy = (b[1] - a[1]) * h;
  if (dx !== 0 || dy !== 0) {
    const ang = Math.abs(Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI);   // 0〜90（水平からの角度）
    if (ang <= snapDeg) b = [b[0], a[1]];
  }
  return [a.slice(), b.slice()];
}

/** 線 stroke が点 (nx,ny)（ページ比）から radiusPx 以内にあるか。w,h は「ページ全体」の実寸 px */
export function strokeHit(stroke, nx, ny, w, h, radiusPx) {
  const pts = stroke.points;
  if (!pts || !pts.length) return false;
  const reach = radiusPx + (stroke.width || 0) * w / 2;
  const p = [nx * w, ny * h];
  if (pts.length === 1) return Math.hypot(pts[0][0] * w - p[0], pts[0][1] * h - p[1]) <= reach;
  let prev = [pts[0][0] * w, pts[0][1] * h];
  for (let i = 1; i < pts.length; i++) {
    const cur = [pts[i][0] * w, pts[i][1] * h];
    if (distToSeg(p, prev, cur) <= reach) return true;
    prev = cur;
  }
  return false;
}
