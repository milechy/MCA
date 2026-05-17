# Runbook: Drain Pending Approvals After Overnight Soak

**Purpose:** Inspect and approve the backlog of DIFF/COMMIT/PUSH/PR approvals generated during an overnight approval-mode soak test.

## Prerequisites
- Access to the approval queue / soak dashboard for run `000055` (timestamp: `2026-05-17 07:21:14 UTC`).
- Appropriate permissions to approve/reject pending operations.

---

## Step 1 – Open the Soak Approval Dashboard
1. Navigate to the soak run dashboard for the overnight session.
2. Filter the view to show only **Pending** approvals for the completed soak run.
3. Note the total count of parked approvals and the breakdown by type: **DIFF**, **COMMIT**, **PUSH**, and **PR**.

## Step 2 – Triage Pending Approvals by Type
1. Review each pending approval queue in order of risk:
   - **DIFF** – lowest risk; inspect for unexpected file changes.
   - **COMMIT** – verify the staged changes match the expected soak test mutations.
   - **PUSH** – confirm the target branch and remote repository are correct.
   - **PR** – validate title, body, and linked issue references.
2. Flag any approval that looks suspicious or unrelated to the soak test for deeper inspection before proceeding.

## Step 3 – Batch-Approve DIFF and COMMIT
1. Select all remaining **DIFF** approvals that passed triage.
2. Approve them in the dashboard (or via the CLI) and wait for the status to transition to `Approved`/`Succeeded`.
3. Repeat for all **COMMIT** approvals.
4. Confirm no DIFF or COMMIT approvals remain in the `Pending` state.

## Step 4 – Review and Approve PUSH
1. Inspect each **PUSH** approval to ensure the destination branch is not a protected production branch.
2. Approve all safe PUSH operations.
3. Verify that pushes complete successfully and no errors appear in the soak logs.

## Step 5 – Review and Approve PR
1. Inspect each **PR** approval for correct base/compare branches and meaningful description.
2. Approve all safe PR operations.
3. Confirm that PRs are opened (or merged, if configured) and links are recorded in the soak run summary.

## Step 6 – Verify Drain and Close Out
1. Refresh the dashboard and confirm the **Pending** count is zero across all approval types.
2. Export or screenshot the final approval summary for the soak run record.
3. Mark the soak run as **completed** and archive any associated temporary branches or tags if required by your retention policy.

---

## Post-Run Checklist
- [ ] Zero pending approvals remain in the dashboard.
- [ ] All approvals are logged with timestamp and approver identity.
- [ ] Any rejected or flagged approvals have follow-up tickets created.
- [ ] Soak run artifact is stored in the designated archive location.
