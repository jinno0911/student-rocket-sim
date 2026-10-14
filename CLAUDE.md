# student-rocket-sim
学生ロケット飛行シミュレーター（静的 PWA、ビルド不要・依存ライブラリなし）。
- 構成: `physics.js`（物理コア・DOM 非依存）/ `specsheet.js`（諸元表 xlsx, window.SpecSheet）/ `dispersion.js`（落下分散, window.Dispersion）/ `app.js`（UI）/ `view3d.js`（3D, window.V3D）。読込順はこの順（physics → specsheet → dispersion → app → view3d）
- Magi（C++ のハイブリッドロケット軌道シミュレータ）から移植したモジュール: `geo.js`（WMM2025・Vincenty・正規重力, window.Geo）/ `terrain.js`（国土地理院 標高タイル, window.Terrain）/ `analysis.js` + `analysis-worker.js`（並列 MC・ラプラス近似・EKF・閾値・KML, window.Analysis）/ `verify.js`（検算, window.Verify）/ `design.js`（フィン最適化・パラシュート設計, window.Design）。読込順は geo → terrain → physics → specsheet → dispersion → analysis → verify → design → app → view3d
- 追加 cfg キー（magMode, launchDate, earthRot, tipOff, lugUpper, windModel, windProfile, windMaxH, ばらつき補正 cnaScale/burnScale/cgShift/cpShift/chuteScale/chuteDelay, 閾値 th*）は既定で従来と同じ挙動
- ヘッドレス Chrome の仮想時間は Web Worker を待たない → ワーカーを使うテストは `?noworker`（window.ANALYSIS_NO_WORKER）で本スレッド実行
- sw.js は同一オリジンを cache:'no-cache' で再検証する（更新時に古い app.js が混ざる事故の対策）
- **ファイル間の契約は `docs/spec-v2.md`**（cfg キー・単位・関数・予約名）。キーを足すときは physics.js の PHYS_DEFAULTS と app.js の SCHEMA の両方
- cfg の位置は常に先端基準 mm（諸元表は後端基準、変換は specsheet と UI の posRef 表示だけ）。cfg を変える経路は applyCfg に一本化
- テスト: `bash test/headless.sh`（ヘッドレス Chrome）で test/*.html を実行し `PASS n / FAIL m` を確認。test/fixtures/ は gitignore（実際の諸元表 xlsx・スクショ用ハーネス）
- 入力欄は `SCHEMA` から自動生成（数値項目は掃引の候補にも自動で出る）。DEFAULTS は normalizeCfg(PHYS_DEFAULTS) から作る
- 単位: UI は mm/g/deg、内部は SI。座標 x=東 y=北 z=上
- 設定は localStorage `student-rocket-sim:cfg`。読込時に normalizeCfg が既定値補完と旧キー（recMode）移行をする
- `view3d.js`: Three.js r128（CDN）の 3D ビュー。app.js のグローバル (sim/model/cfg/playIdx/playT) を参照。座標は (x,z,-y) に変換。非減衰スプライトは FOV で補正
- 起動: `.claude/launch.json`（python http.server, port 8775）
- `sw.js` のキャッシュ名 `student-rocket-sim-vN` はファイル更新時にバンプ
- モータープリセットは近似値。正確なデータは .eng 貼付で使う
