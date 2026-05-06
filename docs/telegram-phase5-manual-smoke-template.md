# Telegram Phase 5 Manual Smoke Template

Use this template when performing the first real Telegram bot smoke.

Do **not** fill this file with real secrets, Telegram user ids, chat ids, bot tokens, or private URLs. Copy the template to a private scratchpad outside the repository if concrete values are needed.

## Safety boundary

Phase 5 may validate a real Telegram Bot API path, but real `/run-all` execution remains protected by:

- authorized Telegram user and chat allowlists
- approval record existence and status
- plan hash verification
- diff hash verification
- command allowlist
- shell execution policy
- explicit `RALPH_TELEGRAM_RUN_ALL_ENABLED=true` environment gate

No repository file, CI workflow, npm script, or checked-in document may make real Telegram `/run-all` execution persistent or automatic.

## Private values checklist

Keep these values outside the repository:

```text
TELEGRAM_BOT_TOKEN=<private value, never commit>
TELEGRAM_ALLOWED_USER_IDS=<private value, never commit>
TELEGRAM_ALLOWED_CHAT_IDS=<private value, never commit>
```

Before smoke, verify no private values are staged or tracked:

```bash
git status
git diff --cached
git diff
```

## Pre-smoke local gates

Run from the repository root:

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

## Session-only environment setup

Set variables in the active shell only:

```bash
export TELEGRAM_BOT_TOKEN="<private bot token>"
export TELEGRAM_ALLOWED_USER_IDS="<authorized user ids>"
export TELEGRAM_ALLOWED_CHAT_IDS="<authorized chat ids>"
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Check helper output:

```bash
npm run telegram:check-env
npm run telegram:preflight-no-secrets
```

Expected:

```text
TELEGRAM_BOT_TOKEN is present and redacted
telegram_run_all_enabled=false
preflight-no-secrets ok=true
```

## Real read-only transport guard

Before any real Bot API read-only smoke, run:

```bash
npm run telegram:real-transport-guard
```

Expected:

```text
ok=true
stage=real_transport_read_only_guard
allowed_commands=["/ping","/status","/policy"]
forbidden_commands includes /run-all, /approve, /deny, /modify, /mode fullauto, /confirm
run_all_enabled=false
telegram_env_ok=true
repo_secret_preflight_ok=true
```

If this command fails, do not run real Bot API smoke.

## Real read-only Bot API smoke

Only after the guard passes, run:

```bash
npm run telegram:real-readonly-smoke
```

This runner is intentionally limited to:

```text
/ping
/status
/policy
```

It must not send:

```text
/run-all
/approve
/deny
/modify
/mode fullauto
/confirm
```

Expected:

```text
ok=true
commands=["/ping","/status","/policy"]
dry_run_telegram_send=false
run_all_enabled=false
```

Inspect logs:

```bash
npm run telegram:inspect-logs
```

Expected:

```text
compact audit events exist
no shell completion events from read-only commands
```

## Smoke worksheet

Record only non-secret results.

### Stage 1: read-only transport

Commands sent by real-readonly runner:

```text
/ping
/status
/policy
```

Observed result:

```text
<record only status, no secrets>
```

Log inspection:

```bash
npm run telegram:inspect-logs
```

Expected:

```text
compact audit events exist
no shell completion events from read-only commands
```

### Stage 2: default-off `/run-all`

This stage is manual only and must not be run by `telegram:real-readonly-smoke`.

Ensure gate is unset:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Command sent manually only after read-only smoke passes:

```text
/run-all <approval_id> .ralph/tmp/<approved-plan>.json
```

Expected:

```text
READY_BUT_NOT_EXECUTED
run_all_enabled=false
wired_to_runtime=false
execution_connected=false
commands_executed=[]
files_modified=[]
```

### Stage 3: unsafe input

Command sent manually only after read-only smoke passes:

```text
/run-all APR-ANY ../../tmp/evil.json
```

Expected:

```text
plan_path_not_allowed
wired_to_runtime=false
execution_connected=false
commands_executed=[]
files_modified=[]
```

### Stage 4: explicit-gate real `/run-all`

Only proceed after stages 1-3 pass and after separate operator confirmation.

Enable in active shell only:

```bash
export RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

Command sent manually:

```text
/run-all <approval_id> .ralph/tmp/<approved-plan>.json
```

Expected:

```text
Run-all execution completed.
run_all_enabled=true
wired_to_runtime=true
execution_connected=true
commands_executed=["scripts/gates/run-all.sh"]
files_modified=[]
exit_code=0
```

## Abort notes

Abort immediately if any safety invariant fails.

First command:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Then preserve logs:

```bash
cp .ralph/logs/audit.jsonl .ralph/logs/audit.phase5-abort.$(date +%Y%m%d%H%M%S).jsonl
cp .ralph/logs/execution.jsonl .ralph/logs/execution.phase5-abort.$(date +%Y%m%d%H%M%S).jsonl
```

Do not delete preserved abort logs.

## Cleanup after successful smoke

Unset all session-local secrets and gates:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
unset TELEGRAM_BOT_TOKEN
unset TELEGRAM_ALLOWED_USER_IDS
unset TELEGRAM_ALLOWED_CHAT_IDS
```

Confirm no private values were written to the repository:

```bash
git status
git diff
git diff --cached
```

Expected:

```text
nothing to commit, working tree clean
```

## Safe result report format

Use this format when reporting results in issue comments or chat:

```text
Phase 5 manual Telegram smoke:
- real transport guard: pass|fail
- real-readonly /ping: pass|fail
- real-readonly /status: pass|fail
- real-readonly /policy: pass|fail
- default-off /run-all: READY_BUT_NOT_EXECUTED pass|fail|not-run
- unsafe path: plan_path_not_allowed pass|fail|not-run
- explicit-gate /run-all: completed|skipped|failed|not-run
- files_modified: []|non-empty
- logs preserved: yes|no
- secrets committed: no
```

Do not include token values, Telegram user ids, chat ids, private bot URLs, or raw log payloads containing private values.
