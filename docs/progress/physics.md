# physics 担当 進捗ジャーナル

担当ファイル: `physics.js`, `test/physics-test.html`（他は編集しない）

## 2026-10-08 P1（モデル層）開始
- 済み: CLAUDE.md / spec-v2.md / spec-dump.txt / 現行 physics.js / app.js DEFAULTS を読んだ
- 残り: PHYS_DEFAULTS, RHO0_SHEET, G_SHEET, normalizeCfg, cfgLenMm, declCheck, enuToLatLon, REVIEW_LABELS, rotDeriv,
  buildModel 拡張（hybrid 質量・慣性・空力 manual/aeroTable/減衰/cant・圧力推力・パラ CdA・M フィールド・M.warn・真方位）,
  reviewValues, simulate の最小適応, test/physics-test.html（§3.3 検算）
- 次の一手: physics.js の先頭部分（定数・既定値・normalizeCfg 等）を書く

## ⚠ 中断（2026-10-08 21:0x, セッション上限で強制終了）→ 再開
- 担当ファイルは **途中まで書かれた状態** でディスクに残っている（ジャーナルより先に進んでいる）。
- 再開したら、まず担当ファイルを最後まで読み、どこまで実装済みかを確認してから続きを書くこと（書き直しは不要な部分まで消さない）。
- 末尾が途中で切れている・構文エラーがある可能性があるので、最初に headless.sh で構文エラーの有無を確認する。
- 統括の確認（再開前）: test/physics-test.html は **PASS 143 / FAIL 0 / SKIP 4**。P1（モデル層・reviewValues・normalizeCfg・rotDeriv・暫定 simulate）は実質完了。
  SKIP 4 件は P2 項目（14 状態 simulate のロール応答、velocity 降下速度、ペイロード、硬さサブステップ）。P1 担当は残りの確認だけで P2 へ。

## 2026-10-09 再開（P1 の残り確認）
- 済み: physics.js を最後まで読んだ（構文エラーなし・末尾欠けなし）。test/physics-test.html = PASS 143 / FAIL 0 / SKIP 4（P2 項目のみ SKIP）。
- 済み: specsheet.js の実物 DEBUG_PRESET（`{...normalizeCfg({}), ...DEBUG_PRESET}`）でも §3.3 検算 15 項目すべて相対 1e-4 で一致、
  放出後 m=5.882 / cg=1038.14 / I=1.31799、M.warn 空、declCheck 警告あり（scratchpad の使い捨てページで確認）。
- 済み: index.html を file:// でヘッドレス起動 → physics 由来のエラーなし。
- 残り: P1 の未検査項目をテストに追加（rec の roll/p/cg/fst、opt.wind、declCheck 境界、payloadDia、tIgn ずれ、motor の放出後質量 など）。
- 次の一手: test/physics-test.html に「P1 追加確認」グループを足して再実行。

## 2026-10-09 P1 完了
- 済み: test/physics-test.html に「P1 追加確認」19 項目（rec の roll/p/cg/fst・st.maxRollRate、opt.wind の上書きと windDirRef 基準、
  declCheck 境界 −3/−11、payloadDia、負の偏角での真方位の折返し、先頭ゼロ推力区間での tIgn / 点火前質量 / tEnd、motor のペイロード放出、
  boolean 文字列、PHYS_DEFAULTS の §2 全キー）を追加 → **PASS 161 / FAIL 0 / SKIP 4**（SKIP は P2 の 4 項目だけ）。
- P1 の公開物: PHYS_DEFAULTS, RHO0_SHEET, G_SHEET, normalizeCfg, cfgLenMm, declCheck, enuToLatLon, REVIEW_LABELS, rotDeriv, reviewValues,
  buildModel（hybrid 質量・tIgn/tEnd、慣性＋ロール慣性と下限・単位警告、manual/aeroTable/cmq/clp/clpEq/cmqEq/cant、圧力推力、
  パラ CdA（diameter/velocity）・ペイロード CdA・等価直径、§3.1 全フィールド、M.warn、真方位・windDirRef・wdir）、simulate は P1 暫定版（5DOF、payload:null）。

### 契約から外れた点（意図的・軽微）
- reviewValues.opTime_s: hOpTime を使うのは hybrid のときだけ（motor は常に M.tb。§4.2 の motor 書出し規則「作動時間 = M.tb」と一致させるため）。
- reviewValues.avgThrust_N は契約に定義が無いので Itot / opTimeCurve とした。
- M には契約外の補助フィールドもある（Fmax, opTimeCurve, Ymac, Rcant, rg2, Sf, cant, cmqAt, clpAt, cantMoment, chuteVel, mRef, landZ, railEff, windFromTrue, windDirOff, dt など）。
  cpAt の戻り値には cnaF（干渉込みフィン群 CNα）も入る。M.thrust(t, z) は z を渡すと圧力推力込み、省略で曲線値。
- cmqEq の Σ 項は既存コードと同じく max(0, …) でクランプ（負の減衰を作らない）。

### 未実装（P2）
- simulate の 14 状態化（ロール・ジャイロ・cant 励起・ロール減衰）、ペイロード放出と並行積分、硬さ対策のサブステップ／ev.error、flightSummary。

### 他担当への依頼
- なし（specsheet の実物 DEBUG_PRESET で §3.3 の検算値がすべて一致することを確認済み）。

### 次の一手（P2）
- simulate を §2.6 / §2.8 / §3.2 に沿って書き直し、P2 の SKIP 4 件を有効化。flightSummary を実装。

## 2026-10-09 P2（dynamics）開始
- 済み: ジャーナル・spec-v2.md・physics.js・physics-test.html を読み直した。ベースライン PASS 161 / FAIL 0 / SKIP 4（file:// 実行。localhost:8775 は現在停止中）。
- 残り: simulate を §2.6/§2.8/§2.9/§3.2 で書き直し（14 状態・サブステップ・ペイロード並行積分・回収系の不変条件）、flightSummary（§3.4）、P2 テスト 4 件＋追加。
- 次の一手: simulate を丸ごと置き換えて書く → ヘッドレスで既存テストの回帰を確認。
- [cp1] simulate を 14 状態版に置換・flightSummary を追加（physics.js に書込み済み）。既存テストは PASS 161 / FAIL 0 / SKIP 4 のまま（回帰なし）。
  次の一手: scratchpad で値を確認 → P2 テスト（SKIP 4 件の有効化＋回収系・ペイロード・flightSummary の確認）を physics-test.html に追加。

## 2026-10-09 P2 完了
- 済み: simulate を 14 状態（位置・速度・u・ω⊥・p・φ）に書き直し。§2.6 の回転方程式（rotDeriv と同じ式をインライン）、各サブステップ後の u 正規化と ω⊥ の直交化、
  phase 規則（0: ω⊥=p=0・φ 固定 / 2: ω⊥=p=0・φ 保持）、cant 励起とロール減衰（phase 1 のみ）、§3.2 のサブステップ（phase 1: ω_n/λ_q/λ_p/λ_g、n>200 で ev.error、
  phase 2 とペイロード: h = min(0.02, 0.5/λ_d)、gust は外側ステップごと）、opt.wind（gust 0）、lugAft、landSurface 'sea'、圧力推力、
  rec1/rec2/rec1Delay/rec1Backup と §2.9 の不変条件、CdA 合成（diameter 加算 / velocity 置換）、ペイロード放出（ステップ境界・CG/速度補正・並行積分・本体着地後も継続・
  payload.error）、rec の roll/p/cg/fst、ev.deploy{t,z,V,vz,q,by,beforeDeploy1}・ev.payload・railExit{va,alphaW}、st.maxRollRate、payload 出力、flightSummary（§3.4）。
- テスト: test/physics-test.html = **PASS 235 / FAIL 0 / SKIP 0**（P2 の SKIP 4 件を有効化＋74 項目追加）。主な実測:
  velocity 降下 |vz| 誤差 2.8e-5、2 段目 1.2e-4、diameter 3.7e-4（いずれも ±1% 規定）、cant |p| = 10.38 vs 理論 9.94 rad/s（±30% 規定）、
  放出時の系の重心の連続性 6e-14 m、cmq −300 はサブステップで完走、cmq −1e7 は硬さエラーで停止、motor 既定の頂点 1635.9 m。
- 他モジュールとの結合確認: specsheet-test 101/0（http）、index.html はコンソールエラーなしで結果カード（flightSummary）表示。
  dispersion-test は 116/1（失敗は代替 canvas のツールチップのホバー判定で、physics の値に依存しない UI 側の項目）。
- 性能: record:false で 1 回 12〜20 ms（Debug / motor、風 0〜7 m/s × 16 方位の 128 回でエラー 0、ペイロードも全て着地）。
- 注: localhost:8775 は作業時点で停止していたので file:// と一時サーバー（127.0.0.1:8791、終了済み）で確認した。

### 契約から外れた点・補足（P2）
- st に内部用の `st.asc = {maxV, maxV_t, maxMach, maxQ, maxQ_t, maxG}`（離床〜頂点の最大値）を追加。flightSummary はこれを使うので record:false でも同じ値になる。
- 外側ステップ: phase 0/1 は M.dt、phase 2 と本体着地後（ペイロードだけ積分中）は 0.02 s（従来どおり）。その中で §3.2 のサブステップを行う。
- rec2 が deploy1 より先に成立して同時展開したときの deploy1.by は 'timer'。rec1 'ignition'/'burnout' の by も 'timer'。
- レール離脱は「離床済み かつ sAlong ≥ railLen − lugAft」（lugAft ≥ railLen で射点上のまま離脱しないための保護）。
- 着地面は z ≤ min(M.landZ, 0)（'sea' で siteAlt < 0 の不自然な入力の保護）。payloadMass ≤ 0 なら放出しない（payload null）。
- payload.error は非有限値のほか、1800 s までに着地しない場合と本体がエラーで止まった場合にも入れる（landing は null）。
- st.maxRollRate は rad/s（|p| の最大）。flightSummary の deploy1_by は未展開なら NaN（契約の「発生しなかった項目は NaN」に従う）。
  burnEnd_t_s はモデル値（hybrid: tIgn + hBurnTime、motor: M.tb）で常に入る。dtApo の基準は ev.apogee.t（vz<0 を検出したステップ）。
- payload.release / payload.rec の V は対地速度 |v_p|（ev.payload.V は対気速度）。

### 未実装
- なし（P2 の範囲）。

### 他担当への依頼
- ui: st.maxRollRate と rec.p は rad/s（rpm は ×60/2π）。rec.roll は mod 2π していない。ペイロードの軌跡は sim.payload.rec、再生範囲は flightSummary().flightEnd_t_s。
- dispersion: test/dispersion-test.html の「代替 canvas: 点にカーソルを当てるとツールチップ」が FAIL（ホバー座標の問題に見える。physics の値には依存しない）。テストの代替シム flightSummary は実物が入ったので使われなくなった。
- 統括: localhost:8775 が停止中（2026-10-09 00:1x 時点）。

### 次の一手
- P2 完了。統括の指示待ち（必要なら UI 結合時の不具合対応）。

## 2026-10-09 P3（テスト）開始
- 済み: ジャーナル・spec-v2.md・physics.js（全 884 行）・physics-test.html を読み直した。ベースライン（file://）**PASS 235 / FAIL 0**。localhost:8775 は停止中（curl 000）。
- 方針: §3.5 の 13 項目すべてに検査タグを付け、`<pre id="result">` に「PASS n / FAIL m」＋項目別の PASS/FAIL 表を出す（未検査の項目は FAIL 扱い）。
  load イベントで実行し、physics.js が読めない・例外でも PASS/FAIL 行を必ず出す。
  強化: rotDeriv（射影前のドリフト・連続追跡した歳差角速度・トルクありの微分式）、lugAft（railLen − lugAft の等価性）、圧力推力の min(1, F/0.05Fmax) ランプ、
  declCheck の文言、landSurface 'site'/'sea' の比較、ペイロードが本体より先に着地する場合、aeroTable の Cd が飛行に効くこと。
- 次の一手: test/physics-test.html を書き換え → ヘッドレスで実行。
- [cp1] test/physics-test.html を書き換え（load 時に実行、§3.5 の項目タグ S1〜S13 / B / X、`<pre id="result">` に「PASS n / FAIL m」＋項目別の集計表）→ **PASS 276 / FAIL 0**（約 0.9 s）。

## 2026-10-09 P3 完了
- 済み: test/physics-test.html（physics.js だけを読込み、load 時に実行）。`<pre id="result">` の 1 行目が `PASS n / FAIL m`、続いて §3.5 の 13 項目＋B（§2.5 Barrowman）＋X（その他）の PASS/FAIL 表、
  FAIL があれば詳細行。下に全行の HTML 表（§3.5 タグ列付き）。検査行が 1 つも無い §3.5 項目はカバレッジ不足として FAIL にする。
  physics.js が読めない・テスト本体が例外のときも PASS/FAIL 行を必ず出す（scratchpad に置いて ../physics.js が無い状態で PASS 0 / FAIL 15 になることを確認）。
- 結果: file:// と http（一時サーバー 127.0.0.1:8792、終了済み）の両方で **PASS 276 / FAIL 0**。項目別 PASS 数:
  S1 19, S2 13, S3 2, S4 13, S5 2, S6 2, S7 7, S8 13, S9 7, S10 8, S11 6, S12 6, S13 6, B 15, X 157。
- 主な実測: 頂点（motor 既定）1635.85 m / rotDeriv |ΔH|/|H0| 1.3e-14、|ω⊥·u| 射影前 1.1e-16、歳差角速度 1.3000（= |H|/I_t、12.9987 rad を連続追跡）、
  dH/dt = τ（一般の向き）1e-16 / cant |p| 10.38 vs 9.94 rad/s / velocity 降下 |vz| 最大相対誤差 2.8e-5（64 点）/ ΔF @1 km 2.866 N、
  F = 0.025·Fmax で ΔF が半分（ランプ）/ lugAft 1000 mm ≡ railLen −1 m（離脱時刻・速度が完全一致）/ 'sea' は z = −40 m で本体・ペイロードとも着地。
- physics.js の変更: なし（全項目が初回から PASS。契約の検算値に誤りは見つからなかった）。
- 結合確認（http）: index.html はコンソールエラー 0 件、結果カード（flightSummary）と諸元表チェックが表示される。specsheet-test 180/0、dispersion-test 117/0。
- 注: localhost:8775 は P3 の作業中も停止していた（curl 000）。

### 契約から外れた点・補足（P3）
- §3.5「Ipitch = 0.0015 の manual」は、§2.4 の下限 I_t ≥ 0.01·m·L²（Debug で 0.168 kg·m²）に張り付くため実際には硬くならない。
  サブステップの経路は cmq −300（完走）、硬さエラーの経路は cmq −1e7（ev.error で停止）で別に検査している。
- rotDeriv の |ω⊥·u| は §2.6 の射影の前（1 ステップのずれ）と後の両方を検査（射影後だけでは自明に 0 になるため）。
- テストの Debug cfg と仮定推力曲線は、physics.js だけを読むためのテスト専用の写し（§4.1 の仮定曲線そのものの検査は specsheet 側）。

### 他担当への依頼
- 統括 / ui: 既定 cfg（lat/lon が日本域・magDecl 0）では declCheck が契約どおり「（現在 0°）」の警告を返すので、既定の画面に常に「注意 1 件」が出る。
  意図どおりか確認を（変えるなら PHYS_DEFAULTS.magDecl の既定値か §2.2 の declCheck 条件の契約変更が必要。physics は契約どおりのまま）。
- 統括: localhost:8775 が停止中。

### 次の一手
- P3 完了。統括の指示待ち。
