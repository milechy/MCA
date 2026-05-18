# Phase 2 Risk Matrix

**目的**: autonomous loop に書かせる範囲ごとに、想定リスクと mitigation を整理する。
Phase 1 までの risk_evaluator は touchesSecrets / touchesRls の substring チェックのみだった。Phase 2 ではこれをパス・パターンベースに拡張する(Phase 2 #2 のスコープ)。

## リスクレベル(Phase 2 で再定義)

`02-ghi-requirements-v1.0.1.md` §4.3 セキュリティ要件と Phase 1 の RISK_0..5 体系を組み合わせ、以下に再定義する。

| Risk | label | autonomous loop の扱い | 例 |
|---|---|---|---|
| 0 | RISK_0_LOW | fullauto 自動承認 | `docs/**`, `README.md` 部分編集 |
| 1 | RISK_1_LOW | fullauto 自動承認(ただし path-filter gate 必須) | `*.test.js` test additions, lint fix |
| 2 | RISK_2_MEDIUM | fullauto 自動承認(diff approval は loop で auto、PR 作成も auto) | `src/**` 通常コード変更、UI コンポーネント追加 |
| 3a | RISK_3A_DATA | **PLAN approval 必須**(人間が plan を見る) | `supabase/migrations/**`、DB スキーマ変更 |
| 3b | RISK_3B_AUTH | **PLAN approval 必須** | 認証フロー変更、token 発行ロジック |
| 3c | RISK_3C_PII | **PLAN approval 必須** | PII 検出ロジック、マスク処理 |
| 3d | RISK_3D_RLS | **PLAN approval 必須**、RLS テスト pgTAP green 必須 | `ALTER POLICY`, `CREATE POLICY` 含む変更 |
| 4 | RISK_4_LEGAL | **PLAN + DIFF + COMMIT approval すべて必須** | 規約・プライバシーポリシー編集、クライアント混入チェック辞書変更 |
| 5 | RISK_5_STOP | **STOP** — autonomous loop は触らない | secrets ファイル、credentials、本番 DB の destructive 操作 |

## パス → Risk マッピング(Phase 2 #2 の実装案)

```yaml
# config/risk-paths.yaml(Phase 2 #2 PR で導入)
risk_rules:
  - pattern: 'docs/**'
    risk: 0
  - pattern: '**/*.test.{js,ts,py}'
    risk: 1
  - pattern: 'src/**'
    risk: 2
  - pattern: 'supabase/migrations/**'
    risk: 3a
  - pattern: 'src/**/auth/**'
    risk: 3b
  - pattern: 'src/**/pii/**'
    risk: 3c
  - pattern: '**/*policy*.sql'
    risk: 3d
  - pattern: 'docs/legal/**'
    risk: 4
  - pattern: 'config/client-keywords.txt'
    risk: 4
  - pattern: '.env*'
    risk: 5
  - pattern: '**/*credentials*'
    risk: 5
```

複数パターン該当時は **最も高い Risk** を採用する。

## 既知の致命傷シナリオ

| ID | シナリオ | risk | mitigation |
|---|---|---|---|
| F-1 | autonomous loop が `ALTER POLICY ... USING (true)` で RLS を実質無効化 | RISK_3D | 3d は PLAN approval 必須。人間が `USING` 句を目視レビュー |
| F-2 | PII 検出から `email` 検出が抜ける | RISK_3C | 検出範囲のテストは fixed list (`tests/pii/expected-detections.json`)、これを通らないと PR open 不可 |
| F-3 | 招待トークンが multi-use になる | RISK_3B | `ghi.invitations.used_at IS NULL AND now() < expires_at` チェックが残っているか自動テスト |
| F-4 | クライアント名(IDS, AVAS, 介護AI)が code 内に commit される | RISK_4 | pre-commit hook `client-leak-check` skill (`04-ghi-claude-code-setup.md` 参照)で chunk |
| F-5 | secrets 系ファイル(`.env`, `*-credentials.json`)が autonomous で書き換わる | RISK_5 | risk_evaluator が STOP。そもそも path が STOP リストに入っている |
| F-6 | autonomous loop が `git push --force` を含む patch を出す | RISK_5 | apply-time の patch 解析で `--force` キーワード検出時は immediate_escalation |
| F-7 | 提供者の動画を別提供者にエクスポートできてしまう | RISK_3D | RLS pgTAP テストが provider_a → provider_b の動画にアクセスできないことを毎 PR で確認 |
| F-8 | 規約・プライバシーポリシーが法的に瑕疵あり | RISK_4 | loop が出すのは雛形のみ。merge 前に弁護士レビューが必須(`07-ghi-deferred-items.md` §15.1) |

## Phase 2 で risk_evaluator が分岐する基準

```
1. PATCH に含まれる各 path について risk_paths.yaml で risk を引く
2. 全 path の中で最も高い risk を採用
3. risk による分岐:
   - 0-2: fullauto で auto-approve(従来通り)
   - 3a-3d: PLAN_APPROVAL_PENDING に止め、operator が plan を確認するまで待機
   - 4: PLAN + DIFF + COMMIT のすべてで human approval を要求(fullauto を一時的に無効化)
   - 5: STORY 即 ESCALATED、blocked_reason='risk_5_stop'
```

Phase 1 までの risk_evaluator は touchesSecrets/touchesRls/touchesProductionDB のシンプルな substring チェックのみ。Phase 2 #2 でこれをパス・パターン + diff 内容の併用に拡張する。

## fullauto + Risk 4 の例外

`02-ghi-requirements-v1.0.1.md` §15.1 法務体制整備の見送り中、autonomous loop で規約・プライバシーポリシーを **触らせない**。

Phase 2 では fullauto モード中でも以下は強制 human approval:
- `docs/legal/**`
- `config/client-keywords.txt`
- `supabase/migrations/**` で `CREATE POLICY` / `ALTER POLICY` を含む
- `src/**/pii/**`

これは fullauto auto-approver (`src/ralph/fullauto-auto-approver.js`) で AUTOAPPROVABLE_TYPES から除外することで実装する。

## メトリクス

Phase 2 #6 soak で以下を測定し、Phase 1 と比較する:

| メトリクス | Phase 1 (docs only) | Phase 2 target (real code) |
|---|---|---|
| autonomous PR open rate | ~9 PR/hour | ≥ 4 PR/hour (現実的低下) |
| 完走率 (DONE / created) | 86% | ≥ 70% |
| race regression (Bug F-L) | 0 | 0 |
| Risk 3a-3d の auto-approve 拒否 | N/A | 100%(正常動作) |
| Risk 4 の auto-approve 拒否 | N/A | 100% |
| 平均 Kimi token / story | ~5K | ~30-50K(コード書く分増える) |
| 平均 cost / story | ~$0.05 | ~$0.20-$0.30 |

## Phase 2 で未解決の課題

- **VLM の品質**(GHI-016)に関するリスクは autonomous loop の責任範囲外。`vlm-prompt-tuner` subagent で hkobayashi が判断
- **Hermes Agent 単一依存リスク**(§15.3): autonomous loop が緩和できるものではない。Stage 3 着手前に hkobayashi が代替策を検討
- **コスト超過**: budget cap (Phase 2 #5) で対応。それでも超過する LLM 料金は hkobayashi の意思決定
