'use strict';
/* 落下分散（風速×風向スイープ）・GO/NOGO 表・地図・CSV/KML — 契約 docs/spec-v2.md §5
 * physics.js / app.js のグローバル（cfg, download, normalizeCfg, buildModel, simulate, flightSummary, enuToLatLon, RE）は
 * 呼び出す時点で裸の識別子として参照する。読込時には DOM 操作も他モジュール呼出しもしない。
 * 座標は ENU（x=東, y=真北）。判定もこの平面で行う。
 */
window.Dispersion = (() => {
  const LS_KEY = 'student-rocket-sim:disp';
  const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  const ASSUMED = '推力履歴は仮定（Isp 170 s）。審査提出には地上燃焼試験の推力履歴を使用すること';
  const MODES = ['ballistic', 'recovery', 'payload'];
  const MODE_L = { ballistic: '弾道落下', recovery: '減速落下', payload: 'ペイロード' };
  const DASH = { ballistic: [9, 6], recovery: [], payload: [2, 5] };   // 破線 / 実線 / 点線
  const CSV_H = 'mode,elev_deg,wind_mps,wind_from_true_deg,wind_from_mag_deg,east_m,north_m,lat,lon,dist_m,t_s,v_mps,vz_mps,apogee_m,apogee_t_s,railExit_V_mps,deploy1_dtApo_s,deploy2_dtApo_s,payload_dtApo_s,deploy1_Va_mps,payload_Va_mps,ok';
  const GNG_H = 'elev_deg,wind_from_deg,dir_ref,allowed_max_mps,limiting_mode,limiting_wind_mps';
  const OPT0 = { speeds: '1,2,3,4,5,6,7', nDir: 16, tBal: true, tRec: true, tPay: true, land: 'cfg', elevs: '', zones: [], margin: 0 };

  let opt = null, root = null, visible = false, stale = false, busy = false, cancelReq = false, res = null, mapEi = 0;
  let leafletP = null, leafletOff = false, leafletFail = false, map = null, lyr = null, needFit = true, hits = [], shownT = 0;

  // ---------------- 小物 ----------------
  const D = Math.PI / 180;
  const q = s => root.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const pick = (a, b) => fin(a) ? a : fin(b) ? b : NaN;
  const fx = (v, d = 1) => fin(v) ? v.toFixed(d) : '—';
  const cn = (v, d = 3) => fin(v) ? String(+v.toFixed(d)) : '';
  const n360 = a => +(((a % 360) + 360) % 360).toFixed(3);
  const Re = () => (typeof RE === 'number' ? RE : 6371000);
  const curCfg = () => { try { return typeof cfg !== 'undefined' && cfg ? cfg : null; } catch (e) { return null; } };
  const norm = c => (typeof normalizeCfg === 'function' ? normalizeCfg(c) : { ...c });
  const curBase = () => { const c = curCfg(); try { return c ? norm(c) : null; } catch (e) { return null; } };
  // 次のタスクまで譲る。MessageChannel はバックグラウンドのタブでもタイマーほど間引かれない
  const tick = () => new Promise(r => { try { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); } catch (e) { setTimeout(r); } });

  function hsl2hex(h, s, l) {
    const f = n => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
    return '#' + f(0) + f(8) + f(4);
  }
  // 風速のグラデーション（青→赤）。0 m/s は白
  const spdCol = (si, n) => si === 0 ? '#e6ecf8' : hsl2hex(215 - 215 * (n > 2 ? (si - 1) / (n - 2) : 0), 0.85, 0.58);

  // ---------------- 入力（localStorage） ----------------
  function validZone(z) {
    if (!z || (z.kind !== 'include' && z.kind !== 'exclude')) return false;
    if (z.shape === 'circle') return fin(z.lat) && fin(z.lon) && fin(z.r_m) && z.r_m > 0;
    return z.shape === 'polygon' && Array.isArray(z.pts) && z.pts.length >= 3 && z.pts.every(p => Array.isArray(p) && fin(p[0]) && fin(p[1]));
  }
  function loadOpt() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { o = {}; }
    opt = { ...OPT0, ...(typeof o === 'object' ? o : {}) };
    opt.zones = Array.isArray(opt.zones) ? opt.zones.filter(validZone) : [];
    opt.nDir = [8, 16, 36].includes(+opt.nDir) ? +opt.nDir : 16;
    opt.margin = Math.max(0, +opt.margin || 0);
    if (!['cfg', 'site', 'sea'].includes(opt.land)) opt.land = 'cfg';
    for (const k of ['speeds', 'elevs']) opt[k] = String(opt[k] ?? OPT0[k]);
    for (const k of ['tBal', 'tRec', 'tPay']) opt[k] = !!opt[k];
  }
  function saveOpt() { try { localStorage.setItem(LS_KEY, JSON.stringify(opt)); } catch (e) { /* 保存できなくても動く */ } }

  const parseList = s => String(s ?? '').normalize('NFKC').split(/[\s,;、]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  // 風速: 正の値を昇順・重複なしにして、先頭に 0 m/s を必ず 1 点足す
  const parseSpeeds = s => [0, ...[...new Set(parseList(s).filter(v => v > 0).map(v => +v.toFixed(3)))].sort((a, b) => a - b)];
  const parseElevs = (s, def) => { const v = [...new Set(parseList(s).filter(x => x > 0 && x <= 90))]; return v.length ? v : [def]; };
  const dirList = n => Array.from({ length: n }, (_, i) => +(i * 360 / n).toFixed(3));
  function parsePolygon(text) {
    const pts = [], bad = [];
    for (const line of String(text ?? '').normalize('NFKC').split(/\r?\n/)) {
      const t = line.trim(); if (!t || t[0] === '#') continue;
      const v = t.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (v.length >= 2 && fin(v[0]) && fin(v[1]) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180) pts.push([v[0], v[1]]); else bad.push(t);
    }
    if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();   // 閉じた入力は 1 点落とす
    return { pts, bad };
  }

  // ---------------- 幾何（ENU 平面）— DOM に触れない純関数。Dispersion._geom で公開 ----------------
  // enuToLatLon の逆変換: x = Δlon·RE·cos(lat0), y = Δlat·RE
  const toENU = (lat0, lon0, lat, lon) => [(lon - lon0) * D * Re() * Math.cos(lat0 * D), (lat - lat0) * D * Re()];
  const toLL = (lat0, lon0, x, y) => typeof enuToLatLon === 'function' ? enuToLatLon(lat0, lon0, x, y)
    : [lat0 + y / Re() / D, lon0 + x / (Re() * Math.cos(lat0 * D)) / D];
  // 風向 fromDeg（吹いてくる方位, 真北基準）の風が流れていく向きの単位ベクトル [東, 北]
  const downwindUnit = fromDeg => [-Math.sin(fromDeg * D), -Math.cos(fromDeg * D)];
  // zones（緯度経度）→ ENU: 円 {kind, shape:'circle', c:[x,y], r}、多角形 {kind, shape:'polygon', p:[[x,y],…]}
  const prepZones = (zones, lat0, lon0) => zones.map(z => z.shape === 'circle'
    ? { kind: z.kind, shape: 'circle', c: toENU(lat0, lon0, z.lat, z.lon), r: z.r_m }
    : { kind: z.kind, shape: 'polygon', p: z.pts.map(p => toENU(lat0, lon0, p[0], p[1])) });
  // 多角形 p = [[x,y],…] の内外判定（ray casting。閉じていない点列のままでよい）
  function pointInPolygon(p, x, y) {
    let c = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function segDist(x, y, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  }
  // 多角形の辺（閉じる辺を含む）までの最短距離 [m]（内外に関係なく非負）
  function distToPolygon(p, x, y) {
    let d = Infinity;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) d = Math.min(d, segDist(x, y, p[j], p[i]));
    return d;
  }
  // 境界までの符号付き距離 [m]（内側が正）
  function signedDist(z, x, y) {
    if (z.shape === 'circle') return z.r - Math.hypot(x - z.c[0], y - z.c[1]);
    const d = distToPolygon(z.p, x, y);
    return pointInPolygon(z.p, x, y) ? d : -d;
  }
  // 着地点の判定（zs は prepZones 済み）。zones が空なら null（判定しない）。include が 1 つも無いときは include 条件を満たすとみなす
  function zoneOk(zs, margin, x, y) {
    if (!zs.length) return null;
    if (!fin(x) || !fin(y)) return false;
    const m = Math.max(0, +margin || 0), inc = zs.filter(z => z.kind === 'include');
    if (inc.length && !inc.some(z => signedDist(z, x, y) >= m)) return false;
    return zs.every(z => z.kind !== 'exclude' || -signedDist(z, x, y) >= m);
  }
  // ok[si][di]（セルの真偽。0 m/s の行は 1 列だけでもよい）と昇順の speeds から許容風速を出す。
  // allow(θ) = max{ s | s' ≤ s の全セル (s', θ) が OK }。0 m/s が NG なら v = null（打上げ不可）。lim は最初に NG になった風速の添字（無ければ null）。
  // all = min_θ allow(θ)（どれかが null なら null）
  function allowFromMatrix(ok, speeds, nDir) {
    const nd = nDir ?? Math.max(1, ...ok.map(r => r?.length || 0));
    const allow = Array.from({ length: nd }, (_, di) => {
      let v = null, lim = null;
      for (let si = 0; si < speeds.length; si++) {
        const row = ok[si] || [], c = row.length === 1 ? row[0] : row[di];
        if (c === true) v = speeds[si]; else { lim = si; break; }
      }
      return { v, lim };
    });
    return { allow, all: allow.length && allow.every(a => a.v != null) ? Math.min(...allow.map(a => a.v)) : null };
  }

  // ---------------- 計算 ----------------
  function runOne(c, wind, ballistic, tg) {
    let M = null, sim = null, fs = {}, err = '';
    try { M = buildModel(c); sim = simulate(M, { record: false, ballistic, wind }); }
    catch (e) { err = String(e?.message || e); }
    if (!err && sim?.ev?.error) err = String(sim.ev.error);
    if (M && sim && typeof flightSummary === 'function') { try { fs = flightSummary(M, sim) || {}; } catch (e) { fs = {}; } }
    const out = [];
    const mk = (mode, L, e2, dist, t, V, vz) => {
      const x = fin(L?.x) ? L.x : NaN, y = fin(L?.y) ? L.y : NaN;
      return { mode, x, y, landed: fin(x) && fin(y), err: e2, fs, dist: pick(dist, Math.hypot(x, y)), t: pick(t, L?.t), V: pick(V, L?.V), vz: pick(vz, L?.vz) };
    };
    if (ballistic || tg.recovery) {
      const L = sim?.ev?.landing;
      out.push(mk(ballistic ? 'ballistic' : 'recovery', L, err, fs.landing_dist_m, fs.landing_t_s, fs.landing_V_mps, fs.landing_vz_mps));
    }
    if (!ballistic && tg.payload) {
      const P = sim?.payload, L = P?.landing;
      out.push(mk('payload', L, err || (P?.error ? String(P.error) : '') || (P ? '' : '放出されませんでした'), fs.payloadLanding_dist_m, NaN, NaN, fs.payloadLanding_vz_mps));
    }
    return out;
  }

  async function run() {
    if (busy || !root) return;
    loadLeaflet();
    const c0 = curCfg();
    if (!c0 || typeof buildModel !== 'function' || typeof simulate !== 'function') { msg('physics.js / app.js を読み込めていません'); return; }
    const base = norm(c0);
    const speeds = parseSpeeds(opt.speeds), dirs = dirList(opt.nDir), elevs = parseElevs(opt.elevs, +base.elev);
    const dirRef = base.windDirRef === 'magnetic' ? 'magnetic' : 'true', decl = +base.magDecl || 0;
    const tg = { ballistic: opt.tBal, recovery: opt.tRec, payload: opt.tPay && !!base.payloadOn };
    if (!tg.ballistic && !tg.recovery && !tg.payload) { msg('対象を 1 つ以上選んでください'); return; }
    const land = opt.land === 'site' || opt.land === 'sea' ? opt.land : (base.landSurface || 'site');
    const lat0 = fin(+base.lat) ? +base.lat : 0, lon0 = fin(+base.lon) ? +base.lon : 0;
    const jobs = [];
    elevs.forEach((elev, ei) => speeds.forEach((s, si) => { for (let di = 0; di < (s === 0 ? 1 : dirs.length); di++) jobs.push({ ei, elev, si, s, di }); }));
    const perJob = (tg.ballistic ? 1 : 0) + (tg.recovery || tg.payload ? 1 : 0), nRun = jobs.length * perJob;
    const stale0 = stale;
    busy = true; cancelReq = false; stale = false; setBusy(true); progress(0, nRun);
    const rows = [], t00 = performance.now();
    let done = 0, t0 = performance.now(), k = 0;
    try {
      for (const j of jobs) {
        const from = j.s === 0 ? 0 : dirs[j.di];
        const fromTrue = n360(from + (dirRef === 'magnetic' ? decl : 0)), fromMag = n360(fromTrue - decl);
        const c = { ...base, elev: j.elev, landSurface: land }, wind = { speed: j.s, from };
        const add = list => { for (const r of list) { Object.assign(r, { ei: j.ei, elev: j.elev, si: j.si, s: j.s, di: j.di, from, fromTrue, fromMag }); const ll = r.landed ? toLL(lat0, lon0, r.x, r.y) : [NaN, NaN]; r.lat = ll[0]; r.lon = ll[1]; rows.push(r); } };
        if (tg.ballistic) { add(runOne(c, wind, true, tg)); done++; }
        if (tg.recovery || tg.payload) { add(runOne(c, wind, false, tg)); done++; }
        // 40 ms か 8 件ごとに譲る（仮想時間のヘッドレスでも中止が効くよう件数でも区切る）
        if (performance.now() - t0 > 40 || ++k >= 8) { progress(done, nRun); await tick(); t0 = performance.now(); k = 0; }
        if (cancelReq) break;
      }
    } finally { busy = false; setBusy(false); }
    if (cancelReq) { msg(`中止しました（${done} / ${nRun} 回で打切り。前回の結果は残しています）`); setStale(stale0 || stale); return; }
    const idx = new Map();
    for (const r of rows) idx.set(`${r.ei}|${r.si}|${r.di}|${r.mode}`, r);
    res = { base, speeds, dirs, elevs, tg, dirRef, decl, land, lat0, lon0, rows, idx, nRun, sec: (performance.now() - t00) / 1000 };
    res.sum = summarize(res);
    if (mapEi >= elevs.length) mapEi = 0;
    judge(res); needFit = true;
    msg(`${nRun} 回の計算が終わりました（${res.sec.toFixed(1)} s）`);
    setStale(stale); renderResult(); drawMap(); refreshInfo();
  }

  // ---------------- 判定 ----------------
  function judge(r) {
    const zs = prepZones(opt.zones, r.lat0, r.lon0), m = Math.max(0, +opt.margin || 0);
    r.hasZones = zs.length > 0; r.margin = m;
    for (const w of r.rows) {
      w.inZone = r.hasZones && w.landed ? zoneOk(zs, m, w.x, w.y) : null;
      w.ok = r.hasZones ? !w.err && w.landed && w.inZone === true : null;
    }
    const modes = MODES.filter(k => r.tg[k]);
    r.tab = r.elevs.map((elev, ei) => {
      const cells = r.speeds.map((s, si) => r.dirs.map((_, di) => {
        const rows = modes.map(k => r.idx.get(`${ei}|${si}|${s === 0 ? 0 : di}|${k}`)).filter(Boolean);
        return { rows, ok: r.hasZones ? rows.length === modes.length && rows.every(w => w.ok) : null };
      }));
      if (!r.hasZones) return { elev, cells, allow: r.dirs.map(() => ({ v: null, lim: null, limModes: [] })), all: null };
      // allow(θ) = max{ s | s' ≤ s の全セルが OK }。0 m/s が NG なら null（打上げ不可）
      const A = allowFromMatrix(cells.map(row => row.map(c => c.ok)), r.speeds, r.dirs.length);
      const allow = A.allow.map((a, di) => ({ ...a, limModes: a.lim == null ? [] : cells[a.lim][di].rows.filter(w => !w.ok).map(w => w.mode) }));
      return { elev, cells, allow, all: A.all };
    });
  }
  function why(w) {
    if (w.err) return 'エラー: ' + w.err;
    if (!w.landed) return '着地せず';
    return w.ok === false ? `範囲外（${fx(w.dist, 0)} m）` : `OK（${fx(w.dist, 0)} m）`;
  }

  // ---------------- 要約 ----------------
  function summarize(r) {
    const runs = [...new Map(r.rows.map(w => [w.fs, w])).values()];   // 実行ごとに 1 つ
    const ext = (key, sgn) => { let b = null; for (const w of runs) { const v = w.fs[key]; if (fin(v) && (!b || sgn * v > sgn * b.v)) b = { v, w }; } return b; };
    const c = r.base, wExp = fin(+c.windExp) ? +c.windExp : 0, wRef = Math.max(0.1, +c.windRef || 10);
    const S = { apo: ext('apogee_m', 1), va1: ext('deploy1_Va_mps', 1), va2: ext('deploy2_Va_mps', 1), vap: ext('payload_Va_mps', 1), alphaW: ext('railExit_alphaW_deg', 1) };
    S.dt = ['deploy1', 'deploy2', 'payload'].map(k => ({ k, lo: ext(k + '_dtApo_s', -1), hi: ext(k + '_dtApo_s', 1) }));
    // ランチクリア迎角 atan(w(z_exit)/V_exit)。z_exit は有効レール長×sin(射角)
    S.clr = null;
    for (const w of runs) {
      const V = w.fs.railExit_V_mps; if (!fin(V) || V <= 0) continue;
      const zx = Math.max(0, (+c.railLen || 0) - (+c.lugAft || 0) / 1000) * Math.sin(w.elev * D);
      const ang = Math.atan(w.s * Math.pow(Math.max(zx, 1) / wRef, wExp) / V) / D;
      if (!S.clr || ang > S.clr.v) S.clr = { v: ang, w, V };
    }
    S.dist = MODES.filter(k => r.tg[k]).map(k => {
      let b = null; for (const w of r.rows) if (w.mode === k && w.landed && (!b || w.dist > b.v)) b = { v: w.dist, w };
      return { k, b };
    });
    S.nErr = r.rows.filter(w => w.err).length; S.nNoLand = r.rows.filter(w => !w.err && !w.landed).length;
    S.errs = [...new Set(r.rows.filter(w => w.err).map(w => w.err))].slice(0, 3);
    return S;
  }
  const at = w => w ? `（${w.s} m/s・${w.s === 0 ? '—' : w.from + '°'}${res && res.elevs.length > 1 ? '・射角 ' + w.elev + '°' : ''}）` : '';

  // ---------------- 書出し ----------------
  const fname = r => String(r.base.name || 'rocket').replace(/[\\/:*?"<>|\s]+/g, '_');
  function csvText(r = res) {
    if (!r) return '';
    const L = [CSV_H];
    for (const w of r.rows) {
      const f = w.fs;
      L.push([w.mode, w.elev, w.s, cn(w.fromTrue), cn(w.fromMag), cn(w.x, 2), cn(w.y, 2), cn(w.lat, 7), cn(w.lon, 7), cn(w.dist, 2), cn(w.t), cn(w.V), cn(w.vz),
        cn(f.apogee_m, 2), cn(f.apogee_t_s), cn(f.railExit_V_mps), cn(f.deploy1_dtApo_s), cn(f.deploy2_dtApo_s), cn(f.payload_dtApo_s),
        cn(f.deploy1_Va_mps), cn(f.payload_Va_mps), w.ok == null ? '' : w.ok ? 1 : 0].join(','));
    }
    return L.join('\n') + '\n';
  }
  // 風向ごとの許容風速。最後に wind_from_deg = all の行（全方位の許容風速）を足す。打上げ不可は NOGO
  function gngText(r = res) {
    if (!r || !r.hasZones) return '';
    const L = [GNG_H];
    r.tab.forEach(T => {
      T.allow.forEach((a, di) => L.push([T.elev, r.dirs[di], r.dirRef, a.v == null ? 'NOGO' : a.v, a.limModes.join('+'), a.lim == null ? '' : r.speeds[a.lim]].join(',')));
      const lim = T.allow.filter(a => a.v === T.all && a.lim != null);
      L.push([T.elev, 'all', r.dirRef, T.all == null ? 'NOGO' : T.all, [...new Set(lim.flatMap(a => a.limModes))].join('+'), lim.length ? r.speeds[lim[0].lim] : ''].join(','));
    });
    return L.join('\n') + '\n';
  }
  function kmlText(r = res) {
    if (!r) return '';
    const kc = hex => 'ff' + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);
    const co = (lat, lon) => `${+lon.toFixed(7)},${+lat.toFixed(7)},0`;
    const n = r.speeds.length, refN = r.dirRef === 'magnetic' ? '磁北' : '真北';
    let k = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(r.base.name || 'rocket')} 落下分散</name>`;
    k += `<description>${esc((r.base.thrustKind === 'assumed' ? ASSUMED + '。' : '') + `風速は高度 ${r.base.windRef} m の値。風向は${refN}基準（吹いてくる方位）。`)}</description>`;
    r.speeds.forEach((s, si) => { const c = kc(spdCol(si, n)); k += `<Style id="s${si}"><IconStyle><color>${c}</color><scale>0.6</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon></IconStyle><LineStyle><color>${c}</color><width>2</width></LineStyle></Style>`; });
    k += `<Style id="zin"><LineStyle><color>ff87e77e</color><width>2</width></LineStyle><PolyStyle><color>2287e77e</color></PolyStyle></Style><Style id="zex"><LineStyle><color>ff8b6bff</color><width>2</width></LineStyle><PolyStyle><color>228b6bff</color></PolyStyle></Style>`;
    k += `<Placemark><name>射点</name><Point><coordinates>${co(r.lat0, r.lon0)}</coordinates></Point></Placemark>`;
    if (opt.zones.length) {
      k += '<Folder><name>許可域・禁止域</name>';
      for (const z of opt.zones) {
        const ring = z.shape === 'circle' ? Array.from({ length: 73 }, (_, i) => { const e = toENU(r.lat0, r.lon0, z.lat, z.lon), a = i * 5 * D; return toLL(r.lat0, r.lon0, e[0] + z.r_m * Math.sin(a), e[1] + z.r_m * Math.cos(a)); }) : [...z.pts, z.pts[0]];
        k += `<Placemark><name>${z.kind === 'include' ? '許可域' : '禁止域'}</name><styleUrl>#${z.kind === 'include' ? 'zin' : 'zex'}</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring.map(p => co(p[0], p[1])).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
      }
      k += '</Folder>';
    }
    r.elevs.forEach((elev, ei) => MODES.filter(m => r.tg[m]).forEach(m => {
      k += `<Folder><name>${esc(`${MODE_L[m]}・射角 ${elev}°`)}</name>`;
      r.speeds.forEach((s, si) => {
        const pts = r.rows.filter(w => w.ei === ei && w.si === si && w.mode === m && w.landed);
        for (const w of pts) k += `<Placemark><name>${esc(`${s} m/s ${s === 0 ? '' : w.from + '°'}`)}</name><description>${esc(`${MODE_L[m]} 東 ${fx(w.x, 0)} m 北 ${fx(w.y, 0)} m 距離 ${fx(w.dist, 0)} m${w.ok == null ? '' : w.ok ? ' OK' : ' NG'}`)}</description><styleUrl>#s${si}</styleUrl><Point><coordinates>${co(w.lat, w.lon)}</coordinates></Point></Placemark>`;
        if (s > 0 && pts.length >= 2) k += `<Placemark><name>${esc(`${MODE_L[m]} ${s} m/s`)}</name><styleUrl>#s${si}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${[...pts, pts[0]].map(w => co(w.lat, w.lon)).join(' ')}</coordinates></LineString></Placemark>`;
      });
      k += '</Folder>';
    }));
    return k + '</Document></kml>\n';
  }
  function dl(name, text, type) {
    if (typeof download === 'function') return download(name, text, type);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------- DOM・CSS ----------------
  const CSS_TEXT = `
#dispersion .disp-hide{display:none!important}
#dispersion .disp-wide{grid-column:1/-1}
#dispersion .row{flex-wrap:wrap}
#dispersion .disp-h{font-weight:700;font-size:12px;margin:8px 0 4px}
#dispersion .disp-note{border-radius:8px;padding:6px 10px;margin:0 0 8px;font-size:13px;background:#3a2a10;border:1px solid #7a5a20}
#dispersion .disp-stale{border-radius:8px;padding:6px 10px;margin:0 0 8px;font-size:13px;background:#3a1424;border:1px solid #7a2a46}
#dispersion .disp-hint{font-size:11px;color:var(--muted)}
#dispersion .disp-targets{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;font-size:12px;color:var(--muted);margin:2px 0 8px}
#dispersion .disp-targets label{display:flex;align-items:center;gap:4px;color:var(--fg)}
#dispersion .disp-targets label.disp-off{color:var(--muted)}
#dispersion details.disp-zones{background:#0d1428;margin:0 0 8px}
#dispersion details.disp-zones summary{font-size:13px}
#dispersion .disp-zbody{padding:0 12px 10px}
#dispersion .disp-z{display:flex;gap:6px;align-items:center;font-size:12px;padding:3px 0;border-bottom:1px solid var(--line)}
#dispersion .disp-z select{width:auto}
#dispersion .disp-z span{flex:1;min-width:0;overflow-wrap:anywhere}
#dispersion .disp-z button{padding:2px 8px}
#dispersion .disp-sub{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px 8px;align-items:end;margin:4px 0 6px}
#dispersion .disp-run progress{flex:1;min-width:80px;max-width:260px}
#dispersion .disp-mapbar .field{min-width:160px}
#dispersion .disp-mapwrap{position:relative;margin:8px 0;border-radius:8px;overflow:hidden;background:#0d1a33;border:1px solid var(--line)}
#dispersion .disp-map{height:min(60vh,520px);width:100%;background:#0d1a33}
#dispersion canvas.disp-cv{width:100%;height:min(60vh,520px);display:block}
#dispersion .leaflet-container{font:12px/1.4 system-ui,sans-serif}
#dispersion .leaflet-container canvas{width:auto;height:auto}
#dispersion .leaflet-control input{width:auto}
#dispersion .leaflet-tooltip{font-size:11px}
#dispersion .disp-legend{position:absolute;right:8px;bottom:24px;z-index:1000;background:rgba(11,16,32,.88);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font-size:11px;line-height:1.5;color:var(--fg);pointer-events:none;max-width:62%}
#dispersion .disp-legend i{display:inline-block;width:12px;height:8px;margin:0 3px 0 6px;vertical-align:middle;border-radius:2px}
#dispersion .disp-legend svg{vertical-align:middle;margin:0 3px 0 6px}
#dispersion .disp-tip{position:absolute;z-index:1001;pointer-events:none;background:rgba(11,16,32,.94);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font-size:11px;white-space:nowrap;color:var(--fg)}
#dispersion .disp-mapnote{font-size:11px;color:var(--muted);margin:-4px 0 6px}
#dispersion .disp-scroll{overflow-x:auto;margin:4px 0 8px;max-width:100%}
#dispersion table.disp-tbl{border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
#dispersion .disp-tbl th,#dispersion .disp-tbl td{border:1px solid var(--line);padding:2px 5px;text-align:center;white-space:nowrap}
#dispersion .disp-tbl th{color:var(--muted);font-weight:600;background:#0d1428}
#dispersion .disp-tbl td.disp-ok{color:#7ee787}
#dispersion .disp-tbl td.disp-ng{color:#ff6b8b;background:#3a1424}
#dispersion .disp-tbl td.disp-na{color:var(--muted)}
#dispersion .disp-all{font-size:14px;margin:2px 0 10px}
#dispersion .disp-all b{font-size:17px}
#dispersion .disp-all b.disp-nogo{color:#ff6b8b}
#dispersion .disp-exp{margin-top:6px}
`;
  const kindSel = cls => `<select class="${cls}" autocomplete="off"><option value="include">許可域（この中に落とす）</option><option value="exclude">禁止域（ここを避ける）</option></select>`;
  function buildDom() {
    if (!document.getElementById('disp-style')) {
      const st = document.createElement('style'); st.id = 'disp-style'; st.textContent = CSS_TEXT; document.head.appendChild(st);
    }
    root.innerHTML = `
<div class="card-h">落下分散・GO/NOGO（風速 × 風向のスイープ）</div>
<div class="disp-note disp-assumed disp-hide">${ASSUMED}</div>
<div class="fields mini">
  <label class="field disp-wide"><span class="disp-spdl">風速リスト [m/s]</span><input type="text" data-k="speeds" autocomplete="off"><span class="disp-hint disp-spdhint"></span></label>
  <label class="field"><span>風向数</span><select data-k="nDir" autocomplete="off"><option value="8">8 方位（45°）</option><option value="16">16 方位（22.5°）</option><option value="36">36 方位（10°）</option></select></label>
  <div class="field"><span>風向の基準（吹いてくる方位）</span><b class="disp-dirref"></b></div>
  <label class="field"><span>着地面</span><select data-k="land" autocomplete="off"><option value="cfg">設定に従う</option><option value="site">射点標高</option><option value="sea">海面</option></select></label>
  <label class="field"><span>射角リスト [deg]（任意）</span><input type="text" data-k="elevs" autocomplete="off"></label>
</div>
<div class="disp-targets"><span>対象:</span>
  <label><input type="checkbox" data-k="tBal">弾道落下（回収系なし）</label>
  <label><input type="checkbox" data-k="tRec">減速落下（回収系あり）</label>
  <label class="disp-tpay"><input type="checkbox" data-k="tPay">ペイロード</label>
</div>
<details class="disp-zones">
  <summary>許可域・禁止域と判定 <span class="muted small disp-zsum"></span></summary>
  <div class="disp-zbody">
    <div class="disp-zlist"></div>
    <div class="disp-sub"><label class="field"><span>マージン [m]（境界からこれ以上離す）</span><input type="number" data-k="margin" min="0" step="10"></label></div>
    <div class="disp-h">円を追加</div>
    <div class="disp-sub">
      <label class="field"><span>種別</span>${kindSel('disp-ckind')}</label>
      <label class="field"><span>中心の緯度 [deg]</span><input type="number" class="disp-clat" step="any"></label>
      <label class="field"><span>中心の経度 [deg]</span><input type="number" class="disp-clon" step="any"></label>
      <label class="field"><span>半径 [m]</span><input type="number" class="disp-cr" min="1" step="10" value="500"></label>
      <button type="button" class="disp-csite">中心＝射点</button>
      <button type="button" class="disp-cadd">円を追加</button>
    </div>
    <div class="disp-h">多角形を追加（1 行に「緯度,経度」を 3 点以上）</div>
    <div class="disp-sub"><label class="field"><span>種別</span>${kindSel('disp-pkind')}</label></div>
    <textarea class="disp-ptext" rows="4" autocomplete="off" placeholder="35.1800,140.3540&#10;35.1800,140.3600&#10;35.1740,140.3600&#10;35.1740,140.3540"></textarea>
    <div class="row" style="margin-top:6px"><button type="button" class="disp-padd">多角形を追加</button><span class="muted small disp-zmsg"></span></div>
  </div>
</details>
<div class="row disp-run"><button type="button" class="primary disp-go">実行</button><button type="button" class="disp-stop" disabled>中止</button><progress class="disp-prog disp-hide" max="1" value="0"></progress><span class="muted small disp-msg"></span></div>
<div class="disp-stale disp-hide">設定変更あり・再計算してください</div>
<div class="row disp-mapbar disp-hide"><label class="field"><span>地図に出す射角</span><select class="disp-elsel" autocomplete="off"></select></label></div>
<div class="disp-mapwrap"><div class="disp-map disp-hide"></div><canvas class="disp-cv"></canvas><div class="disp-legend disp-hide"></div><div class="disp-tip disp-hide"></div></div>
<div class="disp-mapnote"></div>
<div class="disp-res"></div>
<div class="row disp-exp"><button type="button" class="disp-csv" disabled>CSV</button><button type="button" class="disp-gng" disabled title="許可域を設定して計算すると出せます">go_nogo.csv</button><button type="button" class="disp-kml" disabled>KML</button></div>`;
    writeForm(); renderZones(); bind();
  }
  function writeForm() {
    for (const el of root.querySelectorAll('[data-k]')) {
      const v = opt[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    }
  }
  function bind() {
    root.addEventListener('change', e => {
      const el = e.target;
      if (el.dataset.zi != null) { const z = opt.zones[+el.dataset.zi]; if (z) { z.kind = el.value; saveOpt(); renderZones(); rejudge(); } return; }
      const k = el.dataset.k; if (!k) return;
      if (el.type === 'checkbox') opt[k] = el.checked;
      else if (k === 'nDir') opt[k] = +el.value;
      else if (k === 'margin') { opt[k] = Math.max(0, +el.value || 0); el.value = opt[k]; }
      else opt[k] = el.value;
      saveOpt(); updateHint();
      if (k === 'margin') { renderZones(); rejudge(); } else if (res) setStale(true);
    });
    root.addEventListener('input', e => { const k = e.target.dataset.k; if (k === 'speeds' || k === 'elevs') { opt[k] = e.target.value; updateHint(); } });
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.zdel != null) { opt.zones.splice(+b.dataset.zdel, 1); saveOpt(); renderZones(); rejudge(); return; }
      if (b.classList.contains('disp-go')) run();
      else if (b.classList.contains('disp-stop')) cancelReq = true;
      else if (b.classList.contains('disp-csite')) { const c = curBase(); if (c) { q('.disp-clat').value = c.lat; q('.disp-clon').value = c.lon; } }
      else if (b.classList.contains('disp-cadd')) addCircle();
      else if (b.classList.contains('disp-padd')) addPolygon();
      else if (b.classList.contains('disp-csv') && res) dl(`${fname(res)}_dispersion.csv`, csvText(), 'text/csv');
      else if (b.classList.contains('disp-gng') && res?.hasZones) dl('go_nogo.csv', gngText(), 'text/csv');
      else if (b.classList.contains('disp-kml') && res) dl(`${fname(res)}_dispersion.kml`, kmlText(), 'application/vnd.google-earth.kml+xml');
    });
    q('.disp-elsel').addEventListener('change', e => { mapEi = +e.target.value || 0; needFit = true; drawMap(); });
    const cv = q('.disp-cv');
    cv.addEventListener('mousemove', canvasTip);
    cv.addEventListener('mouseleave', () => q('.disp-tip').classList.add('disp-hide'));
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (visible && !map) drawCanvas(); }, 120); });
  }
  function zmsg(t) { q('.disp-zmsg').textContent = t; }
  function addCircle() {
    const c = curBase();
    const lat = parseFloat(q('.disp-clat').value || c?.lat), lon = parseFloat(q('.disp-clon').value || c?.lon), r = parseFloat(q('.disp-cr').value);
    if (!fin(lat) || !fin(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return zmsg('中心の緯度・経度を入れてください');
    if (!fin(r) || r <= 0) return zmsg('半径は正の値にしてください');
    opt.zones.push({ kind: q('.disp-ckind').value, shape: 'circle', lat, lon, r_m: r });
    saveOpt(); renderZones(); rejudge(); zmsg('円を追加しました');
  }
  function addPolygon() {
    const { pts, bad } = parsePolygon(q('.disp-ptext').value);
    if (pts.length < 3) return zmsg(`3 点以上必要です（読めた点 ${pts.length}${bad.length ? `、読めない行 ${bad.length}` : ''}）`);
    opt.zones.push({ kind: q('.disp-pkind').value, shape: 'polygon', pts });
    saveOpt(); renderZones(); rejudge();
    q('.disp-ptext').value = '';
    zmsg(`多角形（${pts.length} 点）を追加しました${bad.length ? `。読めない ${bad.length} 行は無視: ${bad.slice(0, 2).join(' / ')}` : ''}`);
  }
  const zoneDesc = z => z.shape === 'circle' ? `円 中心 ${+z.lat.toFixed(6)}, ${+z.lon.toFixed(6)}・半径 ${+z.r_m.toFixed(1)} m`
    : `多角形 ${z.pts.length} 点（${z.pts.slice(0, 2).map(p => `${+p[0].toFixed(5)},${+p[1].toFixed(5)}`).join(' / ')}${z.pts.length > 2 ? ' …' : ''}）`;
  function renderZones() {
    q('.disp-zlist').innerHTML = opt.zones.length ? opt.zones.map((z, i) => `<div class="disp-z"><select data-zi="${i}" autocomplete="off"><option value="include"${z.kind === 'include' ? ' selected' : ''}>許可域</option><option value="exclude"${z.kind === 'exclude' ? ' selected' : ''}>禁止域</option></select><span>${esc(zoneDesc(z))}</span><button type="button" data-zdel="${i}">削除</button></div>`).join('')
      : '<div class="muted small">未設定（○/× の判定はしません）。円か多角形を追加すると、○/× の行列と許容風速を出します。許可域が無く禁止域だけのときは、禁止域を避ければ OK とします。</div>';
    const ni = opt.zones.filter(z => z.kind === 'include').length;
    q('.disp-zsum').textContent = opt.zones.length ? `（許可域 ${ni}・禁止域 ${opt.zones.length - ni}・マージン ${opt.margin} m）` : '（未設定）';
  }
  function updateHint() {
    if (!root) return;
    const b = curBase(), sp = parseSpeeds(opt.speeds), el = parseElevs(opt.elevs, b ? +b.elev : NaN);
    const nT = (opt.tBal ? 1 : 0) + (opt.tRec || (opt.tPay && b?.payloadOn) ? 1 : 0);
    const n = el.length * (1 + (sp.length - 1) * opt.nDir) * nT;
    q('.disp-spdhint').textContent = `計算する風速: ${sp.join(', ')} m/s（0 m/s は 1 点）× ${opt.nDir} 方位 × 射角 ${el.map(v => fin(v) ? v + '°' : '設定値').join('・')} → ${n} 回`;
  }
  function refreshInfo() {
    if (!root) return;
    const b = curBase();
    q('.disp-dirref').textContent = !b ? '—' : b.windDirRef === 'magnetic' ? `磁北基準（設定の風向基準。磁気偏角 ${b.magDecl}°）` : '真北基準（設定の風向基準）';
    q('.disp-spdl').textContent = `風速リスト [m/s]（高度 ${b?.windRef ?? 10} m での値。カンマ区切り）`;
    q('[data-k="land"] option[value="cfg"]').textContent = `設定に従う（${b?.landSurface === 'sea' ? '海面' : '射点標高'}）`;
    q('[data-k="elevs"]').placeholder = `空欄＝設定の射角 ${b?.elev ?? ''}°（例: 80,85）`;
    const pay = !!b?.payloadOn, lp = q('.disp-tpay');
    lp.querySelector('input').disabled = !pay; lp.classList.toggle('disp-off', !pay);
    lp.title = pay ? '' : 'ペイロード放出（payloadOn）が無効のため対象外';
    q('.disp-assumed').classList.toggle('disp-hide', !(b?.thrustKind === 'assumed' || res?.base.thrustKind === 'assumed'));
    if (b) { q('.disp-clat').placeholder = b.lat; q('.disp-clon').placeholder = b.lon; }
    updateHint();
  }
  function msg(t) { if (root) q('.disp-msg').textContent = t; }
  function progress(d, n) { const p = q('.disp-prog'); p.max = n; p.value = d; msg(`計算中… ${d} / ${n} 回`); }
  function setBusy(b) { q('.disp-go').disabled = b; q('.disp-stop').disabled = !b; q('.disp-prog').classList.toggle('disp-hide', !b); }
  function setStale(b) { stale = b; if (root) q('.disp-stale').classList.toggle('disp-hide', !(b && res)); }
  function rejudge() { if (res) { judge(res); renderResult(); } drawMap(); }

  // ---------------- 結果の表 ----------------
  const refName = r => r.dirRef === 'magnetic' ? '磁北' : '真北';
  function tipOf(w) {
    const r = res;
    return `${MODE_L[w.mode]}・${w.s} m/s・${w.s === 0 ? '無風' : `風向 ${w.from}°（${refName(r)}基準）`}${r.elevs.length > 1 ? `・射角 ${w.elev}°` : ''}\n`
      + `東 ${fx(w.x, 0)} m・北 ${fx(w.y, 0)} m・距離 ${fx(w.dist, 0)} m・降下 ${fx(Math.abs(w.vz))} m/s${w.ok == null ? '' : w.ok ? '・OK' : '・NG'}`;
  }
  function table(r, T) {
    const nd = r.dirs.length, ref = refName(r);
    let h = `<div class="disp-h">射角 ${T.elev}°${r.hasZones ? '' : '（許可域が未設定のため ○/× は出さず、対象のうち最大の落下距離 [m] を示します）'}</div>`;
    h += `<div class="disp-scroll"><table class="disp-tbl"><tr><th>風速＼風向（${ref}）</th>${r.dirs.map(d => `<th>${d}°</th>`).join('')}</tr>`;
    const cellH = (c, span) => {
      const tip = esc(c.rows.map(w => `${MODE_L[w.mode]}: ${why(w)}`).join('\n')), cs = span ? ` colspan="${span}" style="text-align:left"` : '';
      if (!r.hasZones) {
        const bad = !c.rows.length || c.rows.some(w => w.err || !w.landed), dm = Math.max(...c.rows.map(w => w.landed ? w.dist : -Infinity));
        return `<td${cs} class="${bad ? 'disp-ng' : 'disp-na'}" title="${tip}">${bad ? '!' : fin(dm) ? dm.toFixed(0) : '—'}</td>`;
      }
      return `<td${cs} class="${c.ok ? 'disp-ok' : 'disp-ng'}" title="${tip}">${c.ok ? '○' : '×'}</td>`;
    };
    r.speeds.forEach((s, si) => { h += `<tr><th>${s} m/s</th>${s === 0 ? cellH(T.cells[si][0], nd) : T.cells[si].map(c => cellH(c)).join('')}</tr>`; });
    h += '</table></div>';
    if (!r.hasZones) return h;
    const top = r.speeds.at(-1);
    h += `<div class="disp-scroll"><table class="disp-tbl"><tr><th>風向（${ref}）</th>${r.dirs.map(d => `<th>${d}°</th>`).join('')}</tr>`;
    h += `<tr><th>許容風速 [m/s]</th>${T.allow.map(a => a.v == null ? '<td class="disp-ng">不可</td>'
      : `<td class="disp-ok"${a.lim == null ? ' title="リストの最大風速まで OK"' : ''}>${a.lim == null ? '≥' : ''}${a.v}</td>`).join('')}</tr>`;
    h += `<tr><th>制限要因</th>${T.allow.map(a => `<td class="disp-na">${a.lim == null ? '—' : `${r.speeds[a.lim]} m/s ${a.limModes.map(k => MODE_L[k]).join('・')}`}</td>`).join('')}</tr></table></div>`;
    const allTop = T.all != null && T.allow.every(a => a.lim == null);
    h += `<div class="disp-all">全方位の許容風速（射角 ${T.elev}°）: ${T.all == null ? '<b class="disp-nogo">打上げ不可</b>（0 m/s でも許可域に収まりません）'
      : `<b>${allTop ? '≥' : ''}${T.all} m/s</b>（高度 ${r.base.windRef} m の風速${allTop ? `。リストの最大 ${top} m/s まで全方位 OK` : ''}）`}</div>`;
    return h;
  }
  function renderResult() {
    if (!root) return;
    const box = q('.disp-res'), r = res;
    q('.disp-csv').disabled = q('.disp-kml').disabled = !r;
    q('.disp-gng').disabled = !(r && r.hasZones);
    if (!r) { box.innerHTML = ''; return; }
    const S = r.sum, kv = (l, v) => `<span>${l} <b>${v}</b></span>`;
    let h = `<div class="muted small">${r.nRun} 回（${MODES.filter(k => r.tg[k]).map(k => MODE_L[k]).join('・')}）・風向は${refName(r)}基準（吹いてくる方位）・風速は高度 ${r.base.windRef} m の値・着地面 ${r.land === 'sea' ? '海面' : '射点標高'}${r.hasZones ? `・マージン ${r.margin} m` : ''}</div>`;
    h += '<div class="kv">' + kv('頂点高度の最大', S.apo ? `${fx(S.apo.v, 0)} m${at(S.apo.w)}` : '—');
    const DTL = { deploy1: '1段目開傘', deploy2: '2段目開傘', payload: 'ペイロード放出' };
    for (const d of S.dt) if (d.lo) h += kv(`${DTL[d.k]}−頂点 dtApo`, `${fx(d.lo.v, 2)} 〜 ${fx(d.hi.v, 2)} s`);
    if (S.va1) h += kv('1段目開傘時の対気速度 最大', `${fx(S.va1.v)} m/s${at(S.va1.w)}`);
    if (S.va2) h += kv('2段目開傘時の対気速度 最大', `${fx(S.va2.v)} m/s${at(S.va2.w)}`);
    if (S.vap) h += kv('ペイロード放出時の対気速度 最大', `${fx(S.vap.v)} m/s${at(S.vap.w)}`);
    if (S.clr) h += kv('最悪のランチクリア迎角 atan(w/V)', `${fx(S.clr.v)}°（離脱 ${fx(S.clr.V)} m/s${at(S.clr.w)}）`);
    if (S.alphaW) h += kv('レール直交成分の αW 最大', `${fx(S.alphaW.v)}°`);
    for (const d of S.dist) if (d.b) h += kv(`${MODE_L[d.k]}の最大落下距離`, `${fx(d.b.v, 0)} m${at(d.b.w)}`);
    if (S.nErr || S.nNoLand) h += kv('エラー / 未着地', `${S.nErr} / ${S.nNoLand} 件`) + (S.errs.length ? `<span>${esc(S.errs.join(' / '))}</span>` : '');
    h += '</div>';
    for (const T of r.tab) h += table(r, T);
    box.innerHTML = h;
  }

  // ---------------- 地図（Leaflet / 代替 canvas） ----------------
  function mapData() {
    const b = res ? res.base : curBase();
    const lat0 = res ? res.lat0 : +(b?.lat ?? 0) || 0, lon0 = res ? res.lon0 : +(b?.lon ?? 0) || 0;
    const curves = [], pts = [];
    if (res) {
      const ei = Math.min(mapEi, res.elevs.length - 1), n = res.speeds.length;
      for (const m of MODES) if (res.tg[m]) res.speeds.forEach((s, si) => {
        const col = spdCol(si, n);
        const ws = (s === 0 ? [0] : res.dirs.map((_, di) => di)).map(di => res.idx.get(`${ei}|${si}|${di}|${m}`)).filter(w => w && w.landed);
        ws.forEach(w => pts.push({ w, col }));
        if (s > 0 && ws.length >= 2) curves.push({ m, col, ws });
      });
    }
    return { lat0, lon0, curves, pts };
  }
  function renderLegend() {
    const lg = q('.disp-legend');
    if (!res) { lg.classList.add('disp-hide'); return; }
    const n = res.speeds.length;
    const line = d => `<svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke="#e6ecf8" stroke-width="2"${d.length ? ` stroke-dasharray="${d.join(',')}"` : ''}/></svg>`;
    lg.innerHTML = `<div>${MODES.filter(m => res.tg[m]).map(m => line(DASH[m]) + MODE_L[m]).join(' ')}</div>`
      + `<div>風速${res.speeds.map((s, si) => `<i style="background:${spdCol(si, n)}"></i>${s}`).join('')} m/s</div>`
      + `<div><i style="background:#ff9b3d;border-radius:50%"></i>射点${opt.zones.length ? '<i style="background:#7ee787"></i>許可域<i style="background:#ff6b8b"></i>禁止域・NG 点' : ''}</div>`;
    lg.classList.remove('disp-hide');
  }
  function drawMap() {
    if (!root) return;
    renderLegend();
    const bar = q('.disp-mapbar');
    if (res && res.elevs.length > 1) {
      bar.classList.remove('disp-hide');
      q('.disp-elsel').innerHTML = res.elevs.map((e, i) => `<option value="${i}"${i === mapEi ? ' selected' : ''}>${e}°</option>`).join('');
    } else bar.classList.add('disp-hide');
    q('.disp-mapnote').textContent = map ? '線は風速ごとに風向をつないだ閉曲線（弾道落下=破線、減速落下=実線、ペイロード=点線）。点にカーソルを当てると詳細を表示。'
      : leafletFail ? '地図（Leaflet）を読み込めないため、射点を原点とする平面図（東・北 [m]、北が上）で表示しています。'
        : leafletP ? '地図（Leaflet）を読込中…' : '';
    if (map) drawLeaflet(); else drawCanvas();
  }
  let lastBounds = [];
  function drawLeaflet() {
    const Lf = window.L, d = mapData(), all = [[d.lat0, d.lon0]];
    lyr.clearLayers();
    for (const z of opt.zones) {
      const st = { color: z.kind === 'include' ? '#7ee787' : '#ff6b8b', weight: 2, fillOpacity: 0.08 };
      (z.shape === 'circle' ? Lf.circle([z.lat, z.lon], { radius: z.r_m, ...st }) : Lf.polygon(z.pts, st))
        .bindTooltip(esc((z.kind === 'include' ? '許可域: ' : '禁止域: ') + zoneDesc(z))).addTo(lyr);
      if (z.shape === 'circle') { const e = toENU(d.lat0, d.lon0, z.lat, z.lon); all.push(toLL(d.lat0, d.lon0, e[0] - z.r_m, e[1] - z.r_m), toLL(d.lat0, d.lon0, e[0] + z.r_m, e[1] + z.r_m)); }
      else all.push(...z.pts);
    }
    for (const c of d.curves) Lf.polyline([...c.ws, c.ws[0]].map(w => [w.lat, w.lon]), { color: c.col, weight: 2, opacity: 0.9, dashArray: DASH[c.m].length ? DASH[c.m].join(',') : null, interactive: false }).addTo(lyr);
    for (const p of d.pts) {
      const w = p.w, ng = w.ok === false;
      Lf.circleMarker([w.lat, w.lon], { radius: w.s === 0 ? 5 : 3.5, color: ng ? '#ff6b8b' : p.col, weight: ng ? 2 : 1, fillColor: p.col, fillOpacity: 0.9 })
        .bindTooltip(esc(tipOf(w)).replace(/\n/g, '<br>')).addTo(lyr);
      all.push([w.lat, w.lon]);
    }
    Lf.circleMarker([d.lat0, d.lon0], { radius: 6, color: '#ffffff', weight: 2, fillColor: '#ff9b3d', fillOpacity: 1 }).bindTooltip('射点').addTo(lyr);
    lastBounds = all;
    if (needFit) fitMap();
  }
  function fitMap() {
    if (!map || !visible || !q('.disp-map').clientWidth) return;
    needFit = false;
    map.invalidateSize();
    if (lastBounds.length > 1) map.fitBounds(window.L.latLngBounds(lastBounds), { padding: [24, 24], maxZoom: 17 });
    else map.setView(lastBounds[0], 15);
  }
  const nstep = v => { const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };
  function drawCanvas() {
    const cv = q('.disp-cv');
    if (!visible || map) return;
    const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const d = mapData(), zs = prepZones(opt.zones, d.lat0, d.lon0);
    let x0 = -100, x1 = 100, y0 = -100, y1 = 100;
    const ext = (x, y) => { if (fin(x) && fin(y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } };
    for (const z of zs) { if (z.shape === 'circle') { ext(z.c[0] - z.r, z.c[1] - z.r); ext(z.c[0] + z.r, z.c[1] + z.r); } else z.p.forEach(p => ext(p[0], p[1])); }
    for (const p of d.pts) ext(p.w.x, p.w.y);
    const pad = 34, sc = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0)), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const X = x => W / 2 + (x - cx) * sc, Y = y => H / 2 - (y - cy) * sc;
    // 格子（m）
    const st = nstep(Math.max(W, H) / sc / 8), xa = cx - W / 2 / sc, xb = cx + W / 2 / sc, ya = cy - H / 2 / sc, yb = cy + H / 2 / sc;
    ctx.font = '11px system-ui,sans-serif'; ctx.lineWidth = 1;
    for (let v = Math.ceil(xa / st) * st; v <= xb; v += st) { ctx.strokeStyle = Math.abs(v) < st / 2 ? '#4a5a80' : '#22304f'; ctx.beginPath(); ctx.moveTo(X(v), 0); ctx.lineTo(X(v), H); ctx.stroke(); if (X(v) < W - 80) { ctx.fillStyle = '#8c9bbd'; ctx.textAlign = 'center'; ctx.fillText(String(Math.round(v)), X(v), H - 4); } }
    for (let v = Math.ceil(ya / st) * st; v <= yb; v += st) { ctx.strokeStyle = Math.abs(v) < st / 2 ? '#4a5a80' : '#22304f'; ctx.beginPath(); ctx.moveTo(0, Y(v)); ctx.lineTo(W, Y(v)); ctx.stroke(); if (Y(v) > 30) { ctx.fillStyle = '#8c9bbd'; ctx.textAlign = 'left'; ctx.fillText(String(Math.round(v)), 4, Y(v) - 3); } }
    ctx.fillStyle = '#e6ecf8'; ctx.textAlign = 'left'; ctx.fillText('↑北 [m]', 4, 14); ctx.textAlign = 'right'; ctx.fillText('東 [m] →', W - 6, H - 4);
    // 許可域・禁止域
    for (const z of zs) {
      const col = z.kind === 'include' ? '126,231,135' : '255,107,139';
      ctx.beginPath();
      if (z.shape === 'circle') ctx.arc(X(z.c[0]), Y(z.c[1]), z.r * sc, 0, 2 * Math.PI);
      else z.p.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
      ctx.closePath(); ctx.fillStyle = `rgba(${col},.08)`; ctx.fill(); ctx.strokeStyle = `rgb(${col})`; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke();
    }
    // 風速ごとの閉曲線
    ctx.lineWidth = 2;
    for (const c of d.curves) {
      ctx.setLineDash(DASH[c.m]); ctx.strokeStyle = c.col; ctx.beginPath();
      c.ws.forEach((w, i) => i ? ctx.lineTo(X(w.x), Y(w.y)) : ctx.moveTo(X(w.x), Y(w.y)));
      ctx.closePath(); ctx.stroke();
    }
    ctx.setLineDash([]);
    hits = [];
    for (const p of d.pts) {
      const w = p.w, px = X(w.x), py = Y(w.y);
      ctx.beginPath(); ctx.arc(px, py, w.s === 0 ? 5 : 3.5, 0, 2 * Math.PI); ctx.fillStyle = p.col; ctx.fill();
      if (w.ok === false) { ctx.strokeStyle = '#ff6b8b'; ctx.lineWidth = 2; ctx.stroke(); }
      hits.push({ x: px, y: py, t: tipOf(w) });
    }
    ctx.beginPath(); ctx.arc(X(0), Y(0), 6, 0, 2 * Math.PI); ctx.fillStyle = '#ff9b3d'; ctx.fill(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
    hits.push({ x: X(0), y: Y(0), t: '射点' });
  }
  function canvasTip(e) {
    const cv = q('.disp-cv'), tip = q('.disp-tip'), rc = cv.getBoundingClientRect(), mx = e.clientX - rc.left, my = e.clientY - rc.top;
    let best = null, bd = 81;
    for (const h of hits) { const d2 = (h.x - mx) ** 2 + (h.y - my) ** 2; if (d2 < bd) { bd = d2; best = h; } }
    if (!best) { tip.classList.add('disp-hide'); return; }
    tip.innerHTML = esc(best.t).replace(/\n/g, '<br>'); tip.classList.remove('disp-hide');
    tip.style.left = Math.max(0, Math.min(mx + 12, rc.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(0, my + 14 + tip.offsetHeight > rc.height ? my - tip.offsetHeight - 8 : my + 14) + 'px';
  }
  function loadLeaflet() {
    if (leafletP) return leafletP;
    leafletP = new Promise(done => {
      if (leafletOff) return done(false);
      if (window.L?.map) return done(true);
      if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = LEAFLET_CSS; document.head.appendChild(l); }
      const s = document.createElement('script'); s.src = LEAFLET_JS; s.async = true;
      s.onload = () => done(!!window.L?.map); s.onerror = () => done(false);
      setTimeout(() => done(!!window.L?.map), 15000);
      document.head.appendChild(s);
    }).then(ok => { if (ok) initMap(); else { leafletFail = true; drawMap(); } return ok; });
    if (root) drawMap();
    return leafletP;
  }
  function initMap() {
    if (map || !root || !window.L?.map) return;
    const Lf = window.L, el = q('.disp-map'), d = mapData();
    el.classList.remove('disp-hide'); q('.disp-cv').classList.add('disp-hide'); q('.disp-tip').classList.add('disp-hide');
    map = Lf.map(el, { zoomControl: true }).setView([d.lat0, d.lon0], 14);   // 既定の SVG レンダラ
    Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }).addTo(map);
    Lf.control.scale({ imperial: false }).addTo(map);
    lyr = Lf.layerGroup().addTo(map);
    needFit = true; drawMap();
    if (visible) { requestAnimationFrame(onShown); setTimeout(onShown, 250); }
  }

  // ---------------- 公開 API ----------------
  function mount(el) {
    if (root || !el) return;
    root = el; loadOpt(); buildDom(); refreshInfo(); renderResult(); drawMap();
  }
  function setVisible(b) {
    if (!root) return;
    visible = !!b;
    if (!visible) return;
    refreshInfo(); loadLeaflet();
    requestAnimationFrame(onShown);
    clearTimeout(shownT); shownT = setTimeout(onShown, 250);   // rAF が回らない環境（背景タブ・ヘッドレス）の保険。2 回呼んでも害はない
  }
  function onShown() { if (!visible || !root) return; if (map) { map.invalidateSize(); if (needFit) fitMap(); } else drawCanvas(); }
  function markStale() { if (!root) return; setStale(true); refreshInfo(); }

  return {
    mount, setVisible, markStale,
    // 幾何の純関数（DOM・状態に触れない。test/dispersion-test.html から使う）
    _geom: { pointInPolygon, distToPolygon, signedDist, zoneOk, allowFromMatrix, prepZones, toENU, toLL, downwindUnit },
    // テスト用（test/dispersion-test.html）
    _test: {
      parseSpeeds, parseElevs, parsePolygon, dirList, toENU, toLL, prepZones, sdist: signedDist, judgePoint: zoneOk, run,
      cancel: () => { cancelReq = true; }, result: () => res, opt: () => opt, isBusy: () => busy, isStale: () => stale,
      csvText, gngText, kmlText, disableLeaflet: () => { leafletOff = true; }, css: () => CSS_TEXT, leafletState: () => ({ map: !!map, fail: leafletFail, loading: !!leafletP, size: map ? [map.getSize().x, map.getSize().y] : null }),
      spdCol, hits: () => hits.slice(),
    },
  };
})();
