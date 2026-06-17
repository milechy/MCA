# Decision: Fullauto Auto-Approval Excludes PLAN

**Decision ID:** 000051  
**Date:** 2026-05-17

## Context
We have a "fullauto" execution mode intended to minimize human intervention by auto-approving routine steps.

## Decision
Even in fullauto mode, **PLAN** approvals **must** require explicit human approval. The following remaining stages are permitted for auto-approval:

- **DIFF**
- **COMMIT**
- **PUSH**
- **PR**

## Rationale
A PLAN stage sets the strategic direction, scope, and guardrails for subsequent operations. Requiring a human at the PLAN stage ensures oversight, catches misalignment with intent, and provides a necessary control point before the remainder of the workflow is executed automatically.

## Consequences
- Users must manually approve the PLAN even when running in fullauto.
- Subsequent automated stages (DIFF, COMMIT, PUSH, PR) proceed without further human intervention once the PLAN is approved.
