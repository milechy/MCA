# Soak Harness Pilot Run — 2026-05-14

Status: pilot complete, harness validated end-to-end. Phase 1 #6.

This is the validation soak that proves the supplier + harness infrastructure introduced in Phase 1 #6 actually drives the autonomous loop end-to-end. It is **not** the Phase 1 #7 24-hour saturated soak — that is a separate, longer exercise that uses this same harness.

## Setup

```
branch:          claude/phase1-06-soak-harness (this PR)
trunk:           infra/phase0-autonomous-foundation @ 6feddd4 (after PR #53 merge)
host:            darwin 25.0.0 (operator's Mac)
docker:          running (supabase-local gate passes)
dispatcher:      default since ADR-2026-05-14 (OpenCode + Kimi K2.6 via OpenRouter)
mode:            approval (stories park at PLAN/DIFF approval rather than auto-progress)
harness command:
  scripts/ralph/soak-harness.sh start \
    --duration-hours 0 \
    --rate-per-hour 60 \
    --supplier-max-stories 6 \
    --mode approval \
    --interval-ms 30000
```

## Result

| Metric | Value |
|---|---|
| Wall clock | ~15 min (2026-05-14T06:30:17Z → 2026-05-14T06:45:31Z) |
| Supplier emits | 6 / 6 |
| Stories reaching `DIFF_APPROVAL_PENDING` | 6 / 6 = **100 %** |
| Candidate patches written | 6 / 6 |
| `git apply --check` clean (visual inspection of sample) | yes |
| Escalations / failures | **0** |
| Worktree leaks (`git worktree list` outside the two expected entries) | **0** |
| `.ralph/` disk usage at end | 572 KB |
| Estimated cost (~$0.007 / story × 6) | **~$0.04** |

## Two operational findings (already merged in this PR)

### Finding 1: working_tree_dirty blocks the harness if any uncommitted change exists

The very first pilot launch — with the supplier/harness/runbook files freshly written but uncommitted — produced 8 cycles of `to_phase: ESCALATED / reason: working_tree_dirty` and 0 candidate patches before the loop spun down. The sandbox preflight (`src/telegram/opencode-sandbox-preflight.js`) calls `git status --porcelain`; any untracked or modified file under the worktree counts.

**Mitigation already in place**: `docs/soak-harness-runbook.md` lists "git status --porcelain → empty" as a precondition for both the 4 h pilot and the 24 h overnight run.

### Finding 2: `.ralph/soak/` was not gitignored

The supplier-state file (`.ralph/soak/supplier-state.json`), pid files, daemon/supplier logs, and the harness wrapper scripts live under `.ralph/soak/`. That directory was not in `.gitignore`, so as soon as the harness launched it created the directory and the preflight treated it as `working_tree_dirty` — exactly the same symptom as Finding 1, but caused by the harness itself rather than the operator.

**Fix in this PR**: `.gitignore` now has `.ralph/soak/*` alongside the existing `.ralph/tmp/*`, `.ralph/sandboxes/*`, `.ralph/external-agent-jobs/*`, `.ralph/stories/*`, `.ralph/approval-pending/*`, `.ralph/approval-log.jsonl`, `.ralph/mode.json`, `.ralph/state.json`, `.ralph/roles.json`, `.ralph/telegram-offset.json`, `.ralph/opencode-jobs/*`. After the gitignore commit the v3 pilot ran clean: 6/6 patches in ~15 min wall clock.

## Sample of a generated patch (one of six)

```
diff --git a/docs/soak/glossary-fullauto-window-000005.md b/docs/soak/glossary-fullauto-window-000005.md
new file mode 100644
index 0000000..91e3086
--- /dev/null
+++ b/docs/soak/glossary-fullauto-window-000005.md
@@ -0,0 +1,3 @@
+# Fullauto Window
+
+The fullauto window is a scheduled period during which an admin can automatically apply approved soak-test changes without requiring manual confirmation for each individual step. Before the window begins, an admin must explicitly confirm the list of pending changes, either through the web dashboard or via the CLI. The default duration of a fullauto window is `DEFAULT_FULLAUTO_HOURS=6`, providing a standard half-day automation cycle. For safety, the maximum allowed length of any single fullauto window is capped at `MAX_FULLAUTO_HOURS=24`, preventing runaway automation. If the window expires while operations are still pending, the system reverts to manual confirmation mode until a new window is requested.
```

Notes:
- The patch is well-formed (passes the requested-paths validator), single-file, in the `docs/soak/` namespace as requested by the supplier.
- Kimi K2.6 followed the prompt: 4-6 sentence definition, references the real constants `DEFAULT_FULLAUTO_HOURS=6` and `MAX_FULLAUTO_HOURS=24` from `src/ralph/mode-manager.js`, and matches the operational semantics documented in PR #50.

## Stability observations (~15 min window, do not generalize to 24 h)

1. **No daemon crash.** Both processes ran continuously from start to clean stop.
2. **Worktree teardown clean.** Every per-story `.ralph/sandboxes/<story_id>/worktree` was created and removed within a single dispatch. `git worktree list` shows only the two expected entries (main repo + this checkout).
3. **No `.ralph/` disk growth surprise.** 572 KB at end is in line with the Phase 0 24-story soak's 536 KB.
4. **Approval-mode parking works as designed.** All 6 stories reached `DIFF_APPROVAL_PENDING` and stopped, waiting for `/approve`. None of them were auto-approved (correct — fullauto was not enabled).
5. **Dispatcher contract holds at scale.** None of the 6 patches included `candidate.patch`, `candidate.diff`, or `.opencode/` artefacts (PR #46 fix). None modified files outside `requested_paths` (PR #45/#46 fix). None tripped the post-secret-scan gate.
6. **Supplier-state persistence works.** The supplier state file recorded `seq: 6` at exit; a restart would resume at seq 6 rather than collide on story id.

## What this pilot does NOT prove

- **24 h endurance.** 15 min is too short to surface slow leaks, memory creep, OpenRouter rate-limit behaviour at scale, or fullauto window expiry behaviour.
- **Fullauto end-to-end.** This pilot ran in approval mode; the fullauto auto-approver was not exercised in this run (its end-to-end behaviour was already shown in PR #50).
- **Cost trajectory across an actual 24 h spend.** Extrapolation predicts ~$5 for 720 stories at 30/h, but real OpenRouter pricing fluctuations and Kimi K2.6 latency variance need a real run to confirm.
- **Recovery from `attempts → ESCALATED` under sustained provider failure.** Would need a deliberate Kimi outage to test.

These are exactly the questions Phase 1 #7 (the actual 24 h saturated soak using this harness) will answer.

## How to reproduce

```bash
# 1. From a clean working tree (git status --porcelain → empty)
git checkout infra/phase0-autonomous-foundation

# 2. Confirm env has OPENROUTER_API_KEY
cat /Users/<you>/MCA/.env | grep -c OPENROUTER_API_KEY     # → 1

# 3. Start the harness
scripts/ralph/soak-harness.sh start \
  --duration-hours 0 \
  --rate-per-hour 60 \
  --supplier-max-stories 6 \
  --mode approval \
  --interval-ms 30000

# 4. Watch progress
scripts/ralph/soak-harness.sh status
scripts/ralph/soak-harness.sh tail daemon

# 5. After supplier hits its max, stop the daemon
scripts/ralph/soak-harness.sh stop

# 6. Inspect
node -e "console.table(require('./src/ralph/story-queue').listStories({rootDir:process.cwd(),limit:20}).map(s=>({id:s.story_id,phase:s.current_phase,patch:!!s.current_candidate_patch_path})))"
find .ralph/tmp -name candidate.patch
```
