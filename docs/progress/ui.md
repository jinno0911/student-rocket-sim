# ui 進捗ジャーナル（app.js / index.html / style.css / view3d.js / sw.js）

## マイルストーン U1（設定の配線）
### 済み
- （作業開始）spec-v2.md / CLAUDE.md / 既存コードを読んだ。physics.js はまだ旧版（normalizeCfg 等が無い）→ 契約 API だけを前提に書き、テストは scratchpad のシムで行う。

- [cp1] index.html: 読込順 §0.1、ヘッダボタン（#fileSpec / #btnSpecExport / #btnDebug, class spec-btn）、落下分散タブ・#tab-disp、#importPanel
- [cp1] sw.js: v3 / FILES / OSM バイパス
- [cp1] view3d.js: window.V3D 化、風ラベル「高度 windRef m」、パラ径は model.c1Dia/c2Dia（無ければ cfg.c1D/1000）
- [cp1] app.js: SCHEMA 全面（新キー全部、t:text/check/select/textarea、nul、ro、pos、lf 動的ラベル）、DEFAULTS=normalizeCfg、loadCfg/applyCfg、
  onField→applyCfg(rewrite:false)+writeFields(入力中の欄を除く)、posRef 切替は表示だけ、CHART_CSS、recMode 0 件、
  例外時 sim に payload:null、model=null 時のガード、MC は hybrid で hDryMass、掃引/MC は開始時スナップショット、
  諸元表ボタン配線（SpecSheet 無しなら disabled）、取込結果パネル showImportPanel、落下分散 mount/setVisible、CSV に cg/fst/roll/p
- [cp1] style.css: disabled ボタン、取込パネル

- [cp2] ヘッドレス確認（旧 physics＋新 normalizeCfg のシム, scratchpad/h/test.html）: U1 テスト 47/47、legacy {recMode:'none'} → rec1 none 2/2、
  Debug 諸元ボタン＋spec.xlsx 実読込（specsheet.js 実物）10/10。hDryCG 表示（後端）= 591.48 を確認
  - onField は「入力中の欄以外を writeFields(el) で同期」: normalizeCfg の補正（hFuelPost ≤ hFuelPre、payloadOn の自動 off など）が他欄に即反映される

- [cp3] 新 physics.js（作業中版）でも通し確認: test-real.html 49/49・legacy 2/2・Debug+xlsx 10/10、localhost:8775/index.html でコンソールエラーなし
  （dispersion.js は他担当が書きかけで SyntaxError → app は「読み込めませんでした」を表示して継続）
- [cp3] cfgEdit（正規化前の編集値）を追加: 打ちかけの途中値で normalizeCfg が他欄を補正しても、確定値で元に戻る（hFuelPost / payloadOn）。
  外部からの applyCfg（rewrite:true）で破棄。footer の文言を 6 自由度に更新

## U1 の契約からの差分（意図的）
- rec2Time / mainAlt の show に `rec1 !== 'none'` を追加（rec2 自体が非表示・無視されるため）。
- thrustKind を SCHEMA に「表示のみ（disabled select）」で追加（状態の可視化と、書出しの項目名 FIELDS.l のため）。
- onField は applyCfg(…, {rewrite:false}) の後に writeFields(入力中の要素) を呼び、入力中以外の全欄（補正・連動・pos 表示・表示条件・ラベル）を同期する。値が同じ欄は触らない。
- Debug 諸元は confirm() で確認してから置き換える。
- タイマー開傘の頂点ずれ警告のしきい値は 1.5 固定ではなく cfg.dtApoWarn。
- 掃引のラベルで pos 項目には「（先端から）」を付ける（掃引は先端基準のため）。

## 他担当への依頼・メモ
- dispersion: 現在 dispersion.js が途中で切れていて SyntaxError（294 行）。完成待ち。
- specsheet: download(name, data, type) は Blob に渡すだけなので ArrayBuffer / Uint8Array も可。

## U1 完了。次（U2 以降の候補）
- 結果カードを flightSummary に、諸元表チェックカード（REVIEW_LABELS×reviewValues 後端基準, M.warn, declCheck, trueAzim, assumed 注意文）
- 警告の追加（§6 の一覧）、ペイロードの 2D/3D 描画、ロール（3D 合成・HUD rpm・ロールレートのグラフ）、再生範囲 flightEnd_t_s
- テスト用ハーネス: scratchpad/h/test-real.html（?legacy=1 / ?debug=1）, ui-test.js
- U2 以降（結果カード flightSummary、諸元表チェックカード、警告追加、ペイロード描画、ロール 3D/HUD/グラフ、再生範囲 flightEnd）

### 次の一手
- ヘッドレスで起動確認（physics.js が新 API になるまではシムで）

## ⚠ 中断（2026-10-08 21:0x, セッション上限）→ 再開
- U1 は完了済み。U2/U3 は未着手のまま中断。担当ファイルは U1 完了時点の状態。

## [cp4] 再開後の再検証（2026-10-09）
- 担当ファイルは U1 完了時点から無変更。`grep recMode app.js view3d.js` = 0 件、読込順 §0.1・sw.js v3・window.V3D を再確認。
- 現行の physics.js / specsheet.js / dispersion.js（構文エラー解消済み）を全部読み込んだハーネス（scratchpad/h/test-real.html に dispersion.js を追加）で
  通常 49/49・legacy {recMode:'none'} 2/2・Debug 諸元＋spec.xlsx 10/10。実物 index.html（file://）もコンソールエラーなし、#dispersion に mount 済み、頂点 1636 m。
- localhost:8775 は停止中だったため file:// で確認（manifest の CORS 警告のみ。file:// 固有）。
- U1 完了。次の一手: U2（結果カード flightSummary・諸元表チェックカード・警告追加・ペイロード描画・ロール・再生範囲）。

## マイルストーン U2（結果と結線）
- [u2-cp1] app.js: getSummary(M,sim)（flightSummary があればそれ、無い・例外時は §3.4 と同じ定義の summaryLocal）、fsNow/rvNow を runNominal で更新。
  結果カードを fsNow で書き直し（上昇区間の最大値、dtApo、ペイロード放出・落下距離、flightEnd）。renderWarnings を §6 の全項目に拡張。
  renderReview（#reviewCard: REVIEW_LABELS×reviewValues、null→—、真方位、M.warn、declCheck、assumed 注意）。#resultNote（assumed 注意）。
  MC/掃引の各試行を try/catch。drawCharts/renderStatic の model=null ガード。取込パネルにも assumed 注意。
- index.html: #resultNote、#reviewCard（details）。style.css: .banner / .rv-*。
- 次の一手: ヘッドレス確認（通常 / Debug / 計算エラー時）。
- [u2-cp2] ヘッドレス確認（scratchpad/h/test-u2.html + ui2-test.js、index.html から生成。?debug=1 / ?nospec=1 / ?nodisp=1）:
  既定 27/27・Debug 15/15・SpecSheet 無し 2/2・Dispersion 無し 3/3。U1 ハーネスも 49/49・legacy 2/2・Debug+xlsx 10/10。実物 index.html（file://）コンソールエラーなし。
  - physics.js に flightSummary とペイロードが入った後の実物で確認（Debug: 放出 T+7.0 s・頂点−3.6 s → 上昇中放出の警告、ペイロード落下 420 m、flightEnd 74.9 s）。
  - summaryLocal と flightSummary の差は maxV_t_s / maxQ_t_s の 0.01 s（rec の 0.02 s 間引き）だけ。
  - バグ修正: drawMc がタブ非表示（canvas 幅 0）で ellipse の半径が負になり例外 → 非表示なら描かない（表示時に redrawVisible が描く）。
  - 諸元表チェックの表は CSS columns で 2 段（列方向に REVIEW_LABELS の順）。512px 幅で横スクロールなし。

## U2 完了

### U2 の契約からの差分（意図的）
- declCheck: 「諸元表チェック」カードには常に出す。警告欄には magDecl ≠ 0 か azimRef/windDirRef が 'magnetic' のときだけ出す
  （既定値 lat/lon が日本域・magDecl 0 のため、何もしなくても毎回警告が出てしまうのを避ける）。
- deploy2 の dtApo は「< 0（上昇中）」と beforeDeploy1 のときだけ警告する。2段目は設計上頂点のずっと後に開くので「> dtApoWarn」は警告しない。
  deploy1 と payload は契約どおり < 0 または > dtApoWarn。
- Fst の警告しきい値は 10 %（目安。< 0 は ⛔）。railExit.alphaW の警告しきい値は 15°（目安）。いずれも契約に数値が無いため ui で決めた。
- 諸元表チェックの表は REVIEW_LABELS の全行（「先端から」の行も）を順に出す。先端基準の行は薄く表示（参考）。
- flightSummary が無い・例外のときは summaryLocal（§3.4 と同じ定義）で代替する。

### 残り（U3 以降）
- ペイロードの 2D/3D 描画、再生範囲を flightEnd_t_s まで、本体着地後は着地点に停止
- ロール（3D 合成 setFromUnitVectors·setFromAxisAngle、HUD rpm、ロールレートのグラフ）

## マイルストーン U3（描画と自己点検）— 開始 2026-10-09
- 方針: 再生は時刻ベース（playT が主、playIdx = rec の t ≤ playT の最後の添字）。scrub は 0〜playEnd()（= max(flightEnd_t_s, 本体最後の t)）の秒。
  本体の記録が終わった後は本体を着地点に止め、ペイロードは sim.payload.rec を playT で補間。
- 予定: 2D 側面/上面にペイロード破線＋着地点、phKey の頑健化、凡例 !!ev.deploy2、3D ペイロード（カプセル＋パラ）、ロール合成、HUD rpm、
  グラフ「ロールレート [rpm]」「重心位置」、風ラベル windRef、全ファイル再読、ヘッドレス確認。
- [u3-cp1] app.js: phKey 頑健化（sim/model null 可、deploy2 以降は c2）、時刻ベース再生（playEnd/idxAt/seekT/payAt/drawPlay、scrub は秒・step 0.01）、
  側面図・上面図にペイロード破線（ゴースト＋現在まで）・着地 ×・現在位置、1段目開傘/同時開傘/放出の点、凡例（!!ev.deploy2・同時展開なら 1段目なし・ペイロード）、
  'sea' 着地で z<0 も範囲に、上面図にも凡例、風ラベル「高度 windRef m」、HUD に rpm・本体着地後の表示・ペイロード高度、
  グラフ「ロールレート [rpm]」「重心位置 [mm, 先端/後端から]」（posRef 切替で描き直し）、イベント線に 1段目/2段目/PL放出、機体図にペイロード □。
- [u3-cp1] view3d.js: ペイロード（Lathe カプセル＋紫ゴアのパラ、径 M.payloadDia、放出からの openTime で展開、破線軌跡・着地リング・ラベル・ビーコン）、
  ロール q = fromUnitVectors(Y, axis)·fromAxisAngle(Y, roll)、ph2 の tc を頑健化、chuteDia('pay')、THREE 無しでも window.V3D を作る、_dbg に rocket/pay。
- [u3-cp1] ヘッドレス scratchpad/h/test-u3.html + ui3-test.js（rAF を setTimeout に差し替え。ヘッドレスでは rAF が発火しないため）: 36/36。
- [u3-cp2] 見た目の調整: 側面図のペイロード着地ラベルは × の上、上面図の着地ラベルは右端で × の左へ、凡例は狭い画面で 2 段に折返し、
  グラフのイベントラベルは重なると段を下げる（最大 4 段）、HUD の −0 rpm を 0 に、3D の 1段目開傘・放出ラベルは点の下、ペイロードのラベルは左側。
- [u3-cp2] 自己点検: 担当 5 ファイルを通読。ESLint（ブラウザ版 eslint-linter-browserify 8.57.0 を headless で実行、physics→specsheet→dispersion→app→view3d を連結）
  no-undef / no-redeclare / no-dupe-keys / no-unreachable 等 0 件（未使用変数 chuteCanopy を削除）。`grep recMode|CSS` 0 件（CHART_CSS のみ）。
  ヘッドレス: U3 36/36、U2 27/27・Debug 15/15・nospec 2/2・nodisp 3/3、U1 49/49・legacy 2/2・Debug+xlsx 10/10。
  index（http, 一時サーバー 127.0.0.1:8779 → 停止済み。8775 は落ちていた）・file:// ともコンソール出力 0 件。
  375px の iframe で全タブ横スクロールなし。physics-test 235/0、specsheet-test 180/0、dispersion-test 117/0（参考）。
  スクリーンショット: scratchpad/h/shot-flight.png, shot-charts.png, shot3d-*.png。

## U3 完了

### U3 の契約からの差分・補足（意図的）
- 再生は時刻ベースにした（playT が主。playIdx は rec の t ≤ playT の最後の添字のまま。他モジュールが参照する意味は不変）。scrub は秒（0〜playEnd, step 0.01）。
- ロールレートのグラフと HUD の rpm は ph 1 のときだけ（ph 0/2 は p = 0 固定なので出さない）。
- 重心位置のグラフは posRef に合わせて表示し、x 範囲は max(tEnd, 放出時刻)×1.2+1 s まで（その後は一定のため）。
- 凡例・ラベルの用語を「1段目パラ / 2段目パラ」に統一（旧「第1パラ / メイン」）。2段目しか無い（同時展開）ときは 1段目の凡例を出さない。
- view3d の _dbg に renderer/scene/rocket/chute/pay/visScale を追加（テスト用）。Three.js が読めないときも window.V3D を作るよう Y_UP/qRoll を遅延化。
- ヘッドレスでは requestAnimationFrame が発火しないため、再生と 3D のテストはハーネス側で rAF を setTimeout に差し替えて確認した。

### 他担当への依頼・メモ
- なし（physics / specsheet / dispersion の自己テストは全 PASS。ui 側から見て API の不足なし）。
- 統括へ: localhost:8775 のサーバーが停止していた（U3 の確認は 127.0.0.1:8779 の一時サーバーと file:// で実施）。

### 残り（任意）
- 本体着地後に追従カメラをペイロードへ切り替える、'sea' 着地時の 3D 地面（標高 0 m）の表示、ペイロード軌跡の CSV 出力。
