# Ralph v1.3 / Detailed Design v0.2 Implementation Coverage

This document tracks implementation coverage against the confirmed v1.3 requirements, v0.2 detailed design direction, and later autonomous OpenCode development loop work.

## Status Legend

```text
DONE      implemented with tests and local gates green
PARTIAL   implemented as a skeleton or bounded subset
TODO      not implemented yet
BLOCKED   intentionally not implemented without separate approval
DEV-ONLY  intentionally available only behind explicit development opt-in
```

## Core Requirements Coverage

| Area | Requirement | Status | Evidence |
|---|---|---:|---|
| Ralph Core | State machine with explicit phases | DONE | `src/ralph/state-machine.js`, `tests/ralph/state-machine-control-decision.spec.js` |
| Ralph Core | `PLAN_APPROVAL_PENDING` | DONE | `src/ralph/state-machine.js` |
| Ralph Core | `DIFF_APPROVAL_PENDING` | DONE | `src/ralph/state-machine.js` |
| Ralph Core | Remove/avoid `WAITING_FOR_DIFF_APPROVAL` | DONE | `tests/ralph/state-machine-control-decision.spec.js` |
| Ralph Core | `STOPPED_SECURITY` for security stops | DONE | `src/ralph/state-machine.js`, `src/ralph/failure-escalation.js` |
| Ralph Core | `ESCALATED` for human escalation | DONE | `src/ralph/types.js`, `src/ralph/state-machine.js` |
| Risk Evaluator | Replace boolean approval decision with `ControlDecision` | DONE | `src/ralph/risk-evaluator.js`, `tests/ralph/risk-evaluator.spec.js` |
| Risk Evaluator | Risk 5 is stop, not “approval not required” | DONE | `tests/ralph/risk-evaluator.spec.js` |
| Risk Evaluator | Risk 3a local/staging migration | DONE | `src/ralph/risk-evaluator.js` |
| Risk Evaluator | Risk 3b auth logic | DONE | `src/ralph/risk-evaluator.js` |
| Risk Evaluator | Risk 3c RLS policy | DONE | `src/ralph/risk-evaluator.js` |
| Risk Evaluator | Risk 3d external API | DONE | `src/ralph/risk-evaluator.js` |
| Approval | Approval object and approval logs | DONE | `src/ralph/approval-manager.js`, existing approval tests |
| Approval | `/modify` supersedes and requires replan | DONE | `src/ralph/approval-manager.js`, `src/telegram/approval-adapter.js`, Telegram approval adapter tests |
| Approval | approval wait/resume for autonomous stories | DONE | `src/telegram/approval-adapter.js`, `tests/telegram/approval-adapter.spec.js` |
| Mode | `/mode approval` immediate | DONE | `src/ralph/mode-manager.js` |
| Mode | `/mode fullauto` admin/confirm/expiry | DONE | `src/ralph/mode-manager.js`, Telegram handler coverage |
| Hashing | canonical JSON plan hash | DONE | `src/ralph/langgraph-planning-layer.js`, `src/ralph/ultraplan-runner.js`, existing approval manager hash coverage |
| Hashing | diff approval separation | DONE | `src/ralph/state-machine.js`, `src/ralph/production-change-policy.js`, OpenCode patch approval flow, autonomous `DIFF_APPROVAL_PENDING` |
| Dashboard | Read-only dashboard JSON and Markdown | DONE | `src/ralph/dashboard.js`, `scripts/ralph/dashboard.js`, `tests/ralph/dashboard.spec.js` |
| Dashboard | Group active, queued, waiting approval, failed, stopped, completed stories | DONE | `src/ralph/dashboard.js`, `tests/ralph/dashboard.spec.js` |
| Dashboard | Include approvals, jobs, gates, hashes, next actions, bounded audit | DONE | `src/ralph/dashboard.js`, `tests/ralph/dashboard.spec.js` |
| Dashboard | Redact secrets/raw logs and bound output | DONE | `src/ralph/dashboard.js`, `tests/ralph/dashboard.spec.js` |
| PR Body | Deterministic PR body generation from story/plan/gates/approvals | DONE | `src/ralph/pr-body-generator.js`, `tests/ralph/pr-body-generator.spec.js` |
| PR Body | GitHub issue, changed files, hashes, approval trail, safety checklist | DONE | `src/ralph/pr-body-generator.js`, `tests/ralph/pr-body-generator.spec.js` |
| PR Body | PR creation fallback body when approval body is empty | DONE | `src/telegram/opencode-pr.js`, `tests/telegram/opencode-pr.spec.js` |
| PR Body | Bounded/redacted body with no raw logs or secrets | DONE | `src/ralph/pr-body-generator.js`, `tests/ralph/pr-body-generator.spec.js`, `tests/telegram/opencode-pr.spec.js` |
| Gate Runner | ordered gate manifest | DONE | `src/ralph/gate-runner.js` |
| Gate Runner | Ralph CLI command | DONE | `node src/ralph/cli.js gate-runner`, `tests/ralph/cli-gate-runner.spec.js` |
| Gate Runner | Telegram read-only manifest command | DONE | `/ralph-gate-manifest`, `tests/telegram/handlers.spec.js` |
| Gate Runner | autonomous gate/fix/retry loop | DONE | `src/ralph/autonomous-loop.js`, `tests/ralph/autonomous-loop-gates.spec.js` |
| Gate Runner | pre/post secret scans required | DONE | `src/ralph/gate-runner.js`, `scripts/gates/run-all.sh` |
| Gate Runner | lint/typecheck/unit/build/type generation/dependency audit slots | DONE | optional gates in `src/ralph/gate-runner.js` |
| Gate Runner | Supabase local reset / migration dry-run gate | DONE | `scripts/gates/supabase-local.sh`, `src/ralph/gate-runner.js` |
| Gate Runner | Playwright smoke/regression slots | DONE | `src/ralph/gate-runner.js`, `scripts/gates/playwright-e2e.sh` |
| Secrets | Secret values never displayed/persisted/logged | DONE | `src/ralph/secrets-policy.js`, `tests/ralph/secrets-policy.spec.js` |
| Secrets | Reference-only runtime injection | DONE | `src/ralph/runtime-env-preflight.js`, `tests/ralph/runtime-env-preflight.spec.js` |
| Secrets | Production secret injection blocked | DONE | `src/ralph/secrets-policy.js`, `src/ralph/runtime-env-preflight.js` |
| Secrets | Telegram config runtime env preflight | DONE | `src/telegram/config.js` |
| Production DB | production destructive DB change security stop | DONE | `src/ralph/production-change-policy.js` |
| Production DB | production migration human approval | DONE | `src/ralph/production-change-policy.js` |
| Production DB | execution preflight production policy wiring | DONE | `src/ralph/execution-preflight.js`, `tests/ralph/execution-preflight.spec.js` |
| RLS/Auth | RLS/auth changes require approval | DONE | `src/ralph/production-change-policy.js` |
| Failure | Risk 5 stop criteria | DONE | `src/ralph/failure-escalation.js` |
| Failure | Stop story/agent/secret injection, preserve logs/diff, notify, human resume | DONE | `src/ralph/failure-escalation.js` |
| LangGraph | Planning layer skeleton | DONE | `src/ralph/langgraph-planning-layer.js` |
| LangGraph | Ralph CLI command | DONE | `node src/ralph/cli.js plan <story.json>`, `tests/ralph/cli-plan.spec.js` |
| LangGraph | Telegram read-only planning graph command | DONE | `/ralph-plan`, `tests/telegram/handlers.spec.js` |
| LangGraph | non-executing graph with plan/risk/decision/route | DONE | `src/ralph/langgraph-planning-layer.js` |
| Provider Roles | Gemini planning provider config | DONE | `src/ralph/provider-config.js`, `tests/ralph/provider-config.spec.js` |
| Provider Roles | Kimi execution provider config through NemoClaw | DONE | `src/ralph/provider-config.js`, `src/ralph/autonomous-loop.js`, `tests/ralph/provider-config.spec.js`, `tests/ralph/autonomous-loop.spec.js` |
| Provider Roles | provider secrets redacted and never logged raw | DONE | `src/ralph/provider-config.js`, `tests/ralph/provider-config.spec.js`, `tests/ralph/autonomous-loop.spec.js` |
| Provider Roles | legacy `llm` maps to Gemini planning role | DONE | `src/ralph/provider-config.js`, `src/ralph/ultraplan-provider.js`, `tests/ralph/provider-config.spec.js`, `tests/ralph/ultraplan-provider.spec.js` |
| Provider Roles | Kimi execution cannot override Ralph/NemoClaw policies | DONE | `src/ralph/provider-config.js`, `tests/ralph/provider-config.spec.js` |
| UltraPlan | deterministic UltraPlan-style plan object | DONE | `src/ralph/ultraplan-runner.js`, `tests/ralph/ultraplan-runner.spec.js` |
| UltraPlan | optional Gemini planning provider with deterministic fallback | DONE | `src/ralph/ultraplan-provider.js`, `tests/ralph/ultraplan-provider.spec.js` |
| UltraPlan | Gemini plan schema validation / canonicalization / hash | DONE | `src/ralph/ultraplan-schema.js`, `src/ralph/ultraplan-provider.js`, `tests/ralph/ultraplan-provider.spec.js` |
| UltraPlan | malformed/missing-env/provider-failure fallback | DONE | `src/ralph/ultraplan-provider.js`, `tests/ralph/ultraplan-provider.spec.js` |
| UltraPlan | story queue persistence | DONE | `src/ralph/story-queue.js`, `tests/ralph/story-queue.spec.js` |
| UltraPlan | autonomous single-step loop | DONE | `src/ralph/autonomous-loop.js`, `tests/ralph/autonomous-loop.spec.js` |
| UltraPlan | Telegram `/ralph-start` | DONE | `src/telegram/autonomous-command.js`, `tests/telegram/autonomous-command.spec.js` |
| UltraPlan | Telegram `/ralph-tick` | DONE | `src/telegram/autonomous-command.js`, `tests/telegram/autonomous-command.spec.js` |
| UltraPlan | Telegram `/ralph-run-until-blocked` | DONE | `src/telegram/autonomous-command.js`, `tests/telegram/autonomous-command.spec.js` |
| UltraPlan | Telegram `/ralph-loop-status` | DONE | `src/telegram/autonomous-command.js`, `tests/telegram/autonomous-command.spec.js` |
| UltraPlan | pause/resume/stop/artifact command surface | DONE | `src/telegram/autonomous-command.js`, `tests/telegram/autonomous-command.spec.js` |
| OpenCode | real CLI sandbox smoke | DONE | `scripts/telegram/real-opencode-operational-smoke.js` |
| OpenCode | candidate patch only | DONE | `src/telegram/opencode-run.js` |
| OpenCode | autonomous candidate.patch dispatch from story loop | DONE | `src/ralph/autonomous-loop.js`, `tests/ralph/autonomous-loop.spec.js` |
| OpenCode | patch preview / approval / apply / gates / commit / push / PR chain | DONE | `src/telegram/opencode-*.js` |
| OpenCode | bounded status/abort/artifact retrieval | DONE | `src/telegram/opencode-jobs.js`, `src/telegram/opencode-artifacts.js` |
| NemoClaw Runtime | NemoClaw-mediated OpenCode default dispatch | DONE | `src/ralph/autonomous-loop.js`, `src/ralph/nemoclaw-opencode-gateway.js`, `tests/ralph/nemoclaw-opencode-gateway.spec.js` |
| NemoClaw Runtime | candidate.patch-only NemoClaw policy | DONE | `src/ralph/nemoclaw-policy.js`, `tests/ralph/nemoclaw-opencode-gateway.spec.js` |
| NemoClaw Runtime | apply/commit/push/PR/deploy/migration/merge/shell escalation denied | DONE | `src/ralph/nemoclaw-policy.js`, `tests/ralph/nemoclaw-opencode-gateway.spec.js` |
| NemoClaw Runtime | raw logs and secret display/persistence denied/redacted | DONE | `src/ralph/nemoclaw-policy.js`, `src/ralph/nemoclaw-opencode-gateway.js`, `tests/ralph/nemoclaw-opencode-gateway.spec.js` |
| NemoClaw Runtime | runtime-not-installed behavior | DONE | `src/ralph/nemoclaw-opencode-gateway.js`, `tests/ralph/nemoclaw-opencode-gateway.spec.js` |
| NemoClaw Runtime | runtime smoke reports mediated/direct-dev-only mode | DONE | `scripts/ralph/real-external-agent-smoke.js`, `tests/ralph/external-agent-dev-only-policy.spec.js` |
| External Gateway | Generic external gateway boundary policy | DONE | `src/ralph/external-agent-gateway.js`, `docs/opencode-external-agent-gateway-boundary.md` |
| External Gateway | NemoClaw/OpenClaw runtime approval record | DONE | GitHub issue `#10` operator approval comment |
| External Gateway | NemoClaw candidate.patch-only adapter metadata | DONE | `src/ralph/external-agent-adapter.js`, `tests/ralph/external-agent-adapter.spec.js` |
| External Gateway | OpenClaw/generic non-NemoClaw paths require explicit dev-only opt-in | DEV-ONLY | `src/ralph/external-agent-gateway.js`, `tests/ralph/external-agent-dev-only-policy.spec.js` |
| External Gateway | External agent job status/abort records | DONE | `src/ralph/external-agent-jobs.js`, `tests/ralph/external-agent-jobs.spec.js` |
| External Gateway | External agent bounded artifact retrieval | DONE | `src/ralph/external-agent-artifacts.js`, `tests/ralph/external-agent-artifacts.spec.js` |
| External Gateway | Optional real runtime smoke | DONE | `scripts/ralph/real-external-agent-smoke.js`, `tests/ralph/real-external-agent-smoke.spec.js`, `npm run ralph:real-external-agent-smoke` |
| Deploy | production deploy from Telegram | BLOCKED | explicit non-goal |
| Migration | production migration from Telegram | BLOCKED | explicit non-goal unless separate human approval path is created |
| Merge | merge from Telegram | BLOCKED | explicit non-goal |
| Shell | unrestricted shell | BLOCKED | explicit non-goal |

## Issue #11 Autonomous Loop Coverage

```text
DONE  Phase A: story-queue + deterministic UltraPlan object
DONE  Phase B: autonomous-loop single-step runner
DONE  Phase C: Telegram /ralph-start and /ralph-loop-status
DONE  Phase D: NemoClaw-mediated OpenCode candidate.patch dispatch integration
DONE  Phase E: gate/fix/retry loop
DONE  Phase F: approval wait/resume integration
DONE  Telegram /ralph-tick
DONE  Telegram /ralph-run-until-blocked
```

Current autonomous UX:

```text
/ralph-start <requirements>
→ /ralph-run-until-blocked STORY-*
→ approval boundary
→ /approve APR-*
→ /ralph-run-until-blocked STORY-*
→ NemoClaw-mediated candidate.patch / diff / gates / fix loop / commit-push-PR approval boundary
```

## Issue #14 NemoClaw-Mediated OpenCode Runtime Coverage

```text
DONE  Ralph autonomous loop dispatches OpenCode through NemoClaw gateway by default
DONE  Direct/non-NemoClaw execution path blocked by default or marked dev-only
DONE  NemoClaw gateway enforces candidate.patch-only output
DONE  NemoClaw gateway denies apply/commit/push/PR/deploy/migration/merge/shell escalation
DONE  NemoClaw gateway blocks raw logs and secret display/persistence via bounded redaction
DONE  Runtime smoke reports opencode_runtime_mode and mediator
DONE  Tests cover allowed candidate.patch generation, forbidden commands, secret redaction, policy failure, and runtime-not-installed behavior
DONE  All outputs are bounded/redacted
```

## Issue #15 Gemini/Kimi Role Separation Coverage

```text
DONE  Explicit planning provider abstraction for Gemini
DONE  Explicit execution provider config for Kimi/OpenCode
DONE  Deterministic UltraPlan remains default fallback
DONE  Gemini-generated plan is schema validated, canonicalized, and hashed
DONE  Malformed Gemini output falls back safely without execution
DONE  Missing Gemini env falls back safely without execution
DONE  Kimi execution role cannot override Ralph/NemoClaw policies
DONE  Provider config never logs raw API keys or secret values
DONE  Autonomous loop exposes redacted provider role metadata
DONE  Tests cover provider selection, fallback, malformed output, missing env, and role boundaries
```

## Issue #19 Dashboard / Status Report Coverage

```text
DONE  Generate dashboard JSON and Markdown from stories, approvals, jobs, gates, and audit summaries
DONE  Include active, queued, waiting approval, failed/escalated, stopped, and completed stories
DONE  Include next_action per story
DONE  Include bounded recent audit events
DONE  Include approval IDs, job IDs, plan_hash/diff_hash where available
DONE  Exclude raw logs, secrets, tokens, and unbounded stdout/stderr
DONE  Tests cover output shape, grouping, redaction, missing optional files, and bounded output
```

## Issue #20 PR Body Generation Coverage

```text
DONE  Generate deterministic PR body from story, plan, changed files, gates, and approvals
DONE  Include GitHub issue metadata, plan_hash, diff_hash, changed files, gate summary, approval trail, and safety checklist
DONE  Preserve explicit approval body when provided
DONE  Generate fallback PR body when PR approval body is empty
DONE  Bound and redact generated body; no raw logs or secret values
DONE  Tests cover output shape, redaction, bounded metadata, and Telegram PR flow fallback
```

## Previously Identified Gaps Now Closed

```text
DONE  gate-runner.js into Ralph CLI
DONE  langgraph-planning-layer.js into Ralph CLI
DONE  production-change-policy.js into execution-preflight
DONE  secrets-policy.js into runtime env injection preflight
DONE  Telegram config loading through runtime env injection preflight
DONE  NemoClaw/OpenClaw explicit runtime approval recorded in #10
DONE  NemoClaw-mediated OpenCode runtime default for autonomous loop
DONE  NemoClaw candidate.patch-only policy and gateway
DONE  External agent job status/abort records
DONE  External agent bounded candidate.patch/stdout/stderr artifact retrieval
DONE  Telegram read-only planning graph command
DONE  Telegram read-only gate manifest command
DONE  Optional real external agent smoke for installed runtime
DONE  Ralph Autonomous Loop / UltraPlan Runner for Issue #11
DONE  Gemini/Kimi provider role separation for Issue #15
DONE  Dashboard/status report for Issue #19
DONE  PR body generation for Issue #20
```

## Remaining Implementation Gaps

```text
None for the confirmed v1.3 / detailed design v0.2 MVP scope.
None for Issue #11 MVP acceptance criteria.
None for Issue #14 NemoClaw-mediated OpenCode runtime acceptance criteria.
None for Issue #15 Gemini/Kimi provider role separation acceptance criteria.
None for Issue #19 dashboard/status report acceptance criteria.
None for Issue #20 PR body generation acceptance criteria.
```

## Still Blocked / Explicit Non-goals

```text
production deploy from Telegram
production migration from Telegram
merge from Telegram
unrestricted shell
raw logs
agent-initiated apply/commit/push/PR without the existing approval chain
non-NemoClaw OpenCode runtime as a default execution path
model-driven policy bypass
model access to raw secrets
```

## Current Green Evidence

Latest operator-provided verification:

```text
telegram-tests: 263 passed
supabase-local passed
playwright-e2e passed
post-secret-scan passed
all Phase 2 local gates passed
working tree clean
```
