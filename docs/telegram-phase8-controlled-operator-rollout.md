# Telegram Phase 8 Controlled Operator Rollout

Phase 8 converts the successful explicit-gate `/run-all` smoke into a controlled operator rollout boundary.

This phase does **not** authorize production deployment, database migration, OpenCode execution, CI Telegram Bot API usage, persistent bot secrets, or a broadened shell allowlist.

## Current proven path

The following path has passed manual real Telegram smoke:

```text
authorized Telegram user/chat
→ fresh local approved smoke plan
→ RALPH_TELEGRAM_RUN_ALL_ENABLED=true in the active local shell only
→ /run-all <approval_id> .ralph/tmp/<approval_id>.json
→ scripts/gates/run-all.sh
→ exit_code=0
→ files_modified=[]
→ working tree clean after cleanup
```

## Rollout boundary

Allowed during Phase 8:

```text
/ping
/status
/policy
/run-all <approval_id> .ralph/tmp/<approval_id>.json
```

The only executable command remains:

```text
scripts/gates/run-all.sh
```

The explicit run-all gate must be enabled only in a local, attended operator session:

```bash
export RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

The gate must be disabled immediately after the smoke or operator run:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

## Required operator runner

Use only the hidden-prompt runner for real Telegram `/run-all` validation:

```bash
npm run telegram:real-run-all-smoke
```

Do not paste Telegram bot tokens into chat, shared logs, runbooks, GitHub issues, shell transcripts, or committed files.

## Pre-run checklist

Before enabling the explicit gate:

```text
local branch is expected branch=yes
working tree clean=yes
npm run test:telegram passes=yes
./scripts/gates/run-all.sh passes=yes
pre-secret-scan passes=yes
post-secret-scan passes=yes
operator is present=yes
Telegram chat is authorized=yes
approval id is fresh=yes
plan path is under .ralph/tmp/ and ends in .json=yes
```

## Runtime invariants

Phase 8 requires all of:

```text
run_all_enabled true only during attended session
telegram_shell_execution_connected true only when explicit gate is true
approval/hash/diff preflight required
command allowlist required
command exactly scripts/gates/run-all.sh
commands_executed contains no other command
files_modified remains [] for the Telegram smoke result
response preview does not include raw stdout
response preview does not include raw Telegram payload
response preview does not include full execution internals
logs are inspected after run
working tree clean after cleanup
```

## Abort criteria

Abort immediately if any of the following occur:

```text
unauthorized user/chat reaches command handler
unsafe plan path reaches shell execution
/run-all executes while explicit gate is unset or not exactly true
command executed is not scripts/gates/run-all.sh
commands_executed has more than one command
files_modified is non-empty
response includes raw token, raw chat id, raw user id, raw update, raw response payload, stdout, or full shell policy internals
working tree is dirty after cleanup except documented transient local logs
```

## Cleanup

After every run:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
unset TELEGRAM_BOT_TOKEN
unset TELEGRAM_ALLOWED_USER_IDS
unset TELEGRAM_ALLOWED_CHAT_IDS
git restore .ralph/approval-log.jsonl 2>/dev/null || true
git status
```

Expected:

```text
nothing to commit, working tree clean
```

## Exit criteria

Phase 8 is complete when:

```text
Phase 7 smoke report is present=yes
operator runbook points to hidden-prompt runner=yes
controlled rollout boundary documented=yes
drift tests protect Phase 8 boundaries=yes
npm run test:telegram passes=yes
./scripts/gates/run-all.sh passes=yes
working tree clean=yes
```

## Explicit non-goals

```text
No production deploy from Telegram
No database migration from Telegram
No OpenCode execution from Telegram
No CI Telegram Bot API execution
No persistent bot token in repository or CI
No persistent RALPH_TELEGRAM_RUN_ALL_ENABLED=true
No shell allowlist expansion
No unattended bot daemon rollout
```
