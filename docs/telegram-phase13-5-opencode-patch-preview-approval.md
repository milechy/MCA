# Telegram Phase 13.5 OpenCode Patch Preview Approval Object

Phase 13.5 records an OpenCode candidate patch preview as a record-only approval object.

This phase does **not** apply a patch. It only persists the preview metadata, patch hash, risk, and required future verification fields in `.ralph/approval-pending/`.

## Purpose

Phase 13.5 ensures that any future apply phase cannot proceed from an ephemeral preview alone.

The required flow is:

```text
Phase 13 candidate patch preview passes
→ patch hash is calculated from sandbox-local candidate.patch bytes
→ approval object is written to .ralph/approval-pending/<approval_id>.json
→ approval status starts as pending
→ approval type is diff
→ requested action is opencode_candidate_patch_apply
→ apply remains disabled
→ execution remains disconnected
→ future apply must verify approval id, patch hash, plan hash, and pre-apply diff hash
```

## Approval object requirements

The approval object must include:

```text
approval_id
approval_type=diff
status=pending
requested_action=opencode_candidate_patch_apply
story_id
risk
plan_hash
patch_hash
candidate_patch_path
sandbox_root
files_touched
blocked_paths
requires_approval=true
apply_allowed=false
execution_connected=false
future_apply_requires_patch_hash=true
future_apply_requires_pre_apply_diff_hash=true
commands_executed=[]
files_modified=[]
repository_files_modified=[]
commit_created=false
push_performed=false
deploy_performed=false
migration_performed=false
```

## Required invariant

Even after creating the approval object:

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

## Block conditions

Approval creation must fail closed when:

```text
candidate preview is missing
candidate preview failed
candidate preview is risk 5
candidate preview does not require approval
candidate patch path is not sandbox-local
candidate patch file is missing
candidate patch hash cannot be calculated
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
