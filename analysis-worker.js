'use strict';
/* 並列モンテカルロ / ラプラス近似用のワーカー。1 ジョブ = 1 つの cfg で減速落下（通常）と、必要なら弾道落下を計算する */
self.window = self;
importScripts('geo.js', 'physics.js');
self.onmessage = e => {
  const { id, cfg, hard } = e.data;
  try { self.postMessage({ id, r: runCase(cfg, hard) }); }
  catch (err) { self.postMessage({ id, r: { ok: false, err: String(err && err.message || err) } }); }
};
// analysis.js と同じ関数（ワーカー内で使うため複製しない: analysis.js は runCase を文字列化せず、同じ定義をここに持つ）
function runCase(cfg, hard) {
  const M = buildModel(cfg), s = simulate(M, { seed: cfg.__seed || 1, record: false });
  const f = flightSummary(M, s), L = s.ev.landing, P = s.payload && s.payload.landing;
  const r = {
    ok: !s.ev.error && !!L, err: s.ev.error || null,
    apogee: f.apogee_m, railV: f.railExit_V_mps, maxV: f.maxV_mps, maxMach: f.maxMach, maxQ: f.maxQ_Pa, apoT: f.apogee_t_s,
    soft: L ? [L.x, L.y] : null, pay: P ? [P.x, P.y] : null, hard: null,
  };
  if (hard) {
    const sh = simulate(M, { seed: cfg.__seed || 1, record: false, ballistic: true });
    if (sh.ev.landing) r.hard = [sh.ev.landing.x, sh.ev.landing.y];
  }
  return r;
}
