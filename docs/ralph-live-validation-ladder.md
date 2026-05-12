# Ralph live validation ladder

This runbook supports staged validation for Ralph autonomous development after the deterministic issue-to-PR smoke is passing.

The goal is to move from local deterministic validation to live provider and live PR canaries without accidentally enabling broad production automation.

## Level 0: local deterministic smoke

Purpose: verify lifecycle routing without external provider, network, push, or PR side effects.

```bash
npm run ralph:issue-to-pr-smoke
```

Expected evidence:

```text
ok=true
final_story.current_phase=DONE
push_performed=false
pr_created=false
repository_files_modified=[]
```

## Level 1: live provider patch-only smoke

Purpose: validate live provider / NemoClaw candidate.patch generation while stopping before apply.

Required gate:

```bash
export RALPH_LIVE_VALIDATION_LEVEL=1
export RALPH_EXTERNAL_AGENT_RUNTIME_APPROVED=true
```

Suggested command:

```bash
RALPH_LIVE_VALIDATION_LEVEL=1 RALPH_EXTERNAL_AGENT_RUNTIME_APPROVED=true npm run ralph:real-external-agent-smoke
```

To write a bounded report at the same time:

```bash
RALPH_LIVE_VALIDATION_LEVEL=1 \
RALPH_EXTERNAL_AGENT_RUNTIME_APPROVED=true \
npm run ralph:real-external-agent-smoke -- --record-level 1 --json-out .ralph/live-validation/level-1-latest.json
```

Allowed side effects:

```text
provider call
sandbox candidate.patch under .ralph/tmp
```

Forbidden side effects:

```text
repository source modification
apply
commit
push
PR creation
merge
deploy
migration
```

Expected evidence:

```text
candidate_patch_path=.ralph/tmp/.../candidate.patch
working_tree_clean_after=true
apply_allowed=false
```

Blocked provider evidence:

```text
reason=provider_rate_limited
blocked=true
execution_connected=true
real_gateway_process_started=true
candidate_patch_path=null
apply_allowed=false
commit_created=false
push_performed=false
pr_created=false
working_tree_clean_after=true
next_action=retry_level_1_after_provider_recovers_or_record_blocked_outcome
```

Blocked runtime evidence:

```text
reason=nemoclaw_runtime_timeout
blocked=true
runtime_blocked=true
runtime_blocker_reason=nemoclaw_runtime_timeout
execution_connected=true
real_gateway_process_started=true
candidate_patch_path=null
apply_allowed=false
commit_created=false
push_performed=false
pr_created=false
working_tree_clean_after=true
next_action=retry_level_1_after_runtime_or_provider_recovers_or_record_blocked_outcome
```

If Level 1 returns a blocked provider or runtime outcome, do not proceed to Level 2. Record the blocker and retry later after provider quota, gateway, or sandbox availability recovers.

The real external agent smoke now cleans its own `.ralph/external-agent-jobs/...` and `.ralph/tmp/external-agent-smoke/...` artifacts unless `RALPH_EXTERNAL_AGENT_KEEP_RUNTIME_ARTIFACTS=true` is set.

## Recording validation results

Record an existing smoke JSON output:

```bash
node src/ralph/cli.js record-live-validation-result \
  --level 1 \
  --input /path/to/smoke.json \
  --output .ralph/live-validation/level-1-report.json
```

The saved report is bounded and redacted. For a blocked provider result it records:

```text
provider_blocked=true
provider_blocker_reason=provider_rate_limited
candidate_patch_available=false
safe_side_effects=true
decision=hold_before_level_2_provider_blocked
next_action=retry_level_1_after_provider_recovers
```

For a blocked runtime result it records:

```text
runtime_blocked=true
runtime_blocker_reason=nemoclaw_runtime_timeout
candidate_patch_available=false
safe_side_effects=true
decision=hold_before_level_2_runtime_blocked
next_action=retry_level_1_after_runtime_recovers
```

Reports must be written under `.ralph/live-validation/`.

## Level 2: live provider + apply/gates/commit, no push

Purpose: validate patch quality, apply path, gates, and local commit without remote push.

Required gate:

```bash
export RALPH_LIVE_VALIDATION_LEVEL=2
```

Operate only on a small `ralph-ready` sandbox issue. Approve only through commit approval. Stop before push approval.

Allowed side effects:

```text
provider call
repository apply
local gates
local commit
```

Forbidden side effects:

```text
git push
GitHub PR creation
merge
deploy
migration
```

Expected evidence:

```text
gates ok=true
commit_created=true
push_performed=false
pr_created=false
```

## Level 3: live push to test branch, no PR

Purpose: validate explicit push approval and remote test branch write.

Required gate:

```bash
export RALPH_LIVE_VALIDATION_LEVEL=3
```

Use only a sandbox branch prefix, such as:

```text
ralph/smoke-*
ralph/canary-*
```

Allowed side effects:

```text
provider call
repository apply
local commit
git push to test branch
```

Forbidden side effects:

```text
GitHub PR creation
merge
deploy
migration
```

Expected evidence:

```text
push_performed=true
remote branch created or updated
pr_created=false
```

## Level 4: live PR smoke to sandbox, no merge

Purpose: validate explicit PR approval and GitHub PR creation.

Required gate:

```bash
export RALPH_LIVE_VALIDATION_LEVEL=4
```

Use a sandbox issue / sandbox repo / `ralph-smoke` label. Do not merge automatically.

Allowed side effects:

```text
provider call
repository apply
local commit
git push to test branch
GitHub PR creation
```

Forbidden side effects:

```text
merge
deploy
migration
```

Expected evidence:

```text
pr_created=true
pr_url present
merge_performed=false
```

## Level 5: real issue canary batch

Purpose: run 3 to 10 bounded real issues and measure success rate, review burden, repair behavior, and failure taxonomy.

Required gate:

```bash
export RALPH_LIVE_VALIDATION_LEVEL=5
```

Recommended scope:

```text
label: ralph-ready
risk: low
paths: docs / tests / small bugfixes
max touched files: small
merge: human only
production DB / deploy / migration: prohibited
```

Track this evidence for each issue:

```text
issue number
requested paths
provider outcome
patch source
approval count
repair attempts
gates result
PR URL if created
human review outcome
failure reason if failed
```

Success criteria should be chosen before the batch. Example:

```text
>= 70% create acceptable PR without manual JSON edits
0 approval boundary bypasses
0 secret leaks
0 unrelated file modifications
0 unauthorized pushes
0 auto merges
```

## Helper command

Inspect the ladder as JSON:

```bash
npm run ralph:live-validation-ladder
```

Inspect one level and require its gate:

```bash
node scripts/ralph/live-validation-ladder.js --level 4 --json --assert-gate
```

Without `RALPH_LIVE_VALIDATION_LEVEL=4`, this exits non-zero.

## Cleanup commands

Use Issue #34 runtime operator commands to clean or reset stories:

```bash
node src/ralph/cli.js story-status STORY-*
node src/ralph/cli.js explain-runnable STORY-*
node src/ralph/cli.js cleanup-story-runtime STORY-*
node src/ralph/cli.js reset-story-runtime STORY-*
```

## Global non-goals

```text
No approval bypass
No raw logs
No secret printing
No production DB changes
No migrations
No deploys
No auto merge
No live push/PR without explicit gate and approval record
```
