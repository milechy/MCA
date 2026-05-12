# Ralph lifecycle / deterministic fallback test plan

This branch adds focused support for GitHub Issues #32 and #33.

## Focused tests

Run the new targeted test set first:

```bash
npm run test:ralph:lifecycle
```

This runs:

```text
tests/ralph/deterministic-candidate-patch-fallback.spec.js
tests/ralph/autonomous-loop-wired.spec.js
```

Expected coverage:

```text
OPENCODE_RUNNING provider failure -> deterministic fallback -> PATCH_PREVIEW
fallback candidate.patch stays sandbox-only and requires later diff approval
ineligible fallback remains on retry/escalation path
COMMIT -> PUSH_APPROVAL_PENDING with push approval metadata
PUSH_APPROVAL_PENDING -> PUSH after approval
PUSH -> PR_APPROVAL_PENDING with PR approval metadata
PR_APPROVAL_PENDING -> PR after approval
PR -> DONE after PR creation
```

## Broader regression tests

After the focused tests pass, run the existing Ralph suite:

```bash
npm run test:ralph
```

Then run Telegram coverage that exercises the underlying OpenCode approval helpers:

```bash
npm run test:telegram
```

## Local safety gate

When available, run the repository gate script:

```bash
./scripts/gates/run-all.sh
```

## Manual smoke shape

A bounded local/manual smoke should show this story phase progression:

```text
PLAN
OPENCODE_RUNNING
PATCH_PREVIEW
DIFF_APPROVAL_PENDING
APPLY
GATES
COMMIT_APPROVAL_PENDING
COMMIT
PUSH_APPROVAL_PENDING
PUSH
PR_APPROVAL_PENDING
PR
DONE
```

The smoke must not perform push or PR creation without approved approval records. In live mode, real push and PR creation also require working GitHub credentials and the existing helper preflights to pass.

## Invariants to inspect in output

```text
fallback patch_source == deterministic_fallback
fallback writes only .ralph/tmp/.../candidate.patch
fallback repository_files_modified == []
apply_allowed == false until separate diff approval/apply path
push_allowed == true only inside approved PUSH execution
pr_allowed == true only inside approved PR execution
merge_allowed == false
deploy_allowed == false
migration_allowed == false
commands_executed are bounded
stdout/stderr previews are bounded
```

## Known implementation note

The branch uses `src/ralph/autonomous-loop-wired.js` as a wrapper around the existing `src/ralph/autonomous-loop.js` because the base loop file is large and was not safely patchable in the connector-only environment. `src/ralph/autonomous-scheduler.js` now calls `tickAutonomousLoopWired`, so scheduled autonomous operation uses the wired path.
