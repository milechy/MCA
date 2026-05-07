# Telegram Phase 9 Observability and Incident Controls

Phase 9 adds observability and incident-control boundaries after the successful Phase 7 explicit-gate run-all smoke and Phase 8 controlled operator rollout boundary.

This phase does **not** authorize unattended daemon operation, production deploys, database migrations, OpenCode execution, CI Telegram Bot API usage, persistent bot secrets, or shell allowlist expansion.

## Objective

Provide a repeatable operator view of Telegram runtime safety events without exposing secrets or raw Telegram payloads.

Phase 9 focuses on:

```text
bounded log summaries
incident trigger conditions
abort evidence preservation
safe report validation
operator-readable go/no-go status
```

## Current allowed execution boundary

The only allowed executable command remains:

```text
scripts/gates/run-all.sh
```

The explicit runtime gate remains local-session-only:

```bash
export RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

The gate must not be set persistently, in CI, in shell profile files, or in repository files.

## Observability surfaces

Approved operator inspection commands:

```bash
npm run telegram:inspect-logs
npm run telegram:validate-smoke-report -- <report-file>
npm run telegram:check-env
npm run telegram:real-transport-guard
```

Operator reports must include only bounded summaries:

```text
ok
reason
reason_taxonomy
stage
executor
command
exit_code
duration_ms
run_all_enabled
wired_to_runtime
execution_connected
commands_executed
files_modified
approval_id
plan_path
log_path
shell_completion_events count or bounded summary
working tree clean status
```

Reports must not include:

```text
Telegram bot token
raw Telegram user id
raw Telegram chat id
private bot URL
raw update payload
raw response payload
raw response_text
full audit log
full execution log
stdout from shell execution
stderr from shell execution
full shell policy internals
```

## Incident trigger conditions

Treat any of the following as an incident:

```text
unauthorized user/chat reaches shell execution
unknown command reaches shell execution
unsafe plan path reaches shell execution
/run-all executes while RALPH_TELEGRAM_RUN_ALL_ENABLED is unset or not exactly true
command other than scripts/gates/run-all.sh executes
commands_executed contains more than one command
files_modified is non-empty
response includes token-like value
response includes raw Telegram user id or chat id
response includes raw update or raw response payload
response includes full stdout/stderr
working tree remains dirty after cleanup
```

## Incident response

Immediate operator actions:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
unset TELEGRAM_BOT_TOKEN
unset TELEGRAM_ALLOWED_USER_IDS
unset TELEGRAM_ALLOWED_CHAT_IDS
npm run telegram:inspect-logs
```

Preserve evidence before clearing transient state:

```bash
cp .ralph/logs/audit.jsonl .ralph/logs/audit.incident.$(date +%Y%m%d%H%M%S).jsonl
cp .ralph/logs/execution.jsonl .ralph/logs/execution.incident.$(date +%Y%m%d%H%M%S).jsonl
cp .ralph/approval-log.jsonl .ralph/approval-log.incident.$(date +%Y%m%d%H%M%S).jsonl
```

Do not post preserved logs to chat unless they have been separately redacted and validated.

## Safe report validation

Before sharing any smoke or incident report, run:

```bash
npm run telegram:validate-smoke-report -- <report-file>
```

A report is shareable only if:

```text
validator ok=true
no secret env keys
no token-like values
no raw Telegram IDs
no raw update payloads
no raw response payloads
required summary shape present
```

## Go/no-go summary format

Use this compact form for operator status:

```text
phase: 9-observability-incident-controls
local_gates: pass|fail
telegram_tests: pass|fail
pre_secret_scan: pass|fail
post_secret_scan: pass|fail
real_transport_guard: pass|fail|not-run
explicit_run_all_smoke: pass|fail|not-run
executor: shell|null
command: scripts/gates/run-all.sh|null
exit_code: 0|nonzero|null
files_modified: []|non-empty|unknown
working_tree_clean: yes|no
incident: yes|no
next_action: continue|abort|investigate
```

## Exit criteria

Phase 9 is complete when:

```text
observability and incident-control doc exists=yes
runbook links Phase 9 controls=yes
drift tests protect Phase 9 non-goals=yes
smoke report validator still passes safe reports=yes
npm run test:telegram passes=yes
./scripts/gates/run-all.sh passes=yes
working tree clean=yes
```

## Explicit non-goals

```text
No unattended bot daemon rollout
No production deploy from Telegram
No database migration from Telegram
No OpenCode execution from Telegram
No CI Telegram Bot API execution
No persistent bot token in repository or CI
No persistent RALPH_TELEGRAM_RUN_ALL_ENABLED=true
No shell allowlist expansion
No automatic incident remediation
```
