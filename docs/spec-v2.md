# spec-v2.1: 審査用諸元表（団体入力シート）対応 — 実装契約

目的: 学生ロケット射場審査で使う「団体入力シート」形式の諸元表（`test/fixtures/spec.xlsx`、機体名 Debug、
テキスト化したもの `test/fixtures/spec-dump.txt`）を **そのまま読み込んでシミュレーションできる** ようにする。
あわせて、シミュレータに無い機能を付け足す（ハイブリッド質量モデル、空力係数の直接入力、減衰係数、ロール・ジャイロ、
磁気偏角、べき法則の基準高さ、ノズル圧力推力、終端速度でのパラシュート指定、点火基準タイマー、ペイロード放出、
落下分散図と GO/NOGO 表、諸元表の入出力）。

この文書がファイル間の **唯一の契約**。キー名・関数名・単位・定義はここに従う。v2.0 からの変更は 3 者レビューの反映。

---

## 0. ファイル・担当・グローバル規約

| ファイル | 担当 | 内容 |
|---|---|---|
| `physics.js` | physics | 物理コア（DOM 非依存） |
| `test/physics-test.html` | physics | physics.js だけを読み込んで自己テストを走らせ、PASS/FAIL を表で表示する |
| `app.js`, `index.html`, `style.css`, `view3d.js`, `sw.js` | ui | 入力 UI、結果表示、2D/3D、結線 |
| `specsheet.js` | specsheet | 諸元表 xlsx の読込・書出し、Debug プリセット |
| `dispersion.js` | dispersion | 落下分散（風速×風向スイープ）、GO/NOGO 表、地図、CSV/KML |

**他担当のファイルは編集しない**。担当外の不具合を見つけたら、自分の進捗ジャーナルに書く。

### 0.1 読込順（index.html）
`three.min.js` → `OrbitControls.js` → `physics.js` → `specsheet.js` → `dispersion.js` → `app.js` → `view3d.js`

### 0.2 モジュール公開の書式（厳守）
- クラシックスクリプト（ES module ではない）。トップレベルの `const`/`let` は **window のプロパティにならない**。
- `specsheet.js`: `window.SpecSheet = (() => { …; return {…}; })();`
- `dispersion.js`: `window.Dispersion = (() => { …; return {…}; })();`
- `view3d.js`: `window.V3D = (() => { …; return {…}; })();`。末尾の呼出しも `window.V3D.setVisible(…)` にする。
  これで既存バグ（`const V3D` のため `window.V3D?.…` が常に何もしない）も直る。
- specsheet / dispersion / view3d は **読込時に DOM 操作・他モジュール呼出しをしない**（view3d は既存どおり自分の DOM の初期化だけしてよい）。
- **app.js → 他モジュール**: 必ず `window.SpecSheet` / `window.Dispersion` / `window.V3D` 経由で、存在チェックを付ける（`window.Dispersion?.markStale()`）。
  `window.SpecSheet` が無ければ諸元表関連ボタンを disabled にし、title を「specsheet.js を読み込めませんでした」とする。
- **他モジュール → app.js / physics.js**: グローバルは **裸の識別子** で、呼び出す時点で参照する（`window.cfg` は undefined なので使わない）。
  参照してよい app.js の名前: `cfg, model, sim, DEFAULTS, FIELDS, saveCfg, writeFields, runNominal, scheduleRun, applyCfg, download, fmtN, niceStep, $, $$, playIdx, playing, playT, PH_COL, phKey`。
  `cfg` は再代入されるので、参照を保持しない。計算の開始時に `const base = normalizeCfg(cfg)` でスナップショットを取る。

### 0.3 予約名（他ファイルで再宣言しない）
- physics.js のトップレベル名はこれだけにする: `G0 RE RAIR GAM D2R MOTORS SHAPES shapeFn genCurve parseEng motorClass machFactor atm buildModel mulberry32 gauss simulate noseR PHYS_DEFAULTS RHO0_SHEET G_SHEET normalizeCfg reviewValues REVIEW_LABELS flightSummary enuToLatLon cfgLenMm declCheck rotDeriv PHYS_UTIL`。
  これ以外のヘルパーは関数の内部に置くか、`const PHYS_UTIL = {…}` 1 個にまとめる。
- app.js の予約名: `$ $$ SCHEMA FIELDS NUM_FIELDS SAMPLE_ENG DEFAULTS STORE_KEY cfg loadCfg saveCfg applyCfg prep niceStep nice fmtN frame lineChart model sim playIdx playing playT lastFrame buildPanel writeFields refreshVisibility onField runTimer scheduleRun runNominal renderAll drawRocket renderStatic renderMotorInfo card f0 f1 f2 renderResults renderWarnings PH_COL PH_NAME phKey drawFlight trail drawSide legend equalRanges gridFrame windArrow drawTop updateHud playLoop CHARTS drawCharts MC_FIELDS mcData mcBusy buildMcForm runMc drawMc swData buildSweep runSweep drawSweep init redrawVisible download CHART_CSS`。
  app.js の `const CSS` は `CHART_CSS` に改名する（`window.CSS` を隠してしまうため）。ui が新しく足すトップレベル名は physics の名前と重複させない。
- specsheet.js / dispersion.js / view3d.js は、トップレベルに `window.X = …` 以外の名前を作らない。

### 0.4 外部ライブラリ（使う時点で動的に読み込む。URL は固定）
- SheetJS: `https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js`
- Leaflet: `https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js` と `…/leaflet/1.9.4/leaflet.min.css`

---

## 1. 座標・単位

- 物理座標: x=東、y=**真北**、z=上 [m]。原点は射点。磁気偏角の補正はすべて physics の中で済ませる。
- cfg の単位: 長さ mm、質量 g、角度 deg、時間 s（既存どおり）。慣性モーメントだけ kg·m²。
- **cfg の位置（重心・圧力中心など）は、すべて機体先端からの mm で持つ**。諸元表は後端基準なので、specsheet が `x_nose = L − x_aft` で変換する。
  `cfgLenMm(c) = c.noseLen + c.bodyLen + c.tailLen`（全長, mm）。
- UI だけで使う表示切替 `posRef`（'nose'|'aft'）。`pos:true` のキーは **`airCG, ballastPos, hDryCG, hOxCG, hTankOutlet, hFuelCG, cpManual, payloadPos` だけ**。
  表示は `+(L − x).toFixed(3)`、入力は `x = L − v`。L は常に `cfgLenMm(cfg)` を使う（model.L は使わない）。
  L が変わっても cfg の値（先端基準）は変えない。posRef==='aft' のときは、noseLen/bodyLen/tailLen が変わるたびに pos 欄の表示だけを書き直す（入力中の要素は除く）。
  posRef の切替は表示だけの変更なので、再計算も markStale もしない。ラベルの「（先端から）/（後端から）」と、機体図の CG/CP 表示も posRef に合わせる。
  `finAft`、`mOver`、`lugAft`、aeroTable の Xcp 列（常に先端基準）は変換しない。掃引とモンテカルロは cfg の値（先端基準）のまま使う。

---

## 2. cfg キー

### 2.0 既定値と正規化
- `PHYS_DEFAULTS` は **すべての cfg キー** の既定値をまとめた唯一の表とする。中身は、現行 app.js の DEFAULTS の値（`recMode`, `delay` を除く）と、本節の新規キーを合わせたもの。
  `engText` の既定値は `''`。UI 専用のキー（`name`, `posRef`）も含める（physics は使わない）。
- `normalizeCfg(c)` は入力を変更せず、新しいオブジェクトを返す。冪等であること。処理順:
  1. **旧キーの移行**: `c.recMode` があれば、rec1 の有無に関係なく必ず上書きする。
     dual→{rec1:'apogee',rec2:'altitude'}、apogee→{rec1:'apogee',rec2:'none'}、
     delay→{rec1:'burnout',rec1Time:(c.delay ?? 8),rec2:'none'}、none→{rec1:'none',rec2:'none'}。未知の値は dual 扱い。
     最後に `recMode` と `delay` を削除する。
  2. `{...PHYS_DEFAULTS, ...c}`。
  3. **補正**（値を直し、内容を `__warn`（文字列配列, 非列挙プロパティでもよい）に記録する。buildModel はこれを `M.warn` に引き継ぐ）:
     - windExp > 1 のときは n が入力されたとみなして 1/windExp とする。その後 [0, 1] に収める。
     - windRef ≥ 0.1、hBurnTime ≥ 0.01、hFuelPost ≤ hFuelPre、openTime ≥ 0。
     - payloadMass ≥ 0.5×燃焼終了時質量なら payloadOn=false。
     - cmq/clp は数値か `null` だけを許す（空文字は null にする）。
- app.js は `const DEFAULTS = normalizeCfg({ engText: SAMPLE_ENG })` とし、既定値を二重に持たない。
- `buildModel(c)` は内部で normalizeCfg を呼ぶ。`M.warn: string[]` を持つ（補正内容、hBurnTime > 作動時間、慣性の下限張り付き、慣性の単位疑い など）。

### 2.1 基本
| key | 型/単位 | 既定 | 意味 |
|---|---|---|---|
| `name` | string | `'MyRocket'` | 機体名 |
| `posRef` | 'nose'\|'aft' | `'nose'` | UI の位置表示の基準 |

### 2.2 射点・ランチャー・風・着地面
| key | 単位 | 既定 | 意味 |
|---|---|---|---|
| `lat` | deg | `35.177228` | 射点緯度 |
| `lon` | deg | `140.357056` | 射点経度 |
| `magDecl` | deg | `0` | 磁気偏角。**東偏 +、西偏 −** |
| `azimRef` | 'true'\|'magnetic' | `'true'` | `azim` の基準。真方位 = azim + (magnetic ? magDecl : 0) |
| `windDirRef` | 'true'\|'magnetic' | `'true'` | `windFrom` の基準。真風向 = windFrom + (magnetic ? magDecl : 0) |
| `windRef` | m | `10` | べき法則の基準高さ（`wind` はこの高さでの風速） |
| `lugAft` | mm | `0` | 機体後端から最後尾ランチラグまでの距離。レール離脱は sAlong ≥ railLen − lugAft/1000 で判定する（0 なら現行と同じ） |
| `landSurface` | 'site'\|'sea' | `'site'` | 着地面。'sea' のとき、本体・ペイロードとも z ≤ −siteAlt で着地とする |

- 既存のキー `siteAlt`（射点標高＝海面高度）, `azim`, `elev`, `railLen`, `wind`, `windFrom`, `windExp`, `gust` はそのまま使う。
- 風速は `w(z) = wind · (max(z, 1) / windRef) ^ windExp`。`windExp` は α = 1/n で、諸元表の「べき指数 6」は 1/6 にあたる。
- 大気の高度は `h = max(siteAlt + z, 0)`。
- `declCheck(lat, lon, magDecl) -> null | string`: 緯度 24〜46°、経度 122〜154° の範囲（日本域）で、magDecl が [−11, −3] の外にあれば
  「日本の磁気偏角は西偏（本様式では負）。符号を確認してください（現在 {値}°）」を返す。値は自動で反転しない。

### 2.3 質量モデル
| key | 単位 | 既定 | 意味 |
|---|---|---|---|
| `massMode` | 'motor'\|'hybrid' | `'motor'` | motor: 既存の機体＋固体モーター。hybrid: 諸元表の方式 |
| `hDryMass` | g | `6190` | 乾燥質量。**液体酸化剤だけを除いた**機体の全質量（燃焼前の燃料グレインとペイロードを含む） |
| `hDryCG` | mm(先端) | `1008.52` | 乾燥時の重心 |
| `hOxMass` | g | `391` | 満充填時の酸化剤質量 |
| `hOxCG` | mm(先端) | `1224` | 酸化剤単体の初期重心 |
| `hTankOutlet` | mm(先端) | `1379.14` | タンク口金の位置 |
| `hFuelPre` | g | `380` | 燃焼前の燃料（グレイン）質量 |
| `hFuelPost` | g | `322` | 燃焼後の燃料質量 |
| `hFuelCG` | mm(先端) | `1489.57` | 燃料グレイン単体の重心 |
| `hBurnTime` | s | `2.393` | 燃焼時間（質量流量が続く時間）。作動時間とは別 |
| `hOpTime` | s | `0` | 諸元表の作動時間（保持と表示・検査だけに使う。0 は未設定） |
| `hOxDrain` | bool | `true` | 排出に伴い、酸化剤の重心が口金へ移動する |

hybrid の時間変化（`M.tIgn` = 推力が初めて 0.05·Fmax 以上になる時刻。曲線の t=0 が点火時刻で、ゼロ推力区間は削らない）:
- `f = clamp(1 − (t − tIgn)/hBurnTime, 0, 1)`。酸化剤も燃料も **線形** に消費する（諸元表の一定質量流量と同じ）。
- `m_ox = hOxMass·f`、`Δm_f = (hFuelPre − hFuelPost)·(1 − f)`、`x_ox = hOxDrain ? hTankOutlet + f·(hOxCG − hTankOutlet) : hOxCG`
- `m = hDryMass + m_ox − Δm_f + ballast − (放出済みなら payloadMass)`
- `cg = (hDryMass·hDryCG + m_ox·x_ox − Δm_f·hFuelCG + ballast·ballastPos − [rel]·payloadMass·payloadPos) / m`
- hybrid では `mProp`, `mTotal` を使わない（`mLen`, `mDia`, `mOver` は描画にだけ使う）。motor モードは既存どおりで、ペイロードは `airMass` に含まれるものとする。
- `M.tEnd = max(M.tb, tIgn + hBurnTime)`（motor では M.tb）。massAt は t ≥ tEnd で一定値を返す。燃焼後の表示と reviewValues の *Burnout は `massAt(M.tEnd)` を使う。

### 2.4 慣性モーメント
| key | 単位 | 既定 | 意味 |
|---|---|---|---|
| `inertiaMode` | 'auto'\|'manual' | `'auto'` | |
| `Ipitch` | kg·m² | `1.5` | 乾燥時（hybrid: hDryMass、motor: airMass）の乾燥重心まわりのピッチ・ヨー慣性 |
| `Iroll` | kg·m² | `0.09` | 乾燥時のロール慣性 |

- 現在重心まわりのピッチ慣性: `I_t = I_dry + m_dry·(x_dry − cg)² + Σ m_i·(x_i − cg)²（自己慣性を含む）`。
  hybrid では酸化剤を点質量として `+m_ox·(x_ox − cg)²`、消費した燃料は `−Δm_f·(hFuelCG − cg)²`、放出後のペイロードは `−m_p·(payloadPos − cg)²`。
  auto のときは、motor は既存の近似、hybrid は `I_dry = (hDryMass/1000)·L²/12`。
- 下限は `I_t ≥ 0.01·m·L²`。下限に当たったら M.warn に記録する。manual で Ipitch が [0.02, 0.3]·m_dry·L² の外なら「単位（kg·m²）を確認」と M.warn に入れる。
- ロール: auto は `I_r = 0.5·m·(d/2)²`。manual は `I_r = Iroll` とし、**酸化剤分は加えない**（液体は機体のロールに追従しないため）。下限は `0.05·m·(d/2)²`。

### 2.5 空力
| key | 単位 | 既定 | 意味 |
|---|---|---|---|
| `aeroMode` | 'barrowman'\|'manual' | `'barrowman'` | manual: 諸元表の値を直接使う |
| `cpManual` | mm(先端) | `1258` | 圧力中心 |
| `cnaManual` | 1/rad | `11.8` | 全機法線力傾斜 |
| `cmq` | – または null | `-2.96` | ピッチ・ヨー減衰モーメント係数（null なら barrowman 由来の値） |
| `clp` | – または null | `-0.14` | ロール減衰モーメント係数（null なら strip theory 由来の値） |
| `aeroTable` | text | `''` | 任意。行 `Mach,Cd[,CNa[,Xcp_mm(先端)]]`。空でなければ線形補間（範囲外はクランプ）で定数を上書きする |
| `finCant` | deg | `0` | フィン取付角（ロールを起こす） |

- manual: 軸力係数（迎角 0 の Cd）は `cdManual` を使い、`cdMode` は無視する。`cdScale` は両モードで掛ける。manual では `machCorr` を掛けない。
  aeroTable に Cd 列があれば、それに cdScale を掛けた値を使う。CNa・Xcp 列があれば、両モードとも定数を上書きする。
- すべての式の V は **対気速度 V_a**。L = 全長 [m]、A = π·d²/4。
- **ピッチ・ヨー減衰**:
  - manual（cmq が数値）: `M = 0.25·ρ·V_a·A·L²·Cmq·ω⊥`。Barrowman の Σ 項は使わない（置き換える）。
  - barrowman、または cmq が null: `M = −0.5·ρ·V_a·A·(s2 − 2·cg·s1 + cg²·s0)·ω⊥`（既存の式）。
- **ロール減衰**: `M = 0.25·ρ·V_a·A·L²·Clp·p`（**L 基準**。Cmq と同じ基準長）。
  barrowman、または clp が null のとき: `Clp = clpEq = −4·CNα_F·r_g²/L²`。
  `r_g² = (1/S_f)·∫_R^{R+s} c(r)·r² dr`、`c(r) = Cr + (Ct − Cr)(r − R)/s`、`S_f = (Cr + Ct)·s/2`。
  CNα_F は干渉係数込みのフィン群の CNα。barrowman では cpAt(mach) のフィン成分（Prandtl–Glauert 補正込み）、manual ではマッハ 0 の幾何値を使う。
- **フィン取付角による励起**: `M_cant = 2·CNα_F·q·A·δ·(R + Ymac)`。`Ymac = s/3·(Cr + 2Ct)/(Cr + Ct)`、q は対気動圧、δ > 0 で +u まわりに正。phase 1 のときだけ働く。
- 検算（Debug 形状、barrowman、finN=4）: CNα = 11.807±0.01、xcp（後端から）≈ 338.5 mm（シートの 342 との差 3.5 mm は許容）、
  乾燥重心まわりの cmqEq = −2.957±0.01、CNα_F = 9.807、R + Ymac = 0.12209 m、r_g² = 0.016408 m²、clpEq = −0.251。
  シートの Clp −0.14 は L 基準で見て同じ桁にある。manual で finCant ≠ 0 かつ |clp| が 0.2·|clpEq| 未満か 5·|clpEq| 超なら、
  M.warn に「ロール減衰係数の基準長（全長 L）を確認」を入れる。

### 2.6 回転運動（状態と方程式）
- 状態: `y[0..2]` 位置、`y[3..5]` 速度、`y[6..8]` = u（機軸の単位ベクトル）、`y[9..11]` = ω⊥（世界座標で u に垂直）、`y[12]` = p [rad/s]、`y[13]` = φ（ロール角）[rad]。
- `du/dt = ω⊥ × u`
- `dω⊥/dt = (τ⊥ − I_r·p·(ω⊥ × u)) / I_t`（τ⊥ = τ − (τ·u)u）
- `dp/dt = τ_ax / I_r`（τ_ax = M_cant + M_rolldamp）、`dφ/dt = p`
- I_t と I_r には massAt(t) の瞬時値を使う。`d(Iω)/dt` や `−İω` の項は入れない（ジェットダンピングは省略）。
  ペイロード放出やパラ展開で I が不連続に変わっても、ω⊥ と p は連続のままにする。
- 各ステップの後に u を正規化し、`ω⊥ ← ω⊥ − (ω⊥·u)u` で u に垂直へ戻す。
- phase 0（レール上）: ω⊥ = 0、p = 0。φ は固定し、ロールの励起も減衰も計算しない。phase 2: ω⊥ = p = 0、φ は最後の値を保つ。
- `rotDeriv(u, w, p, tau, It, Ir) -> {du, dw, dp}` をグローバル関数として公開し、テストに使う。

### 2.7 推進
| key | 単位 | 既定 | 意味 |
|---|---|---|---|
| `nozzleExitD` | mm | `0` | ノズル出口直径。> 0 なら圧力推力を補正する |
| `thrustKind` | 'measured'\|'assumed' | `'measured'` | specsheet が仮定曲線を作ったときだけ 'assumed'。UI で推力関連のキー（motorSrc, engText, mI, mTb, mShape, motorPreset, thrustScale）を手で変えたら 'measured' に戻す |

- 推力曲線（既存の `motorSrc / mI / mTb / mShape / engText / thrustScale`）は両モードで共通。曲線の終わりの時刻 `M.tb` が作動時間。
- 圧力推力: `F = F_curve + (p_site − p(h))·A_e·min(1, F_curve/(0.05·F_max))`。F_curve > 0 のときだけ加える。
  `p_site = atm(M, siteAlt).p`、`p(h) = atm(M, max(siteAlt + z, 0)).p`。検算: Debug、z=1000 m、推力最大付近で ΔF = 2.9 ± 0.1 N。
- thrustKind === 'assumed' のときは、結果・分散図・書出しの全シートの先頭に
  「推力履歴は仮定（Isp 170 s）。審査提出には地上燃焼試験の推力履歴を使用すること」を表示する。

### 2.8 ペイロード
| key | 単位 | 既定 | 意味 |
|---|---|---|---|
| `payloadOn` | bool | `false` | ペイロードを放出する |
| `payloadMass` | g | `250` | ペイロード質量（機体質量に **含まれる**） |
| `payloadPos` | mm(先端) | `200` | ペイロードの重心（諸元表に無いので補完する項目） |
| `payloadTime` | s | `7` | 放出時刻（**点火から**）。諸元表の注記では「開傘まで」だが、本実装では放出時刻として扱い、補完項目に記載する |
| `payloadVt` | m/s | `6` | ペイロードの降下終端速度。`CdS_p = 2·m_p·G_SHEET/(RHO0_SHEET·Vt²)` |

- 放出は積分ステップの境界でだけ行う（t ≥ payloadTime となった最初のステップの終わり）。
  phase 0 中ならレール離脱後の最初のステップまで延ばす。本体の着地後なら放出しない。
- 放出直前の状態（r, v, u, ω⊥, cg_old）と x_p = payloadPos[m] から、`r_p = r + (cg_old − x_p)·u`、`v_p = v + ω⊥ × ((cg_old − x_p)·u)` とする。
  本体は `cg_new = massAt(t, true).cg` を使い、`r ← r + (cg_old − cg_new)·u`、`v ← v + ω⊥ × ((cg_old − cg_new)·u)` と補正する。ω⊥ と p は変えない。
- ペイロードは同じメインループで、同じ外側ステップ・同じ gust 状態を使って並行に積分する。
  `a_p = −g·ẑ − (0.5·ρ·|v_rel|·CdS_p·r(t)/m_p)·v_rel`、`r(t) = clamp((t − t_rel)/openTime, 0, 1)`、`v_rel = v_p − w(z_p)`。
- 本体が先に着地したら、本体の記録を止めてペイロードの着地までループを続ける。ペイロードで非有限値が出たら `payload.error` に記録し、本体の結果は有効のままにする。
- `opt.ballistic` でも放出は行う（放出機構は回収系とは独立とみなす）。

### 2.9 回収系（`recMode` を置き換える）
| key | 単位 | 既定 | 意味 |
|---|---|---|---|
| `rec1` | 'apogee'\|'ignition'\|'burnout'\|'none' | `'apogee'` | 1段目の開傘条件。apogee: vz<0 を検出してから rec1Delay 後。ignition: 点火から rec1Time。burnout: 作動終了（M.tb）から rec1Time |
| `rec1Time` | s | `8` | |
| `rec1Delay` | s | `0` | 頂点検知の遅れ |
| `rec1Backup` | s | `0` | rec1:'apogee' の冗長タイマー（点火から。0 はなし）。早い方で開傘し、`ev.deploy1.by = 'apogee'\|'timer'` を記録する |
| `rec2` | 'none'\|'altitude'\|'ignition' | `'altitude'` | 2段目。altitude: 1段目の展開後に z ≤ mainAlt。ignition: 点火から rec2Time |
| `rec2Time` | s | `60` | |
| `chuteSpec` | 'diameter'\|'velocity' | `'diameter'` | |
| `c1Vt` | m/s | `8.08` | velocity 指定での 1段目の終端速度 |
| `c2Vt` | m/s | `5` | velocity 指定での 2段目の終端速度（全系） |
| `dtApoWarn` | s | `1.5` | 開傘・放出が頂点から何秒以上ずれたら警告するか |

- 既存の `c1D, c1Cd, c2D, c2Cd, mainAlt, openTime` は diameter 指定のときに使う。
- velocity 指定: `CdS_i = 2·m_ref·G_SHEET/(RHO0_SHEET·Vt_i²)`。m_ref は **燃焼終了時の全機質量（ペイロード込み）**、`RHO0_SHEET = 1.2`、`G_SHEET = 9.81`。
  検算（Debug）: 1段目の CdS = 1.53567 m²、ペイロードの CdS = 0.113542 m²。
- 展開率 `r_i(t) = tc_i ≥ 0 ? clamp((t − tc_i)/openTime, 0, 1) : 0`（openTime = 0 なら即座に 1）。
  - diameter: `CdA = A·cd0 + c1CdA·r1 + c2CdA·r2`（ドローグは付いたまま、加算）
  - velocity: `CdA = c1CdA·r1·(1 − r2) + c2CdA·r2`（機体抗力は加えない。終端速度の定義を守るため）
- 不変条件（physics が保証する）:
  (1) rec1 === 'none' なら一切展開しない（rec2 も無視する）。
  (2) rec2 の条件が deploy1 より先に成り立ったら、その瞬間に deploy1 と deploy2 を同時に起こし、`ev.deploy2.beforeDeploy1 = true` とする。
  (3) phase 0 では展開しない。条件が成り立っていれば、レール離脱の直後に展開する。
  (4) `opt.ballistic` のときは ev.deploy1/2 を作らない。
  → `ph === 2 ⇒ ev.deploy1 がある`、`ev.deploy2 ⇒ deploy2.t ≥ deploy1.t` が常に成り立つ。
- 時刻 t = 0 は推力曲線の t = 0（点火）。rec1Time / rec2Time / payloadTime はこの t から数える。

---

## 3. physics.js の公開 API

```
PHYS_DEFAULTS, RHO0_SHEET = 1.2, G_SHEET = 9.81
normalizeCfg(c) -> c'
cfgLenMm(c) -> mm
buildModel(c) -> M
simulate(M, opt) -> {rec, ev, st, payload}      // 常に4キー。payload は null 可
reviewValues(M) -> object
REVIEW_LABELS: [[key, 項目名, 単位], …]          // 表示順。項目名は審査用/分野別確認シートの表記
flightSummary(M, sim) -> object
enuToLatLon(lat0, lon0, x, y) -> [lat, lon]      // lat = lat0 + y/RE·180/π, lon = lon0 + x/(RE·cos lat0)·180/π
declCheck(lat, lon, magDecl) -> null|string
rotDeriv(u, w, p, tau, It, Ir) -> {du, dw, dp}
noseR(M, x)
```

### 3.1 M（既存のフィールドは維持する）
`M.c`（正規化済み cfg）, `M.warn`, `M.name`, `M.L`, `M.d`, `M.R`, `M.A`, `M.Ln`, `M.Lb`, `M.Lt`, `M.dBase`, `M.Xb`, `M.Cr`, `M.Ct`, `M.s`, `M.Xs`, `M.N`,
`M.mLen`, `M.mDia`, `M.motorX`, `M.mName`, `M.cd0`, `M.cdEst`, `M.pts`, `M.Itot`, `M.tb`（作動時間＝曲線の終わり）, `M.tIgn`, `M.burnTime`, `M.tEnd`,
`M.trueAzim`（rad。`M.azim` も同じ値）, `M.elev`, `M.railLen`, `M.wdir`（真の風下方向の単位ベクトル [東, 北]）, `M.windRef`, `M.openTime`, `M.lat`, `M.lon`, `M.massMode`,
`M.massAt(t, released = false) -> {m, cg, I, Ir}`（cg は先端からの m）, `M.cpAt(mach) -> {cna [1/rad], xcp [m, 先端から], s0, s1, s2}`, `M.cdAt(mach)`, `M.thrust(t)`,
`M.c1CdA`, `M.c2CdA`, `M.payloadCdA`（m²）, 描画用の等価直径 `M.c1Dia`, `M.c2Dia`, `M.payloadDia` [m]
（diameter 指定なら c1D/1000 など。velocity 指定なら `2·sqrt(CdA/(π·0.8))`）。
view3d は `cfg.c1D` / `cfg.c2D` の代わりにこれらを使う。

### 3.2 simulate(M, opt)
- `opt.seed`（既定 1）, `opt.record`（既定 true）, `opt.ballistic`（true なら回収系を展開しない。ペイロードの放出は行う）,
  `opt.wind = {speed, from}`（指定すると cfg の wind / windFrom を上書きし、gust を 0 にする。`from` は windDirRef 基準）。
- **刻み幅**（硬さ対策）: phase 1 では外側ステップ（M.dt）の開始時に
  `ω_n = sqrt(q·A·CNα·|xcp − cg|/I_t)`、`λ_q = c_pitch/I_t`、`λ_p = c_roll/I_r`、`λ_g = I_r·|p|/I_t` を求める。
  `h_sub = min(M.dt, 1/max(ω_n, λ_q, λ_p, λ_g, 1e-9))`、`n = ceil(M.dt/h_sub)` でサブステップする。
  n > 200 なら `ev.error = '回転運動が硬すぎます（慣性モーメント・減衰係数の単位を確認）'` として止める。
  phase 2 とペイロードでは `λ_d = ρ·CdA·V_a/m` を使い、`h = min(0.02, 0.5/λ_d)` でサブステップする。gust の更新は外側ステップごとのまま。
- `rec[i]`: 既存の `t,x,y,z,vx,vy,vz,V,va,mach,g,alpha,q,T,m,sm,ux,uy,uz,ph` に加えて、
  `roll`（rad。点火時 0 から ∫p dt を **mod 2π しない** で保持し、ph = 2 では止める）, `p`, `cg`（m, 先端から）, `fst`（%）。
- `ev`: 既存の `liftoff, railExit, burnout{t,z,V}, apogee{t,z,V}, deploy1, deploy2, landing{t,x,y,V,vz}, error` を保つ。
  `railExit` は `{t, V, va, sm, alphaW}`。alphaW [deg] = atan2(|w⊥|, V)。w⊥ は離脱高度でのべき法則の風速（gust なし）のうち、レールに直交する成分。
  `deploy1` / `deploy2` は `{t, z, V(対気), vz, q, by?, beforeDeploy1?}`、`payload` は `{t, z, V(対気), q}`。`ev.burnout.t` = M.tb。
- `st`: 既存の `maxV, maxMach, maxG, maxQ, maxAlpha, minSM, apogee, apoT, apoX, apoY` に `maxRollRate` を加える。
- `payload`: null、または `{release:{t,x,y,z,V}, rec:[{t,x,y,z,V}], landing:{t,x,y,V,vz} | null, error?}`。
  rec は release から 0.1 s ごとに記録し、landing で終わる。record:false のとき rec は [] だが、release と landing は必ず入れる。

### 3.3 reviewValues(M)（ペイロード放出前 = released:false で計算する）
```
L_mm, d_mm, trueAzim_deg,
massWet_kg, massDry_kg (hybrid: hDryMass / motor: 点火時の全質量), massBurnout_kg (massAt(tEnd)),
cgWet_aft_mm, cgDry_aft_mm (hybrid: hDryCG), cgBurnout_aft_mm, cgWet_nose_mm, cgDry_nose_mm, cgBurnout_nose_mm,
cp_aft_mm, cp_nose_mm (静的: mach 0 / manual), cna, cd0,
fstWet_pct, fstDry_pct, fstBurnout_pct      // = (cg_aft − cp_aft)/L × 100
smWet_cal, smBurnout_cal,
cgAfterPayload_aft_mm, fstAfterPayload_pct, smAfterPayload_cal   // 燃焼終了時からペイロードを除いた値
oxFlow_kgps, fuelFlow_kgps (hybrid のみ), propFlow_kgps,
burnTime_s, opTime_s (hOpTime、0 なら M.tb), opTimeCurve_s (0.1·Fmax を最初に超えてから最後に下回るまで), totalImpulse_Ns, motorClass, avgThrust_N, ispEff_s (Itot/(推進剤質量·G0)),
cdS1_m2, cdS2_m2, cdSPayload_m2, vt1_mps, vt2_mps, vtPayload_mps,
IpitchWet, IpitchBurnout, IrollWet, cmqEq, clpEq
```
- vt は `sqrt(2·m_ref·G_SHEET/(RHO0_SHEET·CdS))`。CdS2 は diameter なら c1CdA + c2CdA、velocity なら c2CdA。vtPayload は payloadMass と CdS_p で計算する。
- `cmqEq = −2·(s2 − 2·cg·s1 + cg²·s0)/L²`（cpAt(0)、cg は hybrid なら hDryCG、motor なら massAt(tb).cg。manual で cmq が数値なら cmq）。
- 該当しない値（motor の ox/fuel、rec2 なしの cdS2/vt2、payloadOn=false のペイロード関連）は **null**。UI は「—」、xlsx は空セル。
- 検算（Debug、ballast 0、inertia manual。相対 1e-4）:
  massWet 6.581、massBurnout 6.132、cgWet_aft 578.678、cgBurnout_aft 596.030、cgDry_aft 591.48、fstWet 14.792、fstDry 15.593、
  cdS1 1.53567、cdSPayload 0.113542、oxFlow 0.163393、fuelFlow 0.0242374、propFlow 0.187631、
  IpitchWet 1.51708、IpitchBurnout 1.48645、smWet_cal 1.8206。
  放出後の massAt(t ≥ payloadTime, true): m = 5.882、cg = 先端から 1038.14 mm、I = 1.31799。

### 3.4 flightSummary(M, sim)
UI の結果カード、specsheet の「飛行結果」シート、dispersion の表と CSV は、すべてこの関数の値を使う。発生しなかった項目は NaN。
```
railExit_t_s, railExit_V_mps(対地), railExit_alphaW_deg,
maxV_mps, maxV_t_s, maxMach, maxQ_Pa, maxQ_t_s, maxAcc_G     // 離床から頂点までの上昇区間だけ
opEnd_t_s(=M.tb), opEnd_z_m, opEnd_V_mps, burnEnd_t_s,
apogee_m, apogee_t_s, apogee_range_m,
deploy1_t_s, deploy1_z_m, deploy1_Va_mps, deploy1_q_Pa, deploy1_dtApo_s, deploy1_by,
deploy2_t_s, deploy2_z_m, deploy2_Va_mps, deploy2_q_Pa, deploy2_dtApo_s,
payload_t_s, payload_z_m, payload_Va_mps, payload_q_Pa, payload_dtApo_s, payloadOpenLoad_N (= payload_q_Pa·cdSPayload), payloadOpenLoad_G,
descent1_mps (1段目展開後、2段目展開前の最後の |vz|), landing_t_s, landing_V_mps, landing_vz_mps, landing_dist_m, landing_brgTrue_deg,
payloadLanding_dist_m, payloadLanding_brgTrue_deg, payloadLanding_vz_mps, flightEnd_t_s (= max(本体着地, ペイロード着地))
```

### 3.5 test/physics-test.html（physics.js だけを読み込む）
検査する項目:
- §3.3 の検算値。
- 旧キーの移行（`{recMode:'none'}` から rec1 'none'、delay の移行、冪等性）。
- motor モードの回帰: `simulate(buildModel(normalizeCfg({})))` の頂点高度が約 1636 m ±3%。
- rotDeriv: u0 = (0,0,1)、ω⊥ = (0.5,0,0)、p = 20、I_t = 1.5、I_r = 0.09、τ = 0 で、RK4（h = 0.003）を 10 s 回す。
  `H = I_t·ω⊥ + I_r·p·u` について |H − H0|/|H0| < 1e-6、|ω⊥·u| < 1e-9、歳差角速度が |H|/I_t と相対 1e-4 以内で一致すること。
- barrowman、Debug 形状、finCant = 1° で、燃焼終了時の |p| が V_a·δ·(R + Ymac)/r_g² の ±30% 以内。
- Debug（velocity 指定、無風、rec1 apogee）で、1段目展開の 5 s 後以降かつ z < 50 m のとき、|vz| が 8.08·sqrt(m/6.132)·sqrt(1.2/ρ(z)) の ±1% 以内。
- ペイロード: 着地すること、本体より後に着地しても記録されること、opt.ballistic でも放出されること。
- aeroTable の補間、圧力推力（ΔF ≈ 2.9 N @1 km）、declCheck（Debug の +7.6 で警告が出る）、lugAft、landSurface 'sea'。
- 硬さ: Ipitch = 0.0015 の manual でも NaN にならない（サブステップが効くか、エラーメッセージで止まる）。

---

## 4. specsheet.js（`window.SpecSheet`）

```
SpecSheet.DEBUG_PRESET            // cfg パッチ（Debug 諸元表＋補完値）。ballast: 0
SpecSheet.DEBUG_SUPPLEMENTS       // [{key,label,value,unit,reason}]
SpecSheet.fieldMap                // [{item, subItem, key, unit, conv:'aft'|'kg'|'invN'|null}]
SpecSheet.importFile(fileOrArrayBuffer, baseCfg) -> Promise<{patch, imported, supplemented, warnings}>
SpecSheet.exportXlsx(cfg, model, sim) -> Promise<void>    // ダウンロードは app.js の download() か SheetJS の writeFile で行う
```
- `imported`: `[{key,label,value,unit,sheetLabel,sheetValue,sheetUnit}]`。value は cfg の単位で、位置は先端基準。
- `supplemented`: `[{key,label,value,unit,reason}]`。**諸元表に無いがシミュレーションに必要な項目**で、値は baseCfg（現在の cfg）から取るか、妥当な仮定を置く。
- 失敗したとき（SheetJS が読めない、シートが無い、必須ラベルが無い）は `reject(new Error(日本語メッセージ))` を返す。
- **patch に必ず含めるキー**: `name, massMode:'hybrid', aeroMode:'manual', inertiaMode:'manual', chuteSpec:'velocity', motorSrc:'eng', motorPreset:'custom', tailLen:0, azimRef:'magnetic', posRef:'aft', ballast:0`
  （ただし空欄規則でモードが変わる場合はそれに従う）。

### 4.1 読込
- 対象シートは「団体入力シート」（無ければ先頭のシート）。行は **列C（SubItem）のラベル** で探す。行番号には依存しない。
  同じラベル（降下終端速度など）は、直前の列B の見出し（リカバリ（1段階目）/（2段階目）/ペイロード）で区別する。値は列D、単位は列E、機体名だけは B「機体名」の行の D 列。
- 値のセルは NFKC 正規化してから数値にする（文字列の数値や全角数字も可）。数値でないものと空欄は「空欄」とする。
  単位のセルが空欄なら fieldMap の既定の単位とみなす。既知の別単位（m/mm、kg/g、kg・m2 / kg·m² / kgm2）は換算し、未知の単位は warnings に入れて既定の単位として扱う。
- 変換:
  - 全長 L とノーズ長から `bodyLen = L − noseLen`、`tailLen = 0`。
  - 位置は `x_nose = L − x_aft`。質量は kg → g。
  - べき指数 n → `windExp = 1/n`、基準高さ → `windRef`、磁気偏角 → `magDecl`、打上方位角 → `azim`（`azimRef:'magnetic'`）、射角 → `elev`、レール長さ → `railLen`、海面高度 → `siteAlt`、緯度経度 → `lat`/`lon`。
  - 代表直径 → `d`。乾燥質量など → `hDryMass, hOxMass, hFuelPre, hFuelPost`。重心 → `hDryCG, hOxCG, hTankOutlet, hFuelCG`。慣性 → `Ipitch, Iroll`。
  - 圧力中心 → `cpManual`、軸力係数 → `cdManual`、法線力傾斜 → `cnaManual`、減衰 → `cmq`, `clp`。ノズル出口直径 → `nozzleExitD`、燃焼時間 → `hBurnTime`。
  - 作動時間（分野別確認項目）→ `hOpTime`。
  - 1段目の降下終端速度 → `c1Vt`（`rec1:'apogee'`。開傘条件は諸元表に無いので仮定とし、supplemented に入れる）。
  - 2段目: 開傘時刻・終端速度とも値があれば `rec2:'ignition', rec2Time, c2Vt`。
  - ペイロード: 3 項目がそろっていれば `payloadOn:true, payloadTime, payloadVt, payloadMass`。
  - ノーズ形状 "Cone"/"Ogive"/"Parabolic"（大文字小文字は区別しない）→ 'cone'/'ogive'/'parabolic'。
  - フィン: オフセット → `finAft`、Cr → `finCr`、Ct → `finCt`、Cle → `finSweep`、半スパン → `finSpan`。
- 空欄の規則（どれも supplemented か warnings に記録する）:
  - 1段目の終端速度が空欄か ≤ 0 → `rec1:'none'`（warning「回収系なし＝弾道落下」）。
  - 2段目は、両方空欄か ≤ 0 なら `rec2:'none'`。片方だけなら `rec2:'none'` にして warning。
  - ペイロードは、3 つとも空欄なら `payloadOn:false`。一部だけなら false にして warning。
  - 慣性のどちらかが空欄 → `inertiaMode:'auto'`。圧力中心か法線力傾斜が空欄 → `aeroMode:'barrowman'`。軸力係数が空欄 → `cdMode:'auto'`。
  - Cmq / Clp が空欄 → null。タンク口金が空欄 → `hOxDrain:false`。
  - ノズル出口直径・フィンオフセット・海面高度が空欄 → 0。磁気偏角が空欄 → 0 と warning。
  - 作動時間が空欄 → `hOpTime:0`（仮定曲線では 1.2·燃焼時間を使い、supplemented に入れる）。
  - 必須項目（代表直径、全長、乾燥質量、乾燥時重心、燃焼時間、ノーズ長さ、フィン寸法）が空欄 → baseCfg の値を残し、warning「必須項目が空欄」。
  - 上で 0 とする 3 項目以外では、空欄を 0 として書かない。
- `declCheck` の結果は warnings に入れる（Debug では出る）。
- **推力**: シート「推力履歴」（t[s], F[N] の 2 列）があればそれを使い、`engText` にして `thrustKind:'measured'` とする。
  無ければ仮定の曲線を生成して `thrustKind:'assumed'` とし、supplemented に入れる。
  - 総力積 `I = (hOxMass + hFuelPre − hFuelPost)/1000 · 170 · G0`（Debug では 748.5 N·s）。
  - 0〜t_b（= hBurnTime）は `shapeFn('regressive', t/t_b)`（立上りは shapeFn の up を使う。t_b での下がりは無視して定常部の値を使う）。
  - t_b〜t_op（= hOpTime。0 なら 1.2·t_b）は `F_b·(e^{−k(t−t_b)} − e^{−k(t_op−t_b)})/(1 − e^{−k(t_op−t_b)})`、`k = 4/(t_op − t_b)`。最終点は必ず (t_op, 0)。
  - 全体を I に合わせて正規化する。`engText` に "t F" 行で入れる（.eng ヘッダは付けない）。テスト: `M.tb = t_op`（±1e-9）、Itot ±0.5%。
- **往復**: シート「シミュレータ追加諸元」（key, 項目名, 値, 単位, 説明）があれば、その値で上書きする（型は `typeof DEFAULTS[key]` に合わせる。
  number は parseFloat、boolean は true/TRUE/1、string はそのまま、null 許容キーは空欄を null）。DEFAULTS に無いキーは無視して warnings に入れる。

### 4.2 書出し（`<name>_諸元表.xlsx`）
- 「団体入力シート」: 元の様式（見出し、更新日、Item / SubItem / Value / Unit / Note 列、各行の Note の文言）を再現する。値は後端基準、質量は kg。
  - 打上方位角 = (trueAzim_deg − magDecl) mod 360（常に磁北基準）。べき指数 = 1/windExp（windExp ≤ 0 なら空欄にして warning）。基準高さ = windRef。
  - 1段目の終端速度: velocity なら c1Vt、diameter なら sqrt(2·m_ref·G_SHEET/(RHO0_SHEET·c1CdA))。
  - 2段目: rec2:'none' なら両セル空欄。'ignition' なら rec2Time と Vt2。'altitude' なら、開傘時刻の欄にノミナル計算の ev.deploy2.t を書き、Note に「高度 mainAlt m 開傘の予測時刻」と書く。
  - ペイロード: payloadOn が false なら 3 セルとも空欄。
  - massMode:'motor' のとき: 乾燥質量 = 点火時の全質量、乾燥時重心 = 点火時の重心、酸化剤 = 0、初期酸化剤重心と口金は空欄、燃焼前燃料 = 推進剤質量、燃焼後燃料 = 0、燃料重心 = motorX、燃焼時間 = 作動時間 = M.tb。
  - aeroMode:'barrowman' のとき: 圧力中心・CNα は cpAt(0) の値、Cmq は cmqEq、Clp は clpEq、軸力係数は cd0。
  - 作動時間 = hOpTime（0 なら M.tb）。
- 「シミュレータ追加諸元」: `Object.keys(DEFAULTS)` のうち fieldMap に無いキーを全部入れる（**これが諸元表の足りない部分**）。
  列は key、項目名（`FIELDS.find(f => f.k === key)?.l ?? key`）、値、単位、説明。位置は先端基準の mm で、単位列は「mm(先端)」。
- 「推力履歴」（t[s], F[N] = M.pts）、「審査用計算値」（REVIEW_LABELS の順に reviewValues）、「飛行結果」（flightSummary、緯度経度は enuToLatLon で計算）。
- thrustKind が 'assumed' なら、全シートの 1 行目に §2.7 の注意文を入れる。
- 往復テスト: Debug を書き出して読み込み直したとき、engText 以外の数値キーが相対 1e-6 で一致すること。

### 4.3 DEBUG_PRESET / DEBUG_SUPPLEMENTS
- `test/fixtures/spec-dump.txt` の値を §4.1 の規則で変換したもの。推力は仮定曲線（thrustKind:'assumed'）、ballast は 0。
- 補完項目（DEBUG_SUPPLEMENTS に理由付きで載せる）:
  - finN = 4（CNα 11.8 と Cmq −2.96 を再現する枚数）、finThick = 3、finCant = 0。
  - 推力履歴（仮定 Isp 170 s）、payloadPos = 200（放出後の静安定に影響する）。payloadTime は放出時刻として扱う。
  - 1段目は rec1:'apogee'（開傘条件は記載なし）、openTime = 1、windDirRef = 'true'（風向基準は記載なし）。
  - 単発計算用の wind = 4、windFrom = 270、gust = 0。lugAft = 0、landSurface = 'site'。
  - モーターの描画寸法 mLen = 600、mDia = 60、mOver = 0。
  - 磁気偏角 +7.6 は declCheck で警告が出る（値は変更しない）。

---

## 5. dispersion.js（`window.Dispersion`）

```
Dispersion.mount(containerEl)   // 1 回目だけ UI を作る（2 回目以降は何もしない）
Dispersion.setVisible(bool)     // mount 前は何もしない。true のとき requestAnimationFrame(() => map.invalidateSize())
Dispersion.markStale()          // mount 前は何もしない。結果に「設定変更あり・再計算してください」と表示する
```
- `#dispersion` の中の DOM はすべて自分で作り、CSS も自分で持つ。mount のときに一度だけ `<style id="disp-style">` を差し込む。
  セレクタにはすべて `#dispersion ` を前に付け、クラス名は `disp-*` にする。既存のクラス（card, card-h, fields mini, field, row, primary, muted, small, kv）は使ってよい。
  少なくとも `#dispersion .disp-map{height:min(60vh,520px)}`、`#dispersion .leaflet-container canvas{width:auto;height:auto}`、
  `#dispersion .leaflet-control input{width:auto}` と、代替 canvas の高さを明示する指定を入れる。ui は style.css に分散図用の CSS を足さない。
- Leaflet の JS/CSS は、最初に `setVisible(true)` が呼ばれたときか、実行ボタンを押したときに 1 回だけ読む。既定の SVG レンダラを使う（preferCanvas は使わない）。
  OSM タイルは `https://tile.openstreetmap.org/{z}/{x}/{y}.png` で、attribution は必須。Leaflet が読めないときは、ENU 平面の canvas で同じ内容の図を描く。
- 入力（cfg キーにはしない。localStorage `student-rocket-sim:disp` に try/catch 付きで保存する）:
  - 風速リスト。既定は `1,2,3,4,5,6,7` [m/s] で、windRef の高さでの値。**先頭に必ず 0 m/s（1 点）を足す**。
  - 風向数（8 / 16 / 36、既定 16）と風向の基準（cfg.windDirRef に合わせて表示する）。
  - 対象: 弾道落下 / 減速落下 / ペイロード（payloadOn のときだけ）。
  - 着地面（cfg.landSurface を上書きできる）。射角リスト（任意。既定は cfg.elev だけ）。
  - 許可域 `zones: [{kind:'include'|'exclude', shape:'circle', lat, lon, r_m} | {kind, shape:'polygon', pts:[[lat,lon],…]}]`、`margin_m`（既定 0）。
    UI は円の追加と多角形の追加（"緯度,経度" の行を貼り付け）ができるようにする。
- 計算: 開始時に `const base = normalizeCfg(cfg)` でスナップショットを取る。各 (射角, 風速, 風向) について
  `simulate(buildModel({...base, elev}), {record:false, ballistic, wind:{speed, from}})` を実行する。
  弾道落下は `ballistic:true`、減速落下は通常の実行、ペイロードは減速落下の実行の `payload.landing` を使う。非同期のチャンクに分けて UI を止めない。進捗と中止ボタンを付ける。
- 判定: 着地点が OK とは、いずれかの include の境界より margin_m 以上内側にあり、かつ全 exclude の境界より margin_m 以上外側にあること。
  判定は ENU 平面で行う（内外判定は ray casting、margin は辺までの最短距離）。zones が空なら判定しない。
  セル (s, θ) が OK とは、チェックした全対象の着地点が OK であること。着地しなかった実行と error の実行は NG とする。
  `allow(θ) = max{ s ∈ リスト | s' ≤ s となる全セル (s', θ) が OK }`。0 m/s が NG なら「打上げ不可」と表示する。全方位の許容風速 = min_θ allow(θ)。
- 表示:
  - 地図: 風速ごとに、風向をつないだ閉曲線を描く（色は風速のグラデーション）。弾道落下は破線、減速落下は実線、ペイロードは点線。射点、許可域、凡例、各点のツールチップも出す。
  - ○/× の行列（風速×風向）、風向別の許容風速の表、全方位の許容風速。
  - 要約: 頂点高度の最大、各 dtApo の min/max、開傘時の対気速度の最大、最悪ケースのランチクリア迎角 atan(w(z_exit)/V_exit)。
  - thrustKind が 'assumed' なら §2.7 の注意文を出す。
- 出力（app.js の `download(name, text, type)` を使う）:
  - CSV: `mode,elev_deg,wind_mps,wind_from_true_deg,wind_from_mag_deg,east_m,north_m,lat,lon,dist_m,t_s,v_mps,vz_mps,apogee_m,apogee_t_s,railExit_V_mps,deploy1_dtApo_s,deploy2_dtApo_s,payload_dtApo_s,deploy1_Va_mps,payload_Va_mps,ok`
  - `go_nogo.csv`: `elev_deg,wind_from_deg,dir_ref,allowed_max_mps,limiting_mode,limiting_wind_mps`
  - KML: 点ごとの Placemark と、風速ごとの LineString。緯度経度は enuToLatLon で計算する。

---

## 6. ui の担当範囲（app.js / index.html / style.css / view3d.js / sw.js）

- **cfg を変更する経路を 1 本にする**: `function applyCfg(next, {rewrite = true} = {}) { cfg = normalizeCfg({...DEFAULTS, ...next}); saveCfg(); if (rewrite) writeFields(); window.Dispersion?.markStale(); window.V3D?.markDirty(); scheduleRun(); }`。
  onField は `applyCfg(cfg, {rewrite:false})` を呼ぶ（posRef と L の変更時は §1 の pos 欄の書き直しだけ）。
  loadCfg / 設定 JSON 読込 / 初期値 / 諸元表読込 / Debug は、すべて `normalizeCfg({...DEFAULTS, ...raw})` か applyCfg を通す。
  受入条件: localStorage に `{recMode:'none'}` を入れて起動したとき、rec1 === 'none' になること。
- SCHEMA:
  - §2 の新規キーを追加する。`t:'text'` 型（input type=text、文字列のまま代入、NUM_FIELDS には入れない）を作り、`name` に使う。
  - `hOxDrain`, `payloadOn` は `t:'check'`、`aeroTable` は `t:'textarea'`、選択肢は `t:'select'`。cmq / clp は空欄で null（数値欄、空欄を許す）。
  - pos:true のキーは §1 のとおり。
  - グループの案: 基本（name, posRef）/ 機体 / フィン（finCant）/ 質量・慣性（massMode, hybrid の各項目, inertiaMode, Ipitch, Iroll, ballast, payload）/
    モーター（nozzleExitD）/ 回収系 / 射点・気象（lat, lon, magDecl, azimRef, windDirRef, windRef, lugAft, landSurface）/
    空力・計算（aeroMode, cpManual, cnaManual, cmq, clp, aeroTable）。
  - 表示条件:
    - airMass, airCG, mProp, mTotal: massMode === 'motor'。hybrid の各項目: massMode === 'hybrid'。Ipitch, Iroll: inertiaMode === 'manual'。
    - cpManual, cnaManual, cmq, clp: aeroMode === 'manual'。cdMode: aeroMode === 'barrowman'。cdManual: manual のときか cdMode === 'manual' のとき。
    - rec1Time: rec1 ∈ {ignition, burnout}。rec1Delay, rec1Backup: rec1 === 'apogee'。rec2: rec1 !== 'none'。rec2Time: rec2 === 'ignition'。mainAlt: rec2 === 'altitude'。
    - chuteSpec: rec1 !== 'none'。c1D, c1Cd: rec1 !== 'none' かつ diameter。c2D, c2Cd: rec1 !== 'none' かつ rec2 !== 'none' かつ diameter。
      c1Vt と c2Vt は同じ条件で velocity のとき。openTime: rec1 !== 'none' または payloadOn。
    - ペイロードの各項目: payloadOn。
  - 推力関連のキーを手で変えたら thrustKind を 'measured' に戻す（§2.7）。
  - azim のラベルは azimRef に応じて「（磁北基準）/（真北基準）」と切り替える。windFrom も同様。windExp のラベルは「べき指数 α（=1/n）」とし、n も併記する。
- cfg.recMode を参照している箇所をすべて置き換える:
  `recMode==='dual'` → `!!sim.ev.deploy2`、`recMode==='delay'` → `cfg.rec1 === 'burnout' || cfg.rec1 === 'ignition'`、
  最適な遅延 = `ev.apogee.t − (cfg.rec1 === 'burnout' ? M.tb : 0)`、`recMode!=='none'` → `cfg.rec1 !== 'none'`、
  メイン高度の警告 → `cfg.rec1 !== 'none' && cfg.rec2 === 'altitude'`。受入条件: `grep recMode app.js view3d.js` が 0 件。
- 例外時の代わりの sim は `{rec:[], ev:{error}, st:{}, payload:null}` とする。
- 結果カードは flightSummary の値を使う（上昇区間の最大値、開傘時の dtApo、ペイロードの落下距離など）。
- 「諸元表チェック」カード: REVIEW_LABELS の順に reviewValues を後端基準で表示する（null は「—」）。M.warn と declCheck も表示する。
  真方位 trueAzim を必ず表示する。thrustKind が 'assumed' なら §2.7 の注意文をここと結果の上に出す。
- ヘッダにボタン「諸元表読込（.xlsx）」「諸元表書出し」「Debug 諸元」を置く。
  - 読込: `SpecSheet.importFile(file, cfg)` → `applyCfg({...cfg, ...patch})`。
  - Debug: `applyCfg({...DEFAULTS, ...SpecSheet.DEBUG_PRESET})`（現在の cfg は混ぜない）。
  - どちらの後も「読み込んだ項目 / 諸元表に無いため補った項目 / 警告」を一覧にするパネルを出す（閉じられる）。
- タブ「落下分散」: `<button data-tab="disp">落下分散</button>` と `<section id="tab-disp" class="tab"><div class="card"><div id="dispersion"></div></div></section>`。
  タブ処理で `.on` を切り替えた後、毎回 `window.Dispersion?.setVisible(b.dataset.tab === 'disp')` を呼ぶ。player を隠すタブは `['mc','sweep','disp']`。
  init() の buildSweep() の後で `window.Dispersion?.mount($('#dispersion'))` を呼ぶ。Dispersion が無ければ #dispersion にその旨を出す。
- ペイロード: 側面図・上面図に破線の軌跡と着地点を描き、3D に小さなカプセルとパラシュートを出す。
  再生範囲は `flightEnd_t_s` まで伸ばし、本体の着地後は本体を着地点に止めて表示する。
- ロール: 3D の機体は `q = setFromUnitVectors(Y_UP, axis) · setFromAxisAngle(Y_UP, roll)` の順で合成して回す。HUD に rpm を出し、グラフに「ロールレート」を加える。
- 警告に追加するもの: Fst（%）、M.warn、declCheck、deploy1/deploy2/payload の dtApo が < 0 または > dtApoWarn、
  ペイロードが上昇中に放出される（対気速度、開傘荷重、放出後の Fst）、velocity 指定で rec2 ≠ 'none' かつ c2Vt ≥ c1Vt、
  thrustKind 'assumed'、|opTimeCurve − hOpTime| > 0.1 s、hBurnTime > 作動時間、hybrid で ispEff が 100〜250 s の範囲外、railExit.alphaW。
- 風速のラベルは「高度 ${cfg.windRef} m」（app と view3d の「10m」固定を直す）。パラシュートの描画サイズは M.c1Dia / M.c2Dia / M.payloadDia を使う。
- モンテカルロ: hybrid では airMass の代わりに hDryMass をばらつかせる。CSV 出力に新しいフィールドを加える。
- `sw.js`: `const CACHE = 'student-rocket-sim-v3'; const FILES = ['./','index.html','style.css','physics.js','specsheet.js','dispersion.js','app.js','view3d.js','manifest.webmanifest','icons/icon.svg'];`。
  `tile.openstreetmap.org` への fetch は respondWith せずに return する（キャッシュしない）。
- `test/physics-test.html` へのリンクは置かない（開発者向け）。

---

## 7. 進捗ジャーナルと作業ルール

- 担当ごとに `docs/progress/<担当>.md` を作業開始時に作り、節目ごとに「済み / 残り / 次の一手」を追記する。中断から再開したら、最初にジャーナルを読む。
- 最初の 15 手以内にコードをディスクへ書く。大きなファイルは分けて書いてよい。
- ブラウザペインと preview_* ツールは **使わない**（統括が使う）。代わりにヘッドレス Chrome を使う:
  `bash C:/Users/jinno/dev/student-rocket-sim/test/headless.sh <URL またはファイル> [仮想時間ms]`
  JS 実行後の DOM が stdout に、console 出力と例外が stderr に出る（`[console] … Uncaught …`）。
  ローカルサーバー `http://localhost:8775/`（プロジェクト直下を配信。統括が起動済み）を使ってよい。
  テストページは結果を DOM（例: `<pre id="result">`）に書き出し、`PASS n / FAIL m` の行を含めること。
- Python が必要なときはフルパス `C:/Users/jinno/AppData/Local/Programs/Python/Python312/python.exe` を使う。Node は入っていない。
- 終わったら、ジャーナルに「契約から外れた点・未実装の点・他担当への依頼」を必ず書く。
