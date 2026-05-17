# Decision: Fullauto Mode Excludes PLAN Stage from Auto-Approval

## Context

In full-auto ("fullauto") execution mode, the system aims to minimize human intervention by auto-approving as many stages as possible. This reduces friction and speeds up the development loop.

## Decision

Even when running in **fullauto** mode, **PLAN** stage approvals **require a human**.

Only the following stages are auto-approved in fullauto:

- **DIFF**
- **COMMIT**
- **PUSH**
- **PR**

## Rationale

The PLAN stage is where the overall strategy, architecture, and approach for a change are determined. Requiring a human at this stage ensures that the high-level direction is correct before the system proceeds to automatically execute the lower-level mechanical stages. This maintains a critical checkpoint for strategic oversight without slowing down the subsequent implementation and delivery steps.

## Consequences

- Human involvement is still mandatory at PLAN.
- Fullauto benefits are realized primarily during the execution and delivery phases.
- Risk of large-scale automated mistakes is reduced by keeping a human in the loop for planning.
