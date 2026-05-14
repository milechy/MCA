# Ralph Detailed Design v0.2

Status: **confirmed**, reflects the implementation merged through PR #45 and PR #46 on `infra/phase0-autonomous-foundation`.

This document is the implementation-level companion to the v1.3 requirements. Where v1.3 says *what* must hold ("approval objects are immutable, plan_hash is canonical JSON, Risk 5 is a stop not a skip"), v0.2 here says *how* the code does it and *where* each rule actually lives. Operators and reviewers should be able to use it to trace any v1.3 requirement to a concrete module, function, and test.

## 0. Scope and non-goals

In scope:

- Ralph autonomous loop on a single host
- OpenCode-mediated code generation through Kimi K2.6 (and any compatible Kimi variant) via OpenRouter
- NemoClaw mediator (installed but currently inert — see §8)
- Approval / risk / mode / gates / failure escalation
- GitHub Issue supplier as a continuous story source
- Local sandbox isolation via per-story git worktree

Explicit non-goals (deferred or out of scope):

- Production deploy from Telegram
- Production database migration from Telegram
- Merge from Telegram
- Unrestricted shell access for any agent
- Raw logs reaching any agent, Telegram, or persisted artifact
- Agent-initiated apply / commit / push / PR without the existing approval chain
- Model-driven policy bypass
- Model access to raw secrets

## 1. Approval object — full specification

### 1.1 Object shape

```text
approval_id          string  APR-<TYPE>-<STORY|JOB>-<TIMESTAMP>
approval_type        enum    plan | diff | migration | deploy | mode_change | resume_after_security_stop
story_id             string  STORY-<id> or null for mode-change
plan_hash            string  sha256:<hex> over canonical JSON plan
pre_exec_diff_hash   string|null  sha256 over `git diff` BEFORE execution
post_exec_diff_hash  string|null  sha256 over `git diff` AFTER execution
risk                 object  { score: 0..5, category: low|medium|high|destructive|stop, label: 'RISK_<n>_<TAG>' }
control_decision     object  { action, reason, approval_type, mode, target_env, risk_score, requires_human, executable }
status               enum    pending | approved | denied | expired | executed | superseded | revoked | failed_verification | cancelled
created_at           ISO8601
expires_at           ISO8601  default 24h after created_at, mode_change/fullauto bounded by §2.3
approved_by          string|null  Telegram user_id or 'ralph:autonomous-loop' for auto records
audit                array   bounded list of {event, at, status, ...}
```

### 1.2 Modules

| Concern | File |
|---|---|
| Object creation, supersede, audit append | `src/ralph/approval-manager.js` |
| Status enum | `src/ralph/types.js` `APPROVAL_STATUSES` |
| Type enum | `src/ralph/types.js` `APPROVAL_TYPES` |
| Persisted log | `.ralph/approval-log.jsonl` (gitignored, runtime-only) |
| Pending records | `.ralph/approval-pending/<approval_id>.json` (gitignored) |

### 1.3 plan_hash / diff_hash computation

`plan_hash` is the SHA-256 of the canonical-JSON serialization of the UltraPlan object (`src/ralph/ultraplan-runner.js`, `src/ralph/ultraplan-schema.js`). Canonical means:

- Recursively sort object keys alphabetically.
- Drop `undefined` values.
- Numbers normalized via `JSON.stringify` (no `NaN`/`Infinity` in plans by schema constraint).
- Newlines and whitespace in string fields are not normalized — the bounded prompt enforces consistent shape upstream.

`pre_exec_diff_hash` is the SHA-256 of `git diff --no-color HEAD` taken in the **worktree sandbox** before `git apply` runs in the real repo. `post_exec_diff_hash` is the SHA-256 of `git diff --no-color HEAD` taken in the **real repo** after the patch has been applied. Equality of `pre_exec` and `post_exec` is the integrity check that nothing else mutated between approval and execution.

### 1.4 /modify must REPLAN

`/modify <approval_id> <instruction>` does NOT mutate the existing approval. It is implemented as:

1. Load `approval_id`, mark it `superseded` with audit entry `{event: 'superseded_by_modify', by: <user>}`.
2. Create a new `STORY-...` plan request whose `requirement` text is the original requirement plus a delta paragraph carrying the operator's instruction (truncated to 4000 chars).
3. Run the UltraPlan runner again. A fresh `plan_hash` is computed.
4. Issue a new `APR-...` for the new plan_hash. The new approval re-enters `PLAN_APPROVAL_PENDING`.

Wired in `src/ralph/approval-manager.js` and surfaced via `src/telegram/approval-adapter.js`. The two-step (supersede → replan) prevents an operator from inadvertently executing a partly-modified plan.

## 2. Mode transition state machine

### 2.1 Modes

| Mode | Default | Semantics |
|---|---|---|
| `approval` | yes | Every Risk ≥ 2 story halts at `PLAN_APPROVAL_PENDING` or `DIFF_APPROVAL_PENDING` until human approval. |
| `fullauto` | opt-in only | Plan and diff approvals can be auto-recorded; Risk ≥ 4 still halts; Risk 5 always stops. |

### 2.2 Transition rules

```
approval  -> approval  : noop (any user)
approval  -> fullauto  : admin-only AND requires /confirm <token> AND expires_at <= 24h from now
fullauto  -> approval  : any reviewer (instant)
fullauto  -> fullauto  : admin-only AND /confirm <token> (renewal extends expires_at)
```

Implementation: `src/ralph/mode-manager.js` (`MODES`, `DEFAULT_FULLAUTO_HOURS = 6`, `MAX_FULLAUTO_HOURS = 24`). Pending mode-change tokens are persisted at `.ralph/approval-pending/<token>.mode-change.json` and consumed atomically by `/confirm`.

### 2.3 Time bound

`fullauto` mode carries `effective_until` (absolute ISO timestamp) and `auto_revert_to: 'approval'`. The autonomous scheduler checks `effective_until` on every tick and reverts to `approval` if expired. No "permanent fullauto" is reachable from any code path.

## 3. Telegram command parser and adapter

### 3.1 Surface

| Command | Connected to execution? | Source |
|---|---|---|
| `/ping` | dry-run only | `src/telegram/handlers.js` |
| `/status` | read-only | `src/telegram/handlers.js` |
| `/mode approval` | yes (instant) | `src/telegram/handlers.js` |
| `/mode fullauto [h]` | yes (needs /confirm) | `src/telegram/handlers.js` |
| `/confirm <token>` | yes | `src/telegram/handlers.js` |
| `/approve <approval_id>` | yes | `src/telegram/approval-adapter.js` |
| `/deny <approval_id>` | yes | `src/telegram/approval-adapter.js` |
| `/modify <approval_id> <instr>` | yes (REPLAN) | `src/telegram/approval-adapter.js` |
| `/ralph-start <req>` | yes | `src/telegram/autonomous-command.js` |
| `/ralph-tick <story>` | yes | `src/telegram/autonomous-command.js` |
| `/ralph-run-until-blocked <story>` | yes | `src/telegram/autonomous-command.js` |
| `/ralph-loop-status [story]` | read-only | `src/telegram/autonomous-command.js` |
| `/ralph-plan <story.json>` | read-only | `src/telegram/handlers.js` |
| `/ralph-gate-manifest` | read-only | `src/telegram/handlers.js` |

### 3.2 Authentication

A command is dispatched only if BOTH:

- The Telegram user_id is in `TELEGRAM_ALLOWED_USER_IDS`.
- The chat_id is in `TELEGRAM_ALLOWED_CHAT_IDS`.

`isAdmin(user_id)` checks `.ralph/roles.json` `admin_user_ids` / `owner_user_ids`; `isReviewerOrHigher` adds `reviewer_user_ids`. The roles file is gitignored.

## 4. Risk evaluator

### 4.1 Levels

| Score | Label | Examples | Default action |
|---:|---|---|---|
| 0 | RISK_0_LOW | docs only, tests only | auto_execute |
| 1 | RISK_1_LOW | refactor with full test coverage, deps bump | auto_execute in fullauto, plan approval in approval mode |
| 2 | RISK_2_MEDIUM | new module under `src/` | plan approval (any mode) |
| 3a | RISK_3A_DB_MIGRATION | `supabase/migrations/**` (local/staging) | plan approval |
| 3b | RISK_3B_AUTH | files mentioning auth/jwt/session | plan approval |
| 3c | RISK_3C_RLS | RLS policy / row-level-security | plan approval |
| 3d | RISK_3D_EXTERNAL_API | webhook / oauth / third-party | plan approval |
| 4 | RISK_4_HIGH | production target_env at risk ≥ 3 | plan approval always |
| 5 | RISK_5_STOP | destructive prod ops, secret leak, RLS disable, force push | **STOP** — not approval, not skip |

### 4.2 Output

`decideControlAction(risk, mode, target_env, approval_type) → ControlDecision` returns:

```js
{
  action,         // 'auto_execute' | 'require_plan_approval' | 'require_diff_approval' | 'stop' | 'escalate'
  reason,         // CONTROL_REASONS enum
  approval_type,  // null for auto_execute/stop, otherwise APPROVAL_TYPES.<...>
  mode,
  target_env,
  risk_score,
  risk_category,
  requires_human, // action !== AUTO_EXECUTE
  executable      // action === AUTO_EXECUTE
}
```

Order of checks (in `src/ralph/risk-evaluator.js`):

1. `risk.score >= 5` → `STOP`. Always wins.
2. `resume_after_security_stop` → `REQUIRE_PLAN_APPROVAL` (special approval type).
3. `mode_change` request → `REQUIRE_PLAN_APPROVAL` (approval_type = MODE_CHANGE).
4. `approval_type === DIFF` or `requires_diff_approval` or `post_exec_diff_hash_changed` → `REQUIRE_DIFF_APPROVAL`.
5. `target_env === 'production' && risk.score >= 3` → `REQUIRE_PLAN_APPROVAL`.
6. `mode === 'approval' && risk.score >= 2` → `REQUIRE_PLAN_APPROVAL`.
7. `mode === 'fullauto' && risk.score >= 4` → `REQUIRE_PLAN_APPROVAL`.
8. Otherwise → `AUTO_EXECUTE`.

The decision object replaces v1.0's boolean `requires_approval()` so a Risk 5 stop is never mistaken for "no approval needed". Tested in `tests/ralph/risk-evaluator.spec.js` and `tests/ralph/state-machine-control-decision.spec.js`.

## 5. Ralph state machine

### 5.1 Phases

```
IDLE
PLANNING
RISK_ASSESSMENT
PLAN_APPROVAL_PENDING
OPENCODE_RUNNING        (formerly EXECUTING in v1.0)
PATCH_PREVIEW
DIFF_APPROVAL_PENDING   (formerly WAITING_FOR_DIFF_APPROVAL, removed)
APPLY
GATES                   (formerly GATE_RUNNING)
FIX_LOOP                (formerly DEBUGGING)
COMMIT_APPROVAL_PENDING
COMMIT
PUSH_APPROVAL_PENDING
PUSH
PR_APPROVAL_PENDING
PR
DONE
ESCALATED
STOPPED_SECURITY
PAUSED
BLOCKED
```

`WAITING_FOR_DIFF_APPROVAL` is removed from `PHASES`. A regression test in `tests/ralph/state-machine-control-decision.spec.js` asserts `PHASES.WAITING_FOR_DIFF_APPROVAL` is `undefined`, so a future refactor cannot silently re-introduce the duplicate.

### 5.2 Transitions

The autonomous-loop wired tick (`src/ralph/autonomous-loop-wired.js`) drives transitions in this order per story per tick:

```
PLAN -> RISK_ASSESSMENT -> {STOP | PLAN_APPROVAL_PENDING | OPENCODE_RUNNING}
OPENCODE_RUNNING -> {PATCH_PREVIEW | fallback | retry_with_attempts++ | ESCALATED}
PATCH_PREVIEW -> {DIFF_APPROVAL_PENDING | ESCALATED}
DIFF_APPROVAL_PENDING -> {APPLY | denied -> ESCALATED | expired -> ESCALATED}
APPLY -> {GATES | ESCALATED}
GATES -> {COMMIT_APPROVAL_PENDING | FIX_LOOP | ESCALATED}
FIX_LOOP -> OPENCODE_RUNNING (with bounded repair context, attempts++)
COMMIT_APPROVAL_PENDING -> COMMIT
COMMIT -> PUSH_APPROVAL_PENDING
PUSH_APPROVAL_PENDING -> PUSH
PUSH -> PR_APPROVAL_PENDING
PR_APPROVAL_PENDING -> PR
PR -> DONE
```

Stuck-loop guard (added PR #45): if `from_phase === OPENCODE_RUNNING && to_phase === OPENCODE_RUNNING` for a runtime infra reason, `attempts` is incremented and at `attempts >= max_attempts` the story is auto-promoted to `ESCALATED`. Wired in `escalateStuckOpenCodeRunning` in `src/ralph/autonomous-loop-wired.js`, with end-to-end test `tickAutonomousLoopWired escalates ineligible-fallback OPENCODE_RUNNING stuck story after max_attempts`.

## 6. Hashing

Canonical JSON spec is implemented in `src/ralph/hash.js`:

- Recursively sort all object keys.
- Drop properties whose value is `undefined`.
- Numbers serialize via `JSON.stringify`; the UltraPlan schema rejects `NaN` / `±Infinity` at validation time.
- Strings are passed through verbatim; trailing newline removal is not performed (bounded prompts enforce shape).

`hash(value)` returns `sha256:<hex>`. Tested in `tests/ralph/hash.spec.js` for stability across semantically identical inputs (key reorderings, array ordering when arrays are documented as unordered, etc.) and in `tests/ralph/ultraplan-provider.spec.js` for plan-shape stability across Gemini and deterministic providers.

## 7. LangGraph planning layer

`src/ralph/langgraph-planning-layer.js` exposes a non-executing planning graph with the four nodes `plan / risk / decision / route`. It is read-only — there is no edge from any node to apply / commit / push / PR / deploy / migration. Run via `node src/ralph/cli.js plan <story.json>` or Telegram `/ralph-plan`. The output is the same canonical UltraPlan object hashed by §6.

The graph is intentionally a thin shell over the deterministic UltraPlan + optional Gemini provider; full LangGraph dynamic orchestration is out of scope for v0.2.

## 8. NemoClaw runtime — current status

### 8.1 Design intent

NemoClaw is the policy-enforcing mediator between Ralph and OpenCode. Ralph dispatches `openshell sandbox exec ... openclaw agent --message <bounded prompt> --json` and the NemoClaw policy (`src/ralph/nemoclaw-policy.js`) blocks any escalation beyond `candidate.patch` output.

### 8.2 Actual installed state on the development host

```
nemoclaw  ~/.local/bin/nemoclaw   v0.0.38   INSTALLED
openshell ~/.local/bin/openshell  v0.0.36   INSTALLED
openclaw  not in PATH                       MISSING
```

Because `openclaw` is missing, the NemoClaw mediated path returns `nemoclaw_runtime_timeout` on the first sandbox exec. The deterministic fallback set in `src/ralph/autonomous-loop-wired.js` (PR #45) covers this reason, so a story routed through NemoClaw degrades gracefully rather than blocking the loop forever.

### 8.3 Effective execution path (post Phase 1 #5)

Per [ADR 2026-05-14](./adr-2026-05-14-retire-nemoclaw-mediator-default.md), **the autonomous-loop default is OpenCode + Kimi K2.6 direct** (`src/ralph/opencode-kimi-dispatcher.js`). NemoClaw is now opt-in via `RALPH_DISPATCHER=nemoclaw`; `nemoclaw-policy.js` is retained as the authoritative policy spec. See §9.1 for the updated selection order.

## 9. Execution dispatcher — OpenCode + Kimi K2.6 direct (PR #45, refined in PR #46)

### 9.1 Selection

`buildDefaultOpenCodeDispatcher` (in `src/ralph/autonomous-loop.js`) selects the dispatch path in this order **(updated 2026-05-14 per ADR Phase 1 #5)**:

1. Sandbox preflight failure → return the preflight diagnostic.
2. `RALPH_DISPATCHER === 'nemoclaw'` (or `RALPH_EXECUTION_DISPATCHER === 'nemoclaw'`) → legacy NemoClaw mediator (`runNemoClawOpenCodeCandidatePatch`). Operators opt in here only when `openclaw` is installed and verified.
3. `RALPH_OPENCODE_DIRECT_DEV_ONLY === 'true'` → direct OpenCode (dev-only).
4. **Default** → `dispatchOpenCodeKimi` (OpenCode + Kimi K2.6 via OpenRouter).

`RALPH_DISPATCHER=opencode-kimi` is still accepted as an explicit opt-in for symmetry but is now redundant with the default.

### 9.2 Provider configuration

```
Default model:  openrouter/moonshotai/kimi-k2.6  (256K context)
Override env:   RALPH_OPENCODE_KIMI_MODEL or OPENCODE_MODEL
                — values are sanitized; any value containing whitespace or shell metachars
                  collapses back to the default.
API key env:    OPENROUTER_API_KEY (primary), KIMI_API_KEY (fallback)
                — exactly one is exported as OPENROUTER_API_KEY into the spawned subprocess.
Telemetry env:  OPENCODE_DISABLE_TELEMETRY=1 enforced.
```

Everything else in `process.env` is scrubbed before spawning OpenCode. The subprocess only sees `PATH`, `HOME`, `TMPDIR`, `CI`, `OPENROUTER_API_KEY`, `OPENCODE_DISABLE_TELEMETRY`. Production secrets (Supabase service role, GitHub token, etc.) never reach the agent.

### 9.3 Worktree contract (post-PR #46)

The agent runs inside a per-story `git worktree` rooted at `.ralph/sandboxes/<story_id>/worktree` (created from current `HEAD`, detached). The prompt explicitly tells the agent:

- Modify or create files at the paths listed under "Requested paths" using normal write tools.
- Do **not** write a file literally named `candidate.patch` or `candidate.diff` (legacy NemoClaw output-contract leftover — would itself appear in the diff and be rejected).
- Do **not** print the diff to stdout — Ralph captures it via `git diff`.
- Forbidden commands: git/gh/npm publish/deploy/migration/push/merge/release.
- Forbidden writes: anything outside `requested_paths`, `.git/**`, `.ralph/**`.

After the agent exits, Ralph runs `git add --intent-to-add --all && git diff --no-color HEAD -- ':(exclude)candidate.patch' ':(exclude)candidate.diff' ':(exclude).opencode' ':(exclude).opencode/**'`. The result is then validated against `requested_paths` by `validateCandidatePatchAgainstRepository` (in `src/ralph/nemoclaw-opencode-gateway.js`, reused as a pure function).

### 9.4 Failure classification (post-PR #46)

`classifyFailure` checks in this order:

1. Missing API key → `opencode_kimi_api_key_missing`.
2. Hard timeout → `opencode_kimi_runtime_timeout`.
3. Patch produced but failed validation → the validation reason. **This wins over** any transient-rate-limit-shaped substring elsewhere in the bounded output, so a contract violation cannot hide behind a misleading `provider_rate_limited`.
4. Rate-limit pattern in output → `provider_rate_limited`.
5. No valid patch → `candidate_patch_missing`.
6. Non-zero exit → `opencode_kimi_runtime_failed`.
7. All clear → `null`.

### 9.5 Soft-timeout downgrade (PR #46)

If the OpenCode subprocess returns `ETIMEDOUT` **and** the worktree diff produced a fully valid candidate patch, the dispatcher reports `ok: true` and lets the story progress to `PATCH_PREVIEW`. Rationale: the timeout in this case is session-shutdown overhead, not failed work; without the downgrade Ralph would burn provider tokens recomputing a result it already has. The hard timeout path (no patch, or patch invalid) is preserved verbatim, so a genuinely stuck agent still escalates through `attempts → ESCALATED`.

### 9.6 Benchmarked capability

Real Kimi K2.6 run over three representative tasks (all `infra/phase0-autonomous-foundation` HEAD at the time of PR #46):

| Difficulty | Requested paths | Result | Generated tests pass when applied |
|---|---|---|---|
| Easy 2-file new | `src/ralph/clamp.js`, `tests/ralph/clamp.spec.js` | ok | 6/6 |
| Medium edit + augment existing tests | `src/ralph/dashboard.js`, `tests/ralph/dashboard.spec.js` | ok | 7/7 (incl. new test) |
| Medium-hard additive logic + new spec | `src/ralph/story-priority.js`, `tests/ralph/story-priority.spec.js` | ok | 2/2 |

Generated patches were applied to the real repo with `git apply` and tests were run with `npx playwright test`. All three were applied and reverted without leaving artifacts.

## 10. Per-story worktree isolation

`src/ralph/story-worktree.js` provides:

```
createStoryWorktree({ rootDir, sandbox_root, base_ref?: 'HEAD' })
  -> { ok, worktree_path, base_sha, ... } | { ok:false, reason }
destroyStoryWorktree({ rootDir, sandbox_root })
  -> { ok, ... } | { ok:false, reason }
diffStoryWorktree({ rootDir, sandbox_root, base_sha? })
  -> { ok, patch_text, base_sha, ... } | { ok:false, reason }
```

Constraints:

- `sandbox_root` must start with `.ralph/sandboxes/` or `.ralph/tmp/` (allow-list).
- `base_ref` defaults to `HEAD`; only `HEAD` or a 4-64 hex SHA is accepted.
- The worktree directory is recreated if a stale one exists.
- `git diff` excludes `candidate.patch`, `candidate.diff`, `.opencode`, `.opencode/**`.
- `destroyStoryWorktree` unconditionally tears down both git metadata and the on-disk directory; absent worktrees return `ok` quietly.

Working tree of the real repository is never modified — the only artifact left after a successful dispatch is `.ralph/tmp/opencode-sandbox/<approval_id>/candidate.patch` (or `.ralph/sandboxes/<story_id>/candidate.patch`).

## 11. Stuck-loop recovery (PR #45)

### 11.1 Eligible-fallback failures

`FALLBACK_FAILURE_REASONS` in `src/ralph/autonomous-loop-wired.js` and `ELIGIBLE_FAILURE_REASONS` in `src/ralph/deterministic-candidate-patch-fallback.js` are kept in sync. The set is:

```
provider_rate_limited
candidate_patch_missing
agent_output_contract_violation
nemoclaw_runtime_timeout
nemoclaw_runtime_not_installed
openshell_runtime_not_installed
gateway_runtime_timeout
```

For any of these, when `from_phase === to_phase === OPENCODE_RUNNING`, the deterministic-patch fallback is consulted. If `riskIsLow && requested_paths.length === 1 && path matches the docs / tests / .github / .md|.txt|.json|.yml|.yaml allow-list && file does not exist`, the fallback writes a bounded candidate.patch and the story advances to `PATCH_PREVIEW`.

### 11.2 Ineligible-fallback escalation

If the fallback is ineligible (e.g. multi-file requested, or `src/` modifications), the wired tick consults `escalateStuckOpenCodeRunning`:

```
attempts++
if attempts < max_attempts: stay in OPENCODE_RUNNING, return non-ok
else: transition to ESCALATED with bounded failure_summary, status=FAILED
```

Default `max_attempts` is 3. Stories that fail three times in a row without progress no longer pile up runnable in the scheduler — they are off the runnable queue and visible in the dashboard's `failed/escalated` group with a redacted reason.

## 12. GitHub Issue supplier (PR #45)

`src/ralph/github-issue-supplier.js` exposes `tickIssueSupplier`. The autonomous daemon (`scripts/ralph/autonomous-daemon.js`) calls it once per cycle:

- Cadence: `RALPH_ISSUE_PULL_EVERY_CYCLES` (or `--issue-pull-every-cycles`), clamped to `[0, 1440]`. **Default 0 = off**; the daemon never touches GitHub unless an operator opts in.
- Repo: `RALPH_GITHUB_REPO` or `GITHUB_REPOSITORY` (`owner/name` validated by regex).
- Token: `GITHUB_TOKEN` or `GH_TOKEN`. The token is used only in the GitHub REST `Authorization` header; it is never persisted, redacted, or logged.
- Labels: `RALPH_GITHUB_READY_LABELS` (CSV), default `ralph-ready,autonomous`. An issue matches if it has at least one of these labels.
- Idempotency: existing `STORY-GH-<number>` records are skipped (`src/ralph/github-issue-queue.js`).
- Bounded summary: `imported_count`, `imported_story_ids` (≤25), `skipped_count`, `skipped_preview` (≤10), `next_action`. Raw issue bodies, tokens, emails, and secret-shaped values are redacted via `redactText` before they ever appear in the supplier summary.

Errors during pull are captured and reported on `daemonStatus.issue_supplier` without crashing the daemon.

## 13. Secrets injection

| Concern | File |
|---|---|
| Reference-only injection | `src/ralph/runtime-env-preflight.js` |
| Production secret block | `src/ralph/secrets-policy.js` |
| Redaction in logs and dashboards | `src/ralph/audit-log.js`, `src/ralph/dashboard.js`, `src/ralph/github-issue-provider.js` |

Rules:

- No agent ever sees raw `SUPABASE_SERVICE_ROLE`, `GITHUB_TOKEN`, `*_API_KEY` other than the routed one for its provider role.
- The Kimi dispatcher scrubs env down to PATH/HOME/TMPDIR/CI/`OPENROUTER_API_KEY`/`OPENCODE_DISABLE_TELEMETRY` before spawning.
- The deterministic-fallback path never reads any provider key.
- All Telegram, audit, dashboard, PR-body, and Issue-supplier outputs run through `redactText`-style filters that strip GitHub PAT shapes, emails, and `(password|passwd|secret|token|api[_-]?key)=…` patterns.

## 14. Failure escalation

`src/ralph/failure-escalation.js` defines the Risk 5 stop semantics:

When a story hits a Risk 5 reason (production destructive op, secret-leak attempt, RLS disable, force push, etc.):

1. The story stops (status `failed`, current_phase `STOPPED_SECURITY`).
2. The active agent process is killed (subprocess `.kill()` in the dispatcher).
3. Secrets injection for that story is disabled — no further dispatch can route any key on its behalf.
4. The current git diff snapshot and audit log are preserved verbatim in `.ralph/snapshots/<story_id>/`.
5. Telegram + dashboard notifications fire.
6. Resume requires a fresh `RESUME_AFTER_SECURITY_STOP` approval (separate `APPROVAL_TYPES` value), which itself requires plan approval — auto-resume is impossible.

`src/ralph/repair-strategy.js` cross-classifies failures (test / typecheck / build / secret / migration / e2e / timeout / unknown). Some failure types (`secret scan`, `security policy`, `production DB`, `RLS disable`, `migration`) are routed to immediate Risk 5 escalation even outside the autonomous loop's stuck-recovery path.

## 15. Explicit prohibitions (all modes)

The following are forbidden across `approval` and `fullauto` modes:

- Production database destructive writes.
- Display, storage, or logging of secret values.
- Disabling RLS or auth on any environment.
- Deletion of tests for the purpose of making a failing gate look green.
- Modification of `acceptance_criteria` without operator instruction.
- Direct push to a protected main branch.
- Force push to any branch.
- `git reset --hard` initiated by an agent.
- Production deploy without explicit `APPROVAL_TYPES.DEPLOY` approval.
- Execution of code whose `post_exec_diff_hash` differs from the approved `pre_exec_diff_hash`.

## 16. Acceptance test mapping

| v1.3 requirement | Implementation | Test |
|---|---|---|
| State machine explicit phases | `src/ralph/state-machine.js` | `tests/ralph/state-machine-control-decision.spec.js` |
| `PLAN_APPROVAL_PENDING` exists | `src/ralph/types.js` | same |
| `DIFF_APPROVAL_PENDING` exists, `WAITING_FOR_DIFF_APPROVAL` removed | `src/ralph/types.js`, regression assertion | same |
| `STOPPED_SECURITY`, `ESCALATED` | `src/ralph/types.js`, `src/ralph/failure-escalation.js` | `tests/ralph/failure-escalation.spec.js` |
| ControlDecision (no boolean) | `src/ralph/risk-evaluator.js` | `tests/ralph/risk-evaluator.spec.js` |
| Risk 3a/3b/3c/3d split | `src/ralph/risk-evaluator.js` | same |
| Risk 5 = stop | `src/ralph/risk-evaluator.js` | same |
| Approval object + `/modify` REPLAN | `src/ralph/approval-manager.js`, `src/telegram/approval-adapter.js` | `tests/telegram/approval-adapter.spec.js` |
| `/mode fullauto` admin+confirm+expiry | `src/ralph/mode-manager.js` | `tests/ralph/mode-manager.spec.js` |
| canonical-JSON `plan_hash` | `src/ralph/hash.js`, `src/ralph/ultraplan-provider.js` | `tests/ralph/hash.spec.js`, `tests/ralph/ultraplan-provider.spec.js` |
| Production DB destructive stop | `src/ralph/production-change-policy.js` | `tests/ralph/production-change-policy.spec.js` |
| Production migration human approval | `src/ralph/production-change-policy.js` | same |
| RLS/auth approval | `src/ralph/production-change-policy.js` | same |
| Failure classification + retry caps | `src/ralph/repair-strategy.js` | `tests/ralph/repair-strategy.spec.js` |
| Bounded/redacted repair context | `src/ralph/repair-strategy.js` | same |
| Dashboard JSON+Markdown, redacted | `src/ralph/dashboard.js` | `tests/ralph/dashboard.spec.js` |
| PR body deterministic + redacted | `src/ralph/pr-body-generator.js` | `tests/ralph/pr-body-generator.spec.js` |
| Gate runner ordered manifest | `src/ralph/gate-runner.js`, `scripts/gates/run-all.sh` | `tests/ralph/gate-runner*.spec.js` |
| Pre/post secret scan | `scripts/gates/run-all.sh` | gate-runner tests |
| Secrets never logged | `src/ralph/secrets-policy.js`, `src/ralph/runtime-env-preflight.js` | `tests/ralph/secrets-policy.spec.js`, `tests/ralph/runtime-env-preflight.spec.js` |
| Gemini planning + deterministic fallback | `src/ralph/ultraplan-provider.js` | `tests/ralph/ultraplan-provider.spec.js` |
| Kimi execution role (current: direct via OpenRouter) | `src/ralph/opencode-kimi-dispatcher.js` | `tests/ralph/opencode-kimi-dispatcher.spec.js` |
| Worktree isolation | `src/ralph/story-worktree.js` | `tests/ralph/story-worktree.spec.js` |
| Stuck OPENCODE_RUNNING → ESCALATED | `src/ralph/autonomous-loop-wired.js` | `tests/ralph/autonomous-loop-wired.spec.js` |
| Deterministic fallback covers runtime infra failures | `src/ralph/deterministic-candidate-patch-fallback.js` | `tests/ralph/deterministic-candidate-patch-fallback.spec.js` |
| Issue supplier idempotent, default off | `src/ralph/github-issue-supplier.js` | `tests/ralph/github-issue-supplier.spec.js` |

Full ralph test suite at v0.2 baseline: **277 passed**.

## 17. Known limits, not yet implemented at v0.2

- `openclaw` runtime is missing on the development host; the NemoClaw mediated path is opt-in via `RALPH_DISPATCHER=nemoclaw` and is currently inert end-to-end. Per ADR 2026-05-14 (Phase 1 #5), the autonomous-loop default is now OpenCode + Kimi K2.6 direct; NemoClaw remains retained as the authoritative policy spec.
- No 24h overnight soak has been demonstrated. The dispatcher is verified at the 1-cycle, 3-story, and 9-test scale; long-duration cost-and-stability data is still pending.
- LangGraph planning layer is a non-executing skeleton; dynamic re-planning during a story (vs. plan-once-then-execute) is deferred.
- Telegram `/approve` is connected to execution; `/approve` of a `RESUME_AFTER_SECURITY_STOP` approval still requires manual operator review because that approval type intentionally has no automatic resume hook.
- `production` `target_env` is reachable in the risk evaluator, but no production secrets are wired and no production code path is reachable from any autonomous tick.

## 18. Versioning

- v1.0: original notebook design, boolean approval, NemoClaw-only execution.
- v1.3: requirements confirmed (Risk 3 split, ControlDecision, Plan vs Diff Approval, Risk 5 = stop, `/modify` ⇒ REPLAN, mode change admin+confirm+expiry, explicit prohibitions).
- v0.2 (this document): implementation companion, reflects PR #45 + PR #46. Adds OpenCode + Kimi K2.6 direct dispatcher, per-story worktree, stuck-loop escalation, issue supplier, dispatcher contract fixes.

The next version (v0.3 or v1.4 depending on requirements-vs-design framing) should add: 24h soak telemetry, openclaw runtime install path, dynamic re-planning, and Telegram `RESUME_AFTER_SECURITY_STOP` workflow.
