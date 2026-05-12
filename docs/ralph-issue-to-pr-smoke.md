# Ralph issue-to-PR smoke gate

Issue #35 adds a deterministic local smoke for Ralph's autonomous issue-to-PR lifecycle.

The default smoke does not call live providers, GitHub APIs, `git push`, or PR creation. It uses a fixture story and simulated push/PR runners to verify lifecycle routing and dashboard reporting.

## Run the fixture smoke

```bash
npm run ralph:issue-to-pr-smoke
```

Equivalent direct command:

```bash
node scripts/ralph/autonomous-issue-to-pr-smoke.js --fixture
```

Expected output is bounded JSON with:

```text
ok=true
stage=ralph_issue_to_pr_smoke
mode=fixture
final_story.status=completed
final_story.current_phase=DONE
push_performed=false
pr_created=false
repository_files_modified=[]
raw_logs_included=false
secrets_included=false
```

## Covered transitions

The fixture smoke records these labels in order:

```text
issue_imported
plan_approved_opencode_running
candidate_patch_ready
diff_approved_apply
gates_passed
commit_approved
push_approval_pending
push_resumed
pr_approval_pending
pr_resumed
pr_created_done
```

These labels are intended to catch regressions in approval routing, candidate patch recovery, push/PR boundary handling, and dashboard counts.

## Stop points

Use `--stop-at` for bounded debugging:

```bash
node scripts/ralph/autonomous-issue-to-pr-smoke.js --fixture --stop-at patch-preview
node scripts/ralph/autonomous-issue-to-pr-smoke.js --fixture --stop-at commit
node scripts/ralph/autonomous-issue-to-pr-smoke.js --fixture --stop-at push
node scripts/ralph/autonomous-issue-to-pr-smoke.js --fixture --stop-at pr
node scripts/ralph/autonomous-issue-to-pr-smoke.js --fixture --stop-at done
```

Stop mode returns `ok=true` with `reason=stopped_at_<phase>` when the expected stop point is reached.

## Live mode guard

`--github-live` is intentionally refused unless explicitly gated:

```bash
RALPH_E2E_SMOKE_GITHUB_LIVE=1 node scripts/ralph/autonomous-issue-to-pr-smoke.js --github-live
```

The current implementation still reports live mode as unsupported by default. This prevents accidental live provider calls, pushes, or PR creation while preserving an explicit future gate location.

## Gate integration

The smoke is included in local gates through:

```bash
bash scripts/gates/ralph-issue-to-pr-smoke.sh
./scripts/gates/run-all.sh
```

## Safety invariants

```text
No live provider calls in fixture mode
No GitHub network calls in fixture mode
No git push in fixture mode
No real PR creation in fixture mode
No merge/deploy/migration
No raw logs
No secrets
Bounded machine-readable JSON
Repository source files not modified
```
