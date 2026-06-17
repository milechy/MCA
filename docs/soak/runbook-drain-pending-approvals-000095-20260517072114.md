# Runbook: Drain Pending Approvals (Post-Soak)

## Purpose
Drain the backlog of DIFF, COMMIT, PUSH, and PR approvals that accumulated during an overnight approval-mode soak test.

## When to Use
- Morning after an overnight soak where the execution provider ran in `approval` mode.
- The soak generated a queue of pending approvals that must be reviewed and released before normal CI/CD can resume.

## Prerequisites
- Access to the approval queue (e.g., UI, CLI, or notification channel used during the soak).
- Maintainer / approver privileges for the repository under test.
- The soak test artifacts and logs are retained for reference.

## Step-by-Step Procedure

### 1. Inventory Pending Approvals
1. Open the approval queue and filter by the soak start/end timestamps.
2. Tally the counts per category:
   - **DIFF** – code diffs awaiting human review.
   - **COMMIT** – proposed commits not yet pushed.
   - **PUSH** – branch pushes awaiting release.
   - **PR** – pull requests pending merge.
3. Record the totals in a scratch pad; this becomes your drain checklist.

### 2. Inspect DIFF Approvals
1. For each pending DIFF, open the diff view.
2. Verify no unexpected code changes, secrets, or build artifacts leaked into the diff.
3. If the diff matches the expected soak behavior:
   - Click **Approve** (or run the equivalent CLI command).
   - If it deviates, reject and attach a note with the soak log snippet for triage.

### 3. Inspect COMMIT Approvals
1. Review the commit messages and changed files for each queued COMMIT.
2. Cross-check the commit hash against the soak execution log to confirm provenance.
3. Approve commits that are clean and expected; reject any that contain sensitive data or structural anomalies.

### 4. Inspect PUSH Approvals
1. Identify the target branch and the commit range for each PUSH request.
2. Verify the branch diff is a strict subset of the already-approved COMMITs from Step 3.
3. Approve the push if the subset check passes; otherwise reject and flag for investigation.

### 5. Inspect PR Approvals
1. Open each pending PR created during the soak.
2. Confirm CI checks (if any) completed with expected results (failures are acceptable if documented in the soak plan).
3. Review the PR description for soak metadata (test ID, duration, provider version).
4. Approve and merge PRs that meet criteria; close or reject any that do not.

### 6. Validate Drain Completeness
1. Re-run the approval queue query used in Step 1.
2. Confirm the counts for DIFF, COMMIT, PUSH, and PR are all zero.
3. If any items remain, return to the relevant step above.
4. Once empty, update the soak log with a timestamped note: `Approvals drained, queue cleared.`

## Exit Criteria
- Approval queue shows zero pending items across all four categories.
- Any rejected items have been moved to a triage issue or log for post-soak analysis.
- The repository is ready to resume normal automated CI/CD flows.
