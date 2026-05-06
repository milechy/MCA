# Telegram Phase 5 Read-only Go/No-Go Checklist

This checklist is the final operator gate before running the real Telegram Bot API read-only smoke.

It does not authorize real `/run-all` execution.

## Scope

Allowed in this checklist:

```text
/ping
/status
/policy
```

Not allowed in this checklist:

```text
/run-all
/approve
/deny
/modify
/mode fullauto
/confirm
```

Real `/run-all` remains a separate manual stage requiring separate operator confirmation after read-only smoke passes.

## Hard no-go conditions

Do not run real Bot API smoke if any of the following are true:

- local gates are not green
- working tree is not clean
- `npm run telegram:preflight-no-secrets` fails
- `npm run telegram:real-transport-guard` fails
- `RALPH_TELEGRAM_RUN_ALL_ENABLED=true` is set
- Telegram token or IDs appear in `git diff`, `git diff --cached`, CI, repository files, logs, or chat output
- operator has not read `docs/telegram-phase5-manual-smoke-template.md`
- operator is not in the authorized user allowlist
- chat is not in the authorized chat allowlist

## Required local gate commands

Run from the repository root:

```bash
npm run telegram:preflight-no-secrets
npm run telegram:dry-transport-smoke
npm run test:ralph
npm run test:telegram
./scripts/gates/run-all.sh
git status
```

Expected:

```text
preflight-no-secrets ok=true
dry-transport-smoke ok=true
[ralph-tests] passed
[telegram-tests] passed
[gate] all Phase 2 local gates passed
nothing to commit, working tree clean
```

## Session-only environment

Set these values only in the current shell session:

```bash
export TELEGRAM_BOT_TOKEN="<private bot token>"
export TELEGRAM_ALLOWED_USER_IDS="<authorized user ids>"
export TELEGRAM_ALLOWED_CHAT_IDS="<authorized chat ids>"
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Then run:

```bash
npm run telegram:check-env
npm run telegram:preflight-no-secrets
npm run telegram:real-transport-guard
```

Expected:

```text
telegram env present
bot token redacted
repo_secret_preflight_ok=true
run_all_enabled=false
allowed_commands=["/ping","/status","/policy"]
```

## Go decision

Proceed to real read-only smoke only if all of these are true:

```text
local_gates_green=true
working_tree_clean=true
preflight_no_secrets_ok=true
dry_transport_smoke_ok=true
real_transport_guard_ok=true
run_all_enabled=false
allowed_commands_only=/ping,/status,/policy
secrets_committed=false
operator_ready=true
```

## No-go decision

If any check fails:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
unset TELEGRAM_BOT_TOKEN
unset TELEGRAM_ALLOWED_USER_IDS
unset TELEGRAM_ALLOWED_CHAT_IDS
```

Do not retry until the failed condition is understood and fixed.

## Real read-only smoke command

After a go decision, run:

```bash
npm run telegram:real-readonly-smoke
```

Expected output contract:

```text
ok=true
output_contract.no_raw_update=true
output_contract.no_raw_response_payload=true
output_contract.no_private_ids=true
commands=["/ping","/status","/policy"]
response_kind in ["pong","status","policy"]
run_all_enabled=false
```

The output must not include:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS
TELEGRAM_ALLOWED_CHAT_IDS
raw user id
raw chat id
raw update payload
raw response_text
```

## Post-smoke checks

Run:

```bash
npm run telegram:inspect-logs
git status
git diff
git diff --cached
```

Expected:

```text
no shell completion events from read-only commands
nothing to commit, working tree clean
no token or Telegram ID in diff
```

## Safe result report

Report only this shape:

```text
Phase 5 real read-only smoke go/no-go:
- local gates: pass|fail
- preflight-no-secrets: pass|fail
- dry-transport-smoke: pass|fail
- real-transport-guard: pass|fail
- real-readonly /ping: pass|fail|not-run
- real-readonly /status: pass|fail|not-run
- real-readonly /policy: pass|fail|not-run
- run_all_enabled: false|unexpected-true
- output redaction: pass|fail
- shell completion events: none|present
- working tree clean: yes|no
- secrets committed: no|yes
- decision: go|no-go
```

Do not report tokens, Telegram user IDs, Telegram chat IDs, private bot URLs, or raw log payloads.

## Deferred items

Still deferred after this checklist:

- real default-off `/run-all` smoke
- explicit-gate real `/run-all` smoke
- GitHub Secrets storage for Telegram token
- CI job that calls Telegram Bot API
- CI job that performs gated `/run-all`
- production deploys from Telegram
- database migrations from Telegram
- OpenCode runtime execution from Telegram
