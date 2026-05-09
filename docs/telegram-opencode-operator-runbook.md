# Telegram OpenCode / Ralph Operator Runbook

This runbook documents the controlled Telegram-to-Ralph-to-OpenCode development flow.

## Current architecture

```text
Gemini      planning / decomposition / risk-aware UltraPlan generation
Kimi        implementation / repair / code generation provider role
Ralph       controller, story state, approval boundaries, gates, audit, scheduler
OpenCode    coding hand that produces candidate.patch
NemoClaw    security/runtime guard around OpenCode execution and secret handling
Telegram    human approval, stop/resume, status, artifact UI
```

OpenCode is allowed to generate a candidate patch in a sandbox only. It does not decide whether to apply, commit, push, create a PR, merge, deploy, or migrate.

The authority chain remains:

```text
Telegram authorization
Ralph story state
UltraPlan plan_hash
Ralph approval records
NemoClaw-mediated OpenCode sandbox dispatch
candidate.patch preview
separate apply approval when required
local gates
repair loop or escalation
separate commit approval
separate push approval
separate PR approval
```

## Required local gates

Run before and after autonomous operation:

```bash
npm run test:ralph
npm run test:telegram
./scripts/gates/run-all.sh
git status
```

Expected:

```text
ralph tests passed
telegram-tests passed
all Phase 2 local gates passed
nothing to commit, working tree clean
```

## Recommended autonomous flow

Start from Telegram:

```text
/ralph-start <requirements>
/ralph-loop-status [story_id]
/ralph-run-until-blocked STORY-*
```

Expected behavior:

```text
1. Ralph creates a persisted story.
2. Ralph creates deterministic UltraPlan by default, or Gemini planning if configured.
3. Ralph dispatches OpenCode through the NemoClaw gateway by default.
4. OpenCode may produce only candidate.patch.
5. Ralph stops at approval boundaries with approval_id and next_action.
6. Operator approves, denies, modifies, pauses, resumes, or stops through Telegram.
7. Ralph applies approved candidate.patch only through existing approval chain.
8. Ralph runs gates.
9. Gate failures enter repair strategy or immediate escalation.
10. Commit, push, and PR creation each require their own approval boundary.
```

Common commands:

```text
/ralph-start <requirements>
/ralph-loop-status [story_id]
/ralph-tick STORY-*
/ralph-run-until-blocked STORY-*
/ralph-pause STORY-*
/ralph-resume STORY-* [APR-*]
/ralph-stop STORY-*
/ralph-artifact <job_id>
/approve APR-*
/deny APR-* [reason]
/modify APR-* <instruction>
/approvals
/approval APR-*
```

## Dashboard and status report

Generate a read-only local status report:

```bash
node scripts/ralph/dashboard.js --markdown
node scripts/ralph/dashboard.js --json
```

Dashboard output includes:

```text
active stories
queued stories
waiting approvals
failed/escalated stories
completed stories
stopped stories
approval IDs
job IDs
plan_hash and diff_hash where available
bounded recent audit events
next_action per story
```

Dashboard output must not include raw logs, secrets, tokens, or unbounded stdout/stderr.

## Gemini / Kimi provider roles

Default planning is deterministic. Optional Gemini planning can be enabled by environment configuration:

```bash
RALPH_PLANNING_PROVIDER=gemini
GEMINI_API_KEY=<provided by runtime secret manager>
```

Legacy compatibility:

```bash
RALPH_ULTRAPLAN_PROVIDER=llm
RALPH_ULTRAPLAN_LLM_API_KEY=<provided by runtime secret manager>
```

Kimi is represented as the execution provider role and must remain mediated by NemoClaw:

```bash
RALPH_EXECUTION_PROVIDER=kimi
RALPH_EXECUTION_MEDIATOR=nemoclaw
KIMI_API_KEY=<provided by runtime secret manager>
```

Provider config must only record secret presence as redacted metadata. Raw API keys must not be displayed, logged, persisted, or passed to Telegram output.

## NemoClaw-mediated OpenCode runtime

Ralph dispatches OpenCode through NemoClaw by default.

Expected runtime metadata:

```text
opencode_runtime_mode=nemoclaw-mediated
mediator=nemoclaw
candidate_patch_path=.ralph/tmp/.../candidate.patch
apply_allowed=false
commit_allowed=false
push_allowed=false
pr_allowed=false
deploy_allowed=false
migration_allowed=false
```

Direct OpenCode execution is development-only and must not be used as the default autonomous path. Non-NemoClaw external gateways are explicit dev-only paths and require opt-in.

## Real external agent / NemoClaw smoke

Run optional smoke when runtime is installed and approved:

```bash
npm run ralph:real-external-agent-smoke
git status
```

Expected evidence:

```text
ok=true or skipped=true when runtime is not installed
stage=real_external_agent_smoke
opencode_runtime_mode=nemoclaw-mediated
mediator=nemoclaw
candidate_patch_path=.ralph/tmp/external-agent-smoke/<approval_id>/candidate.patch
working_tree_clean_before=true
working_tree_clean_after=true
commit_created=false
push_performed=false
pr_created=false
merge_performed=false
deploy_performed=false
migration_performed=false
```

If runtime is not installed, the smoke should report a bounded skip/failure reason and must not mutate the repository.

## Manual OpenCode command sequence

The manual command sequence remains available for targeted operation and debugging:

```text
/opencode-sandbox-plan <approval_id> <intent...>
/opencode-sandbox-preflight <approval_id> <sandbox_root> <requested_path...>
/opencode-run <approval_id> <sandbox_root> <task...>
/opencode-patch-preview <approval_id> <sandbox_root> <candidate_patch_path>
/opencode-patch-approval <approval_id> <sandbox_root> <candidate_patch_path> [patch_approval_id]
/approve <patch_approval_id>
/opencode-apply-preflight <patch_approval_id> <patch_hash>
/opencode-apply <patch_approval_id> <patch_hash>
/opencode-gates <patch_approval_id> <patch_hash>
/opencode-commit-approval <patch_approval_id> <patch_hash> <commit_message...>
/approve <commit_approval_id>
/opencode-commit <commit_approval_id>
/opencode-push-approval <commit_sha> <branch> <remote>
/approve <push_approval_id>
/opencode-push <push_approval_id>
/opencode-pr-approval <commit_sha> <head_branch> <base_branch> <title...>
/approve <pr_approval_id>
/opencode-pr <pr_approval_id>
```

## PR body generation

When PR approval metadata includes a body, Ralph preserves that explicit body.

When the approved PR body is empty, Ralph generates a deterministic bounded PR body from:

```text
story metadata
GitHub issue metadata when available
UltraPlan / plan_hash
changed files
gate results
approval trail
diff_hash where available
safety checklist
```

Generated PR body output must be bounded/redacted and must not include raw logs, secrets, tokens, or unbounded stdout/stderr.

## Gate failure repair strategy

On gate failure, Ralph classifies the failure and either dispatches a bounded repair task through NemoClaw/OpenCode or escalates to a human.

Repairable examples:

```text
test_failure
typecheck
build
e2e
timeout with retry cap
unknown with configured cap
```

Immediate escalation examples:

```text
secret_scan
security_policy
production_db
rls_disable
migration
```

Repair context must include only bounded/redacted previews and likely target files. It must not include raw logs or secret values.

## Visibility and control

```text
/opencode-status [job_id]
/opencode-abort <job_id>
/opencode-artifact <job_id> <candidate_patch|stdout|stderr> [artifact_path]
/ralph-loop-status [story_id]
```

Artifact retrieval is bounded and redacted. Raw full logs must not be returned in Telegram.

## Real OpenCode smoke legacy command

The legacy Telegram/OpenCode smoke remains available:

```bash
npm run telegram:real-opencode-smoke
git status
```

Expected evidence:

```text
ok=true
stage=real_opencode_operational_smoke
real_opencode_process_started=true
execution_connected=true
candidate_patch_path=.ralph/tmp/opencode-sandbox/<approval_id>/candidate.patch
patch_preview.ok=true
patch_preview.requires_approval=true
patch_preview.blocked_paths=[]
working_tree_clean_before=true
working_tree_clean_after=true
commit_created=false
push_performed=false
pr_created=false
merge_performed=false
deploy_performed=false
migration_performed=false
nothing to commit, working tree clean
```

Adapter-only fallback:

```bash
RALPH_OPENCODE_SMOKE_TEST_DOUBLE=true npm run telegram:real-opencode-smoke
```

## Cleanup

```bash
unset RALPH_OPENCODE_SANDBOX_ENABLED
unset RALPH_OPENCODE_DIRECT_DEV_ONLY
unset RALPH_EXTERNAL_AGENT_DEV_ONLY_GATEWAY_ALLOWED
git restore .ralph/approval-log.jsonl 2>/dev/null || true
rm -rf .ralph/stories
git status
```

Expected:

```text
nothing to commit, working tree clean
```

## Hard non-goals

```text
No unrestricted shell
No production secrets
No merge from Telegram
No deploy from Telegram
No migration from Telegram
No OpenCode-initiated commit
No OpenCode-initiated push
No OpenCode-initiated PR creation
No approval bypass
No local gate bypass
No raw logs
No secret display/persistence/logging
No production DB destructive changes
No RLS disable
No model-driven policy bypass
No model access to raw secrets
No non-NemoClaw OpenCode runtime as default path
```

## External agent gateway boundary

NemoClaw is the default OpenCode runtime mediator for Ralph autonomous operation.

OpenClaw-style and future external gateways are adapter candidates only and remain dev-only unless explicitly approved. Boundary documentation:

```text
docs/opencode-external-agent-gateway-boundary.md
```

Any new concrete runtime dependency, credential path, or policy change requires separate operator approval and must preserve candidate.patch-only output, bounded/redacted logs, and the existing approval chain.
