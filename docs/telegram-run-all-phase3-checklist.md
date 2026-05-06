# Telegram `/run-all` Phase 3 Completion Checklist

This checklist records the completed Phase 3 safety boundary for Telegram-triggered `scripts/gates/run-all.sh` execution.

## Scope

Phase 3 covers Telegram command handling, policy inspection, approval preflight, command allowlisting, shell execution gating, compact runtime responses, and audit/execution-log separation for `/run-all`.

It does **not** cover production deploys, database migrations, OpenCode execution, production secrets, or arbitrary shell execution from Telegram.

## Execution model

Telegram `/run-all` is default-off. It only attempts real shell execution when all of the following are true:

1. Telegram user and chat are authorized.
2. The command is `/run-all <approval_id> <plan_path>`.
3. `plan_path` is inside `.ralph/tmp/` and is a JSON file.
4. The approval exists and is approved.
5. The plan hash matches the approved plan hash.
6. The current diff hash matches the approved pre-execution diff hash.
7. The command request matches `COMMAND_ALLOWLIST`.
8. The shell execution policy passes.
9. `RALPH_TELEGRAM_RUN_ALL_ENABLED=true` is explicitly set.

If the environment gate is absent or not exactly `true`, `/run-all` remains preflight-only and returns `READY_BUT_NOT_EXECUTED`.

## Allowed command

The only production allowlisted Telegram shell command is:

```text
scripts/gates/run-all.sh
```

with:

```text
args: []
cwd: .
```

`/policy.allowed_commands` is tested to mirror `COMMAND_ALLOWLIST`.

## Audit and execution log responsibilities

### `audit.jsonl`

Telegram commands write compact audit events.

For `/policy`, audit records only the compact command event and never stores the full policy object.

For `/run-all`, audit records a compact summary containing bounded fields only.

Unauthorized Telegram commands are audited compactly as `command_type=unauthorized` and never reach execution.

### `execution.jsonl`

`execution.jsonl` is reserved for shell execution attempts and results.

The following must not write shell completion events:

- `/policy`
- unauthorized user/chat
- unknown or unsupported command
- unsafe `/run-all` path
- `/run-all` preflight-only mode

Successful real `/run-all` execution writes:

- `shell_execution_completed`
- `approved_shell_execution_completed`

Failed real shell execution may write shell failure information, but it must remain bounded in Telegram response/audit summaries.

## Telegram response bounds

Telegram responses are intentionally compressed.

`/policy` response text must stay under the policy response size bound and must not include:

- stdout
- execution preflight internals
- command preflight internals
- shell execution completion log payloads

`/run-all` response text must stay under the run-all response size bound and must not include:

- stdout
- execution preflight internals
- command preflight internals
- full shell policy internals

## Failure taxonomy

Run-all failures use the shared taxonomy in `src/telegram/run-all-taxonomy.js`.

The taxonomy, normalization map, and audit summary fields are tested directly and through both handler and policy-reader paths.

Known normalized reasons include:

```text
plan_file_not_found -> plan_file_missing
command_not_allowed -> command_not_allowlisted
```

## Safety tests completed

Phase 3 includes tests for:

- Telegram auth allowlists
- command parsing
- approval adapter behavior
- no-op execution adapter behavior
- `/policy` read-only behavior
- `/policy` drift prevention against `COMMAND_ALLOWLIST`
- `/policy` response compression and size bounds
- `/run-all` default-off preflight-only behavior
- `/run-all` real execution only behind `RALPH_TELEGRAM_RUN_ALL_ENABLED=true`
- `/run-all` unsafe path rejection
- `/run-all` compact success/failure summaries
- audit schema compactness
- execution/audit log responsibility separation
- unauthorized user/chat safety
- unknown command safety
- run-all failure taxonomy drift prevention

## Phase 3 done criteria

Phase 3 is complete when all local gates pass:

```bash
npm run test:ralph
npm run test:telegram
./scripts/gates/run-all.sh
git status
```

Expected final state:

```text
[ralph-tests] passed
[telegram-tests] passed
[gate] all Phase 2 local gates passed
nothing to commit, working tree clean
```

## Deferred to Phase 4+

The following are intentionally deferred:

- real Telegram Bot API smoke against a private bot
- CI-level secrets and environment wiring
- production deploy/migration execution from Telegram
- OpenCode runtime execution from Telegram
- multi-command allowlist expansion
- richer operator documentation for incident response
- production observability dashboards
