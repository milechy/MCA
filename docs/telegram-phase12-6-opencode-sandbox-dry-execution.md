# Telegram Phase 12.6 OpenCode Sandbox Dry Execution

Phase 12.6 introduces an isolated sandbox runner using a test double, not the real OpenCode process.

This phase proves the runner contract before real OpenCode execution is allowed.

## Purpose

The purpose of Phase 12.6 is to verify that a sandbox runner can:

```text
require Phase 12.5 preflight pass
write only inside .ralph/tmp/opencode-sandbox/<approval_id>/
produce bounded metadata
report sandbox-local files_modified
avoid repository source modifications
avoid commit
avoid push
avoid deploy
avoid migration
avoid production secrets
```

## Current implementation boundary

Allowed:

```text
fake OpenCode runner execution
sandbox-local summary file write
bounded dry-run result metadata
preflight pass/fail enforcement
```

Forbidden:

```text
real OpenCode process execution
repository source file modification
patch apply
commit
push
deploy
database migration
production secret access
unattended execution
```

## Runner output shape

```text
ok
stage
reason
runner
approval_id
sandbox_root
started_at
finished_at
duration_ms
preflight_ok
opencode_execution_started=false
real_opencode_process_started=false
commands_executed=[]
files_modified=[sandbox-local summary file only]
repository_files_modified=[]
commit_created=false
push_performed=false
deploy_performed=false
migration_performed=false
next_action
```

## Required invariant

Even on success:

```text
real_opencode_process_started=false
commands_executed=[]
repository_files_modified=[]
commit_created=false
push_performed=false
deploy_performed=false
migration_performed=false
```

The only allowed file modification is a sandbox-local summary file:

```text
.ralph/tmp/opencode-sandbox/<approval_id>/dry-run-summary.json
```

## Exit criteria

```text
Phase 12.6 document exists=yes
fake sandbox runner helper exists=yes
runner refuses failed preflight=yes
runner writes only sandbox-local summary=yes
runner reports no real OpenCode process=yes
runner reports no commit/push/deploy/migration=yes
Telegram tests pass=yes
local gates pass=yes
working tree clean after cleanup=yes
```

## Explicit non-goals

```text
No real OpenCode process execution
No repository source file modification
No patch apply
No commit
No push
No production deploy
No database migration
No production secret access
No unattended bot daemon execution
No direct main branch write
No shell allowlist expansion
```
