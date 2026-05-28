# Phase 10: Ralph + Aider Resolver hybrid

Status: draft, 2026-05-28
Owner: Ralph autonomous-loop infrastructure
Successor to: Phase 8 (executor router + difficulty ladder), Phase 9 (Aider Resolver Action)

## TL;DR

We now have **two production paths** for "idea → PR" automation. They are not competing — they are for different jobs.

| Path | Best for | Costs | Trust model |
|---|---|---|---|
| **Ralph local daemon** | Operator-supervised work: a story queue the operator approves, with audit-grade JSON for every step, cost ledger per-day, NemoClaw-policy boundary on every executor call | $0.03–0.40 / PR + laptop electricity | Operator + Ralph policy spec |
| **Aider GitHub Actions Resolver** | Walk-up tasks anyone in the org can file as a GitHub Issue and have resolved without operator presence | $0.05–0.20 / PR + GitHub Actions minutes (free tier) | GitHub identity + `aider-fix` label + repo secret hygiene |

Both reach the same OpenRouter-routed LLM ladder and share the same `cost-ledger`-equivalent ceiling. Differences are in the **gating layer**, not the executor.

## Why two paths instead of one

Phase 9 PoC proved Aider on Actions can produce merge-ready PRs autonomously, on free runners, at competitive cost. That tempts a "kill Ralph daemon" narrative. We reject it because Ralph still does three things Aider Resolver cannot:

1. **Policy spec enforcement** — `src/ralph/nemoclaw-policy.js` enumerates exactly what an execution mediator may and may not do (no apply, no commit, no push, no PR, no merge, no shell escalation, secret-display denied, raw-logs denied, requested-paths regex validated). The dispatcher consults it on every Kimi call. Aider Resolver's GitHub Actions invocation skips it — Aider is allowed to `apply + commit + push + open PR` because the workflow itself is the trusted boundary, not Aider's internals.
2. **Per-day, per-account, per-story cost ledger** — `.ralph/cost-ledger.jsonl` is an append-only record with `pricing_source`, `story_id`, token counts, model. Lets us reconcile against OpenRouter monthly invoices and attribute spend per task. Aider Resolver's spend is visible only at OpenRouter's account-wide `/credits` endpoint.
3. **Approval-mode policy versioning** — `approval-policy-v1.4` (current) defines `fullauto-request → confirm → revert` semantics, expirations, audit log entries for every approval/deny/modify. The 24h soak harness, the watchdog, the stuck-story detector, the role-based gating — all sit on top of this.

So:
- **High-stakes / regulated / audit-required work → Ralph**.
- **Open-source-ish / experiment-velocity / "anyone can file an issue" → Aider Resolver**.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   IDEA INPUTS                                                       │
│   ├─ Telegram bot ─────┐                                            │
│   ├─ submit-idea CLI ──┤                                            │
│   └─ GitHub Issue ─────┼──────────────┐                             │
│                        │              │                             │
│                        ▼              ▼                             │
│   ┌────────────────────────────┐    ┌──────────────────────────┐    │
│   │  RALPH local daemon        │    │  Aider Resolver Action   │    │
│   │                            │    │                          │    │
│   │  planner (DeepSeek V3)     │    │  (no planner — uses      │    │
│   │  ↓                         │    │   issue body verbatim)   │    │
│   │  difficulty router         │    │  ↓                       │    │
│   │  ↓                         │    │  ┌────────────────────┐  │    │
│   │  ┌──────────────────────┐  │    │  │ pre-flight:        │  │    │
│   │  │ kimi-cost-tracker:   │  │    │  │ /credits + /key    │  │    │
│   │  │ isOverBudget()       │  │    │  │ cap + balance      │  │    │
│   │  └──────────────────────┘  │    │  └────────────────────┘  │    │
│   │  ↓                         │    │  ↓                       │    │
│   │  nemoclaw-policy guard     │    │  aider --auto-test       │    │
│   │  ↓                         │    │  ↓                       │    │
│   │  worktree sandbox          │    │  git commit + push       │    │
│   │  ↓                         │    │  ↓                       │    │
│   │  opencode-kimi-dispatcher  │    │  gh pr create            │    │
│   │  ↓                         │    │  ↓                       │    │
│   │  GATES / FIX_LOOP / etc.   │    │  gh pr merge --auto      │    │
│   │  ↓                         │    │                          │    │
│   │  gh pr create / merge      │    │                          │    │
│   └────────────────────────────┘    └──────────────────────────┘    │
│            │                                  │                     │
│            └────────────┬─────────────────────┘                     │
│                         ▼                                           │
│                  ┌──────────────┐                                   │
│                  │  OpenRouter  │  ← same key, same models          │
│                  └──────────────┘                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Shared substrate

These resources are common to both paths:

### OpenRouter API key

- Source of truth: GitHub repository secret `LLM_API_KEY` (Aider path) AND `~/.local/share/opencode/auth.json` (Ralph path, via Phase 8 #6 fallback in PR #217).
- Either path can be re-bootstrapped from the other. The auth.json path is also writeable via `opencode auth login openrouter`.

### Model routing (executor-router.js)

- Ralph daemon uses `src/ralph/executor-router.js` `routeExecutor()` with the Phase 8 #4 ladder:
  - trivial / easy → Kimi K2.6
  - medium → Claude Haiku 4.5 (post Phase 8 #5b — Qwen3-Coder was the original choice; replaced after live smoke #24 showed multi-file MODIFY EXISTING failure)
  - hard → Claude Sonnet 4.6 (Phase 8 #1 PR #177 evidence: $0.42 / PR)
  - architectural → GPT-5
- Aider Resolver uses repo variable `LLM_MODEL` (default `openrouter/anthropic/claude-haiku-4.5`). One global value per repo; no difficulty awareness today.
- Future merge point: Aider workflow could call `routeExecutor` via a small JS step before launching aider. Deferred.

### Cost ceiling

- Ralph daemon: `kimi-cost-tracker.isOverBudget()` reads `.ralph/cost-ledger.jsonl`, compares against `RALPH_KIMI_DAILY_BUDGET_USD` (default $5).
- Aider Resolver: Phase 9 #4 pre-flight `gh api /credits + /key`, compares `usage_daily` against repo variable `AIDER_DAILY_CAP_USD` (default $5) and balance against `AIDER_MIN_BALANCE_USD` (default $1).
- Both cap defaults are aligned at $5/day on purpose — the same OpenRouter account, the same human budget.
- Trade-off: Aider path can't see the ledger and Ralph path can't see GitHub's `/credits` cheaply on every story dispatch. They independently approximate the same constraint.

## What is NOT shared (and why)

| Capability | Ralph path | Aider path | Why not unified |
|---|---|---|---|
| Policy spec (nemoclaw-policy.js) | ✅ enforced on every dispatch | ❌ workflow itself is the trust boundary | Aider runs inside an ephemeral GHA runner; we trust the runner image + secret scoping instead of inspecting Aider's calls |
| Cost ledger per-story | ✅ `.ralph/cost-ledger.jsonl` | ❌ — only OpenRouter `/credits` aggregate | Workflow can't push to the laptop's ledger file; future: write ledger entries to a repo artifact or KV |
| Approval-mode policy | ✅ approval / fullauto / record-only | ❌ label = full approval | Aider triggers are GitHub identity-gated (labels require repo write). For higher-stakes Aider work, add branch protection requiring code review |
| FIX_LOOP across cycles | ✅ Phase 5 #4 — auto-repair across daemon cycles | 🟡 within one invocation only (`--auto-test`) | GHA runners are stateless per run; cross-run state would need either issue-comment chaining or a separate retrying workflow |
| Worktree sandbox | ✅ per-story isolated git worktree | ❌ — workflow uses one runner-scoped clone | GHA runner is itself a sandbox |
| Stuck watchdog | ✅ — `detectStuckStories` over `.ralph/stories/*.json` | ❌ | GHA timeout (10 min) is the only "stuck" signal |
| Reviewer model (per PR review-feedback FIX_LOOP) | ✅ Sonnet 4.6 via `pr-reviewer.js` + auto-repair Phase 5 #4 | ❌ — `--auto-test` is the only quality gate | Adding a Sonnet-reviewer step inside the Aider workflow is straightforward; deferred |

## Operating modes

### Mode A: walk-up issue (Aider Resolver)

1. Someone in the org files a GitHub Issue with paths in backticks for any files to touch.
2. They (or maintainer) add the `aider-fix` label.
3. Aider Resolver workflow:
   - acknowledges on issue with a status comment
   - calls OpenRouter `/credits` + `/key` for pre-flight cost gate (Phase 9 #4)
   - installs aider-chat + npm deps + Playwright chromium
   - runs `aider --auto-test --test-cmd "npx playwright test ..."` headless
   - commits, pushes `auto/issue-<N>` branch, opens PR, enables auto-merge or immediate-merges
4. Auto-merged PR closes the issue via "Closes #N".

**Tested with**: PRs #188 (1 issue, sequential), #193+#194 (2 issues, parallel), and the Phase 10 mini-soak (20 issues, 12-min intervals — see `docs/phase10-mini-soak-2026-05-28.md` once that's written).

**When to use**: any task that can be expressed in a clear issue body and that touches files independent of in-flight Ralph stories. Especially good for: dependency bumps with API changes that need code adjustment, doc fixes, new utility helpers, lint cleanups, small refactors.

### Mode B: operator-driven story (Ralph daemon)

1. Operator runs `submit-idea` CLI or files via Telegram bot.
2. Idea-refiner (DeepSeek V3 planner) produces JSON spec with `requested_paths`, `difficulty`, `recommended_executor`.
3. Operator (or fullauto mode) approves the plan.
4. Ralph dispatches via `opencode-kimi-dispatcher`:
   - reads OpenRouter key from env or auth.json (Phase 8 #6)
   - checks `isOverBudget` against `.ralph/cost-ledger.jsonl`
   - spins up per-story worktree, calls `opencode run` for chosen model
   - validates patch against requested_paths regex, secret patterns, forbidden runtime args
5. Gates phase: lint + coverage + targeted tests. If gates fail → FIX_LOOP, another dispatch attempt (capped by `max_attempts`).
6. Approval-mode-aware: in approval mode the operator OKs the diff; in fullauto mode it auto-approves with audit entries.
7. PR creation + Sonnet reviewer + (if reviewer says request_changes) review-driven FIX_LOOP.
8. Merge.

**When to use**: anything that needs to land with a paper trail (regulated environment, post-incident remediation, large refactors), or anything that depends on the difficulty router (e.g. an "architectural" task that should reach GPT-5 not Haiku).

## Migration / handoff scenarios

### "An issue is too big for Aider Resolver"

Symptom: PR opens but Aider's `--auto-test` fails repeatedly; or Aider produces nothing (Open PR step says "no diff").

Action:
1. Manually convert the issue to a `submit-idea` invocation.
2. Let Ralph's planner classify difficulty.
3. If `medium/hard/architectural`, Ralph routes to a stronger model (Haiku/Sonnet/GPT-5) and adds FIX_LOOP across attempts.

### "A Ralph daemon story is too small / wants to be event-driven"

Symptom: operator wants to file 10 mechanical refactors and walk away; they don't need approval mode.

Action:
1. File each as a GitHub Issue with backticked target paths in the body.
2. Apply `aider-fix` label.
3. Walk away; auto-merge handles the rest. Watch `gh pr list` for stragglers.

### "Cost spiked"

Symptom: daily OpenRouter spend high, source unclear.

Action:
1. Inspect Ralph side: `node scripts/ralph/status.js` (Phase 5 #6) shows `daily_spend` from `.ralph/cost-ledger.jsonl` per model.
2. Inspect Aider side: `gh run list --workflow aider-resolver.yml --limit 20` + filter for "Pre-flight cost ceiling check" annotations.
3. If Aider-driven: lower `AIDER_DAILY_CAP_USD` via `gh variable set`.
4. If Ralph-driven: lower `RALPH_KIMI_DAILY_BUDGET_USD` in the daemon env and restart.

### "Aider Resolver auth.json got wiped"

Action:
- Re-run `opencode auth login openrouter` and paste the OpenRouter key.
- Ralph daemon picks up the new value automatically via Phase 8 #6 fallback.
- Aider Resolver doesn't need this; it reads from repo secret `LLM_API_KEY`. Update via `gh secret set LLM_API_KEY` if the OpenRouter key was rotated.

## Open design questions / next steps

1. **Shared cost ledger**: write Aider Resolver runs to `.ralph/cost-ledger.jsonl` via a follow-up workflow step that posts an entry as a GitHub repo artifact / discussion comment. Today the two ledgers are independent.
2. **NemoClaw-style policy guard for Aider**: implement an Action step that scans Aider's diff for forbidden patterns (secrets, requested_paths violations, large `node_modules` adds, etc.) before allowing the merge. Would mirror `nemoclaw-policy.js` constraints on the GHA side.
3. **Difficulty routing for Aider**: small step before `aider` invocation that calls `node -e "require('./src/ralph/executor-router').routeExecutor(...)"` on the issue body. Free upgrade in quality for "hard" tasks if it actually fires.
4. **Sonnet reviewer step on Aider PRs**: add a workflow step after `gh pr create` that calls `src/ralph/pr-reviewer.js` (or a packaged-up version of it) and converts a `request_changes` verdict into an `@aider-fix` follow-up comment on the same PR. Brings Phase 5 #4 review-driven FIX_LOOP to the Aider path.
5. **Stuck watchdog for Aider**: a periodic workflow that scans for `auto/issue-<N>` branches older than X days and closes their PRs with a comment if Aider's `--auto-test` never converged.

## References

- `docs/adr-2026-05-14-retire-nemoclaw-mediator-default.md` — why opencode-kimi-direct is the Ralph default dispatcher.
- `src/ralph/executor-router.js` — Phase 8 #4 difficulty ladder.
- `src/ralph/kimi-cost-tracker.js` — Ralph cost ledger + budget cap.
- `src/ralph/nemoclaw-policy.js` — authoritative policy spec (action whitelist, forbidden args, secret patterns, redaction rules).
- `src/ralph/opencode-kimi-dispatcher.js` — Ralph executor path; PR #217 added auth.json fallback.
- `.github/workflows/aider-resolver.yml` — Phase 9 Aider Resolver Action (cost gate + auto-test + auto-merge).
- PRs: #176 (postReviewToPR), #177 (Sonnet hard executor), #178 (DeepSeek planner), #179 (Phase 8 #4 ladder), #180 (Haiku medium swap), #184 (Aider Resolver wiring), #187 (`--auto-test`), #190 (cost ceiling), #195 (auto-merge), #217 (auth.json fallback), #219 (clean-status fallback).
