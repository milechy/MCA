# Runbook: Security Stop Triage

## Purpose
This runbook provides a standard operating procedure for triaging stories that have been stopped due to security concerns (`STOPPED_SECURITY`). It ensures consistent evaluation, clear decision-making, and proper documentation when determining whether to resume or formally close a blocked story.

## When to Use
- A story has been flagged or transitioned to `STOPPED_SECURITY` status.
- A security review, scan, or incident has blocked ongoing development work.
- A previous security remediation attempt has been re-evaluated and found insufficient.

## 1. Acknowledge and Contain
**Objective:** Confirm the stop status and prevent further exposure or conflicting work.

- **Verify Stop Status:** Confirm in the issue tracker (e.g., Jira, Linear) that the story is formally marked `STOPPED_SECURITY`.
- **Halt Active Work:** Ensure all active branches, pull requests, or deployments related to the story are paused or marked as blocked. If the story is part of a larger epic, assess whether related stories must also be paused.
- **Document Context:** Capture the current state: assignee, sprint, linked epics, and the specific reason for the security stop (e.g., vulnerability ID, audit finding, security team flag).
- **Notify Stakeholders:** Inform the story owner, product manager, and security liaison that triage is beginning. Set expectations for the decision timeline (target: within 1 business day for high-severity issues).

> **Output:** Updated issue status, paused related work, and a brief initial summary posted to the story comments.

## 2. Reproduce and Assess Severity
**Objective:** Independently verify the security concern and classify its impact.

- **Reproduce the Finding:** If the stop was triggered by a scan or report, reproduce the finding in a controlled environment. For code-level issues, identify the specific commit or branch introducing the vulnerability.
- **Classify Severity:** Use the organization's security severity framework (e.g., Critical, High, Medium, Low) based on:
  - Exploitability (can it be triggered by an unauthenticated user?)
  - Impact (data breach, service disruption, compliance violation)
  - Scope (single story, broader system, third-party dependency)
- **Map to Requirements:** Determine if the story's business requirements inherently conflict with security policy, or if the implementation can be adjusted to satisfy both.

> **Output:** A severity classification and a reproducibility note attached to the story. If the finding cannot be reproduced, document the discrepancy immediately and notify the security team.

## 3. Evaluate Remediation Options
**Objective:** Determine whether the story can be securely completed or must be abandoned.

- **Identify Remediation Paths:**
  - **Path A: In-Story Fix** — Can the security issue be resolved by modifying the implementation within the existing story scope (e.g., input validation, access control, dependency upgrade)?
  - **Path B: Story Decomposition** — Should the story be split into a secure subset and a deferred risky subset?
  - **Path C: Dependency on External Fix** — Is the blocker a third-party vulnerability awaiting a patch?
  - **Path D: Unresolvable Conflict** — Does the story's core requirement violate a non-negotiable security control or compliance mandate?
- **Estimate Effort:** For viable paths (A, B, or C), provide a rough estimate of the additional security work required. For Path C, establish a monitoring plan and timeline for the external fix.

> **Output:** A decision matrix documenting the viable paths, estimated effort, and recommended option.

## 4. Make Resume or Close Decision
**Objective:** Reach a formal, documented decision with security and product alignment.

- **Convene Review:** Schedule a brief triage meeting or async review with the story owner, product manager, and a security representative.
- **Apply Decision Criteria:**
  - **Resume** if:
    - A viable remediation path exists (A, B, or C).
    - The additional security work fits within acceptable timeline and budget.
    - A clear owner is assigned to the security remediation tasks.
  - **Close** if:
    - The story requirement fundamentally violates policy and no alternative satisfies the business need (Path D).
    - The remediation effort exceeds the story's value and a different approach (e.g., new architecture, vendor solution) must be pursued instead.
    - The external dependency (Path C) has no committed fix date and the business need is time-bound.
- **Document Decision Rationale:** Record the specific reason for resuming or closing in the story comments. Reference the severity, chosen path, and any trade-offs accepted.

> **Output:** A formal decision (Resume or Close) logged in the story, with all approvers tagged.

## 5. Execute Post-Decision Actions
**Objective:** Implement the agreed-upon next steps cleanly.

- **If Resuming:**
  1. Update the story and any sub-tasks to reflect the security remediation work.
  2. Assign security review checkpoints (e.g., mandatory PR review by a security champion, required scan passing).
  3. Update sprint or roadmap projections to account for remediation effort.
  4. Remove `STOPPED_SECURITY` status and return the story to the appropriate workflow state (e.g., In Progress, Refinement).
- **If Closing:**
  1. Transition the story to a terminal state (e.g., Won't Do, Closed — Security Exception Denied).
  2. Create a follow-up ticket in the security backlog if the finding implies a broader systemic risk (e.g., "Evaluate safe alternative to X").
  3. Update the product roadmap or epic to reflect that the capability will not be delivered as originally scoped.
  4. Archive or delete any feature branches associated with the story to prevent accidental revival.

> **Output:** Updated issue tracker state, follow-up tickets created, and stakeholders notified of next steps.

## 6. Review and Close the Loop
**Objective:** Ensure lessons learned are captured and process health is monitored.

- **Retrospective Input:** For resumed stories that required significant rework, add a brief note to the team retrospective on how to avoid similar security stops in the future.
- **Metrics:** Log the triage duration and decision in the team's operational metrics. Track:
  - Number of `STOPPED_SECURITY` stories per quarter.
  - Average time from stop to decision.
  - Percentage resumed vs. closed.
- **Runbook Review:** If patterns emerge (e.g., repeated dependency vulnerabilities, frequent policy conflicts), flag the runbook for process improvement review.

> **Output:** Metrics updated, retrospective item added if applicable, and the runbook owner notified of any systemic issues.

## Roles and Responsibilities
| Role | Responsibility |
|------|----------------|
| Story Owner | Reproduce issue, propose remediation paths, implement fixes. |
| Product Manager | Assess business value vs. remediation cost, approve close decision. |
| Security Liaison | Validate severity, approve resume decision, review fixes. |
| Engineering Lead | Ensure timeline/effort estimates are realistic, assign resources. |

## Escalation
- If severity is classified as **Critical** (active exploitation possible, imminent compliance audit), escalate to the CISO or security on-call immediately after Step 1.
- If the product and security owners cannot reach agreement in Step 4, escalate to the engineering director or equivalent for arbitration.
