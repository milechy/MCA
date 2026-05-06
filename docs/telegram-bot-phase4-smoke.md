# Telegram Bot Phase 4 Smoke Plan

This document defines the Phase 4 smoke procedure for validating the real Telegram Bot integration without weakening the Phase 3 safety boundary.

## Goal

Validate that the Telegram runtime can receive authorized commands from a private bot and return bounded operator responses while preserving:

- default-off `/run-all` execution
- explicit environment gate for real shell execution
- approval/hash preflight
- command allowlist enforcement
- compact audit logging
- execution/audit log separation

## Non-goals

Phase 4 smoke does not authorize arbitrary shell execution, deploys, production migrations, production secrets, or OpenCode execution from Telegram.

## Required environment variables

### Telegram transport

```bash
TELEGRAM_BOT_TOKEN="<private bot token>"
TELEGRAM_ALLOWED_USER_IDS="<comma-separated Telegram user ids>"
TELEGRAM_ALLOWED_CHAT_IDS="<comma-separated Telegram chat ids>"
```

### Runtime execution gate

```bash
RALPH_TELEGRAM_RUN_ALL_ENABLED="true"
```

This variable must be absent or not equal to `true` for default-off/preflight-only mode.

### Recommended local smoke defaults

```bash
RALPH_TELEGRAM_RUN_ALL_ENABLED=""
```

Start every smoke session with real run-all execution disabled.

## Smoke stages

### Stage 1: dry transport smoke

Purpose: prove the bot can receive and respond without executing anything.

Commands:

```text
/ping
/status
/policy
```

Expected:

```text
/ping -> pong
/status -> current state and mode
/policy -> bounded read-only execution policy
```

Required checks:

```bash
tail -n 20 .ralph/logs/audit.jsonl
tail -n 20 .ralph/logs/execution.jsonl
```

Expected log behavior:

- audit has compact Telegram command events
- `/policy` does not write shell execution entries
- execution log remains free of shell completion entries

### Stage 2: `/run-all` default-off smoke

Purpose: prove `/run-all` stays preflight-only unless explicitly enabled.

Preconditions:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Send:

```text
/run-all <approval_id> .ralph/tmp/<approved-plan>.json
```

Expected response:

```text
Run-all preflight passed. READY_BUT_NOT_EXECUTED.
```

Expected summary fields:

```text
run_all_enabled=false
wired_to_runtime=false
execution_connected=false
commands_executed=[]
files_modified=[]
```

Expected logs:

- compact audit summary exists
- no `shell_execution_completed`
- no `approved_shell_execution_completed`

### Stage 3: unsafe input smoke

Purpose: prove unsafe plan paths never reach shell execution.

Send:

```text
/run-all APR-ANY ../../tmp/evil.json
```

Expected:

```text
Run-all failed: plan_path_not_allowed
```

Expected summary fields:

```text
wired_to_runtime=false
execution_connected=false
commands_executed=[]
files_modified=[]
```

Expected logs:

- compact audit summary exists
- no shell completion entries

### Stage 4: real `/run-all` smoke behind explicit gate

Purpose: prove explicitly gated Telegram `/run-all` can execute only the production allowlisted command.

Preconditions:

```bash
export RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

Additional preconditions:

- approval exists and is approved
- plan hash matches
- diff hash matches
- command matches `scripts/gates/run-all.sh` with no args from repo root
- local working tree is in the expected state

Send:

```text
/run-all <approval_id> .ralph/tmp/<approved-plan>.json
```

Expected success response:

```text
Run-all execution completed.
```

Expected summary fields:

```text
run_all_enabled=true
wired_to_runtime=true
execution_connected=true
commands_executed=["scripts/gates/run-all.sh"]
files_modified=[]
exit_code=0
```

Expected logs:

```text
shell_execution_completed
approved_shell_execution_completed
```

## Abort criteria

Abort Phase 4 smoke immediately if any of the following occur:

- unauthorized user/chat reaches execution
- `/policy` writes shell execution log entries
- unsafe `/run-all` path reaches shell execution
- `/run-all` executes while `RALPH_TELEGRAM_RUN_ALL_ENABLED` is absent or not exactly `true`
- response text includes raw stdout, execution preflight internals, command preflight internals, or full shell policy internals
- `files_modified` is non-empty for the run-all smoke

## Pre-CI checklist

Before adding CI wiring:

```bash
npm run test:ralph
npm run test:telegram
./scripts/gates/run-all.sh
git status
```

Expected:

```text
[ralph-tests] passed
[telegram-tests] passed
[gate] all Phase 2 local gates passed
nothing to commit, working tree clean
```

## CI deferred items

The following should be handled after successful manual bot smoke:

- secret storage for `TELEGRAM_BOT_TOKEN`
- isolated CI Telegram chat/user allowlist
- CI job separation between dry transport smoke and gated run-all smoke
- explicit protection against running real `/run-all` on pull request forks
- retention policy for audit and execution logs
- incident-response runbook
