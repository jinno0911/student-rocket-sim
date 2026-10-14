'use strict';
/* 学生ロケット シミュレーター（UI 層）
 * 物理コアは physics.js（normalizeCfg / buildModel / simulate …）。契約は docs/spec-v2.md
 * 単位: cfg は mm / g / deg / s（慣性モーメントのみ kg·m²）。位置は常に機体先端からの mm
 * 座標: x=東, y=北, z=上 [m]
 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------------- 入力スキーマ ----------------
// t: 未指定=数値 / 'text' / 'select' / 'textarea' / 'check'。nul: 空欄で null を許す数値。ro: 表示のみ
// pos: 位置（cfg は先端基準。表示と入力だけ posRef に合わせて変換する）。lf: 動的なラベル
const SCHEMA = (() => {
  const motor = c => c.massMode === 'motor', hyb = c => c.massMode === 'hybrid', pl = c => !!c.payloadOn;
  const iman = c => c.inertiaMode === 'manual', aman = c => c.aeroMode === 'manual', apo = c => c.rec1 === 'apogee';
  const r1 = c => c.rec1 !== 'none', r2 = c => r1(c) && c.rec2 !== 'none';
  const dia = c => c.chuteSpec !== 'velocity', vel = c => c.chuteSpec === 'velocity';
  const ref = c => c === 'magnetic' ? '磁北基準' : '真北基準';
  const REF = [['true', '真北'], ['magnetic', '磁北']];
  return [
    { group: '基本', open: true, fields: [
      { k: 'name', l: '機体名', t: 'text', wide: true },
      { k: 'posRef', l: '位置の表示基準', t: 'select', wide: true, o: [['nose', '機体先端から'], ['aft', '機体後端から（諸元表の様式）']] },
    ] },
    { group: '機体', open: true, fields: [
      { k: 'noseShape', l: 'ノーズ形状', t: 'select', o: [['ogive', 'オジャイブ'], ['cone', 'コーン'], ['parabolic', '放物線'], ['elliptic', '楕円']] },
      { k: 'noseLen', l: 'ノーズ長', u: 'mm', min: 5, step: 5 },
      { k: 'bodyLen', l: '胴体長（ノーズ除く）', u: 'mm', min: 10, step: 10 },
      { k: 'd', l: '胴体外径', u: 'mm', min: 5, step: 1 },
      { k: 'tailLen', l: 'ボートテール長', u: 'mm', min: 0, step: 5 },
      { k: 'tailD', l: 'テール後端径', u: 'mm', min: 5, step: 1, show: c => c.tailLen > 0 },
    ] },
    { group: 'フィン', fields: [
      { k: 'finN', l: '枚数', min: 2, max: 8, step: 1 },
      { k: 'finCr', l: '翼根コード', u: 'mm', min: 1, step: 5 },
      { k: 'finCt', l: '翼端コード', u: 'mm', min: 0, step: 5 },
      { k: 'finSpan', l: 'スパン（高さ）', u: 'mm', min: 1, step: 5 },
      { k: 'finSweep', l: '前縁後退長', u: 'mm', step: 5 },
      { k: 'finThick', l: '厚さ', u: 'mm', min: 0.1, step: 0.5 },
      { k: 'finAft', l: '翼根後縁〜機体後端', u: 'mm', step: 5 },
      { k: 'finCant', l: '取付角（カント）', u: 'deg', step: 0.1 },
    ] },
    { group: '質量・慣性', fields: [
      { k: 'massMode', l: '質量モデル', t: 'select', wide: true, o: [['motor', '機体＋固体モーター'], ['hybrid', 'ハイブリッド（諸元表の方式）']] },
      { k: 'airMass', l: '機体質量（モーター除く）', u: 'g', min: 1, step: 10, show: motor },
      { k: 'airCG', l: '機体重心', u: 'mm', min: 0, step: 5, pos: true, show: motor },
      { k: 'hDryMass', l: '乾燥質量（酸化剤のみ除く）', u: 'g', min: 1, step: 10, show: hyb },
      { k: 'hDryCG', l: '乾燥時重心', u: 'mm', step: 5, pos: true, show: hyb },
      { k: 'hOxMass', l: '酸化剤質量（満充填）', u: 'g', min: 0, step: 10, show: hyb },
      { k: 'hOxCG', l: '酸化剤の初期重心', u: 'mm', step: 5, pos: true, show: hyb },
      { k: 'hTankOutlet', l: 'タンク口金の位置', u: 'mm', step: 5, pos: true, show: hyb },
      { k: 'hOxDrain', l: '排出に伴い酸化剤の重心を口金へ移動', t: 'check', wide: true, show: hyb },
      { k: 'hFuelPre', l: '燃焼前の燃料質量', u: 'g', min: 0, step: 10, show: hyb },
      { k: 'hFuelPost', l: '燃焼後の燃料質量', u: 'g', min: 0, step: 10, show: hyb },
      { k: 'hFuelCG', l: '燃料グレインの重心', u: 'mm', step: 5, pos: true, show: hyb },
      { k: 'hBurnTime', l: '燃焼時間（質量流量）', u: 's', min: 0.01, step: 0.1, show: hyb },
      { k: 'hOpTime', l: '作動時間（諸元表, 0=未設定）', u: 's', min: 0, step: 0.1, show: hyb },
      { k: 'ballast', l: 'バラスト質量', u: 'g', min: 0, step: 5 },
      { k: 'ballastPos', l: 'バラスト位置', u: 'mm', min: 0, step: 5, pos: true, show: c => c.ballast > 0 },
      { k: 'inertiaMode', l: '慣性モーメント', t: 'select', wide: true, o: [['auto', '形状・質量から自動推定'], ['manual', '手入力（乾燥時・乾燥重心まわり）']] },
      { k: 'Ipitch', l: 'ピッチ・ヨー慣性', u: 'kg·m²', min: 0, step: 0.01, show: iman },
      { k: 'Iroll', l: 'ロール慣性', u: 'kg·m²', min: 0, step: 0.001, show: iman },
      { k: 'payloadOn', l: 'ペイロードを放出する', t: 'check', wide: true },
      { k: 'payloadMass', l: 'ペイロード質量（機体に含む）', u: 'g', min: 0, step: 10, show: pl },
      { k: 'payloadPos', l: 'ペイロード重心', u: 'mm', min: 0, step: 5, pos: true, show: pl },
      { k: 'payloadTime', l: '放出時刻（点火から）', u: 's', min: 0, step: 0.5, show: pl },
      { k: 'payloadVt', l: 'ペイロード降下終端速度', u: 'm/s', min: 0.1, step: 0.5, show: pl },
    ] },
    { group: 'モーター', info: 'motorInfo', fields: [
      { k: 'motorPreset', l: 'プリセット', t: 'select', o: [['custom', '— 手動 —'], ...Object.entries(MOTORS).map(([k, m]) => [k, m.n])], wide: true },
      { k: 'motorSrc', l: '推力データ', t: 'select', o: [['param', 'パラメトリック'], ['eng', '推力表を貼付（.eng / t,F）']], wide: true },
      { k: 'mI', l: '総力積', u: 'N·s', min: 0.1, step: 10, show: c => c.motorSrc === 'param' },
      { k: 'mTb', l: '燃焼時間', u: 's', min: 0.05, step: 0.1, show: c => c.motorSrc === 'param' },
      { k: 'mShape', l: '推力形状', t: 'select', o: SHAPES, show: c => c.motorSrc === 'param', wide: true },
      { k: 'engText', l: '推力表（RASP .eng をそのまま貼付可。ヘッダ行があれば質量・寸法も上書き）', t: 'textarea', show: c => c.motorSrc === 'eng' },
      { k: 'thrustKind', l: '推力履歴の種別', t: 'select', ro: true, wide: true, o: [['measured', '実測・指定どおり'], ['assumed', '仮定（Isp 170 s から生成）']] },
      { k: 'mProp', l: '推進剤質量', u: 'g', min: 0, step: 10, show: motor },
      { k: 'mTotal', l: 'モーター全備質量', u: 'g', min: 0, step: 10, show: motor },
      { k: 'mLen', l: 'モーター長', u: 'mm', min: 1, step: 5 },
      { k: 'mDia', l: 'モーター径', u: 'mm', min: 1, step: 1 },
      { k: 'mOver', l: '後端からの突出', u: 'mm', step: 5 },
      { k: 'thrustScale', l: '推力倍率（気温・個体差）', u: '%', min: 1, step: 1 },
      { k: 'nozzleExitD', l: 'ノズル出口直径（0=圧力推力補正なし）', u: 'mm', min: 0, step: 1 },
    ] },
    { group: '回収系', fields: [
      { k: 'rec1', l: '1段目の開傘条件', t: 'select', wide: true, o: [['apogee', '頂点検知'], ['ignition', '点火からのタイマー'], ['burnout', '作動終了からのタイマー'], ['none', 'なし（弾道落下）']] },
      { k: 'rec1Time', l: 'タイマー時間', u: 's', min: 0, step: 0.5, show: c => c.rec1 === 'ignition' || c.rec1 === 'burnout' },
      { k: 'rec1Delay', l: '頂点検知の遅れ', u: 's', min: 0, step: 0.1, show: apo },
      { k: 'rec1Backup', l: '冗長タイマー（点火から, 0=なし）', u: 's', min: 0, step: 0.5, show: apo },
      { k: 'rec2', l: '2段目の開傘条件', t: 'select', wide: true, o: [['altitude', '1段目展開後、指定高度で開傘'], ['ignition', '点火からのタイマー'], ['none', 'なし（1段のみ）']], show: r1 },
      { k: 'rec2Time', l: '2段目タイマー（点火から）', u: 's', min: 0, step: 1, show: c => r1(c) && c.rec2 === 'ignition' },
      { k: 'mainAlt', l: '2段目の開傘高度', u: 'm', min: 0, step: 10, show: c => r1(c) && c.rec2 === 'altitude' },
      { k: 'chuteSpec', l: 'パラシュートの指定', t: 'select', wide: true, o: [['diameter', '直径と Cd'], ['velocity', '降下終端速度']], show: r1 },
      { k: 'c1D', l: '1段目パラ直径', u: 'mm', min: 0, step: 50, show: c => r1(c) && dia(c) },
      { k: 'c1Cd', l: '1段目パラ Cd', min: 0, step: 0.05, show: c => r1(c) && dia(c) },
      { k: 'c1Vt', l: '1段目の降下終端速度', u: 'm/s', min: 0.1, step: 0.1, show: c => r1(c) && vel(c) },
      { k: 'c2D', l: '2段目パラ直径', u: 'mm', min: 0, step: 50, show: c => r2(c) && dia(c) },
      { k: 'c2Cd', l: '2段目パラ Cd', min: 0, step: 0.05, show: c => r2(c) && dia(c) },
      { k: 'c2Vt', l: '2段目の降下終端速度（全系）', u: 'm/s', min: 0.1, step: 0.1, show: c => r2(c) && vel(c) },
      { k: 'openTime', l: '展開所要時間', u: 's', min: 0, step: 0.1, show: c => r1(c) || pl(c) },
      { k: 'dtApoWarn', l: '開傘・放出の頂点からのずれ 警告', u: 's', min: 0, step: 0.1 },
    ] },
    { group: '射点・気象', info: 'terrainInfo', fields: [
      { k: 'lat', l: '射点緯度', u: 'deg' },
      { k: 'lon', l: '射点経度', u: 'deg' },
      { k: 'siteAlt', l: '射点標高（海面高度）', u: 'm', step: 10 },
      { k: 'magMode', l: '磁気偏角の決め方', t: 'select', o: [['manual', '手入力'], ['auto', '自動（WMM2025・打上げ日）']],
        lf: c => c.magMode === 'auto' && window.Geo ? `磁気偏角の決め方（自動: ${window.Geo.magDecl(c.lat, c.lon, c.siteAlt, window.Geo.decimalYear(c.launchDate)).toFixed(2)}°）` : '磁気偏角の決め方' },
      { k: 'magDecl', l: '磁気偏角（東偏+ / 西偏−）', u: 'deg', step: 0.1, show: c => c.magMode !== 'auto' },
      { k: 'launchDate', l: '打上げ日（YYYY-MM-DD）', t: 'text', show: c => c.magMode === 'auto' },
      { k: 'temp', l: '地上気温', u: '℃', step: 1 },
      { k: 'landSurface', l: '着地面', t: 'select', o: [['site', '射点と同じ標高'], ['sea', '海面（標高 0 m）'], ['terrain', '地形（国土地理院 標高タイル）']] },
      { k: 'railLen', l: 'ランチャー長', u: 'm', min: 0.1, step: 0.5 },
      { k: 'lugAft', l: '後端〜最後尾（下側）ランチラグ', u: 'mm', min: 0, step: 5 },
      { k: 'tipOff', l: 'ティップオフ（上側ラグが抜けてから下側ラグを支点に回転）', t: 'check', wide: true },
      { k: 'lugUpper', l: '後端〜上側ランチラグ', u: 'mm', min: 0, step: 5, show: c => c.tipOff },
      { k: 'elev', l: '射角（90=垂直）', u: 'deg', min: 1, max: 90, step: 1 },
      { k: 'azimRef', l: '打上げ方位の基準', t: 'select', o: REF },
      { k: 'azim', l: '打上げ方位', u: 'deg', step: 5, lf: c => `打上げ方位（${ref(c.azimRef)}, 0=北 90=東）` },
      { k: 'windDirRef', l: '風向の基準', t: 'select', o: REF },
      { k: 'windFrom', l: '風向（吹いてくる方位）', u: 'deg', step: 5, lf: c => `風向・吹いてくる方位（${ref(c.windDirRef)}）` },
      { k: 'windModel', l: '風モデル', t: 'select', o: [['power', 'べき法則'], ['profile', '高度別プロファイル（表）']] },
      { k: 'wind', l: '風速', u: 'm/s', min: 0, step: 0.5, lf: c => `風速（高度 ${c.windRef} m）`, show: c => c.windModel !== 'profile' },
      { k: 'windRef', l: '風速の基準高さ', u: 'm', min: 0.1, step: 1, show: c => c.windModel !== 'profile' },
      { k: 'windExp', l: 'べき指数 α（=1/n）', min: 0, step: 0.01, show: c => c.windModel !== 'profile',
        lf: c => `べき指数 α（=1/n）　n = ${c.windExp > 0 ? +(1 / c.windExp).toFixed(2) : '∞'}` },
      { k: 'windMaxH', l: 'べき法則の上限高度（0=無制限）', u: 'm', min: 0, step: 100, show: c => c.windModel !== 'profile' },
      { k: 'windProfile', l: '風プロファイル（1行 = 高度m, 風速m/s, 風向deg。風向は上の基準）', t: 'textarea', rows: 4, ph: '0,2,270\n100,5,270\n500,9,260\n1000,12,250', show: c => c.windModel === 'profile' },
      { k: 'gust', l: '乱流（突風）強度', u: 'm/s', min: 0, step: 0.5 },
      { k: 'earthRot', l: '地球の自転（コリオリ力）と緯度・高度による重力', t: 'check', wide: true },
    ] },
    { group: '空力・計算', fields: [
      { k: 'aeroMode', l: '空力係数', t: 'select', wide: true, o: [['barrowman', 'Barrowman 法で推定'], ['manual', '諸元表の値を直接使う']] },
      { k: 'cpManual', l: '圧力中心', u: 'mm', step: 5, pos: true, show: aman },
      { k: 'cnaManual', l: '法線力傾斜 CNα', u: '1/rad', min: 0, step: 0.1, show: aman },
      { k: 'cmq', l: 'ピッチ減衰 Cmq（空欄=推定）', step: 0.01, nul: true, show: aman },
      { k: 'clp', l: 'ロール減衰 Clp（空欄=推定）', step: 0.01, nul: true, show: aman },
      { k: 'cdMode', l: '抗力係数 Cd', t: 'select', o: [['auto', '形状から自動推定'], ['manual', '手入力']], show: c => c.aeroMode === 'barrowman' },
      { k: 'cdManual', l: 'Cd（手入力・軸力係数）', min: 0.01, step: 0.01, show: c => aman(c) || c.cdMode === 'manual' },
      { k: 'cdScale', l: 'Cd 倍率（ランチラグ等）', u: '%', min: 1, step: 5 },
      { k: 'machCorr', l: '圧縮性補正（遷音速抗力・フィン揚力）', t: 'check', wide: true },
      { k: 'aeroTable', l: '空力テーブル（任意。1行 = Mach,Cd[,CNa[,Xcp_mm(先端)]]）', t: 'textarea', rows: 4, ph: '0.1,0.45,11.8,1258\n0.5,0.47' },
      { k: 'dt', l: '積分刻み', u: 'ms', min: 0.5, max: 20, step: 0.5 },
    ] },
    { group: '性能閾値（0 で無効）', fields: [
      { k: 'thMinApogee', l: '最低頂点高度', u: 'm', min: 0, step: 10 },
      { k: 'thMaxQ', l: '最大動圧の上限', u: 'Pa', min: 0, step: 1000 },
      { k: 'thMinRailV', l: '最低ランチクリア速度', u: 'm/s', min: 0, step: 1 },
      { k: 'thMaxRange', l: '着地点距離の上限', u: 'm', min: 0, step: 50 },
    ] },
    { group: 'ばらつき補正（モンテカルロ用。通常は既定値）', fields: [
      { k: 'cnaScale', l: 'CNα 倍率', u: '%', min: 1, step: 1 },
      { k: 'burnScale', l: '燃焼時間 倍率（力積は一定）', u: '%', min: 1, step: 1 },
      { k: 'cgShift', l: '乾燥重心のずれ（後方を正）', u: 'mm', step: 1 },
      { k: 'cpShift', l: '圧力中心のずれ（後方を正）', u: 'mm', step: 1 },
      { k: 'chuteScale', l: 'パラシュート CdS 倍率', u: '%', min: 0, step: 1 },
      { k: 'chuteDelay', l: '開傘タイミングのずれ', u: 's', step: 0.1 },
    ] },
  ];
})();
const FIELDS = SCHEMA.flatMap(g => g.fields);
const NUM_FIELDS = FIELDS.filter(f => !f.t);
// 推力に関わるキー。手で変えたら thrustKind を 'measured' に戻す（spec §2.7）
const THRUST_KEYS = ['motorSrc', 'engText', 'mI', 'mTb', 'mShape', 'motorPreset', 'thrustScale'];

const SAMPLE_ENG = `; 例: RASP .eng 形式（数値は架空のサンプル）
SAMPLE 38 337 0 0.37 0.73 Sample
0.02 420
0.10 460
0.40 430
0.80 380
1.20 330
1.60 270
1.85 120
2.00 0`;

// 既定値は physics.js の PHYS_DEFAULTS に一本化（spec §2.0）
const DEFAULTS = normalizeCfg({ engText: SAMPLE_ENG });
const STORE_KEY = 'student-rocket-sim:cfg';
let cfg = loadCfg();

function loadCfg() {
  try { const s = JSON.parse(localStorage.getItem(STORE_KEY)); if (s && typeof s === 'object') return normalizeCfg({ ...DEFAULTS, ...s }); } catch (e) {}
  return normalizeCfg({ ...DEFAULTS });
}
const cfgJson = (c, sp) => JSON.stringify(c, (k, v) => k === '__warn' ? undefined : v, sp);
function saveCfg() { try { localStorage.setItem(STORE_KEY, cfgJson(cfg)); } catch (e) {} }
// 入力欄で編集中の値（正規化前）。normalizeCfg が「他の欄」を補正しても（hFuelPost ≤ hFuelPre、payloadOn の自動 off など）
// 打ちかけの途中値で元の値が失われないよう、onField はこれを基に cfg を作り直す。外部からの applyCfg で破棄する
let cfgEdit = null;
// cfg を変更する唯一の経路（spec §6）
function applyCfg(next, { rewrite = true } = {}) {
  cfg = normalizeCfg({ ...DEFAULTS, ...next }); saveCfg(); if (rewrite) { cfgEdit = null; writeFields(); }
  window.Dispersion?.markStale(); window.V3D?.markDirty(); window.Analysis?.markStale(); window.Verify?.markStale(); scheduleRun();
}
// 位置の表示⇔cfg（spec §1）。L は常に cfgLenMm(cfg)
const posDisp = x => cfg.posRef === 'aft' ? +(cfgLenMm(cfg) - x).toFixed(3) : x;
const posFromDisp = v => cfg.posRef === 'aft' ? cfgLenMm(cfg) - v : v;

// ---------------- 描画ユーティリティ ----------------
function prep(cv) {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height };
}
function niceStep(span, n) {
  const s0 = span / n, mag = 10 ** Math.floor(Math.log10(s0)), e = s0 / mag;
  return (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
}
function nice(min, max, n = 5) {
  if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if (max - min < 1e-9) { const p = Math.abs(max) * 0.1 || 1; min -= p; max += p; }
  const st = niceStep(max - min, n);
  return { lo: Math.floor(min / st) * st, hi: Math.ceil(max / st) * st, step: st };
}
const fmtN = v => { const a = Math.abs(v); return a >= 1e4 ? (v / 1000).toFixed(0) + 'k' : a >= 100 ? v.toFixed(0) : a >= 1 ? +v.toFixed(2) + '' : +v.toPrecision(2) + ''; };
const CHART_CSS = { grid: '#22304f', axis: '#4a5a80', text: '#8c9bbd', fg: '#e6ecf8' };

// 軸付きフレーム。返り値 X(), Y() でデータ→画面
function frame(ctx, w, h, xr, yr, o = {}) {
  const pl = o.pl ?? 50, pr = o.pr ?? 12, pt = o.pt ?? 24, pb = o.pb ?? 30;
  const X = v => pl + (v - xr.lo) / (xr.hi - xr.lo) * (w - pl - pr);
  const Y = v => h - pb - (v - yr.lo) / (yr.hi - yr.lo) * (h - pt - pb);
  ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (let v = xr.lo; v <= xr.hi + xr.step * 1e-6; v += xr.step) {
    ctx.strokeStyle = CHART_CSS.grid; ctx.beginPath(); ctx.moveTo(X(v), pt); ctx.lineTo(X(v), h - pb); ctx.stroke();
    ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'center'; ctx.fillText(fmtN(v), X(v), h - pb + 14);
  }
  for (let v = yr.lo; v <= yr.hi + yr.step * 1e-6; v += yr.step) {
    ctx.strokeStyle = CHART_CSS.grid; ctx.beginPath(); ctx.moveTo(pl, Y(v)); ctx.lineTo(w - pr, Y(v)); ctx.stroke();
    ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'right'; ctx.fillText(fmtN(v), pl - 5, Y(v) + 4);
  }
  ctx.strokeStyle = CHART_CSS.axis; ctx.strokeRect(pl, pt, w - pl - pr, h - pt - pb);
  ctx.fillStyle = CHART_CSS.fg; ctx.textAlign = 'left'; ctx.font = 'bold 12px system-ui';
  if (o.title) ctx.fillText(o.title, pl, 15);
  ctx.font = '11px system-ui'; ctx.fillStyle = CHART_CSS.text;
  if (o.xlabel) { ctx.textAlign = 'right'; ctx.fillText(o.xlabel, w - pr, h - 3); }
  return { X, Y, pl, pr, pt, pb };
}
function lineChart(cv, o) {
  const { ctx, w, h } = prep(cv);
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of o.series) for (const [x, y] of s.pts) {
    if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
    if (o.xmax != null && x > o.xmax) continue;
    xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  if (o.yzero) ymin = Math.min(ymin, 0);
  if (!isFinite(xmin)) { xmin = 0; xmax = 1; ymin = 0; ymax = 1; }
  const xr = nice(xmin, xmax, 6), yr = nice(ymin, ymax, 5);
  if (o.xmax != null) xr.hi = Math.min(xr.hi, Math.max(o.xmax, xmin + 1e-6));
  const F = frame(ctx, w, h, xr, yr, o);
  ctx.save(); ctx.beginPath(); ctx.rect(F.pl, F.pt, w - F.pl - F.pr, h - F.pt - F.pb); ctx.clip();
  // イベント線。ラベルが前のラベルと重なるときは 1 段下げる（頂点と 1段目開傘など）
  const evs = (o.events || []).filter(e => e.x >= xr.lo && e.x <= xr.hi).sort((a, b) => a.x - b.x), ends = [];
  for (const e of evs) {
    const ex = F.X(e.x), lw = ctx.measureText(e.label).width;
    ctx.strokeStyle = e.color || '#556'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(ex, F.pt); ctx.lineTo(ex, h - F.pb); ctx.stroke(); ctx.setLineDash([]);
    let row = 0; while (row < 4 && ends[row] > ex + 3) row++;
    row = Math.min(row, 3); ends[row] = ex + 3 + lw + 4;
    ctx.fillStyle = e.color || CHART_CSS.text; ctx.textAlign = 'left'; ctx.fillText(e.label, ex + 3, F.pt + 11 + 12 * row);
  }
  for (const s of o.series) {
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = 1.8;
    ctx.beginPath(); let pen = false;
    for (const [x, y] of s.pts) {
      if (!Number.isFinite(y)) { pen = false; continue; }
      if (pen) ctx.lineTo(F.X(x), F.Y(y)); else { ctx.moveTo(F.X(x), F.Y(y)); pen = true; }
    }
    ctx.stroke();
    if (o.points) for (const [x, y] of s.pts) if (Number.isFinite(y)) { ctx.beginPath(); ctx.arc(F.X(x), F.Y(y), 2.5, 0, 7); ctx.fill(); }
  }
  if (o.cursor != null) { ctx.strokeStyle = '#fff8'; ctx.beginPath(); ctx.moveTo(F.X(o.cursor), F.pt); ctx.lineTo(F.X(o.cursor), h - F.pb); ctx.stroke(); }
  ctx.restore();
  if (o.series.length > 1) {
    let lx = w - F.pr - 6; ctx.textAlign = 'right'; ctx.font = '11px system-ui';
    for (const s of [...o.series].reverse()) { ctx.fillStyle = s.color; ctx.fillText('■ ' + s.name, lx, 15); lx -= ctx.measureText('■ ' + s.name).width + 10; }
  }
}

// ---------------- 状態 & UI ----------------
let model = null, sim = null, playIdx = -1, playing = false;

function buildPanel() {
  const panel = $('#panel'); panel.innerHTML = '';
  for (const g of SCHEMA) {
    const det = document.createElement('details'); det.open = !!g.open;
    det.innerHTML = `<summary>${g.group}</summary>`;
    const grid = document.createElement('div'); grid.className = 'fields';
    for (const f of g.fields) {
      const wrap = document.createElement('label');
      wrap.className = 'field' + (f.t === 'textarea' || f.wide ? ' wide' : '') + (f.t === 'check' ? ' check' : '');
      wrap.dataset.k = f.k;
      let inp;
      if (f.t === 'select') { inp = document.createElement('select'); for (const [v, l] of f.o) inp.add(new Option(l, v)); }
      else if (f.t === 'textarea') { inp = document.createElement('textarea'); inp.rows = f.rows ?? 8; inp.spellcheck = false; }
      else { inp = document.createElement('input'); inp.type = f.t === 'check' ? 'checkbox' : f.t === 'text' ? 'text' : 'number';
        if (!f.t) { inp.step = f.step ?? 'any'; if (f.min != null) inp.min = f.min; if (f.max != null) inp.max = f.max; inp.inputMode = 'decimal'; } }
      inp.id = 'f_' + f.k;
      if (f.ph) inp.placeholder = f.ph;
      else if (f.nul) inp.placeholder = '空欄 = 推定値';
      if (f.ro) { inp.disabled = true; wrap.classList.add('ro'); }
      if (!f.t) inp.addEventListener('wheel', () => { if (document.activeElement === inp) inp.blur(); }, { passive: true });
      const lab = document.createElement('span'); lab.innerHTML = fieldLabelHtml(f);
      if (f.t === 'check') { wrap.append(inp, lab); } else { wrap.append(lab, inp); }
      grid.appendChild(wrap);
      inp.addEventListener(f.t === 'select' || f.t === 'check' ? 'change' : 'input', () => onField(f, inp));
    }
    if (g.info) { const d = document.createElement('div'); d.className = 'info'; d.id = g.info; grid.appendChild(d); }
    det.appendChild(grid); panel.appendChild(det);
  }
}
// ラベル（pos 欄は「（先端から）/（後端から）」、lf は cfg に応じた動的ラベル）
function fieldLabelHtml(f) {
  const l = (f.lf ? f.lf(cfg) : f.l) + (f.pos ? (cfg.posRef === 'aft' ? '（後端から）' : '（先端から）') : '');
  return l + (f.u ? ` <small>[${f.u}]</small>` : '');
}
// skip: 入力中の要素（書き直さない）。値が同じ欄は触らない（カーソル・スクロールを保つ）
function writeFields(skip) {
  for (const f of FIELDS) {
    const el = $('#f_' + f.k); if (!el || el === skip) continue;
    if (f.t === 'check') { el.checked = !!cfg[f.k]; continue; }
    const v = cfg[f.k], s = v == null ? '' : String(f.pos && typeof v === 'number' ? posDisp(v) : v);
    if (el.value !== s) el.value = s;
  }
  refreshVisibility(); refreshLabels();
}
function refreshVisibility() {
  for (const f of FIELDS) if (f.show) $(`.field[data-k="${f.k}"]`).classList.toggle('hide', !f.show(cfg));
}
function refreshLabels() {
  for (const f of FIELDS) if (f.pos || f.lf) { const s = $(`.field[data-k="${f.k}"] > span`); const h = fieldLabelHtml(f); if (s && s.innerHTML !== h) s.innerHTML = h; }
}
function onField(f, el) {
  if (f.k === 'posRef') {
    // 表示基準の切替は表示だけ（再計算・markStale はしない。spec §1）
    cfg = normalizeCfg({ ...cfg, posRef: el.value }); if (cfgEdit) cfgEdit.posRef = cfg.posRef;
    saveCfg(); writeFields(el); if (model) drawRocket();
    if (model && $('#tab-charts').classList.contains('on')) drawCharts();   // 重心位置のグラフも表示基準に合わせる
    return;
  }
  const next = { ...(cfgEdit || cfg) };
  if (f.t === 'check') next[f.k] = el.checked;
  else if (f.t) next[f.k] = el.value;                       // select / textarea / text は文字列のまま
  else {
    const v = parseFloat(el.value);
    if (Number.isFinite(v)) next[f.k] = f.pos ? posFromDisp(v) : v;
    else if (f.nul && el.value.trim() === '' && !el.validity.badInput) next[f.k] = null;
    else return;
  }
  if (f.k === 'motorPreset' && MOTORS[next.motorPreset]) {
    const m = MOTORS[next.motorPreset];
    Object.assign(next, { motorSrc: 'param', mI: m.I, mTb: m.tb, mShape: m.shape, mProp: m.prop, mTotal: m.total, mLen: m.len, mDia: m.dia });
  } else if (['mI', 'mTb', 'mShape', 'mProp', 'mTotal', 'mLen', 'mDia'].includes(f.k) || (f.k === 'motorSrc' && next.motorSrc === 'eng')) {
    next.motorPreset = 'custom';
  }
  if (THRUST_KEYS.includes(f.k)) next.thrustKind = 'measured';
  cfgEdit = next;
  applyCfg(next, { rewrite: false });
  // 入力中の欄以外を同期: 連動した値（プリセット・thrustKind・正規化の補正）、L 変更時の pos 欄（後端基準）、表示条件、ラベル
  writeFields(el);
}
let runTimer = 0;
function scheduleRun() { clearTimeout(runTimer); runTimer = setTimeout(runNominal, 120); }

function runNominal() {
  clearTimeout(runTimer); runTimer = 0;
  let M = null;
  try {
    M = buildModel(cfg);
    sim = simulate(M, { seed: 1 });
  } catch (e) { console.error(e); sim = { rec: [], ev: { error: '計算エラー: ' + e.message }, st: {}, payload: null }; }
  model = M;
  fsNow = getSummary(M, sim); rvNow = null;
  if (M) try { rvNow = reviewValues(M); } catch (e) { console.error(e); }
  playing = false; $('#btnPlay').textContent = '▶ 再生';
  seekT(playEnd());                                // 計算直後は飛行の終わり（全体の軌跡）を表示する
  renderAll();
  window.V3D?.markDirty();
}

function renderAll() {
  drawRocket(); renderStatic(); renderResults(); renderWarnings(); renderReview(); renderMotorInfo();
  drawFlight(); if ($('#tab-charts').classList.contains('on')) drawCharts();
}

// ---- 機体図 ----
function drawRocket() {
  const cv = $('#cvRocket'), { ctx, w, h } = prep(cv), M = model;
  if (!M) return;
  const xEnd = Math.max(M.L, M.L + cfg.mOver / 1000, M.Xb + Math.max(M.Cr, M.Xs + M.Ct));
  const halfH = M.R + M.s;
  const sc = Math.min((w - 40) / xEnd, (h - 56) / (2 * halfH));
  const ox = 20, oy = h / 2 + 6;
  const X = x => ox + x * sc, Y = r => oy - r * sc;
  // 胴体輪郭
  ctx.beginPath(); ctx.moveTo(X(0), Y(0));
  for (let i = 1; i <= 40; i++) { const x = M.Ln * i / 40; ctx.lineTo(X(x), Y(noseR(M, x))); }
  ctx.lineTo(X(M.Ln + M.Lb), Y(M.R)); ctx.lineTo(X(M.L), Y(M.dBase / 2));
  ctx.lineTo(X(M.L), Y(-M.dBase / 2)); ctx.lineTo(X(M.Ln + M.Lb), Y(-M.R));
  for (let i = 40; i >= 0; i--) { const x = M.Ln * i / 40; ctx.lineTo(X(x), Y(-noseR(M, x))); }
  ctx.closePath(); ctx.fillStyle = '#24345a'; ctx.fill(); ctx.strokeStyle = '#9fb3d9'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.strokeStyle = '#9fb3d966'; ctx.beginPath(); ctx.moveTo(X(M.Ln), Y(M.R)); ctx.lineTo(X(M.Ln), Y(-M.R)); ctx.stroke();
  // フィン
  for (const sgn of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(X(M.Xb), Y(sgn * M.R)); ctx.lineTo(X(M.Xb + M.Xs), Y(sgn * (M.R + M.s)));
    ctx.lineTo(X(M.Xb + M.Xs + M.Ct), Y(sgn * (M.R + M.s))); ctx.lineTo(X(M.Xb + M.Cr), Y(sgn * M.R)); ctx.closePath();
    ctx.fillStyle = '#3d5a8a'; ctx.fill(); ctx.strokeStyle = '#9fb3d9'; ctx.stroke();
  }
  // モーター
  ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ff9b3d';
  ctx.strokeRect(X(M.motorX - M.mLen / 2), Y(M.mDia / 2), M.mLen * sc, M.mDia * sc); ctx.setLineDash([]);
  // バラスト
  if (cfg.ballast > 0) { ctx.fillStyle = '#c9a227'; ctx.beginPath(); ctx.arc(X(cfg.ballastPos / 1000), Y(0), 4, 0, 7); ctx.fill(); }
  // ペイロード（重心位置に □）
  if (M.payloadOn ?? cfg.payloadOn) { ctx.strokeStyle = PH_COL.pay; ctx.lineWidth = 2; ctx.strokeRect(X(cfg.payloadPos / 1000) - 5, Y(0) - 5, 10, 10); }
  // CG / CP
  const m0 = M.massAt(0), m1 = M.massAt(M.tEnd), cp = M.cpAt(0);
  const pl = x => f0(posDisp(x * 1000));   // 表示は posRef に合わせる
  const mark = (x, col, label, up, hollow) => {
    const px = X(x), py = Y(0);
    ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(px, py, 6, 0, 7); hollow ? ctx.stroke() : ctx.fill();
    ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    const ty = up ? Y(halfH) - 6 : Y(-halfH) + 14;
    ctx.beginPath(); ctx.moveTo(px, py + (up ? -7 : 7)); ctx.lineTo(px, ty + (up ? 2 : -11)); ctx.globalAlpha = .5; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(label, px, ty);
  };
  mark(m0.cg, '#7aa2ff', `CG ${pl(m0.cg)}`, true);
  mark(m1.cg, '#7aa2ff', `燃焼後 ${pl(m1.cg)}`, false, true);
  mark(cp.xcp, '#ff6b8b', `CP ${pl(cp.xcp)}`, true);
  ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'left'; ctx.font = '11px system-ui';
  ctx.fillText(`全長 ${(M.L * 1000).toFixed(0)} mm  /  単位: mm（${cfg.posRef === 'aft' ? '後端' : '先端'}基準）`, 8, 14);
}
function renderStatic() {
  const M = model; if (!M) { $('#staticInfo').innerHTML = ''; return; }
  const m0 = M.massAt(0), m1 = M.massAt(M.tEnd), cp = M.cpAt(0);
  const sm0 = (cp.xcp - m0.cg) / M.d, sm1 = (cp.xcp - m1.cg) / M.d;
  $('#staticInfo').innerHTML = [
    ['離陸質量', (m0.m * 1000).toFixed(0) + ' g'], ['燃焼後質量', (m1.m * 1000).toFixed(0) + ' g'],
    ['CNα', cp.cna.toFixed(2)], ['静安定余裕', `${sm0.toFixed(2)} → ${sm1.toFixed(2)} cal`],
    ['Cd', `${M.cd0.toFixed(3)}${cfg.cdMode === 'auto' ? '（推定）' : ''}`], ['L/D', (M.L / M.d).toFixed(1)],
  ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
}
function renderMotorInfo() {
  const M = model, el = $('#motorInfo'); if (!M || !el) return;
  const avg = M.tb > 0 ? M.Itot / M.tb : 0, peak = Math.max(...M.pts.map(p => p[1]));
  const tw = peak / (M.massAt(0).m * G0), twAvg = avg / (M.massAt(0).m * G0);
  el.innerHTML = `<b>${motorClass(M.Itot)}</b> クラス${M.mName ? '（' + M.mName + '）' : ''} ／ 総力積 <b>${M.Itot.toFixed(1)}</b> N·s ／ 燃焼 <b>${M.tb.toFixed(2)}</b> s<br>
    平均 <b>${avg.toFixed(0)}</b> N・最大 <b>${peak.toFixed(0)}</b> N ／ 推力重量比 平均 <b>${twAvg.toFixed(1)}</b>・最大 <b>${tw.toFixed(1)}</b>`;
}

function card(l, v, u, s) { return `<div class="res"><div class="l">${l}</div><div class="v">${v}<small>${u || ''}</small></div><div class="s">${s || ''}</div></div>`; }
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : '—', f0 = v => Number.isFinite(v) ? v.toFixed(0) : '—', f2 = v => Number.isFinite(v) ? v.toFixed(2) : '—';
const ASSUMED_MSG = '推力履歴は仮定（Isp 170 s）。審査提出には地上燃焼試験の推力履歴を使用すること';   // spec §2.7
const escHtml = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// ノミナル計算の要約（flightSummary）と審査用計算値（reviewValues）。runNominal で更新する
let fsNow = {}, rvNow = null;
// 飛行結果の要約（spec §3.4）。physics の flightSummary を使い、無い・失敗したときだけ同じ定義で rec/ev から求める
function getSummary(M, s) {
  if (M && s && typeof flightSummary === 'function') {
    try { const r = flightSummary(M, s); if (r && typeof r === 'object') return r; } catch (e) { console.error(e); }
  }
  return summaryLocal(M, s);
}
function summaryLocal(M, s) {
  const ev = s?.ev || {}, st = s?.st || {}, rec = s?.rec || [], pay = s?.payload || null, N = NaN;
  const num = v => Number.isFinite(v) ? v : N, brg = (x, y) => (Math.atan2(x, y) / D2R + 360) % 360;
  const apoT = ev.apogee?.t ?? Infinity, t0 = ev.liftoff?.t ?? 0;
  const o = {
    railExit_t_s: num(ev.railExit?.t), railExit_V_mps: num(ev.railExit?.V), railExit_alphaW_deg: num(ev.railExit?.alphaW),
    maxV_mps: N, maxV_t_s: N, maxMach: N, maxQ_Pa: N, maxQ_t_s: N, maxAcc_G: N,
    opEnd_t_s: num(M?.tb), opEnd_z_m: num(ev.burnout?.z), opEnd_V_mps: num(ev.burnout?.V),
    burnEnd_t_s: M ? (M.massMode === 'hybrid' ? (M.tIgn || 0) + M.c.hBurnTime : M.tb) : N,
    apogee_m: num(ev.apogee?.z ?? st.apogee), apogee_t_s: num(ev.apogee?.t ?? st.apoT), apogee_range_m: num(Math.hypot(st.apoX, st.apoY)),
  };
  // 上昇区間（離床〜頂点）の最大値
  const asc = rec.filter(r => r.t >= t0 && r.t <= apoT);
  if (asc.length) {
    let a = asc[0], b = asc[0];
    for (const r of asc) { if (r.V > a.V) a = r; if (r.q > b.q) b = r; }
    Object.assign(o, { maxV_mps: a.V, maxV_t_s: a.t, maxQ_Pa: b.q, maxQ_t_s: b.t,
      maxMach: Math.max(...asc.map(r => num(r.mach)).filter(Number.isFinite)), maxAcc_G: Math.max(...asc.map(r => num(r.g)).filter(Number.isFinite)) });
  } else Object.assign(o, { maxV_mps: num(st.maxV), maxMach: num(st.maxMach), maxQ_Pa: num(st.maxQ), maxAcc_G: num(st.maxG) });
  const dtA = e => e && ev.apogee ? e.t - ev.apogee.t : N;
  for (const [k, e] of [['deploy1', ev.deploy1], ['deploy2', ev.deploy2], ['payload', ev.payload]]) {
    o[k + '_t_s'] = num(e?.t); o[k + '_z_m'] = num(e?.z); o[k + '_Va_mps'] = num(e?.V); o[k + '_q_Pa'] = num(e?.q); o[k + '_dtApo_s'] = dtA(e);
  }
  o.deploy1_by = ev.deploy1?.by ?? '';
  o.payloadOpenLoad_N = M?.payloadCdA > 0 ? o.payload_q_Pa * M.payloadCdA : N;
  o.payloadOpenLoad_G = M ? o.payloadOpenLoad_N / (M.c.payloadMass / 1000 * G0) : N;
  // 1段目展開後、2段目展開前の最後の |vz|
  const tEnd1 = ev.deploy2?.t ?? ev.landing?.t ?? Infinity, r1 = ev.deploy1 ? rec.filter(r => r.t >= ev.deploy1.t && r.t <= tEnd1) : [];
  o.descent1_mps = r1.length ? Math.abs(r1[r1.length - 1].vz) : ev.deploy1 ? Math.abs((ev.deploy2 ?? ev.landing)?.vz ?? N) : N;
  const L = ev.landing, PL = pay?.landing;
  Object.assign(o, { landing_t_s: num(L?.t), landing_V_mps: num(L?.V), landing_vz_mps: num(L?.vz),
    landing_dist_m: L ? Math.hypot(L.x, L.y) : N, landing_brgTrue_deg: L ? brg(L.x, L.y) : N,
    payloadLanding_dist_m: PL ? Math.hypot(PL.x, PL.y) : N, payloadLanding_brgTrue_deg: PL ? brg(PL.x, PL.y) : N, payloadLanding_vz_mps: num(PL?.vz) });
  const tE = [L?.t, PL?.t].filter(Number.isFinite); o.flightEnd_t_s = tE.length ? Math.max(...tE) : N;
  return o;
}
function renderResults() {
  const { ev, st } = sim, S = fsNow || {}, el = $('#results');
  const dA = v => Number.isFinite(v) ? `頂点${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} s` : '';
  const has = k => Number.isFinite(S[k]);
  const cards = [
    card('頂点高度', f0(S.apogee_m), ' m', `T+${f1(S.apogee_t_s)} s ／ 水平 ${f0(S.apogee_range_m)} m`),
    card('最大速度（上昇中）', f0(S.maxV_mps), ' m/s', `Mach ${f2(S.maxMach)} ／ T+${f1(S.maxV_t_s)} s`),
    card('最大加速度（上昇中）', f1(S.maxAcc_G), ' G', `最大動圧 ${f1(S.maxQ_Pa / 1000)} kPa（T+${f1(S.maxQ_t_s)} s）`),
    card('ランチクリア速度', f1(S.railExit_V_mps), ' m/s', `T+${f2(S.railExit_t_s)} s ／ 横風迎角 ${f1(S.railExit_alphaW_deg)}°`),
    card('安定余裕', f2(ev.railExit?.sm), ' cal', `飛行中最小 ${f2(st.minSM)}`),
    card('最大迎角', f1(st.maxAlpha), '°', st.maxRollRate * 30 / Math.PI >= 0.5 ? `最大ロール ${f0(st.maxRollRate * 30 / Math.PI)} rpm` : ''),
    card('作動終了時', f0(S.opEnd_V_mps), ' m/s', `T+${f2(S.opEnd_t_s)} s ／ 高度 ${f0(S.opEnd_z_m)} m`),
    card(has('deploy2_t_s') ? '1段目開傘 対気速度' : '開傘時対気速度', f1(S.deploy1_Va_mps), ' m/s',
      has('deploy1_t_s') ? `高度 ${f0(S.deploy1_z_m)} m ／ ${dA(S.deploy1_dtApo_s)}${S.deploy1_by === 'timer' && cfg.rec1 === 'apogee' ? '（冗長タイマー）' : ''}` : '開傘なし'),
  ];
  if (has('deploy2_t_s')) cards.push(card('2段目開傘 対気速度', f1(S.deploy2_Va_mps), ' m/s', `高度 ${f0(S.deploy2_z_m)} m ／ ${dA(S.deploy2_dtApo_s)}`));
  cards.push(
    card('着地時降下速度', f1(Math.abs(S.landing_vz_mps)), ' m/s', (has('deploy2_t_s') ? `1段目 ${f1(S.descent1_mps)} ／ ` : '') + `対地 ${f1(S.landing_V_mps)} m/s`),
    card('落下距離', f0(S.landing_dist_m), ' m', has('landing_t_s') ? `方位 ${f0(S.landing_brgTrue_deg)}°（真北）` : ''),
    card('飛行時間', f1(S.landing_t_s), ' s', S.flightEnd_t_s > S.landing_t_s + 1e-9 ? `ペイロード着地まで ${f1(S.flightEnd_t_s)} s` : `作動時間 ${f2(S.opEnd_t_s)} s`),
  );
  if (cfg.payloadOn) {
    cards.push(
      card('ペイロード放出 対気速度', f1(S.payload_Va_mps), ' m/s', has('payload_t_s')
        ? `T+${f1(S.payload_t_s)} s ／ ${dA(S.payload_dtApo_s)} ／ 開傘荷重 ${f0(S.payloadOpenLoad_N)} N（${f1(S.payloadOpenLoad_G)} G）` : '放出なし'),
      card('ペイロード落下距離', f0(S.payloadLanding_dist_m), ' m', Number.isFinite(S.payloadLanding_dist_m)
        ? `方位 ${f0(S.payloadLanding_brgTrue_deg)}°（真北）／ 降下 ${f1(Math.abs(S.payloadLanding_vz_mps))} m/s` : '着地なし'),
    );
  }
  el.innerHTML = cards.join('');
  const rn = $('#resultNote'); if (rn) rn.innerHTML = cfg.thrustKind === 'assumed' ? `<div class="w warn banner">⚠ ${ASSUMED_MSG}</div>` : '';
}
function renderWarnings() {
  const { ev, st } = sim, M = model, S = fsNow || {}, rv = rvNow || {}, out = [];
  const add = (lv, msg) => out.push(`<div class="w ${lv}">${msg}</div>`);
  if (ev.error) add('bad', '⛔ ' + escHtml(ev.error));
  if (!M) { $('#warnings').innerHTML = out.join(''); return; }
  for (const w of M.warn || []) add('warn', '⚠ ' + escHtml(w));
  // 偏角を使う（磁北基準の入力がある）か 0 以外を入れたときだけ警告欄に出す（既定の 0°・真北基準で毎回出るのを避ける）。チェック欄には常に出す
  const dc = usesDecl() ? declCheck(cfg.lat, cfg.lon, declNow()) : null; if (dc) add('warn', '⚠ ' + escHtml(dc));
  const cp = M.cpAt(0), m0 = M.massAt(0), sm0 = (cp.xcp - m0.cg) / M.d;
  if (sm0 < 0) add('bad', `⛔ 静的に不安定です（安定余裕 ${sm0.toFixed(2)} cal）。CP が CG より前にあります。`);
  else if (sm0 < 1) add('warn', `⚠ 安定余裕が小さい（${sm0.toFixed(2)} cal、目安 1.0〜2.0 cal 以上）`);
  else if (sm0 > 4) add('warn', `⚠ オーバースタブル気味（${sm0.toFixed(2)} cal）。風に向かって大きく傾きやすい`);
  // Fst（%）= (cg_aft − cp_aft)/L × 100（諸元表の定義）
  const fst = [['充填時', rv.fstWet_pct], ['非充填時', rv.fstDry_pct], ['燃焼終了時', rv.fstBurnout_pct], ['ペイロード放出後', rv.fstAfterPayload_pct]].filter(([, v]) => Number.isFinite(v));
  const fMin = Math.min(...fst.map(a => a[1]));
  if (fst.length && fMin < 10) add(fMin < 0 ? 'bad' : 'warn', `${fMin < 0 ? '⛔' : '⚠'} Fst が小さい（${fst.map(([l, v]) => `${l} ${v.toFixed(1)} %`).join('、')}。目安 10 % 以上）`);
  if (ev.railExit && ev.railExit.V < 15) add('warn', `⚠ ランチクリア速度が低い（${ev.railExit.V.toFixed(1)} m/s、目安 15〜20 m/s 以上）`);
  if (S.railExit_alphaW_deg > 15) add('warn', `⚠ ランチクリア時の横風迎角が大きい（${S.railExit_alphaW_deg.toFixed(1)}°、目安 15° 以下）。風見効果で風上へ大きく向きます`);
  const tw = M.Itot / Math.max(M.tb, 1e-6) / (m0.m * G0);
  if (tw < 5 && !ev.error) add('warn', `⚠ 平均推力重量比が低い（${tw.toFixed(1)}、目安 5 以上）`);
  if (st.maxMach > 0.85) add('warn', `⚠ 遷音速域に入ります（Mach ${st.maxMach.toFixed(2)}）。抗力・CP の推定誤差が大きくなります`);
  if (st.maxAlpha > 15) add('warn', `⚠ 迎角が大きい（最大 ${st.maxAlpha.toFixed(0)}°）。風・安定性を確認してください`);
  if (ev.deploy1 && ev.deploy1.V > 30) add('warn', `⚠ 開傘時の対気速度が大きい（${ev.deploy1.V.toFixed(0)} m/s）。開傘衝撃に注意`);
  if (ev.deploy2 && ev.deploy2.V > 40) add('warn', `⚠ 2段目開傘時の対気速度が大きい（${ev.deploy2.V.toFixed(0)} m/s）。1段目の大きさを確認してください`);
  // 頂点からのずれ（dtApo < 0 は上昇中、> dtApoWarn は遅すぎ）
  const tw1 = cfg.rec1 === 'burnout' || cfg.rec1 === 'ignition', lim = cfg.dtApoWarn;
  const d1 = S.deploy1_dtApo_s;
  if (Number.isFinite(d1) && (d1 < 0 || d1 > lim)) {
    const hint = tw1 && ev.apogee ? `（最適な${cfg.rec1 === 'burnout' ? '作動終了からの' : '点火からの'}時間 ≈ ${(ev.apogee.t - (cfg.rec1 === 'burnout' ? M.tb : 0)).toFixed(1)} s）` : '';
    add('warn', d1 < 0 ? `⚠ 1段目が頂点の ${(-d1).toFixed(1)} s 前（上昇中）に開傘します。対気速度 ${f1(S.deploy1_Va_mps)} m/s${hint}`
      : `⚠ 1段目の開傘が頂点から +${d1.toFixed(1)} s 遅れています（しきい値 ${lim} s）${hint}`);
  }
  if (ev.deploy1 && !ev.apogee) add('warn', '⚠ 頂点到達前に開傘しています');
  if (ev.deploy1?.by === 'timer' && cfg.rec1 === 'apogee') add('warn', `⚠ 頂点検知より先に冗長タイマー（${cfg.rec1Backup} s）で開傘しています`);
  // 2段目は「1段目の後に開く」設計なので、頂点より前（上昇中）と 1段目より先のときだけ警告する
  if (S.deploy2_dtApo_s < 0) add('warn', `⚠ 2段目が頂点の ${(-S.deploy2_dtApo_s).toFixed(1)} s 前（上昇中）に開傘します。対気速度 ${f1(S.deploy2_Va_mps)} m/s`);
  if (ev.deploy2?.beforeDeploy1) add('warn', '⚠ 2段目の条件が 1段目より先に成立したため、1段目と同時に展開しました');
  if (cfg.rec1 !== 'none' && cfg.chuteSpec === 'velocity' && cfg.rec2 !== 'none' && cfg.c2Vt >= cfg.c1Vt)
    add('warn', `⚠ 2段目の降下終端速度 ${cfg.c2Vt} m/s が 1段目 ${cfg.c1Vt} m/s 以上です（2段目で減速しません）`);
  if (ev.landing && Math.abs(ev.landing.vz) > 7 && cfg.rec1 !== 'none') add('warn', `⚠ 降下速度が大きい（${Math.abs(ev.landing.vz).toFixed(1)} m/s、目安 4〜7 m/s）`);
  if (cfg.rec1 !== 'none' && cfg.rec2 === 'altitude' && ev.apogee && ev.apogee.z < cfg.mainAlt) add('warn', '⚠ 頂点高度が 2段目の開傘高度より低いため、1段目の直後に 2段目が開きます');
  // ペイロード
  if (cfg.payloadOn && !ev.error) {
    const dp = S.payload_dtApo_s, P = sim.payload;
    if (!P && !ev.payload) add('warn', `⚠ ペイロードが放出されませんでした（放出時刻 ${cfg.payloadTime} s が着地より後など）`);
    if (dp < 0) add('warn', `⚠ ペイロードが上昇中（頂点の ${(-dp).toFixed(1)} s 前）に放出されます。対気速度 ${f1(S.payload_Va_mps)} m/s、開傘荷重 ${f0(S.payloadOpenLoad_N)} N（${f1(S.payloadOpenLoad_G)} G）、放出後の Fst ${f1(rv.fstAfterPayload_pct)} %`);
    else if (dp > lim) add('warn', `⚠ ペイロードの放出が頂点から +${dp.toFixed(1)} s 遅れています（しきい値 ${lim} s）`);
    if (P?.error) add('warn', '⚠ ペイロード: ' + escHtml(P.error));
    else if (P && !P.landing) add('warn', '⚠ ペイロードが着地しませんでした');
  }
  // 推進系（諸元表との整合）
  const hyb = cfg.massMode === 'hybrid';
  if (cfg.thrustKind !== 'assumed' && cfg.hOpTime > 0 && Number.isFinite(rv.opTimeCurve_s) && Math.abs(rv.opTimeCurve_s - cfg.hOpTime) > 0.1)
    add('warn', `⚠ 推力履歴から求めた作動時間 ${rv.opTimeCurve_s.toFixed(2)} s が諸元表の作動時間 ${cfg.hOpTime} s と 0.1 s 以上違います`);
  const opT = Number.isFinite(rv.opTime_s) ? rv.opTime_s : M.tb;
  if (hyb && cfg.hBurnTime > opT + 1e-9 && !(M.warn || []).some(w => /燃焼時間.*作動時間/.test(w)))
    add('warn', `⚠ 燃焼時間 ${cfg.hBurnTime} s が作動時間 ${+opT.toFixed(3)} s を超えています`);
  if (hyb && Number.isFinite(rv.ispEff_s) && (rv.ispEff_s < 100 || rv.ispEff_s > 250))
    add('warn', `⚠ 有効比推力 ${rv.ispEff_s.toFixed(0)} s が範囲外です（ハイブリッドの目安 100〜250 s）。推力履歴・推進剤質量を確認してください`);
  if (M.c.mDia > M.c.d) add('bad', '⛔ モーター径が胴体外径より大きくなっています');
  for (const th of window.Analysis ? window.Analysis.thresholds(cfg, S) : []) if (!th.ok) add('bad', `⛔ 性能閾値: ${th.l} ${th.limit} ${th.u} を満たしていません（${Number.isFinite(th.value) ? +th.value.toFixed(1) : '—'} ${th.u}）`);
  if (ev.railExit && Number.isFinite(ev.railExit.tipRate)) add('ok', `ℹ ティップオフ: 下側ラグ離脱時のピッチレート ${ev.railExit.tipRate.toFixed(2)}°/s、頭下げ ${ev.railExit.tipAngle.toFixed(3)}°`);
  if (!out.length) add('ok', '✓ 主要な警告はありません');
  $('#warnings').innerHTML = out.join('');
}
const declNow = () => (model && Number.isFinite(model.magDecl) ? model.magDecl : cfg.magDecl); // 自動（WMM）なら計算値
function usesDecl() { return declNow() !== 0 || cfg.azimRef === 'magnetic' || cfg.windDirRef === 'magnetic'; }
// 「諸元表チェック」カード: REVIEW_LABELS の順に reviewValues（位置は後端基準。null は —）、真方位、M.warn、declCheck
function renderReview() {
  const box = $('#review'), sum = $('#reviewSum'); if (!box || !sum) return;
  const M = model, rv = rvNow;
  if (!M || !rv) { sum.textContent = '諸元表チェック'; box.innerHTML = '<p class="muted small">計算エラーのため表示できません。入力を確認してください。</p>'; return; }
  const fv = v => v == null || (typeof v === 'number' && !Number.isFinite(v)) ? '—' : typeof v === 'number' ? String(+v.toPrecision(6)) : escHtml(v);
  const ta = rv.trueAzim_deg, ref = r => r === 'magnetic' ? '磁北' : '真北';
  const warns = [...(M.warn || [])], dc = usesDecl() ? declCheck(cfg.lat, cfg.lon, declNow()) : null; if (dc) warns.push(dc);
  const nW = warns.length + (cfg.thrustKind === 'assumed' ? 1 : 0);
  sum.innerHTML = `諸元表チェック <span class="muted">（審査用計算値・後端基準）</span>　<span class="rv-pill">真方位 ${f1(ta)}°</span>`
    + (Number.isFinite(rv.fstWet_pct) ? `<span class="rv-pill">Fst ${f1(rv.fstWet_pct)} %</span>` : '')
    + (nW ? `<span class="rv-pill warn">注意 ${nW} 件</span>` : '');
  const windTrue = ((cfg.windFrom + (cfg.windDirRef === 'magnetic' ? cfg.magDecl : 0)) % 360 + 360) % 360;
  const rows = REVIEW_LABELS.map(([k, l, u]) => `<div class="rv-row${/_nose_/.test(k) ? ' sub' : ''}${k === 'trueAzim_deg' ? ' key' : ''}"><span class="rv-l">${escHtml(l)}</span><span class="rv-v">${fv(rv[k])}</span><span class="rv-u">${u === '-' ? '' : escHtml(u)}</span></div>`).join('');
  box.innerHTML = (cfg.thrustKind === 'assumed' ? `<div class="w warn">⚠ ${ASSUMED_MSG}</div>` : '')
    + warns.map(w => `<div class="w warn">⚠ ${escHtml(w)}</div>`).join('')
    + `<div class="kv rv-az"><span>打上げ方位（入力） <b>${cfg.azim}°（${ref(cfg.azimRef)}基準）</b></span><span>磁気偏角 <b>${cfg.magDecl}°</b></span>`
    + `<span>真方位 <b>${f1(ta)}°</b></span><span>風向（真北基準） <b>${f1(windTrue)}°</b></span></div>`
    + `<div class="rv-grid">${rows}</div>`
    + `<p class="muted small">位置は機体後端からの mm（「先端から」の行は参考）。Fst = (重心 − 圧力中心)/全長 × 100（後端基準）。該当しない項目は「—」。</p>`;
}

// ---- 飛行軌跡 ----
const PH_COL = { pow: '#ff9b3d', coast: '#e8eef9', c1: '#4fc3f7', c2: '#7ee787', pay: '#c58bff' };
// 区間の判定。ph 2 は 2段目の展開時刻以降なら c2（2段目の条件が先に成立したときは 1段目と同時展開なので c1 区間は無い）
function phKey(r) {
  const d2 = sim?.ev?.deploy2;
  if (r.ph === 2) return d2 && r.t >= d2.t - 1e-9 ? 'c2' : 'c1';
  return r.t < (model?.tb ?? 0) ? 'pow' : 'coast';
}
// ---- 再生（時刻ベース）: playT が主で、playIdx は本体の記録 rec の「t ≤ playT の最後の添字」。
// 再生範囲は flightEnd_t_s まで（本体の着地後は本体を着地点に止め、ペイロードだけ動かす）
function playEnd() {
  const rec = sim?.rec || [], tl = rec.length ? rec[rec.length - 1].t : 0, fe = fsNow?.flightEnd_t_s;
  return Number.isFinite(fe) ? Math.max(fe, tl) : tl;
}
function idxAt(t) {
  const rec = sim?.rec || []; let lo = 0, hi = rec.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rec[m].t <= t + 1e-9) lo = m; else hi = m - 1; }
  return lo;
}
function seekT(t) { playT = Math.min(Math.max(+t || 0, 0), playEnd()); playIdx = idxAt(playT); }
// ペイロードの位置（sim.payload.rec を t で線形補間）。放出前は null、記録の終わり以降は最後の点（着地点）
function payAt(t) {
  const P = sim?.payload, pr = P?.rec;
  if (!pr || !pr.length || !(t >= pr[0].t)) return null;
  const last = pr[pr.length - 1];
  if (t >= last.t) return { ...last, landed: !!P.landing };
  let lo = 0, hi = pr.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pr[m].t <= t) lo = m; else hi = m; }
  const a = pr[lo], b = pr[hi], f = (t - a.t) / Math.max(b.t - a.t, 1e-9), L = k => a[k] + (b[k] - a[k]) * f;
  return { t, x: L('x'), y: L('y'), z: L('z'), V: L('V'), landed: false };
}
function drawFlight() {
  drawSide(); drawTop(); updateHud();
  const sc = $('#scrub'); sc.step = 0.01; sc.max = +playEnd().toFixed(2); sc.value = playT;
}
function trail(ctx, rec, X, Y, fx, fy, upto) {
  let prevKey = null; ctx.lineWidth = 2;
  for (let i = 1; i <= upto && i < rec.length; i++) {
    const k = phKey(rec[i]);
    if (k !== prevKey) { if (prevKey) ctx.stroke(); ctx.strokeStyle = PH_COL[k]; ctx.beginPath(); ctx.moveTo(X(fx(rec[i - 1])), Y(fy(rec[i - 1]))); prevKey = k; }
    ctx.lineTo(X(fx(rec[i])), Y(fy(rec[i])));
  }
  if (prevKey) ctx.stroke();
}
// ペイロードの軌跡（破線）。tUpto までを描き、最後は補間点までつなぐ
function payTrail(ctx, X, Y, fx, fy, tUpto) {
  const pr = sim.payload?.rec; if (!pr || pr.length < 2 || !(tUpto >= pr[0].t)) return;
  ctx.strokeStyle = PH_COL.pay; ctx.lineWidth = 1.8; ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(X(fx(pr[0])), Y(fy(pr[0])));
  for (let i = 1; i < pr.length && pr[i].t <= tUpto; i++) ctx.lineTo(X(fx(pr[i])), Y(fy(pr[i])));
  const p = payAt(tUpto); if (p) ctx.lineTo(X(fx(p)), Y(fy(p)));
  ctx.stroke(); ctx.setLineDash([]);
}
// 着地点の × 印
function xMark(ctx, px, py, col, label, above) {
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px - 6, py - 6); ctx.lineTo(px + 6, py + 6); ctx.moveTo(px + 6, py - 6); ctx.lineTo(px - 6, py + 6); ctx.stroke();
  if (!label) return;
  // 右端からはみ出すときは × の左に書く
  ctx.fillStyle = col; ctx.font = '11px system-ui';
  const W = ctx.canvas.width / (window.devicePixelRatio || 1), left = px + 8 + ctx.measureText(label).width > W - 14;
  ctx.textAlign = left ? 'right' : 'left'; ctx.fillText(label, left ? px - 8 : px + 8, above ? py - 9 : py + 4);
}
function drawSide() {
  const cv = $('#cvSide'), { ctx, w, h } = prep(cv), rec = sim.rec;
  if (!rec.length || !model) return;
  const sa = Math.sin(model.azim), ca = Math.cos(model.azim);
  const dr = r => r.x * sa + r.y * ca;
  const pr = sim.payload?.rec || [], PL = sim.payload?.landing;
  let x0 = 0, x1 = 0, z0 = 0, z1 = 1;
  for (const r of rec.concat(pr)) { const d = dr(r); x0 = Math.min(x0, d); x1 = Math.max(x1, d); z0 = Math.min(z0, r.z); z1 = Math.max(z1, r.z); }
  const xr = nice(x0, x1, 6), yr = nice(z0, z1 * 1.05, 5);
  const F = frame(ctx, w, h, xr, yr, { xlabel: '打上げ方位方向の距離 [m]', title: '' });
  ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'left'; ctx.fillText('高度 [m]', 4, 14);
  ctx.save(); ctx.beginPath(); ctx.rect(F.pl, F.pt - 10, w - F.pl - F.pr, h - F.pt - F.pb + 10); ctx.clip();
  ctx.globalAlpha = 0.25; trail(ctx, rec, F.X, F.Y, dr, r => r.z, rec.length - 1); payTrail(ctx, F.X, F.Y, dr, r => r.z, Infinity); ctx.globalAlpha = 1;
  trail(ctx, rec, F.X, F.Y, dr, r => r.z, playIdx);
  payTrail(ctx, F.X, F.Y, dr, r => r.z, playT);
  const ev = sim.ev;
  const evDot = (t, label, col, below) => {
    if (t == null) return; const r = rec.find(q => q.t >= t) || rec[rec.length - 1];
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(F.X(dr(r)), F.Y(r.z), 3.5, 0, 7); ctx.fill();
    ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.fillText(label, F.X(dr(r)) + 6, F.Y(r.z) + (below ? 14 : -4));
  };
  evDot(ev.burnout?.t, '燃焼終了', PH_COL.pow);
  evDot(ev.apogee?.t, `頂点 ${f0(ev.apogee?.z)} m`, '#fff');
  if (ev.deploy1 && !ev.deploy2?.beforeDeploy1) evDot(ev.deploy1.t, '1段目開傘', PH_COL.c1, true);
  if (ev.deploy2) evDot(ev.deploy2.t, ev.deploy2.beforeDeploy1 ? '1・2段目 同時開傘' : '2段目開傘', PH_COL.c2);
  if (ev.payload) evDot(ev.payload.t, 'ペイロード放出', PH_COL.pay, true);
  // 着地点（本体は軌跡の終点、ペイロードは × 印）
  if (PL) xMark(ctx, F.X(dr(PL)), F.Y(pr.length ? pr[pr.length - 1].z : 0), PH_COL.pay, 'ペイロード着地', true);
  // ペイロードの現在位置
  const pn = payAt(playT);
  if (pn) { ctx.fillStyle = PH_COL.pay; ctx.beginPath(); ctx.arc(F.X(dr(pn)), F.Y(pn.z), 4, 0, 7); ctx.fill(); }
  // 現在位置（本体）
  const r = rec[Math.max(0, playIdx)];
  const px = F.X(dr(r)), py = F.Y(r.z);
  if (r.ph === 2) {
    ctx.strokeStyle = PH_COL[phKey(r)]; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px, py - 14, 9, Math.PI, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px - 9, py - 14); ctx.lineTo(px, py); ctx.lineTo(px + 9, py - 14); ctx.stroke();
  } else {
    const sx = (F.X(1) - F.X(0)), sy = (F.Y(0) - F.Y(1));
    let dx = (r.ux * sa + r.uy * ca) * sx, dy = -r.uz * sy; const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(px - dx * 10, py - dy * 10); ctx.lineTo(px + dx * 10, py + dy * 10); ctx.stroke();
    if (r.T > 0) { ctx.strokeStyle = '#ff9b3d'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(px - dx * 10, py - dy * 10); ctx.lineTo(px - dx * 20, py - dy * 20); ctx.stroke(); }
  }
  ctx.restore();
  legend(ctx, w);
}
function legend(ctx, w) {
  const ev = sim.ev, has2 = !!ev.deploy2, items = [['動力飛行', PH_COL.pow], ['慣性飛行', PH_COL.coast]];
  if (ev.deploy1 && !(has2 && ev.deploy2.beforeDeploy1)) items.push([has2 ? '1段目パラ' : 'パラ降下', PH_COL.c1]);
  if (has2) items.push(['2段目パラ', PH_COL.c2]);
  if (sim.payload) items.push(['ペイロード', PH_COL.pay, '┅ ']);
  ctx.font = '11px system-ui'; ctx.textAlign = 'right'; let x = w - 16, y = 14;
  for (const [l, c, mk = '━ '] of items.reverse()) {
    const s = mk + l, sw = ctx.measureText(s).width;
    if (x - sw < 64 && x < w - 16) { x = w - 16; y += 13; }   // 狭い画面では左上の軸ラベルと重ならないよう折り返す
    ctx.fillStyle = c; ctx.fillText(s, x, y); x -= sw + 10;
  }
}
function equalRanges(w, h, x0, x1, y0, y1, pad) {
  const pw = w - pad.pl - pad.pr, ph = h - pad.pt - pad.pb;
  let sx = (x1 - x0) / pw, sy = (y1 - y0) / ph, s = Math.max(sx, sy);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const xr = { lo: cx - s * pw / 2, hi: cx + s * pw / 2 }, yr = { lo: cy - s * ph / 2, hi: cy + s * ph / 2 };
  const step = niceStep(Math.max(xr.hi - xr.lo, yr.hi - yr.lo), 7);
  xr.step = yr.step = step;
  // グリッド線を step の倍数に合わせる（frame はlo から刻むため lo を丸めて描画用にずらす）
  return { xr, yr };
}
function gridFrame(ctx, w, h, xr, yr, pad, xlabel) {
  const X = v => pad.pl + (v - xr.lo) / (xr.hi - xr.lo) * (w - pad.pl - pad.pr);
  const Y = v => h - pad.pb - (v - yr.lo) / (yr.hi - yr.lo) * (h - pad.pt - pad.pb);
  ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (let v = Math.ceil(xr.lo / xr.step) * xr.step; v <= xr.hi; v += xr.step) {
    ctx.strokeStyle = CHART_CSS.grid; ctx.beginPath(); ctx.moveTo(X(v), pad.pt); ctx.lineTo(X(v), h - pad.pb); ctx.stroke();
    ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'center'; ctx.fillText(fmtN(v), X(v), h - pad.pb + 14);
  }
  for (let v = Math.ceil(yr.lo / yr.step) * yr.step; v <= yr.hi; v += yr.step) {
    ctx.strokeStyle = CHART_CSS.grid; ctx.beginPath(); ctx.moveTo(pad.pl, Y(v)); ctx.lineTo(w - pad.pr, Y(v)); ctx.stroke();
    ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'right'; ctx.fillText(fmtN(v), pad.pl - 5, Y(v) + 4);
  }
  ctx.strokeStyle = CHART_CSS.axis; ctx.strokeRect(pad.pl, pad.pt, w - pad.pl - pad.pr, h - pad.pt - pad.pb);
  ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'right'; ctx.fillText(xlabel, w - pad.pr, h - 3);
  return { X, Y };
}
function windArrow(ctx, x, y) {
  const wd = model.wdir, L = 22;
  ctx.strokeStyle = '#4fc3f7'; ctx.fillStyle = '#4fc3f7'; ctx.lineWidth = 2;
  const ex = x + wd[0] * L, ey = y - wd[1] * L, sx = x - wd[0] * L, sy = y + wd[1] * L;
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
  const a = Math.atan2(ey - sy, ex - sx);
  ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 8 * Math.cos(a - .5), ey - 8 * Math.sin(a - .5)); ctx.lineTo(ex - 8 * Math.cos(a + .5), ey - 8 * Math.sin(a + .5)); ctx.fill();
  ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(`風 ${cfg.wind} m/s（高度 ${cfg.windRef} m）`, x, y + 36);
}
function drawTop() {
  const cv = $('#cvTop'), { ctx, w, h } = prep(cv), rec = sim.rec;
  if (!rec.length || !model) return;
  const pr = sim.payload?.rec || [], PL = sim.payload?.landing;
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (const r of rec.concat(pr)) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x); y0 = Math.min(y0, r.y); y1 = Math.max(y1, r.y); }
  const m = Math.max(x1 - x0, y1 - y0, 20) * 0.08;
  const pad = { pl: 50, pr: 12, pt: 20, pb: 30 };
  const { xr, yr } = equalRanges(w, h, x0 - m, x1 + m, y0 - m, y1 + m, pad);
  const F = gridFrame(ctx, w, h, xr, yr, pad, '東 [m] →');
  ctx.fillStyle = CHART_CSS.text; ctx.textAlign = 'left'; ctx.fillText('↑ 北 [m]', 4, 14);
  ctx.save(); ctx.beginPath(); ctx.rect(pad.pl, pad.pt, w - pad.pl - pad.pr, h - pad.pt - pad.pb); ctx.clip();
  ctx.globalAlpha = 0.25; trail(ctx, rec, F.X, F.Y, r => r.x, r => r.y, rec.length - 1); payTrail(ctx, F.X, F.Y, r => r.x, r => r.y, Infinity); ctx.globalAlpha = 1;
  trail(ctx, rec, F.X, F.Y, r => r.x, r => r.y, playIdx);
  payTrail(ctx, F.X, F.Y, r => r.x, r => r.y, playT);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(F.X(0), F.Y(0), 4, 0, 7); ctx.fill();
  ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.fillText('射点', F.X(0) + 6, F.Y(0) - 4);
  const L = sim.ev.landing;
  if (L) xMark(ctx, F.X(L.x), F.Y(L.y), '#ff6b8b', `着地 ${f0(Math.hypot(L.x, L.y))} m`);
  if (PL) xMark(ctx, F.X(PL.x), F.Y(PL.y), PH_COL.pay, `ペイロード ${f0(Math.hypot(PL.x, PL.y))} m`);
  const pn = payAt(playT);
  if (pn) { ctx.fillStyle = PH_COL.pay; ctx.beginPath(); ctx.arc(F.X(pn.x), F.Y(pn.y), 4, 0, 7); ctx.fill(); }
  const r = rec[Math.max(0, playIdx)];
  ctx.fillStyle = '#ffd36b'; ctx.beginPath(); ctx.arc(F.X(r.x), F.Y(r.y), 4, 0, 7); ctx.fill();
  ctx.restore();
  windArrow(ctx, pad.pl + 40, pad.pt + 34);
  legend(ctx, w);
}
const PH_NAME = { pow: '動力飛行', coast: '慣性飛行', c1: '1段目パラ降下', c2: '2段目パラ降下' };
function updateHud() {
  const r = sim.rec[Math.max(0, playIdx)]; if (!r) { $('#hud').textContent = ''; return; }
  const t = Math.max(r.t, playT), last = playIdx >= sim.rec.length - 1, pn = payAt(t);
  const rpm = r.ph === 1 && Number.isFinite(r.p) ? `ロール ${Math.round(r.p * 30 / Math.PI) || 0}rpm  ` : '';   // || 0 で −0 を避ける
  let s = `T+${t.toFixed(2)}s  `;
  if (last && sim.ev.landing && t > r.t + 1e-6) s += `本体 着地済み（${f0(Math.hypot(sim.ev.landing.x, sim.ev.landing.y))}m）`;
  else s += `高度 ${r.z.toFixed(0)}m  速度 ${r.V.toFixed(1)}m/s  Mach ${r.mach.toFixed(2)}  加速度 ${r.g.toFixed(1)}G  ${Number.isFinite(r.alpha) ? '迎角 ' + r.alpha.toFixed(1) + '°  ' : ''}${rpm}[${PH_NAME[phKey(r)]}]`;
  if (pn) s += `  ／ ペイロード ${pn.landed ? '着地済み' : `高度 ${pn.z.toFixed(0)}m  速度 ${pn.V.toFixed(1)}m/s`}`;
  $('#hud').textContent = s;
}
let lastFrame = 0, playT = 0, chartFrame = 0;
// 再生中の 2D・HUD・グラフのカーソル（グラフは 5 fps に間引く）
function drawPlay(ts) {
  drawSide(); drawTop(); updateHud(); $('#scrub').value = playT;
  if ($('#tab-charts').classList.contains('on') && (!ts || ts - chartFrame > 200)) { chartFrame = ts || 0; drawCharts(); }
}
function playLoop(ts) {
  if (!playing) return;
  const dt = lastFrame ? (ts - lastFrame) / 1000 : 0; lastFrame = ts;
  const end = playEnd();
  seekT(playT + dt * +$('#selSpeed').value);
  drawPlay(ts);
  if (playT >= end - 1e-9) { playing = false; $('#btnPlay').textContent = '▶ 再生'; drawPlay(); return; }
  requestAnimationFrame(playLoop);
}

// ---- グラフ ----
const CHARTS = [
  { t: '高度 [m]', s: [['高度', r => r.z, '#7aa2ff']] },
  { t: '速度 [m/s]', s: [['対地速度', r => r.V, '#ff9b3d'], ['鉛直速度', r => r.vz, '#7ee787']] },
  { t: '加速度（加速度計の読み）[G]', s: [['加速度', r => r.g, '#ff6b8b']], asc: true },
  { t: 'マッハ数', s: [['Mach', r => r.mach, '#ffd36b']], asc: true },
  { t: '迎角 [deg]', s: [['迎角', r => r.alpha, '#4fc3f7']], asc: true },
  { t: '動的安定余裕 [cal]', s: [['安定余裕', r => r.ph === 1 ? r.sm : NaN, '#c58bff']], asc: true },
  { t: '動圧 [kPa]', s: [['動圧', r => r.q / 1000, '#ff9b3d']], asc: true },
  { t: 'ロールレート [rpm]', s: [['ロールレート', r => r.ph === 1 ? r.p * 30 / Math.PI : NaN, '#7ee787']], asc: true },
  // 重心位置は posRef に合わせて表示（燃焼による移動とペイロード放出による移動が分かる範囲まで）
  { t: () => `重心位置 [mm, ${cfg.posRef === 'aft' ? '後端' : '先端'}から]`, s: [['重心', r => posDisp(r.cg * 1000), '#7aa2ff']], cg: true },
  { t: '推力曲線 [N]', thrust: true },
];
function drawCharts() {
  const box = $('#charts');
  if (!model) { box.innerHTML = '<p class="muted">計算エラーのためグラフを表示できません。</p>'; return; }
  if (box.children.length !== CHARTS.length || box.firstElementChild.tagName !== 'CANVAS') box.innerHTML = CHARTS.map(() => '<canvas></canvas>').join('');
  const rec = sim.rec, ev = sim.ev, cvs = box.children;
  const evs = [];
  if (ev.burnout) evs.push({ x: ev.burnout.t, label: '燃焼終了', color: '#ff9b3d' });
  if (ev.apogee) evs.push({ x: ev.apogee.t, label: '頂点', color: '#ccc' });
  if (ev.deploy1 && !ev.deploy2?.beforeDeploy1) evs.push({ x: ev.deploy1.t, label: '1段目', color: PH_COL.c1 });
  if (ev.deploy2) evs.push({ x: ev.deploy2.t, label: '2段目', color: PH_COL.c2 });
  if (ev.payload) evs.push({ x: ev.payload.t, label: 'PL放出', color: PH_COL.pay });
  const ascMax = ev.apogee ? ev.apogee.t * 1.05 + 0.5 : null;
  const cgMax = Math.max(model.tEnd ?? model.tb, ev.payload?.t ?? 0) * 1.2 + 1;
  const cur = rec.length ? Math.min(playT, rec[rec.length - 1].t) : null;
  CHARTS.forEach((c, i) => {
    const title = typeof c.t === 'function' ? c.t() : c.t;
    if (c.thrust) {
      lineChart(cvs[i], { title, xlabel: '時間 [s]', series: [{ name: '推力', color: '#ff9b3d', pts: model.pts }], yzero: true });
      return;
    }
    lineChart(cvs[i], {
      title, xlabel: '時間 [s]', events: evs, cursor: cur,
      xmax: c.asc ? ascMax : c.cg ? cgMax : null, yzero: !c.cg,
      series: c.s.map(([name, fn, color]) => ({ name, color, pts: rec.map(r => [r.t, fn(r)]) })),
    });
  });
}

// ---- パラメータ掃引 ----
let swData = null;
function buildSweep() {
  const sel = $('#swKey');
  sel.innerHTML = NUM_FIELDS.map(f => `<option value="${f.k}">${f.l}${f.pos ? '（先端から）' : ''}${f.u ? ' [' + f.u + ']' : ''}</option>`).join('');
  sel.value = 'ballast';
  const setRange = () => { const v = cfg[sel.value] ?? 0; const f = NUM_FIELDS.find(f => f.k === sel.value);
    let a = v * 0.5, b = v * 1.5; if (v === 0) { a = 0; b = sel.value === 'ballast' ? 500 : 10; }
    if (f.max != null) b = Math.min(b, f.max); if (f.min != null) a = Math.max(a, f.min);
    $('#swFrom').value = +a.toPrecision(3); $('#swTo').value = +b.toPrecision(3); };
  sel.addEventListener('change', setRange); setRange();
}
async function runSweep() {
  const k = $('#swKey').value, a = +$('#swFrom').value, b = +$('#swTo').value, n = Math.min(200, Math.max(2, +$('#swN').value | 0));
  const rows = [], base = normalizeCfg(cfg);
  for (let i = 0; i < n; i++) {
    const v = a + (b - a) * i / (n - 1);
    const c = { ...base, [k]: v };
    try {
      const M = buildModel(c), s = simulate(M, { seed: 1, record: false });
      const m0 = M.massAt(0), cp = M.cpAt(0);
      rows.push({ v, apo: s.st.apogee, maxV: s.st.maxV, dist: s.ev.landing ? Math.hypot(s.ev.landing.x, s.ev.landing.y) : NaN,
        sm: (cp.xcp - m0.cg) / M.d, rail: s.ev.railExit?.V ?? NaN, land: s.ev.landing?.V ?? NaN, g: s.st.maxG });
    } catch (e) { console.error(e); rows.push({ v, apo: NaN, maxV: NaN, dist: NaN, sm: NaN, rail: NaN, land: NaN, g: NaN }); }
    if (i % 3 === 2) { $('#swProg').textContent = `${i + 1} / ${n}`; await new Promise(r => setTimeout(r)); }
  }
  $('#swProg').textContent = '完了';
  const f = NUM_FIELDS.find(f => f.k === k);
  swData = { rows, label: f.l + (f.pos ? '（先端から）' : '') + (f.u ? ` [${f.u}]` : ''), cur: cfg[k] };
  drawSweep();
}
function drawSweep() {
  if (!swData) return;
  const defs = [['頂点高度 [m]', 'apo', '#7aa2ff'], ['最大速度 [m/s]', 'maxV', '#ff9b3d'], ['落下距離 [m]', 'dist', '#ff6b8b'],
    ['静安定余裕 [cal]', 'sm', '#c58bff'], ['ランチクリア速度 [m/s]', 'rail', '#7ee787'], ['着地速度 [m/s]', 'land', '#4fc3f7']];
  const box = $('#swCharts');
  if (box.children.length !== defs.length) box.innerHTML = defs.map(() => '<canvas></canvas>').join('');
  defs.forEach(([t, key, col], i) => lineChart(box.children[i], {
    title: t, xlabel: swData.label, points: true, cursor: swData.cur,
    series: [{ name: t, color: col, pts: swData.rows.map(r => [r.v, r[key]]) }],
  }));
}

// ---------------- 諸元表（specsheet.js 連携） ----------------
// 読込・Debug の結果パネル（読み込んだ項目 / 補った項目 / 警告）。閉じられる
function showImportPanel(title, r = {}) {
  const el = $('#importPanel');
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const val = v => v == null || v === '' ? '—' : typeof v === 'number' ? (Number.isFinite(v) ? +v.toPrecision(6) + '' : '—')
    : typeof v === 'boolean' ? (v ? 'はい' : 'いいえ') : String(v).length > 40 ? String(v).slice(0, 36).replace(/\s+/g, ' ') + '…' : String(v);
  const tbl = (head, rows) => rows.length
    ? `<div class="imp-wrap"><table class="imp-tbl"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
      rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<p class="muted small">なし</p>';
  const imp = r.imported || [], sup = r.supplemented || [], warns = (r.warnings || []).filter(Boolean);
  let body;
  if (r.error) body = `<div class="w bad">⛔ ${esc(r.error)}</div>`;
  else body = (cfg.thrustKind === 'assumed' ? `<div class="w warn banner">⚠ ${ASSUMED_MSG}</div>` : '') + `
    <details class="imp-sec" ${warns.length ? 'open' : ''}><summary>警告（${warns.length}）</summary>${
      warns.length ? warns.map(w => `<div class="w warn">⚠ ${esc(w)}</div>`).join('') : '<p class="muted small">なし</p>'}</details>
    <details class="imp-sec" open><summary>諸元表に無いため補った項目（${sup.length}）</summary>${
      tbl(['項目', '値', '単位', '理由'], sup.map(s => [s.label ?? s.key, val(s.value), s.unit ?? '', s.reason ?? '']))}</details>
    <details class="imp-sec"><summary>読み込んだ項目（${imp.length}）</summary>${
      tbl(['諸元表の項目', '諸元表の値', 'シミュレータの項目', '値'], imp.map(s => [
        s.sheetLabel ?? '—', s.sheetValue == null ? '—' : `${val(s.sheetValue)} ${s.sheetUnit ?? ''}`,
        s.label ?? s.key, `${val(s.value)} ${s.unit ?? ''}`]))}</details>`;
  el.innerHTML = `<div class="imp-h"><b>${esc(title)}</b><button type="button" class="imp-close" title="閉じる">✕</button></div>${body}`;
  el.classList.remove('hide');
  el.querySelector('.imp-close').addEventListener('click', () => el.classList.add('hide'));
  el.scrollIntoView?.({ block: 'nearest' });
}
function initSpecButtons() {
  if (!window.SpecSheet) {
    $('#fileSpec').disabled = true; $('#btnSpecExport').disabled = true; $('#btnDebug').disabled = true;
    $$('.spec-btn').forEach(e => { e.title = 'specsheet.js を読み込めませんでした'; e.classList.add('disabled'); });
    return;
  }
  $('#fileSpec').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      const r = await window.SpecSheet.importFile(file, cfg);
      applyCfg({ ...cfg, ...r.patch });
      showImportPanel(`諸元表を読み込みました: ${file.name}`, r);
    } catch (err) { console.error(err); showImportPanel(`諸元表の読込に失敗しました: ${file.name}`, { error: err?.message || String(err) }); }
  });
  $('#btnDebug').addEventListener('click', () => {
    if (!confirm('Debug 機体の諸元を読み込みます（現在の設定は置き換わります）。よろしいですか？')) return;
    const S = window.SpecSheet;
    applyCfg({ ...DEFAULTS, ...S.DEBUG_PRESET });   // 現在の cfg は混ぜない（spec §6）
    const sup = S.DEBUG_SUPPLEMENTS || [], supK = new Set(sup.map(s => s.key));
    const imported = Object.entries(S.DEBUG_PRESET).filter(([k]) => !supK.has(k)).map(([k, v]) => {
      const f = FIELDS.find(f => f.k === k);
      return { key: k, label: f?.l ?? k, value: k === 'engText' ? `推力表 ${String(v).trim().split('\n').length} 行` : v, unit: f?.pos ? 'mm(先端)' : f?.u ?? '' };
    });
    const dc = declCheck(cfg.lat, cfg.lon, declNow());
    showImportPanel('Debug 諸元を読み込みました', { imported, supplemented: sup, warnings: dc ? [dc] : [] });
  });
  $('#btnSpecExport').addEventListener('click', async () => {
    if (runTimer) runNominal();                   // 未反映の変更があれば先に計算する
    if (!model) { alert('計算エラーのため書き出せません。入力を確認してください。'); return; }
    const b = $('#btnSpecExport'), t = b.textContent; b.disabled = true; b.textContent = '書出し中…';
    try { await window.SpecSheet.exportXlsx(cfg, model, sim); }
    catch (err) { console.error(err); alert('諸元表の書出しに失敗しました: ' + (err?.message || err)); }
    finally { b.disabled = false; b.textContent = t; }
  });
}

// ---------------- 地形（terrain.js 連携） ----------------
function initTerrain() {
  const el = $('#terrainInfo'); if (!el) return;
  if (!window.Terrain) { el.textContent = 'terrain.js を読み込めませんでした（地形は使えません）'; return; }
  el.innerHTML = '地形: 国土地理院の標高タイル（日本国内のみ）を射点のまわりで取得します。<br>半径 <input type="number" id="trR" value="3000" min="200" max="20000" step="500" style="width:90px"> m <button type="button" id="trGo">地形を取得</button> <span id="trSt"></span>';
  $('#trGo').addEventListener('click', async () => {
    const st = $('#trSt'), b = $('#trGo'); b.disabled = true;
    try {
      const r = await window.Terrain.prefetch(cfg.lat, cfg.lon, Math.max(200, +$('#trR').value || 3000), (d, n) => { st.textContent = `取得中 ${d}/${n}`; });
      st.textContent = `${r.ok}/${r.tiles} 枚取得。射点の標高 ${r.center == null ? '—（データ無し）' : r.center.toFixed(1) + ' m'}`;
      if (cfg.landSurface === 'terrain') applyCfg({ ...cfg }, { rewrite: false });
    } catch (e) { st.textContent = '失敗: ' + e.message; }
    b.disabled = false;
  });
}

// ---------------- 起動 ----------------
function init() {
  buildPanel(); writeFields(); buildSweep();
  // Magi から移植したタブ（解析・EKF・検算・設計）。読めなければその旨を出す
  const mountTab = (mod, fn, sel, name) => {
    const el = $(sel); if (!el) return;
    if (!window[mod]) { el.innerHTML = `<div class="card"><p class="muted">${name}を読み込めませんでした。</p></div>`; return; }
    try { window[mod][fn](el); } catch (e) { console.error(e); el.innerHTML = `<div class="card"><p class="muted">${name}の初期化に失敗しました: ${e.message}</p></div>`; }
  };
  mountTab('Analysis', 'mountMc', '#tab-mc', 'analysis.js（モンテカルロ・ラプラス近似）');
  mountTab('Analysis', 'mountEkf', '#tab-ekf', 'analysis.js（EKF）');
  mountTab('Verify', 'mount', '#tab-verify', 'verify.js（検算）');
  mountTab('Design', 'mount', '#tab-design', 'design.js（設計ツール）');
  initTerrain();
  if (window.Dispersion) {
    try { window.Dispersion.mount($('#dispersion')); }
    catch (e) { console.error(e); $('#dispersion').innerHTML = `<p class="muted">落下分散の初期化に失敗しました: ${e.message}</p>`; }
  } else $('#dispersion').innerHTML = '<p class="muted">dispersion.js を読み込めませんでした（落下分散は使えません）。</p>';
  initSpecButtons();
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
    $('#playerCard').classList.toggle('hide', ['mc', 'sweep', 'disp', 'ekf', 'verify', 'design'].includes(b.dataset.tab));
    window.V3D?.setVisible(b.dataset.tab === '3d');
    window.Dispersion?.setVisible(b.dataset.tab === 'disp');
    redrawVisible();
  }));
  $('#btnPlay').addEventListener('click', () => {
    if (playing) { playing = false; $('#btnPlay').textContent = '▶ 再生'; return; }
    if (!sim.rec.length) return;
    if (playT >= playEnd() - 1e-6) seekT(0);
    lastFrame = 0; playing = true; $('#btnPlay').textContent = '⏸ 停止';
    requestAnimationFrame(playLoop);
  });
  $('#scrub').addEventListener('input', e => { seekT(+e.target.value); drawPlay(); });
  $('#btnKml').addEventListener('click', () => {
    if (!model || !sim || !sim.rec.length || !window.Analysis) return;
    download(`${String(cfg.name || 'rocket').replace(/[\\/:*?"<>|]/g, '_')}_flight.kml`, window.Analysis.flightKml(model, sim), 'application/vnd.google-earth.kml+xml');
  });
  $('#btnSweep').addEventListener('click', runSweep);
  $('#btnReset').addEventListener('click', () => { if (!confirm('設定を初期値に戻しますか？')) return; applyCfg({ ...DEFAULTS }); });
  $('#btnExport').addEventListener('click', () => download(`${String(cfg.name || 'rocket').replace(/[\\/:*?"<>|]/g, '_')}-config.json`, cfgJson(cfg, 2), 'application/json'));
  $('#fileImport').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('設定 JSON ではありません');
      applyCfg(raw);
    } catch (err) { alert('読み込みに失敗しました: ' + err.message); }
    e.target.value = '';
  });
  $('#btnCsv').addEventListener('click', () => {
    const keys = ['t', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'V', 'va', 'mach', 'g', 'alpha', 'q', 'T', 'm', 'cg', 'sm', 'fst', 'roll', 'p', 'ph'];
    const csv = [keys.join(','), ...sim.rec.map(r => keys.map(k => Number.isFinite(r[k]) ? +r[k].toFixed(5) : '').join(','))].join('\n');
    download('flight.csv', csv, 'text/csv');
  });
  let rt = 0; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redrawVisible, 100); });
  runNominal();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
function redrawVisible() {
  if (!sim) return;
  drawRocket(); drawFlight();
  if ($('#tab-charts').classList.contains('on')) drawCharts();
  window.Analysis?.redraw();
  if ($('#tab-sweep').classList.contains('on')) drawSweep();
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
init();
