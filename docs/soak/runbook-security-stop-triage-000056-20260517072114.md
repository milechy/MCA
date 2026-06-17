# Runbook: Security Stop Triage

> **Runbook ID:** `runbook-security-stop-triage-000056-20260517072114`  
> **Purpose:** Investigate a `STOPPED_SECURITY` story and decide whether to **resume** or **formally close** it.  
> **Applies to:** Stories halted by automated security signals, manual security review flags, or vulnerability scan blockers.

---

## Step 1 – Confirm the Stop Reason and Scope

| Action | Details |
|--------|---------|
| 1.1 | Open the story ticket and locate the exact `STOPPED_SECURITY` annotation (timestamp, runner, rule ID). |
| 1.2 | Identify which artefact(s) triggered the stop: commit hash, container image tag, dependency manifest, or infrastructure drift report. |
| 1.3 | Record the **blast radius**: repos, environments, and downstream consumers affected. |
| 1.4 | Check linked Slack/Teams alerts or SIEM notifications for additional context. |

**Output:** A one-paragraph summary in the story comments describing *what* stopped the story, *when*, and *where* it propagates.

---

## Step 2 – Reproduce and Validate the Security Signal

| Action | Details |
|--------|---------|
| 2.1 | Re-run the same security scanner (SAST/DAST/SCA/secret-scan) against the flagged artefact in an isolated workspace. |
| 2.2 | Compare results against the **latest allow-list / suppression file** (`.snyk`, `.trivyignore`, `grype.yaml`, etc.) to rule out false positives already documented. |
| 2.3 | If the signal is **reproducible**, capture the raw JSON/SARIF output and attach it to the story. |
| 2.4 | If the signal is **not reproducible**, mark it as *transient / false positive* and proceed to Step 4 with a *resume* recommendation. |

**Output:** A pass/fail verdict with scanner logs attached.

---

## Step 3 – Assess Risk and Remediation Cost

| Action | Details |
|--------|---------|
| 3.1 | Map the finding to **OWASP Top 10**, **CWE**, or internal severity matrix (Critical / High / Medium / Low). |
| 3.2 | Determine whether a patch, configuration change, or architectural fix is required. |
| 3.3 | Estimate engineering effort (hours) and target date for remediation. |
| 3.4 | Consult the security champion or on-call security engineer if severity is **Critical** or **High**. |

**Decision gate:**
- **Fixable within Sprint** → Go to Step 4 (Resume with security task).
- **Requires major refactor / external dependency** → Go to Step 5 (Formal closure with risk acceptance).
- **No actual vulnerability (false positive)** → Go to Step 4 (Resume).

**Output:** Risk rating and chosen path documented in the story.

---

## Step 4 – Resume the Story

| Action | Details |
|--------|---------|
| 4.1 | Create a child task or sub-story for the security fix, linked to the blocker that caused the stop. |
| 4.2 | Update the story status from `STOPPED_SECURITY` to `IN_PROGRESS` (or equivalent workflow state). |
| 4.3 | Add the security fix to the **Definition of Done** checklist for this story. |
| 4.4 | Schedule a post-merge verification scan in CI/CD to prevent regression. |
| 4.5 | Notify the product owner and the original reporter that work has resumed. |

**Output:** Story is active, security task is tracked, and stakeholders are informed.

---

## Step 5 – Formally Close the Story

> Use this step only when the story will **not** be resumed (risk accepted, duplicated, obsolete, or false positive confirmed after Step 2).

| Action | Details |
|--------|---------|
| 5.1 | Write a **closure rationale** in the story comments: why the risk is accepted, which alternative controls exist, or why the finding is invalid. |
| 5.2 | Obtain sign-off from the **security champion** or **AppSec lead** (mandatory for Critical/High findings). |
| 5.3 | Attach any compensating controls (WAF rule, network segmentation, monitoring alert) that mitigate the accepted risk. |
| 5.4 | Transition the story to `CLOSED_SECURITY` (or equivalent terminal state) and tag it `wont-fix` or `risk-accepted`. |
| 5.5 | Archive scanner evidence and sign-off record in the long-term audit repository (minimum retention: 7 years). |

**Output:** Story is closed with full audit trail and sign-off.

---

## Step 6 – Post-Triage Review (Optional but Recommended)

| Action | Details |
|--------|---------|
| 6.1 | Schedule a 15-minute retrospective if the stop was a false positive or caused > 4 hours of delay. |
| 6.2 | Update scanner tuning, allow-lists, or playbooks to reduce future friction. |
| 6.3 | Record metrics: **time-to-triage**, **resume-vs-close ratio**, and **false-positive rate**. |

**Output:** Improvement ticket created or playbook updated.

---

## Quick Reference: Status Transitions

```
STOPPED_SECURITY
    │
    ├─► Step 1-2 (Validate)
    │
    ├─► Step 3 (Assess)
    │       │
    │       ├─► Fixable / False positive ──► Step 4 ──► IN_PROGRESS
    │       │
    │       └─► Risk accepted / Obsolete ──► Step 5 ──► CLOSED_SECURITY
    │
    └─► Step 6 (Retro / Metrics)
```

---

## Roles & Escalation

| Role | Responsibility |
|------|----------------|
| Story Owner | Drives Steps 1-3, documents findings. |
| Security Champion | Validates severity, signs off on Step 5 closures. |
| AppSec On-Call | Consulted for Critical/High findings, final arbiter on disputes. |
| Engineering Manager | Approves effort allocation for remediation in Step 4. |

> **Escalation path:** If consensus cannot be reached in Step 3 within **24 hours**, escalate to the AppSec On-Call via PagerDuty/Slack `#security-incidents`.
