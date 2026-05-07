# Telegram Phase 12 OpenCode Local Sandbox Execution Boundary

Phase 12 defines the boundary for future OpenCode local sandbox execution.

This phase does **not** authorize production deploys, database migrations, direct main-branch writes, commit, push, automatic patch apply, unattended operation, or production secret access.

## Purpose

Phase 12 moves beyond Phase 11 metadata-only planning by defining the minimum controls required before OpenCode may run in a local sandbox.

The intended future path is:

```text
Telegram /opencode-plan
→ metadata-only plan
→ approval for sandbox attempt
→ isolated sandbox workspace or sandbox branch
→ OpenCode generates candidate diff
→ bounded diff summary
→ no apply to main
→ no commit
→ no push
```

## Current implementation boundary

At the start of Phase 12, Telegram still must not invoke an OpenCode process.

Allowed now:

```text
sandbox execution plan metadata
sandbox workspace path proposal
sandbox branch name proposal
risk classification
expected test command summary
approval requirement
```

Forbidden now:

```text
OpenCode process execution
file modification
patch apply
commit
push
deploy
database migration
production secret access
unattended execution
```

## Future sandbox execution requirements

Before any actual OpenCode sandbox execution is enabled, all of the following must be true:

```text
working tree clean=yes
current branch is not main=yes
sandbox branch or tmp workspace selected=yes
sandbox path is under .ralph/tmp/opencode-sandbox/=yes
approval exists=yes
approval not expired=yes
plan hash matches=yes
diff hash baseline recorded=yes
forbidden paths blocked=yes
secret scan before execution passes=yes
secret scan after execution passes=yes
commands_executed summary bounded=yes
files_modified summary bounded=yes
no commit created=yes
no push performed=yes
no deploy performed=yes
no migration performed=yes
```

## Sandbox path boundary

Allowed sandbox roots:

```text
.ralph/tmp/opencode-sandbox/<approval_id>/
```

Forbidden sandbox roots:

```text
/
~
.
..
.git/
node_modules/
.env
.env.*
.ralph/logs/
.ralph/approval-log.jsonl
```

## Allowed output shape

Any Phase 12 sandbox planner must return only bounded metadata:

```text
ok
stage
approval_id
intent_summary
sandbox_root
sandbox_branch
risk
requires_approval
allowed_paths
forbidden_paths
expected_tests
execution_connected=false
opencode_execution_enabled=false
commands_executed=[]
files_modified=[]
commit_created=false
push_performed=false
deploy_performed=false
migration_performed=false
next_action
```

## Incident triggers

Treat any of the following as an incident:

```text
OpenCode process runs before explicit Phase 12 execution approval
sandbox path escapes .ralph/tmp/opencode-sandbox/
file modification occurs outside sandbox
commit is created
push is performed
deploy is performed
migration is performed
secret-like value appears in output
raw OpenCode transcript appears in output
raw tool output appears in output
files_modified is unbounded or includes forbidden path
```

## Handoff to Phase 13

Phase 13 may introduce approved patch apply only after Phase 12 proves:

```text
sandbox plan is safe and bounded
sandbox execution cannot escape allowed root
candidate diff can be summarized without raw sensitive output
forbidden paths are blocked
secret scans pass before and after sandbox
approval and hash verification are stable
local gates pass
working tree clean after cleanup
```

## Explicit non-goals

```text
No direct main branch write
No automatic patch apply
No commit
No push
No production deploy
No database migration
No production secret access
No unattended bot daemon execution
No OpenCode execution outside sandbox
No shell allowlist expansion
```
