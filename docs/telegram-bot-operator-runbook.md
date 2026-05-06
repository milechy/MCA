# Telegram Bot Operator Runbook

This runbook describes how to manually smoke test the Telegram bot integration while preserving the Phase 3/4 safety boundary.

## Operating principle

Telegram execution must remain default-off unless an operator explicitly enables:

```bash
export RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

Never set this variable globally in a shell profile, CI environment, shared terminal session, or repository file.

## Preconditions

Run from the repository root:

```bash
cd /Users/hkobayashi/MCA
```

Local gates must be green before manual bot smoke:

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

## Environment setup

Set Telegram transport variables only in the active shell session:

```bash
export TELEGRAM_BOT_TOKEN="<private bot token>"
export TELEGRAM_ALLOWED_USER_IDS="<comma-separated authorized Telegram user ids>"
export TELEGRAM_ALLOWED_CHAT_IDS="<comma-separated authorized Telegram chat ids>"
```

Check environment status:

```bash
npm run telegram:check-env
```

The bot token should be redacted in output.

## Stage 1: read-only transport smoke

Keep run-all execution disabled:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Send these Telegram commands from an authorized chat:

```text
/ping
/status
/policy
```

Expected:

```text
/ping returns pong
/status returns state and mode
/policy returns bounded read-only execution policy
```

Inspect logs:

```bash
npm run telegram:inspect-logs
```

Expected:

- compact audit events exist
- no shell completion events for `/policy`
- no unexpected execution log entries

## Stage 2: default-off `/run-all` smoke

Keep run-all execution disabled:

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

Expected summary:

```text
run_all_enabled=false
wired_to_runtime=false
execution_connected=false
commands_executed=[]
files_modified=[]
```

Inspect logs:

```bash
npm run telegram:inspect-logs
```

Abort if any shell completion event appears.

## Stage 3: unsafe input smoke

Send:

```text
/run-all APR-ANY ../../tmp/evil.json
```

Expected response:

```text
Run-all failed: plan_path_not_allowed
```

Expected summary:

```text
wired_to_runtime=false
execution_connected=false
commands_executed=[]
files_modified=[]
```

Abort if any shell completion event appears.

## Stage 4: real run-all smoke behind explicit gate

Only enter this stage after Stages 1-3 pass.

Enable run-all for this shell session only:

```bash
export RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

Re-check environment:

```bash
npm run telegram:check-env
```

Send:

```text
/run-all <approval_id> .ralph/tmp/<approved-plan>.json
```

Expected success response:

```text
Run-all execution completed.
```

Expected summary:

```text
run_all_enabled=true
wired_to_runtime=true
execution_connected=true
commands_executed=["scripts/gates/run-all.sh"]
files_modified=[]
exit_code=0
```

Expected execution log events:

```text
shell_execution_completed
approved_shell_execution_completed
```

Inspect logs:

```bash
npm run telegram:inspect-logs
```

## Immediate abort criteria

Abort the smoke immediately if any of the following occur:

- unauthorized user/chat reaches execution
- `/policy` writes shell completion events
- unsafe `/run-all` path reaches execution
- `/run-all` executes while `RALPH_TELEGRAM_RUN_ALL_ENABLED` is unset or not exactly `true`
- response text includes raw stdout, execution preflight internals, command preflight internals, or full shell policy internals
- `files_modified` is non-empty
- command executed is anything other than `scripts/gates/run-all.sh`

## Abort procedure

Immediately disable real run-all execution:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Stop interacting with the bot until logs are reviewed.

Inspect logs:

```bash
npm run telegram:inspect-logs
```

Preserve the current log files for review:

```bash
cp .ralph/logs/audit.jsonl .ralph/logs/audit.abort.$(date +%Y%m%d%H%M%S).jsonl
cp .ralph/logs/execution.jsonl .ralph/logs/execution.abort.$(date +%Y%m%d%H%M%S).jsonl
```

Then reset local transient smoke state only if no further forensic review is required:

```bash
rm -rf .ralph/approval-pending/*
rm -rf .ralph/tmp/*
: > .ralph/approval-log.jsonl
: > .ralph/logs/execution.jsonl
```

Do not delete preserved abort copies.

## Cleanup after successful smoke

Disable real run-all execution:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Clear shell-local Telegram secrets:

```bash
unset TELEGRAM_BOT_TOKEN
unset TELEGRAM_ALLOWED_USER_IDS
unset TELEGRAM_ALLOWED_CHAT_IDS
```

Confirm clean code state:

```bash
git status
```

Expected:

```text
nothing to commit, working tree clean
```

## Do not do

Do not:

- commit bot tokens or Telegram IDs to the repository
- set `RALPH_TELEGRAM_RUN_ALL_ENABLED=true` in GitHub Actions
- allow production deploys or migrations from Telegram
- expand Telegram command allowlist without new tests
- bypass approval/hash/diff preflight
- run smoke from an untrusted chat

## Escalation notes

If an unexpected execution occurs, treat it as a safety incident. Preserve logs, disable the gate, and review:

- `.ralph/logs/audit.jsonl`
- `.ralph/logs/execution.jsonl`
- `.ralph/approval-log.jsonl`
- `.ralph/approval-pending/`
- `.ralph/tmp/`
