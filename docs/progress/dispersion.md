# dispersion 進捗ジャーナル

担当ファイル: `dispersion.js`, `test/dispersion-test.html`（これ以外は編集しない）

## マイルストーン D1（エンジンと UI）

### 済み
- 契約（spec-v2.md §0, §2, §3.2, §3.4, §5）を読んだ。physics.js はまだ v2 API（normalizeCfg / flightSummary / enuToLatLon / opt.wind）を持っていない（並行作業中）→ 契約どおりに書き、テストページでは足りない関数だけ代替シムを入れて検証する。

### 残り
- dispersion.js 本体（mount/setVisible/markStale、入力 UI、計算、判定、表示、書出し）
- test/dispersion-test.html

### 次の一手
- dispersion.js を書く

## ⚠ 中断（2026-10-08 21:0x, セッション上限で強制終了）→ 再開
- 担当ファイルは **途中まで書かれた状態** でディスクに残っている（ジャーナルより先に進んでいる）。
- 再開したら、まず担当ファイルを最後まで読み、どこまで実装済みかを確認してから続きを書くこと（書き直しは不要な部分まで消さない）。
- 末尾が途中で切れている・構文エラーがある可能性があるので、最初に headless.sh で構文エラーの有無を確認する。

## 再開 2026-10-09
- dispersion.js（708 行）と test/dispersion-test.html（245 行）は最後まで書かれていた（末尾の切れなし）。
- physics.js にはまだ flightSummary が無い（physics が P2 作業中）→ テストページの代替シムで検証する。
- localhost:8775 が起動していないので file:// で headless.sh を回す。
- 次の一手: ヘッドレスでテストを実行し、FAIL を直す。

### チェックポイント 1（2026-10-09）
- 済み: ヘッドレス初回 69/3 → 修正後 **PASS 74 / FAIL 0**（file:// 実行、flightSummary は代替シム）。
  - 修正: チャンク分割を「40 ms か 8 件ごと」に（仮想時間では performance.now が進まず中止が効かなかった）。譲り先を MessageChannel に（背景タブで setTimeout が間引かれる対策）。
  - 中止したとき、前の結果の「再計算」表示を消さないようにした。`field wide` → `field disp-wide`（契約外クラスを使わない）。
  - テスト側: __g1 番兵の除外、zones 空の判定を td で見る、進捗・中止ボタンの検査を追加。
- 残り: Leaflet 経路の確認（?leaflet=1）、ペイロード経路（physics が payload を返さないのでテスト用シムで確認）、見た目の確認（スクリーンショット）。

### チェックポイント 2 — D1 完了（2026-10-09）
- 済み: test/dispersion-test.html **PASS 81 / FAIL 0**（file://、Leaflet なし）、`?leaflet=1` でも 75/0（Leaflet・SVG レンダラ・OSM 帰属を確認）。
  - 追加テスト: ペイロード経路（physics が payload を返すまで simulate を包んで合成。シム使用はページに表示）、進捗・中止ボタン、中止後も「再計算」表示が残る。
  - 見た目: ヘッドレスのスクリーンショットで 1100 px と 390 px 幅を確認（390 px 幅ではみ出す要素なし。表は .disp-scroll 内で横スクロール）。
  - 代替 canvas の軸ラベルの重なりを解消、0 m/s のセル（16 列結合）を左寄せ。
  - index.html（実アプリ）でも mount され、例外なし。
- 契約から外れた点（意図的）:
  1. include が 1 つも無く exclude だけのときは「include 条件は満たす」とみなす（文字どおりだと常に NG で使えないため）。UI の説明文にも明記。
  2. go_nogo.csv は射角ごとに風向の行のあと `wind_from_deg=all` の行（全方位の許容風速）を足す。0 m/s が NG の風向は allowed_max_mps=`NOGO`。
  3. 対象に弾道落下が無くても、ペイロードのために減速落下の実行はする（ペイロードは減速落下の実行の payload.landing を使う契約どおり）。
  4. CSV には §2.7 の注意文を入れない（ヘッダ行が契約で固定のため）。KML の description と画面には出す。
- 未実装: なし（D1 の範囲）。
- 他担当への依頼:
  - physics: `flightSummary(M, sim)` がまだ physics.js に無い。無い間は CSV の apogee/dtApo/Va 列と要約が空欄（— 表示）になる。`simulate` の戻り値 `payload` もまだ無いので、ペイロード対象は「放出されませんでした」で NG になる。
  - 統括: localhost:8775 が起動していなかったので file:// で検証した。

## マイルストーン D2（地図＋テスト）開始 2026-10-09
- 確認: Leaflet の遅延読込・OSM タイル＋帰属・射点・許可域・風速ごと／モードごとの閉曲線（破線/実線/点線、風速グラデーション）・ツールチップ・凡例・fitBounds・表示時 invalidateSize・代替 canvas は D1 で実装済み。
- 残り: `Dispersion._geom`（pointInPolygon, distToPolygon, signedDist, zoneOk, allowFromMatrix, toENU/toLL, prepZones, downwindUnit）を公開し、judge を allowFromMatrix 経由に整理。テストページに純関数のテストと「風下へ流れる」検査を追加。
- localhost:8775 は停止中（curl 接続拒否）→ file:// で検証。
- 次の一手: dispersion.js の幾何部を純関数化して _geom を公開。

### チェックポイント — D2 完了（2026-10-09）
- 済み:
  - `Dispersion._geom` を公開（DOM・状態に触れない純関数）:
    `pointInPolygon(p,x,y)`（ray casting, p=[[x,y],…] ENU）, `distToPolygon(p,x,y)`（閉じる辺を含む最短距離, 非負）, `signedDist(zone,x,y)`（内側が正）,
    `zoneOk(zs, margin, x, y)`（zs は prepZones 済み。空なら null、非有限は false、margin<0 は 0）,
    `allowFromMatrix(ok[si][di], speeds, nDir?) -> {allow:[{v,lim}], all}`（0 m/s の行は 1 列でも可。true 以外は NG）,
    `prepZones(zones, lat0, lon0)`, `toENU(lat0,lon0,lat,lon)`, `toLL(lat0,lon0,x,y)`（= enuToLatLon）, `downwindUnit(fromDeg) -> [東,北]`。
  - judge() は allowFromMatrix 経由に整理（結果は従来どおり。旧 _test.sdist/judgePoint は別名で残した）。
  - setVisible(true) の invalidateSize/再描画を rAF に加えて 250 ms タイマーでも行う（ヘッドレスでは rAF が回らない・背景タブで間引かれる対策。2 回呼んでも無害）。initMap も同様。
  - test/dispersion-test.html: 純関数のテスト（凹多角形・頂点を通るレイ・閉じる辺・margin 境界・include 複数・exclude 複数・allow の打切り・0 m/s NG・往復変換・downwind）、
    normalizeCfg({}) の 2 風速 × 8 方位で「減速落下の着地点が全方位で風下へ流れ、4 m/s > 2 m/s > 0」「横ずれ < 風下成分の 0.5」、
    遅延読込（mount では読まない／最初の setVisible(true) で 1 回だけ／2 回目は読み直さない）、代替 canvas の注記・ツールチップ・範囲合わせ・再表示での描き直し、
    Leaflet の OSM 帰属・実線/点線の閉曲線・fitBounds・マーカーのツールチップ・凡例・再表示時の invalidateSize。結果欄は ok() ごとに途中経過も書く（ハング箇所が分かる）。
  - 結果: file:// で **PASS 117 / FAIL 0**、`?leaflet=1` で **PASS 120 / FAIL 0**。代替シムは不要になった（physics.js が flightSummary と payload を返す）。index.html も例外なし。
  - 参考値（normalizeCfg({})、風下方向の変位）: 減速落下 2 m/s ≈ 330 m, 4 m/s ≈ 658 m。弾道落下は −64〜−131 m（ウェザーコックで風上に出る）ので判定しない。
- 契約から外れた点: D1 の 4 点のまま（include 無しは include 条件を満たす扱い／go_nogo の all 行と NOGO／ペイロードのための減速落下実行／CSV に注意文なし）。追加の逸脱なし（250 ms タイマーは rAF に追加するだけ）。
- 未実装: なし（D2 の範囲）。
- 他担当への依頼: なし。統括へ: localhost:8775 は停止中だったので file:// で検証。ヘッドレス Chrome では requestAnimationFrame が回らない（他のテストでも rAF 待ちはハングする）。
