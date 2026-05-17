# Decision: Fullauto excludes PLAN Approval

**Date:** 2026-05-17
**ID:** decision-fullauto-pl-excludes-plan-000031

## Context
In fullauto mode, Ralph aims to minimize human intervention. However, the PLAN stage is where high-level strategy, architecture, and intent are defined.

## Decision
Even when running in fullauto mode, PLAN approvals **must** remain gated by a human operator. Only the subsequent DIFF, COMMIT, PUSH, and PR steps are eligible for auto-approval.

## Rationale
- A human review at the PLAN stage prevents misaligned or risky automation before any code is generated.
- DIFF, COMMIT, PUSH, and PR steps carry lower strategic risk because they are constrained by the already-approved plan.

## Consequences
- Fullauto pipelines will pause and wait for human input at the PLAN approval gate.
- All later stages can proceed without further human interaction once the PLAN is approved.
