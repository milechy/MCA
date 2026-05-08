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
| Gate Runner | pre/post secret scans required | DONE | `src/ralph/gate-runner.js`, `scripts/gates/run-all.sh` |
| Gate Runner | lint/typecheck/unit/build/type generation/dependency audit slots | DONE | optional gates in `src/ralph/gate-runner.js` |
| Gate Runner | Supabase local reset / migration dry-run gate | DONE | `scripts/gates/supabase-local.sh`, `src/ralph/gate-runner.js` |
| Gate Runner | Playwright smoke/regression slots | DONE | `src/ralph/gate-runner.js`, `scripts/gates/playwright-e2e.sh` |
| Secrets | Secret values never displayed/persisted/logged | DONE | `src/ralph/secrets-policy.js`, `tests/ralph/secrets-policy.spec.js` |
| Secrets | Reference-only runtime injection | DONE | `src/ralph/secrets-policy.js` |
| Secrets | Production secret injection blocked | DONE | `src/ralph/secrets-policy.js` |
| Production DB | production destructive DB change security stop | DONE | `src/ralph/production-change-policy.js` |
| Production DB | production migration human approval | DONE | `src/ralph/production-change-policy.js` |
| RLS/Auth | RLS/auth changes require approval | DONE | `src/ralph/production-change-policy.js` |
| Failure | Risk 5 stop criteria | DONE | `src/ralph/failure-escalation.js` |
| Failure | Stop story/agent/secret injection, preserve logs/diff, notify, human resume | DONE | `src/ralph/failure-escalation.js` |
| LangGraph | Planning layer skeleton | DONE | `src/ralph/langgraph-planning-layer.js` |
| LangGraph | non-executing graph with plan/risk/decision/route | DONE | `src/ralph/langgraph-planning-layer.js` |
| OpenCode | real CLI sandbox smoke | DONE | `scripts/telegram/real-opencode-operational-smoke.js` |
| OpenCode | candidate patch only | DONE | `src/telegram/opencode-run.js` |
| OpenCode | patch preview / approval / apply / gates / commit / push / PR chain | DONE | `src/telegram/opencode-*.js` |
| OpenCode | bounded status/abort/artifact retrieval | DONE | `src/telegram/opencode-jobs.js`, `src/telegram/opencode-artifacts.js` |
| External Gateway | NemoClaw/OpenClaw boundary policy | DONE | `src/ralph/external-agent-gateway.js`, `docs/opencode-external-agent-gateway-boundary.md` |
| External Gateway | NemoClaw runtime dependency | BLOCKED | requires separate explicit approval |
| External Gateway | OpenClaw runtime dependency | BLOCKED | requires separate explicit approval |
| Deploy | production deploy from Telegram | BLOCKED | explicit non-goal |
| Migration | production migration from Telegram | BLOCKED | explicit non-goal unless separate human approval path is created |
| Merge | merge from Telegram | BLOCKED | explicit non-goal |
| Shell | unrestricted shell | BLOCKED | explicit non-goal |

## Remaining Implementation Gaps

### 1. Connect `gate-runner.js` into the runtime command path

Current state:

```text
scripts/gates/run-all.sh is the active gate command.
src/ralph/gate-runner.js formalizes the gate sequence and policy.
```

Remaining work:

```text
Add CLI command: node src/ralph/cli.js gate-runner
Optionally switch Telegram /run-all summary to consume gate-runner summaries.
Keep scripts/gates/run-all.sh as compatibility wrapper.
```

### 2. Connect `langgraph-planning-layer.js` into CLI/Telegram plan creation

Current state:

```text
Planning graph skeleton exists and is tested.
Existing OpenCode/TG flows still build plans through narrower helpers.
```

Remaining work:

```text
Add CLI command: node src/ralph/cli.js plan <story.json>
Add Telegram command or internal route for planning graph output.
Ensure approval creation consumes planning graph plan_hash.
```

### 3. Connect `production-change-policy.js` into execution preflight

Current state:

```text
Policy exists and is tested.
OpenCode apply/commit/push/PR chain has separate controls.
```

Remaining work:

```text
Execution preflight should call production-change-policy for production/RLS/auth/migration plans.
Risk evaluator and production policy decisions should be reconciled in one preflight output.
```

### 4. Connect `secrets-policy.js` into Telegram/OpenCode runtime setup

Current state:

```text
Secret policy exists and is tested.
Telegram real smoke uses local prompt handling and redaction.
```

Remaining work:

```text
All runtime env injection paths should call decideSecretInjection.
Reject literal secrets before runtime invocation.
Only allow reference names in persistent approval/plan artifacts.
```

### 5. External gateway runtime adapters

Current state:

```text
NemoClaw/OpenClaw/generic gateway policy exists.
Runtime dependency is intentionally blocked without separate approval.
```

Remaining work if approved:

```text
Implement concrete NemoClaw adapter as candidate.patch-only provider.
Add test double.
Add real smoke.
Wire status/abort/artifact retrieval.
Keep same sandbox/preflight/approval boundaries.
```

## Immediate Next Tasks

```text
1. Wire gate-runner.js into Ralph CLI.
2. Wire langgraph-planning-layer.js into Ralph CLI.
3. Wire production-change-policy.js into execution-preflight.
4. Wire secrets-policy.js into runtime env injection preflight.
5. Create a separate approval issue before any NemoClaw/OpenClaw runtime dependency.
```

## Current Green Evidence

Latest operator-provided verification:

```text
telegram-tests: 249 passed
supabase-local passed
playwright-e2e passed
post-secret-scan passed
all Phase 2 local gates passed
working tree clean
```
