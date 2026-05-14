# Phase 1 #7 Saturated Soak Findings — 2026-05-15

Status: **partial success / three production bugs found**. Cost: well within budget. Operator-visible safety properties: intact. Three concrete fixes proposed below.

## Run summary

| Metric | Value |
|---|---|
| Branch / commit | `infra/phase0-autonomous-foundation` @ `b92816a` (post PR #54) |
| Mode | fullauto (admin-confirmed 24 h window) |
| Started | 2026-05-14T06:57:20Z |
| Stopped | 2026-05-14T21:04:28Z (operator stopped at ~14 h elapsed) |
| Supplier emits | 424 stories |
| Stories reaching `DIFF_APPROVAL_PENDING` or `DONE` | **1** (only the very first story made any progress) |
| Stories escalated (`working_tree_dirty`) | **89** visible / **761** `working_tree_dirty` events total |
| Kimi K2.6 dispatches (real LLM calls) | **1** (the rest failed at the sandbox preflight before dispatch) |
| Estimated Kimi cost | **~\$0.007** total |
| Disk usage at stop | 18 MB (mostly story JSON × 424 and daemon log) |
| `git status` at stop | one untracked file: `docs/soak/glossary-risk-score-000000.md` |

## What actually happened

```
T+0       supplier seeds STORY-...-000000 (glossary-risk-score)
T+1m      daemon dispatches; Kimi K2.6 generates patch (real LLM call #1)
T+1m      DIFF_APPROVAL_PENDING -> auto-approved (fullauto)
T+1m      APPLY ok -> docs/soak/glossary-risk-score-000000.md appears in repo (untracked)
T+1m      GATES runs scripts/gates/run-all.sh
T+1m      pre-secret-scan flags two false positives in OUR OWN repo:
            - scripts/ralph/soak-story-supplier.js:62  (template text)
            - tests/ralph/resume-after-security-stop.spec.js:61 (redactRationale fixture)
T+1m      repair-strategy classifies secret_scan as immediate_escalation_required
T+1m      Story 0 -> ESCALATED. Status: failed. blocked_reason: immediate_escalation_required
          last_apply.ok: true (so the file is still in the repo)
          last_gate_failure.failed_gate: null (gate-runner did not attach a name)

T+1m+     Next 423 stories enter OPENCODE_RUNNING -> sandbox-preflight runs
          git status --porcelain  ->  ?? docs/soak/glossary-risk-score-000000.md
          preflight rejects with working_tree_dirty
          Each story burns max_attempts=2 worth of preflight checks then escalates

T+~14h    Operator stops. 1 PR. 0 commits. 89+ failed stories. 1 dispatch.
```

The system **was running** the whole time — daemon cycles: 845, supplier emits: 424. The supplier behavior was healthy. The escalation guard worked correctly. **But the loop got stuck because the first story's APPLY left an orphan untracked file that no subsequent dispatch could clear.**

## Three concrete bugs

### Bug A — `pre-secret-scan` false-positives on our own source

The pre-secret-scan gate runs over the whole repo, not just the diff. Two existing files trip it:

1. **`scripts/ralph/soak-story-supplier.js:62`** — the line `['risk-score', 'Glossary: risk score', 'Define the Ralph risk score (0..5) ...']` was matched because of literal substrings that look like keys. (The gate's stdout preview shows it was the `risk-score` template text.)
2. **`tests/ralph/resume-after-security-stop.spec.js:61`** — the line `redactRationale('investigation reveals leak: api_key=sk-or-v1-deadbeef...')` is the **input** to a redaction test. The gate scanner cannot tell that this is a test fixture intentionally containing the pattern that the redactor strips.

**Fix:**
- Make secret-scan ignore lines flagged with a `// NOSCAN-FIXTURE` comment on the line above (lowest blast radius).
- Alternatively, add a per-file allow-list anchored on `tests/ralph/resume-after-security-stop.spec.js` and `scripts/ralph/soak-story-supplier.js`.
- And/or restructure those two specific lines to express the test fixture without the literal trigger pattern (rewrite `'sk-or-v1-...'` as `'sk' + '-or-v1-' + 'deadbeef...'`).

**Recommended:** the `// NOSCAN-FIXTURE` annotation. It is explicit at the call site, narrowly scoped, and review-friendly. (`secret-scan.sh` would skip the single annotated line.)

### Bug B — `repair-strategy` correctly routes `secret_scan` to immediate ESCALATED **but APPLY is never rolled back**

`repair-strategy.js` classifies `secret_scan`, `production_db`, `rls_disable`, and `migration` as immediate escalation by design — and that is correct safety behavior (PR #51 + earlier ADRs).

The problem: when the autonomous loop transitions a story from `GATES` to `ESCALATED`, it does **not** roll back the changes made in the `APPLY` step. The applied file stays in the working tree, untracked. Every subsequent dispatch fails preflight with `working_tree_dirty` until an operator manually cleans up.

This is a **production-grade liveness bug**: a single immediate-escalation failure cascades into total loop deadlock. PR #45's `attempts → ESCALATED` guard moves the individual story off the runnable queue, but it cannot fix the polluted working tree.

**Fix:** when `GATES` -> `ESCALATED` (and analogously when `APPLY` -> `ESCALATED` after partial apply), reset the working tree to the pre-apply state:

```
git checkout -- <repository_files_modified from last_apply_result>
git clean -fd <repository_files_modified directories>   # for new files
```

Bounded to **only the paths the last APPLY actually touched**, with strict regex validation on each path, so this rollback is itself policy-safe. Audit it. Add a test that drives a story into escalated-after-apply and confirms the working tree is clean afterwards.

### Bug C — `gate-runner` does not attach `failed_gate` to the failure summary

`last_gate_failure_summary.failed_gate: null` is unhelpful for triage. The stdout preview contains enough information to root-cause the failure (it shows `[gate] start: pre-secret-scan ... [secret-scan] potential secret detected ...`), but a structured `failed_gate: 'pre-secret-scan'` would let the dashboard and the audit log surface the failure name without parsing the preview.

**Fix:** in `gate-runner.js` / `scripts/gates/run-all.sh`, capture the gate name and propagate it into the wired loop's failure summary. Cheap and high-signal.

## Operator-visible properties that DID hold

- **Cost stayed near zero.** Only 1 real Kimi dispatch (~\$0.007). Every other story failed at preflight *before* the dispatcher was called, so OpenRouter usage was minimal. The "burn provider tokens on retry" failure mode is correctly prevented by the preflight gate.
- **Safety policy: no commits, no pushes, no PRs.** Zero commits during 14 h. Zero PRs. Zero pushes. The only repo mutation was the single untracked file from APPLY before the escalation halted further progress.
- **PLAN_APPROVAL_PENDING gating works.** 10 stories whose `requirement` text contained `policy` / `risk evaluator stays conservative` / `weekly Kimi cost check` / etc. correctly halted at PLAN_APPROVAL_PENDING (Risk Evaluator's substring scan triggered), and the fullauto auto-approver correctly refused to auto-approve PLAN approvals (PR #50 regression test holds at scale).
- **Supplier runs forever.** 424 emits over 14 h matches the configured 30 / h rate exactly. Sequence counter stayed monotonic. No duplicate story ids. Restart-safe.
- **Worktree leak: 0.** `git worktree list` after stop shows only the two expected entries.
- **Daemon stayed alive.** 845 cycles emitted JSON status with no crash, no OOM, no hang.
- **`attempts → ESCALATED` guard works.** Every escalated story has `attempts: 1` or `2` (`max_attempts=2`), so each story took at most 2 wasted dispatches.

## What the bugs do NOT invalidate

The four lower-numbered Phase 1 items (#1 fullchain, #2 fullauto, #3 RESUME, #4 Telegram surface) still hold. Each was validated end-to-end against a single story; the soak revealed a class of issues that only show up under **continuous flow against a transient safety failure**, which is exactly what a soak is for.

## Cost summary

| Line item | Amount |
|---|---|
| Kimi K2.6 inference (1 successful dispatch) | ~\$0.007 |
| Wasted preflight churn (424 stories × ~30 ms each) | \$0 (no LLM tokens) |
| Total | **~\$0.007** |

For comparison, the design budget for a 24 h run at 30 / h was ~\$5. The actual spend was 0.14% of budget — the system spent essentially nothing because it failed safe.

## Recommendation

Open a follow-up PR with all three fixes (Bug A, B, C). After merge, re-run a **6 h compressed soak** in fullauto mode and confirm:

- At least 80 % of stories reach `DONE` (real commits + real PRs).
- 0 immediate-escalation cascades.
- `failed_gate` is populated on any GATES failure.
- After any ESCALATED story, the working tree returns to clean.

If that 6 h re-run is clean, schedule the actual 24 h Phase 1 #7 (round 2) on a subsequent operator-chosen overnight slot.

## Audit / reproduction artefacts

The soak's daemon logs, supplier logs, story state files, and applied-patch artefacts have been archived to `/tmp/phase1-7-soak-archive/` (15 MB) for post-mortem. They include:

- `daemon.log` — 845 cycle JSON status objects.
- `supplier.log` — 424 emit_ok events.
- `stories/` — 424 story JSON files with full audit trails.
- `tmp/opencode-sandbox/APR-OPENCODE-AUTO-SOAK-...-000000/candidate.patch` — the one real Kimi K2.6 output that made it through dispatch (well-formed, single-file, references real `mode-manager.js` constants).

These are intentionally left **out** of git for operator privacy and disk reasons.

---

## Addendum (2026-05-14T22:00 — same day re-run after bug fixes)

After landing Bug A / B / C fixes on this same branch, a **15 min compressed re-run** (`--supplier-max-stories 12 --rate-per-hour 90 --mode fullauto`) was driven to validate them. Numbers below are from `.ralph/soak/daemon.log` and `.ralph/soak/supplier.log` of the second run.

### Validation of A / B / C

| Bug | Validation | Result |
|---|---|---|
| **A: secret-scan false positives** | `pre-secret-scan` no longer flags the supplier template slug or the redactor test fixture on a clean tree | **PASS**. Re-run cycle 1 had `pre-secret-scan: passed`. A `gates_passed` event fired for the first patch within 4 minutes of soak start. |
| **B: APPLY rollback on GATES → ESCALATED** | When `gates → ESCALATED` fires, `last_apply_rollback` is recorded on the story and the working tree returns to clean | **PASS for the gates path**. Across the 11 stories that eventually escalated, no `working_tree_dirty` event surfaced **from the gates escalation path**. (See Bug D below for the path that did surface working_tree_dirty events.) |
| **C: `failed_gate` name** | `story.last_gate_failure_summary.failed_gate` is populated with the kebab-case sub-gate name on every gate failure | **PASS**. The first iteration of the re-run (before the NOSCAN-FIXTURE self-annotation follow-up commit) reported `failed_gate: pre-secret-scan` on every ESCALATED story, exactly as designed. After the follow-up commit, gates pass and the field is `null` on success — the field is now meaningful, not always-null. |

### Bug D — newly surfaced under parallel load

The re-run reached the post-`APPLY` half of the pipeline for the first time, which exposed a new failure path the original 14 h soak never reached:

- `--supplier-max-stories 12 --rate-per-hour 90` floods the daemon with 12 ready stories within 8 minutes.
- The daemon's `--limit 25` (the harness default) makes the scheduler dispatch all of them within a single cycle.
- Each story's `APPLY` writes its `docs/soak/<slug>.md` straight into the **real repository working tree** (the dispatcher's worktree isolation only protects the LLM run, not `APPLY`).
- When story A's auto-approved `COMMIT_APPROVAL_PENDING` advances to `COMMIT`, the working tree already contains the as-yet-uncommitted files from stories B–L. `git commit -- <A's path>` then fails with `git_commit_failed` because git refuses the commit (or commits the wrong file set, depending on the wrapper).
- The story escalates with `blocked_reason: git_commit_failed`. Crucially this is **not** the `repair.escalation_required` path that Bug B's rollback hooks into, so the applied file stays in the working tree.
- 11 of 12 stories cascaded through this failure. 9 candidate patches were generated, 8 files remained `??` untracked in the working tree at stop time.

`failed_gate` stayed `null` for these (commit is not a gate), `last_apply_rollback` is absent (rollback is gates-escalation-only), and the leftover untracked files would have tripped the next batch's preflight if the supplier had continued.

### Recommended fix for Bug D (separate PR)

Either:

1. **Per-story APPLY worktree.** Promote the dispatcher's git-worktree-per-story isolation up the pipeline so that `APPLY` also writes into a per-story worktree, not the real repo. `COMMIT` would then run inside that worktree, and the merge back into trunk is a separate explicit step. This is the clean architectural fix.
2. **Serialize APPLY → COMMIT.** Force the daemon to dispatch only one story past `APPLY` at a time (a mutex on the real working tree). Simple, but caps throughput.
3. **Extend Bug B's rollback hook.** Add the same rollback step to `advanceCommitPhase`'s failure paths. Cheap, but only recovers — does not prevent the collision.

This PR (Phase 1 #7) intentionally **does not include Bug D's fix**. The three bugs that were diagnosed from the original 14 h log are scoped, fixed, and tested. Bug D requires architectural choice (between options 1 / 2 / 3) and is best handled in its own PR with its own ADR.

### Updated recommendation

Open Phase 1 #7 PR with the **three fixes already on this branch** plus this addendum. Schedule **Bug D as Phase 1 #8**, choose the per-story APPLY worktree route (option 1), and run a second 6 h compressed re-run after merging Phase 1 #8. Only after that re-run is clean should the **actual 24 h saturated run** be scheduled.

Status of the current branch:

```
fa7de92  Phase 1 #7: 3 bug fixes + 23 unit tests + findings from 14h soak run
089f76a  Phase 1 #7 follow-up: annotate synthetic sk-* string literals inside the secret-scan test itself
```

Suites: 356 ralph + 271 telegram = 627 passed.

