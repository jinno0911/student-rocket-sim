'use strict';
/* 地形モデル（Magi の dem.cpp を移植）: 国土地理院 標高タイル（テキスト）を取得し、緯度経度から標高を引く。window.Terrain のみ公開
 *  - dem5a（5 m メッシュ, z15）を優先し、無い所は dem（10 m メッシュ, z14）で補う。日本国内のみ
 *  - 取得はネットワーク（prefetch）、参照（height）は取得済みタイルだけを使う同期関数。取れない所は null
 */
window.Terrain = (() => {
  const LAYERS = [['dem5a', 15], ['dem', 14]];
  const tiles = new Map(); // key "layer/z/x/y" → Float32Array(65536)（NaN = データ無し） or null（取得失敗）
  const key = (l, z, x, y) => `${l}/${z}/${x}/${y}`;
  const tileXY = (lat, lon, z) => {
    const n = 2 ** z, la = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
    return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n];
  };
  function parse(text) {
    const out = new Float32Array(256 * 256).fill(NaN), rows = text.trim().split(/\r?\n/);
    for (let j = 0; j < Math.min(rows.length, 256); j++) {
      const v = rows[j].split(',');
      for (let i = 0; i < Math.min(v.length, 256); i++) { const h = parseFloat(v[i]); if (Number.isFinite(h)) out[j * 256 + i] = h; }
    }
    return out;
  }
  async function load(l, z, x, y) {
    const k = key(l, z, x, y);
    if (tiles.has(k)) return tiles.get(k);
    let t = null;
    try {
      const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${l}/${z}/${x}/${y}.txt`);
      if (r.ok) t = parse(await r.text());
    } catch (e) { t = null; }
    tiles.set(k, t);
    return t;
  }
  // 中心 (lat, lon) の半径 radius [m] を覆うタイルを取得。onProgress(done, total)
  async function prefetch(lat, lon, radius = 3000, onProgress) {
    const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    const jobs = [];
    for (const [l, z] of LAYERS) {
      const [x0, y0] = tileXY(lat + dLat, lon - dLon, z), [x1, y1] = tileXY(lat - dLat, lon + dLon, z);
      for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let y = Math.floor(y0); y <= Math.floor(y1); y++) jobs.push([l, z, x, y]);
    }
    if (jobs.length > 400) throw new Error(`範囲が広すぎます（タイル ${jobs.length} 枚）。半径を小さくしてください`);
    let done = 0, ok = 0;
    const queue = jobs.slice(), worker = async () => {
      while (queue.length) { const j = queue.shift(); if (await load(...j)) ok++; done++; onProgress && onProgress(done, jobs.length); }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return { tiles: jobs.length, ok, center: height(lat, lon) };
  }
  // 標高 [m]（バイリニア補間）。取得済みタイルに無ければ null
  function sample(l, z, lat, lon) {
    const [fx, fy] = tileXY(lat, lon, z), px = fx * 256 - 0.5, py = fy * 256 - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py), ax = px - ix, ay = py - iy;
    const at = (X, Y) => {
      const t = tiles.get(key(l, z, Math.floor(X / 256), Math.floor(Y / 256)));
      if (!t) return NaN; // 未取得
      const h = t[(((Y % 256) + 256) % 256) * 256 + (((X % 256) + 256) % 256)];
      return Number.isFinite(h) ? h : 0; // 取得済みタイルの「データ無し（e）」は海面とみなす
    };
    const h00 = at(ix, iy), h10 = at(ix + 1, iy), h01 = at(ix, iy + 1), h11 = at(ix + 1, iy + 1);
    const v = [h00, h10, h01, h11];
    if (v.every(Number.isFinite)) return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    const f = v.filter(Number.isFinite);
    return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
  }
  function height(lat, lon) {
    for (const [l, z] of LAYERS) { const h = sample(l, z, lat, lon); if (h != null) return h; }
    return null;
  }
  const count = () => [...tiles.values()].filter(Boolean).length;
  return { prefetch, height, count, clear: () => tiles.clear() };
})();
