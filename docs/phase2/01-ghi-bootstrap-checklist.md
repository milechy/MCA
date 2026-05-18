# GHI Bootstrap Checklist

**目的**: GHI(General Human Intelligence)α 版開発を autonomous loop で開始するために、hkobayashi 側で揃える必要がある外部リソース・credentials の一覧。

**Stage 3 起動の前提**: 本ファイルの全項目が ✅ になっていること。

---

## 1. GitHub repository

### 1.1 `moore-corp/ghi` (private repo)

- [ ] organization `moore-corp` に private repo `ghi` を作成
- [ ] hkobayashi が admin 権限を持つ
- [ ] Claude / autonomous loop の作業者(Claude session)が write 権限を持つ(`gh auth status` で確認)
- [ ] `main` (or `infra/phase0-autonomous-foundation` 相当の trunk) ブランチを default に
- [ ] `.gitignore` 初期化(`node_modules/`, `.env`, `*.mp4`, `.ralph/` などを除外)
- [ ] 初回 commit + push 完了

**確認コマンド**:
```bash
gh repo view moore-corp/ghi --json visibility,defaultBranchRef,viewerPermission
```

### 1.2 GitHub Token

- [ ] `GH_TOKEN` 環境変数に `repo:write` 権限つき token を設定
- [ ] autonomous loop の `github-pr-client.js` が PR を open 可能

---

## 2. DIA1000 Supabase Cloud

`03-ghi-architecture.md` で「`ghi` スキーマで分離」とある通り、DIA1000 と DB 共有。

### 2.1 admin アクセス

- [ ] DIA1000 Supabase Cloud project URL: ____ (例: `https://xxx.supabase.co`)
- [ ] service_role key を `.env.ghi` に保管(本番では Vault 等に格納、git に絶対 commit しない)
- [ ] hkobayashi が Supabase Dashboard に owner として参加

### 2.2 `ghi` スキーマと DB ロール

`05-ghi-day1-tasks.md` の [GHI-001] に記載の SQL を実行:

- [ ] `CREATE SCHEMA IF NOT EXISTS ghi;`
- [ ] `CREATE ROLE ghi_app NOINHERIT;`
- [ ] `CREATE ROLE ghi_admin NOINHERIT;`
- [ ] Schema/Privilege grants 完了
- [ ] pgvector extension が `extensions` schema にあり `ghi_app` から USAGE 可能

**確認 SQL**:
```sql
SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'ghi';
SELECT rolname FROM pg_roles WHERE rolname IN ('ghi_app', 'ghi_admin');
```

### 2.3 pgTAP 拡張

- [ ] DIA1000 で `CREATE EXTENSION IF NOT EXISTS pgtap;`
- [ ] `tests/rls/` ディレクトリで `supabase db test` が成功する基盤

### 2.4 既存 DIA1000 テーブルへの影響評価

- [ ] DIA1000 担当の現状(`ghi-cache-summary.md` §v1.0.1 認識ずれ)で確認した:
  - 全テーブル `public` schema にあり、`ghi` は未作成 ← 本作業で新設
  - Supabase Cloud の Pro プラン自動バックアップが有効か確認
  - 既存マイグレーションファイル (`supabase/migrations/`) との衝突なし

---

## 3. Hetzner CPX31 VPS

`03-ghi-architecture.md` §Hetzner CPX31 VPS 内の構成 参照。

### 3.1 契約

- [ ] Hetzner Cloud account 開設
- [ ] CPX31 (4 vCPU / 16GB / 80GB) を東京リージョン or 近接リージョンで契約
- [ ] 月額 ¥4,200 を支払い設定

### 3.2 SSH

- [ ] ed25519 鍵を新規生成(GHI 専用、業務用と分離)
- [ ] 公開鍵を VPS に登録、`root` パスワード認証を無効化
- [ ] `~/.ssh/config` に host alias 登録(例: `ghi-vps`)

**確認**: `ssh ghi-vps echo ok` で `ok` が返る

### 3.3 OS / 基本セットアップ

- [ ] Ubuntu 24.04 LTS インストール
- [ ] `apt update && apt upgrade -y` 完了
- [ ] `ufw` 有効化、 22/80/443 のみ開放
- [ ] Docker + Docker Compose plugin インストール(OrbStack ローカル開発 → 本番 Docker)
- [ ] Caddy 2 インストール、Let's Encrypt 自動更新設定
- [ ] (任意) Tailscale なし、Cloudflare Tunnel なしで直接 HTTPS 公開の方針確認

---

## 4. ドメイン

- [ ] `ghi.moore.jp` (or 同等) を確保
- [ ] A レコード → Hetzner CPX31 VPS の IP
- [ ] Caddy 設定で TLS 自動取得確認

---

## 5. 外部 API keys

### 5.1 OpenRouter (LLM)

- [ ] アカウント作成、初期入金($20 程度)
- [ ] API key 発行、`.env.ghi` に `OPENROUTER_API_KEY=` で保管
- [ ] Phase 1 で利用実績ある `moonshotai/kimi-k2.6` モデルが GHI でも使えるか確認

### 5.2 Groq (Whisper STT)

- [ ] アカウント作成
- [ ] API key 発行、`.env.ghi` に `GROQ_API_KEY=` で保管
- [ ] Whisper Large-v3 の利用可否確認

### 5.3 VLM Provider (画面要素認識)

`02-ghi-requirements-v1.0.1.md` §FR-005、`04-ghi-claude-code-setup.md` §VLM 第一候補 参照。
[UNCONFIRMED-003] のため、Day 1 で複数候補比較。

候補:
- [ ] UI-TARS(Apache 2.0、ローカル実行可)— 第一候補
- [ ] Claude Sonnet 4.6 VLM(精度高い、コスト高)
- [ ] GPT-4o VLM(中程度)
- [ ] Qwen2-VL(OSS、Apache 2.0、自前ホスト可)

Stage 3 開始時点では UI-TARS を採用し、後で `vlm-prompt-tuner` subagent (`04-ghi-claude-code-setup.md` 参照) で比較する方針。

---

## 6. Sentry

- [ ] DIA1000 共通 Sentry project への access(既存)
- [ ] GHI 用に DSN を発行(同 project 内で project name = "ghi" でタグ分け)
- [ ] PII を含むログのマスキング設定確認

---

## 7. Asana

- [ ] Asana の「GHI α版」プロジェクト作成
- [ ] Asana MCP が autonomous loop の daemon から呼べる(`tools/asana_*` の動作確認)
- [ ] `05-ghi-day1-tasks.md` の GHI-001 〜 GHI-024 を Asana に登録

---

## 8. 録画専用環境(FR-043)

`02-ghi-requirements-v1.0.1.md` §3 FR-043 + `05-ghi-day1-tasks.md` Day 1 確認ポイント #1 参照。

- [ ] 業務環境(クライアント案件用 Mac)とは別の PC または VM を準備
- [ ] OBS Studio or 同等の録画ツールインストール
- [ ] 業務関連アプリ(Slack, Notion, Asana の業務 PJ, クライアント repo)が**インストールされていない**ことを確認
- [ ] FR-043/FR-044 の運用ルールを `docs/operations/recording-env.md` 等で明文化
- [ ] テスト録画 1 本実施(hkobayashi 自身が短い操作録画を撮る)

**重要**: ここで撮影された動画には、ムーアのクライアント案件(IDS, AVAS, 介護AI)の画面が**絶対に**映ってはいけない。NDA違反になる。

---

## 9. autonomous loop 側の準備(MCA Phase 2 完了が前提)

Stage 2 (`00-roadmap.md` 参照) が完了していること:
- [ ] Phase 2 #2: risk_evaluator が `src/**` に対しても Risk 2 として fullauto 可能
- [ ] Phase 2 #3: path-filter gate suite が動作
- [ ] Phase 2 #4: Kimi prompt が "modify existing file" を扱える
- [ ] Phase 2 #5: budget cap が `.ralph/cost.json` などで実装済み
- [ ] Phase 2 #6: MCA-internal soak で real-code PR が出ている実績

---

## 10. 法務・運用前提(α 版 MUST)

- [ ] FR-012 α版利用規約・プライバシーポリシーが文書化(loop が雛形、人間レビュー必須)
- [ ] §15 見送り事項の再点検トリガー (`07-ghi-deferred-items.md`) を運用ルール化
  - 特に「提供者 10 名超え」「Hermes Agent 破壊的変更」「DIA1000 バックアップ問題」のモニタ
- [ ] hkobayashi 自身が α 提供者 #1 として登録する自覚を持つ(ドッグフーディング前提)

---

## チェックリスト完了後

このファイル冒頭の "前提" がすべて ✅ になったら、Claude に次の発話を送る:

```
GHI bootstrap checklist 完了。Stage 3 を起動して。
```

これで autonomous loop が `moore-corp/ghi` repo に対して GHI Day 1 タスクを開始する。
