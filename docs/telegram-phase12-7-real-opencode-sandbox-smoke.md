# Telegram Phase 12.7 Real OpenCode Sandbox Smoke

Phase 12.7 introduces the first boundary for a real OpenCode process smoke inside an isolated local sandbox.

This phase does **not** authorize patch apply to the repository, commits, pushes, deploys, migrations, production secret access, or unattended operation.

## Purpose

Phase 12.7 validates that the system can start a real OpenCode-compatible process only when all safety gates pass, and only inside the approved sandbox root.

The required flow is:

```text
Phase 12.5 sandbox runner preflight passes
→ explicit local-session env gate RALPH_OPENCODE_SANDBOX_ENABLED=true
→ OpenCode binary/path discovery passes
→ process cwd is .ralph/tmp/opencode-sandbox/<approval_id>/
→ mandatory timeout
→ bounded stdout/stderr capture
→ redacted output summary
→ no repository source file modification
→ no commit
→ no push
→ no deploy
→ no migration
→ post-run repository git status clean
```

## Current implementation boundary

Allowed:

```text
real process smoke command under sandbox cwd
bounded stdout/stderr summary
redacted process metadata
sandbox-local output only
post-run invariant verification
```

Forbidden:

```text
OpenCode patch apply to repository
repository source file modification
commit
push
deploy
database migration
production secret access
unbounded process output
unbounded runtime
unattended daemon execution
```

## Required explicit gate

The real process smoke requires a local-session-only gate:

```bash
export RALPH_OPENCODE_SANDBOX_ENABLED=true
```

This value must not be stored in repository files, CI, shell profiles, launch agents, or daemon configuration.

## Binary/path discovery

The OpenCode command must be discovered from a bounded allowlist or explicit local test override.

Allowed smoke command forms:

```text
opencode --version
node <repo-local-test-double> --version
```

Any command with shell metacharacters, path traversal, extra arguments, deploy verbs, migration verbs, write/apply verbs, or repository-root cwd must be rejected.

## Output contract

The process smoke result must include only bounded metadata:

```text
ok
stage
reason
runner
approval_id
sandbox_root
cwd
command_preview
exit_code
started_at
finished_at
duration_ms
timeout_ms
stdout_preview
stderr_preview
stdout_length
stderr_length
execution_connected=true
opencode_execution_started=true
real_opencode_process_started=true
commands_executed=[bounded command preview]
files_modified=[]
repository_files_modified=[]
commit_created=false
push_performed=false
deploy_performed=false
migration_performed=false
post_git_status_clean=true
next_action
```

## Redaction contract

The smoke result must not include:

```text
raw environment
raw Telegram update
raw prompt transcript
raw tool output
full stdout
full stderr
secret-looking token values
private bot URL
raw user/chat ids
```

## Incident triggers

Treat any of the following as an incident:

```text
process cwd is not the sandbox root
process starts without explicit env gate
process starts without passing preflight
process exceeds timeout
process output is unbounded
stdout/stderr contains secret-looking values
repository git status becomes dirty
commit is created
push is performed
deploy is performed
migration is performed
```

## Exit criteria

```text
Phase 12.7 document exists=yes
real process smoke helper exists=yes
helper refuses failed preflight=yes
helper refuses missing env gate=yes
helper refuses unsafe command=yes
helper runs only in sandbox cwd=yes
helper bounds and redacts stdout/stderr=yes
helper reports no repository file modification=yes
helper reports no commit/push/deploy/migration=yes
Telegram tests pass=yes
local gates pass=yes
working tree clean after cleanup=yes
```

## Explicit non-goals

```text
No patch apply to repository
No repository source file modification
No commit
No push
No production deploy
No database migration
No production secret access
No unattended bot daemon execution
No direct main branch write
No shell allowlist expansion beyond the real OpenCode smoke command
```
