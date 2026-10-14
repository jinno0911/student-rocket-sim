# specsheet 進捗ジャーナル

担当: `specsheet.js`, `test/specsheet-test.html`（契約: docs/spec-v2.md §4）

## 2026-10-08 S1（読込）開始
- 済み: CLAUDE.md / spec-v2.md / spec-dump.txt を読了。設計方針を決定。
  - fieldMap は団体入力シートの全 SubItem（機体名・全長も含む）。全長は key 'bodyLen'（bodyLen = L − noseLen − tailLen）。
  - 仮定推力は内部関数で生成（shapeFn('regressive') と同じ式。読込時に他モジュールを呼ばないため）。
  - DEBUG_PRESET は spec-dump.txt から手で変換（hDryCG 1008.52 など）。
  - exportXlsx は S2 まで未実装スタブ（reject）。
- 残り: specsheet.js 本体 → test/specsheet-test.html → ヘッドレス検証。
- 次の一手: specsheet.js を書く。

## ⚠ 中断（2026-10-08 21:0x, セッション上限で強制終了）→ 再開
- 担当ファイルは **途中まで書かれた状態** でディスクに残っている（ジャーナルより先に進んでいる）。
- 再開したら、まず担当ファイルを最後まで読み、どこまで実装済みかを確認してから続きを書くこと（書き直しは不要な部分まで消さない）。
- 末尾が途中で切れている・構文エラーがある可能性があるので、最初に headless.sh で構文エラーの有無を確認する。

## 2026-10-09 再開（3 回目）
- 確認: specsheet.js（497 行）と test/specsheet-test.html（294 行）は末尾まで書かれている（途中切れなし）。
- 次の一手: ヘッドレスで構文エラー・PASS/FAIL を確認し、FAIL を直す。

## 2026-10-09 S1（読込）完了 — test/specsheet-test.html: PASS 101 / FAIL 0（ヘッドレス Chrome）
- 済み（この回の修正）:
  - aeroTable を patch で常に '' にする（Debug 読込結果が DEBUG_PRESET と一致しなかった FAIL の修正）。
  - 仮定推力の engText からコメント行を外し、"t F" 行だけにした（§4.1 厳守）。
  - 同名ラベル（降下終端速度）は行が 1 つしか無くても列B の見出しで区別（1段目の値を 2段目・ペイロードへ流用しない）。
  - 「推力履歴」シートに §2.7 の注意文（本ツールの書出し）があれば thrustKind 'assumed' のまま読む（往復用）。
  - 「シミュレータ追加諸元」の数値は NFKC→数値、だめなら parseFloat（§4.1 の parseFloat 指定）。
  - cdScale ≠ 100% を警告（thrustScale と同様）。
  - テスト側: __keys0 の誤検出、exportXlsx スタブの未処理 reject を修正。shapeFn 一致・同名ラベル・追加諸元・推力シートのテストを追加。
- 契約から外れた点: なし。補足として、ラベルの表記ゆれ（ALIAS）・m/cm/g/ms 等の別単位も受け付ける。
  仮定推力は shapeFn を呼ばず同じ式を内部に持つ（DEBUG_PRESET を読込時に作るため。テストで shapeFn と一致を確認）。
- 未実装: exportXlsx（S2。現在は reject するスタブ）。
- 他担当への依頼: なし（ローカルサーバー 8775 が落ちていたので、テストは自前の 127.0.0.1:8791 で実行した）。
- 次の一手: S2（書出し §4.2 と往復テスト）。

## 2026-10-09 S2（書出し＋テスト）開始
- 済み: specsheet.js に書出しを実装（buildBook → _buildWorkbook / exportXlsx）。5 シート（団体入力シート・シミュレータ追加諸元・推力履歴・審査用計算値・飛行結果）、
  逆変換（後端基準・kg・n=1/α・磁北方位）、仮定推力の注意文（全シート 1 行目）、ファイル名 <name>_諸元表.xlsx。
  - 推力は「推力履歴」シート（M.pts＝倍率適用済み）を正とし、追加諸元では engText を空欄、thrustScale≠100 なら 100、motorSrc≠eng なら eng/custom、motor モードは mProp/mTotal/mLen/mDia を計算値で書く（再読込で M.pts が一致するように）。
  - 読込側: 追加諸元の engText 空欄は無視。追加諸元で azimRef 'true' なら磁北の方位角を真方位に戻す。
- 残り: test/specsheet-test.html に S2 テスト（dump 照合・§3.3 検算・仮定曲線・DEBUG_PRESET 比較・往復・書出し規則）を追加 → ヘッドレス実行。
- 次の一手: テスト追加。

## 2026-10-09 S2（書出し＋テスト）完了 — test/specsheet-test.html: PASS 180 / FAIL 0 / SKIP 0（ヘッドレス Chrome, 60000 ms）
- 済み:
  - exportXlsx(cfg, model, sim) / SpecSheet._buildWorkbook(cfg, model, sim)（内部の buildBook を共用）。model/sim が null なら cfg から buildModel / simulate する。
  - 「団体入力シート」は元の様式を再現（行 2〜62 のラベル・見出し・Note・セル結合が fixture と一致、更新日は日付シリアル、改訂履歴欄あり）。
    Debug を書き出すと D 列の値が fixture と相対 1e-9 で一致（テスト済み）。基準高さの単位だけ元の空欄に対し 'm' を書く。
  - 逆変換: 後端基準 = L − x（L = cfgLenMm）、kg、n = 1/α（α ≤ 0 は空欄＋warning）、方位 = (真方位 − 偏角) mod 360、
    diameter 指定の終端速度は √(2·m_ref·9.81/(1.2·CdS))、rec2 altitude は ev.deploy2.t ＋ Note「高度 mainAlt m 開傘の予測時刻」、
    motor モード・barrowman モードの規則（§4.2）、作動時間 = hOpTime（0 なら M.tb）。
  - 「シミュレータ追加諸元」「推力履歴」(M.pts)「審査用計算値」(REVIEW_LABELS×reviewValues＋M.warn/declCheck)「飛行結果」(flightSummary＋enuToLatLon の緯度経度＋計算条件)。
  - assumed なら全シートの A1 に §2.7 の注意文。ファイル名 <name>_諸元表.xlsx（使えない文字は _）。
  - テスト追加: spec-dump.txt と全 43 項目照合、§3.3 検算 15 値＋放出後質量、dump の数式結果と reviewValues（1e-6）、仮定曲線（M.tb = t_op、Itot ±0.5%）、
    DEBUG_PRESET と読込結果の比較（baseCfg = normalizeCfg({})）、書出しの各規則、往復（Debug・真北方位＋テール・rec2 altitude・motor 既定・推力倍率 110%・barrowman/auto 慣性）。
  - 実アプリ（index.html＋app.js）でも確認: Debug 諸元 → exportXlsx → app の download() に Debug_諸元表.xlsx、読み直して applyCfg → cfg 差分 0、頂点高度一致。
  - xlsx の構造を Python（zipfile＋XML パース）でも確認（14 パート、全 XML 整形式）。
- 契約から外れた点（意図的）:
  - _buildWorkbook は SheetJS の遅延読込を待つため Promise<ArrayBuffer> を返す。exportXlsx は void ではなく {fileName, warnings} で解決する（app.js は使わなくてよい）。
  - 「シミュレータ追加諸元」は推力を「推力履歴」シート（M.pts＝倍率適用済み）に一本化するため、engText を空欄、thrustScale≠100 なら 100、
    motorSrc≠eng なら 'eng'/'custom'、motor モードは mProp/mTotal/mLen/mDia を計算に使った値で書く（再読込で同じ M.pts・質量になる）。説明列に元の値を記載。
  - 項目名は FIELDS → specsheet 内の表示名 → key の順（FIELDS が無いテスト環境でも日本語名にするため）。
  - 読込側の追加: 追加諸元の engText が空欄なら推力履歴シートを使う。追加諸元で azimRef 'true' なら、団体入力シートの方位角（磁北）を真方位に戻す。
  - auto 慣性のときの慣性モーメント欄は推定値（hybrid: m_dry·L²/12, 0.5·m_dry·R² / motor: 点火時の値）。manual で cmq/clp が null のときは cmqEq/clpEq を書き、Note に由来を書く。
- 未実装: なし。
- 他担当への依頼: なし（physics 側の不一致は見つからなかった）。ローカルサーバー 8775 が落ちていたため、同じプロジェクト直下を 127.0.0.1:8793 で配信してテストした。
