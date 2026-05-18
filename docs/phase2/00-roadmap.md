# Phase 2 Roadmap: real-task autonomous loop + GHI dogfood

**Status**: planning (Phase 2 #1 PR ratifies this doc)
**Scope**: 1-2 weeks, multiple PRs (Phase 1 #9-#14 と同規模)
**Trunk**: `infra/phase0-autonomous-foundation`

## なぜ Phase 2 か

Phase 1 (PRs #45-#62) で autonomous-loop 基盤を完成させた:
- 24h saturated soak で **72 autonomous PRs**(`auto/STORY-*` feature branches)を生成
- 7 race / arch bug (F/G/H/I/J/K/L) を全て根絶、21h 連続稼働で 0 regression
- ただし生成物は **`docs/soak/*.md` のテンプレ docs に限定**(Risk 0、内容も 5-7 文の glossary)

Phase 2 のゴールは **autonomous loop が "本物のコード" を書ける段階まで引き上げる**こと。
最終的な dogfood ターゲットは **GHI (General Human Intelligence)** — ムーア株式会社の v0.1 α 版データ収集プラットフォーム(`02-ghi-requirements-v1.0.1.md` 参照)。

## Stage 構造

Phase 2 は credentials / repo 整備のタイミングに合わせて 3 stage で進める。

### Stage 1: 設計・計画 (Phase 2 #1, このドキュメント)

GHI の credentials/repo がまだ揃っていないため、まず**コード変更なしの設計 PR**で全体図を固める。

- `docs/phase2/00-roadmap.md`(本ファイル)
- `docs/phase2/01-ghi-bootstrap-checklist.md` — GHI 開発に必要な credentials/外部リソース調達リスト
- `docs/phase2/02-task-allocation.md` — GHI の各 FR / GHI-NNN タスクを「Claude が書く」「autonomous loop が dogfood」「人間 (hkobayashi) が手動でやる」の 3 区分に振り分け
- `docs/phase2/03-risk-matrix.md` — Phase 2 で autonomous loop に書かせる範囲とそのリスク評価

このフェーズの所要時間は数日。コードは 1 行も書かない。

### Stage 2: MCA Phase 2 整備 (Phase 2 #2 〜 #6)

GHI dogfood に入る前に、autonomous loop 自身を強化する。

| PR | タイトル | 主担当 | 説明 |
|---|---|---|---|
| **Phase 2 #2** | risk_evaluator を code/docs で分離 | **Claude** (bootstrap) | 現状 `src/**` 触ると PLAN_APPROVAL_PENDING で止まる。docs=Risk 0, src/tests=Risk 2, secret/RLS=Risk 4+ に再設計。これがないと loop が自分のコードを書けない(chicken-and-egg)|
| **Phase 2 #3** | path-filter gate suite | autonomous loop | 影響範囲に応じて gate を選択(`src/ralph/` 変更時のみ ralph-tests を走らせるなど)|
| **Phase 2 #4** | Kimi prompt: real code editing | autonomous loop | 現状 prompt は "create new file" 寄り。"modify existing file in-place / diff-aware" に強化 |
| **Phase 2 #5** | budget cap + cost telemetry | autonomous loop | per-day Kimi token 上限、超過で auto-pause、`story.audit` に cost 記録 |
| **Phase 2 #6** | 24h soak validation (MCA-internal tasks) | autonomous loop | GHI credentials がまだ無い場合の代替: MCA 自身の小規模 refactor / doc improvement / lint fix を story 化して soak。real-code dogfood の最初の検証 |

Phase 2 #7+ は soak から出た bug を Phase 1 #9-#14 と同じパターンで修理。

### Stage 3: GHI dogfood (Stage 2 完了 + credentials 揃った後)

ユーザー (hkobayashi) が以下を整えたら起動:
- `moore-corp/ghi` GitHub repo 作成(private)
- DIA1000 Supabase Cloud の `ghi` スキーマ admin アクセス
- Hetzner CPX31 VPS 契約 + SSH key
- OpenRouter / Groq / VLM Provider API keys

その後 autonomous loop に GHI Day 1 タスク(GHI-001 〜 GHI-024)を story として供給。
私 (Claude) は security-critical 領域(FR-001/040 認証、FR-003 PII、FR-043/044 録画専用環境、FR-045 RLS)を bootstrap PR として直接書き、それ以外を loop に書かせる。

Stage 3 のタスク振り分けの詳細は `02-task-allocation.md` 参照。

## Phase 1 と Phase 2 の対比

| 軸 | Phase 1 (完了) | Phase 2 |
|---|---|---|
| Story source | soak supplier (templated docs) | MCA-internal tasks → GHI Day 1 tasks |
| Output paths | `docs/soak/*.md` (Risk 0) | `src/**` `tests/**` `supabase/migrations/**` (Risk 2-3) |
| Gates | 全 gate 走らせる | path-filter で影響範囲のみ |
| Risk evaluator | conservative (auto-block src/) | code-aware (Risk による分岐) |
| Cost telemetry | なし | per-day 上限 + tracking |
| Repo | MCA 単独 | MCA + (将来) `moore-corp/ghi` |
| 成功基準 | autonomous PR が立つ | autonomous PR が **merge 可能な品質** |

## 範囲外 (Phase 2 では扱わない)

- GHI Phase 1.5 以降の機能(API ゲートウェイ、Marketplace、Stripe Connect 等)
- GHI の法務体制整備(`07-ghi-deferred-items.md` §15.1)
- 自社特化 LoRA・ファインチューニングの実コード(Phase 2 完了後の自社 Phase 2/3 と紛らわしいが別物)
- multi-LLM dispatcher (Gemini/Claude/GPT-5/Ollama) — Phase 1 の "(C) 複数 LLM scale out" 案として保留

## 完了基準

Phase 2 完了とみなす条件:
1. `Phase 2 #2 〜 #5` 全マージ
2. `Phase 2 #6` MCA-internal soak で 12h 以上、新規 race bug 0、PR 数 5 件以上
3. GHI credentials 揃った時点で Stage 3 が即起動可能な状態(`02-task-allocation.md` の "Claude bootstrap 必須" 項目が全て明文化されている)

Stage 3 の GHI 開発自体は Phase 3 以降の話。

## 次のアクション

- [x] Phase 2 #1 PR(本 doc + 関連ドキュメント)を open し merge
- [ ] Phase 2 #2 で risk_evaluator の code/docs 分離を bootstrap
- [ ] Phase 2 #3-#5 を autonomous loop に story として供給(MCA-internal)
- [ ] hkobayashi 側で GHI credentials 取得作業(`01-ghi-bootstrap-checklist.md` 参照)
- [ ] Stage 2 完了 + Stage 3 credentials 揃い次第、GHI repo 作成と Day 1 タスク投入
