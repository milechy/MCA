# Telegram Phase 10 Unattended Daemon Readiness Preflight

Phase 10 prepares the safety boundary for a future unattended Telegram bot daemon.

This phase does **not** start an unattended daemon and does **not** authorize OpenCode execution, production deploys, database migrations, CI Telegram Bot API execution, persistent bot secrets, or shell allowlist expansion.

## Purpose

Before Telegram can be left running as an operator surface, the runtime must have explicit daemon-readiness controls:

```text
single instance guard
lock file ownership
health check
panic shutdown
rate limit
bounded polling
safe startup preflight
safe shutdown cleanup
log redaction boundary
operator-visible status
```

## Current execution boundary

The only currently proven real execution path remains:

```text
Telegram /run-all
→ explicit local session gate
→ fresh approved plan
→ scripts/gates/run-all.sh
```

The only allowed executable command remains:

```text
scripts/gates/run-all.sh
```

## Required daemon preflight controls

A future daemon must refuse to start unless all are true:

```text
repository working tree clean=yes
pre-secret-scan pass=yes
post-secret-scan pass=yes
Telegram transport env valid=yes
bot token redacted in all diagnostics=yes
allowed user ids configured=yes
allowed chat ids configured=yes
single instance lock acquired=yes
lock file belongs to current process=yes
health check endpoint or command available=yes
panic shutdown command available=yes
rate limit configured=yes
polling interval bounded=yes
run-all explicit gate default-off=yes
OpenCode execution disabled=yes
production deploy disabled=yes
database migration disabled=yes
CI Telegram Bot API disabled=yes
```

## Required daemon runtime invariants

```text
only one daemon instance active
unknown commands never reach execution
unauthorized users/chats never reach execution
/policy remains read-only
/status remains read-only
/run-all remains default-off unless explicit local session gate is true
all execution still requires approval/hash/diff/allowlist preflight
commands_executed contains only scripts/gates/run-all.sh
files_modified is reported and incident-triggered if non-empty
logs remain bounded and redacted
```

## Required shutdown behavior

A daemon shutdown must:

```text
release lock file
unset or forget in-memory Telegram token
stop polling
flush bounded audit summary
not delete incident evidence
not mutate repository files
not leave RALPH_TELEGRAM_RUN_ALL_ENABLED=true
```

## Panic shutdown triggers

Immediate shutdown is required if:

```text
authorization failure reaches execution boundary
unknown command reaches execution boundary
command other than scripts/gates/run-all.sh attempts execution
multiple commands are requested from one Telegram command
files_modified is non-empty after Telegram execution
response redaction validator fails
token-like value appears in output
raw Telegram payload appears in output
OpenCode execution is requested
production deploy or database migration is requested
```

## OpenCode boundary

OpenCode remains disabled in Phase 10.

OpenCode may be introduced only after daemon readiness is green, and only in a dry-run planning phase first:

```text
Phase 11: OpenCode dry-run bridge
  allowed: intent capture, plan generation, risk evaluation, diff preview metadata
  forbidden: file modification, command execution, commit, push, deploy, migration

Phase 12: OpenCode local sandbox execution
  allowed: isolated tmp workspace or sandbox branch only
  forbidden: production deploy, migration, direct main branch writes, unattended apply

Phase 13: approved OpenCode patch apply
  allowed: human-approved patch apply after diff hash verification and tests
  forbidden: automatic merge, production deploy, unreviewed migration
```

## Exit criteria

Phase 10 is complete when:

```text
Phase 10 readiness document exists=yes
daemon preflight helper exists=yes
single instance lock behavior tested=yes
panic shutdown criteria documented=yes
runbook links Phase 10 boundary=yes
drift tests protect OpenCode disabled boundary=yes
npm run test:telegram passes=yes
./scripts/gates/run-all.sh passes=yes
working tree clean=yes
```

## Explicit non-goals

```text
No unattended bot daemon start
No OpenCode execution from Telegram
No production deploy from Telegram
No database migration from Telegram
No CI Telegram Bot API execution
No persistent bot token in repository or CI
No persistent RALPH_TELEGRAM_RUN_ALL_ENABLED=true
No shell allowlist expansion
No automatic code modification
```
