# Ralph runtime operator commands

Issue #34 adds safe CLI commands for story inspection, runnable explanation, candidate patch resume, and per-story runtime cleanup.

All commands emit bounded JSON and should not print raw logs or secrets.

## Inspect story state

```bash
node src/ralph/cli.js story-status STORY-GH-27
```

Use this before manual recovery to inspect the current phase, approval/job IDs, candidate patch path, sandbox root, retry state, and bounded runtime metadata.

## Explain runnable state

```bash
node src/ralph/cli.js explain-runnable STORY-GH-27
```

This explains whether the scheduler can pick up the story. Common blockers include terminal phases and active `retry_after_at` backoff.

## Resume with an externally seeded candidate.patch

```bash
node src/ralph/cli.js resume-with-candidate-patch STORY-GH-27 .ralph/tmp/opencode-sandbox/APR-.../candidate.patch
```

The command validates that:

```text
candidate.patch is under .ralph/tmp/
candidate.patch exists
candidate.patch is a unified git diff
candidate.patch includes diff --git headers
```

On success it updates only the story runtime metadata:

```text
status=running
current_phase=PATCH_PREVIEW
current_candidate_patch_path=<path>
current_sandbox_root=<candidate.patch dir>
retry_after_at=null
blocked_reason=null
patch_source=operator_seeded_candidate_patch
```

It does not apply, commit, push, create PRs, merge, deploy, or migrate.

## Cleanup one story runtime

```bash
node src/ralph/cli.js cleanup-story-runtime STORY-GH-27
```

Default cleanup removes only runtime artifacts associated with that story:

```text
current external-agent job record
current sandbox directory
```

It does not delete the story file or approval record by default.

Optional flags:

```bash
node src/ralph/cli.js cleanup-story-runtime STORY-GH-27 --include-approval
node src/ralph/cli.js cleanup-story-runtime STORY-GH-27 --include-story
```

These flags are explicit because approval and story deletion are more destructive.

## Reset one story runtime for rerun

```bash
node src/ralph/cli.js reset-story-runtime STORY-GH-27
```

This cleans runtime artifacts, preserves the story file, and resets runtime metadata so the story can be planned again:

```text
status=queued
current_phase=PLAN
current_approval_id=null
current_job_id=null
current_plan_hash=null
current_patch_hash=null
current_candidate_patch_path=null
current_sandbox_root=null
blocked_reason=null
retry_after_at=null
patch_source=null
```

Use `--no-cleanup` to reset metadata without deleting associated sandbox/job artifacts:

```bash
node src/ralph/cli.js reset-story-runtime STORY-GH-27 --no-cleanup
```

## Safety invariants

```text
No repository source file modifications
No unrelated approval deletion
No unrelated job deletion
No unrelated sandbox deletion
No raw logs
No secret display
No apply/commit/push/PR/merge/deploy/migration side effects
```

## Suggested recovery flow

```bash
node src/ralph/cli.js story-status STORY-GH-27
node src/ralph/cli.js explain-runnable STORY-GH-27
node src/ralph/cli.js resume-with-candidate-patch STORY-GH-27 .ralph/tmp/opencode-sandbox/APR-.../candidate.patch
node src/ralph/cli.js story-status STORY-GH-27
```

Expected post-resume next action:

```text
preview_candidate_patch_and_decide_apply
```
