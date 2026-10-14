'use strict';
/* 解析（Magi の advanced.cpp / runner.cpp を移植）。window.Analysis のみ公開
 *  - モンテカルロ: 13 入力のばらつき（一様 ±a または正規 σ=a/√3）、Web Worker で並列、統計・落下楕円・95% 包含円・相関/寄与率・閾値達成率
 *  - ラプラス近似: 公称点まわりの中心差分（2n+1 回）で着地点を線形化 + 2 次の平均補正 → ガウス楕円
 *  - EKF: 公称飛行から IMU・GPS・気圧計を模擬し、拡張カルマンフィルタ（位置3, 速度3, 加速度バイアス3, 気圧計バイアス1）で推定
 *  - 性能閾値の判定、Google Earth 用 KML（速度で色分け・イベント・追従ツアー）
 * physics.js / geo.js の関数と app.js の一部（cfg, model, sim, download, lineChart, prep, nice, frame, fmtN）を呼び出し時に参照する
 */
window.Analysis = (() => {
  // ワーカーはこのスクリプトと同じ場所から読む（test/ など別階層のページからも使えるように）
  const BASE = document.currentScript && document.currentScript.src ? new URL('.', document.currentScript.src).href : '';
  // ---------------- 入力のばらつき（Magi と同じ 13 項目・同じ既定値） ----------------
  const VARS = [
    { k: 'dryMass', l: '乾燥質量', u: '%', a: 2, set: (c, x) => { if (c.massMode === 'hybrid') c.hDryMass *= 1 + x / 100; else c.airMass *= 1 + x / 100; } },
    { k: 'cd', l: 'Cd', u: '%', a: 5, set: (c, x) => { c.cdScale *= 1 + x / 100; } },
    { k: 'cna', l: 'CNα', u: '%', a: 5, set: (c, x) => { c.cnaScale *= 1 + x / 100; } },
    { k: 'thrust', l: '推力', u: '%', a: 5, set: (c, x) => { c.thrustScale *= 1 + x / 100; } },
    { k: 'burn', l: '燃焼時間', u: '%', a: 3, set: (c, x) => { c.burnScale *= 1 + x / 100; } },
    { k: 'wind', l: '風速', u: '%', a: 20, set: (c, x) => { c.wind = Math.max(0, c.wind * (1 + x / 100)); } },
    { k: 'chute', l: 'パラシュート CdS', u: '%', a: 10, set: (c, x) => { c.chuteScale *= 1 + x / 100; } },
    { k: 'cg', l: '乾燥重心（後方を正）', u: 'mm', a: 5, set: (c, x) => { c.cgShift += x; } },
    { k: 'cp', l: '圧力中心（後方を正）', u: 'mm', a: 10, set: (c, x) => { c.cpShift += x; } },
    { k: 'az', l: '発射方位', u: 'deg', a: 1, set: (c, x) => { c.azim += x; } },
    { k: 'el', l: '射角', u: 'deg', a: 1, set: (c, x) => { c.elev = Math.min(90, c.elev + x); } },
    { k: 'wdir', l: '風向', u: 'deg', a: 20, set: (c, x) => { c.windFrom += x; } },
    { k: 'chuteT', l: '開傘タイミング', u: 's', a: 0.5, set: (c, x) => { c.chuteDelay += x; } },
  ];
  const OUTS = [
    ['apogee', '頂点高度', 'm'], ['railV', 'ランチクリア速度', 'm/s'], ['maxV', '最大速度', 'm/s'], ['maxMach', '最大マッハ数', '-'],
    ['maxQ', '最大動圧', 'Pa'], ['dSoft', '減速落下 距離', 'm'], ['dHard', '弾道落下 距離', 'm'], ['dPay', 'ペイロード 距離', 'm'],
  ];
  const KINDS = [['soft', '減速落下', '#4fc3f7'], ['hard', '弾道落下', '#ff6b8b'], ['pay', 'ペイロード', '#c58bff']];
  const UNC_KEY = 'student-rocket-sim:unc';

  // ---------------- 小道具 ----------------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const fx = (v, d = 1) => (fin(v) ? v.toFixed(d) : '—');
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  function stat(arr) {
    const a = arr.filter(fin).sort((p, q) => p - q), n = a.length;
    if (!n) return { n: 0 };
    const m = mean(a), sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, n - 1));
    const q = p => { const i = p * (n - 1), lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
    return { n, mean: m, sd, min: a[0], p05: q(0.05), p50: q(0.5), p95: q(0.95), max: a[n - 1] };
  }
  // 共分散から 95% 楕円（χ²(2)=5.991）。theta: 長軸の向き [rad, 東から反時計]
  function ellipseFromCov(see, snn, sen) {
    const tr = see + snn, dt = see * snn - sen * sen, disc = Math.sqrt(Math.max(0, tr * tr / 4 - dt));
    const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc), k2 = 5.991464547;
    return { a95: Math.sqrt(k2 * l1), b95: Math.sqrt(k2 * l2), theta: 0.5 * Math.atan2(2 * sen, see - snn), l1, l2, sdE: Math.sqrt(Math.max(see, 0)), sdN: Math.sqrt(Math.max(snn, 0)) };
  }
  function ellipseFromPts(pts) {
    if (pts.length < 3) return null;
    const me = mean(pts.map(p => p[0])), mn = mean(pts.map(p => p[1]));
    let see = 0, snn = 0, sen = 0;
    for (const [e, n] of pts) { see += (e - me) ** 2; snn += (n - mn) ** 2; sen += (e - me) * (n - mn); }
    const k = 1 / (pts.length - 1), E = ellipseFromCov(see * k, snn * k, sen * k);
    const d = pts.map(([e, n]) => Math.hypot(e - me, n - mn)).sort((a, b) => a - b);
    return { ...E, me, mn, n: pts.length, r95: d[Math.floor(0.95 * (d.length - 1))] };
  }
  // ガウス分布の 95% 包含円（固定シードの抽選。Magi と同じ方法）
  function r95Gauss(E, seed) {
    const rnd = mulberry32(seed), c = Math.cos(E.theta), s = Math.sin(E.theta), s1 = Math.sqrt(E.l1), s2 = Math.sqrt(E.l2), d = [];
    for (let i = 0; i < 20000; i++) { const a = s1 * gauss(rnd), b = s2 * gauss(rnd); d.push(Math.hypot(a * c - b * s, a * s + b * c)); }
    d.sort((p, q) => p - q);
    return d[Math.floor(0.95 * (d.length - 1))];
  }
  function pearson(x, y) {
    const n = x.length; if (n < 3) return 0;
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  // ---------------- 1 ケースの計算（analysis-worker.js と同じ内容） ----------------
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
  const outVal = (r, k) => (k === 'dSoft' ? (r.soft ? Math.hypot(...r.soft) : NaN) : k === 'dHard' ? (r.hard ? Math.hypot(...r.hard) : NaN) : k === 'dPay' ? (r.pay ? Math.hypot(...r.pay) : NaN) : r[k]);

  // ---------------- 並列実行（Web Worker。使えない・地形モードのときは本スレッドで分割実行） ----------------
  let pool = null;
  function getPool(n) {
    if (pool && pool.n === n) return pool;
    if (pool) pool.ws.forEach(w => w.terminate());
    pool = null;
    try {
      if (!window.Worker || location.protocol === 'file:' || window.ANALYSIS_NO_WORKER) return null; // ヘッドレス試験などでは本スレッド
      const ws = Array.from({ length: n }, () => new Worker(BASE + 'analysis-worker.js'));
      pool = { n, ws };
    } catch (e) { pool = null; }
    return pool;
  }
  function threadsAuto(t) { const hc = navigator.hardwareConcurrency || 4; return Math.max(1, Math.min(16, t > 0 ? t : hc - 1)); }
  // jobs: [{cfg, hard}] → 結果配列。onProgress(done, total), ctl.cancel で中止
  async function runJobs(jobs, threads, onProgress, ctl) {
    const out = new Array(jobs.length);
    let done = 0;
    const useMain = jobs.some(j => j.cfg.landSurface === 'terrain'); // 地形タイルは本スレッドにしか無い
    const P = useMain ? null : getPool(threadsAuto(threads));
    if (!P) {
      for (let i = 0; i < jobs.length; i++) {
        if (ctl.cancel) break;
        out[i] = runCase(jobs[i].cfg, jobs[i].hard); done++;
        if (i % 4 === 3) { onProgress(done, jobs.length, 1); await new Promise(r => setTimeout(r)); }
      }
      onProgress(done, jobs.length, 1);
      return out;
    }
    let next = 0;
    await new Promise(resolve => {
      let active = 0;
      const feed = w => {
        if (ctl.cancel || next >= jobs.length) { if (active === 0) resolve(); return; }
        const i = next++; active++;
        w.onmessage = e => { out[e.data.id] = e.data.r; done++; active--; onProgress(done, jobs.length, P.n); feed(w); };
        w.onerror = () => { out[i] = runCase(jobs[i].cfg, jobs[i].hard); done++; active--; feed(w); };
        w.postMessage({ id: i, cfg: jobs[i].cfg, hard: jobs[i].hard });
      };
      P.ws.forEach(feed);
    });
    return out;
  }

  // ---------------- モンテカルロ ----------------
  // base: normalizeCfg 済み cfg、unc: {k: a}, opt: {n, seed, dist:'uniform'|'normal', hard, threads}
  async function runMC(base, unc, opt, onProgress, ctl) {
    const t0 = performance.now(), rnd = mulberry32(opt.seed >>> 0 || 1);
    const draws = [], jobs = [];
    for (let i = 0; i < opt.n; i++) { // 乱数は先にすべて抽選（スレッド数に依存しない）
      const x = VARS.map(v => { const a = +unc[v.k] || 0; return a <= 0 ? 0 : opt.dist === 'normal' ? a / Math.sqrt(3) * gauss(rnd) : a * (2 * rnd() - 1); });
      const c = { ...base, gust: base.gust, __seed: 1000 + i };
      VARS.forEach((v, j) => x[j] && v.set(c, x[j]));
      draws.push(x); jobs.push({ cfg: c, hard: opt.hard });
    }
    const res = await runJobs(jobs, opt.threads, onProgress, ctl);
    const cases = res.map((r, i) => ({ x: draws[i], r })).filter(o => o.r);
    const ok = cases.filter(o => o.r.ok);
    const stats = Object.fromEntries(OUTS.map(([k]) => [k, stat(ok.map(o => outVal(o.r, k)))]));
    const ell = {};
    for (const [k] of KINDS) { const pts = ok.map(o => o.r[k]).filter(Boolean); if (pts.length >= 3) ell[k] = { ...ellipseFromPts(pts), pts }; }
    // 入力 × 出力 の相関と寄与率（相関の 2 乗を出力ごとに 100% に正規化）
    const corr = VARS.map((v, i) => OUTS.map(([k]) => {
      const pair = ok.map(o => [o.x[i], outVal(o.r, k)]).filter(p => fin(p[1]));
      return (+unc[v.k] || 0) > 0 ? pearson(pair.map(p => p[0]), pair.map(p => p[1])) : 0;
    }));
    const contrib = corr.map(row => row.slice());
    OUTS.forEach((_, j) => { const s = corr.reduce((a, row) => a + row[j] ** 2, 0); corr.forEach((row, i) => { contrib[i][j] = s > 0 ? 100 * row[j] ** 2 / s : 0; }); });
    const th = thresholdRates(base, ok.map(o => o.r));
    return { n: opt.n, done: cases.length, nOk: ok.length, failed: cases.length - ok.length, cancelled: !!ctl.cancel, stats, ell, corr, contrib, th, cases,
      ms: performance.now() - t0, threads: pool ? pool.n : 1 };
  }

  // ---------------- ラプラス近似 ----------------
  async function runLaplace(base, unc, opt, onProgress, ctl) {
    const t0 = performance.now(), act = VARS.map((v, i) => ({ v, i, a: +unc[v.k] || 0 })).filter(o => o.a > 0);
    const jobs = [{ cfg: { ...base }, hard: opt.hard }];
    for (const o of act) for (const sg of [1, -1]) { const c = { ...base }; o.v.set(c, sg * 0.5 * o.a); jobs.push({ cfg: c, hard: opt.hard }); }
    const res = await runJobs(jobs, opt.threads, onProgress, ctl);
    const nom = res[0], out = { evals: jobs.length, kinds: {}, sigma: act.map(o => ({ k: o.v.k, l: o.v.l, s: o.a / Math.sqrt(3) })) };
    if (!nom || !nom.ok) return { ...out, err: '公称ケースが計算できませんでした' };
    KINDS.forEach(([k], ki) => {
      const p0 = nom[k]; if (!p0) return;
      let see = 0, snn = 0, sen = 0, me = 0, mn = 0, tot = 0; const grads = [];
      for (let j = 0; j < act.length; j++) {
        const rp = res[1 + 2 * j], rm = res[2 + 2 * j];
        if (!rp || !rm || !rp[k] || !rm[k]) return;
        const h = 0.5 * act[j].a, v = (act[j].a / Math.sqrt(3)) ** 2;
        const ge = (rp[k][0] - rm[k][0]) / (2 * h), gn = (rp[k][1] - rm[k][1]) / (2 * h);
        const de = (rp[k][0] + rm[k][0] - 2 * p0[0]) / (h * h), dn = (rp[k][1] + rm[k][1] - 2 * p0[1]) / (h * h);
        see += v * ge * ge; snn += v * gn * gn; sen += v * ge * gn; me += 0.5 * de * v; mn += 0.5 * dn * v;
        const share = v * (ge * ge + gn * gn); tot += share;
        grads.push({ k: act[j].v.k, l: act[j].v.l, u: act[j].v.u, ge, gn, share });
      }
      grads.forEach(g => { g.share = tot > 1e-12 ? 100 * g.share / tot : 0; });
      const E = ellipseFromCov(see, snn, sen);
      out.kinds[k] = { ...E, e0: p0[0], n0: p0[1], me: p0[0] + me, mn: p0[1] + mn, r95: r95Gauss(E, 12345 + ki), grads };
    });
    out.ms = performance.now() - t0;
    return out;
  }

  // ---------------- 性能閾値 ----------------
  const TH = [
    ['thMinApogee', '最低頂点高度', 'm', r => r.apogee, (v, l) => v >= l],
    ['thMaxQ', '最大動圧の上限', 'Pa', r => r.maxQ, (v, l) => v <= l],
    ['thMinRailV', '最低ランチクリア速度', 'm/s', r => r.railV, (v, l) => v >= l],
    ['thMaxRange', '着地点距離の上限', 'm', r => Math.max(...['soft', 'hard', 'pay'].map(k => (r[k] ? Math.hypot(...r[k]) : 0))), (v, l) => v <= l],
  ];
  // 公称 1 ケース（flightSummary から）の判定
  function thresholds(c, fs) {
    const r = { apogee: fs.apogee_m, maxQ: fs.maxQ_Pa, railV: fs.railExit_V_mps, soft: null, hard: null, pay: null };
    const dist = Math.max(fin(fs.landing_dist_m) ? fs.landing_dist_m : 0, fin(fs.payloadLanding_dist_m) ? fs.payloadLanding_dist_m : 0);
    return TH.filter(([k]) => c[k] > 0).map(([k, l, u, get, okf]) => {
      const v = k === 'thMaxRange' ? dist : get(r);
      return { k, l, u, limit: c[k], value: v, ok: fin(v) && okf(v, c[k]) };
    });
  }
  function thresholdRates(c, rs) {
    const act = TH.filter(([k]) => c[k] > 0);
    if (!act.length || !rs.length) return null;
    const per = act.map(([k, l, u, get, okf]) => ({ k, l, u, limit: c[k], rate: 100 * rs.filter(r => { const v = get(r); return fin(v) && okf(v, c[k]); }).length / rs.length }));
    const all = 100 * rs.filter(r => act.every(([k, , , get, okf]) => { const v = get(r); return fin(v) && okf(v, c[k]); })).length / rs.length;
    return { per, all };
  }

  // ---------------- EKF（Magi run_ekf の移植。座標は射点 NED） ----------------
  const EKF_DEF = { imuHz: 100, accNoise: 0.2, accBias: 0.08, accRange: 16, gpsHz: 10, gpsSigma: 2.5, gpsVSigma: 0.3, gpsMaxV: 515, gpsMaxAlt: 18000, baroHz: 25, baroSigma: 20, baroBias: 30, seed: 7 };
  function runEKF(M, sim, o) {
    const rec = sim.rec.filter(r => Number.isFinite(r.z));
    if (rec.length < 20) return { err: '飛行データがありません' };
    // 記録（不等間隔）から速度・加速度を作り、IMU 周期で線形補間する
    const tR = rec.map(r => r.t), N = rec.length;
    const pR = rec.map(r => [r.y, r.x, -r.z]), vR = rec.map(r => [r.vy, r.vx, -r.vz]);
    const aR = rec.map((_, i) => { const lo = Math.max(0, i - 1), hi = Math.min(N - 1, i + 1), dt = tR[hi] - tR[lo]; return [0, 1, 2].map(c => (dt > 1e-9 ? (vR[hi][c] - vR[lo][c]) / dt : 0)); });
    const dtI = 1 / o.imuHz, ts = []; for (let t = tR[0]; t <= tR[N - 1] + 1e-9; t += dtI) ts.push(t);
    let seg = 0;
    const at = (arr, t) => { while (seg < N - 2 && tR[seg + 1] < t) seg++; while (seg > 0 && tR[seg] > t) seg--; const a = arr[seg], b = arr[Math.min(seg + 1, N - 1)], w = Math.min(1, Math.max(0, (t - tR[seg]) / Math.max(tR[Math.min(seg + 1, N - 1)] - tR[seg], 1e-9))); return [0, 1, 2].map(c => a[c] + (b[c] - a[c]) * w); };
    const rnd = mulberry32(o.seed >>> 0 || 7), Nn = () => gauss(rnd), g0 = G0, h0 = M.siteAlt, isa = window.Geo ? window.Geo.isa1976 : (h => ({ p: atm(M, h).p }));
    const pres = h => isa(Math.max(h, -400)).p;
    const NX = 10, X = new Float64Array(NX), P = Array.from({ length: NX }, () => new Float64Array(NX));
    const bias = [0, 1, 2].map(() => o.accBias * Nn()), baroB = o.baroBias * Nn();
    let p0 = at(pR, ts[0]);
    for (let i = 0; i < 3; i++) { X[i] = p0[i] + o.gpsSigma * Nn(); P[i][i] = o.gpsSigma ** 2; P[3 + i][3 + i] = 0.25; P[6 + i][6 + i] = Math.max(o.accBias ** 2, 1e-6); }
    P[9][9] = Math.max(o.baroBias ** 2, 1e-6);
    const predict = (fm, dt) => {
      const a = [0, 1, 2].map(i => fm[i] - X[6 + i] + (i === 2 ? g0 : 0));
      for (let i = 0; i < 3; i++) { X[i] += X[3 + i] * dt + 0.5 * a[i] * dt * dt; X[3 + i] += a[i] * dt; }
      const F = Array.from({ length: NX }, (_, i) => { const r = new Float64Array(NX); r[i] = 1; return r; });
      for (let i = 0; i < 3; i++) { F[i][3 + i] = dt; F[i][6 + i] = -0.5 * dt * dt; F[3 + i][6 + i] = -dt; }
      const FP = F.map(r => Float64Array.from({ length: NX }, (_, j) => r.reduce((s, v, k) => s + v * P[k][j], 0)));
      const Nm = FP.map(r => Float64Array.from({ length: NX }, (_, j) => r.reduce((s, v, k) => s + v * F[j][k], 0)));
      const qa = Math.max(o.accNoise, 1e-3) ** 2;
      for (let i = 0; i < 3; i++) {
        Nm[i][i] += 0.25 * qa * dt ** 4; Nm[3 + i][3 + i] += qa * dt * dt; Nm[i][3 + i] += 0.5 * qa * dt ** 3; Nm[3 + i][i] += 0.5 * qa * dt ** 3; Nm[6 + i][6 + i] += 1e-6 * dt;
      }
      for (let i = 0; i < NX; i++) P[i] = Nm[i];
    };
    const update = (H, innov, R) => { // スカラー観測（Joseph 形式）
      const PH = Float64Array.from({ length: NX }, (_, i) => P[i].reduce((s, v, j) => s + v * H[j], 0));
      const S = R + H.reduce((s, h, i) => s + h * PH[i], 0); if (S < 1e-12) return;
      const K = PH.map(v => v / S);
      for (let i = 0; i < NX; i++) X[i] += K[i] * innov;
      const IKH = Array.from({ length: NX }, (_, i) => Float64Array.from({ length: NX }, (_, j) => (i === j ? 1 : 0) - K[i] * H[j]));
      const A = IKH.map(r => Float64Array.from({ length: NX }, (_, j) => r.reduce((s, v, k) => s + v * P[k][j], 0)));
      for (let i = 0; i < NX; i++) P[i] = Float64Array.from({ length: NX }, (_, j) => A[i].reduce((s, v, k) => s + v * IKH[j][k], 0) + K[i] * K[j] * R);
    };
    const nees3 = err => {
      const [a, b, c] = [P[0][0], P[0][1], P[0][2]], d = P[1][1], e = P[1][2], g = P[2][2];
      const det = a * (d * g - e * e) - b * (b * g - e * c) + c * (b * e - d * c); if (Math.abs(det) < 1e-30) return 0;
      const i00 = (d * g - e * e) / det, i01 = (c * e - b * g) / det, i02 = (b * e - c * d) / det, i11 = (a * g - c * c) / det, i12 = (b * c - a * e) / det, i22 = (a * d - b * b) / det;
      return err[0] * (i00 * err[0] + i01 * err[1] + i02 * err[2]) + err[1] * (i01 * err[0] + i11 * err[1] + i12 * err[2]) + err[2] * (i02 * err[0] + i12 * err[1] + i22 * err[2]);
    };
    const drP = [X[0], X[1], X[2]], drV = [0, 0, 0], range = o.accRange * g0;
    let nextG = 0, nextB = 0, se = 0, seH = 0, seV = 0, seNG = 0, nNG = 0, seDR = 0, neesS = 0, mx = 0, cnt = 0, nG = 0, nGD = 0, nB = 0;
    const rows = [], keep = Math.max(1, Math.floor(ts.length / 2000));
    for (let e = 0; e < ts.length; e++) {
      const t = ts[e]; seg = 0;
      const p = at(pR, t), v = at(vR, t), a = at(aR, t);
      const fm = [0, 1, 2].map(c => Math.max(-range, Math.min(range, a[c] - (c === 2 ? g0 : 0) + bias[c] + o.accNoise * Nn())));
      if (e > 0) {
        predict(fm, dtI);
        for (let c = 0; c < 3; c++) { const acc = fm[c] + (c === 2 ? g0 : 0); drP[c] += drV[c] * dtI + 0.5 * acc * dtI * dtI; drV[c] += acc * dtI; }
      }
      const speed = Math.hypot(...v), altMsl = h0 - p[2], avail = speed <= o.gpsMaxV && altMsl <= o.gpsMaxAlt;
      let gpsNow = false;
      if (t >= nextG) {
        nextG = t + 1 / o.gpsHz;
        if (avail) {
          gpsNow = true; nG++;
          for (let c = 0; c < 3; c++) { const sg = c === 2 ? 1.5 * o.gpsSigma : o.gpsSigma, H = new Float64Array(NX); H[c] = 1; update(H, p[c] + sg * Nn() - X[c], sg * sg); }
          for (let c = 0; c < 3; c++) { const H = new Float64Array(NX); H[3 + c] = 1; update(H, v[c] + o.gpsVSigma * Nn() - X[3 + c], o.gpsVSigma ** 2); }
        } else nGD++;
      }
      if (t >= nextB) {
        nextB = t + 1 / o.baroHz; nB++;
        const z = pres(altMsl) + baroB + o.baroSigma * Nn(), hx = h0 - X[2], pred = pres(hx) + X[9], dpdh = pres(hx + 0.5) - pres(hx - 0.5);
        const H = new Float64Array(NX); H[2] = -dpdh; H[9] = 1; update(H, z - pred, o.baroSigma ** 2);
      }
      const err = [X[0] - p[0], X[1] - p[1], X[2] - p[2]], e2 = err[0] ** 2 + err[1] ** 2 + err[2] ** 2;
      se += e2; seH += err[0] ** 2 + err[1] ** 2; seV += err[2] ** 2; mx = Math.max(mx, Math.sqrt(e2));
      if (!avail) { seNG += e2; nNG++; }
      seDR += (drP[0] - p[0]) ** 2 + (drP[1] - p[1]) ** 2 + (drP[2] - p[2]) ** 2;
      const ne = nees3(err); neesS += ne; cnt++;
      if (e % keep === 0 || e === ts.length - 1) rows.push({ t, err: Math.sqrt(e2), sig: Math.sqrt(P[0][0] + P[1][1] + P[2][2]), hTrue: -p[2], hEst: -X[2], dr: Math.hypot(drP[0] - p[0], drP[1] - p[1], drP[2] - p[2]), gps: avail, gpsNow, nees: ne });
    }
    const last = rows[rows.length - 1];
    return {
      n: cnt, nG, nGD, nB, rms3: Math.sqrt(se / cnt), rmsH: Math.sqrt(seH / cnt), rmsV: Math.sqrt(seV / cnt), max3: mx, rmsNoGps: nNG ? Math.sqrt(seNG / nNG) : NaN,
      rmsImu: Math.sqrt(seDR / cnt), neesMean: neesS / cnt / 3, finalErr: last.err, biasTrue: bias, biasEst: [X[6], X[7], X[8]], baroBiasTrue: baroB, baroBiasEst: X[9], rows,
    };
  }

  // ---------------- Google Earth 用 KML（単発飛行） ----------------
  function flightKml(M, sim) {
    const G = window.Geo, c = M.c, h0 = c.siteAlt;
    const ll = (x, y, z) => { const g = G ? G.enuToGeodetic(c.lat, c.lon, h0, x, y, z) : { lat: enuToLatLon(c.lat, c.lon, x, y)[0], lon: enuToLatLon(c.lat, c.lon, x, y)[1], h: h0 + z }; return `${g.lon.toFixed(7)},${g.lat.toFixed(7)},${Math.max(g.h, 0).toFixed(1)}`; };
    const rec = sim.rec, vmax = Math.max(...rec.map(r => r.V), 1);
    const col = v => { const k = Math.min(1, v / vmax), r = Math.round(255 * k), b = Math.round(255 * (1 - k)); return `ff${b.toString(16).padStart(2, '0')}40${r.toString(16).padStart(2, '0')}`; }; // aabbggrr
    let segs = '', cur = [], curBin = -1;
    const bin = v => Math.min(9, Math.floor(v / vmax * 10));
    for (const r of rec) {
      const b = bin(r.V), p = ll(r.x, r.y, r.z);
      if (b !== curBin && cur.length) { segs += `<Placemark><styleUrl>#v${curBin}</styleUrl><LineString><extrude>1</extrude><altitudeMode>absolute</altitudeMode><coordinates>${cur.join(' ')} ${p}</coordinates></LineString></Placemark>`; cur = []; }
      curBin = b; cur.push(p);
    }
    if (cur.length > 1) segs += `<Placemark><styleUrl>#v${curBin}</styleUrl><LineString><extrude>1</extrude><altitudeMode>absolute</altitudeMode><coordinates>${cur.join(' ')}</coordinates></LineString></Placemark>`;
    const styles = Array.from({ length: 10 }, (_, i) => `<Style id="v${i}"><LineStyle><color>${col((i + 0.5) / 10 * vmax)}</color><width>4</width></LineStyle><PolyStyle><color>40${col((i + 0.5) / 10 * vmax).slice(2)}</color></PolyStyle></Style>`).join('');
    const ev = sim.ev, near = t => rec.find(r => r.t >= t) || rec[rec.length - 1];
    const pin = (name, t) => { if (t == null || !rec.length) return ''; const r = near(t); return `<Placemark><name>${esc(name)}</name><description><![CDATA[時刻 ${r.t.toFixed(2)} s<br>高度 ${r.z.toFixed(1)} m<br>速度 ${r.V.toFixed(1)} m/s<br>マッハ ${(r.mach || 0).toFixed(3)}<br>動圧 ${((r.q || 0) / 1000).toFixed(2)} kPa<br>質量 ${(r.m || 0).toFixed(3)} kg]]></description><styleUrl>#pin</styleUrl><Point><extrude>1</extrude><altitudeMode>absolute</altitudeMode><coordinates>${ll(r.x, r.y, r.z)}</coordinates></Point></Placemark>`; };
    let pins = pin('ランチクリア', ev.railExit && ev.railExit.t) + pin('作動終了', ev.burnout && ev.burnout.t) + pin('頂点', ev.apogee && ev.apogee.t)
      + pin('1段目開傘', ev.deploy1 && ev.deploy1.t) + pin('2段目開傘', ev.deploy2 && ev.deploy2.t) + pin('ペイロード放出', ev.payload && ev.payload.t);
    if (ev.landing) pins += `<Placemark><name>着地</name><styleUrl>#land</styleUrl><Point><coordinates>${ll(ev.landing.x, ev.landing.y, ev.landing.z || 0)}</coordinates></Point></Placemark>`;
    const P = sim.payload;
    const payLine = P && P.rec && P.rec.length > 1 ? `<Placemark><name>ペイロード</name><styleUrl>#pay</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>${P.rec.map(r => ll(r.x, r.y, r.z)).join(' ')}</coordinates></LineString></Placemark>` : '';
    const shadow = `<Placemark><name>地上の影</name><styleUrl>#shadow</styleUrl><LineString><altitudeMode>clampToGround</altitudeMode><coordinates>${rec.filter((_, i) => i % 3 === 0).map(r => ll(r.x, r.y, 0)).join(' ')}</coordinates></LineString></Placemark>`;
    // 追従ツアー: 全景 → 離昇 → 頂点 → 着地 → 全景
    const look = (r, range, tilt, dur, heading) => `<gx:FlyTo><gx:duration>${dur}</gx:duration><gx:flyToMode>smooth</gx:flyToMode><LookAt><longitude>${ll(r.x, r.y, r.z).split(',')[0]}</longitude><latitude>${ll(r.x, r.y, r.z).split(',')[1]}</latitude><altitude>${Math.max(h0 + r.z, 0).toFixed(1)}</altitude><heading>${heading}</heading><tilt>${tilt}</tilt><range>${range}</range><altitudeMode>absolute</altitudeMode></LookAt></gx:FlyTo>`;
    const apo = ev.apogee ? near(ev.apogee.t) : rec[0], end = rec[rec.length - 1], span = Math.max(sim.st.apogee || 100, Math.hypot(end.x, end.y), 200);
    const tour = `<gx:Tour><name>▶ 追従ツアー</name><gx:Playlist>${look(apo, span * 3, 65, 3, 0)}${look(rec[0], 150, 75, 3, 0)}${rec.filter(r => r.t <= (ev.apogee ? ev.apogee.t : 10)).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 25)) === 0).map((r, i) => look(r, 120 + r.z * 0.6, 70, 0.4, (i * 4) % 360)).join('')}<gx:Wait><gx:duration>1.5</gx:duration></gx:Wait>${look(end, 250, 70, 4, 90)}${look(apo, span * 3, 60, 3, 0)}</gx:Playlist></gx:Tour>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>${esc(c.name)} 飛行軌跡</name>
<description>student-rocket-sim。軌道は速度で色分け（青=遅い → 赤=速い）。${c.thrustKind === 'assumed' ? '推力履歴は仮定（Isp 170 s）。' : ''}</description>
${styles}<Style id="pin"><IconStyle><scale>0.9</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/ylw-circle.png</href></Icon></IconStyle></Style>
<Style id="land"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle></Style>
<Style id="pay"><LineStyle><color>ffff8bc5</color><width>3</width></LineStyle></Style><Style id="shadow"><LineStyle><color>66000000</color><width>3</width></LineStyle></Style>
${tour}<Folder><name>軌道（速度で色分け）</name>${segs}</Folder>${payLine}${shadow}<Folder><name>イベント</name>${pins}
<Placemark><name>射点</name><Point><coordinates>${c.lon},${c.lat},0</coordinates></Point></Placemark></Folder></Document></kml>`;
  }

  // ================= UI =================
  const CSS = `
#tab-mc .an-grid,#tab-ekf .an-grid{display:grid;grid-template-columns:1fr;gap:10px}
@media(min-width:900px){#tab-mc .an-grid,#tab-ekf .an-grid{grid-template-columns:1fr 1fr}}
#tab-mc table.an-t,#tab-ekf table.an-t{border-collapse:collapse;font-size:12px;width:100%}
#tab-mc .an-t th,#tab-mc .an-t td,#tab-ekf .an-t th,#tab-ekf .an-t td{border-bottom:1px solid var(--line);padding:3px 6px;text-align:right;white-space:nowrap}
#tab-mc .an-t th:first-child,#tab-mc .an-t td:first-child,#tab-ekf .an-t td:first-child{text-align:left}
#tab-mc .an-scroll{overflow-x:auto}
#tab-mc .an-unc input{width:80px}
#tab-mc canvas.an-map{height:420px}
#tab-ekf canvas{height:240px}
#tab-mc .an-heat td{color:#0b1020}
#tab-mc .an-bar{display:inline-block;height:9px;background:var(--blue);border-radius:2px;vertical-align:middle;margin-right:4px}`;
  let styled = false;
  const style = () => { if (styled) return; styled = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); };
  const loadUnc = () => { try { const v = JSON.parse(localStorage.getItem(UNC_KEY)); if (v) return v; } catch (e) {} return null; };
  let mcState = { unc: Object.fromEntries(VARS.map(v => [v.k, v.a])), n: 100, seed: 1, dist: 'uniform', hard: true, lap: true, threads: 0, ...(loadUnc() || {}) };
  const saveUnc = () => { try { localStorage.setItem(UNC_KEY, JSON.stringify(mcState)); } catch (e) {} };
  let mcRes = null, lapRes = null, mcCtl = null, mcStale = false;

  function mountMc(el) {
    style();
    el.innerHTML = `<div class="card"><div class="card-h">モンテカルロ・ラプラス近似（入力のばらつきから落下範囲を見積もる）</div>
      <div class="an-grid"><div><div class="muted small">ばらつきの幅 ±a（一様分布。正規分布を選ぶと σ = a/√3）。0 の項目は動かさない</div>
      <table class="an-t an-unc">${VARS.map(v => `<tr><td>${esc(v.l)}</td><td>± <input type="number" step="any" min="0" data-u="${v.k}" value="${mcState.unc[v.k]}"> ${esc(v.u)}</td></tr>`).join('')}</table></div>
      <div><div class="fields mini" style="grid-template-columns:1fr 1fr">
        <label class="field"><span>試行回数</span><input type="number" id="anN" min="1" max="20000" value="${mcState.n}"></label>
        <label class="field"><span>乱数シード</span><input type="number" id="anSeed" value="${mcState.seed}"></label>
        <label class="field"><span>分布</span><select id="anDist"><option value="uniform">一様 ±a</option><option value="normal">正規 σ=a/√3</option></select></label>
        <label class="field"><span>並列スレッド数（0=自動）</span><input type="number" id="anThr" min="0" max="16" value="${mcState.threads}"></label>
        <label class="field check"><input type="checkbox" id="anHard"${mcState.hard ? ' checked' : ''}><span>弾道落下も計算する</span></label>
        <label class="field check"><input type="checkbox" id="anLap"${mcState.lap ? ' checked' : ''}><span>ラプラス近似も計算する（2n+1 回）</span></label>
      </div>
      <div class="row"><button class="primary" id="anRun">モンテカルロ実行</button><button id="anLapOnly">ラプラス近似のみ</button><button id="anStop" disabled>中止</button></div>
      <div id="anProg" class="muted small"></div><div id="anStale" class="muted small"></div></div></div>
      <canvas class="an-map" id="anMap"></canvas><div id="anOut"></div></div>`;
    el.querySelector('#anDist').value = mcState.dist;
    el.addEventListener('input', e => {
      const u = e.target.dataset && e.target.dataset.u;
      if (u) mcState.unc[u] = Math.max(0, parseFloat(e.target.value) || 0);
      mcState.n = Math.max(1, Math.min(20000, +el.querySelector('#anN').value | 0)); mcState.seed = +el.querySelector('#anSeed').value | 0;
      mcState.dist = el.querySelector('#anDist').value; mcState.threads = +el.querySelector('#anThr').value | 0;
      mcState.hard = el.querySelector('#anHard').checked; mcState.lap = el.querySelector('#anLap').checked; saveUnc();
    });
    el.addEventListener('change', e => el.dispatchEvent(new Event('input')));
    el.querySelector('#anRun').addEventListener('click', () => go(el, true));
    el.querySelector('#anLapOnly').addEventListener('click', () => go(el, false));
    el.querySelector('#anStop').addEventListener('click', () => { if (mcCtl) mcCtl.cancel = true; });
  }
  async function go(el, doMc) {
    if (mcCtl) return;
    const base = normalizeCfg(cfg), ctl = mcCtl = { cancel: false }, t0 = performance.now();
    const prog = el.querySelector('#anProg'), btns = ['#anRun', '#anLapOnly'].map(s => el.querySelector(s));
    btns.forEach(b => (b.disabled = true)); el.querySelector('#anStop').disabled = false; el.querySelector('#anStale').textContent = '';
    const show = (what, d, n, th) => { const el2 = (performance.now() - t0) / 1000, rate = d / Math.max(el2, 1e-3); prog.textContent = `${what}: ${d}/${n}（${th} スレッド）| ${Math.round(100 * d / n)}% | 経過 ${el2.toFixed(1)} s | 残り約 ${((n - d) / Math.max(rate, 1e-9)).toFixed(1)} s | ${rate.toFixed(1)} 回/秒`; };
    try {
      mcRes = doMc ? await runMC(base, mcState.unc, mcState, (d, n, th) => show('モンテカルロ', d, n, th), ctl) : null;
      lapRes = (!doMc || mcState.lap) && !ctl.cancel ? await runLaplace(base, mcState.unc, mcState, (d, n, th) => show('ラプラス近似', d, n, th), ctl) : null;
      prog.textContent = ctl.cancel ? '中止しました' : `完了（${((performance.now() - t0) / 1000).toFixed(1)} s${mcRes ? `、${(mcRes.done / (mcRes.ms / 1000)).toFixed(1)} 回/秒、${mcRes.threads} スレッド` : ''}）`;
      mcStale = false; render(el, base);
    } catch (e) { prog.textContent = 'エラー: ' + e.message; console.error(e); }
    mcCtl = null; btns.forEach(b => (b.disabled = false)); el.querySelector('#anStop').disabled = true;
  }
  function render(el, base) {
    drawMap(el.querySelector('#anMap'));
    const o = [], M = mcRes, Lp = lapRes;
    if (base && base.thrustKind === 'assumed') o.push('<div class="w warn">⚠ 推力履歴は仮定（Isp 170 s）。審査提出には地上燃焼試験の推力履歴を使用すること</div>');
    if (M) {
      o.push(`<div class="muted small">試行 ${M.done}/${M.n}（着地まで計算できたもの ${M.nOk}、失敗 ${M.failed}）${M.cancelled ? '・途中で中止' : ''}</div>`);
      o.push('<div class="card-h">出力の統計</div><div class="an-scroll"><table class="an-t"><tr><th>項目</th><th>平均</th><th>σ</th><th>最小</th><th>5%</th><th>中央値</th><th>95%</th><th>最大</th></tr>'
        + OUTS.map(([k, l, u]) => { const s = M.stats[k]; return s.n ? `<tr><td>${l} [${u}]</td>${['mean', 'sd', 'min', 'p05', 'p50', 'p95', 'max'].map(q => `<td>${fx(s[q], k === 'maxMach' ? 3 : 1)}</td>`).join('')}</tr>` : ''; }).join('') + '</table></div>');
      if (M.th) o.push(`<div class="card-h">性能閾値の達成率</div><table class="an-t">${M.th.per.map(p => `<tr><td>${p.l}（${p.limit} ${p.u}）</td><td>${p.rate.toFixed(1)} %</td></tr>`).join('')}<tr><td><b>すべて満たす</b></td><td><b>${M.th.all.toFixed(1)} %</b></td></tr></table>`);
    }
    // 落下楕円の比較
    const rows = KINDS.map(([k, l]) => {
      const e = M && M.ell[k], q = Lp && Lp.kinds && Lp.kinds[k];
      if (!e && !q) return '';
      const c = (E, mE, mN) => (E ? `<td>${fx(mE, 0)}, ${fx(mN, 0)}</td><td>${fx(E.a95, 0)} × ${fx(E.b95, 0)}</td><td>${fx(E.r95, 0)}</td>` : '<td>—</td><td>—</td><td>—</td>');
      return `<tr><td>${l}</td>${c(e, e && e.me, e && e.mn)}${c(q, q && q.me, q && q.mn)}</tr>`;
    }).join('');
    if (rows) o.push(`<div class="card-h">落下範囲（95%）: モンテカルロとラプラス近似</div><div class="an-scroll"><table class="an-t"><tr><th>対象</th><th>MC 平均 東,北 [m]</th><th>MC 楕円 長×短 [m]</th><th>MC 95%円 [m]</th><th>ラプラス 平均 東,北</th><th>ラプラス 楕円</th><th>ラプラス 95%円</th></tr>${rows}</table></div>
      ${Lp ? `<div class="muted small">ラプラス近似: ${Lp.evals} 回の計算${Lp.ms ? `（${(Lp.ms / 1000).toFixed(1)} s）` : ''}。公称点まわりの線形化と 2 次補正。非線形性が強い条件（強風など）ではモンテカルロとずれます</div>` : ''}`);
    // ラプラス: 分散への寄与
    const lk = Lp && Lp.kinds && (Lp.kinds.soft || Lp.kinds.hard);
    if (lk) o.push(`<div class="card-h">着地点の分散への寄与（ラプラス近似・${Lp.kinds.soft ? '減速落下' : '弾道落下'}）</div><table class="an-t"><tr><th>入力</th><th>∂東/∂x</th><th>∂北/∂x</th><th>寄与率</th></tr>${lk.grads.slice().sort((a, b) => b.share - a.share).map(g => `<tr><td>${esc(g.l)}</td><td>${g.ge.toFixed(2)} m/${esc(g.u)}</td><td>${g.gn.toFixed(2)} m/${esc(g.u)}</td><td style="text-align:left"><span class="an-bar" style="width:${(g.share * 1.2).toFixed(0)}px"></span>${g.share.toFixed(1)} %</td></tr>`).join('')}</table>`);
    // MC: 相関・寄与率のヒートマップ
    if (M && M.nOk > 3) {
      const heat = v => `background:hsl(${v >= 0 ? 200 : 350},80%,${100 - Math.min(1, Math.abs(v)) * 45}%)`;
      o.push(`<div class="card-h">入力と出力の相関係数（モンテカルロ）</div><div class="an-scroll"><table class="an-t an-heat"><tr><th>入力＼出力</th>${OUTS.map(([, l]) => `<th>${l}</th>`).join('')}</tr>${VARS.map((v, i) => `<tr><td style="color:var(--fg)">${esc(v.l)}</td>${OUTS.map((_, j) => `<td style="${heat(M.corr[i][j])}">${M.corr[i][j].toFixed(2)}</td>`).join('')}</tr>`).join('')}</table></div>`);
      o.push(`<div class="card-h">寄与率 [%]（相関係数の 2 乗を出力ごとに 100% に正規化）</div><div class="an-scroll"><table class="an-t"><tr><th>入力＼出力</th>${OUTS.map(([, l]) => `<th>${l}</th>`).join('')}</tr>${VARS.map((v, i) => `<tr><td>${esc(v.l)}</td>${OUTS.map((_, j) => `<td>${M.contrib[i][j].toFixed(1)}</td>`).join('')}</tr>`).join('')}</table></div>`);
      o.push('<div class="row"><button id="anCsv">試行結果 CSV</button></div>');
    }
    const out = el.querySelector('#anOut'); out.innerHTML = o.join('');
    const b = out.querySelector('#anCsv');
    if (b) b.addEventListener('click', () => {
      const head = ['run', ...VARS.map(v => `${v.k}_${v.u}`), 'ok', 'apogee_m', 'railV_mps', 'maxV_mps', 'maxMach', 'maxQ_Pa', 'soft_e', 'soft_n', 'hard_e', 'hard_n', 'pay_e', 'pay_n'];
      const lines = mcRes.cases.map((c, i) => [i + 1, ...c.x.map(v => +v.toFixed(5)), c.r.ok ? 1 : 0, c.r.apogee, c.r.railV, c.r.maxV, c.r.maxMach, c.r.maxQ, ...(c.r.soft || ['', '']), ...(c.r.hard || ['', '']), ...(c.r.pay || ['', ''])].map(v => (typeof v === 'number' ? +v.toFixed(3) : v)).join(','));
      download('montecarlo.csv', [head.join(','), ...lines].join('\n'), 'text/csv');
    });
  }
  function drawMap(cv) {
    if (!cv || (!mcRes && !lapRes)) return;
    const { ctx, w, h } = prep(cv), pts = [[0, 0]];
    KINDS.forEach(([k]) => { const e = mcRes && mcRes.ell[k]; if (e) pts.push(...e.pts); const q = lapRes && lapRes.kinds && lapRes.kinds[k]; if (q) pts.push([q.me + q.a95, q.mn + q.a95], [q.me - q.a95, q.mn - q.a95]); });
    let x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
    const m = Math.max(x1 - x0, y1 - y0, 50) * 0.08, pad = { pl: 50, pr: 12, pt: 20, pb: 30 };
    const { xr, yr } = equalRanges(w, h, x0 - m, x1 + m, y0 - m, y1 + m, pad), F = gridFrame(ctx, w, h, xr, yr, pad, '東 [m] →');
    ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'left'; ctx.fillText('↑ 北 [m]　● 試行の着地点　実線: モンテカルロ 95% 楕円　破線: ラプラス近似 95% 楕円　点線: 95% 包含円', 4, 14);
    const sc = F.X(1) - F.X(0);
    const ell = (cx, cy, a, b, th, color, dash) => { ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath(); ctx.ellipse(F.X(cx), F.Y(cy), Math.max(a * sc, 0.5), Math.max(b * sc, 0.5), -th, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); };
    KINDS.forEach(([k, , col]) => {
      const e = mcRes && mcRes.ell[k];
      if (e) {
        ctx.fillStyle = col + '99'; for (const [x, y] of e.pts) { ctx.beginPath(); ctx.arc(F.X(x), F.Y(y), 2.2, 0, 7); ctx.fill(); }
        ell(e.me, e.mn, e.a95, e.b95, e.theta, col, []); ell(e.me, e.mn, e.r95, e.r95, 0, col, [2, 4]);
      }
      const q = lapRes && lapRes.kinds && lapRes.kinds[k];
      if (q) { ell(q.me, q.mn, q.a95, q.b95, q.theta, col, [7, 4]); ctx.fillStyle = col; ctx.fillRect(F.X(q.me) - 3, F.Y(q.mn) - 3, 6, 6); }
    });
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(F.X(0), F.Y(0), 4, 0, 7); ctx.fill(); ctx.fillText('射点', F.X(0) + 6, F.Y(0) - 4);
    let lx = w - 14; ctx.textAlign = 'right';
    for (const [, l, col] of KINDS.slice().reverse()) { ctx.fillStyle = col; ctx.fillText('● ' + l, lx, h - 36); lx -= ctx.measureText('● ' + l).width + 10; }
  }

  // ---- EKF タブ ----
  let ekfOpt = { ...EKF_DEF }, ekfRes = null;
  const EKF_F = [['imuHz', 'IMU 周波数', 'Hz'], ['accNoise', '加速度ノイズ 1σ', 'm/s²'], ['accBias', '加速度バイアス 1σ', 'm/s²'], ['accRange', 'IMU レンジ', 'G'],
    ['gpsHz', 'GPS 周波数', 'Hz'], ['gpsSigma', 'GPS 位置ノイズ 1σ', 'm'], ['gpsVSigma', 'GPS 速度ノイズ 1σ', 'm/s'], ['gpsMaxV', 'GPS 無効 速度', 'm/s'], ['gpsMaxAlt', 'GPS 無効 高度', 'm'],
    ['baroHz', '気圧計 周波数', 'Hz'], ['baroSigma', '気圧計ノイズ 1σ', 'Pa'], ['baroBias', '気圧計バイアス 1σ', 'Pa'], ['seed', '乱数シード', '']];
  function mountEkf(el) {
    style();
    el.innerHTML = `<div class="card"><div class="card-h">EKF 状態推定（公称飛行から IMU・GPS・気圧計を模擬し、拡張カルマンフィルタで位置・速度を推定）</div>
      <div class="fields mini">${EKF_F.map(([k, l, u]) => `<label class="field"><span>${l}${u ? ` <small>[${u}]</small>` : ''}</span><input type="number" step="any" data-e="${k}" value="${ekfOpt[k]}"></label>`).join('')}</div>
      <div class="row"><button class="primary" id="ekRun">推定を実行</button><button id="ekCsv" disabled>ログ CSV</button><span class="muted small">状態: 位置3・速度3・加速度バイアス3・気圧計バイアス1。GPS は設定速度・高度を超えると無効（IMU＋気圧計のみ）</span></div>
      <div id="ekOut" class="kv"></div><div class="an-grid"><canvas id="ekC1"></canvas><canvas id="ekC2"></canvas></div></div>`;
    el.addEventListener('input', e => { const k = e.target.dataset && e.target.dataset.e; if (k) ekfOpt[k] = parseFloat(e.target.value) || 0; });
    el.querySelector('#ekRun').addEventListener('click', () => {
      if (!model || !sim || !sim.rec.length) return;
      const t0 = performance.now(); ekfRes = runEKF(model, sim, { ...EKF_DEF, ...ekfOpt }); ekfRes.ms = performance.now() - t0; renderEkf(el);
    });
    el.querySelector('#ekCsv').addEventListener('click', () => {
      if (!ekfRes || !ekfRes.rows) return;
      download('ekf_log.csv', ['t_s,err3_m,sigma3_m,alt_true_m,alt_est_m,imu_only_err_m,gps_available,nees', ...ekfRes.rows.map(r => [r.t.toFixed(3), r.err.toFixed(3), r.sig.toFixed(3), r.hTrue.toFixed(2), r.hEst.toFixed(2), r.dr.toFixed(2), r.gps ? 1 : 0, r.nees.toFixed(3)].join(','))].join('\n'), 'text/csv');
    });
  }
  function renderEkf(el) {
    const R = ekfRes, out = el.querySelector('#ekOut');
    if (!R || R.err) { out.textContent = R ? R.err : ''; return; }
    el.querySelector('#ekCsv').disabled = false;
    out.innerHTML = [['位置誤差 RMS（3 軸）', fx(R.rms3, 2) + ' m'], ['水平 RMS', fx(R.rmsH, 2) + ' m'], ['鉛直 RMS', fx(R.rmsV, 2) + ' m'], ['最大誤差', fx(R.max3, 2) + ' m'],
      ['GPS 無効区間の RMS', fin(R.rmsNoGps) ? fx(R.rmsNoGps, 2) + ' m' : 'GPS 無効区間なし'], ['比較: IMU のみ（補正なし）RMS', fx(R.rmsImu, 1) + ' m'], ['最終誤差', fx(R.finalErr, 2) + ' m'],
      ['平均 NEES/3（≈1 で整合）', fx(R.neesMean, 2)], ['IMU / GPS / 気圧', `${R.n} / ${R.nG}（無効 ${R.nGD}）/ ${R.nB}`],
      ['加速度バイアス 真値→推定', R.biasTrue.map((b, i) => `${b.toFixed(3)}→${R.biasEst[i].toFixed(3)}`).join(', ') + ' m/s²'], ['気圧計バイアス 真値→推定', `${R.baroBiasTrue.toFixed(1)}→${R.baroBiasEst.toFixed(1)} Pa`], ['計算時間', fx(R.ms, 0) + ' ms']]
      .map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
    const rows = R.rows;
    lineChart(el.querySelector('#ekC1'), { title: '位置誤差 [m]（3 軸合成）', xlabel: '時間 [s]', yzero: true, series: [
      { name: 'EKF 誤差', color: '#ff9b3d', pts: rows.map(r => [r.t, r.err]) }, { name: '推定 1σ', color: '#7aa2ff', pts: rows.map(r => [r.t, r.sig]) },
      { name: 'GPS 無効', color: '#ff6b8b', pts: rows.map(r => [r.t, r.gps ? NaN : 0]) }] });
    lineChart(el.querySelector('#ekC2'), { title: '高度 [m]（真値と推定）', xlabel: '時間 [s]', yzero: true, series: [
      { name: '真値', color: '#e6ecf8', pts: rows.map(r => [r.t, r.hTrue]) }, { name: 'EKF 推定', color: '#7ee787', pts: rows.map(r => [r.t, r.hEst]) }] });
  }

  return {
    VARS, OUTS, KINDS, runCase, runMC, runLaplace, runEKF, thresholds, thresholdRates, flightKml, ellipseFromPts, ellipseFromCov,
    mountMc, mountEkf,
    markStale() { mcStale = true; const s = document.querySelector('#anStale'); if (s && (mcRes || lapRes)) s.textContent = '設定が変わりました。再計算してください'; ekfRes = null; },
    redraw() { const el = document.querySelector('#tab-mc'); if (el && (mcRes || lapRes)) drawMap(el.querySelector('#anMap')); const ek = document.querySelector('#tab-ekf'); if (ek && ekfRes) renderEkf(ek); },
  };
})();
