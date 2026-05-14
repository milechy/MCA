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
