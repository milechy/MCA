# Telegram Phase 5 Completion Checklist

This checklist summarizes the Phase 5 safety boundary before any operator runs a real Telegram Bot API read-only smoke.

Phase 5 is complete when the repository can prove that real Telegram read-only smoke is guarded, secret-safe, manually initiated, and still disconnected from CI secrets and real `/run-all` automation.

## Phase 5 completed scope

Phase 5 completed:

- manual real-smoke template with secrets-safe handoff
- no-secret preflight helper
- dry transport runtime smoke harness
- CI-safe dry transport integration
- real transport guard
- real read-only smoke runner skeleton
- real read-only smoke documentation and drift tests
- real read-only output redaction contract
- read-only go/no-go checklist

## Current repository commands

Safe CI/local commands:

```bash
npm run telegram:preflight-no-secrets
npm run telegram:check-env
npm run telegram:dry-transport-smoke
npm run telegram:ci-smoke
npm run test:telegram
npm run test:ralph
```

Manual-only commands requiring operator judgment:

```bash
npm run telegram:real-transport-guard
npm run telegram:real-readonly-smoke
```

`telegram:real-readonly-smoke` must remain manual-only and must not be added to CI unless a separate Phase explicitly adds Bot API CI with secrets isolation.

## Current CI boundary

CI may run:

```bash
npm run telegram:ci-smoke
npm run test:ralph
npm run test:telegram
```

CI must not use:

```text
TELEGRAM_BOT_TOKEN
secrets.TELEGRAM_BOT_TOKEN
RALPH_TELEGRAM_RUN_ALL_ENABLED=true
telegram:real-readonly-smoke
telegram:real-transport-guard
```

CI must not perform real Telegram Bot API calls or real `/run-all` execution.

## Real read-only smoke handoff

Before running real Bot API smoke, the operator must read:

```text
docs/telegram-phase5-manual-smoke-template.md
docs/telegram-phase5-readonly-go-no-go.md
```

The operator must set Telegram secrets only in the active shell session:

```bash
export TELEGRAM_BOT_TOKEN="<private bot token>"
export TELEGRAM_ALLOWED_USER_IDS="<authorized user ids>"
export TELEGRAM_ALLOWED_CHAT_IDS="<authorized chat ids>"
unset RALPH_TELEGRAM_RUN_ALL_ENABLED
```

Then the operator must run:

```bash
npm run telegram:preflight-no-secrets
npm run telegram:real-transport-guard
```

Only if both pass may the operator run:

```bash
npm run telegram:real-readonly-smoke
```

Allowed real read-only commands are exactly:

```text
/ping
/status
/policy
```

## Real read-only output contract

The real read-only smoke output must preserve:

```text
output_contract.no_raw_update=true
output_contract.no_raw_response_payload=true
output_contract.no_private_ids=true
response_preview_max_chars=160
```

It must not output:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_IDS
TELEGRAM_ALLOWED_CHAT_IDS
raw user id
raw chat id
raw update payload
raw response_text
full audit payload
full execution payload
```

## Hard deferred items

Still deferred after Phase 5 completion:

- real default-off `/run-all` smoke
- explicit-gate real `/run-all` smoke
- GitHub Secrets storage for Telegram token
- CI job that calls Telegram Bot API
- CI job that performs gated `/run-all`
- production deploys from Telegram
- database migrations from Telegram
- OpenCode runtime execution from Telegram
- multi-command shell allowlist expansion
- production incident automation

## Phase 5 done criteria

Run:

```bash
npm run telegram:ci-smoke
npm run test:telegram
./scripts/gates/run-all.sh
git status
```

Expected:

```text
telegram:ci-smoke passes
[telegram-tests] passed
[gate] all Phase 2 local gates passed
nothing to commit, working tree clean
```

## Final invariant

After Phase 5, the repository may support a manually initiated real Telegram read-only smoke, but it must not make real Telegram `/run-all` execution automatic, persistent, CI-triggered, or secret-backed.
