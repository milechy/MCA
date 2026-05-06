# Phase 2: Telegram Bridge Skeleton and Runtime Dry Run

## Purpose

Phase 2 adds a Telegram command/control surface while keeping autonomous execution disconnected.

The goal is to validate Telegram authentication, command parsing, command handlers, and dry-run runtime behavior before any `/approve`, `/deny`, `/modify`, OpenCode write execution, or planning agent integration is connected.

## Current Safety Posture

Connected:

- `/ping`
- `/status`
- `/mode approval`
- `/mode fullauto`
- `/confirm <token>`

Parsed only, not execution-connected:

- `/approve <approval_id>`
- `/deny <approval_id>`
- `/modify <approval_id> <instruction>`

Still disconnected:

- OpenCode write execution
- LangGraph Planning Layer
- Production Supabase secrets
- Production DB operations
- Automated migrations

## Implemented Files

Telegram source files:

- `src/telegram/config.js`
- `src/telegram/auth.js`
- `src/telegram/command-parser.js`
- `src/telegram/handlers.js`
- `src/telegram/bot.js`
- `src/telegram/runtime.js`

Runtime script:

- `scripts/telegram/run-dry.js`

Tests:

- `tests/telegram/auth.spec.js`
- `tests/telegram/command-parser.spec.js`
- `tests/telegram/handlers.spec.js`
- `tests/telegram/runtime.spec.js`

## Environment Variables

Required for real Telegram polling:

```bash
export TELEGRAM_BOT_TOKEN="<bot-token>"
export TELEGRAM_ALLOWED_USER_IDS="123456789"
export TELEGRAM_ALLOWED_CHAT_IDS="123456789"
```

Dry-run defaults to enabled. To actually send replies through Telegram API:

```bash
export TELEGRAM_DRY_RUN=false
```

For local runtime smoke tests, keep dry-run enabled unless explicitly testing real replies.

Optional one-shot polling limit:

```bash
export TELEGRAM_MAX_ITERATIONS=1
```

## Local Tests

Run Telegram tests only:

```bash
npm run test:telegram
```

Expected result:

```text
Telegram tests passed
```

Run all gates:

```bash
./scripts/gates/run-all.sh
```

Expected final output:

```text
[gate] all Phase 2 local gates passed
```

## Dry-Run Runtime

Start polling with dry-run send behavior:

```bash
TELEGRAM_MAX_ITERATIONS=1 node scripts/telegram/run-dry.js
```

In dry-run mode:

- Updates are read from Telegram.
- Commands are authenticated and processed.
- Replies are printed to stdout instead of being sent.

## Real Reply Runtime

Only after allowlists are confirmed:

```bash
export TELEGRAM_DRY_RUN=false
node scripts/telegram/run-dry.js
```

This sends Telegram replies, but still does not connect `/approve`, `/deny`, or `/modify` to execution.

## Allowlist Rules

Every Telegram update must pass both checks:

- `telegram_user_id` is in `TELEGRAM_ALLOWED_USER_IDS`
- `chat_id` is in `TELEGRAM_ALLOWED_CHAT_IDS`

Unauthorized commands return:

```text
Unauthorized Telegram command.
```

## Mode Commands

### Approval Mode

```text
/mode approval
```

Rules:

- Requires reviewer or higher.
- Switches mode immediately to `approval`.

### Fullauto Request

```text
/mode fullauto 6
```

Rules:

- Requires admin or owner.
- Creates a pending confirmation token.
- Does not switch mode immediately.
- Defaults to 6 hours.
- Maximum is 24 hours.

### Confirm Fullauto

```text
/confirm MODE-...
```

Rules:

- Requires admin or owner.
- Requires valid pending token.
- Token expires after 10 minutes.
- Sets `auto_revert_to` to `approval`.

## Approval Commands in Phase 2

These are intentionally not execution-connected:

```text
/approve APR-...
/deny APR-...
/modify APR-... instruction
```

Expected response:

```text
command parsed but execution is not connected in Phase 2 skeleton.
```

## Next Phase Recommendation

Before connecting Telegram approval commands to Ralph Approval Manager, add:

1. Telegram command audit logging
2. Telegram command idempotency guard
3. Approval ID existence check
4. Approval status read-only display
5. `/approvals` command to list pending approvals
6. More tests for malformed commands

Do not connect OpenCode write execution yet.
