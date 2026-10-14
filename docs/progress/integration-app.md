# integration-app 進捗ジャーナル（app.js / index.html / style.css / view3d.js / sw.js / dispersion.js / test/app-smoke.html / test/dispersion-test.html）

## マイルストーン I1（統合スモークテスト）開始 2026-10-09
- 読んだ: CLAUDE.md, spec-v2.md, progress/ui.md, progress/dispersion.md。
- localhost:8775 が停止していたので python http.server 8775（127.0.0.1）をバックグラウンドで起動した。
- 予定: test/app-smoke.html（iframe で ../index.html を開き contentWindow.eval で 7 項目を検査）を書く → headless(90000) → FAIL を担当ファイルで直す。
  dispersion-test.html の「代替 canvas: ツールチップ」FAIL（physics 報告）も確認する。

### 次の一手
- app.js / dispersion.js の該当 DOM を確認して app-smoke.html を書く。
