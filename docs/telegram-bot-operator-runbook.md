# Telegram Bot Operator Runbook

This runbook describes how to manually smoke test the Telegram bot integration while preserving the Phase 3+ safety boundary.

## Operating principle

Telegram execution must remain default-off unless an operator explicitly enables:

```bash
export RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

Never set this variable globally in a shell profile, CI environment, shared terminal session, or repository file.

For real explicit-gate `/run-all` smoke, prefer the hidden-prompt runner:

```bash
npm run telegram:real-run-all-smoke
```

The hidden-prompt runner avoids shell history-visible bot token exports, creates a fresh smoke approval and plan, prints the one-line Telegram command to send, polls only for the matching approval id, and cleans up shell environment on exit.

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

For read-only transport smoke, set Telegram transport variables only in the active shell session:

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

For explicit-gate `/run-all` smoke, use `npm run telegram:real-run-all-smoke` instead of pasting token-bearing export commands into shell history or chat.

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

Preferred command:

```bash
npm run telegram:real-run-all-smoke
```

The runner will:

```text
prompt for Telegram bot token without echo
prompt for allowed user/chat ids
run no-secret preflight
create a fresh approved smoke plan under .ralph/tmp/
print command_to_send
wait for operator confirmation after Telegram send
set RALPH_TELEGRAM_RUN_ALL_ENABLED=true for the smoke only
poll Telegram updates matched to the fresh approval id
run scripts/gates/run-all.sh through the Telegram runtime path
unset Telegram and run-all env vars on exit
restore .ralph/approval-log.jsonl on exit
```

Send the displayed `command_to_send` exactly as one line in the authorized Telegram chat. Do not send from the terminal.

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

## Phase 7 recorded pass

The explicit-gate real `/run-all` smoke passed with:

```text
executor=shell
command=scripts/gates/run-all.sh
exit_code=0
run_all_enabled=true
wired_to_runtime=true
execution_connected=true
commands_executed=["scripts/gates/run-all.sh"]
files_modified=[]
working tree clean after cleanup=yes
```

See:

```text
docs/telegram-phase7-run-all-smoke-report.md
```

This pass does not authorize new Telegram execution commands, production deploys, database migrations, OpenCode runtime execution, CI Telegram Bot API calls, or persistent secrets.

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

Restore transient approval-log smoke changes if present:

```bash
git restore .ralph/approval-log.jsonl 2>/dev/null || true
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
- paste bot token export commands into chat or shared logs

## Escalation notes

If an unexpected execution occurs, treat it as a safety incident. Preserve logs, disable the gate, and review:

- `.ralph/logs/audit.jsonl`
- `.ralph/logs/execution.jsonl`
- `.ralph/approval-log.jsonl`
- `.ralph/approval-pending/`
- `.ralph/tmp/`
