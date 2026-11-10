'use strict';
/* ロケット シミュレーター — 物理コア（DOM 非依存）
 * normalizeCfg(cfg) → 正規化 cfg, buildModel(cfg) → M, simulate(M, opt) → {rec, ev, st, payload}, reviewValues(M)
 * 座標: x=東, y=真北, z=上 [m]。cfg の位置は機体先端基準 [mm]。契約は docs/spec-v2.md
 */
const G0 = 9.80665, RE = 6371000, RAIR = 287.05, GAM = 1.4, D2R = Math.PI / 180;
const RHO0_SHEET = 1.2, G_SHEET = 9.81; // 諸元表（審査用シート）の換算定数

// ---------------- モーター ----------------
const MOTORS = {
  C6:   { n: 'Estes C6（近似）',          I: 10,   tb: 1.85, shape: 'spike',      prop: 12.3, total: 25.8, len: 70,  dia: 18 },
  F40:  { n: 'Aerotech F40W（近似）',     I: 80,   tb: 2.0,  shape: 'regressive', prop: 39,   total: 90,   len: 124, dia: 29 },
  G80:  { n: 'Aerotech G80T（近似）',     I: 125,  tb: 1.6,  shape: 'flat',       prop: 62,   total: 108,  len: 124, dia: 29 },
  H128: { n: 'Aerotech H128W（近似）',    I: 176,  tb: 1.4,  shape: 'regressive', prop: 94,   total: 206,  len: 194, dia: 29 },
  I284: { n: 'Aerotech I284W（近似）',    I: 540,  tb: 1.9,  shape: 'regressive', prop: 330,  total: 610,  len: 330, dia: 38 },
  J350: { n: 'Aerotech J350W（近似）',    I: 700,  tb: 2.0,  shape: 'regressive', prop: 370,  total: 730,  len: 337, dia: 38 },
  K550: { n: 'Aerotech K550W（近似）',    I: 1590, tb: 2.9,  shape: 'regressive', prop: 800,  total: 1500, len: 410, dia: 54 },
  L1115:{ n: 'Cesaroni L1115（近似）',    I: 5000, tb: 4.5,  shape: 'flat',       prop: 2500, total: 4600, len: 621, dia: 75 },
  HYB:  { n: '学生ハイブリッド例 N2O/ABS', I: 3000, tb: 5.0,  shape: 'hybrid',     prop: 1800, total: 4500, len: 900, dia: 75 },
};
const SHAPES = [['flat', '平坦'], ['regressive', '減少型（W系）'], ['progressive', '増加型'], ['spike', '初期スパイク（黒色火薬）'], ['boost', 'ブースト＋サステイン'], ['hybrid', 'ハイブリッド（ブローダウン）']];

function shapeFn(shape, x) {
  const up = Math.min(1, x / 0.04), down = x > 0.92 ? Math.max(0, (1 - x) / 0.08) : 1;
  let f = 1;
  switch (shape) {
    case 'regressive': f = 1.25 - 0.6 * x; break;
    case 'progressive': f = 0.7 + 0.6 * x; break;
    case 'spike': f = 0.45 + 2.6 * Math.exp(-(((x - 0.12) / 0.06) ** 2)); break;
    case 'boost': f = 0.6 + 1.2 / (1 + Math.exp((x - 0.3) / 0.02)); break;
    case 'hybrid': f = 1.1 * Math.exp(-0.9 * x) + 0.1; break;
  }
  return f * up * down;
}
function genCurve(shape, I, tb) {
  const n = 80, pts = [];
  for (let i = 0; i <= n; i++) { const x = i / n; pts.push([x * tb, shapeFn(shape, x)]); }
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += (pts[i][1] + pts[i - 1][1]) / 2 * (pts[i][0] - pts[i - 1][0]);
  const k = s > 0 ? I / s : 0;
  return pts.map(p => [p[0], p[1] * k]);
}
// RASP .eng 形式 or 単純な "t F" / "t,F" 列
function parseEng(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith(';'));
  if (!lines.length) return null;
  let hdr = null, i = 0;
  const tk = lines[0].split(/\s+/);
  if (tk.length >= 7 && isNaN(+tk[0])) {
    hdr = { name: tk[0], dia: +tk[1], len: +tk[2], prop: +tk[4] * 1000, total: +tk[5] * 1000 };
    i = 1;
  }
  const pts = [];
  for (; i < lines.length; i++) {
    const a = lines[i].split(/[\s,;\t]+/).map(Number);
    if (a.length >= 2 && isFinite(a[0]) && isFinite(a[1])) pts.push([a[0], Math.max(0, a[1])]);
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a[0] - b[0]);
  if (pts[0][0] > 0) pts.unshift([0, 0]);
  if (pts[pts.length - 1][1] > 0) pts.push([pts[pts.length - 1][0] + 0.01, 0]);
  return { hdr, pts };
}
function motorClass(I) {
  if (I <= 2.5) return I <= 1.25 ? '1/2A' : 'A';
  const idx = Math.ceil(Math.log2(I / 2.5));
  return String.fromCharCode(65 + Math.min(idx, 25));
}

// ---------------- cfg 既定値・正規化 ----------------
// すべての cfg キーの既定値（唯一の表）。位置は先端基準 mm、質量 g、慣性 kg·m²
const PHYS_DEFAULTS = {
  name: 'MyRocket', posRef: 'nose',
  noseShape: 'ogive', noseLen: 300, bodyLen: 1100, d: 80, tailLen: 0, tailD: 60,
  airMass: 1900, airCG: 720, ballast: 0, ballastPos: 120,
  finN: 4, finCr: 160, finCt: 70, finSpan: 70, finSweep: 70, finThick: 3, finAft: 0, finCant: 0,
  motorPreset: 'J350', motorSrc: 'param', mI: 700, mTb: 2.0, mShape: 'regressive', mProp: 370, mTotal: 730, mLen: 337, mDia: 38, mOver: 0, thrustScale: 100,
  engText: '', nozzleExitD: 0, thrustKind: 'measured',
  massMode: 'motor', hDryMass: 6190, hDryCG: 1008.52, hOxMass: 391, hOxCG: 1224, hTankOutlet: 1379.14,
  hFuelPre: 380, hFuelPost: 322, hFuelCG: 1489.57, hBurnTime: 2.393, hOpTime: 0, hOxDrain: true,
  inertiaMode: 'auto', Ipitch: 1.5, Iroll: 0.09,
  payloadOn: false, payloadMass: 250, payloadPos: 200, payloadTime: 7, payloadVt: 6,
  rec1: 'apogee', rec1Time: 8, rec1Delay: 0, rec1Backup: 0, rec2: 'altitude', rec2Time: 60,
  chuteSpec: 'diameter', c1D: 450, c1Cd: 0.8, c2D: 1200, c2Cd: 1.5, c1Vt: 8.08, c2Vt: 5, mainAlt: 150, openTime: 1.0, dtApoWarn: 1.5,
  lat: 35.177228, lon: 140.357056, magDecl: 0, azimRef: 'true', windDirRef: 'true',
  siteAlt: 10, temp: 20, railLen: 5, lugAft: 0, elev: 85, azim: 0,
  wind: 4, windFrom: 270, windRef: 10, windExp: 0.14, gust: 1.0, landSurface: 'site',
  aeroMode: 'barrowman', cpManual: 1258, cnaManual: 11.8, cmq: -2.96, clp: -0.14, aeroTable: '',
  cdMode: 'auto', cdManual: 0.45, cdScale: 100, machCorr: true, dt: 3,
  // 以下 Magi から移植した機能（既定値は従来と同じ挙動）
  magMode: 'manual', launchDate: '2026-10-11',            // 磁気偏角: manual=magDecl / auto=WMM2025（射点・打上げ日）
  earthRot: false,                                          // 地球の自転（コリオリ力）と正規重力（緯度・高度）
  tipOff: false, lugUpper: 0,                               // ティップオフ: 上側ラグ（後端から mm）が抜けてから下側ラグ（lugAft）が抜けるまで回転
  windModel: 'power', windProfile: '', windMaxH: 0,         // 風: べき法則 / 高度別プロファイル（"高度m,風速m/s,風向deg"）、べき法則の上限高度（0=無制限）
  cnaScale: 100, burnScale: 100, cgShift: 0, cpShift: 0, chuteScale: 100, chuteDelay: 0, // ばらつき（モンテカルロ・ラプラス近似で使用）
  thMinApogee: 0, thMaxQ: 0, thMinRailV: 0, thMaxRange: 0, // 性能閾値（0 で無効）
  // 多段式: stageCount = 全段数（1〜3）。機体入力（外形・質量・モーター・フィン）は「打上げ時の全体」で、それを分離面で分割する。
  // 元のモーターとフィンは最下段（最初に点火）。up = 最上段、mid = 中段（3 段式のとき）。位置は機体先端から mm
  // 質量は推進剤を除く値。最下段の質量 = 全体 − 上の段の合計。Sep = その段の後端（分離面）の位置
  // SepDelay / IgnDelay / DropVt / DropChuteDelay は、その段のすぐ下の段の切り離しについての値
  stageCount: 1,
  upSep: 800, upMass: 700, upCG: 355, upProp: 180, upMotorLen: 200, upSrc: 'param', upI: 320, upTb: 1.5, upShape: 'regressive', upEng: '',
  upFinN: 4, upFinCr: 80, upFinCt: 40, upFinSpan: 48, upFinSweep: 40, upFinAft: 0, upFinThick: 3, upSepDelay: 0.3, upIgnDelay: 0.5, upDropVt: 0, upDropChuteDelay: 1,
  midSep: 1050, midMass: 420, midCG: 850, midProp: 180, midMotorLen: 200, midSrc: 'param', midI: 320, midTb: 1.5, midShape: 'regressive', midEng: '',
  midFinN: 4, midFinCr: 80, midFinCt: 40, midFinSpan: 48, midFinSweep: 40, midFinAft: 0, midFinThick: 3, midSepDelay: 0.3, midIgnDelay: 0.5, midDropVt: 0, midDropChuteDelay: 1,
};

// 内部ヘルパー（トップレベル名を増やさないため 1 個にまとめる）
const PHYS_UTIL = (() => {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const ENUMS = {
    posRef: ['nose', 'aft'], azimRef: ['true', 'magnetic'], windDirRef: ['true', 'magnetic'], landSurface: ['site', 'sea', 'terrain'], magMode: ['manual', 'auto'], windModel: ['power', 'profile'],
    massMode: ['motor', 'hybrid'], inertiaMode: ['auto', 'manual'], aeroMode: ['barrowman', 'manual'], thrustKind: ['measured', 'assumed'],
    rec1: ['apogee', 'ignition', 'burnout', 'none'], rec2: ['none', 'altitude', 'ignition'], chuteSpec: ['diameter', 'velocity'],
    upSrc: ['param', 'eng'], midSrc: ['param', 'eng'], upShape: SHAPES.map(s => s[0]), midShape: SHAPES.map(s => s[0]),
    cdMode: ['auto', 'manual'], noseShape: ['ogive', 'cone', 'parabolic', 'elliptic'], motorSrc: ['param', 'eng'], mShape: SHAPES.map(s => s[0]),
  };
  const NULLABLE = ['cmq', 'clp'];
  // 区分線形補間（tab は [[x, y], …] を x 昇順。範囲外はクランプ）
  function interp(tab, x) {
    const n = tab.length;
    if (n === 1 || x <= tab[0][0]) return tab[0][1];
    if (x >= tab[n - 1][0]) return tab[n - 1][1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab[m][0] <= x) lo = m; else hi = m; }
    const a = tab[lo], b = tab[hi];
    return a[1] + (b[1] - a[1]) * (x - a[0]) / Math.max(b[0] - a[0], 1e-12);
  }
  // aeroTable: 行 "Mach,Cd[,CNa[,Xcp_mm(先端)]]" → {cd, cna, xcp, rows}（各 [[mach, v], …]、無い列は null）。1 行も読めなければ null
  function parseAeroTable(text) {
    const cols = [[], [], []];
    let rows = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l[0] === '#' || l[0] === ';') continue;
      const tk = /[,;\t]/.test(l) ? l.split(/\s*[,;\t]\s*/) : l.split(/\s+/);
      const v = tk.map(s => (s === '' ? NaN : Number(s)));
      if (!isFinite(v[0])) continue; // 見出し行など
      let any = false;
      for (let j = 0; j < 3; j++) if (isFinite(v[j + 1])) { cols[j].push([v[0], v[j + 1]]); any = true; }
      if (any) rows++;
    }
    if (!rows) return null;
    const f = a => (a.length ? a.sort((p, q) => p[0] - q[0]) : null);
    return { cd: f(cols[0]), cna: f(cols[1]), xcp: f(cols[2]), rows };
  }
  // 燃焼終了時の全機質量 [g]（ペイロード込み。normalizeCfg の検査用）
  function burnoutMassG(c) {
    if (c.massMode === 'hybrid') return c.hDryMass - (c.hFuelPre - c.hFuelPost) + c.ballast;
    let prop = c.mProp, total = c.mTotal;
    if (c.motorSrc === 'eng') {
      const e = parseEng(c.engText);
      if (e && e.hdr) { if (isFinite(e.hdr.prop)) prop = e.hdr.prop; if (isFinite(e.hdr.total)) total = e.hdr.total; }
    }
    return c.airMass + c.ballast + total - Math.min(prop, total);
  }
  const fmt = (x, n = 4) => String(+(+x).toPrecision(n));
  // 風（gust を除く）[東, 北] を返す関数を作る。opt.wind は speed / from（windDirRef 基準）で上書き（べき法則）
  function windFn(M, opt = {}) {
    let wind = M.wind, wdir = M.wdir, wTab = M.windTab, gustS = M.gust;
    if (opt.wind) {
      wind = Math.max(0, +opt.wind.speed || 0);
      const wf = ((+opt.wind.from || 0) + M.windDirOff + 180) * D2R;
      wdir = [Math.sin(wf), Math.cos(wf)]; gustS = 0; wTab = null;
    }
    const tabE = wTab && wTab.map(r => [r[0], r[1]]), tabN = wTab && wTab.map(r => [r[0], r[2]]);
    const windV = z => {
      if (wTab) { const zz = Math.max(z, 0); return [interp(tabE, zz), interp(tabN, zz)]; }
      const w = wind * Math.pow(Math.min(Math.max(z, 1), M.windMaxH) / M.windRef, M.windExp);
      return [w * wdir[0], w * wdir[1]];
    };
    return { windV, gustS };
  }
  return { clamp, interp, parseAeroTable, burnoutMassG, ENUMS, NULLABLE, fmt, windFn };
})();

// 入力を変更せず、移行・既定値マージ・補正を行った新しい cfg を返す（冪等）。補正内容は非列挙の __warn に入る
function normalizeCfg(c0) {
  const src = c0 || {};
  const W = Array.isArray(src.__warn) ? src.__warn.slice() : [];
  const warn = s => { if (!W.includes(s)) W.push(s); };
  const U = PHYS_UTIL, fmt = U.fmt;
  const o = { ...src };
  delete o.__warn;
  // 1. 旧キー recMode / delay の移行（recMode があれば rec1 の有無に関係なく上書き）
  if (o.recMode != null) {
    const mig = {
      dual: { rec1: 'apogee', rec2: 'altitude' }, apogee: { rec1: 'apogee', rec2: 'none' },
      delay: { rec1: 'burnout', rec1Time: o.delay ?? 8, rec2: 'none' }, none: { rec1: 'none', rec2: 'none' },
    };
    Object.assign(o, mig[o.recMode] || mig.dual);
  }
  delete o.recMode; delete o.delay;
  // 2. 既定値とマージ（undefined は既定値）
  const n = { ...PHYS_DEFAULTS };
  for (const k in o) if (o[k] !== undefined) n[k] = o[k];
  // 型の整理
  for (const k in PHYS_DEFAULTS) {
    const d = PHYS_DEFAULTS[k];
    let v = n[k];
    if (U.NULLABLE.includes(k)) {
      if (v === null || (typeof v === 'string' && v.trim() === '')) v = null;
      else {
        const x = typeof v === 'number' ? v : parseFloat(v);
        if (Number.isFinite(x)) v = x; else { warn(`${k} が数値でないため空欄（自動計算）にしました`); v = null; }
      }
    } else if (typeof d === 'number') {
      if (typeof v !== 'number') v = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(v)) { warn(`${k} が数値でないため既定値 ${d} を使いました`); v = d; }
    } else if (typeof d === 'boolean') {
      if (v == null) v = d;
      else if (typeof v !== 'boolean') v = v === 1 || /^(true|1|yes|on)$/i.test(String(v).trim());
    } else if (U.ENUMS[k]) {
      const s = typeof v === 'string' ? v.trim().toLowerCase() : v;
      if (U.ENUMS[k].includes(s)) v = s;
      else { if (v != null && v !== '') warn(`${k} の値「${v}」は使えないため「${d}」にしました`); v = d; }
    } else v = v == null ? d : String(v);
    n[k] = v;
  }
  // 3. 補正
  if (n.windExp > 1) { warn(`べき指数 ${fmt(n.windExp)} は n とみなし α = 1/n = ${fmt(1 / n.windExp)} にしました`); n.windExp = 1 / n.windExp; }
  if (n.windExp < 0 || n.windExp > 1) { const v = U.clamp(n.windExp, 0, 1); warn(`べき指数 α ${fmt(n.windExp)} を ${v} にしました（0〜1）`); n.windExp = v; }
  if (n.windRef < 0.1) { warn(`べき法則の基準高さ ${fmt(n.windRef)} m を 0.1 m にしました`); n.windRef = 0.1; }
  if (n.hBurnTime < 0.01) { warn(`燃焼時間 ${fmt(n.hBurnTime)} s を 0.01 s にしました`); n.hBurnTime = 0.01; }
  if (n.hFuelPost > n.hFuelPre) { warn(`燃焼後燃料質量 ${fmt(n.hFuelPost)} g が燃焼前 ${fmt(n.hFuelPre)} g を超えるため、燃焼前と同じにしました`); n.hFuelPost = n.hFuelPre; }
  { const v = U.clamp(Math.round(n.stageCount), 1, 3); if (v !== n.stageCount) { warn(`段数 ${fmt(n.stageCount)} を ${v} にしました（1〜3）`); n.stageCount = v; } }
  if (n.openTime < 0) { warn(`展開所要時間 ${fmt(n.openTime)} s を 0 s にしました`); n.openTime = 0; }
  if (n.payloadOn) {
    const mb = U.burnoutMassG(n);
    if (n.payloadMass >= 0.5 * mb) { warn(`ペイロード質量 ${fmt(n.payloadMass)} g が燃焼終了時質量 ${fmt(mb)} g の半分以上のため、ペイロード放出を無効にしました`); n.payloadOn = false; }
  }
  Object.defineProperty(n, '__warn', { value: W, enumerable: false, writable: true, configurable: true });
  return n;
}

// 全長 [mm]
function cfgLenMm(c) { return (+c.noseLen || 0) + (+c.bodyLen || 0) + (+c.tailLen || 0); }

// 日本域で磁気偏角の符号が疑わしければ警告文を返す
function declCheck(lat, lon, magDecl) {
  if (!(lat >= 24 && lat <= 46 && lon >= 122 && lon <= 154)) return null;
  if (magDecl >= -11 && magDecl <= -3) return null;
  return `日本の磁気偏角は西偏（本様式では負）。符号を確認してください（現在 ${magDecl}°）`;
}

// ENU [m] → 緯度経度 [deg]（射点の接平面。WGS84 楕円体の子午線曲率半径 M・卯酉線曲率半径 N を使う）
function enuToLatLon(lat0, lon0, x, y) {
  const s = Math.sin(lat0 * D2R), w = 1 - 0.00669437999014 * s * s, M = 6378137 * (1 - 0.00669437999014) / w ** 1.5, N = 6378137 / Math.sqrt(w);
  return [lat0 + y / M * 180 / Math.PI, lon0 + x / (N * Math.cos(lat0 * D2R)) * 180 / Math.PI];
}
// 緯度経度 [deg] → ENU [m]（enuToLatLon の逆変換）
function latLonToEnu(lat0, lon0, lat, lon) {
  const s = Math.sin(lat0 * D2R), w = 1 - 0.00669437999014 * s * s, M = 6378137 * (1 - 0.00669437999014) / w ** 1.5, N = 6378137 / Math.sqrt(w);
  return [(lon - lon0) * D2R * N * Math.cos(lat0 * D2R), (lat - lat0) * D2R * M];
}

// 回転運動の微分: du/dt = ω⊥×u, dω⊥/dt = (τ⊥ − Ir·p·(ω⊥×u))/It, dp/dt = (τ·u)/Ir
function rotDeriv(u, w, p, tau, It, Ir) {
  const du = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const ta = tau[0] * u[0] + tau[1] * u[1] + tau[2] * u[2];
  const dw = [0, 1, 2].map(i => (tau[i] - ta * u[i] - Ir * p * du[i]) / It);
  return { du, dw, dp: ta / Ir };
}

// ---------------- 物理モデル ----------------
function machFactor(M) {
  if (M < 0.8) return 1;
  if (M < 1.05) { const s = (M - 0.8) / 0.25; return 1 + 0.9 * s * s * (3 - 2 * s); }
  return 1.9 - 0.5 * Math.min((M - 1.05) / 1.5, 1);
}
function atm(M, h) {
  const T0 = M.T0sl;
  let T, p;
  if (h < 11000) { T = T0 - 0.0065 * h; p = 101325 * Math.pow(T / T0, 5.25588); }
  else { T = T0 - 71.5; p = 101325 * Math.pow(T / T0, 5.25588) * Math.exp(-G0 * (h - 11000) / (RAIR * T)); }
  return { rho: p / (RAIR * T), a: Math.sqrt(GAM * RAIR * T), T, p };
}

function buildModel(c0) {
  const c = normalizeCfg(c0);
  const warn = c.__warn.slice();
  const W = s => { if (!warn.includes(s)) warn.push(s); };
  const U = PHYS_UTIL, fmt = U.fmt;
  const mm = 1e-3, gr = 1e-3;
  const Ln = c.noseLen * mm, Lb = c.bodyLen * mm, Lt = c.tailLen * mm, d = c.d * mm, R = d / 2, A = Math.PI * R * R;
  const L = Ln + Lb + Lt;
  const hyb = c.massMode === 'hybrid', manI = c.inertiaMode === 'manual', manA = c.aeroMode === 'manual';
  // --- Barrowman ---
  const comps = [];
  const kn = { ogive: 0.466, cone: 0.666, parabolic: 0.5, elliptic: 0.333 }[c.noseShape] ?? 0.466;
  comps.push({ name: 'ノーズ', cna: 2, x: kn * Ln, fin: false });
  const dBase = Lt > 0 ? c.tailD * mm : d;
  if (Lt > 0 && Math.abs(dBase - d) > 1e-6) {
    const r = d / dBase;
    comps.push({ name: 'テール', cna: 2 * ((dBase / d) ** 2 - 1), x: Ln + Lb + Lt / 3 * (1 + 1 / (1 + r)), fin: false });
  }
  const Cr = c.finCr * mm, Ct = c.finCt * mm, s = c.finSpan * mm, Xs = c.finSweep * mm, N = Math.max(1, Math.round(c.finN));
  const Lf = Math.hypot(s, Xs + Ct / 2 - Cr / 2);
  const nFac = { 5: 0.97, 6: 0.948, 7: 0.9, 8: 0.865 }[N] ?? 1;
  let cnaF = 4 * N * (s / d) ** 2 / (1 + Math.sqrt(1 + (2 * Lf / Math.max(Cr + Ct, 1e-6)) ** 2));
  cnaF *= (1 + R / (s + R)) * nFac;
  const Xb = L - c.finAft * mm - Cr;
  const xf = Xb + Xs * (Cr + 2 * Ct) / (3 * Math.max(Cr + Ct, 1e-9)) + (1 / 6) * ((Cr + Ct) - Cr * Ct / Math.max(Cr + Ct, 1e-9));
  comps.push({ name: 'フィン', cna: cnaF, x: xf, fin: true });
  // フィンの代表半径: Ymac（翼根からの空力平均翼弦位置）と r_g² = (1/S_f)∫_R^{R+s} c(r)·r² dr
  const Ymac = s / 3 * (Cr + 2 * Ct) / Math.max(Cr + Ct, 1e-9), Rcant = R + Ymac;
  const Sf = (Cr + Ct) * s / 2, kc = s > 0 ? (Ct - Cr) / s : 0, ac = Cr - kc * R;
  const Fr = r => ac * r ** 3 / 3 + kc * r ** 4 / 4;
  const rg2 = Sf > 0 ? (Fr(R + s) - Fr(R)) / Sf : R * R;

  // --- モーター・推力曲線 ---
  let pts = null, prop = c.mProp * gr, total = c.mTotal * gr, mLen = c.mLen * mm, mDia = c.mDia * mm, mName = '';
  if (c.motorSrc === 'eng') {
    const e = parseEng(c.engText);
    if (e) {
      pts = e.pts;
      if (e.hdr) {
        if (isFinite(e.hdr.prop)) prop = e.hdr.prop * gr;
        if (isFinite(e.hdr.total)) total = e.hdr.total * gr;
        if (isFinite(e.hdr.len) && e.hdr.len > 0) mLen = e.hdr.len * mm;
        if (isFinite(e.hdr.dia) && e.hdr.dia > 0) mDia = e.hdr.dia * mm;
        mName = e.hdr.name;
      }
    } else W('推力表を読み取れなかったため、パラメトリック曲線を使いました');
  }
  if (!pts) pts = genCurve(c.mShape, c.mI, c.mTb);
  const ts = c.thrustScale / 100, bs = Math.max(c.burnScale, 1) / 100; // burnScale: 時間を伸縮し総力積は保つ
  pts = pts.map(p => [p[0] * bs, p[1] * ts / bs]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + (pts[i][1] + pts[i - 1][1]) / 2 * (pts[i][0] - pts[i - 1][0]));
  const Itot = cum[cum.length - 1], tb = pts[pts.length - 1][0];
  let Fmax = 0;
  for (const p of pts) if (p[1] > Fmax) Fmax = p[1];
  if (!(Itot > 0)) W('推力曲線の総力積が 0 です');
  // 推力が初めて lv 以上になる時刻 / 最後に lv 以上である時刻（線形補間）
  const crossUp = lv => {
    for (let i = 0; i < pts.length; i++) if (pts[i][1] >= lv) {
      if (i === 0) return pts[0][0];
      const a = pts[i - 1], b = pts[i];
      return a[0] + (b[0] - a[0]) * (lv - a[1]) / (b[1] - a[1]);
    }
    return 0;
  };
  const crossDown = lv => {
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i][1] >= lv) {
      if (i === pts.length - 1) return pts[i][0];
      const a = pts[i], b = pts[i + 1];
      return a[0] + (b[0] - a[0]) * (a[1] - lv) / (a[1] - b[1]);
    }
    return 0;
  };
  const tIgn = Fmax > 0 ? crossUp(0.05 * Fmax) : 0;
  const opTimeCurve = Fmax > 0 ? crossDown(0.1 * Fmax) - crossUp(0.1 * Fmax) : 0;
  prop = Math.min(prop, total);
  const caseM = total - prop;
  const motorX = L - mLen / 2 + c.mOver * mm;
  const seg = t => { let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) lo = m; else hi = m; } return lo; };
  const curveF = t => {
    if (t <= 0 || t >= tb) return 0;
    const i = seg(t), a = pts[i], b = pts[i + 1];
    return a[1] + (b[1] - a[1]) * (t - a[0]) / Math.max(b[0] - a[0], 1e-12);
  };
  const cumAt = t => {
    if (t <= 0) return 0; if (t >= tb) return Itot;
    const i = seg(t); return cum[i] + (pts[i][1] + curveF(t)) / 2 * (t - pts[i][0]);
  };
  // 大気（射点標高から T0 を決める）と圧力推力
  const T0sl = c.temp + 273.15 + 0.0065 * c.siteAlt, atmRef = { T0sl };
  const pSite = atm(atmRef, Math.max(c.siteAlt, 0)).p;
  const Ae = c.nozzleExitD > 0 ? Math.PI * (c.nozzleExitD * mm / 2) ** 2 : 0;
  // thrust(t) は曲線の値。z [m]（射点からの高度）を渡すとノズル出口の圧力推力補正を加える
  const thrust = (t, z) => {
    const F = curveF(t);
    if (!(F > 0) || !(Ae > 0) || z === undefined) return F;
    return F + (pSite - atm(atmRef, Math.max(c.siteAlt + z, 0)).p) * Ae * Math.min(1, F / (0.05 * Fmax));
  };

  // --- 質量・重心・慣性 ---
  const air = c.airMass * gr, airX = (c.airCG + c.cgShift) * mm, bal = c.ballast * gr, balX = c.ballastPos * mm;
  const payOn = !!c.payloadOn, mPay = c.payloadMass * gr, xPay = c.payloadPos * mm;
  const hDry = c.hDryMass * gr, hDryX = (c.hDryCG + c.cgShift) * mm, hOx = c.hOxMass * gr, hOxX = c.hOxCG * mm, hOutX = c.hTankOutlet * mm;
  const hDf = (c.hFuelPre - c.hFuelPost) * gr, hFuelX = c.hFuelCG * mm, tBurn = c.hBurnTime * bs;
  const tEnd = hyb ? Math.max(tb, tIgn + tBurn) : tb;
  const Idry = manI ? c.Ipitch : hyb ? hDry * L * L / 12 : null; // motor の auto は従来の近似（下で個別に計算）
  const floorHit = { I: false, Ir: false };
  const finish = (m, cg, I) => {
    const Imin = 0.01 * m * L * L;
    if (!(I >= Imin)) { I = Imin; floorHit.I = true; }
    let Ir = manI ? c.Iroll : 0.5 * m * R * R;
    const Irmin = 0.05 * m * R * R;
    if (!(Ir >= Irmin)) { Ir = Irmin; floorHit.Ir = true; }
    return { m, cg, I, Ir };
  };
  // massAt(t, released) → {m [kg], cg [m, 先端から], I [kg·m², 現在重心まわりのピッチ], Ir [kg·m², ロール]}
  const massAt = (t, released = false) => {
    const rel = released && payOn, mp = rel ? mPay : 0;
    if (hyb) {
      const f = U.clamp(1 - (t - tIgn) / tBurn, 0, 1);
      const mox = hOx * f, dmf = hDf * (1 - f), xox = c.hOxDrain ? hOutX + f * (hOxX - hOutX) : hOxX;
      const m = hDry + mox - dmf + bal - mp;
      const cg = (hDry * hDryX + mox * xox - dmf * hFuelX + bal * balX - mp * xPay) / m;
      const I = Idry + hDry * (hDryX - cg) ** 2 + mox * (xox - cg) ** 2 - dmf * (hFuelX - cg) ** 2
        + bal * (balX - cg) ** 2 - mp * (xPay - cg) ** 2;
      return finish(m, cg, I);
    }
    const mmot = caseM + prop * (1 - (Itot > 0 ? cumAt(t) / Itot : 1)), m = air + bal + mmot - mp;
    const cg = (air * airX + bal * balX + mmot * motorX - mp * xPay) / m;
    const Iair = manI ? Idry + air * (airX - cg) ** 2 : air * (L * L / 12 + (airX - cg) ** 2);
    const I = Iair + bal * (balX - cg) ** 2 + mmot * (mLen * mLen / 12 + (motorX - cg) ** 2) - mp * (xPay - cg) ** 2;
    return finish(m, cg, I);
  };
  // 下限張り付きの検査（代表時刻）
  massAt(0); massAt(tIgn + tBurn / 2); massAt(tEnd); if (payOn) massAt(tEnd, true);
  if (floorHit.I) W('ピッチ慣性モーメントが下限 0.01·m·L² に張り付きました（入力値を確認）');
  if (floorHit.Ir) W('ロール慣性モーメントが下限 0.05·m·(d/2)² に張り付きました（入力値を確認）');
  if (manI) {
    const mDry = hyb ? hDry : air, k = c.Ipitch / (mDry * L * L);
    if (!(k >= 0.02 && k <= 0.3)) W(`ピッチ慣性モーメント ${fmt(c.Ipitch)} kg·m² が乾燥質量・全長から見て不自然です。単位（kg·m²）を確認`);
  }
  if (hyb) {
    if (tBurn > tb + 1e-9) W(`燃焼時間 ${fmt(tBurn)} s が作動時間（推力曲線の終わり ${fmt(tb)} s）を超えています`);
    if (c.hOpTime > 0 && tBurn > c.hOpTime + 1e-9) W(`燃焼時間 ${fmt(tBurn)} s が作動時間 ${fmt(c.hOpTime)} s を超えています`);
  }

  // --- 抗力係数推定（Mandell / Barrowman 系の簡易式） ---
  const Re = 100 * L / 1.5e-5, Cf = 0.074 / Math.pow(Re, 0.2);
  const fr = L / d;
  const cdFB = (1 + 60 / fr ** 3 + 0.0025 * fr) * (2.7 * Ln / d + 4 * Lb / d + 2 * (1 - dBase / d) * Lt / d) * Cf;
  const cdBase = 0.029 * (dBase / d) ** 3 / Math.sqrt(Math.max(cdFB, 1e-4));
  const cMean = Math.max((Cr + Ct) / 2, 1e-6);
  const cdFin = 2 * Cf * (1 + 2 * (c.finThick * mm) / cMean) * 4 * N * Sf / (Math.PI * d * d);
  const cdEst = (cdFB + cdBase + cdFin) * 1.3; // 干渉・レールボタン・表面粗さ等の余裕

  // --- 空力: barrowman / manual / aeroTable ---
  const aeroTxt = String(c.aeroTable || '').trim();
  const tab = aeroTxt ? U.parseAeroTable(aeroTxt) : null;
  if (aeroTxt && !tab) W('空力表（aeroTable）を読み取れませんでした（行: Mach,Cd[,CNa[,Xcp_mm]]）');
  const machCorr = !!c.machCorr && !manA;
  const baseCd = manA || c.cdMode === 'manual' ? c.cdManual : cdEst;
  const cdAt = Mn => (tab && tab.cd ? U.interp(tab.cd, Mn) : baseCd * (machCorr ? machFactor(Mn) : 1)) * c.cdScale / 100;
  const cd0 = cdAt(0);
  // Barrowman の和（pg: フィンに Prandtl–Glauert 補正を掛ける）
  const barrow = (Mn, pg) => {
    const kf = pg ? 1 / Math.sqrt(1 - Math.min(Mn, 0.8) ** 2) : 1;
    let s0 = 0, s1 = 0, s2 = 0, cf = 0;
    for (const p of comps) { const k = p.cna * (p.fin ? kf : 1); s0 += k; s1 += k * p.x; s2 += k * p.x * p.x; if (p.fin) cf += k; }
    return { cna: s0, xcp: s0 !== 0 ? s1 / s0 : 0, s0, s1, s2, cnaF: cf };
  };
  const geo0 = barrow(0, false);
  const bAt = Mn => (manA ? geo0 : barrow(Mn, machCorr));
  // cpAt(mach) → {cna [1/rad], xcp [m, 先端から], s0, s1, s2（Barrowman の和）, cnaF（干渉込みフィン群の CNα）}
  const cpAt = Mn => {
    const b = bAt(Mn);
    let cna = manA ? c.cnaManual : b.cna, xcp = manA ? c.cpManual * mm : b.xcp;
    if (tab && tab.cna) cna = U.interp(tab.cna, Mn);
    if (tab && tab.xcp) xcp = U.interp(tab.xcp, Mn) * mm;
    cna *= c.cnaScale / 100; xcp += c.cpShift * mm;
    return { cna, xcp, s0: b.s0, s1: b.s1, s2: b.s2, cnaF: b.cnaF };
  };
  // 減衰係数（L 基準）。モーメント = 0.25·ρ·V_a·A·L²·C·ω
  const cmqEq = (cg, Mn = 0) => { const b = bAt(Mn); return -2 * Math.max(0, b.s2 - 2 * cg * b.s1 + cg * cg * b.s0) / (L * L); };
  const cmqAt = (Mn, cg) => (manA && c.cmq !== null ? c.cmq : cmqEq(cg, Mn));
  const clpEq = (Mn = 0) => -4 * bAt(Mn).cnaF * rg2 / (L * L);
  const clpAt = Mn => (manA && c.clp !== null ? c.clp : clpEq(Mn));
  // フィン取付角によるロール励起モーメント [N·m]（+u まわり）。q は対気動圧
  const cant = c.finCant * D2R;
  const cantMoment = (q, Mn) => 2 * bAt(Mn).cnaF * q * A * cant * Rcant;
  if (manA && c.finCant !== 0 && c.clp !== null) {
    const r = Math.abs(c.clp) / Math.max(Math.abs(clpEq(0)), 1e-12);
    if (r < 0.2 || r > 5) W('ロール減衰係数の基準長（全長 L）を確認');
  }

  // --- 回収系・ペイロードの CdA ---
  const mRef = massAt(tEnd).m; // 燃焼終了時の全機質量（ペイロード込み）
  const vel = c.chuteSpec === 'velocity';
  const cdsV = (mk, vt) => (vt > 0 ? 2 * mk * G_SHEET / (RHO0_SHEET * vt * vt) : 0);
  const eqDia = cda => 2 * Math.sqrt(Math.max(cda, 0) / (Math.PI * 0.8));
  const chS = Math.max(c.chuteScale, 0) / 100;
  const c1CdA = (vel ? cdsV(mRef, c.c1Vt) : c.c1Cd * Math.PI * (c.c1D * mm / 2) ** 2) * chS;
  const c2CdA = (vel ? cdsV(mRef, c.c2Vt) : c.c2Cd * Math.PI * (c.c2D * mm / 2) ** 2) * chS;
  const payloadCdA = cdsV(mPay, c.payloadVt);
  if (vel && c.rec1 !== 'none' && !(c.c1Vt > 0)) W('1段目の終端速度が 0 以下です');
  if (vel && c.rec1 !== 'none' && c.rec2 !== 'none' && !(c.c2Vt > 0)) W('2段目の終端速度が 0 以下です');
  if (payOn && !(c.payloadVt > 0)) W('ペイロードの終端速度が 0 以下です');

  // --- 方位・風（真北基準に直す） ---
  // 磁気偏角: auto は WMM2025（geo.js）で射点・打上げ日から計算
  const G = typeof window !== 'undefined' ? window.Geo : null;
  const decl = c.magMode === 'auto' && G ? G.magDecl(c.lat, c.lon, c.siteAlt, G.decimalYear(c.launchDate)) : c.magDecl;
  if (c.magMode === 'auto' && !G) W('geo.js が無いため磁気偏角の自動計算ができません（手入力値を使いました）');
  const azDeg = ((c.azim + (c.azimRef === 'magnetic' ? decl : 0)) % 360 + 360) % 360;
  const windDirOff = c.windDirRef === 'magnetic' ? decl : 0;
  // 風プロファイル（高度[m], 風速[m/s], 風向[deg, windDirRef 基準]）→ [[z, 東, 北], …]（風下方向の速度成分）
  let windTab = null;
  if (c.windModel === 'profile') {
    const rows = [];
    for (const raw of String(c.windProfile || '').split(/\r?\n/)) {
      const v = raw.trim().split(/[\s,;\t]+/).map(Number);
      if (v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) {
        const to = (v[2] + windDirOff + 180) * D2R;
        rows.push([v[0], v[1] * Math.sin(to), v[1] * Math.cos(to)]);
      }
    }
    if (rows.length) windTab = rows.sort((a, b) => a[0] - b[0]);
    else W('風プロファイルを読み取れなかったため、べき法則を使いました（行: 高度m,風速m/s,風向deg）');
  }
  // 地形: landSurface 'terrain' は terrain.js の標高タイル（取得済みの範囲）から地面の高さを求める
  const T = typeof window !== 'undefined' ? window.Terrain : null;
  let groundZ = null;
  if (c.landSurface === 'terrain') {
    const h0 = T && T.height(c.lat, c.lon);
    if (h0 == null) W('地形データが無いため、着地面は射点の高さとしました（落下分散タブ等で地形を取得してください）');
    else groundZ = (x, y) => { const [la, lo] = enuToLatLon(c.lat, c.lon, x, y), h = T.height(la, lo); return h == null ? 0 : h - h0; };
  }
  const tipOff = !!c.tipOff && c.lugUpper > c.lugAft;
  if (c.tipOff && !tipOff) W('ティップオフ: 上側ラグ位置が下側ラグ（後端〜最後尾ラグ）より前方にないため無効にしました');
  const windFromTrue = ((c.windFrom + windDirOff) % 360 + 360) % 360;
  const wf = (windFromTrue + 180) * D2R;

  const single = {
    c, warn, name: c.name, massMode: c.massMode,
    L, d, R, A, Ln, Lb, Lt, dBase, comps, Cr, Ct, s, Xs, Xb, N,
    Ymac, Rcant, rg2, Sf, cant,
    pts, Itot, Fmax, tb, tIgn, burnTime: hyb ? tBurn : tb, tEnd, opTimeCurve,
    prop: hyb ? hOx + hDf : prop, total, caseM, mLen, mDia, motorX, mName, thrust, Ae, pSite, massAt, mRef,
    cdEst, cd0, cdAt, cpAt, aeroTab: tab, cmqEq, clpEq, cmqAt, clpAt, cantMoment,
    chuteVel: vel, c1CdA, c2CdA, payloadCdA,
    c1Dia: vel ? eqDia(c1CdA) : c.c1D * mm, c2Dia: vel ? eqDia(c2CdA) : c.c2D * mm, payloadDia: eqDia(payloadCdA),
    payloadOn: payOn, payloadMass: mPay, payloadPos: xPay, payloadTime: c.payloadTime,
    mainAlt: c.mainAlt, openTime: c.openTime,
    siteAlt: c.siteAlt, T0sl, lat: c.lat, lon: c.lon,
    railLen: c.railLen, lugAft: c.lugAft * mm, railEff: Math.max(c.railLen - c.lugAft * mm, 0),
    tipOff, railUp: Math.max(c.railLen - c.lugUpper * mm, 0),
    landZ: c.landSurface === 'sea' ? -c.siteAlt : 0, groundZ, magDecl: decl,
    earthRot: !!c.earthRot, omegaENU: G && c.earthRot ? [0, G.OMEGA * Math.cos(c.lat * D2R), G.OMEGA * Math.sin(c.lat * D2R)] : [0, 0, 0],
    windTab, windMaxH: c.windMaxH > 0 ? c.windMaxH : Infinity, chuteDelay: c.chuteDelay,
    elev: Math.min(90, Math.max(1, c.elev)) * D2R, trueAzim: azDeg * D2R, azim: azDeg * D2R,
    wind: Math.max(0, c.wind), wdir: [Math.sin(wf), Math.cos(wf)], windFromTrue, windDirOff, windRef: c.windRef, windExp: c.windExp, gust: Math.max(0, c.gust),
    dt: Math.min(0.02, Math.max(0.0005, c.dt / 1000)),
  };
  return c.stageCount > 1 ? buildStack(single) : single;
}

// ---------------- 多段式 ----------------
// 元の機体 orig（打上げ時の全体）を分離面で分割して「段ごとのモデル」を作る。位置はすべて機体先端基準 [m]
// 最下段 = 元のモーターとフィン、その上の段は up*/mid* の入力。最下段の質量は全体から上の段を引いた残り
// 戻り値 F: 点火時の全段（静的な表示用）。F.top = 最上段、F.orig = 元の機体、F.stack = {stages, segs（各段の燃焼中の積み上げモデル）, ign, sep}
function buildStack(orig) {
  let c = orig.c;                                          // 段の諸元を作るまでは元の機体の設定。その後は最上段の設定に切り替える
  const mm = 1e-3, gr = 1e-3, warn = orig.warn, U = PHYS_UTIL;
  const W = s => { if (!warn.includes(s)) warn.push(s); };
  const bs = Math.max(c.burnScale, 1) / 100, ts = c.thrustScale / 100;
  const three = c.stageCount === 3, Lall = orig.L, minLen = 0.05;
  // 分離面（先端から）: 最上段の後端 s1、3 段式は中段の後端 s2
  let s1 = c.upSep * mm, s2 = three ? c.midSep * mm : Lall;
  { const lo = orig.Ln + minLen, hi = Lall - minLen * (three ? 2 : 1), v = U.clamp(s1, lo, Math.max(lo, hi));
    if (Math.abs(v - s1) > 1e-9) { W(`最上段の分離位置 ${U.fmt(c.upSep)} mm を ${U.fmt(v / mm)} mm にしました（ノーズより後ろ・機体後端より前）`); s1 = v; } }
  if (three) { const lo = s1 + minLen, hi = Lall - minLen, v = U.clamp(s2, lo, Math.max(lo, hi));
    if (Math.abs(v - s2) > 1e-9) { W(`中段の分離位置 ${U.fmt(c.midSep)} mm を ${U.fmt(v / mm)} mm にしました（最上段の分離位置より後ろ・機体後端より前）`); s2 = v; } }
  if (c.aeroMode === 'manual') W('多段式では空力係数の直接入力を使わず、Barrowman 法で段ごとに計算します');
  // 最上段: 元の機体の前側。質量・モーター・フィンは up* の入力
  const inTop = x => x * mm < s1;
  const top = buildModel({
    ...c, stageCount: 1, bodyLen: (s1 - orig.Ln) / mm, tailLen: 0, massMode: 'motor', inertiaMode: 'auto', aeroMode: 'barrowman',
    airMass: c.upMass, airCG: c.upCG - c.cgShift, ballast: inTop(c.ballastPos) ? c.ballast : 0, payloadOn: c.payloadOn && inTop(c.payloadPos),
    motorSrc: c.upSrc, engText: c.upEng, mI: c.upI, mTb: c.upTb, mShape: c.upShape, mProp: c.upProp, mTotal: c.upProp, mLen: c.upMotorLen, mOver: 0, nozzleExitD: 0,
    finN: c.upFinN, finCr: c.upFinCr, finCt: c.upFinCt, finSpan: c.upFinSpan, finSweep: c.upFinSweep, finAft: c.upFinAft, finThick: c.upFinThick,
    thrustKind: 'measured',
  });
  for (const w of top.warn) W('最上段: ' + w);
  top.warn = warn;
  if (c.payloadOn && !inTop(c.payloadPos)) W('ペイロードの位置が最上段の外にあるため、ペイロードの放出を計算しません');
  // 段の諸元 → 計算用の段。sp: {k, Len, D, Mass, CG, Prop, PropCG（段の前端から）, pts, フィン, SepDelay, IgnDelay, Vt, ChuteDelay}
  const mkStage = (sp, i) => {
    const pts = sp.pts;
    const cum = [0];
    for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + (pts[j][1] + pts[j - 1][1]) / 2 * (pts[j][0] - pts[j - 1][0]));
    const Itot = cum[cum.length - 1], tb = pts[pts.length - 1][0];
    if (!(Itot > 0)) W(`${i + 1}段目の総力積が 0 です`);
    const seg = t => { let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) lo = m; else hi = m; } return lo; };
    const F = t => { if (t <= 0 || t >= tb) return 0; const j = seg(t), a = pts[j], b = pts[j + 1]; return a[1] + (b[1] - a[1]) * (t - a[0]) / Math.max(b[0] - a[0], 1e-12); };
    const cumAt = t => { if (t <= 0) return 0; if (t >= tb) return Itot; const j = seg(t); return cum[j] + (pts[j][1] + F(t)) / 2 * (t - pts[j][0]); };
    const L = sp.Len, d = sp.D, R = d / 2, Cr = sp.FinCr, Ct = sp.FinCt, span = sp.FinSpan, Xs = sp.FinSweep, N = Math.max(1, Math.round(sp.FinN));
    const lf = Math.hypot(span, Xs + Ct / 2 - Cr / 2), nf = { 5: 0.97, 6: 0.948, 7: 0.9, 8: 0.865 }[N] ?? 1;
    const cnaF = span > 0 ? (1 + R / (span + R)) * nf * 4 * N * (span / d) ** 2 / (1 + Math.sqrt(1 + (2 * lf / Math.max(Cr + Ct, 1e-6)) ** 2)) : 0;
    const xfLocal = L - sp.FinAft - Cr + Xs * (Cr + 2 * Ct) / (3 * Math.max(Cr + Ct, 1e-9)) + (1 / 6) * ((Cr + Ct) - Cr * Ct / Math.max(Cr + Ct, 1e-9));
    const Sf = (Cr + Ct) * span / 2, kc = span > 0 ? (Ct - Cr) / span : 0, ac = Cr - kc * R, Fr = r => ac * r ** 3 / 3 + kc * r ** 4 / 4;
    const rg2 = Sf > 0 ? (Fr(R + span) - Fr(R)) / Sf : R * R;
    return { k: sp.k, no: i + 1, pts, F, cumAt, Itot, tb, L, d, R, Cr, Ct, sp: span, Xs, N, Sf, finThick: sp.FinThick, finAft: sp.FinAft, mDry: sp.Mass, xDry: sp.CG, prop: sp.Prop, xProp: sp.PropCG,
      cnaF, xfLocal, rg2, sepDelay: Math.max(sp.SepDelay, 0), ignDelay: Math.max(sp.IgnDelay, 0), vt: sp.Vt, chuteDelay: Math.max(sp.ChuteDelay, 0), tailLen: sp.tailLen || 0, tailD: sp.tailD || d };
  };
  // 中段（3 段式）: mid* の入力
  let midSp = null;
  if (three) {
    let pts = null;
    if (c.midSrc === 'eng') { const e = parseEng(c.midEng); if (e) pts = e.pts; else W('中段の推力表を読み取れなかったため、パラメトリック曲線を使いました'); }
    if (!pts) pts = genCurve(c.midShape, c.midI, c.midTb);
    const Len = s2 - s1;
    midSp = { k: 'mid', Len, D: orig.d, Mass: c.midMass * gr, CG: U.clamp(c.midCG * mm - s1, 0, Len), Prop: c.midProp * gr, PropCG: Math.max(Len - c.midMotorLen * mm / 2, 0),
      pts: pts.map(q => [q[0] * bs, q[1] * ts / bs]), FinN: c.midFinN, FinCr: c.midFinCr * mm, FinCt: c.midFinCt * mm, FinSpan: c.midFinSpan * mm, FinSweep: c.midFinSweep * mm,
      FinAft: c.midFinAft * mm, FinThick: c.midFinThick * mm, SepDelay: c.upSepDelay, IgnDelay: c.upIgnDelay, Vt: c.upDropVt, ChuteDelay: c.upDropChuteDelay };
    if (c.midCG * mm < s1 || c.midCG * mm > s2) W(`中段の重心 ${U.fmt(c.midCG)} mm が中段の範囲（${U.fmt(s1 / mm)}〜${U.fmt(s2 / mm)} mm）の外にあります`);
  }
  // 最下段: 元の機体（モーター・フィン・ボートテール）から上の段を引いた残り
  const lowP = three ? 'mid' : 'up';
  const x0L = three ? s2 : s1, LenL = Lall - x0L;
  const w0 = orig.massAt(-1), w1 = orig.massAt(orig.tEnd + 1);
  const propL = Math.max(w0.m - w1.m, 0), xPropL = propL > 1e-9 ? (w0.m * w0.cg - w1.m * w1.cg) / propL : Lall - LenL / 2;
  const t1 = top.massAt(top.tEnd + 1);                     // 最上段（推進剤なし・ペイロードとバラスト込み）
  const above = [[t1.m, t1.cg]]; if (midSp) above.push([midSp.Mass, s1 + midSp.CG]);
  let mL = w1.m - above.reduce((a, q) => a + q[0], 0), xL = (w1.m * w1.cg - above.reduce((a, q) => a + q[0] * q[1], 0)) / mL;
  if (!(mL > 0.02 * w1.m)) {
    W(`上の段の質量の合計（${(above.reduce((a, q) => a + q[0], 0) / gr).toFixed(0)} g）が機体全体の燃焼後質量（${(w1.m / gr).toFixed(0)} g）以上です。最下段の質量を全体の 10 % として計算しました`);
    mL = 0.1 * w1.m; xL = x0L + LenL / 2;
  } else if (xL < x0L || xL > Lall) {
    W(`最下段の重心が最下段の範囲の外になりました（先端から ${(xL / mm).toFixed(0)} mm）。機体全体の重心と上の段の質量・重心の入力を確認してください`);
    xL = U.clamp(xL, x0L, Lall);
  }
  const lowSp = { k: 'low', Len: LenL, D: orig.d, Mass: mL, CG: xL - x0L, Prop: propL, PropCG: U.clamp(xPropL - x0L, 0, LenL), pts: orig.pts,
    FinN: orig.N, FinCr: orig.Cr, FinCt: orig.Ct, FinSpan: c.finSpan * mm, FinSweep: c.finSweep * mm, FinAft: c.finAft * mm, FinThick: c.finThick * mm,
    SepDelay: c[lowP + 'SepDelay'], IgnDelay: c[lowP + 'IgnDelay'], Vt: c[lowP + 'DropVt'], ChuteDelay: c[lowP + 'DropChuteDelay'], tailLen: orig.Lt || 0, tailD: orig.dBase };
  if (orig.Cr + c.finAft * mm > LenL) W('元のフィンが最下段に収まっていません（分離面がフィンにかかっています）');
  const stages = (midSp ? [lowSp, midSp] : [lowSp]).map(mkStage); // 点火順（下から）
  c = top.c;
  // 段の位置（最上段の後端から下へ積む）: x0 = その段の前端の位置
  { let x = top.L; for (let i = stages.length - 1; i >= 0; i--) { stages[i].x0 = x; x += stages[i].L; } }
  // 時刻（点火・分離）: 分離 = 点火 + 作動時間 + 分離遅れ、次段の点火 = 分離 + 点火遅れ
  const ign = [], sep = [];
  { let t = 0; stages.forEach((b, i) => { ign[i] = t; sep[i] = t + b.tb + b.sepDelay; t = sep[i] + b.ignDelay; }); ign[stages.length] = t; }
  const topIgn = ign[stages.length];
  const top0 = top.massAt(-1); // 点火前の最上段
  const cdRatio = top.cdEst > 0 ? top.cdAt(0) / top.cdEst : 1;
  // i 段目（点火順）が燃焼中の積み上げモデル。時刻は i 段目の点火からの時間
  const mkSeg = i => {
    const att = stages.slice(i); // i 段目から上の段（最上段を除く）
    const L = att[0].x0 + att[0].L, dRef = Math.max(top.d, ...att.map(b => b.d)), R = dRef / 2, A = Math.PI * R * R;
    const sc = d => (d / dRef) ** 2;
    const comps = top.comps.map(p => ({ cna: p.cna * sc(top.d), x: p.x, fin: p.fin, rg2: p.fin ? top.rg2 : 0 }));
    let dAbove = top.dBase;
    for (let j = att.length - 1; j >= 0; j--) { // 上の段から順に
      const b = att[j];
      if (Math.abs(b.d - dAbove) > 1e-6) comps.push({ cna: 2 * (sc(b.d) - sc(dAbove)), x: b.x0, fin: false, rg2: 0 }); // 段間の径の変化
      comps.push({ cna: b.cnaF * sc(b.d), x: b.x0 + b.xfLocal, fin: true, rg2: b.rg2 });
      dAbove = b.d;
    }
    const mc = !!c.machCorr && c.aeroMode !== 'manual';
    const barrow = Mn => {
      const kf = mc ? 1 / Math.sqrt(1 - Math.min(Mn, 0.8) ** 2) : 1;
      let s0 = 0, s1 = 0, s2 = 0, cf = 0, cr = 0;
      for (const p of comps) { const v = p.cna * (p.fin ? kf : 1); s0 += v; s1 += v * p.x; s2 += v * p.x * p.x; if (p.fin) { cf += v; cr += v * p.rg2; } }
      return { s0, s1, s2, cf, cr };
    };
    const cpAt = Mn => {
      const b = barrow(Mn);
      return { cna: b.s0 * c.cnaScale / 100, xcp: (b.s0 !== 0 ? b.s1 / b.s0 : 0) + c.cpShift * mm, s0: b.s0, s1: b.s1, s2: b.s2, cnaF: b.cf };
    };
    const cmqEq = (cg, Mn = 0) => { const b = barrow(Mn); return -2 * Math.max(0, b.s2 - 2 * cg * b.s1 + cg * cg * b.s0) / (L * L); };
    const clpEq = (Mn = 0) => -4 * barrow(Mn).cr / (L * L);
    // 抗力: 積み上げ全体を 1 本の機体として Mandell 系の簡易式で推定し、最上段の Cd の倍率（手入力・cdScale）を掛ける
    const Re = 100 * L / 1.5e-5, Cf = 0.074 / Math.pow(Re, 0.2), fr = L / dRef, dB = att[0].d;
    const cdFB = (1 + 60 / fr ** 3 + 0.0025 * fr) * (2.7 * top.Ln / dRef + 4 * (L - top.Ln) / dRef) * Cf;
    const cdBase = 0.029 * (dB / dRef) ** 3 / Math.sqrt(Math.max(cdFB, 1e-4));
    let cdFin = 2 * Cf * (1 + 2 * (c.finThick * mm) / Math.max((top.Cr + top.Ct) / 2, 1e-6)) * 4 * top.N * top.Sf / (Math.PI * dRef * dRef);
    for (const b of att) cdFin += 2 * Cf * (1 + 2 * b.finThick / Math.max((b.Cr + b.Ct) / 2, 1e-6)) * 4 * b.N * b.Sf / (Math.PI * dRef * dRef);
    const cd0 = (cdFB + cdBase + cdFin) * 1.3 * cdRatio;
    const cdAt = Mn => cd0 * (mc ? machFactor(Mn) : 1);
    const self = att[0];
    const massAt = t => {
      const parts = [[top0.m, top0.cg, top0.I, top0.Ir]];
      for (const b of att) {
        const pr = b === self ? b.prop * (1 - (b.Itot > 0 ? b.cumAt(t) / b.Itot : 1)) : b.prop;
        const m = b.mDry + pr, x = b.x0 + (b.mDry * b.xDry + pr * b.xProp) / Math.max(m, 1e-9);
        parts.push([m, x, m * b.L * b.L / 12, 0.5 * m * b.R * b.R]);
      }
      const m = parts.reduce((a, q) => a + q[0], 0), cg = parts.reduce((a, q) => a + q[0] * q[1], 0) / m;
      const I = parts.reduce((a, q) => a + q[2] + q[0] * (q[1] - cg) ** 2, 0), Ir = parts.reduce((a, q) => a + q[3], 0);
      return { m, cg, I, Ir };
    };
    return {
      ...top, c: { ...c, rec1: 'none', rec2: 'none', payloadOn: false }, stageNo: i + 1, L, d: dRef, R, A, massAt, cpAt, cdAt, cd0, cdEst: cd0, cmqEq, clpEq,
      cmqAt: (Mn, cg) => cmqEq(cg, Mn), clpAt: Mn => clpEq(Mn), cantMoment: (q, Mn) => top.cantMoment(q, Mn) * sc(top.d),
      thrust: t => self.F(t), pts: self.pts, Itot: self.Itot, tb: self.tb, tIgn: 0, tEnd: self.tb, burnTime: self.tb,
      payloadOn: false, payloadMass: 0, comps,
    };
  };
  const segs = stages.map((_, i) => mkSeg(i));
  // 全体（時刻は最初の点火から）
  const allPts = [];
  stages.forEach((b, i) => b.pts.forEach(p => allPts.push([p[0] + ign[i], p[1]])));
  top.pts.forEach(p => allPts.push([p[0] + topIgn, p[1]]));
  allPts.sort((a, b) => a[0] - b[0]);
  const massAtG = (t, rel = false) => {
    for (let i = 0; i < stages.length; i++) if (t < sep[i]) return segs[i].massAt(t - ign[i]);
    return top.massAt(t - topIgn, rel);
  };
  const thrustG = (t, z) => {
    for (let i = 0; i < stages.length; i++) if (t < sep[i]) return segs[i].thrust(t - ign[i]);
    return top.thrust(t - topIgn, z);
  };
  const cdaAt = (t, Mn) => {
    for (let i = 0; i < stages.length; i++) if (t < sep[i]) return segs[i].A * segs[i].cdAt(Mn);
    return top.A * top.cdAt(Mn);
  };
  const s0 = segs[0], Itot = stages.reduce((a, b) => a + b.Itot, top.Itot);
  return {
    ...s0, c: top.c, top, orig, stack: { stages, segs, ign, sep, topIgn }, warn, topIgn,
    massAt: massAtG, thrust: thrustG, cdaAt, pts: allPts, Itot, Fmax: Math.max(top.Fmax, ...stages.map(b => Math.max(...b.pts.map(p => p[1])))),
    tb: topIgn + top.tb, tIgn: s0.tIgn, burnTime: top.burnTime, tEnd: topIgn + top.tEnd, opTimeCurve: top.opTimeCurve,
    prop: stages.reduce((a, b) => a + b.prop, top.prop), massDropped: stages.reduce((a, b) => a + b.mDry, 0),
    payloadOn: top.payloadOn, payloadMass: top.payloadMass, payloadPos: top.payloadPos, payloadCdA: top.payloadCdA, mRef: top.mRef,
  };
}
// 段構成ごとの静的な安定性（点火時・燃焼終了時）。多段でなければ null
function stageTable(M) {
  if (!M.stack) return null;
  const { stages, segs, ign } = M.stack, T = M.top, rows = [];
  const row = (label, Mx, t, F, no) => {
    const ms = Mx.massAt(t), cp = Mx.cpAt(0);
    rows.push({ label, stage: no, m: ms.m, L: Mx.L, cg: ms.cg, cp: cp.xcp, sm: (cp.xcp - ms.cg) / Mx.d, fst: (cp.xcp - ms.cg) / Mx.L * 100, twr: F / (ms.m * G0) });
  };
  stages.forEach((b, i) => {
    const avg = b.tb > 0 ? b.Itot / b.tb : 0, n = stages.length - i + 1;
    row(i === 0 ? `1段目 点火時（打上げ時の全体）` : `${b.no}段目 点火時（${n} 段分）`, segs[i], 0, avg, b.no);
    row(`${b.no}段目 燃焼終了時`, segs[i], b.tb, 0, b.no);
  });
  const no = stages.length + 1, avgT = T.tb > 0 ? T.Itot / T.tb : 0;
  row(`${no}段目（最上段）点火時`, T, 0, avgT, no);
  row(`${no}段目（最上段）燃焼終了時`, T, T.tEnd, 0, no);
  return rows;
}

// ---------------- 審査用の計算値 ----------------
// [key, 項目名（審査用シート/分野別確認シートの表記）, 単位]。表示順
const REVIEW_LABELS = [
  ['L_mm', '全長', 'mm'], ['d_mm', '代表直径（外径）', 'mm'], ['trueAzim_deg', '打上方位角（真北基準）', 'deg'],
  ['massWet_kg', '酸化剤充填時質量', 'kg'], ['massDry_kg', '酸化剤非充填時質量（乾燥質量）', 'kg'], ['massBurnout_kg', '燃焼終了時質量', 'kg'],
  ['cgWet_aft_mm', '酸化剤充填時重心（機体後端から）', 'mm'], ['cgDry_aft_mm', '酸化剤非充填時重心（機体後端から）', 'mm'], ['cgBurnout_aft_mm', '燃焼終了時重心（機体後端から）', 'mm'],
  ['cgWet_nose_mm', '酸化剤充填時重心（先端から）', 'mm'], ['cgDry_nose_mm', '酸化剤非充填時重心（先端から）', 'mm'], ['cgBurnout_nose_mm', '燃焼終了時重心（先端から）', 'mm'],
  ['cp_aft_mm', '全機圧力中心（機体後端から）', 'mm'], ['cp_nose_mm', '全機圧力中心（先端から）', 'mm'],
  ['cna', '全機法線力傾斜', '1/rad'], ['cd0', '全機軸力係数', '-'],
  ['fstWet_pct', '酸化剤充填時Fst', '%'], ['fstDry_pct', '酸化剤非充填時Fst', '%'], ['fstBurnout_pct', '燃焼終了時Fst', '%'],
  ['smWet_cal', '酸化剤充填時 静安定余裕', 'cal'], ['smBurnout_cal', '燃焼終了時 静安定余裕', 'cal'],
  ['cgAfterPayload_aft_mm', 'ペイロード放出後重心（機体後端から）', 'mm'], ['fstAfterPayload_pct', 'ペイロード放出後Fst', '%'], ['smAfterPayload_cal', 'ペイロード放出後 静安定余裕', 'cal'],
  ['oxFlow_kgps', '酸化剤質量流量', 'kg/s'], ['fuelFlow_kgps', '燃料質量流量', 'kg/s'], ['propFlow_kgps', '推進剤質量流量', 'kg/s'],
  ['burnTime_s', '燃焼時間', 's'], ['opTime_s', '作動時間', 's'], ['opTimeCurve_s', '作動時間（推力履歴, 10%Fmax）', 's'],
  ['totalImpulse_Ns', '全力積', 'N·s'], ['motorClass', 'モータークラス', '-'], ['avgThrust_N', '平均推力', 'N'], ['ispEff_s', '有効比推力', 's'],
  ['cdS1_m2', '1段目パラシュートCdS', 'm²'], ['cdS2_m2', '2段目パラシュートCdS', 'm²'], ['cdSPayload_m2', 'ペイロードCdS', 'm²'],
  ['vt1_mps', '1段目パラシュート降下速度', 'm/s'], ['vt2_mps', '2段目パラシュート降下速度', 'm/s'], ['vtPayload_mps', 'ペイロードパラシュート降下速度', 'm/s'],
  ['IpitchWet', 'ピッチヨー慣性モーメント（酸化剤充填時）', 'kg·m²'], ['IpitchBurnout', 'ピッチヨー慣性モーメント（燃焼終了時）', 'kg·m²'],
  ['IrollWet', 'ロール慣性モーメント（酸化剤充填時）', 'kg·m²'],
  ['cmqEq', 'ピッチヨー減衰モーメント係数', '-'], ['clpEq', 'ロール減衰モーメント係数', '-'],
];

// 諸元表の検算値（ペイロード放出前 = released:false）。該当しない値は null。位置 mm、質量 kg
function reviewValues(M) {
  if (M.top) return reviewValues(M.top); // 多段式は最上段の値（段構成ごとの値は stageTable）
  const c = M.c, hyb = M.massMode === 'hybrid', manA = c.aeroMode === 'manual', Lmm = M.L * 1000;
  const aft = x => Lmm - x * 1000, nose = x => x * 1000;
  const wet = M.massAt(0), bo = M.massAt(M.tEnd);
  const dryM = hyb ? c.hDryMass / 1000 : wet.m, dryX = hyb ? c.hDryCG / 1000 : wet.cg;
  const cp = M.cpAt(0); // 静的（mach 0 / manual）
  const fst = x => (cp.xcp - x) / M.L * 100, sm = x => (cp.xcp - x) / M.d; // (cg_aft − cp_aft)/L·100 = (xcp − cg)/L·100
  const ap = M.payloadOn ? M.massAt(M.tEnd, true) : null;
  const pm = hyb ? (c.hOxMass + c.hFuelPre - c.hFuelPost) / 1000 : M.prop; // 推進剤質量 [kg]
  const r1 = c.rec1 !== 'none', r2 = r1 && c.rec2 !== 'none';
  const vt = (m, cds) => (cds > 0 ? Math.sqrt(2 * m * G_SHEET / (RHO0_SHEET * cds)) : null);
  const cds2 = r2 ? (M.chuteVel ? M.c2CdA : M.c1CdA + M.c2CdA) : null;
  return {
    L_mm: Lmm, d_mm: M.d * 1000, trueAzim_deg: M.trueAzim / D2R,
    massWet_kg: wet.m, massDry_kg: dryM, massBurnout_kg: bo.m,
    cgWet_aft_mm: aft(wet.cg), cgDry_aft_mm: aft(dryX), cgBurnout_aft_mm: aft(bo.cg),
    cgWet_nose_mm: nose(wet.cg), cgDry_nose_mm: nose(dryX), cgBurnout_nose_mm: nose(bo.cg),
    cp_aft_mm: aft(cp.xcp), cp_nose_mm: nose(cp.xcp), cna: cp.cna, cd0: M.cd0,
    fstWet_pct: fst(wet.cg), fstDry_pct: fst(dryX), fstBurnout_pct: fst(bo.cg),
    smWet_cal: sm(wet.cg), smBurnout_cal: sm(bo.cg),
    cgAfterPayload_aft_mm: ap ? aft(ap.cg) : null, fstAfterPayload_pct: ap ? fst(ap.cg) : null, smAfterPayload_cal: ap ? sm(ap.cg) : null,
    oxFlow_kgps: hyb ? c.hOxMass / 1000 / c.hBurnTime : null,
    fuelFlow_kgps: hyb ? (c.hFuelPre - c.hFuelPost) / 1000 / c.hBurnTime : null,
    propFlow_kgps: M.burnTime > 0 ? pm / M.burnTime : null,
    burnTime_s: M.burnTime, opTime_s: hyb && c.hOpTime > 0 ? c.hOpTime : M.tb, opTimeCurve_s: M.opTimeCurve,
    totalImpulse_Ns: M.Itot, motorClass: motorClass(M.Itot),
    avgThrust_N: M.opTimeCurve > 0 ? M.Itot / M.opTimeCurve : null, ispEff_s: pm > 0 ? M.Itot / (pm * G0) : null,
    cdS1_m2: r1 ? M.c1CdA : null, cdS2_m2: cds2, cdSPayload_m2: M.payloadOn ? M.payloadCdA : null,
    vt1_mps: r1 ? vt(M.mRef, M.c1CdA) : null, vt2_mps: r2 ? vt(M.mRef, cds2) : null,
    vtPayload_mps: M.payloadOn ? vt(M.payloadMass, M.payloadCdA) : null,
    IpitchWet: wet.I, IpitchBurnout: bo.I, IrollWet: wet.Ir,
    cmqEq: manA && c.cmq !== null ? c.cmq : M.cmqEq(hyb ? c.hDryCG / 1000 : M.massAt(M.tb).cg, 0),
    clpEq: manA && c.clp !== null ? c.clp : M.clpEq(0),
  };
}

// ---------------- 飛行シミュレーション ----------------
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

// 14 状態: y[0..2] 位置, y[3..5] 速度, y[6..8] u（機軸）, y[9..11] ω⊥（u に垂直）, y[12] p（ロールレート）, y[13] φ（ロール角）
// phase 0: レール上, 1: 自由飛行, 2: パラ降下。ペイロードは同じ外側ステップ・同じ gust で並行に積分する（spec §2.6 / §2.8 / §2.9 / §3.2）
function simulate(M, opt = {}) { return M.stack ? simulateStaged(M, opt) : simulateCore(M, opt); }
// opt.tStart: このモデルの点火時刻（M の時刻 = t − tStart）、opt.init: 途中からの開始状態、opt.stopAt: この時刻で打ち切って end を返す（多段用）
function simulateCore(M, opt = {}) {
  const c = M.c, tS = opt.tStart || 0;
  const rng = mulberry32(opt.seed ?? 1);
  const record = opt.record !== false, ballistic = !!opt.ballistic;
  const { windV, gustS } = PHYS_UTIL.windFn(M, opt); // 風（gust を除く）。プロファイルは高度で補間、べき法則は windMaxH で頭打ち
  const GEO = M.earthRot && typeof window !== 'undefined' ? window.Geo : null;
  const gAt = h => (GEO ? GEO.normalGravity(M.lat, h) : G0 * (RE / (RE + h)) ** 2);
  const OM = M.omegaENU, rot = !!GEO;
  const landZ = Math.min(M.landZ, 0);
  const gz = (x, yy) => (M.groundZ ? M.groundZ(x, yy) : landZ); // 着地面の高さ（射点基準）
  const U_clamp = v => Math.max(-1, Math.min(1, v));
  const tD = M.chuteDelay || 0; // 開傘タイミングのずれ（ばらつき）
  const rec = [], ev = {};
  const st = { maxV: 0, maxMach: 0, maxG: 0, maxQ: 0, maxAlpha: 0, minSM: Infinity, apogee: 0, apoT: 0, apoX: 0, apoY: 0, maxRollRate: 0,
    asc: { maxV: 0, maxV_t: NaN, maxMach: 0, maxQ: 0, maxQ_t: NaN, maxG: 0 } }; // asc: 離床〜頂点の最大値（flightSummary 用）
  const u0 = [Math.cos(M.elev) * Math.sin(M.azim), Math.cos(M.elev) * Math.cos(M.azim), Math.sin(M.elev)];
  const NS = 14, y = new Float64Array(NS); y[6] = u0[0]; y[7] = u0[1]; y[8] = u0[2];
  let t = 0, phase = 0, released = false;
  let tc1 = -1, tc2 = -1;
  const gust = [0, 0], tauG = 2;
  const aux = {}, pinfo = {};
  const L2A = M.A * M.L * M.L;
  const openR = dt => (dt < 0 ? 0 : M.openTime > 0 ? Math.min(1, dt / M.openTime) : 1);
  // 回収系の CdA: diameter は機体抗力に加算、velocity は機体抗力を含めない（終端速度の定義）
  const chuteCdA = t => {
    const r1 = tc1 >= 0 ? openR(t - tc1) : 0, r2 = tc2 >= 0 ? openR(t - tc2) : 0;
    return M.chuteVel ? M.c1CdA * r1 * (1 - r2) + M.c2CdA * r2 : M.A * M.cd0 + M.c1CdA * r1 + M.c2CdA * r2;
  };

  // 本体の微分
  function deriv(t, y, dy, info) {
    const z = y[2], h = Math.max(M.siteAlt + z, 0);
    const at = atm(M, h), T = M.thrust(t - tS, z), ms = M.massAt(t - tS, released), g = gAt(h);
    const wv = windV(z), wx = wv[0] + gust[0], wy = wv[1] + gust[1];
    dy[0] = y[3]; dy[1] = y[4]; dy[2] = y[5];
    for (let i = 6; i < NS; i++) dy[i] = 0;
    let a0 = 0, a1 = 0, a2 = 0, V = 0, q = 0, alpha = 0, sm = NaN, fst = NaN, mach = 0;
    if (phase === 0 || phase === 3) {
      const vr = y[3] * u0[0] + y[4] * u0[1] + y[5] * u0[2];
      V = Math.abs(vr); q = 0.5 * at.rho * V * V; mach = V / at.a;
      const D = q * M.A * M.cdAt(mach) * Math.sign(vr);
      let a = (T - D) / ms.m - g * u0[2];
      if (vr <= 1e-9 && a < 0) a = 0;
      a0 = a * u0[0]; a1 = a * u0[1]; a2 = a * u0[2];
      if (info) { const cp = M.cpAt(mach); sm = (cp.xcp - ms.cg) / M.d; fst = (cp.xcp - ms.cg) / M.L * 100; }
    } else if (phase === 1) {
      const ux = y[6], uy = y[7], uz = y[8];
      const wu = y[9] * ux + y[10] * uy + y[11] * uz;
      const w0 = y[9] - wu * ux, w1 = y[10] - wu * uy, w2 = y[11] - wu * uz, p = y[12];
      const vx = y[3] - wx, vy = y[4] - wy, vz = y[5];
      V = Math.hypot(vx, vy, vz); q = 0.5 * at.rho * V * V; mach = V / at.a;
      const cp = M.cpAt(mach);
      let fx = T * ux, fy = T * uy, fz = T * uz, tx = 0, ty = 0, tz = 0;
      if (V > 1e-6) {
        const kd = q * M.A * M.cdAt(mach) / V;
        fx -= kd * vx; fy -= kd * vy; fz -= kd * vz;
        const vu = vx * ux + vy * uy + vz * uz;
        const px = vx - vu * ux, py = vy - vu * uy, pz = vz - vu * uz;
        alpha = Math.atan2(Math.hypot(px, py, pz), vu);
        const kn = q * M.A * cp.cna / V, nx = -kn * px, ny = -kn * py, nz = -kn * pz;
        fx += nx; fy += ny; fz += nz;
        const arm = ms.cg - cp.xcp; // 法線力の作用点（CP）は重心から −arm·u
        tx = arm * (uy * nz - uz * ny); ty = arm * (uz * nx - ux * nz); tz = arm * (ux * ny - uy * nx);
        // ピッチ・ヨー減衰 0.25·ρ·V_a·A·L²·Cmq·ω⊥（Cmq < 0）
        const kq = 0.25 * at.rho * V * L2A * M.cmqAt(mach, ms.cg);
        tx += kq * w0; ty += kq * w1; tz += kq * w2;
        // ロール: フィン取付角の励起 + 減衰 0.25·ρ·V_a·A·L²·Clp·p（+u まわり）
        const ma = M.cantMoment(q, mach) + 0.25 * at.rho * V * L2A * M.clpAt(mach) * p;
        tx += ma * ux; ty += ma * uy; tz += ma * uz;
      }
      // 回転（rotDeriv と同じ式をインライン）: du = ω⊥×u, dω⊥ = (τ⊥ − Ir·p·(ω⊥×u))/It, dp = (τ·u)/Ir, dφ = p
      const du0 = w1 * uz - w2 * uy, du1 = w2 * ux - w0 * uz, du2 = w0 * uy - w1 * ux;
      const ta = tx * ux + ty * uy + tz * uz;
      dy[6] = du0; dy[7] = du1; dy[8] = du2;
      dy[9] = (tx - ta * ux - ms.Ir * p * du0) / ms.I;
      dy[10] = (ty - ta * uy - ms.Ir * p * du1) / ms.I;
      dy[11] = (tz - ta * uz - ms.Ir * p * du2) / ms.I;
      dy[12] = ta / ms.Ir; dy[13] = p;
      a0 = fx / ms.m; a1 = fy / ms.m; a2 = fz / ms.m - g;
      sm = (cp.xcp - ms.cg) / M.d; fst = (cp.xcp - ms.cg) / M.L * 100;
    } else {
      const vx = y[3] - wx, vy = y[4] - wy, vz = y[5];
      V = Math.hypot(vx, vy, vz); q = 0.5 * at.rho * V * V; mach = V / at.a;
      const k = V > 1e-9 ? q * chuteCdA(t) / V : 0;
      a0 = (T * y[6] - k * vx) / ms.m; a1 = (T * y[7] - k * vy) / ms.m; a2 = (T * y[8] - k * vz) / ms.m - g;
    }
    dy[3] = a0; dy[4] = a1; dy[5] = a2;
    if (info) {
      info.V = V; info.mach = mach; info.q = q; info.alpha = alpha; info.T = T; info.m = ms.m; info.cg = ms.cg;
      info.sm = sm; info.fst = fst; info.fs = Math.hypot(a0, a1, a2 + g) / G0; info.rho = at.rho;
    }
    if (rot && phase !== 0 && phase !== 3) { // コリオリ力 −2Ω×v（遠心力は正規重力に含む）
      dy[3] -= 2 * (OM[1] * y[5] - OM[2] * y[4]); dy[4] -= 2 * (OM[2] * y[3] - OM[0] * y[5]); dy[5] -= 2 * (OM[0] * y[4] - OM[1] * y[3]);
    }
  }

  // ペイロードの微分（s = [r, v]。a = −g·ẑ − 0.5·ρ·|v_rel|·CdS_p·r(t)/m_p·v_rel）
  let pay = null;
  function pderiv(t, s, ds, info) {
    const z = s[2], h = Math.max(M.siteAlt + z, 0), at = atm(M, h), g = gAt(h);
    const wv = windV(z), vx = s[3] - (wv[0] + gust[0]), vy = s[4] - (wv[1] + gust[1]), vz = s[5];
    const V = Math.hypot(vx, vy, vz), k = 0.5 * at.rho * V * pay.cds * openR(t - pay.t0) / pay.m;
    ds[0] = s[3]; ds[1] = s[4]; ds[2] = s[5]; ds[3] = -k * vx; ds[4] = -k * vy; ds[5] = -k * vz - g;
    if (rot) { ds[3] -= 2 * (OM[1] * s[5] - OM[2] * s[4]); ds[4] -= 2 * (OM[2] * s[3] - OM[0] * s[5]); ds[5] -= 2 * (OM[0] * s[4] - OM[1] * s[3]); }
    if (info) { info.V = V; info.q = 0.5 * at.rho * V * V; info.rho = at.rho; }
  }

  // RK4（作業配列は状態の次元ごとに確保）
  const mkRK = n => {
    const k1 = new Float64Array(n), k2 = new Float64Array(n), k3 = new Float64Array(n), k4 = new Float64Array(n), tmp = new Float64Array(n);
    return (f, t0, s, h) => {
      f(t0, s, k1);
      for (let i = 0; i < n; i++) tmp[i] = s[i] + h / 2 * k1[i];
      f(t0 + h / 2, tmp, k2);
      for (let i = 0; i < n; i++) tmp[i] = s[i] + h / 2 * k2[i];
      f(t0 + h / 2, tmp, k3);
      for (let i = 0; i < n; i++) tmp[i] = s[i] + h * k3[i];
      f(t0 + h, tmp, k4);
      for (let i = 0; i < n; i++) s[i] += h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    };
  };
  const rkB = mkRK(NS), rkP = mkRK(6), dtmp = new Float64Array(NS), ptmp = new Float64Array(6);
  // 各ステップ後: u を正規化し、ω⊥ を u に垂直へ戻す
  const fixRot = () => {
    const n = Math.hypot(y[6], y[7], y[8]); y[6] /= n; y[7] /= n; y[8] /= n;
    const wu = y[9] * y[6] + y[10] * y[7] + y[11] * y[8];
    y[9] -= wu * y[6]; y[10] -= wu * y[7]; y[11] -= wu * y[8];
  };
  // phase 1 のサブステップ数（外側ステップの開始時に評価。§3.2）
  const subN1 = (t, H) => {
    const z = y[2], at = atm(M, Math.max(M.siteAlt + z, 0)), ms = M.massAt(t - tS, released);
    const wv = windV(z), V = Math.hypot(y[3] - wv[0] - gust[0], y[4] - wv[1] - gust[1], y[5]);
    const q = 0.5 * at.rho * V * V, mach = V / at.a, cp = M.cpAt(mach);
    const wn = Math.sqrt(q * M.A * Math.abs(cp.cna) * Math.abs(cp.xcp - ms.cg) / ms.I);
    const lq = Math.abs(0.25 * at.rho * V * L2A * M.cmqAt(mach, ms.cg)) / ms.I;
    const lp = Math.abs(0.25 * at.rho * V * L2A * M.clpAt(mach)) / ms.Ir;
    const lg = ms.Ir * Math.abs(y[12]) / ms.I;
    const hs = Math.min(H, 1 / Math.max(wn, lq, lp, lg, 1e-9));
    return Math.max(1, Math.ceil(H / hs - 1e-9));
  };
  // phase 2・ペイロードのサブステップ数: h = min(0.02, 0.5/λ_d), λ_d = ρ·CdA·V_a/m
  const subND = (z, vx, vy, vz, cda, m, H) => {
    const wv = windV(z), V = Math.hypot(vx - wv[0] - gust[0], vy - wv[1] - gust[1], vz);
    const ld = atm(M, Math.max(M.siteAlt + z, 0)).rho * cda * V / m;
    const hs = Math.min(0.02, ld > 0 ? 0.5 / ld : Infinity);
    return Math.max(1, Math.ceil(H / hs - 1e-9));
  };

  const snap = () => ({
    t, x: y[0], y: y[1], z: y[2], vx: y[3], vy: y[4], vz: y[5], V: Math.hypot(y[3], y[4], y[5]),
    va: aux.V, mach: aux.mach, g: aux.fs, alpha: phase === 1 ? aux.alpha / D2R : NaN, q: aux.q, T: aux.T, m: aux.m,
    sm: aux.sm, ux: y[6], uy: y[7], uz: y[8], ph: phase, roll: y[13], p: y[12], cg: aux.cg, fst: aux.fst,
  });
  const psnap = (t, s) => ({ t, x: s[0], y: s[1], z: s[2], V: Math.hypot(s[3], s[4], s[5]) });
  const reached = x => t >= x - 1e-9;

  // ティップオフ（phase 3）: 上側ラグが抜けてから下側ラグが抜けるまで、下側ラグを支点に重力で頭下げに回る。
  // 支点はレールに沿って動く（レール方向の運動はレール上と同じ式）。刻み 0.5 ms の陽解法
  let tip = null;
  const tipStep = (t0, H) => {
    const n = Math.max(1, Math.ceil(H / 0.0005)), h = H / n;
    for (let i = 0; i < n && tip; i++) {
      const tt = t0 + i * h, z = y[2], hh = Math.max(M.siteAlt + z, 0), at = atm(M, hh), ms = M.massAt(tt - tS), g = gAt(hh);
      const T = M.thrust(tt - tS, z), V = Math.abs(tip.vP), D = 0.5 * at.rho * V * V * M.A * M.cdAt(V / at.a) * Math.sign(tip.vP);
      const aR = (T - D) / ms.m - g * u0[2];
      tip.sP += tip.vP * h + 0.5 * aR * h * h; tip.vP += aR * h;
      const d = Math.max(M.L - ms.cg - M.lugAft, 0), Ip = ms.I + ms.m * d * d, k = ms.m * g * d / Ip;
      // τ = d·u × (0,0,−m·g) = −m·g·d·(u_y, −u_x, 0)
      y[9] += -k * y[7] * h; y[10] += k * y[6] * h;
      const du = [y[10] * y[8] - y[11] * y[7], y[11] * y[6] - y[9] * y[8], y[9] * y[7] - y[10] * y[6]];
      for (let j = 0; j < 3; j++) y[6 + j] += du[j] * h;
      fixRot();
      const sd = tip.sP - tip.s0, P = [tip.P0[0] + sd * u0[0], tip.P0[1] + sd * u0[1], tip.P0[2] + sd * u0[2]];
      const wxu = [y[10] * y[8] - y[11] * y[7], y[11] * y[6] - y[9] * y[8], y[9] * y[7] - y[10] * y[6]];
      for (let j = 0; j < 3; j++) { y[j] = P[j] + d * y[6 + j]; y[3 + j] = tip.vP * u0[j] + d * wxu[j]; }
      if (tip.sP >= M.railEff) return true; // 下側ラグが抜けた
    }
    return false;
  };
  const exitRail = () => {
    const tipped = !!tip; tip = null;
    phase = 1; deriv(t, y, dtmp, aux); // aux.V = 対気速度（gust 込み）
    const V = Math.hypot(y[3], y[4], y[5]), wv = windV(y[2]);
    const W0 = wv[0], W1 = wv[1], wu = W0 * u0[0] + W1 * u0[1];
    const wp = Math.hypot(W0 - wu * u0[0], W1 - wu * u0[1], -wu * u0[2]); // レールに直交する風成分（gust なし）
    ev.railExit = { t, V, va: aux.V, sm: aux.sm, alphaW: Math.atan2(wp, V) / D2R };
    if (tipped) {
      ev.railExit.tipRate = Math.hypot(y[9], y[10], y[11]) / D2R; // [deg/s]
      ev.railExit.tipAngle = Math.acos(Math.min(1, y[6] * u0[0] + y[7] * u0[1] + y[8] * u0[2])) / D2R;
    }
  };

  let tRec = 0, lifted = false, apoDone = false, tApo = -1, maxZ = 0, bodyDone = false;
  if (opt.init) { // 分離直後からの続き
    const I = opt.init;
    t = I.t; tRec = I.t; y.set(I.y); phase = I.phase; lifted = true; maxZ = I.maxZ; gust[0] = I.gust[0]; gust[1] = I.gust[1];
    st.apogee = I.maxZ; st.apoT = I.apoT; st.apoX = I.apoX; st.apoY = I.apoY;
  }
  deriv(t, y, dtmp, aux);
  if (record) rec.push(snap());

  const deploy = (which, by) => {
    const e = { t, z: y[2], V: aux.V, vz: y[5], q: aux.q };
    if (by) e.by = by;
    if (which === 1) { tc1 = t; ev.deploy1 = e; } else { tc2 = t; ev.deploy2 = e; }
    phase = 2; y[9] = y[10] = y[11] = y[12] = 0; // ω⊥ = p = 0。φ は最後の値を保つ
  };
  // ペイロード放出（ステップ境界）。本体は重心の移動分だけ位置・速度を補正する（ω⊥, p は不変）
  const release = () => {
    const cgOld = M.massAt(t - tS, false).cg, cgNew = M.massAt(t - tS, true).cg;
    const wxu = [y[10] * y[8] - y[11] * y[7], y[11] * y[6] - y[9] * y[8], y[9] * y[7] - y[10] * y[6]]; // ω⊥ × u
    const dp = cgOld - M.payloadPos, db = cgOld - cgNew;
    const s = new Float64Array(6);
    for (let i = 0; i < 3; i++) {
      s[i] = y[i] + dp * y[6 + i]; s[3 + i] = y[3 + i] + dp * wxu[i];
      y[i] += db * y[6 + i]; y[3 + i] += db * wxu[i];
    }
    released = true;
    pay = { s, t0: t, m: M.payloadMass, cds: M.payloadCdA, done: false, tRec: t + 0.1,
      out: { release: psnap(t, s), rec: record ? [psnap(t, s)] : [], landing: null } };
    pderiv(t, s, ptmp, pinfo);
    ev.payload = { t, z: s[2], V: pinfo.V, q: pinfo.q };
  };

  while (t < 1800) {
    if (opt.stopAt != null && !bodyDone && t >= opt.stopAt - 1e-9) { // 段の分離
      if (phase === 0 || phase === 3) { ev.error = '段の分離時刻にまだランチャー上です（推力不足）'; break; }
      return { rec, ev, st, payload: null, end: { t, y: y.slice(), phase, maxZ, apoT: st.apoT, apoX: st.apoX, apoY: st.apoY, gust: gust.slice() } };
    }
    const pAct = !!pay && !pay.done;
    const H = bodyDone || phase === 2 ? 0.02 : M.dt;
    if (gustS > 0) { // gust は外側ステップごとに更新（本体・ペイロード共通）
      const cg = gustS * Math.sqrt(2 * H / tauG);
      gust[0] += -gust[0] / tauG * H + cg * gauss(rng);
      gust[1] += -gust[1] / tauG * H + cg * gauss(rng);
    }
    const tp = t, ph0 = phase, yp = bodyDone ? null : y.slice(), sp = pAct ? pay.s.slice() : null;
    // --- 本体 ---
    let tipDone = false;
    if (!bodyDone) {
      if (phase === 3) tipDone = tipStep(tp, H);
      else if (phase === 1) {
        const n = subN1(tp, H);
        if (n > 200) { ev.error = '回転運動が硬すぎます（慣性モーメント・減衰係数の単位を確認）'; break; }
        for (let i = 0; i < n; i++) { rkB(deriv, tp + i * H / n, y, H / n); fixRot(); }
      } else if (phase === 2) {
        const n = subND(y[2], y[3], y[4], y[5], chuteCdA(tp + H), M.massAt(tp - tS, released).m, H);
        for (let i = 0; i < n; i++) rkB(deriv, tp + i * H / n, y, H / n);
      } else rkB(deriv, tp, y, H);
      if (!y.every(Number.isFinite)) { ev.error = '数値が発散しました（積分刻みを小さくしてください）'; break; }
    }
    // --- ペイロード ---
    if (pAct) {
      const s = pay.s, n = subND(s[2], s[3], s[4], s[5], pay.cds * openR(tp + H - pay.t0), pay.m, H);
      for (let i = 0; i < n; i++) rkP(pderiv, tp + i * H / n, s, H / n);
      if (!s.every(Number.isFinite)) { pay.out.error = 'ペイロードの数値が発散しました'; pay.done = true; s.set(sp); }
    }
    t = tp + H;

    if (!bodyDone) {
      if (phase === 0) {
        y[6] = u0[0]; y[7] = u0[1]; y[8] = u0[2]; y[9] = y[10] = y[11] = y[12] = 0; // φ は固定
        const sAlong = y[0] * u0[0] + y[1] * u0[1] + y[2] * u0[2];
        if (sAlong < 0) for (let i = 0; i < 6; i++) y[i] = 0;
        if (!lifted && sAlong > 1e-3) { lifted = true; ev.liftoff = { t }; }
        if (lifted && M.tipOff && sAlong >= M.railUp && sAlong < M.railEff) { // 上側ラグが抜けた → ティップオフ
          const ms = M.massAt(t - tS), d = Math.max(M.L - ms.cg - M.lugAft, 0);
          tip = { s0: sAlong, sP: sAlong, vP: y[3] * u0[0] + y[4] * u0[1] + y[5] * u0[2], P0: [y[0] - d * u0[0], y[1] - d * u0[1], y[2] - d * u0[2]] };
          phase = 3; ev.upperLug = { t };
        } else if (lifted && sAlong >= M.railEff) exitRail(); // 最後尾ラグがレール端を抜けたら離脱（railEff = railLen − lugAft。離床前は離脱しない）
        if (!lifted && t > M.tb + 1) { ev.error = '推力不足で離陸できません'; break; }
      } else if (phase === 3 && tipDone) exitRail();
      if (!ev.burnout && reached(M.tb + tS)) ev.burnout = { t: M.tb + tS, z: y[2], V: Math.hypot(y[3], y[4], y[5]) };
      if (opt.init && !ev.ignition && reached(tS)) ev.ignition = { t, z: y[2], V: Math.hypot(y[3], y[4], y[5]), tilt: Math.acos(U_clamp(y[8])) / D2R };

      deriv(t, y, dtmp, aux);
      const Vg = Math.hypot(y[3], y[4], y[5]);
      if (phase !== 2 || !apoDone) {
        if (Vg > st.maxV) st.maxV = Vg;
        if (aux.mach > st.maxMach) st.maxMach = aux.mach;
        if (aux.q > st.maxQ) st.maxQ = aux.q;
      }
      if (phase !== 2 && aux.fs > st.maxG) st.maxG = aux.fs;
      if (phase === 1 && !apoDone && aux.V > 15) {
        if (aux.alpha / D2R > st.maxAlpha) st.maxAlpha = aux.alpha / D2R;
        if (aux.sm < st.minSM) st.minSM = aux.sm;
      }
      if (Math.abs(y[12]) > st.maxRollRate) st.maxRollRate = Math.abs(y[12]);
      if (lifted && !apoDone) { // 上昇区間（離床〜頂点）の最大値
        const a = st.asc;
        if (Vg > a.maxV) { a.maxV = Vg; a.maxV_t = t; }
        if (aux.mach > a.maxMach) a.maxMach = aux.mach;
        if (aux.q > a.maxQ) { a.maxQ = aux.q; a.maxQ_t = t; }
        if (aux.fs > a.maxG) a.maxG = aux.fs;
      }
      if (y[2] > maxZ) { maxZ = y[2]; st.apogee = maxZ; st.apoT = t; st.apoX = y[0]; st.apoY = y[1]; }
      if (!apoDone && !opt.noApogee && (!opt.staged || t >= tS + M.tb) && phase !== 0 && y[5] < 0) { apoDone = true; tApo = t; ev.apogee = { t, z: maxZ, V: aux.V }; }

      // 着地（本体）
      const g0z = lifted && phase !== 0 && phase !== 3 ? gz(y[0], y[1]) : -Infinity;
      if (y[2] <= g0z) {
        const f = (yp[2] - g0z) / (yp[2] - y[2]), tl = tp + f * H;
        for (let i = 0; i < 6; i++) y[i] = yp[i] + f * (y[i] - yp[i]);
        y[2] = g0z;
        const tk = t; t = tl; deriv(t, y, dtmp, aux);
        ev.landing = { t, x: y[0], y: y[1], V: Math.hypot(y[3], y[4], y[5]), vz: y[5] };
        if (record) rec.push(snap());
        t = tk; bodyDone = true;
      } else {
        // ペイロード放出（phase 0 中はレール離脱後の最初のステップまで延ばす）
        if (M.payloadOn && M.payloadMass > 0 && !pay && ph0 !== 0 && ph0 !== 3 && reached(M.payloadTime)) { release(); deriv(t, y, dtmp, aux); }
        // 回収系（phase 0 では展開しない。ballistic なら展開しない。rec1 'none' なら rec2 も無視）
        if (phase !== 0 && phase !== 3 && !ballistic && c.rec1 !== 'none') {
          const n0 = (tc1 >= 0) + (tc2 >= 0);
          if (tc1 < 0) {
            let by = null;
            if (c.rec1 === 'apogee') {
              const okA = apoDone && reached(tApo + c.rec1Delay + tD), okT = c.rec1Backup > 0 && reached(c.rec1Backup + tD);
              if (okA && okT) by = tApo + c.rec1Delay <= c.rec1Backup ? 'apogee' : 'timer';
              else by = okA ? 'apogee' : okT ? 'timer' : null;
            } else if (c.rec1 === 'ignition') { if (reached(c.rec1Time + tD)) by = 'timer'; }
            else if (reached(M.tb + tS + c.rec1Time + tD)) by = 'timer';
            if (by) deploy(1, by);
          }
          if (tc2 < 0) {
            const ok2 = c.rec2 === 'altitude' ? tc1 >= 0 && y[2] <= c.mainAlt : c.rec2 === 'ignition' ? reached(c.rec2Time + tD) : false;
            if (ok2) {
              const before = tc1 < 0;
              if (before) deploy(1, 'timer');
              deploy(2);
              if (before) ev.deploy2.beforeDeploy1 = true;
            }
          }
          if ((tc1 >= 0) + (tc2 >= 0) !== n0) deriv(t, y, dtmp, aux); // 展開したら記録用の値を取り直す
        }
        if (record && t >= tRec - 1e-9) { rec.push(snap()); tRec = t + (phase === 2 ? 0.1 : 0.02); }
      }
    }

    // --- ペイロードの着地・記録 ---
    if (pAct && !pay.done) {
      const s = pay.s;
      const pgz = gz(s[0], s[1]);
      if (s[2] <= pgz) {
        const f = (sp[2] - pgz) / (sp[2] - s[2]), tl = tp + f * H;
        for (let i = 0; i < 6; i++) s[i] = sp[i] + f * (s[i] - sp[i]);
        s[2] = pgz;
        pay.out.landing = { t: tl, x: s[0], y: s[1], V: Math.hypot(s[3], s[4], s[5]), vz: s[5] };
        if (record) pay.out.rec.push(psnap(tl, s));
        pay.done = true;
      } else if (record && t >= pay.tRec - 1e-9) { pay.out.rec.push(psnap(t, s)); pay.tRec = t + 0.1; }
    }
    if (bodyDone && (!pay || pay.done)) break;
  }
  if (!ev.landing && !ev.error) ev.error = '30分以内に着地しませんでした';
  if (pay && !pay.done && !pay.out.error) pay.out.error = ev.error && !ev.landing ? '本体の計算が止まったためペイロードの計算も止めました' : '30分以内に着地しませんでした';
  if (st.minSM === Infinity) st.minSM = NaN;
  return { rec, ev, st, payload: pay ? pay.out : null };
}

// 多段式: 段ごとに simulateCore をつなぐ。分離時に本体の重心を次の構成へ移し、切り離した段は dropStage で落とす
function simulateStaged(M, opt = {}) {
  const { stages, segs, ign, topIgn } = M.stack, T = M.top, seed = opt.seed ?? 1;
  const rec = [], ev = {}, drops = [], stageEv = [];
  const st = { maxV: 0, maxMach: 0, maxG: 0, maxQ: 0, maxAlpha: 0, minSM: Infinity, apogee: 0, apoT: 0, apoX: 0, apoY: 0, maxRollRate: 0,
    asc: { maxV: 0, maxV_t: NaN, maxMach: 0, maxQ: 0, maxQ_t: NaN, maxG: 0 } };
  const merge = r => {
    if (r.rec.length) rec.push(...r.rec);
    Object.assign(ev, r.ev);
    const s = r.st, a = s.asc || {};
    for (const k of ['maxV', 'maxMach', 'maxG', 'maxQ', 'maxAlpha', 'maxRollRate']) if (s[k] > st[k]) st[k] = s[k];
    if (s.minSM < st.minSM) st.minSM = s.minSM;
    if (s.apogee >= st.apogee) { st.apogee = s.apogee; st.apoT = s.apoT; st.apoX = s.apoX; st.apoY = s.apoY; }
    if (a.maxV > st.asc.maxV) { st.asc.maxV = a.maxV; st.asc.maxV_t = a.maxV_t; }
    if (a.maxQ > st.asc.maxQ) { st.asc.maxQ = a.maxQ; st.asc.maxQ_t = a.maxQ_t; }
    if (a.maxMach > st.asc.maxMach) st.asc.maxMach = a.maxMach;
    if (a.maxG > st.asc.maxG) st.asc.maxG = a.maxG;
  };
  let init = null, ended = false;
  for (let i = 0; i < stages.length; i++) {
    const b = stages[i], Mx = segs[i], tsep = M.stack.sep[i];
    const r = simulateCore(Mx, { ...opt, seed: seed + i, tStart: ign[i], stopAt: tsep, init, staged: true, noApogee: true });
    const igEv = r.ev.ignition; delete r.ev.ignition;
    const bo = r.ev.burnout; delete r.ev.burnout;
    merge(r);
    stageEv.push({ stage: b.no, ign: igEv || { t: ign[i], z: 0, V: 0, tilt: 90 - M.elev / D2R }, burnout: bo || null, sep: null });
    if (!r.end) { ended = true; break; }
    // 分離: 位置 = 重心なので、次の構成の重心へ移す（速度は ω×r の分だけ補正）
    const E = r.end, y = E.y, u = [y[6], y[7], y[8]], w = [y[9], y[10], y[11]];
    const wxu = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
    const nxt = i + 1 < stages.length ? segs[i + 1] : T, nxtT0 = ign[i + 1];
    const cgOld = Mx.massAt(E.t - ign[i]).cg, cgNew = nxt.massAt(E.t - nxtT0).cg;
    const xb = b.x0 + b.xDry, db = cgOld - xb, dn = cgOld - cgNew;
    const rD = [0, 1, 2].map(j => y[j] + db * u[j]), vD = [0, 1, 2].map(j => y[3 + j] + db * wxu[j]);
    const vS = Math.hypot(y[3], y[4], y[5]);
    stageEv[i].sep = { t: E.t, z: y[2], V: vS };
    drops.push(dropStage(M, b, E.t, rD, vD, opt));
    for (let j = 0; j < 3; j++) { y[j] += dn * u[j]; y[3 + j] += dn * wxu[j]; }
    init = { t: E.t, y, phase: E.phase, maxZ: E.maxZ, apoT: E.apoT, apoX: E.apoX, apoY: E.apoY, gust: E.gust };
  }
  let payload = null;
  if (!ended) {
    const r = simulateCore(T, { ...opt, seed: seed + stages.length, tStart: topIgn, init, staged: true });
    const igEv = r.ev.ignition; delete r.ev.ignition;
    merge(r); payload = r.payload;
    stageEv.push({ stage: stages.length + 1, ign: igEv || null, burnout: r.ev.burnout || null, sep: null });
  }
  if (!ev.apogee && st.apogee > 0) ev.apogee = { t: st.apoT, z: st.apogee, V: NaN };
  if (st.minSM === Infinity) st.minSM = NaN;
  ev.stages = stageEv;
  return { rec, ev, st, payload, drops };
}
// 切り離した段の落下（質点）。パラシュートなし（vt = 0）はタンブリングの抗力 0.6·L·d
function dropStage(M, b, t0, r0, v0, opt) {
  const { windV } = PHYS_UTIL.windFn(M, opt), record = opt.record !== false, T = M.top, m = b.mDry;
  const cdaT = 0.6 * b.L * b.d, cds = b.vt > 0 ? 2 * m * G_SHEET / (RHO0_SHEET * b.vt * b.vt) : 0, open = T.openTime;
  const landZ = Math.min(T.landZ, 0), gz = (x, y) => (T.groundZ ? T.groundZ(x, y) : landZ);
  const s = [...r0, ...v0];
  const acc = (t, q) => {
    const h = Math.max(T.siteAlt + q[2], 0), rho = atm(T, h).rho, g = G0 * (RE / (RE + h)) ** 2, wv = windV(q[2]);
    const vx = q[3] - wv[0], vy = q[4] - wv[1], vz = q[5], V = Math.hypot(vx, vy, vz);
    const tc = t - t0 - b.chuteDelay, ro = cds > 0 && tc >= 0 ? (open > 0 ? Math.min(1, tc / open) : 1) : 0;
    const cda = ro > 0 ? cdaT * (1 - ro) + cds * ro : cdaT, k = 0.5 * rho * V * cda / m;
    return { a: [-k * vx, -k * vy, -k * vz - g], ld: rho * cda * V / m };
  };
  let t = t0, tRec = t0, landing = null;
  const snap = () => ({ t, x: s[0], y: s[1], z: s[2], V: Math.hypot(s[3], s[4], s[5]) });
  const out = record ? [snap()] : [];
  const release = { t, x: s[0], y: s[1], z: s[2], V: Math.hypot(s[3], s[4], s[5]) };
  while (t < t0 + 1800) {
    const a0 = acc(t, s), h = Math.min(0.02, a0.ld > 0 ? 0.5 / a0.ld : 0.02);
    const mid = [s[0] + s[3] * h / 2, s[1] + s[4] * h / 2, s[2] + s[5] * h / 2, s[3] + a0.a[0] * h / 2, s[4] + a0.a[1] * h / 2, s[5] + a0.a[2] * h / 2];
    const a1 = acc(t + h / 2, mid), zp = s[2], xp = s[0], yp = s[1], vp = [s[3], s[4], s[5]];
    for (let j = 0; j < 3; j++) { s[j] += mid[3 + j] * h; s[3 + j] += a1.a[j] * h; }
    t += h;
    const g = gz(s[0], s[1]);
    if (s[2] <= g) {
      const f = (zp - g) / Math.max(zp - s[2], 1e-9);
      s[0] = xp + f * (s[0] - xp); s[1] = yp + f * (s[1] - yp); s[2] = g; t = t - h + f * h;
      landing = { t, x: s[0], y: s[1], V: Math.hypot(vp[0], vp[1], vp[2]), vz: vp[2] };
      if (record) out.push(snap());
      break;
    }
    if (record && t >= tRec + 0.1) { out.push(snap()); tRec = t; }
  }
  return { stage: b.no, release, rec: out, landing, error: landing ? undefined : '30分以内に着地しませんでした' };
}

// 飛行結果の要約（UI の結果カード・諸元表の「飛行結果」・落下分散の表と CSV で共通）。発生しなかった項目は NaN
function flightSummary(M, sim) {
  const N = NaN, ev = (sim && sim.ev) || {}, st = (sim && sim.st) || {}, P = (sim && sim.payload) || null;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : N);
  const asc = st.asc || {};
  const apoT = ev.apogee ? ev.apogee.t : N;
  const dtA = e => (e ? e.t - apoT : N);
  const brg = (x, y) => ((Math.atan2(x, y) / D2R) % 360 + 360) % 360;
  const RX = ev.railExit, BO = ev.burnout, D1 = ev.deploy1, D2 = ev.deploy2, PE = ev.payload, LD = ev.landing, PL = P && P.landing;
  const cdsP = M.payloadCdA, openN = PE ? PE.q * cdsP : N;
  const ends = [LD && LD.t, PL && PL.t, ...((sim && sim.drops) || []).map(d => d.landing && d.landing.t)].filter(Number.isFinite); // 切り離した段の着地も再生範囲に入れる
  return {
    railExit_t_s: RX ? RX.t : N, railExit_V_mps: RX ? RX.V : N, railExit_alphaW_deg: RX ? num(RX.alphaW) : N,
    maxV_mps: ev.liftoff ? num(asc.maxV) : N, maxV_t_s: num(asc.maxV_t), maxMach: ev.liftoff ? num(asc.maxMach) : N,
    maxQ_Pa: ev.liftoff ? num(asc.maxQ) : N, maxQ_t_s: num(asc.maxQ_t), maxAcc_G: ev.liftoff ? num(asc.maxG) : N,
    opEnd_t_s: BO ? BO.t : N, opEnd_z_m: BO ? BO.z : N, opEnd_V_mps: BO ? BO.V : N,
    burnEnd_t_s: M.massMode === 'hybrid' ? (M.topIgn ?? 0) + (M.top ? M.top.tIgn : M.tIgn) + M.c.hBurnTime * Math.max(M.c.burnScale, 1) / 100 : M.tb,
    apogee_m: ev.apogee ? num(st.apogee) : N, apogee_t_s: apoT, apogee_range_m: ev.apogee ? Math.hypot(st.apoX || 0, st.apoY || 0) : N,
    deploy1_t_s: D1 ? D1.t : N, deploy1_z_m: D1 ? D1.z : N, deploy1_Va_mps: D1 ? D1.V : N, deploy1_q_Pa: D1 ? D1.q : N,
    deploy1_dtApo_s: dtA(D1), deploy1_by: D1 && D1.by ? D1.by : N,
    deploy2_t_s: D2 ? D2.t : N, deploy2_z_m: D2 ? D2.z : N, deploy2_Va_mps: D2 ? D2.V : N, deploy2_q_Pa: D2 ? D2.q : N, deploy2_dtApo_s: dtA(D2),
    payload_t_s: PE ? PE.t : N, payload_z_m: PE ? PE.z : N, payload_Va_mps: PE ? PE.V : N, payload_q_Pa: PE ? PE.q : N, payload_dtApo_s: dtA(PE),
    payloadOpenLoad_N: openN, payloadOpenLoad_G: PE && M.payloadMass > 0 ? openN / (M.payloadMass * G0) : N,
    descent1_mps: D1 ? (D2 ? (D2.t > D1.t ? Math.abs(D2.vz) : N) : LD ? Math.abs(LD.vz) : N) : N,
    landing_t_s: LD ? LD.t : N, landing_V_mps: LD ? LD.V : N, landing_vz_mps: LD ? LD.vz : N,
    landing_dist_m: LD ? Math.hypot(LD.x, LD.y) : N, landing_brgTrue_deg: LD ? brg(LD.x, LD.y) : N,
    payloadLanding_dist_m: PL ? Math.hypot(PL.x, PL.y) : N, payloadLanding_brgTrue_deg: PL ? brg(PL.x, PL.y) : N,
    payloadLanding_vz_mps: PL ? PL.vz : N, flightEnd_t_s: ends.length ? Math.max(...ends) : N,
  };
}

// 機体図用: ノーズ半径 r(x) [m]
function noseR(M, x) {
  const L = M.Ln, R = M.R, u = Math.min(Math.max(x / L, 0), 1);
  switch (M.c.noseShape) {
    case 'cone': return R * u;
    case 'parabolic': return R * (2 * u - u * u);
    case 'elliptic': return R * Math.sqrt(1 - (1 - u) ** 2);
    default: { const rho = (R * R + L * L) / (2 * R); return Math.sqrt(Math.max(0, rho * rho - (L - x) ** 2)) + R - rho; }
  }
}
