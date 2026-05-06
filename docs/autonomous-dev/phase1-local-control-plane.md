# Phase 1: Local Control Plane MVP

## Purpose

Phase 1 establishes the local safety/control plane for the autonomous development system before Telegram, OpenCode write execution, or planning agents are connected.

The goal is to make the system capable of evaluating risk, requiring approval, changing modes, writing audit logs, and running local gates without allowing autonomous code modification.

## Current Safety Posture

- Active default mode: `approval`
- Full auto mode: available only through local CLI and two-step confirmation
- Telegram approval: not connected
- OpenCode write execution: not connected
- LangGraph planning: not connected
- Production secrets: not connected
- Production DB: not connected

## Implemented Components

### Ralph Core

Implemented under `src/ralph/`:

- `types.js`
- `hash.js`
- `risk-evaluator.js`
- `audit-log.js`
- `state-machine.js`
- `approval-manager.js`
- `mode-manager.js`
- `roles.js`
- `cli.js`

### Tests

Implemented under `tests/ralph/`:

- `hash.spec.js`
- `risk-evaluator.spec.js`
- `approval-manager.spec.js`
- `state-machine.spec.js`
- `mode-manager.spec.js`

Expected result:

```bash
npm run test:ralph
```

Expected output:

```text
17 passed
```

### Gate Runner

Implemented under `scripts/gates/`:

- `run-all.sh`
- `secret-scan.sh`
- `ralph-tests.sh`
- `supabase-local.sh`
- `playwright-e2e.sh`

Current gate sequence:

1. `pre-secret-scan`
2. `ralph-tests`
3. `supabase-local`
4. `playwright-e2e`
5. `post-secret-scan`

Run all local gates:

```bash
./scripts/gates/run-all.sh
```

Expected final output:

```text
[gate] all Phase 1 local gates passed
```

## Approval Manager CLI

### Risk Evaluation

```bash
node src/ralph/cli.js risk .ralph/tmp/sample-plan.json
```

Expected behavior:

- Risk is evaluated without execution.
- Risk 5 returns a stop decision.
- Risk 3 in approval mode requires plan approval.

### Create Approval

```bash
node src/ralph/cli.js create-approval .ralph/tmp/sample-plan.json
```

Expected behavior:

- Creates `.ralph/approval-pending/<approval_id>.json`
- Appends to `.ralph/approval-log.jsonl`
- Stores `plan_hash`
- Stores `pre_exec_diff_hash`
- Keeps approval in `pending` status

### Approve

```bash
node src/ralph/cli.js approve <approval_id> <user_id> .ralph/tmp/sample-plan.json
```

Expected behavior:

- Allowed user approves successfully.
- Disallowed user fails with `failed_verification`.
- Changed plan fails with `plan_hash_mismatch`.

### Deny

```bash
node src/ralph/cli.js deny <approval_id> <user_id>
```

### Modify

```bash
node src/ralph/cli.js modify <approval_id> "instruction"
```

Important behavior:

- The current approval becomes `superseded`.
- The next action is `REPLAN_REQUIRED`.
- The system must not execute directly after `/modify`.

## Mode Manager CLI

### Show Mode

```bash
node src/ralph/cli.js mode
```

### Local Roles

Runtime roles are loaded from:

```text
.ralph/roles.json
```

An example is committed at:

```text
.ralph/roles.example.json
```

Create the local runtime file with:

```bash
cp .ralph/roles.example.json .ralph/roles.json
```

`.ralph/roles.json` is intentionally ignored by Git.

### Switch to Approval Mode

```bash
node src/ralph/cli.js mode approval <user_id>
```

Rules:

- `owner`, `admin`, or `reviewer` can switch to approval mode.
- `observer` cannot change the mode.

### Request Fullauto Mode

```bash
node src/ralph/cli.js mode fullauto-request <admin_user_id> [hours]
```

Rules:

- Admin or owner only.
- Default duration: 6 hours.
- Maximum duration: 24 hours.
- Creates a pending confirmation token.
- Does not switch mode immediately.

### Confirm Fullauto Mode

```bash
node src/ralph/cli.js mode fullauto-confirm <MODE_TOKEN> <admin_user_id>
```

Rules:

- Admin or owner only.
- Requires a valid pending token.
- Token expires after 10 minutes.
- Sets `auto_revert_to` to `approval`.

### Auto Revert

```bash
node src/ralph/cli.js mode auto-revert
```

Expected behavior:

- If fullauto expired, mode changes back to approval.
- If fullauto is still valid, no change.
- If mode is already approval, no change.

## State Machine Safety Rules

The state machine enforces valid transitions only.

Important states:

- `IDLE`
- `PLANNING`
- `RISK_ASSESSMENT`
- `PLAN_APPROVAL_PENDING`
- `EXECUTING`
- `GATE_RUNNING`
- `GATE_FAILED`
- `DEBUGGING`
- `DIFF_APPROVAL_PENDING`
- `COMMITTING`
- `DONE`
- `PAUSED`
- `BLOCKED`
- `STOPPED_SECURITY`

Important guarantees:

- Invalid transitions throw an error.
- Invalid transitions do not modify `.ralph/state.json`.
- `STOPPED_SECURITY` has no normal outgoing transition.
- Security stops are written to audit log.

## Risk Evaluator Rules

Current risk examples:

| Risk | Meaning |
|---|---|
| 0 | Low risk |
| 3 | DB migration, auth/RLS, or external API |
| 4 | Production DB migration |
| 5 | Destructive or secret-related risk |

Control decisions:

- `auto_execute`
- `require_plan_approval`
- `require_diff_approval`
- `stop`
- `escalate`

Important rule:

Risk 5 must result in `stop`, not approval.

## Hash Rules

### `plan_hash`

- Calculated from canonical JSON.
- Object keys are sorted.
- Volatile fields are excluded.
- Array order is preserved.

Excluded fields include:

- `created_at`
- `updated_at`
- `expires_at`
- `approved_at`
- `generated_by`
- `model_response_id`
- `trace_id`
- `token_usage`
- `latency_ms`

### `diff_hash`

- Calculated from `git diff --binary --full-index`.
- Used to detect pre-execution or post-execution diff changes.

## Runtime Files Not Committed

The following are runtime artifacts and must not be committed:

- `.ralph/approval-pending/*`
- `.ralph/tmp/*`
- `.ralph/approval-log.jsonl`
- `.ralph/logs/*`
- `.ralph/roles.json`
- `playwright-report/`
- `test-results/`

## Current Verification Command

Before moving to the next phase, this must pass:

```bash
npm run test:ralph
./scripts/gates/run-all.sh
git status
```

Expected result:

```text
17 passed
[gate] all Phase 1 local gates passed
nothing to commit, working tree clean
```

## Next Phase Recommendation

The next phase should be Telegram Bridge, but only as a command/control surface.

Do not connect Telegram to OpenCode write execution yet.

Recommended Phase 2 scope:

1. Telegram Bot skeleton
2. `/ping`
3. `/status`
4. `/mode approval`
5. `/mode fullauto` request/confirm
6. `/approve`, `/deny`, `/modify` command parsing only
7. Strict `telegram_user_id` and `chat_id` allowlist
8. No autonomous execution connection
