# Runbook: Drain Pending Approvals After Overnight Soak

## Purpose
Inspect and approve queued DIFF, COMMIT, PUSH, and PR approvals generated during an overnight approval-mode soak test.

## Prerequisites
- Access to the approval queue/dashboard
- Soak test configuration and expected output summary

## Steps

### 1. Identify Pending Approvals
Open the approval queue and filter for approvals created during the soak window (overnight). Note the count of pending items by type: DIFF, COMMIT, PUSH, PR.

### 2. Inspect Approval Details
For each pending approval, open the detail view and verify:
- **Source branch / commit range** matches the soak test targets.
- **Author / actor** is the soak service account or expected automation identity.
- **Description / title** contains soak-related identifiers (e.g., `soak-`, `overnight-`, ticket IDs).

### 3. Validate Against Soak Expectations
Cross-check the pending changes with the soak test plan:
- Confirm the number of pending approvals aligns with expected soak volume.
- Verify no unexpected repositories or branches are included.
- If a diff is available, spot-check that file changes are consistent with soak scenarios.

### 4. Approve Legitimate Operations
For approvals that pass validation:
- Select all verified items in the queue.
- Apply bulk approval, or approve individually if the queue requires per-item review.
- Record approval timestamps and counts for the soak report.

### 5. Reject or Escalate Anomalies
If any approval fails validation (unexpected repo, unknown actor, suspicious diff):
- **Do not approve.**
- Reject the approval and document the reason.
- Escalate to the soak owner or security team for investigation.

### 6. Verify Queue Drain and Close Out
After all items are processed:
- Confirm the approval queue shows **zero pending** items for the soak window.
- Run any post-approval health checks (e.g., CI status, branch synchronization).
- Record final metrics and mark the soak test complete.

## Post-Run
Archive this runbook alongside soak results. If anomalies were found, attach escalation tickets to the soak test record.
