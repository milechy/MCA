# Telegram Phase 7 Explicit-gate Run-all Smoke Report

This report records the manually initiated real Telegram `/run-all` smoke after Phase 6 read-only transport validation.

Do **not** include Telegram bot tokens, raw Telegram user IDs, raw Telegram chat IDs, private bot URLs, raw update payloads, raw response payloads, full audit logs, or full execution logs.

## Scope

Phase 7 validates only this path:

```text
authorized Telegram user/chat
→ fresh approved local smoke plan
→ explicit local session gate RALPH_TELEGRAM_RUN_ALL_ENABLED=true
→ /run-all <approval_id> .ralph/tmp/<approval_id>.json
→ scripts/gates/run-all.sh
```

Allowed execution command is exactly:

```text
scripts/gates/run-all.sh
```

Still out of scope:

```text
production deploys from Telegram
database migrations from Telegram
OpenCode runtime execution from Telegram
multi-command shell allowlist expansion
GitHub Actions or CI Telegram Bot API secrets
persistent RALPH_TELEGRAM_RUN_ALL_ENABLED=true
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

## Required operator command

Use the hidden-prompt runner only:

```bash
npm run telegram:real-run-all-smoke
```

The runner prompts for the Telegram bot token without echoing it, creates a fresh approval and plan, prints a one-line `command_to_send`, waits for the operator to send that command in Telegram, then polls for the matching approval id.

Do not use shell history-visible token exports for this smoke.

## Evidence captured

Successful smoke evidence from 2026-05-07:

```json
{
  "ok": true,
  "reason": null,
  "reason_taxonomy": null,
  "stage": null,
  "executor": "shell",
  "command": "scripts/gates/run-all.sh",
  "exit_code": 0,
  "duration_ms": 34657,
  "run_all_enabled": true,
  "wired_to_runtime": true,
  "execution_connected": true,
  "commands_executed": [
    "scripts/gates/run-all.sh"
  ],
  "files_modified": [],
  "approval_id": "APR-TELEGRAM-RUN-ALL-SMOKE-20260507022239",
  "plan_path": ".ralph/tmp/APR-TELEGRAM-RUN-ALL-SMOKE-20260507022239.json",
  "log_path": ".ralph/logs/execution.jsonl"
}
```

Repository cleanup evidence:

```text
nothing to commit, working tree clean
```

## Pass criteria

A pass requires all of:

```text
preflight-no-secrets=pass
local gates=pass
working tree clean before smoke=yes
fresh approval id generated=yes
operator sends exact command_to_send in Telegram=yes
run_all_enabled=true only during smoke=yes
executor=shell
command=scripts/gates/run-all.sh
exit_code=0
commands_executed=["scripts/gates/run-all.sh"]
files_modified=[]
working tree clean after smoke=yes
secrets committed=no
cleanup completed=yes
```

## Cleanup

After every Phase 7 smoke run:

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

## Decision

```text
decision: pass-explicit-gate-run-all-smoke
```

This decision means the manual, explicit-gate Telegram `/run-all` path can execute the single production allowlisted local gate command. It does not authorize new commands, CI execution, production deploys, migrations, or persistent secrets.
