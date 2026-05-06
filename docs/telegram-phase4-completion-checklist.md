# Telegram Phase 4 Completion Checklist

This checklist summarizes the Phase 4 readiness boundary for Telegram bot smoke, CI-safe validation, and deferred production execution.

## Phase 4 completed scope

Phase 4 completed the following safety and readiness work:

- real Telegram bot smoke plan
- Telegram smoke helper scripts
- helper direct tests
- default-off smoke CLI tests
- npm scripts for smoke helpers
- CI-safe GitHub Actions skeleton
- operator smoke and abort runbook
- runbook drift prevention tests

## Current safe CI boundary

The CI workflow is intentionally default-off.

CI may run:

```bash
npm run telegram:check-env || true
npm run telegram:inspect-logs
npm run test:ralph
npm run test:telegram
```

CI must not set:

```bash
RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

CI must not reference:

```text
TELEGRAM_BOT_TOKEN
secrets.TELEGRAM_BOT_TOKEN
```

CI must not directly execute:

```bash
scripts/gates/run-all.sh
```

Real run-all execution remains limited to the approved Telegram runtime path guarded by authorization, approval, hashes, command allowlist, shell execution policy, and the explicit environment gate.

## Manual smoke readiness

Manual Telegram bot smoke is ready when the following are true:

1. Local gates pass.
2. The operator has a private Telegram bot token.
3. The operator knows the authorized Telegram user id and chat id.
4. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, and `TELEGRAM_ALLOWED_CHAT_IDS` are set only in the active shell session.
5. `RALPH_TELEGRAM_RUN_ALL_ENABLED` is unset for initial smoke stages.
6. The operator has read `docs/telegram-bot-operator-runbook.md`.

## Required pre-smoke commands

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

## Manual smoke sequence

Follow the operator runbook in this order:

1. Read-only transport smoke: `/ping`, `/status`, `/policy`
2. Default-off `/run-all` smoke with `RALPH_TELEGRAM_RUN_ALL_ENABLED` unset
3. Unsafe input smoke
4. Explicit-gate real `/run-all` smoke only after stages 1-3 pass
5. Cleanup and unset all Telegram/session execution environment variables

## Immediate abort triggers

Abort immediately if any of the following occur:

- unauthorized user/chat reaches execution
- `/policy` writes shell completion events
- unsafe `/run-all` path reaches execution
- `/run-all` executes while `RALPH_TELEGRAM_RUN_ALL_ENABLED` is unset or not exactly `true`
- response text exposes raw stdout, execution preflight internals, command preflight internals, or full shell policy internals
- `files_modified` is non-empty
- command executed is anything other than `scripts/gates/run-all.sh`

## Phase 4 done criteria

Phase 4 is complete when:

```bash
npm run test:telegram
./scripts/gates/run-all.sh
git status
```

returns:

```text
[telegram-tests] passed
[gate] all Phase 2 local gates passed
nothing to commit, working tree clean
```

## Deferred to Phase 5+

The following remain intentionally deferred:

- real Telegram bot token storage in GitHub secrets
- isolated CI smoke chat/user allowlist
- CI job that talks to Telegram Bot API
- CI job that performs real gated `/run-all`
- production deploys from Telegram
- database migrations from Telegram
- OpenCode runtime execution from Telegram
- multi-command shell allowlist expansion
- production observability dashboards
- incident-response automation

## Safety invariant

The permanent invariant after Phase 4 is:

```text
No repository, CI workflow, npm script, or document should make real Telegram `/run-all` execution persistent or automatic.
```

Real execution requires a deliberate operator action in a scoped shell session:

```bash
export RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

and still must pass the authorization, approval, hash, command allowlist, and shell execution policy gates.
