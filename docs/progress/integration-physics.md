# integration-physics 担当 進捗ジャーナル

担当ファイル: `physics.js`, `test/physics-test.html`（他は編集しない）

## 2026-10-09 統合（physics）開始
- 済み: CLAUDE.md / spec-v2.md / physics.md（実装フェーズのジャーナル）を読んだ。localhost:8775 は停止中（curl 000）。
- 残り: physics-test を実行 → specsheet-test / dispersion-test（http）→ physics.js を §2–§3 と突き合わせて敵対的に再確認
  （符号・単位・基準長・ペイロードの CG/速度補正・CdA 合成・§2.9 不変条件 (1)-(4)・flightSummary の上昇区間最大値）。
- 次の一手: physics-test を headless で実行。http は一時サーバー（別ポート）で行い、終わったら止める。
