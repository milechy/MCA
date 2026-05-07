# Telegram Phase 11 OpenCode Dry-run Bridge

Phase 11 introduces the first Telegram-to-OpenCode bridge boundary.

This phase does **not** authorize OpenCode command execution, file modification, patch apply, commit, push, deploy, database migration, production secret access, or unattended operation.

## Purpose

The purpose of Phase 11 is to allow Telegram to capture a development intent and convert it into a safe, reviewable OpenCode planning artifact.

Allowed outputs are metadata only:

```text
intent summary
operator request summary
proposed plan
risk evaluation
proposed file/path summary
expected test command summary
diff preview metadata placeholder
approval requirement
next action
```

No file content is changed during Phase 11.

## Allowed Telegram-facing shape

A future OpenCode dry-run command may accept an operator request such as:

```text
/opencode-plan <short development intent>
```

The command must return a bounded plan summary only. It must not run OpenCode or mutate files.

Allowed response fields:

```text
ok
stage
intent_summary
risk
requires_approval
allowed_paths
forbidden_paths
proposed_steps
expected_tests
execution_connected=false
files_modified=[]
commands_executed=[]
next_action
```

## Forbidden behavior

Phase 11 forbids:

```text
OpenCode process execution
shell command execution
file modification
patch apply
commit
push
deploy
database migration
production secret access
main branch direct writes
long-running background jobs
unattended daemon execution
```

## Required safety invariants

```text
execution_connected=false
telegram_shell_execution_connected=false
commands_executed=[]
files_modified=[]
OpenCode runtime not invoked
no raw prompt transcript in report
no raw tool output in report
no secret env values in report
bounded response length
risk evaluation required
approval required before any future apply
```

## Risk boundary

OpenCode planning is higher risk than `/policy` and lower risk than shell execution.

Phase 11 plans must be classified as:

```text
read-only planning
no execution
no mutation
approval-required-before-apply
```

Any request involving the following must be marked blocked or escalated:

```text
production deploy
migration execution
secret handling
credential rotation
remote shell
package publishing
payment or billing changes
security-sensitive auth changes without human review
```

## Allowed path metadata

The dry-run bridge may mention proposed paths, but must not read or rewrite arbitrary private data.

Default allowed planning paths:

```text
docs/**
scripts/**
tests/**
lib/**
src/**
package.json
```

Default forbidden planning paths:

```text
.env
.env.*
*.pem
*.key
*.p12
.ralph/logs/**
.ralph/approval-log.jsonl
node_modules/**
.git/**
```

## Handoff to Phase 12

Phase 12 may introduce sandboxed OpenCode execution only after Phase 11 proves:

```text
OpenCode dry-run command is non-mutating
risk evaluation is stable
response is bounded and redacted
forbidden requests are blocked
drift tests protect no-execution boundary
local gates pass
working tree clean
```

## Exit criteria

Phase 11 is complete when:

```text
OpenCode dry-run bridge document exists=yes
dry-run bridge helper exists=yes
helper returns metadata only=yes
helper refuses execution and mutation=yes
Telegram tests protect no-execution boundary=yes
smoke report validator rejects raw prompt/tool payloads=yes
npm run test:telegram passes=yes
./scripts/gates/run-all.sh passes=yes
working tree clean=yes
```

## Explicit non-goals

```text
No OpenCode process execution
No file modification
No patch apply
No commit
No push
No production deploy
No database migration
No production secret access
No unattended bot daemon execution
No direct main branch write
No automatic code modification
```
