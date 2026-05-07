# Telegram Phase 13 OpenCode Candidate Patch Preview

Phase 13 introduces candidate patch preview for OpenCode output.

This phase does **not** apply patches to the repository. It only parses, bounds, classifies, and summarizes candidate diffs produced in the isolated sandbox.

## Purpose

Phase 13 allows the system to review a candidate patch before any repository mutation is possible.

The required flow is:

```text
Phase 12.7 real process smoke boundary exists
→ candidate diff is read from sandbox-local file
→ candidate diff is bounded
→ candidate diff is checked for forbidden paths
→ candidate diff is classified by risk
→ approval requirement is produced
→ no patch apply
→ no repository source modification
→ no commit
→ no push
→ no deploy
→ no migration
```

## Allowed input

Candidate patch input must be sandbox-local only:

```text
.ralph/tmp/opencode-sandbox/<approval_id>/candidate.patch
```

No repository-root diff files, absolute paths, path traversal, private directories, `.env`, migration files, production config, or secret-bearing files are allowed.

## Output contract

```text
ok
stage
reason
approval_id
sandbox_root
candidate_patch_path
diff_bytes
diff_preview
files_touched
blocked_paths
risk
requires_approval
apply_allowed=false
execution_connected=false
commands_executed=[]
files_modified=[]
repository_files_modified=[]
commit_created=false
push_performed=false
deploy_performed=false
migration_performed=false
next_action
```

## Risk classification

```text
risk 0: no candidate patch or docs/tests only
risk 1: source-only local code change preview
risk 2: package or configuration preview
risk 3: security-sensitive application paths
risk 4: database, auth, infra, or workflow preview
risk 5: secret, production deploy, destructive, or path escape preview
```

Risk 5 must be blocked.

All non-empty candidate patches require explicit approval before any future apply phase.

## Required invariant

Even on success:

```text
apply_allowed=false
execution_connected=false
commands_executed=[]
files_modified=[]
repository_files_modified=[]
commit_created=false
push_performed=false
deploy_performed=false
migration_performed=false
```

## Explicit non-goals

```text
No patch apply
No repository source file modification
No commit
No push
No production deploy
No database migration
No production secret access
No unattended bot daemon execution
No direct main branch write
No shell allowlist expansion
```
