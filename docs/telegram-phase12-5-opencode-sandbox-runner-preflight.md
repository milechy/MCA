# Telegram Phase 12.5 OpenCode Sandbox Runner Preflight

Phase 12.5 adds the preflight contract for a future actual OpenCode local sandbox runner.

This phase does **not** execute OpenCode. It only determines whether a future sandbox run would be allowed to start.

## Purpose

Before OpenCode can be executed in any local sandbox, the system must prove a deterministic, fail-closed preflight.

The preflight checks:

```text
sandbox root is allowed
sandbox root is inside .ralph/tmp/opencode-sandbox/
sandbox root is not repository root
sandbox root is not absolute path
working tree is clean
current branch is not main or master
approval exists
approval is approved
approval is not expired
requested paths are within allowed planning paths
requested paths do not include forbidden paths
pre-secret-scan passed
OpenCode execution env gate is explicit true only when intentionally enabled
commit/push/deploy/migration are disabled
```

## Current implementation boundary

Allowed in Phase 12.5:

```text
preflight metadata
start_allowed boolean
fail-closed reason
bounded requested path summary
bounded sandbox root summary
approval id summary
next action
```

Forbidden in Phase 12.5:

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

## Future execution gate

Future sandbox execution may only be enabled by a separate explicit local-session env gate:

```bash
export RALPH_OPENCODE_SANDBOX_ENABLED=true
```

This gate must remain unset by default and must not be stored in repository files, CI, shell profiles, launch agents, or daemon configuration.

## Preflight output shape

```text
ok
stage
reason
start_allowed
approval_id
sandbox_root
branch
working_tree_clean
opencode_sandbox_enabled
requested_paths
blocked_paths
pre_secret_scan_ok
execution_connected=false
opencode_execution_started=false
commands_executed=[]
files_modified=[]
commit_created=false
push_performed=false
deploy_performed=false
migration_performed=false
next_action
```

## Fail-closed reasons

```text
approval_id_required
approval_missing
approval_not_approved
approval_expired
sandbox_root_invalid
sandbox_root_not_allowed
working_tree_dirty
branch_not_allowed
requested_path_forbidden
pre_secret_scan_failed
opencode_sandbox_env_not_enabled
```

## Required non-execution invariant

Even when every preflight check passes, Phase 12.5 must return:

```text
execution_connected=false
opencode_execution_started=false
commands_executed=[]
files_modified=[]
```

Actual OpenCode execution is deferred to Phase 12.6.

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
No shell allowlist expansion
```
