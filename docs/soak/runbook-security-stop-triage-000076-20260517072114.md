# Runbook: Security STOP Triage

## Purpose
Investigate and resolve a story whose pipeline stage has stopped with `STOPPED_SECURITY`.

## When to use
- A story build or deployment stage exits with `STOPPED_SECURITY`
- Automated security scanning (SAST/DAST/container/dependency) flags a blocking finding
- The team needs to decide whether to resume the story or formally close it

## Steps

### 1. Identify the security finding
- Open the failed pipeline run and locate the exact security tool report (e.g., Snyk, SonarQube, Trivy, Checkmarx).
- Record: tool name, rule/finding ID, severity, file or package path, and CVSS score if available.
- Save a permalink to the raw report.

### 2. Classify the finding
- Determine if the finding is:
  - **True positive** and exploitable in production
  - **True positive** but not exploitable (e.g., test-only dependency, unreachable code)
  - **False positive** or informational
- Cross-check the finding against the team’s accepted risk list and security baseline.

### 3. Assess business impact and fix feasibility
- Estimate the effort to fix (hours vs. days).
- If the story is release-blocking, evaluate whether a temporary compensating control (feature flag, WAF rule, monitoring) can safely defer the code fix.
- Document the impact decision in the story’s comments or linked risk register.

### 4. Decide: Resume or Close
- **Resume** if:
  - A fix is committed and the finding is cleared, **or**
  - A documented risk acceptance is approved by the security lead or product owner.
- **Close** if:
  - The finding is a confirmed critical or high exploitable vulnerability and the business deems the story too risky to continue, **or**
  - The story is permanently superseded by an alternative approach.
- When closing, set the story state to `CLOSED` (or equivalent) and link the security finding so it remains auditable.

### 5. Document and notify
- Update the story with:
  - Summary of the finding
  - Classification and impact assessment
  - Decision (resume/close) and rationale
  - Names of reviewers or approvers
- Notify the team via the standard channel (e.g., Slack, email) referencing the story ID.

### 6. Verify pipeline state
- If resuming, rerun the affected pipeline stage and confirm it passes.
- If closing, ensure no downstream stages remain queued and the story is correctly archived.

## References
- Security scanning tool dashboards
- Team risk acceptance register
- Product owner / security lead escalation contacts
