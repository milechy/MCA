# Decision: Fullauto Excludes PLAN Auto-Approval

## Context
Even when operating in **fullauto** mode, the system must retain human oversight for planning decisions.

## Decision
- **PLAN** approvals **require a human**. They are **never** auto-approved, even in fullauto.
- **DIFF**, **COMMIT**, **PUSH**, and **PR** actions are **auto-approved** in fullauto.

## Rationale
PLAN approvals determine the strategy and set the course of action. Keeping them gated by human review ensures accountability, prevents drift, and reduces the risk of unintended large-scale changes being triggered automatically.

## Consequences
- Fullauto pipelines will pause and wait for human approval at the PLAN stage.
- Subsequent stages (DIFF, COMMIT, PUSH, PR) proceed automatically once PLAN is approved.
