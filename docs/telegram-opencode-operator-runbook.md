# Telegram OpenCode Operator Runbook

This runbook documents the controlled Telegram-to-OpenCode development flow.

## Principle

OpenCode is allowed to generate a candidate patch in a sandbox only. The authority chain remains:

```text
Telegram authorization
Ralph approval records
sandbox preflight
candidate.patch preview
separate apply approval
local gates
separate commit approval
separate push approval
separate PR approval
```

OpenCode does not decide whether to apply, commit, push, create a PR, merge, deploy, or migrate.

## Required local gates

Run before OpenCode operation:

```bash
npm run test:telegram
./scripts/gates/run-all.sh
git status
```

Expected:

```text
telegram-tests passed
all local gates passed
nothing to commit, working tree clean
```

## Real OpenCode smoke

Run:

```bash
npm run telegram:real-opencode-smoke
git status
```

Expected evidence:

```text
ok=true
stage=real_opencode_operational_smoke
real_opencode_process_started=true
execution_connected=true
candidate_patch_path=.ralph/tmp/opencode-sandbox/<approval_id>/candidate.patch
patch_preview.ok=true
patch_preview.requires_approval=true
patch_preview.blocked_paths=[]
working_tree_clean_before=true
working_tree_clean_after=true
commit_created=false
push_performed=false
pr_created=false
merge_performed=false
deploy_performed=false
migration_performed=false
nothing to commit, working tree clean
```

Adapter-only fallback:

```bash
RALPH_OPENCODE_SMOKE_TEST_DOUBLE=true npm run telegram:real-opencode-smoke
```

## Command sequence

```text
/opencode-sandbox-plan <approval_id> <intent...>
/opencode-sandbox-preflight <approval_id> <sandbox_root> <requested_path...>
/opencode-run <approval_id> <sandbox_root> <task...>
/opencode-patch-preview <approval_id> <sandbox_root> <candidate_patch_path>
/opencode-patch-approval <approval_id> <sandbox_root> <candidate_patch_path> [patch_approval_id]
/approve <patch_approval_id>
/opencode-apply-preflight <patch_approval_id> <patch_hash>
/opencode-apply <patch_approval_id> <patch_hash>
/opencode-gates <patch_approval_id> <patch_hash>
/opencode-commit-approval <patch_approval_id> <patch_hash> <commit_message...>
/approve <commit_approval_id>
/opencode-commit <commit_approval_id>
/opencode-push-approval <commit_sha> <branch> <remote>
/approve <push_approval_id>
/opencode-push <push_approval_id>
/opencode-pr-approval <commit_sha> <head_branch> <base_branch> <title...>
/approve <pr_approval_id>
/opencode-pr <pr_approval_id>
```

## Visibility and control

```text
/opencode-status [job_id]
/opencode-abort <job_id>
/opencode-artifact <job_id> <candidate_patch|stdout|stderr> [artifact_path]
```

Artifact retrieval is bounded and redacted. Raw full logs must not be returned in Telegram.

## Cleanup

```bash
unset RALPH_OPENCODE_SANDBOX_ENABLED
git restore .ralph/approval-log.jsonl 2>/dev/null || true
git status
```

Expected:

```text
nothing to commit, working tree clean
```

## Hard non-goals

```text
No unrestricted shell
No production secrets
No merge from Telegram
No deploy from Telegram
No migration from Telegram
No OpenCode-initiated commit
No OpenCode-initiated push
No OpenCode-initiated PR creation
No approval bypass
No local gate bypass
```

## External agent gateway boundary

NemoClaw, OpenClaw-style gateways, and future external agent gateways are adapter candidates only. They may be considered only under the boundary documented in:

```text
docs/opencode-external-agent-gateway-boundary.md
```

No external gateway runtime dependency is approved without a separate approval issue.
