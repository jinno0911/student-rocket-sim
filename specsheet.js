'use strict';
/* 学生ロケット シミュレーター — 諸元表（団体入力シート .xlsx）の読込・書出しと Debug プリセット
 * 契約: docs/spec-v2.md §4。トップレベルの名前は window.SpecSheet だけ（§0.3）。
 * 読込時には DOM 操作も他モジュールの呼出しもしない（§0.2）。physics / app のグローバルは使う時点で typeof 付きで参照する。
 * cfg の位置は先端基準 mm、諸元表は後端基準（x_nose = L − x_aft）。質量は cfg が g、諸元表が kg。
 */
window.SpecSheet = (() => {
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const XLSX_SRI = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';   // npm xlsx@0.18.5 の同ファイル（§0.4）
  const SHEET_IN = '団体入力シート', SHEET_EXTRA = 'シミュレータ追加諸元', SHEET_THRUST = '推力履歴';
  const ISP = 170, g0 = 9.80665;   // 仮定推力の比推力 [s] / 標準重力（physics の G0 と同じ値）
  const ASSUMED_NOTE = '推力履歴は仮定（Isp 170 s）。審査提出には地上燃焼試験の推力履歴を使用すること';
  const jpErr = m => Object.assign(new Error(m), { jp: true });

  // ---------------- SheetJS の遅延読込（§0.4。使う時点で 1 回だけ） ----------------
  let xlsxP = null;
  function loadXLSX() {
    if (window.XLSX?.read) return Promise.resolve(window.XLSX);
    return xlsxP || (xlsxP = new Promise((res, rej) => {
      const s = document.createElement('script');
      const fail = () => { xlsxP = null; s.remove(); rej(jpErr('SheetJS（xlsx ライブラリ）を読み込めませんでした。ネットワーク接続を確認してください')); };
      s.src = XLSX_URL; s.integrity = XLSX_SRI; s.crossOrigin = 'anonymous'; s.async = true;
      s.onload = () => window.XLSX?.read ? res(window.XLSX) : fail();
      s.onerror = fail;
      document.head.appendChild(s);
    }));
  }

  // ---------------- 項目対応表 ----------------
  // item: 列B の見出し, subItem: 列C のラベル, key: cfg キー, unit: 諸元表の既定単位,
  // conv: 'aft'（後端基準→先端基準）| 'kg'（kg→g）| 'invN'（べき指数 n→α=1/n）| null
  // 全長は key 'bodyLen'（bodyLen = 全長 − noseLen − tailLen）。機体名は B「機体名」行の D 列。
  const F = (item, subItem, key, unit, conv = null) => ({ item, subItem, key, unit, conv });
  const fieldMap = [
    F('機体名', '', 'name', '-'),
    F('射点座標', '緯度', 'lat', 'deg'),
    F('射点座標', '経度', 'lon', 'deg'),
    F('射点座標', '海面高度', 'siteAlt', 'm'),
    F('射点座標', '磁気偏角', 'magDecl', 'deg'),
    F('ランチャ', '打上方位角', 'azim', 'deg'),
    F('ランチャ', '打上射角', 'elev', 'deg'),
    F('ランチャ', 'レール長さ', 'railLen', 'm'),
    F('風', 'べき指数', 'windExp', '-', 'invN'),
    F('風', '基準高さ', 'windRef', 'm'),
    F('機体形状', '代表直径', 'd', 'mm'),
    F('機体形状', '全長', 'bodyLen', 'mm'),
    F('質量', '乾燥質量', 'hDryMass', 'kg', 'kg'),
    F('質量', '酸化剤質量', 'hOxMass', 'kg', 'kg'),
    F('質量', '燃焼前燃料質量', 'hFuelPre', 'kg', 'kg'),
    F('質量', '燃焼後燃料質量', 'hFuelPost', 'kg', 'kg'),
    F('重心', '乾燥時重心位置', 'hDryCG', 'mm', 'aft'),
    F('重心', '初期酸化剤重心位置', 'hOxCG', 'mm', 'aft'),
    F('重心', 'タンク口金位置', 'hTankOutlet', 'mm', 'aft'),
    F('重心', '燃料重心位置', 'hFuelCG', 'mm', 'aft'),
    F('慣性モーメント', 'ヨー・ピッチ', 'Ipitch', 'kg・m2'),
    F('慣性モーメント', 'ロール', 'Iroll', 'kg・m2'),
    F('空力', '圧力中心位置', 'cpManual', 'mm', 'aft'),
    F('空力', '軸力係数', 'cdManual', '-'),
    F('空力', '法線力傾斜', 'cnaManual', '1/rad'),
    F('空力', '減衰モーメント係数（ロール）', 'clp', '-'),
    F('空力', '減衰モーメント係数（ピッチ・ヨー）', 'cmq', '-'),
    F('燃焼', 'ノズル出口直径', 'nozzleExitD', 'mm'),
    F('燃焼', '燃焼時間', 'hBurnTime', 's'),
    F('リカバリ（1段階目）', '降下終端速度', 'c1Vt', 'm/s'),
    F('リカバリ（2段階目）', '開傘時刻', 'rec2Time', 's'),
    F('リカバリ（2段階目）', '降下終端速度', 'c2Vt', 'm/s'),
    F('ペイロード（減速有り）', '放出時刻', 'payloadTime', 's'),
    F('ペイロード（減速有り）', '降下終端速度', 'payloadVt', 'm/s'),
    F('ペイロード（減速有り）', 'ペイロード質量', 'payloadMass', 'kg', 'kg'),
    F('空力形状', 'ノーズ形状', 'noseShape', '-'),
    F('空力形状', 'ノーズ長さ', 'noseLen', 'mm'),
    F('空力形状', 'フィンオフセット長さ', 'finAft', 'mm'),
    F('空力形状', '翼根コード長', 'finCr', 'mm'),
    F('空力形状', '翼端コード長', 'finCt', 'mm'),
    F('空力形状', '翼前縁部後退長さ', 'finSweep', 'mm'),
    F('空力形状', '半スパン', 'finSpan', 'mm'),
    F('分野別確認項目', '作動時間', 'hOpTime', 's'),
  ];
  const FM = Object.fromEntries(fieldMap.map(f => [f.key, f]));
  // ラベルの表記ゆれ（旧様式・手入力）
  const ALIAS = { 'ヨー・ピッチ': ['ピッチ・ヨー'], '減衰モーメント係数（ピッチ・ヨー）': ['減衰モーメント係数（ヨー・ピッチ）'], '打上射角': ['射角'], '打上方位角': ['ランチャ方位角'], '海面高度': ['射点高度'] };
  // 必須項目（行が無ければ reject、空欄なら baseCfg の値を残して warning）
  const REQUIRED = ['d', 'bodyLen', 'hDryMass', 'hDryCG', 'hBurnTime', 'noseLen', 'finCr', 'finCt', 'finSweep', 'finSpan'];

  // cfg 側の表示名と単位（panel 表示用。app の FIELDS より安定した名前を使う）
  const LABEL = {
    name: '機体名', lat: '射点緯度', lon: '射点経度', siteAlt: '射点標高（海面高度）', magDecl: '磁気偏角（東偏+）',
    azim: '打上げ方位（磁北基準）', azimRef: '方位の基準', elev: '射角', railLen: 'ランチャー長', windExp: 'べき指数 α（=1/n）', windRef: '風速の基準高さ',
    d: '胴体外径（代表直径）', bodyLen: '胴体長（ノーズ除く）', tailLen: 'ボートテール長', noseLen: 'ノーズ長', noseShape: 'ノーズ形状',
    hDryMass: '乾燥質量', hOxMass: '酸化剤質量', hFuelPre: '燃焼前燃料質量', hFuelPost: '燃焼後燃料質量',
    hDryCG: '乾燥時重心（先端から）', hOxCG: '酸化剤重心（先端から）', hTankOutlet: 'タンク口金位置（先端から）', hFuelCG: '燃料重心（先端から）', hOxDrain: '酸化剤重心を口金へ移動',
    Ipitch: 'ピッチ・ヨー慣性モーメント', Iroll: 'ロール慣性モーメント', inertiaMode: '慣性モーメントの指定',
    cpManual: '圧力中心（先端から）', cdManual: '軸力係数 Cd', cnaManual: '法線力傾斜 CNα', clp: 'ロール減衰モーメント係数 Clp', cmq: 'ピッチ・ヨー減衰モーメント係数 Cmq',
    aeroMode: '空力係数の指定', cdMode: '抗力係数 Cd の指定', aeroTable: '空力テーブル',
    nozzleExitD: 'ノズル出口直径', hBurnTime: '燃焼時間', hOpTime: '作動時間',
    rec1: '1段目の開傘条件', c1Vt: '1段目 降下終端速度', rec2: '2段目の開傘条件', rec2Time: '2段目 開傘時刻（点火から）', c2Vt: '2段目 降下終端速度', chuteSpec: 'パラシュートの指定',
    payloadOn: 'ペイロード放出', payloadTime: 'ペイロード放出時刻（点火から）', payloadVt: 'ペイロード降下終端速度', payloadMass: 'ペイロード質量', payloadPos: 'ペイロード重心（先端から）',
    finAft: '翼根後縁〜機体後端', finCr: '翼根コード', finCt: '翼端コード', finSweep: '前縁後退長', finSpan: 'スパン（高さ）', finN: 'フィン枚数', finThick: 'フィン厚さ', finCant: 'フィン取付角',
    engText: '推力履歴', thrustKind: '推力履歴の種別', motorSrc: '推力データ', motorPreset: 'モータープリセット', thrustScale: '推力倍率',
    openTime: '展開所要時間', windDirRef: '風向の基準', wind: '風速（基準高さ）', windFrom: '風向（吹いてくる方位）', gust: '乱流（突風）強度', temp: '地上気温',
    lugAft: '後端〜最後尾ランチラグ', landSurface: '着地面', mLen: 'モーター長（描画用）', mDia: 'モーター径（描画用）', mOver: 'モーター突出（描画用）',
    massMode: '質量モデル', ballast: 'バラスト質量', posRef: '位置の表示基準',
    airMass: '機体質量（モーター除く）', airCG: '機体重心（先端から）', ballastPos: 'バラスト位置（先端から）', tailD: 'テール後端径',
    mI: '全力積（パラメトリック）', mTb: '燃焼時間（パラメトリック）', mShape: '推力形状（パラメトリック）', mProp: '推進剤質量', mTotal: 'モーター全質量',
    rec1Time: '1段目タイマー', rec1Delay: '頂点検知の遅れ', rec1Backup: '1段目の冗長タイマー（点火から）', c1D: '1段目パラシュート直径', c1Cd: '1段目パラシュート Cd',
    c2D: '2段目パラシュート直径', c2Cd: '2段目パラシュート Cd', mainAlt: '2段目の開傘高度', dtApoWarn: '頂点からのずれの警告しきい値',
    cdScale: '抗力係数の倍率', machCorr: '圧縮性補正', dt: '計算刻み',
  };
  const UNIT_EXTRA = { finN: '枚', finThick: 'mm', finCant: 'deg', openTime: 's', wind: 'm/s', windFrom: 'deg', gust: 'm/s', temp: '℃', lugAft: 'mm', mLen: 'mm', mDia: 'mm', mOver: 'mm', payloadPos: 'mm', ballast: 'g', tailLen: 'mm', thrustScale: '%' };
  const label = k => LABEL[k] ?? (typeof FIELDS !== 'undefined' ? FIELDS.find?.(f => f.k === k)?.l : null) ?? k;
  const cfgUnit = k => { const f = FM[k]; if (!f) return UNIT_EXTRA[k] ?? ''; return f.conv === 'kg' ? 'g' : f.unit === 'kg・m2' ? 'kg·m²' : f.unit; };

  // ---------------- 値・単位の正規化 ----------------
  const nu = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const nl = s => nu(s).replace(/[()]/g, '');   // ラベル比較用（全角括弧は NFKC で半角になる）
  const str = v => v == null ? '' : String(v).trim();
  const clean = v => +(+v).toPrecision(12);      // 換算で出る 1008.5200000000001 のような端数を落とす
  // 数値セル: number はそのまま、文字列は NFKC（全角数字・全角記号）後に厳密に数値化。それ以外と空欄は null（＝空欄）
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    let s = v.normalize('NFKC').replace(/\s+/g, '').replace(/^[−‐‑‒–—―ー]/, '-');
    if (/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
    const x = +s;
    return isFinite(x) ? x : null;
  }
  // 既定単位ごとの既知の別単位（値 × 係数 = 既定単位の値）
  const UNITS = {
    'mm': { mm: 1, m: 1000, cm: 10 },
    'm': { m: 1, mm: 1e-3, cm: 1e-2, km: 1000 },
    'kg': { kg: 1, g: 1e-3 },
    'deg': { deg: 1, '°': 1, '度': 1, rad: 180 / Math.PI },
    's': { s: 1, sec: 1, '秒': 1, ms: 1e-3 },
    'm/s': { 'm/s': 1, mps: 1, 'km/h': 1 / 3.6 },
    'kg・m2': { kgm2: 1, gm2: 1e-3, kgcm2: 1e-4, gcm2: 1e-7, kgmm2: 1e-6 },
    '1/rad': { '1/rad': 1, '/rad': 1, 'rad-1': 1, '1/deg': 180 / Math.PI },
    '-': { '-': 1 },
  };
  function unitOf(f, raw) {
    const text = str(raw);
    if (!text) return { factor: 1, text: f.unit };
    let k = nu(text);
    if (f.unit === 'kg・m2') k = k.replace(/[・·･*.\-^]/g, '');
    if (f.unit === '1/rad') k = k.replace('^', '');
    if (f.unit === '-') k = k.replace(/^[−‐‑‒–—―ー]$/, '-');
    const tbl = UNITS[f.unit] || {};
    if (k in tbl) return { factor: tbl[k], text };
    if (k === nu(f.unit)) return { factor: 1, text };
    return { factor: 1, text, unknown: true };
  }

  // SheetJS のセル値（エラーセルは空欄扱い）
  function cellV(X, ws, r, c) {
    const x = ws[X.utils.encode_cell({ r, c })];
    if (!x || x.t === 'e' || x.t === 'z') return null;
    return x.v ?? null;
  }
  const findSheet = (wb, name) => wb.SheetNames.find(n => n === name) ?? wb.SheetNames.find(n => nu(n) === nu(name));

  // 団体入力シートを走査: 列B の見出し（セクション）を引き継ぎながら、列C のラベルごとに D 値・E 単位を集める
  function scanInput(X, ws) {
    const rg = X.utils.decode_range(ws['!ref'] || 'A1:A1');
    const rows = []; let sec = '', nameRow = null;
    for (let r = rg.s.r; r <= rg.e.r; r++) {
      const b = str(cellV(X, ws, r, 1)), c = str(cellV(X, ws, r, 2));
      if (b) { sec = b; if (nl(b) === nl('機体名') && !nameRow) nameRow = { v: cellV(X, ws, r, 3) }; }
      if (c) rows.push({ r, sec, label: c, v: cellV(X, ws, r, 3), u: cellV(X, ws, r, 4) });
    }
    return { rows, nameRow };
  }
  const SHARED = new Set(fieldMap.filter((f, i, a) => a.findIndex(g => g.subItem === f.subItem) !== i).map(f => f.subItem));
  function findRow(rows, f) {
    const names = [f.subItem, ...(ALIAS[f.subItem] || [])].map(nl);
    const cands = rows.filter(x => names.includes(nl(x.label)));
    // 同名ラベル（降下終端速度など）は、行が 1 つしか無くても直前の列B の見出しで区別する
    if (!SHARED.has(f.subItem) && cands.length <= 1) return cands[0] || null;
    const it = nl(f.item);
    const hit = cands.find(x => { const s = nl(x.sec); return s && (s.startsWith(it) || it.startsWith(s)); });
    return hit || (SHARED.has(f.subItem) ? null : cands[0] || null);
  }

  // ---------------- 仮定推力曲線（§4.1） ----------------
  // 0〜tb: shapeFn('regressive', t/tb) と同じ式（立上り up = min(1, x/0.04) 込み、tb での下がりは使わず定常部の値）
  // tb〜tOp: F_b·(e^{−k(t−tb)} − e^{−k(tOp−tb)})/(1 − e^{−k(tOp−tb)})、k = 4/(tOp − tb)。最終点は (tOp, 0)
  // 総力積 I = (酸化剤 + 燃料消費)[kg]·Isp·g0 に正規化する。読込時に physics を呼ばないよう式は内部に持つ。
  function assumedCurve(oxG, preG, postG, tb, tOp) {
    const I = (oxG + preG - postG) / 1000 * ISP * g0;
    const reg = x => (1.25 - 0.6 * x) * Math.min(1, x / 0.04);
    const raw = [];
    for (let i = 0; i <= 8; i++) raw.push([i / 200 * tb, reg(i / 200)]);          // 立上り 0〜0.04
    for (let j = 2; j <= 25; j++) raw.push([j / 25 * tb, reg(j / 25)]);          // 定常部（x に線形）
    const Fb = reg(1), D = tOp - tb, E = Math.exp(-4), n = 30;
    for (let j = 1; j <= n; j++) {
      const t = j === n ? tOp : tb + D * j / n;
      raw.push([t, j === n ? 0 : Fb * (Math.exp(-4 * j / n) - E) / (1 - E)]);
    }
    let s = 0;
    for (let i = 1; i < raw.length; i++) s += (raw[i][1] + raw[i - 1][1]) / 2 * (raw[i][0] - raw[i - 1][0]);
    const k = s > 0 ? I / s : 0;
    const pts = raw.map(([t, f], i) => [i === raw.length - 1 ? t : +t.toPrecision(10), +(f * k).toPrecision(8)]);
    const engText = pts.map(([t, f]) => `${t} ${f}`).join('\n');   // "t F" 行だけ（.eng ヘッダ・コメント行なし）
    return { I, tb, tOp, pts, engText };
  }

  // 磁気偏角の符号チェック（physics の declCheck が無いときの代わり。文言は §2.2 と同じ）
  const declChk = (lat, lon, md) => typeof declCheck === 'function' ? declCheck(lat, lon, md)
    : (lat >= 24 && lat <= 46 && lon >= 122 && lon <= 154 && (md < -11 || md > -3)) ? `日本の磁気偏角は西偏（本様式では負）。符号を確認してください（現在 ${md}°）` : null;

  // baseCfg を正規化（physics が無い・古い場合も落ちないように）
  const FALLBACK = { name: 'MyRocket', noseLen: 300, bodyLen: 1100, tailLen: 0, finN: 4, finThick: 3, finCant: 0, openTime: 1, windDirRef: 'true', wind: 4, windFrom: 270, gust: 0, temp: 20,
    lugAft: 0, landSurface: 'site', mLen: 600, mDia: 60, mOver: 0, payloadPos: 200, thrustScale: 100, aeroTable: '' };
  function baseOf(c) {
    let b = { ...FALLBACK, ...(typeof PHYS_DEFAULTS !== 'undefined' ? PHYS_DEFAULTS : typeof DEFAULTS !== 'undefined' ? DEFAULTS : {}), ...(c || {}) };
    try { if (typeof normalizeCfg === 'function') b = normalizeCfg(b); } catch (e) {}
    return b;
  }
  const defaultsTable = () => typeof DEFAULTS !== 'undefined' ? DEFAULTS : typeof PHYS_DEFAULTS !== 'undefined' ? PHYS_DEFAULTS : null;
  const NULLABLE = ['cmq', 'clp'];

  // ---------------- 読込（§4.1） ----------------
  async function importFile(src, baseCfg) {
    try { return await importImpl(src, baseCfg); }
    catch (e) { throw e?.jp ? e : jpErr('諸元表の読込に失敗しました（' + (e?.message || e) + '）'); }
  }
  async function importImpl(src, baseCfg) {
    let buf;
    // 別のウィンドウ（iframe 等）で作られた ArrayBuffer は instanceof が効かないので型タグでも判定する
    if (src instanceof ArrayBuffer || Object.prototype.toString.call(src) === '[object ArrayBuffer]') buf = new Uint8Array(src);
    else if (ArrayBuffer.isView(src)) buf = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    else if (src && typeof src.arrayBuffer === 'function') buf = new Uint8Array(await src.arrayBuffer());
    else throw jpErr('ファイルを読み込めませんでした（xlsx ファイルを選んでください）');
    const X = await loadXLSX();
    let wb;
    try { wb = X.read(buf, { type: 'array' }); } catch (e) { throw jpErr('xlsx ファイルとして読み込めませんでした（' + (e?.message || e) + '）'); }
    if (!wb?.SheetNames?.length) throw jpErr('諸元表にシートがありません');
    const sn = findSheet(wb, SHEET_IN) ?? wb.SheetNames[0];
    const { rows, nameRow } = scanInput(X, wb.Sheets[sn]);

    // 行の特定（必須ラベルが無ければ reject）
    const rowOf = {}, missing = [];
    for (const f of fieldMap) if (f.key !== 'name') { rowOf[f.key] = findRow(rows, f); if (!rowOf[f.key] && REQUIRED.includes(f.key)) missing.push(f.subItem); }
    if (missing.length) throw jpErr(`諸元表の必須項目が見つかりません（${missing.join('、')}）。シート「${sn}」が「${SHEET_IN}」の様式か確認してください`);

    const base = baseOf(baseCfg);
    const patch = {}, imported = [], supplemented = [], warnings = [];
    const warn = s => { if (s && !warnings.includes(s)) warnings.push(s); };
    const sup = (key, value, reason, shown = value) => { patch[key] = value; supplemented.push({ key, label: label(key), value: shown, unit: cfgUnit(key), reason }); };

    // 数値の読取り（既定単位へ換算）。S[key] = 既定単位の値 | null（空欄）| undefined（行なし）
    const S = {}, info = {};
    for (const f of fieldMap) {
      if (f.key === 'name' || f.key === 'noseShape') continue;
      const row = rowOf[f.key];
      if (!row) { warn(`諸元表に「${f.subItem}」の行が見つからないため空欄として扱いました`); S[f.key] = undefined; continue; }
      const x = num(row.v);
      if (x == null) { S[f.key] = null; if (str(row.v)) warn(`「${f.subItem}」の値「${str(row.v)}」は数値でないため空欄として扱いました`); continue; }
      const u = unitOf(f, row.u);
      if (u.unknown) warn(`「${f.subItem}」の単位「${u.text}」は不明のため ${f.unit} とみなしました`);
      S[f.key] = x * u.factor;
      info[f.key] = { sheetLabel: f.subItem, sheetValue: x, sheetUnit: u.text };
    }
    const has = k => S[k] != null, pos = k => has(k) && S[k] > 0;
    const put = (k, v, inf = info[k]) => {
      patch[k] = v;
      imported.push({ key: k, label: label(k), value: v, unit: cfgUnit(k), sheetLabel: inf?.sheetLabel ?? FM[k]?.subItem ?? k, sheetValue: inf?.sheetValue ?? null, sheetUnit: inf?.sheetUnit ?? FM[k]?.unit ?? '' });
    };
    const keepBase = k => warn(REQUIRED.includes(k)
      ? `必須項目が空欄:「${FM[k].subItem}」（現在の設定値 ${base[k]} ${cfgUnit(k)} を使用）`
      : `「${FM[k].subItem}」が空欄のため現在の設定値（${base[k]} ${cfgUnit(k)}）を使用`);

    // 換算: kg→g、後端→先端（L − x）。単位換算した値だけ端数を落とす（そのままの値は完全精度で保つ）
    let L = 0;
    const conv = (k, x) => {
      const c = FM[k].conv;
      if (c === 'kg') return clean(x * 1000);
      if (c === 'aft') { if (x < 0 || x > L) warn(`「${FM[k].subItem}」${x} mm が機体の外（全長 ${L} mm）です`); return clean(L - x); }
      return info[k]?.sheetValue === x ? x : clean(x);
    };
    const putS = k => put(k, conv(k, S[k]));

    // 機体名
    const nm = str(nameRow?.v);
    if (nm) put('name', nm, { sheetLabel: '機体名', sheetValue: nm, sheetUnit: '-' });
    else { patch.name = base.name || 'MyRocket'; warn(`機体名が空欄のため現在の名前「${patch.name}」を使用`); }

    // 全長・ノーズ長（tailLen は 0。bodyLen = L − noseLen。全長が空欄なら現在の全長を保つ）
    const noseLen = has('noseLen') ? conv('noseLen', S.noseLen) : +base.noseLen;
    if (has('noseLen')) put('noseLen', noseLen); else keepBase('noseLen');
    const Lbase = clean((+base.noseLen || 0) + (+base.bodyLen || 0) + (+base.tailLen || 0));
    L = has('bodyLen') ? conv('bodyLen', S.bodyLen) : Lbase;
    if (!has('bodyLen')) keepBase('bodyLen');
    if (!(L > noseLen)) { warn(`全長 ${L} mm がノーズ長 ${noseLen} mm 以下のため、全長を現在の設定値 ${Lbase} mm にしました`); L = Lbase; }
    if (has('bodyLen')) put('bodyLen', clean(L - noseLen)); else patch.bodyLen = clean(L - noseLen);
    patch.tailLen = 0;

    // 値があればそのまま入れる項目（空欄時の扱いは下で個別に）
    for (const k of ['lat', 'lon', 'elev', 'railLen', 'windRef', 'd', 'hDryMass', 'hOxMass', 'hFuelPre', 'hFuelPost', 'hDryCG', 'hOxCG', 'hFuelCG',
      'cdManual', 'hBurnTime', 'finCr', 'finCt', 'finSweep', 'finSpan', 'Ipitch', 'Iroll', 'cpManual', 'cnaManual', 'hTankOutlet', 'clp', 'cmq']) if (has(k)) putS(k);

    // 0 にする 3 項目（ノズル出口直径・フィンオフセット・海面高度）
    for (const k of ['nozzleExitD', 'finAft', 'siteAlt']) {
      if (has(k)) putS(k);
      else sup(k, 0, `「${FM[k].subItem}」が空欄のため 0 とした`);
    }
    // 磁気偏角（東偏 +。符号は変えずに declCheck で警告する）
    if (has('magDecl')) putS('magDecl');
    else { patch.magDecl = 0; warn('磁気偏角が空欄のため 0°（真北＝磁北）とした'); }
    // 打上方位角（磁北基準）
    patch.azimRef = 'magnetic';
    if (has('azim')) putS('azim'); else keepBase('azim');
    // べき指数 n → α = 1/n
    if (has('windExp')) {
      const n = S.windExp;
      if (n >= 1) put('windExp', 1 / n);
      else if (n > 0) { put('windExp', n); warn(`べき指数 ${n} が 1 未満のため α（=1/n）が入力されたとみなした`); }
      else { warn(`べき指数 ${n} が不正のため現在の設定値を使用`); }
    }
    // 空欄なら現在値を残す項目
    for (const k of ['lat', 'lon', 'elev', 'railLen', 'windExp', 'windRef', 'hOxMass', 'hFuelPre', 'hFuelPost', 'hOxCG', 'hFuelCG', ...REQUIRED.filter(k => k !== 'noseLen' && k !== 'bodyLen')])
      if (!has(k)) keepBase(k);

    // ノーズ形状
    {
      const row = rowOf.noseShape, t = nu(row?.v);
      const sh = { cone: 'cone', ogive: 'ogive', parabolic: 'parabolic', elliptic: 'elliptic', 'コーン': 'cone', 'オジャイブ': 'ogive', 'オージャイブ': 'ogive', '放物線': 'parabolic', '楕円': 'elliptic' }[t];
      if (sh) put('noseShape', sh, { sheetLabel: 'ノーズ形状', sheetValue: str(row.v), sheetUnit: '-' });
      else warn(t ? `ノーズ形状「${str(row.v)}」は不明のため現在の設定値（${base.noseShape}）を使用` : `「ノーズ形状」が空欄のため現在の設定値（${base.noseShape}）を使用`);
    }

    // 質量モデル・タンク口金
    patch.massMode = 'hybrid';
    if (has('hTankOutlet')) patch.hOxDrain = true;
    else sup('hOxDrain', false, 'タンク口金位置が空欄のため、酸化剤重心は移動しないとした');

    // 慣性モーメント
    if (has('Ipitch') && has('Iroll')) patch.inertiaMode = 'manual';
    else sup('inertiaMode', 'auto', '慣性モーメントが空欄のため、形状・質量から自動推定する');

    // 空力
    if (has('cpManual') && has('cnaManual')) patch.aeroMode = 'manual';
    else sup('aeroMode', 'barrowman', '圧力中心か法線力傾斜が空欄のため、Barrowman 法で計算する');
    if (has('cdManual')) patch.cdMode = 'manual';
    else {
      sup('cdMode', 'auto', '軸力係数が空欄のため、形状から推定する');
      if (patch.aeroMode === 'manual') warn(`軸力係数が空欄。空力係数の直接入力では現在の Cd ${base.cdManual} を使う`);
    }
    for (const k of ['cmq', 'clp']) if (!has(k)) sup(k, null, `「${FM[k].subItem}」が空欄のため、${k === 'cmq' ? 'Barrowman' : 'strip theory'} 由来の値を使う`);
    patch.aeroTable = '';   // aeroTable は両モードで定数を上書きするので、諸元表の定数を使うために空にする
    if (str(base.aeroTable)) warn('空力テーブル（aeroTable）を空にした（諸元表の定数を使うため）');

    // 作動時間
    if (pos('hOpTime')) putS('hOpTime');
    else sup('hOpTime', 0, '作動時間が空欄のため 0（未設定）。仮定推力曲線では 1.2×燃焼時間を使う');

    // 回収系（終端速度指定）。値が 0 以下なら空欄と同じ扱い
    patch.chuteSpec = 'velocity';
    if (pos('c1Vt')) { putS('c1Vt'); sup('rec1', 'apogee', '1段目の開傘条件は諸元表に記載がないため、頂点検知で開傘すると仮定'); }
    else { patch.rec1 = 'none'; warn('1段目の降下終端速度が空欄（または 0 以下）のため、回収系なし＝弾道落下として計算する'); }
    const r2t = pos('rec2Time'), r2v = pos('c2Vt');
    if (r2t && r2v) { patch.rec2 = 'ignition'; putS('rec2Time'); putS('c2Vt'); }
    else if (!r2t && !r2v) sup('rec2', 'none', '2段目の開傘時刻・降下終端速度が空欄のため、2段目なし');
    else { patch.rec2 = 'none'; warn('2段目の開傘時刻と降下終端速度の片方だけが入力されているため、2段目なしとした'); }

    // ペイロード（3 項目がそろったときだけ放出）
    const pn = ['payloadTime', 'payloadVt', 'payloadMass'].filter(pos).length;
    if (pn === 3) {
      patch.payloadOn = true;
      putS('payloadTime'); putS('payloadVt'); putS('payloadMass');
      supplemented.push({ key: 'payloadTime', label: label('payloadTime'), value: patch.payloadTime, unit: 's', reason: '諸元表の注記は「点火から開傘まで」だが、本実装では点火からの放出時刻として扱う' });
      sup('payloadPos', base.payloadPos ?? FALLBACK.payloadPos, 'ペイロードの重心位置は諸元表に無いため現在の設定値を使用（放出後の静安定に影響する）');
    } else if (pn === 0) sup('payloadOn', false, 'ペイロードの 3 項目が空欄（または 0 以下）のため、放出しない');
    else { patch.payloadOn = false; warn('ペイロードの放出時刻・降下終端速度・質量の一部だけが入力されているため、放出しないとした'); }

    // その他の必須パッチ
    Object.assign(patch, { motorSrc: 'eng', motorPreset: 'custom', posRef: 'aft', ballast: 0 });

    // 諸元表に無いがシミュレーションに必要な項目（現在の設定値を使う）
    const fromBase = (k, reason) => sup(k, base[k] ?? FALLBACK[k], reason);
    fromBase('finN', 'フィン枚数は諸元表に無いため現在の設定値を使用（CNα・Cmq に影響する）');
    fromBase('finThick', 'フィン厚さは諸元表に無いため現在の設定値を使用');
    fromBase('finCant', 'フィン取付角は諸元表に無いため現在の設定値を使用（ロールを起こす）');
    if (patch.rec1 !== 'none' || patch.payloadOn) fromBase('openTime', 'パラシュートの展開所要時間は諸元表に無いため現在の設定値を使用');
    fromBase('windDirRef', '風向の基準（真北/磁北）は諸元表に無いため現在の設定値を使用');
    for (const k of ['wind', 'windFrom', 'gust']) fromBase(k, '単発計算用の風は諸元表に無いため現在の設定値を使用（落下分散では掃引する）');
    fromBase('temp', '地上気温は諸元表に無いため現在の設定値を使用');
    fromBase('lugAft', 'ランチラグの位置は諸元表に無いため現在の設定値を使用');
    fromBase('landSurface', '着地面は諸元表に無いため現在の設定値を使用');
    for (const k of ['mLen', 'mDia', 'mOver']) fromBase(k, 'モーターの描画寸法は諸元表に無いため現在の設定値を使用（ハイブリッドの質量計算には使わない）');
    if ((+base.thrustScale || 100) !== 100) warn(`推力倍率が ${base.thrustScale}% のまま（諸元表の推力を ${base.thrustScale}% にして計算する）`);
    if (base.cdScale != null && +base.cdScale !== 100) warn(`抗力係数の倍率が ${base.cdScale}% のまま（諸元表の軸力係数を ${base.cdScale}% にして計算する）`);

    // 推力: 「推力履歴」シート（t[s], F[N]）→ measured、無ければ仮定曲線 → assumed
    const val = k => patch[k] ?? base[k];
    const tsn = findSheet(wb, SHEET_THRUST);
    let tpts = null, tAssumed = false;
    if (tsn) {
      const ws = wb.Sheets[tsn], rg = X.utils.decode_range(ws['!ref'] || 'A1:A1');
      tpts = [];
      for (let r = rg.s.r; r <= rg.e.r; r++) {
        const a = cellV(X, ws, r, 0), t = num(a), f = num(cellV(X, ws, r, 1));
        if (t != null && f != null) tpts.push([t, f]);
        else if (typeof a === 'string' && a.includes('推力履歴は仮定')) tAssumed = true;   // 本ツールが書き出した仮定曲線（§4.2 の注意文）
      }
      if (tpts.length < 2) { warn(`シート「${tsn}」に推力の数値（t[s], F[N] の 2 列）が無いため、仮定曲線を使う`); tpts = null; }
    }
    if (tpts) {
      patch.engText = tpts.map(([t, f]) => `${t} ${f}`).join('\n');
      patch.thrustKind = tAssumed ? 'assumed' : 'measured';
      imported.push({ key: 'engText', label: label('engText'), value: `${tpts.length} 点（${tpts[tpts.length - 1][0]} s まで）`, unit: '', sheetLabel: tsn, sheetValue: tpts.length, sheetUnit: 't[s], F[N]' });
    } else {
      const tb = +val('hBurnTime'), op = +val('hOpTime');
      let tOp = op > 0 ? op : 1.2 * tb;
      if (op > 0 && !(op > tb)) { warn(`作動時間 ${op} s が燃焼時間 ${tb} s 以下のため、仮定曲線は 1.2×燃焼時間で作る`); tOp = 1.2 * tb; }
      const cv = assumedCurve(+val('hOxMass'), +val('hFuelPre'), +val('hFuelPost'), tb, tOp);
      patch.engText = cv.engText;
      patch.thrustKind = 'assumed';
      supplemented.push({ key: 'engText', label: label('engText'), value: `仮定曲線（総力積 ${cv.I.toFixed(1)} N·s、作動時間 ${+tOp.toPrecision(10)} s）`, unit: '',
        reason: `諸元表に推力履歴が無いため、Isp ${ISP} s と仮定し（酸化剤＋燃料消費量）×Isp×g0 の総力積で減少型の曲線を作った。${ASSUMED_NOTE}` });
    }

    // 往復: 「シミュレータ追加諸元」（key, 項目名, 値, 単位, 説明）で上書き
    const esn = findSheet(wb, SHEET_EXTRA);
    if (esn) readExtra(X, wb.Sheets[esn], esn, { patch, imported, supplemented, warn });
    if (+patch.tailLen) patch.bodyLen = clean(L - (patch.noseLen ?? base.noseLen) - patch.tailLen);   // 追加諸元でテールが付いたら胴体長を詰める
    // 追加諸元で方位の基準が真北なら、団体入力シートの打上方位角（常に磁北基準）を真方位に直す
    if (patch.azimRef === 'true' && has('azim')) {
      patch.azim = clean(((patch.azim + +val('magDecl')) % 360 + 360) % 360) % 360;
      const e = imported.find(x => x.key === 'azim'); if (e) e.value = patch.azim;
    }
    if (patch.thrustKind === 'assumed') warn(ASSUMED_NOTE);

    // 磁気偏角の符号チェック
    warn(declChk(+val('lat'), +val('lon'), +val('magDecl')));
    return { patch, imported, supplemented, warnings };
  }

  function readExtra(X, ws, sn, { patch, imported, supplemented, warn }) {
    const DEF = defaultsTable();
    if (!DEF) { warn(`既定値表が無いため、シート「${sn}」を読めませんでした`); return; }
    const rg = X.utils.decode_range(ws['!ref'] || 'A1:A1');
    let r0 = rg.s.r;
    for (let r = rg.s.r; r <= rg.e.r; r++) if (nu(cellV(X, ws, r, 0)) === 'key') { r0 = r + 1; break; }
    for (let r = r0; r <= rg.e.r; r++) {
      const k = str(cellV(X, ws, r, 0));
      if (!/^[A-Za-z_$][\w$]*$/.test(k) || k === 'key') continue;   // 注意文・見出し・空行
      if (!(k in DEF)) { warn(`シート「${sn}」の未知のキー「${k}」を無視した`); continue; }
      const v = cellV(X, ws, r, 2), d = DEF[k];
      if (k === 'engText' && !str(v)) continue;   // 本ツールの書出しは推力を「推力履歴」シートに置く（空欄なら推力履歴シートを使う）
      let x;
      if ((NULLABLE.includes(k) || d === null) && !str(v)) x = null;
      else if (typeof d === 'number' || d === null) {   // NFKC 後に数値化、だめなら parseFloat（"250 mm" など）
        x = num(v) ?? parseFloat(str(v).normalize('NFKC'));
        if (!Number.isFinite(x)) { warn(`シート「${sn}」の「${k}」の値「${str(v)}」が数値でないため無視した`); continue; }
      }
      else if (typeof d === 'boolean') x = typeof v === 'boolean' ? v : /^(true|1)$/.test(nu(v));
      else x = v == null ? '' : String(v);
      patch[k] = x;
      for (const arr of [imported, supplemented]) for (let i = arr.length - 1; i >= 0; i--) if (arr[i].key === k) arr.splice(i, 1);
      imported.push({ key: k, label: label(k), value: x, unit: cfgUnit(k) || str(cellV(X, ws, r, 3)), sheetLabel: str(cellV(X, ws, r, 1)) || k, sheetValue: v, sheetUnit: str(cellV(X, ws, r, 3)) });
    }
  }

  // ---------------- 書出し（§4.2） ----------------
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const SHEET_REVIEW = '審査用計算値', SHEET_FLIGHT = '飛行結果';
  // 団体入力シート各行の Note（元の様式の文言）
  const NOTE = {
    name: '機体名。', lat: '基本的に射場運営から指定。フォーマットは度形式(10進)。', lon: '基本的に射場運営から指定。フォーマットは度形式(10進)。',
    siteAlt: '基本的に射場運営から指定。', magDecl: '射点座標における真北と磁北の方位角のずれ（西偏は-、東偏は+）。',
    azim: '磁北基準左手系(北が0度で時計回り)でのランチャ方位角。取れる範囲は射場によって異なる。', elev: '地面からのランチャ仰角。取れる範囲は射場によって異なる。',
    railLen: '基本的に射場運営から指定。', windExp: 'べき法則を用いる際の指数。基本的に射場運営から指定。',
    windRef: 'べき法則を用いる際の風速を計測する基準高さ、基本的に射場運営から指定。', d: '',
    bodyLen: 'ノーズコーン先端から機体後端(ボートテイル時はテイル後端まで/ノズルカバー(機体直径より十分小さい)、フィンは含まず)までの長さ。',
    hDryMass: '液体酸化剤を除く機体質量。', hOxMass: '満充填時の酸化剤質量。', hFuelPre: '燃焼前の燃料(グレイン)質量。', hFuelPost: '燃焼後の燃料(グレイン)質量。',
    hDryCG: '機体後端から乾燥質量時重心位置までの長さ。', hOxCG: '機体後端から酸化剤単体の重心位置までの長さ。',
    hTankOutlet: '機体後端からタンク口金位置までの長さ。', hFuelCG: '機体後端から燃料(グレイン)単体の重心位置までの長さ。',
    Ipitch: '乾燥質量時ヨー/ピッチ軸慣性モーメント。', Iroll: '乾燥質量時ロール軸慣性モーメント。',
    cpManual: '機体後端から圧力中心までの長さ。', cdManual: '軸力係数。迎角0 degのときの抗力係数と同義。定数でない場合はCSVで提出すること。',
    cnaManual: '全機での法線力傾斜。定数でない場合はCSVで提出すること。', clp: 'ロール減衰モーメント係数。', cmq: 'ヨー/ピッチ減衰モーメント係数。',
    nozzleExitD: '燃料ノズルの出口直径。', hBurnTime: '燃焼時間(作動時間と区別すること)。', c1Vt: '1段目パラシュートの降下終端速度。',
    rec2Time: '2段目パラシュートの点火時から開傘するまでの時間。', c2Vt: '2段目パラシュートの降下終端速度。',
    payloadTime: 'ペイロードの点火時から開傘するまでの時間。', payloadVt: 'ペイロードの降下終端速度。', payloadMass: 'ペイロードの質量。',
    noseShape: '"Cone" または "Ogive" または "Parabolic"。', noseLen: 'ノーズコーンの長さ。', finAft: '機体後端から翼根後端までの長さ。',
    finCr: '翼根のコード長(Cr)。', finCt: '翼端のコード長(Ct)。', finSweep: '翼前縁部の後退部長(Cle)。', finSpan: 'スパン長(S)。',
    hOpTime: '作動時間(燃焼時間と区別すること)。',
  };
  const NOSE_OUT = { cone: 'Cone', ogive: 'Ogive', parabolic: 'Parabolic', elliptic: 'Elliptic' };
  const POS_KEYS = new Set(['airCG', 'ballastPos', 'hDryCG', 'hOxCG', 'hTankOutlet', 'hFuelCG', 'cpManual', 'payloadPos']);
  Object.assign(UNIT_EXTRA, { airMass: 'g', airCG: 'mm', ballastPos: 'mm', tailD: 'mm', mI: 'N·s', mTb: 's', mProp: 'g', mTotal: 'g', rec1Time: 's', rec1Delay: 's',
    rec1Backup: 's', c1D: 'mm', c2D: 'mm', c1Cd: '-', c2Cd: '-', mainAlt: 'm', dtApoWarn: 's', cdScale: '%', dt: 'ms' });
  // 「シミュレータ追加諸元」の説明列（主なものだけ）
  const DESC = {
    posRef: 'UI の位置表示の基準（nose / aft）。cfg の位置は常に先端基準', massMode: 'motor: 機体＋固体モーター / hybrid: 諸元表の方式',
    inertiaMode: 'auto: 形状・質量から推定 / manual: 団体入力シートの慣性モーメント', aeroMode: 'barrowman: 形状から計算 / manual: 団体入力シートの空力係数',
    cdMode: '抗力係数の指定（barrowman のとき）', chuteSpec: 'diameter: 直径と Cd / velocity: 降下終端速度', rec1: '1段目の開傘条件（諸元表に記載なし）',
    rec2: '2段目の開傘条件', thrustKind: 'measured: 実測 / assumed: Isp 170 s の仮定曲線', engText: '推力履歴はシート「推力履歴」を参照',
    payloadOn: 'ペイロードを放出する', payloadPos: 'ペイロードの重心（諸元表に無い。放出後の静安定に影響）', azimRef: '打上方位角の基準（団体入力シートは常に磁北基準）',
    windDirRef: '風向の基準', finN: 'フィン枚数（諸元表に無い）', finThick: 'フィン厚さ（諸元表に無い）', finCant: 'フィン取付角（ロールを起こす）',
    openTime: 'パラシュートの展開所要時間', wind: '単発計算用の風速（基準高さでの値）', windFrom: '単発計算用の風向（吹いてくる方位）', gust: '単発計算用の乱流強度',
    lugAft: '機体後端から最後尾ランチラグまで', landSurface: '着地面（site / sea）', tailLen: 'ボートテール長（全長に含む）', hOxDrain: '排出に伴い酸化剤の重心を口金へ移動',
    aeroTable: '任意の空力テーブル（Mach,Cd[,CNa[,Xcp_mm(先端)]]）',
  };
  // flightSummary のキー → [項目名, 単位]（§3.4 の順）
  const FS_LABELS = [
    ['railExit_t_s', 'ランチクリア時刻', 's'], ['railExit_V_mps', 'ランチクリア速度（対地）', 'm/s'], ['railExit_alphaW_deg', 'ランチクリア時の風による迎角', 'deg'],
    ['maxV_mps', '最大速度（上昇中）', 'm/s'], ['maxV_t_s', '最大速度の時刻', 's'], ['maxMach', '最大マッハ数', '-'], ['maxQ_Pa', '最大動圧', 'Pa'], ['maxQ_t_s', '最大動圧の時刻', 's'],
    ['maxAcc_G', '最大加速度', 'G'], ['opEnd_t_s', '作動終了時刻', 's'], ['opEnd_z_m', '作動終了時高度', 'm'], ['opEnd_V_mps', '作動終了時速度', 'm/s'], ['burnEnd_t_s', '燃焼終了時刻', 's'],
    ['apogee_m', '頂点高度', 'm'], ['apogee_t_s', '頂点到達時刻', 's'], ['apogee_range_m', '頂点の水平距離', 'm'],
    ['deploy1_t_s', '1段目開傘時刻', 's'], ['deploy1_z_m', '1段目開傘高度', 'm'], ['deploy1_Va_mps', '1段目開傘時の対気速度', 'm/s'], ['deploy1_q_Pa', '1段目開傘時の動圧', 'Pa'],
    ['deploy1_dtApo_s', '1段目開傘の頂点からのずれ', 's'], ['deploy1_by', '1段目開傘のきっかけ', '-'],
    ['deploy2_t_s', '2段目開傘時刻', 's'], ['deploy2_z_m', '2段目開傘高度', 'm'], ['deploy2_Va_mps', '2段目開傘時の対気速度', 'm/s'], ['deploy2_q_Pa', '2段目開傘時の動圧', 'Pa'],
    ['deploy2_dtApo_s', '2段目開傘の頂点からのずれ', 's'],
    ['payload_t_s', 'ペイロード放出時刻', 's'], ['payload_z_m', 'ペイロード放出高度', 'm'], ['payload_Va_mps', 'ペイロード放出時の対気速度', 'm/s'], ['payload_q_Pa', 'ペイロード放出時の動圧', 'Pa'],
    ['payload_dtApo_s', 'ペイロード放出の頂点からのずれ', 's'], ['payloadOpenLoad_N', 'ペイロード開傘荷重', 'N'], ['payloadOpenLoad_G', 'ペイロード開傘荷重', 'G'],
    ['descent1_mps', '1段目展開後の降下速度', 'm/s'], ['landing_t_s', '着地時刻', 's'], ['landing_V_mps', '着地速度', 'm/s'], ['landing_vz_mps', '着地時の降下速度', 'm/s'],
    ['landing_dist_m', '落下距離（射点から）', 'm'], ['landing_brgTrue_deg', '落下方位（真北基準）', 'deg'],
    ['payloadLanding_dist_m', 'ペイロード落下距離（射点から）', 'm'], ['payloadLanding_brgTrue_deg', 'ペイロード落下方位（真北基準）', 'deg'],
    ['payloadLanding_vz_mps', 'ペイロード着地時の降下速度', 'm/s'], ['flightEnd_t_s', '飛行終了時刻', 's'],
  ];
  const mod360 = x => { const y = clean(((x % 360) + 360) % 360); return y >= 360 ? 0 : y; };
  const finite = x => typeof x === 'number' && isFinite(x);
  const cellOut = v => v == null ? null : typeof v === 'number' ? (isFinite(v) ? v : null) : v;   // NaN・null は空セル
  const fieldOf = k => typeof FIELDS !== 'undefined' && Array.isArray(FIELDS) ? FIELDS.find(f => f.k === k) : null;
  const excelDate = () => { const d = new Date(); return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 864e5); };

  // 団体入力シートの値（諸元表の単位・後端基準）。V[key] = 値（null は空欄）、note[key] = Note の追記
  function sheetValues(c, M, sim, rv, warn) {
    const L = typeof cfgLenMm === 'function' ? cfgLenMm(c) : (+c.noseLen || 0) + (+c.bodyLen || 0) + (+c.tailLen || 0);
    const V = {}, note = {};
    const aftMm = xNoseMm => finite(xNoseMm) ? clean(L - xNoseMm) : null;
    const kg = g => finite(+g) ? clean(g / 1000) : null;
    const hyb = c.massMode === 'hybrid', manA = c.aeroMode === 'manual', manI = c.inertiaMode === 'manual';
    const Gs = typeof G_SHEET !== 'undefined' ? G_SHEET : 9.81, Rs = typeof RHO0_SHEET !== 'undefined' ? RHO0_SHEET : 1.2;
    Object.assign(V, { name: c.name, lat: c.lat, lon: c.lon, siteAlt: c.siteAlt, magDecl: c.magDecl, elev: c.elev, railLen: c.railLen, windRef: c.windRef, d: c.d, bodyLen: L });
    // 打上方位角は常に磁北基準: (真方位 − 磁気偏角) mod 360
    const tAz = finite(rv?.trueAzim_deg) ? rv.trueAzim_deg : M.trueAzim * 180 / Math.PI;
    V.azim = mod360(tAz - c.magDecl);
    if (c.azimRef !== 'magnetic') note.azim = `（真北基準 ${+tAz.toFixed(6)}° から換算）`;
    // べき指数 n = 1/α
    if (c.windExp > 0) V.windExp = 1 / c.windExp;
    else { V.windExp = null; note.windExp = '（べき指数 α ≤ 0 のため空欄）'; warn(`べき指数 α = ${c.windExp} が 0 以下のため、諸元表のべき指数 n を空欄にしました`); }
    // 質量・重心・燃焼時間
    if (hyb) {
      Object.assign(V, { hDryMass: kg(c.hDryMass), hOxMass: kg(c.hOxMass), hFuelPre: kg(c.hFuelPre), hFuelPost: kg(c.hFuelPost),
        hDryCG: aftMm(c.hDryCG), hOxCG: aftMm(c.hOxCG), hTankOutlet: aftMm(c.hTankOutlet), hFuelCG: aftMm(c.hFuelCG), hBurnTime: c.hBurnTime,
        hOpTime: c.hOpTime > 0 ? c.hOpTime : M.tb });
      if (!(c.hOpTime > 0)) note.hOpTime = '（未設定のため推力履歴の終わりの時刻）';
    } else {   // 固体モーター: 乾燥質量 = 点火時の全質量、燃料 = 推進剤
      const w = M.massAt(0);
      Object.assign(V, { hDryMass: clean(w.m), hDryCG: aftMm(w.cg * 1000), hOxMass: 0, hOxCG: null, hTankOutlet: null, hFuelPre: clean(M.prop), hFuelPost: 0,
        hFuelCG: aftMm(M.motorX * 1000), hBurnTime: M.tb, hOpTime: M.tb });
      note.hDryMass = '（固体モーター: 点火時の全質量）'; note.hDryCG = '（固体モーター: 点火時の重心）'; note.hFuelPre = '（固体モーター: 推進剤質量）'; note.hFuelCG = '（固体モーター: モーターの重心）';
    }
    // 慣性モーメント（乾燥時）。auto は推定値
    if (manI) { V.Ipitch = c.Ipitch; V.Iroll = c.Iroll; }
    else if (hyb) { const m = c.hDryMass / 1000; V.Ipitch = m * M.L * M.L / 12; V.Iroll = 0.5 * m * M.R * M.R; note.Ipitch = note.Iroll = '（自動推定値）'; }
    else { const w = M.massAt(0); V.Ipitch = w.I; V.Iroll = w.Ir; note.Ipitch = note.Iroll = '（自動推定値・点火時）'; }
    // 空力
    const cmqV = finite(rv?.cmqEq) ? rv.cmqEq : null, clpV = finite(rv?.clpEq) ? rv.clpEq : null;
    if (manA) {
      Object.assign(V, { cpManual: aftMm(c.cpManual), cdManual: c.cdManual, cnaManual: c.cnaManual, cmq: c.cmq ?? cmqV, clp: c.clp ?? clpV });
      if (c.cmq == null) note.cmq = '（Barrowman 由来の値）';
      if (c.clp == null) note.clp = '（strip theory 由来の値）';
    } else {
      const cp = M.cpAt(0);
      Object.assign(V, { cpManual: aftMm(cp.xcp * 1000), cnaManual: cp.cna, cdManual: M.cd0, cmq: cmqV, clp: clpV });
      for (const k of ['cpManual', 'cnaManual', 'cdManual', 'cmq', 'clp']) note[k] = '（Barrowman 法・マッハ 0 の計算値）';
    }
    V.nozzleExitD = c.nozzleExitD;
    // 回収系
    const r1 = c.rec1 !== 'none', r2 = r1 && c.rec2 !== 'none', vel = c.chuteSpec === 'velocity';
    const vtOf = cds => cds > 0 && M.mRef > 0 ? Math.sqrt(2 * M.mRef * Gs / (Rs * cds)) : null;
    const vt1 = vel ? c.c1Vt : (finite(rv?.vt1_mps) ? rv.vt1_mps : vtOf(M.c1CdA));
    const vt2 = vel ? c.c2Vt : (finite(rv?.vt2_mps) ? rv.vt2_mps : vtOf(M.c1CdA + M.c2CdA));
    V.c1Vt = r1 ? vt1 : null;
    if (r1 && !vel) note.c1Vt = `（直径指定から換算: √(2·m·g/(ρ·CdS))、m = ${+(+M.mRef).toFixed(4)} kg）`;
    if (!r1) note.c1Vt = '（回収系なし）';
    V.rec2Time = V.c2Vt = null;
    if (r2) {
      V.c2Vt = vt2;
      if (!vel) note.c2Vt = '（直径指定から換算: 1段目＋2段目の CdS）';
      if (c.rec2 === 'ignition') V.rec2Time = c.rec2Time;
      else {   // altitude: ノミナル計算の開傘時刻
        const t = sim?.ev?.deploy2?.t;
        note.rec2Time = `高度 ${c.mainAlt} m 開傘の予測時刻`;
        if (finite(t)) V.rec2Time = t;
        else { note.rec2Time += '（ノミナル計算で開傘しなかったため空欄）'; warn(`2段目は高度 ${c.mainAlt} m 開傘ですが、ノミナル計算で開傘しなかったため開傘時刻を空欄にしました`); }
      }
    }
    // ペイロード
    if (c.payloadOn) Object.assign(V, { payloadTime: c.payloadTime, payloadVt: c.payloadVt, payloadMass: kg(c.payloadMass) });
    else V.payloadTime = V.payloadVt = V.payloadMass = null;
    // 空力形状
    V.noseShape = NOSE_OUT[c.noseShape] ?? c.noseShape;
    if (c.noseShape === 'elliptic') note.noseShape = '（Elliptic は様式外）';
    Object.assign(V, { noseLen: c.noseLen, finAft: c.finAft, finCr: c.finCr, finCt: c.finCt, finSweep: c.finSweep, finSpan: c.finSpan });
    if (+c.tailLen > 0) note.bodyLen = `（ボートテール ${c.tailLen} mm を含む）`;
    return { V, note };
  }

  async function buildBook(cfg, model, sim) {
    if (typeof normalizeCfg !== 'function' || typeof buildModel !== 'function') throw jpErr('physics.js が読み込まれていないため書き出せません');
    const X = await loadXLSX();
    const c = baseOf(cfg);
    const M = model && typeof model.massAt === 'function' ? model : buildModel(c);
    let S = sim;
    if (!S?.ev && typeof simulate === 'function') { try { S = simulate(M); } catch (e) { S = null; } }
    let rv = null;
    try { if (typeof reviewValues === 'function') rv = reviewValues(M); } catch (e) { rv = null; }
    const warnings = [], warn = s => { if (s && !warnings.includes(s)) warnings.push(s); };
    const assumed = c.thrustKind === 'assumed';
    const top = () => assumed ? [[ASSUMED_NOTE]] : [];
    const today = excelDate();
    const sheet = (aoa, cols) => { const ws = X.utils.aoa_to_sheet(aoa); ws['!cols'] = cols.map(wch => ({ wch })); return ws; };

    // 1. 団体入力シート（元の様式: 1 行目は空き → 仮定推力の注意文、2〜5 行目は見出し、6 行目から項目）
    const { V, note } = sheetValues(c, M, S, rv, warn);
    const A = [assumed ? [ASSUMED_NOTE] : [], [null, '更新日:', today], [null, '・審査用シート，分野別確認シートは確認のみに使用し，数値を直接入力しないこと'],
      [null, '・改訂履歴と更新日を記載すること'], [null, 'Item', 'SubItem', 'Value', 'Unit', 'Note']];
    const merges = [], dateCells = ['C2'];
    let sec = null;
    for (const f of fieldMap) {
      const nt = (NOTE[f.key] || '') + (note[f.key] || '');
      if (f.key === 'name') { merges.push({ s: { r: A.length, c: 1 }, e: { r: A.length, c: 2 } }); A.push([null, f.item, null, cellOut(V.name), f.unit, nt || null]); sec = f.item; continue; }
      if (f.item !== sec) {
        sec = f.item;
        if (sec !== '分野別確認項目') merges.push({ s: { r: A.length, c: 1 }, e: { r: A.length, c: 3 } });
        A.push([null, sec]);
      }
      A.push([null, null, f.subItem, cellOut(V[f.key]), f.unit, nt || null]);
    }
    A.push([], [null, '簡易改訂履歴（記入の際は青字を消し，変更内容を記載すること）'], [null, '訂版', '年月日', '改訂者', null, '改訂内容'],
      [null, 1, today, null, null, 'student-rocket-sim から書出し'], [null, 2], [null, 3], [null, 4], [null, 5]);
    dateCells.push('C' + (A.length - 4));
    const wsIn = sheet(A, [3, 22, 34, 14, 8, 70]);
    wsIn['!merges'] = merges;
    for (const a of dateCells) if (wsIn[a]) wsIn[a].z = 'yyyy/m/d';

    // 2. シミュレータ追加諸元（DEFAULTS のうち fieldMap に無いキー全部。位置は先端基準 mm）
    const DEF = defaultsTable() || {};
    const E = [...top(), ['key', '項目名', '値', '単位', '説明']];
    const over = {};   // 推力は「推力履歴」シート（M.pts、倍率適用済み）を正とするための上書き
    over.engText = ['', '推力履歴はシート「推力履歴」を参照（t[s], F[N]）'];
    if (+c.thrustScale !== 100) over.thrustScale = [100, `推力履歴シートは推力倍率 ${c.thrustScale}% を適用済み`];
    if (c.motorSrc !== 'eng') {
      over.motorSrc = ['eng', `推力履歴シートの曲線を使う（元の設定: ${c.motorSrc}）`];
      over.motorPreset = ['custom', `推力履歴シートの曲線を使う（元の設定: ${c.motorPreset}）`];
    }
    if (c.massMode !== 'hybrid') {   // 固体モーター: .eng ヘッダやプリセット由来の値を数値で残す
      over.mProp = [clean(M.prop * 1000), 'モーターの推進剤質量（計算に使った値）'];
      over.mTotal = [clean(M.total * 1000), 'モーターの全質量（計算に使った値）'];
      over.mLen = [clean(M.mLen * 1000), 'モーター長（計算に使った値）'];
      over.mDia = [clean(M.mDia * 1000), 'モーター径（計算に使った値）'];
    }
    for (const k of Object.keys(DEF)) {
      if (FM[k]) continue;
      const fld = fieldOf(k);
      const [v, d] = over[k] ?? [c[k] ?? DEF[k], DESC[k] ?? ''];
      E.push([k, fld?.l ?? LABEL[k] ?? k, cellOut(v), POS_KEYS.has(k) ? 'mm(先端)' : (fld?.u ?? UNIT_EXTRA[k] ?? ''), d || null]);
    }
    const wsEx = sheet(E, [16, 30, 16, 10, 60]);

    // 3. 推力履歴（t[s], F[N] = M.pts）
    const wsTh = sheet([...top(), ['t[s]', 'F[N]'], ...M.pts.map(p => [p[0], p[1]])], [12, 12]);

    // 4. 審査用計算値（REVIEW_LABELS の順に reviewValues）
    const R = [...top(), ['key', '項目名', '値', '単位']];
    if (rv && typeof REVIEW_LABELS !== 'undefined') for (const [k, l, u] of REVIEW_LABELS) R.push([k, l, cellOut(rv[k]), u]);
    else R.push(['', 'reviewValues（physics.js）が無いため計算値を出力できませんでした']);
    const wl = [...(M.warn || [])];
    const dc = declChk(+c.lat, +c.lon, +c.magDecl); if (dc && !wl.includes(dc)) wl.push(dc);
    if (wl.length) { R.push([]); for (const w of wl) R.push(['warn', '警告', w]); }
    const wsRv = sheet(R, [22, 40, 16, 8]);

    // 5. 飛行結果（flightSummary。緯度経度は enuToLatLon）
    const Fl = [...top(), ['key', '項目名', '値', '単位']];
    let fs = null;
    try { if (S && typeof flightSummary === 'function') fs = flightSummary(M, S); } catch (e) { fs = null; warn('飛行結果（flightSummary）を計算できませんでした: ' + (e?.message || e)); }
    if (fs) {
      const seen = new Set();
      for (const [k, l, u] of FS_LABELS) if (k in fs) { Fl.push([k, l, cellOut(fs[k]), u]); seen.add(k); }
      for (const k of Object.keys(fs)) if (!seen.has(k)) Fl.push([k, k, cellOut(fs[k]), '']);
    } else if (S?.st) {   // flightSummary が無い場合の最低限
      Fl.push(['', 'flightSummary（physics.js）が無いため、主な値だけを出力']);
      const st = S.st, ev = S.ev || {};
      for (const [k, l, u, v] of [['apogee_m', '頂点高度', 'm', st.apogee], ['apogee_t_s', '頂点到達時刻', 's', st.apoT], ['maxV_mps', '最大速度', 'm/s', st.maxV],
        ['maxMach', '最大マッハ数', '-', st.maxMach], ['maxQ_Pa', '最大動圧', 'Pa', st.maxQ], ['maxAcc_G', '最大加速度', 'G', st.maxG],
        ['landing_t_s', '着地時刻', 's', ev.landing?.t], ['landing_vz_mps', '着地時の降下速度', 'm/s', ev.landing?.vz]]) Fl.push([k, l, cellOut(v), u]);
    } else Fl.push(['', '飛行計算の結果が無いため出力できませんでした']);
    if (S && typeof enuToLatLon === 'function') {
      const ll = (k, l, x, y) => { if (finite(x) && finite(y)) { const [la, lo] = enuToLatLon(c.lat, c.lon, x, y); Fl.push([k + '_lat', l + ' 緯度', la, 'deg'], [k + '_lon', l + ' 経度', lo, 'deg']); } };
      ll('apogee', '頂点', S.st?.apoX, S.st?.apoY);
      ll('landing', '着地点', S.ev?.landing?.x, S.ev?.landing?.y);
      ll('payloadLanding', 'ペイロード着地点', S.payload?.landing?.x, S.payload?.landing?.y);
    }
    if (S?.ev?.error) Fl.push(['error', '計算エラー', String(S.ev.error), '']);
    Fl.push([], ['', '計算条件'], ['wind_mps', `風速（高度 ${c.windRef} m）`, c.wind, 'm/s'],
      ['windFrom_deg', `風向（${c.windDirRef === 'magnetic' ? '磁北' : '真北'}基準、吹いてくる方位）`, c.windFrom, 'deg'], ['gust_mps', '乱流強度', c.gust, 'm/s'],
      ['trueAzim_deg', '打上方位角（真北基準）', finite(rv?.trueAzim_deg) ? rv.trueAzim_deg : M.trueAzim * 180 / Math.PI, 'deg'], ['elev_deg', '射角', c.elev, 'deg']);
    const wsFl = sheet(Fl, [26, 40, 16, 8]);

    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, wsIn, SHEET_IN);
    X.utils.book_append_sheet(wb, wsEx, SHEET_EXTRA);
    X.utils.book_append_sheet(wb, wsTh, SHEET_THRUST);
    X.utils.book_append_sheet(wb, wsRv, SHEET_REVIEW);
    X.utils.book_append_sheet(wb, wsFl, SHEET_FLIGHT);
    wb.Props = { Title: `${c.name} 諸元表`, Author: 'student-rocket-sim' };
    const buf = X.write(wb, { type: 'array', bookType: 'xlsx', compression: true });
    const fileName = `${String(c.name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'rocket'}_諸元表.xlsx`;
    return { buf, fileName, warnings };
  }
  // テスト・内部用: 書出しと同じ xlsx を ArrayBuffer で返す（SheetJS の読込を待つので Promise）
  async function _buildWorkbook(cfg, model, sim) { return (await buildBook(cfg, model, sim)).buf; }
  // 書出し: <name>_諸元表.xlsx をダウンロードする。戻り値 {fileName, warnings}（app.js は使わなくてよい）
  async function exportXlsx(cfg, model, sim) {
    let r;
    try { r = await buildBook(cfg, model, sim); }
    catch (e) { throw e?.jp ? e : jpErr('諸元表の書出しに失敗しました（' + (e?.message || e) + '）'); }
    if (typeof download === 'function') download(r.fileName, r.buf, XLSX_MIME);
    else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.buf], { type: XLSX_MIME })); a.download = r.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    for (const w of r.warnings) console.warn('[SpecSheet] ' + w);
    return { fileName: r.fileName, warnings: r.warnings };
  }

  // ---------------- Debug 諸元（§4.3。test/fixtures/spec-dump.txt を §4.1 の規則で変換） ----------------
  const DEBUG_CURVE = assumedCurve(391, 380, 322, 2.393, 3.756);   // 総力積 748.5 N·s、作動時間 3.756 s
  const DEBUG_PRESET = Object.freeze({
    name: 'Debug', massMode: 'hybrid', aeroMode: 'manual', inertiaMode: 'manual', chuteSpec: 'velocity', motorSrc: 'eng', motorPreset: 'custom',
    tailLen: 0, azimRef: 'magnetic', posRef: 'aft', ballast: 0,
    // 射点座標・ランチャ・風
    lat: 35.177228, lon: 140.357056, siteAlt: 0, magDecl: 7.6, azim: 180, elev: 85, railLen: 5, windExp: 1 / 6, windRef: 4,
    // 機体形状（全長 1600 = ノーズ 300 + 胴体 1300）
    d: 130, noseShape: 'ogive', noseLen: 300, bodyLen: 1300,
    // 質量 [g]・重心 [mm 先端から] = 1600 − 後端からの値
    hDryMass: 6190, hOxMass: 391, hFuelPre: 380, hFuelPost: 322,
    hDryCG: 1008.52, hOxCG: 1224, hTankOutlet: 1379.14, hFuelCG: 1489.57, hOxDrain: true,
    Ipitch: 1.5, Iroll: 0.09,
    // 空力（圧力中心 1600 − 342）
    cpManual: 1258, cdManual: 0.37, cdMode: 'manual', cnaManual: 11.8, clp: -0.14, cmq: -2.96, aeroTable: '',
    // 燃焼・推力（仮定曲線）
    nozzleExitD: 18, hBurnTime: 2.393, hOpTime: 3.756, engText: DEBUG_CURVE.engText, thrustKind: 'assumed',
    // 回収系（2段目は空欄 → なし）・ペイロード
    rec1: 'apogee', c1Vt: 8.08, rec2: 'none', openTime: 1,
    payloadOn: true, payloadTime: 7, payloadVt: 6, payloadMass: 250, payloadPos: 200,
    // フィン
    finAft: 0, finCr: 210, finCt: 50, finSweep: 160, finSpan: 143.64, finN: 4, finThick: 3, finCant: 0,
    // 補完（諸元表に無い）
    windDirRef: 'true', wind: 4, windFrom: 270, gust: 0, temp: 20, lugAft: 0, landSurface: 'site', mLen: 600, mDia: 60, mOver: 0,
  });
  const S_ = (key, value, unit, reason) => Object.freeze({ key, label: label(key), value, unit, reason });
  const DEBUG_SUPPLEMENTS = Object.freeze([
    S_('finN', 4, '枚', 'フィン枚数は諸元表に無い。CNα 11.8 と Cmq −2.96 を再現する枚数（Barrowman で CNα 11.807、Cmq −2.957）'),
    S_('finThick', 3, 'mm', 'フィン厚さは諸元表に無い（空力係数を直接入力するので影響は小さい）'),
    S_('finCant', 0, 'deg', 'フィン取付角は諸元表に無いため 0（ロールは起こさない）'),
    S_('engText', `仮定曲線（総力積 ${DEBUG_CURVE.I.toFixed(1)} N·s、作動時間 3.756 s）`, '',
      `諸元表に推力履歴が無いため、Isp ${ISP} s と仮定して（酸化剤 0.391 kg＋燃料消費 0.058 kg）×${ISP}×g0 の総力積で生成。${ASSUMED_NOTE}`),
    S_('payloadPos', 200, 'mm', 'ペイロードの重心位置は諸元表に無い（放出後の静安定に影響する）'),
    S_('payloadTime', 7, 's', '諸元表の注記は「点火から開傘まで」だが、本実装では点火からの放出時刻として扱う'),
    S_('rec1', 'apogee', '', '1段目の開傘条件は諸元表に記載がないため、頂点検知で開傘すると仮定'),
    S_('rec2', 'none', '', '2段目の開傘時刻・降下終端速度が空欄のため、2段目なし'),
    S_('openTime', 1, 's', 'パラシュートの展開所要時間は諸元表に無い'),
    S_('windDirRef', 'true', '', '風向の基準（真北/磁北）は諸元表に記載がないため真北とした'),
    S_('wind', 4, 'm/s', '単発計算用の風速（基準高さ 4 m での値）。落下分散では掃引する'),
    S_('windFrom', 270, 'deg', '単発計算用の風向（西から）。落下分散では掃引する'),
    S_('gust', 0, 'm/s', '単発計算では突風なし'),
    S_('temp', 20, '℃', '地上気温は諸元表に無い'),
    S_('lugAft', 0, 'mm', 'ランチラグの位置は諸元表に無い（レール長いっぱいで離脱判定）'),
    S_('landSurface', 'site', '', '着地面は諸元表に無い（射点と同じ高さの地面）'),
    S_('mLen', 600, 'mm', 'モーターの描画寸法（ハイブリッドの質量計算には使わない）'),
    S_('mDia', 60, 'mm', 'モーターの描画寸法（ハイブリッドの質量計算には使わない）'),
    S_('mOver', 0, 'mm', 'モーターの描画寸法（ハイブリッドの質量計算には使わない）'),
    S_('magDecl', 7.6, 'deg', '諸元表の値（+7.6、東偏）のまま。日本の磁気偏角は西偏（本様式では負）なので declCheck で警告が出る（値は変更しない）'),
  ]);

  return { DEBUG_PRESET, DEBUG_SUPPLEMENTS, fieldMap, importFile, exportXlsx, _buildWorkbook, ASSUMED_NOTE };
})();
