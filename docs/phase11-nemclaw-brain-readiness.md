# Phase 11 調査レポート: NemClaw を「学習する指揮官」にするための適合性評価

Status: investigation, 2026-05-29
調査対象: 現行の構造 / コード / データ層が「NemClaw = 難易度判定 + LLM適材適所ルーティングを学習で精度向上させる頭脳」を載せられるか

---

## 0. 結論（先に正直に）

**現状は「載らない」。だが致命的ではなく、土台の3点を整えれば載る。**

ユーザーの構想を一言でいうと:
> NemClaw が「このプロジェクトはこの難易度」「この機能のコーディングはこのLLMが適任」を判断し、結果(成功/失敗/コスト/手戻り)から**学習して精度を上げ続ける**指揮官になる。

これに対して現状は:

| 構想が要求するもの | 現状 | ギャップ |
|---|---|---|
| 「NemClaw という頭脳」 | NemoClaw は**退役した安全境界**(policy enforcement)。判断も学習も一切しない | 🔴 **頭脳は存在しない。完全に新規** |
| 難易度判定 | DeepSeek V3 planner が**一発分類**(trivial/easy/medium/hard/architectural) | 🟡 判定はあるが学習しない・後から見直さない |
| LLM適材適所ルーティング | `executor-router.js` の**凍結された静的テーブル**(`Object.freeze`) | 🟡 ルーティングはあるが固定。実行時に変わらない |
| 結果から学習 | **皆無**。grep で learn/feedback/bandit/reward 全て不在 | 🔴 フィードバックループがゼロ |
| 学習を貯めるDB | Supabase config のみ。**未配線**。実データは追記JSONL | 🔴 学習基盤として不適 |

つまり「指揮官の精度を学習で上げる」のうち、**判定・ルーティングの"型"はあるが、学習する仕組みと学習を貯める器が無い**。

---

## 1. 「NemClaw = 頭脳」という呼称の重大な誤解（最初に解くべき）

コードベースの `NemoClaw` は、ユーザーが想像している「指揮官」とは**正反対のもの**です。

- `src/ralph/nemoclaw-policy.js` = **やってはいけないことの番人**。apply/commit/push/PR/merge/deploy/shell escalation を**禁止**し、secret を redact し、requested_paths を正規表現で検証するだけ。
- `docs/adr-2026-05-14-retire-nemoclaw-mediator-default.md` = NemoClaw は **2026-05-14 にデフォルト実行系から退役済み**。理由は依存する `openclaw` バイナリ(Moonshot 社内ツール)がインストール不能だったため。今は opt-in (`RALPH_DISPATCHER=nemoclaw`) でしか動かない。

→ **「NemClaw に頭脳をやらせる」は、既存の NemoClaw を拡張するのではなく、新しい指揮官コンポーネントを作る話**。名前を NemClaw にするのは自由だが、現状の nemoclaw-policy.js とは別物として設計すべき。混同するとセキュリティ境界(やってはいけないことの番人)と意思決定(何をどのLLMでやるか)が癒着して危険。

**推奨**: 指揮官を **`orchestrator` / `conductor`** のような別レイヤーとして新設し、NemoClaw-policy は「指揮官の決定を実行する際の安全ガード」として下位に残す。役割分離を保つ。

---

## 2. 現状の意思決定フロー（実地確認済み）

```
idea (人間)
  │
  ▼
idea-refiner.js  ── DeepSeek V3 が一発で JSON spec 生成
  │                 { title, requirement, requested_paths,
  │                   difficulty: "medium",          ← ★一度きりの分類
  │                   recommended_executor }
  ▼
executor-router.js ── routeExecutor()
  │                    difficulty → DIFFICULTY_TIER_MODELS[difficulty]  ← ★凍結テーブル
  │                    (story.executor_model があればそれ優先)
  │
  │   const DIFFICULTY_TIER_MODELS = Object.freeze({
  │     trivial:       'openrouter/moonshotai/kimi-k2.6',
  │     easy:          'openrouter/moonshotai/kimi-k2.6',
  │     medium:        'openrouter/anthropic/claude-haiku-4.5',
  │     hard:          'openrouter/anthropic/claude-sonnet-4.6',
  │     architectural: 'openrouter/openai/gpt-5'
  │   });
  ▼
opencode-kimi-dispatcher.js ── 選ばれたモデルで実行
  ▼
GATES → (失敗) FIX_LOOP → 同じモデル・同じ難易度で再試行  ← ★ここでも学習しない
  ▼
PR → merge
  ▼
結果は cost-ledger.jsonl / stories/*.json / audit.jsonl に記録される
  │
  └──✗──> どこにも戻らない。次の routing 判断に一切影響しない
```

**核心的な欠陥**: 結果データ(成功率・コスト・手戻り回数)は**記録されているのに読み返されない**。学習ループの「環」が閉じていない。

---

## 3. データ層の評価（学習基盤として）

### 3.1 現状: 追記 JSONL + 個別 JSON ファイル。DB なし。

| 保存先 | 形式 | 内容 |
|---|---|---|
| `.ralph/stories/*.json` | 個別JSON (18件) | story の状態・difficulty・executor_model・audit イベント列 |
| `.ralph/cost-ledger.jsonl` | 追記JSONL (59行) | model別コスト・トークン・story_id |
| `.ralph/logs/audit.jsonl` | 追記JSONL (3285行) | approval イベント |
| `supabase/` | config.toml のみ | **DB は未配線**。migration・接続コード・依存パッケージ全て無し |

`package.json` の依存は **ゼロ**(devDeps が Playwright と @types/node のみ)。DB ドライバも ML ライブラリも無い。

### 3.2 「medium 難易度の refactor で最もコスパの良いモデルは?」を今のデータで答えられるか

**答えられるが、実用に耐えない**:
- story から `difficulty=medium` を抽出 → 各 story_id を cost-ledger.jsonl 全行スキャンで突合 → model別に集計、という O(n×m) のファイルスキャンが必要。
- 18 story / 59 行なら手で書ける。**1000 story / 数万行になると毎クエリ 10M 行パース**で破綻。
- 致命的な構造欠陥:
  1. **outcome が非正規化されていない** — `status: "completed"` が「PRマージ済」か「レビュー待ち」か区別不能(audit イベント列を読まないと分からない)。
  2. **executor の総コストが story に無い** — cost-ledger を別途集計が必要。`story_id: null` の planner コストと混在。
  3. **attempt 番号が cost-ledger に無い** — 3回手戻りした時、各コストがどの試行かタイムスタンプ推測でしか分からない。
  4. **join キーはあるが index が無い** — 集計用の事前ロールアップ(`success_rate_by_model` 等)が存在しない。

→ **運用ダッシュボード(現状確認)には十分。アルゴリズム学習には不適**。

---

## 4. NemClaw 頭脳化に必要な3つの土台

### 土台① 結果フィードバックの「環」を閉じる（最重要・コア機能）

学習の本質はこれ。今は記録するだけ。必要なのは:

```
routing decision (difficulty=medium → Haiku) を記録
  ↓
実行 → 結果 (成功? gates何回で通った? 総コスト? 手戻り?) を**同じレコードに追記**
  ↓
次の routing 時に「過去の (difficulty, model) → 成功率/コスト」を参照して選ぶ
```

実装の最小形は **contextual bandit / Thompson sampling**:
- context = {difficulty, task種別(CREATE/MODIFY), ファイル数, 言語, 仕様文字数...}
- arm = candidate models (Kimi/Haiku/Sonnet/GPT-5/...)
- reward = 成功(+1) − 正規化コスト − 手戻りペナルティ
- 各 (context bucket, model) の事後分布を更新し、探索と活用をバランス

これなら「Phase 8 #5 で Qwen が medium で 3連敗」のような事象を**人間が手で `DIFFICULTY_TIER_MODELS` を書き換えなくても自動で学習**して回避できる。今はまさに私が手で Haiku に差し替えた(PR #180)。それを NemClaw が自律的にやる、が構想の核心。

### 土台② 学習を貯める構造化ストア（DB）

JSONL では学習データの蓄積・クエリに耐えない。Supabase が既に config だけある = **最小コストで Postgres を起こせる**。必要なスキーマ(最小):

```sql
-- 1 タスク 1 行。routing 決定と結果を同じ行に。
CREATE TABLE task_outcomes (
  story_id        text PRIMARY KEY,
  -- context (NemClaw の判断入力)
  difficulty      text,           -- trivial..architectural
  task_kind       text,           -- create | modify | refactor | test_only ...
  requested_paths int,            -- ファイル数
  language        text,
  spec_chars      int,
  -- decision (NemClaw が選んだ)
  planner_model   text,
  executor_model  text,
  routing_source  text,           -- difficulty_tier | bandit | explicit
  -- outcome (環を閉じる)
  succeeded       boolean,        -- gates 通過 AND PR マージ
  fix_loop_attempts int,
  planner_cost_usd  numeric,
  executor_cost_usd numeric,
  wall_seconds    int,
  failure_class   text,           -- coverage_incomplete | invalid_patch | ...
  created_at      timestamptz,
  completed_at    timestamptz
);

-- bandit の事後分布(model × context bucket ごと)
CREATE TABLE routing_policy (
  context_bucket  text,           -- e.g. "medium|modify|js|2files"
  model           text,
  trials          int,
  successes       int,
  cost_sum_usd    numeric,
  updated_at      timestamptz,
  PRIMARY KEY (context_bucket, model)
);
```

GitHub Actions(Aider 経路)からも書けるよう、Supabase REST/RPC で append できる。Ralph daemon も同じ表に書く → **両経路の学習が1つの脳に集約**(Phase 10 doc の "shared ledger" 課題が解決)。

### 土台③ 指揮官レイヤーの新設（NemClaw orchestrator）

`executor-router.js` の `routeExecutor()` を「凍結テーブル lookup」から「policy参照 + bandit」に進化。
- 既存の static ladder は **cold-start のデフォルト/事前分布**として残す(Phase 8 の知見はムダにしない)。
- 試行が貯まったら bandit が引き継ぐ。
- 安全のため: NemClaw の決定は必ず nemoclaw-policy の安全境界を通す(役割分離 §1)。

---

## 5. 段階的ロードマップ（破壊を避けつつ）

| Phase | やること | 学習に効くか | リスク |
|---|---|---|---|
| **11-A** | task_outcomes をまず JSONL→Supabase に二重書き(既存JSONLは残す)。outcome 正規化フィールド(succeeded/total_cost/attempts/failure_class)を story 完了時に1行 emit | 学習データの蓄積開始 | 低(追記のみ) |
| **11-B** | 蓄積データで**オフライン分析**。「difficulty×model の成功率/コスト」を可視化。人間が ladder を見直す判断材料に(今は勘) | 半自動学習 | 低 |
| **11-C** | `routeExecutor` に bandit を導入。static ladder を prior に、Supabase の routing_policy を参照。explicit override は維持 | **自動学習 ON** | 中(ルーティング挙動が変わる→ A/B やシャドーで検証) |
| **11-D** | 難易度判定そのものも学習対象に。planner の difficulty 予測 vs 実際の手戻り/コストを突合し、planner プロンプトor後段補正を校正 | 判定精度も学習 | 中 |
| **11-E** | NemClaw を独立サービス化(指揮官 API)。Ralph daemon と Aider Action の両方が問い合わせる単一の脳に | 構想の完成形 | 高(アーキ変更) |

**最小で価値が出るのは 11-A + 11-B**。ここまでで「データが貯まり、適材適所が数字で見える」。11-C から本当の意味での自律学習。

---

## 6. 現構造の「良いところ」（活かせる資産）

破壊ではなく拡張で済む理由:
- ✅ **routing 決定が既に構造化されて記録**されている(`routing_source`, `difficulty_tier`, `reason` フィールド)。学習の入力 context はほぼ揃っている。
- ✅ **provider 抽象が既にある**(`provider-config.js`, `executor-router.js`)。multi-LLM の差し替え口は設計済み。
- ✅ **コストが per-call で記録**されている(cost-ledger)。reward 計算の材料がある。
- ✅ **Supabase が config 済み**。DB の立ち上げが速い。
- ✅ **OpenRouter 経由で全LLM統一**。NemClaw が任意のモデルに振り分ける物理経路は既に通っている。
- ✅ **役割分離の思想が既にある**(nemoclaw-policy = 安全, dispatcher = 実行, router = 選択)。指揮官を足す隙間が明確。

欠けているのは「環を閉じる線」と「学習を貯める器」の2本だけ。型は揃っている。

---

## 7. 外部LLMへの問い合わせプロンプト（設計の壁打ち用）

以下を ChatGPT / Gemini / Grok / Perplexity にそれぞれ投げて、設計の妥当性をクロスチェックすることを推奨。`docs/phase11-external-llm-prompts.md` に格納。

→ **2026-05-29 実施済み。回答統合は §8 を参照。§4-5 のロードマップは §8 の結論で上書きされた。**

---

## 8. 外部LLM 4社の回答統合（2026-05-29）と改訂ロードマップ

ChatGPT(GPT-5) / Gemini / Grok / Perplexity に §7 のプロンプトを投げて回答を得た。以下が統合結論。

### 8.1 全4社の一致・分岐マトリクス

| 論点 | ChatGPT | Gemini | Grok | Perplexity |
|---|---|---|---|---|
| RL / 自作ML訓練 | ❌過剰 | ❌データ過疎 | ❌負ROI | ❌時期尚早 |
| データ収集＋固定表を数字で見直す | ✅Phase0-1 | ✅推奨 | ✅(これが上限と主張) | ✅Phase2 |
| 自作 online bandit を"次の一手"に | ✅本命 | ✅本命 | ❌過剰 | ❌(研究段階・本番標準でない) |
| 既製ルーター(OpenRouter auto/LiteLLM)を先に入れる | — | — | ✅(商用router容認) | ✅**最優先推奨** |
| 非定常環境(モデル価格/性能の激変)への警告 | — | — | 🔴**唯一強く警告** | (既製品が吸収) |
| 難易度判定(LLM-as-judge)の信頼性 | — | reflectionで校正 | — | 🔴**較正必須・単発鵜呑み厳禁** |

### 8.2 全会一致で確定した事項（高確度・即採用）

1. **RL も自作ML分類器もやらない。** 月1000件規模では over-engineering / データ過疎で過学習。4社全員一致。
2. **まずデータ収集と「固定表を数字で見直す」までは全員が肯定。** ここに異論ゼロ。最初の価値はここで出る。
3. **既存の固定 ladder は捨てない。** 事前分布 / cold-start デフォルト / 数字見直しのベースラインとして全段階で活きる。
4. **安全境界は学習させない。** ChatGPT が最強に言語化: 「安全違反 = -100 reward」は危険(期待値で突破しようとする)。`if violates_policy: deny` の hard constraint にする。NemoClaw-policy は意思決定層から分離したまま。

### 8.3 分岐点と、その決着

**唯一の本質的分岐 = 「自作 online bandit を作るか」**。

- ChatGPT/Gemini は「作る」だが、両者とも **Phase 4以降 / 余力があれば** と条件付き。
- Grok は「作るな」(負ROI・非定常で陳腐化・運用地雷)。
- Perplexity は「まだ早い、既製品を先に。bandit は研究段階で本番標準でない」。

→ **実質 3対1 で「自作 bandit は今やる手ではない」**。ChatGPT/Gemini の "本命" も即時着手ではなく将来オプション。

**決着**: Perplexity が出した第三の道 ―― **我々は既に OpenRouter 経由。OpenRouter auto-router(NotDiamond製, prompt複雑度/タスク種別/能力で自動選択)が存在する** ―― がこの分岐を解消する。自作 bandit のインフラ・監視・非定常対応(Grok の懸念)を**全て既製品にアウトソース**でき、かつ動的選択の利得(ChatGPT/Gemini)を得られる。

### 8.4 Grok の批判の精査（採るべき点・退ける点）

| Grok の論点 | 判定 | 理由 |
|---|---|---|
| 非定常環境で学習policyが陳腐化 | 🔴**採用** | DeepSeek R1級の急落・逆転は実在。自作するなら recency-decay/忘却機構が必須。既製品なら provider 側が吸収 |
| cold-start + ベンダー依存 | 🔴**採用** | 新モデル登場でデータ不足。既製品 + 固定prior で緩和 |
| 自作の負ROI | 🟡**条件付き採用** | 「自作前提」では正しい。既製品利用なら無効化 |
| ルーティング判断のレイテンシ/会話一貫性崩壊 | ⚪**退ける** | Grok はチャットの per-query routing を想定。我々は1タスク約100秒のコーディングroutingなので0.2-2秒は無視可、会話一貫性も無関係 |
| eval の ground-truth 収集困難 | ⚪**退ける** | チャットは「満足度=ノイズ」。我々は **gates通過 + PR merge + コスト = 自動取得できるクリーンな正解信号**。ここが我々固有の最大の優位 |

→ Grok の批判は「チャット用router」には全面的に正しいが、「コーディングタスク用router」には半分。我々の use case は懸念2つ(レイテンシ・ground truth)を構造的に回避している。だが非定常・cold-start・負ROI の3点は正当な警告として設計に織り込む。

### 8.5 浮かび上がった真の弱点 = 難易度判定（ルーティングではない）

Gemini(reflection校正) と Perplexity(LLM-as-judge較正研究) が独立に指摘:
- 我々の **DeepSeek V3 が一発で出す `difficulty` が信頼性の弱い環**。
- ルーティング表を bandit で磨くより、**難易度判定の較正の方が ROI が高い**可能性が高い。
- Perplexity の知見: judge を difficulty estimator に使うなら reference answer 付与 + 複数サンプル平均 + 人手一致確認が必須。単発スコア鵜呑みは方向ごと誤る。

### 8.6 改訂ロードマップ（4社統合・§4-5を上書き）

| Phase | 内容 | 根拠(どの社) | やる/保留 |
|---|---|---|---|
| **11-A データ基盤** | Gemini の2テーブル schema(`tasks`/`model_executions`)を Supabase に。冪等性=決定的UUIDv5+ON CONFLICT、楽観排他=updated_at、zombie対策=running/完了の2回書き+stale sweep。既存JSONLは残し二重書き | 全社(基盤) + Gemini(具体) | ✅**最優先** |
| **11-B 可視化** | (difficulty × model) の成功率/コスト/手戻りを集計表示。固定 ladder を勘でなく数字で四半期見直し | 全社一致 | ✅**次** |
| **11-C 既製ルーター shadow** | `openrouter/auto`(NotDiamond) を recommend-only で並走させ、我々の固定 ladder と成功率/コストを比較。**自作ゼロ**。良ければ一部 tier を委譲 | Perplexity(本命) + ChatGPT(shadow) | ✅**buy not build** |
| **11-D 難易度較正** | planner予測difficulty vs 実績(retries/cost由来のactual_difficulty)の乖離を検知 → reflection で1文ルール生成 → pgvectorで類似過去事例を動的few-shot注入。judge較正(複数サンプル/reference)を厳守 | Gemini + Perplexity | ✅**真の弱点・高ROI** |
| **11-E 自作bandit** | Thompson Sampling contextual bandit。固定ladderを事前分布、recency-decayで非定常対応、bounded exploration(10%/safe subset/失敗率閾値で自動停止)、quality_score(binary+rubric)−λcost の reward(reward hacking対策) | ChatGPT/Gemini(設計) | ⏸**保留**。11-A〜D で不足が実証され、かつ ①ボリューム増 ②eval基盤完備 ③既製品で足りないと判明、の3条件が揃った時のみ |

**今やるのは 11-A → 11-B → 11-C → 11-D。11-E は明示的な3条件ゲートの後ろに封印。**

これは ChatGPT/Gemini の「bandit は将来本命」を否定せず、Grok の「今 bandit はやめろ」を尊重し、Perplexity の「buy first」を主軸に据えた、4社全部を満たす唯一の順序。

### 8.7 「NemClaw = 頭脳」構想の再定義

当初構想「NemClaw が学習して自律的にLLMを振り分ける脳」は、4社統合の結果こう再定義すべき:

- ❌ from-scratch の学習ML脳(RL/bandit を最初から自作) → 全社が否定
- ✅ **NemClaw = (1)結果データを集める較正レイヤー + (2)固定prior+既製auto-router+数字見直しで適材適所を出す薄い指揮 + (3)難易度判定の自己校正**。安全境界(nemoclaw-policy)とは分離。
- 「学習」の主戦場は **難易度較正(11-D)** であって、ルーティング bandit(11-E)ではない。
- 自作 bandit は「データと評価基盤が育ち、既製品で足りないと数字で証明された後」の最終形であり、入口ではない。
