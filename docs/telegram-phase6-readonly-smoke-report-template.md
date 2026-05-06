# Telegram Phase 6 Read-only Smoke Report Template

Use this template after running the real Telegram Bot API read-only smoke.

Do **not** include Telegram bot tokens, raw Telegram user IDs, raw Telegram chat IDs, private bot URLs, raw update payloads, raw response payloads, full audit logs, or full execution logs.

## Scope

This report is only for real read-only Bot API smoke:

```text
/ping
/status
/policy
```

This report does not authorize or document real `/run-all` execution.

Commands that must not be part of this report:

```text
/run-all
/approve
/deny
/modify
/mode fullauto
/confirm
```

## Pre-smoke evidence

Record only pass/fail values:

```text
preflight-no-secrets: pass|fail
telegram:dry-transport-smoke: pass|fail
test:telegram: pass|fail
local gates: pass|fail
working tree clean before smoke: yes|no
real-transport-guard: pass|fail
run_all_enabled before smoke: false|unexpected-true
```

## Real read-only smoke result

Run command:

```bash
npm run telegram:real-readonly-smoke
```

Report only this shape:

```text
real-readonly smoke:
- overall: pass|fail
- /ping response_kind: pong|unexpected|not-run
- /status response_kind: status|unexpected|not-run
- /policy response_kind: policy|unexpected|not-run
- output_contract.no_raw_update: true|false
- output_contract.no_raw_response_payload: true|false
- output_contract.no_private_ids: true|false
- response_preview_max_chars: 160|unexpected
- dry_run_telegram_send: false|unexpected-true
```

Do not paste raw JSON output if it contains any private values. Prefer the summarized fields above.

## Post-smoke evidence

Run:

```bash
npm run telegram:inspect-logs
git status
git diff
git diff --cached
```

Report only:

```text
post-smoke logs:
- shell completion events from read-only commands: none|present
- execution log unexpected writes: none|present
- audit log compact events: present|missing

repository state:
- working tree clean after smoke: yes|no
- git diff contains token or Telegram IDs: no|yes
- git diff --cached contains token or Telegram IDs: no|yes
```

## Cleanup evidence

Always run:

```bash
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
unset TELEGRAM_BOT_TOKEN
unset TELEGRAM_ALLOWED_USER_IDS
unset TELEGRAM_ALLOWED_CHAT_IDS
```

Then report:

```text
cleanup:
- RALPH_TELEGRAM_RUN_ALL_ENABLED unset: yes|no
- TELEGRAM_BOT_TOKEN unset: yes|no
- TELEGRAM_ALLOWED_USER_IDS unset: yes|no
- TELEGRAM_ALLOWED_CHAT_IDS unset: yes|no
```

## Decision

Use one of:

```text
decision: pass-readonly-smoke
decision: fail-readonly-smoke
decision: abort-readonly-smoke
```

A pass decision requires all of:

```text
preflight-no-secrets=pass
local gates=pass
working tree clean before smoke=yes
real-transport-guard=pass
run_all_enabled before smoke=false
/ping response_kind=pong
/status response_kind=status
/policy response_kind=policy
output_contract.no_raw_update=true
output_contract.no_raw_response_payload=true
output_contract.no_private_ids=true
shell completion events from read-only commands=none
working tree clean after smoke=yes
secrets committed=no
cleanup completed=yes
```

## Safe report body

Copy this body into a private issue comment, PR comment, or chat message only after replacing placeholders with non-secret pass/fail values:

```text
Phase 6 real read-only Telegram smoke report:

Pre-smoke:
- preflight-no-secrets: pass|fail
- telegram:dry-transport-smoke: pass|fail
- test:telegram: pass|fail
- local gates: pass|fail
- working tree clean before smoke: yes|no
- real-transport-guard: pass|fail
- run_all_enabled before smoke: false|unexpected-true

Real read-only smoke:
- overall: pass|fail
- /ping response_kind: pong|unexpected|not-run
- /status response_kind: status|unexpected|not-run
- /policy response_kind: policy|unexpected|not-run
- output_contract.no_raw_update: true|false
- output_contract.no_raw_response_payload: true|false
- output_contract.no_private_ids: true|false
- response_preview_max_chars: 160|unexpected
- dry_run_telegram_send: false|unexpected-true

Post-smoke:
- shell completion events from read-only commands: none|present
- execution log unexpected writes: none|present
- audit log compact events: present|missing
- working tree clean after smoke: yes|no
- git diff contains token or Telegram IDs: no|yes
- git diff --cached contains token or Telegram IDs: no|yes
- secrets committed: no|yes

Cleanup:
- run-all gate unset: yes|no
- bot token unset: yes|no
- allowed user ids unset: yes|no
- allowed chat ids unset: yes|no

Decision:
- decision: pass-readonly-smoke|fail-readonly-smoke|abort-readonly-smoke
```

## Report validator

Before posting or sharing the report, save only the safe report body to a local scratch file outside the repository or to an ignored temporary file, then run:

```bash
npm run telegram:validate-smoke-report -- <report-file>
```

Expected:

```json
{
  "ok": true,
  "findings": []
}
```

If the validator reports any finding, do not post the report. Remove private values or raw payloads, rerun the validator, and only share the report after it passes.

## Hard redaction rule

Before posting the report, verify the report body does not contain:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS
TELEGRAM_ALLOWED_CHAT_IDS
raw Telegram user ID
raw Telegram chat ID
bot token value
private bot URL
raw update payload
raw response_text
full audit log
full execution log
```

The report body must pass:

```bash
npm run telegram:validate-smoke-report -- <report-file>
```

## Deferred after this report

Still deferred:

- real default-off `/run-all` smoke
- explicit-gate real `/run-all` smoke
- GitHub Secrets storage for Telegram token
- CI job that calls Telegram Bot API
- CI job that performs gated `/run-all`
- production deploys from Telegram
- database migrations from Telegram
- OpenCode runtime execution from Telegram
