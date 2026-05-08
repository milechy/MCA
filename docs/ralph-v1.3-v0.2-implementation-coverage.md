# Ralph v1.3 / Detailed Design v0.2 Implementation Coverage

This document tracks implementation coverage against the confirmed v1.3 requirements and v0.2 detailed design direction.

## Status Legend

```text
DONE      implemented with tests and local gates green
PARTIAL   implemented as a skeleton or bounded subset
TODO      not implemented yet
BLOCKED   intentionally not implemented without separate approval
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
| Approval | `/modify` supersedes and requires replan | DONE | `src/ralph/approval-manager.js`, Telegram approval adapter tests |
| Mode | `/mode approval` immediate | DONE | `src/ralph/mode-manager.js` |
| Mode | `/mode fullauto` admin/confirm/expiry | DONE | `src/ralph/mode-manager.js`, Telegram handler coverage |
| Hashing | canonical JSON plan hash | DONE | `src/ralph/langgraph-planning-layer.js`, existing approval manager hash coverage |
| Hashing | diff approval separation | DONE | `src/ralph/state-machine.js`, `src/ralph/production-change-policy.js`, OpenCode patch approval flow |
| Gate Runner | ordered gate manifest | DONE | `src/ralph/gate-runner.js` |
| Gate Runner | Ralph CLI command | DONE | `node src/ralph/cli.js gate-runner`, `tests/ralph/cli-gate-runner.spec.js` |
| Gate Runner | Telegram read-only manifest command | DONE | `/ralph-gate-manifest`, `tests/telegram/handlers.spec.js` |
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
| OpenCode | real CLI sandbox smoke | DONE | `scripts/telegram/real-opencode-operational-smoke.js` |
| OpenCode | candidate patch only | DONE | `src/telegram/opencode-run.js` |
| OpenCode | patch preview / approval / apply / gates / commit / push / PR chain | DONE | `src/telegram/opencode-*.js` |
| OpenCode | bounded status/abort/artifact retrieval | DONE | `src/telegram/opencode-jobs.js`, `src/telegram/opencode-artifacts.js` |
| External Gateway | NemoClaw/OpenClaw boundary policy | DONE | `src/ralph/external-agent-gateway.js`, `docs/opencode-external-agent-gateway-boundary.md` |
| External Gateway | NemoClaw/OpenClaw runtime approval record | DONE | GitHub issue `#10` operator approval comment |
| External Gateway | NemoClaw/OpenClaw candidate.patch-only adapter | DONE | `src/ralph/external-agent-adapter.js`, `tests/ralph/external-agent-adapter.spec.js` |
| External Gateway | External agent job status/abort records | DONE | `src/ralph/external-agent-jobs.js`, `tests/ralph/external-agent-jobs.spec.js` |
| External Gateway | External agent bounded artifact retrieval | DONE | `src/ralph/external-agent-artifacts.js`, `tests/ralph/external-agent-artifacts.spec.js` |
| External Gateway | Optional real runtime smoke | DONE | `scripts/ralph/real-external-agent-smoke.js`, `tests/ralph/real-external-agent-smoke.spec.js`, `npm run ralph:real-external-agent-smoke` |
| Deploy | production deploy from Telegram | BLOCKED | explicit non-goal |
| Migration | production migration from Telegram | BLOCKED | explicit non-goal unless separate human approval path is created |
| Merge | merge from Telegram | BLOCKED | explicit non-goal |
| Shell | unrestricted shell | BLOCKED | explicit non-goal |

## Previously Identified Gaps Now Closed

```text
DONE  gate-runner.js into Ralph CLI
DONE  langgraph-planning-layer.js into Ralph CLI
DONE  production-change-policy.js into execution-preflight
DONE  secrets-policy.js into runtime env injection preflight
DONE  Telegram config loading through runtime env injection preflight
DONE  NemoClaw/OpenClaw explicit runtime approval recorded in #10
DONE  NemoClaw/OpenClaw candidate.patch-only adapter
DONE  External agent job status/abort records
DONE  External agent bounded candidate.patch/stdout/stderr artifact retrieval
DONE  Telegram read-only planning graph command
DONE  Telegram read-only gate manifest command
DONE  Optional real external agent smoke for installed runtime
```

## Remaining Implementation Gaps

```text
None for the confirmed v1.3 / detailed design v0.2 MVP scope.
```

## Still Blocked / Explicit Non-goals

```text
production deploy from Telegram
production migration from Telegram
merge from Telegram
unrestricted shell
raw logs
agent-initiated apply/commit/push/PR without the existing approval chain
```

## Current Green Evidence

Latest operator-provided verification:

```text
telegram-tests: 252 passed
supabase-local passed
playwright-e2e passed
post-secret-scan passed
all Phase 2 local gates passed
ralph:real-external-agent-smoke ok=true skipped=true when runtime is not installed
working tree clean
```
