# GHI タスクの担当振り分け

**目的**: GHI Day 1 タスク(`05-ghi-day1-tasks.md` の GHI-001 〜 GHI-024)と FR(`02-ghi-requirements-v1.0.1.md` §3)を、誰が書くかで 3 区分に振り分ける。

**前提**: `00-roadmap.md` Stage 3 の方針 — security-critical 領域は Claude が bootstrap PR として直接書き、それ以外を autonomous loop に投げる。

## 区分の定義

| 区分 | 意味 | 例 |
|---|---|---|
| 🔒 **Claude** | security/privacy/legal-critical。autonomous LLM に任せると致命傷を生む。Claude が直接 PR を書く | RLS ポリシー、認証 token フロー、PII 検出、kill switch |
| 🤖 **loop** | autonomous loop が dogfood する。Kimi K2.6 が書き、私が PR レビューで gate | スケルトン UI、CRUD endpoint、規約 markdown 雛形、Docker compose 設定 |
| 👤 **human** | hkobayashi が手動でやる作業。autonomous loop で代替不可 | Hetzner VPS 契約、credentials 設定、招待トークン物理送付、録画専用環境物理セットアップ |

## Day 1 タスク振り分け

### Day 1-3: 環境セットアップ

| タスク | 区分 | 担当 | 備考 |
|---|---|---|---|
| Day 1 確認ポイント #1 録画専用環境 | 👤 | hkobayashi | 物理 PC / VM 準備 |
| Day 1 確認ポイント #2 PostgreSQL RLS 動作確認 | 🔒 | Claude | クロステナント漏洩は致命傷 |
| Day 1 確認ポイント #3 招待制トークン認証フロー | 🔒 | Claude | kill switch + 単回利用 + メール認証強制 |
| Day 1 確認ポイント #4 Go/No-Go 測定基盤 | 🤖 | loop | メトリクス収集スキーマは型に嵌まる |
| Day 1 確認ポイント #5 Hermes Agent v0.10.x 動作検証 | 👤 + 🤖 | hkobayashi がコンテナ起動、loop が動作テストスクリプト書く | |
| **GHI-001** ghi スキーマ作成 SQL | 🔒 | Claude | DDL は人手でレビュー必須 |
| **GHI-002** Hetzner CPX31 VPS セットアップ | 👤 | hkobayashi | OS インストール、Docker、Caddy 等 |
| **GHI-003** GitHub repo + CLAUDE.md | 👤 + 🔒 | hkobayashi が repo 作成、Claude が CLAUDE.md 書く | `04-ghi-claude-code-setup.md` 雛形使用 |
| **GHI-004** Supabase CLI + 初回マイグレーション | 🔒 | Claude | `supabase/migrations/ghi/001_initial.sql` の RLS ポリシー含む |
| **GHI-005** pgTAP セットアップ + 初回 RLS テスト | 🔒 | Claude | テストコードも security-critical |
| **GHI-006** Asana プロジェクト + Day 1 タスク登録 | 👤 + 🤖 | hkobayashi がプロジェクト作成、loop が Asana MCP でタスク登録 | |

### Day 4-7: 認証・招待制実装

| タスク | 区分 | 担当 | 備考 |
|---|---|---|---|
| **GHI-007** Next.js + FastAPI スケルトン | 🤖 | loop | 型に嵌まる scaffold、Phase 1 の docs PR と同じレベルの定型 |
| **GHI-008** Supabase Auth Magic Link 統合 | 🔒 | Claude | 認証フロー、token テーブル、kill switch |
| **GHI-009** 招待トークン管理 UI | 🤖 | loop | UI は型に嵌まる、ただし招待発行のサーバ側ロジック (token 生成・無効化) は Claude が書く |
| **GHI-010** FR-043 録画専用環境制御の運用ルール文書化 | 🔒 | Claude | NDA 違反防止の核心、loop に書かせるとリスク |

### Day 8-14: 動画アップロード・PII 検出

| タスク | 区分 | 担当 | 備考 |
|---|---|---|---|
| **GHI-011** 動画アップロード機能(チャンク対応) | 🤖 | loop | 200MB / 5分 / mp4 等のサーバ + クライアント、定型 |
| **GHI-012** Celery + Redis ジョブキュー | 🤖 | loop | docker-compose + celery worker scaffold |
| **GHI-013** PII 検出パイプライン基本版 | 🔒 | Claude | Microsoft Presidio 統合、検出範囲は requirements 通り。loop に投げると false positive / 漏れが致命的 |
| **GHI-014** Groq Whisper STT 統合 | 🤖 | loop | API クライアント、リトライ、フォールバック |
| **GHI-015** FR-044 録画前/後検査の自動化 | 🔒 | Claude | クライアント名辞書、NDA 違反防止 |

### Day 15-21: VLM + スキル抽出

| タスク | 区分 | 担当 | 備考 |
|---|---|---|---|
| **GHI-016** VLM 選定 PoC ([UNCONFIRMED-003] 解消) | 🤖 + 👤 | loop が比較スクリプト書き、hkobayashi が結果判断 | `vlm-prompt-tuner` subagent 使用 |
| **GHI-017** スキル構造化 (Hermes Agent skill 形式) | 🤖 | loop | agentskills.io スキーマ準拠の JSON 出力 |
| **GHI-018** Hermes Agent v0.10.x マルチテナント運用 | 🔒 + 👤 | Claude がボリューム/ネット分離設計、hkobayashi がコンテナ起動 | provider_id ごとのコンテナ分離は二重分離の片翼 |
| **GHI-019** FR-046 訓練候補データ管理 | 🔒 | Claude | 明示同意 UI + 別ストレージ + 削除請求時の取扱(法務要件) |

### Day 22-28: My Vault・運用・初回招待

| タスク | 区分 | 担当 | 備考 |
|---|---|---|---|
| **GHI-020** My Vault エクスポート (FR-010) | 🤖 | loop | zip 出力、Hermes Agent 互換形式 |
| **GHI-021** My Vault 完全削除 (FR-011) | 🔒 | Claude | 72h 物理削除、バックアップ/WAL/外部 API 送信先含む。漏れたら法務違反 |
| **GHI-022** Sentry 統合 (DIA1000 共通) | 🤖 | loop | SDK 統合 + PII マスキング設定 |
| **GHI-023** 初回招待: hkobayashi + 知人 2 名 | 👤 | hkobayashi | 物理的な招待トークン送付 |
| **GHI-024** α版運用ルール文書化 | 🤖 | loop | クイックスタートガイド、Phase 1 の docs PR と同レベル |

### 並行タスク

| タスク | 区分 | 担当 |
|---|---|---|
| **GHI-PARALLEL-01** DIA1000 担当との連携仕様調整 | 👤 | hkobayashi |
| **GHI-PARALLEL-02** 弁護士レビュー予約 (Phase 1.5 前) | 👤 | hkobayashi |
| **GHI-PARALLEL-03** Phase 2 PoC 自社特化 LoRA 検証 | 👤 | hkobayashi (12ヶ月後) |

## 集計

| 区分 | 件数 | 全体に対する割合 |
|---|---|---|
| 🔒 Claude | 12 | ~35% |
| 🤖 loop | 12 | ~35% |
| 👤 human | 8 | ~25% |
| ハイブリッド (Claude + loop or human + loop) | 3 | ~5% |

つまり Phase 2 Stage 3 で autonomous loop が dogfood する範囲は **約 35-40%**。
残り 35% は Claude (私) が PR を直接書き、25% は hkobayashi の手作業。

## 振り分け基準の原則

`07-ghi-deferred-items.md` §15 と `02-ghi-requirements-v1.0.1.md` §4.3 セキュリティ要件を踏まえ、以下は **必ず Claude が直接書く**(autonomous loop NG):

1. **RLS ポリシー**(FR-045): クロステナント漏洩 = 全提供者のデータ漏洩
2. **認証フロー**(FR-001/040): 招待トークンの単回利用・kill switch
3. **PII 検出**(FR-003): 検出漏れ = 個人情報流出
4. **クライアント案件混入チェック**(FR-043/044): NDA 違反防止
5. **My Vault 完全削除**(FR-011): 72h 物理削除の漏れ = 法務違反
6. **訓練候補データの同意取得 + 別ストレージ**(FR-046): 提供者の権利

## レビュー protocol

autonomous loop が出した PR は以下のいずれかが満たされるまで merge しない:

- [ ] Claude (私) が `gh pr view` でコード全行を確認 + 危険シグナルがない
- [ ] `secret-scan` gate PASS
- [ ] `ralph-tests` 該当範囲 PASS
- [ ] `supabase-local` gate(GHI 用に拡張)PASS、特に RLS テストが green
- [ ] (FR-043/044 関連変更があれば) クライアント名辞書テストが green
- [ ] hkobayashi が "approved" を明示
