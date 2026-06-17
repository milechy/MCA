# Runbook: Drain Pending Approvals After Overnight Soak

**Scope:** Inspect and approve parked DIFF/COMMIT/PUSH/PR approvals following an overnight approval-mode soak.

---

## 1. List Pending Parked Approvals

Query the soak system to enumerate all approvals stuck in the `PENDING` state after the overnight soak.

```bash
# Example command; adapt to your soak CLI/dashboard
soak approvals list --status=PENDING --since="yesterday" --types=DIFF,COMMIT,PUSH,PR
```

Record the approval IDs and their types. Confirm that each item is associated with the current soak run.

## 2. Inspect Artifacts for Each Approval

For every pending approval, open the corresponding artifact and verify its contents.

| Approval Type | Artifact to Review | What to Check |
|---------------|-------------------|---------------|
| DIFF          | Generated diff / patch | Correct files changed; no unexpected diffs |
| COMMIT        | Commit log / proposed commit message | Coherent message; correct author and scope |
| PUSH          | Target branch / commit range | Branch and HEAD match the soak run |
| PR            | Pull request details | Title, body, and linked issues are accurate |

If any artifact looks incorrect or unrelated to the soak, escalate before approving.

## 3. Verify Overnight Soak Health Signals

Before approving, confirm that the soak environment remained healthy while these approvals were parked.

- Check soak logs for critical errors or stalls during the overnight window.
- Review monitoring dashboards for regressions in key metrics (e.g., error rates, latency).
- Confirm no active alerts are linked to the pending changes.

If health signals are red, **do not approve** until the issue is resolved.

## 4. Approve Verified Approvals

For each healthy and verified approval, issue an explicit approval.

```bash
# Approve by type and ID
soak approvals approve --id <APPROVAL_ID> --type <TYPE>
```

- Approve DIFF and COMMIT approvals first if the pipeline requires them in sequence.
- Then approve PUSH and PR approvals.

If approving via a web UI, ensure the approval state transitions to `APPROVED` and is recorded with your identity.

## 5. Monitor Post-Approval Pipeline

After approvals are granted, verify that the pipeline executes successfully.

1. Watch the CI/CD pipeline for the newly approved items.
2. Confirm that the associated jobs (test, build, deploy) pass.
3. Check that approvals clear from the pending queue.
4. Validate that the system reaches a stable state once the soak run completes.

If any job fails or an approval re-enters the pending queue, investigate and repeat Steps 2–4 as needed.

---

**End of runbook**
