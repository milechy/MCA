# Phase 0 Checklist: Autonomous Development Foundation

## Purpose

Phase 0 establishes the safe local foundation for the 24-hour autonomous development system.

The goal of this phase is not to run autonomous development yet. The goal is to ensure that the repository, local services, safety policies, and read-only agent execution are working before any write-capable automation is enabled.

## Current Branch

- Repository: `milechy/MCA`
- Branch: `infra/phase0-autonomous-foundation`

## Completed Items

- [x] GitHub repository connected
- [x] Phase 0 branch created
- [x] `.ralph/state.json` initialized
- [x] `.ralph/mode.json` initialized in `approval` mode
- [x] `.ralph/policy-version.json` initialized
- [x] `policies/dev-agent.yaml` created
- [x] `policies/secrets-policy.yaml` created
- [x] Gate Runner dry-run created at `scripts/gates/run-all.sh`
- [x] Gate Runner dry-run executed successfully
- [x] `.DS_Store` removed from Git tracking
- [x] Supabase CLI updated
- [x] Supabase local initialized with `supabase init`
- [x] Supabase local started successfully with `supabase start`
- [x] `supabase/config.toml` committed
- [x] Playwright initialized
- [x] Playwright tests executed successfully: `6 passed`
- [x] OpenCode installed
- [x] OpenCode read-only repository summary executed successfully

## Pending Items

- [ ] Confirm `git status` remains clean after OpenCode read-only execution
- [ ] Add Phase 0 completion commit after this checklist is synced locally
- [ ] Decide whether Telegram Bot setup is included in Phase 0 or deferred to Phase 1
- [ ] Decide whether NemoClaw/OpenClaw runtime installation is included in Phase 0 or deferred until after local safety scaffolding is complete

## Explicit Non-Goals for Phase 0

The following actions are intentionally not enabled in Phase 0:

- Running a 24-hour autonomous loop
- Enabling `fullauto` mode
- Connecting production Supabase project secrets
- Injecting service role keys
- Allowing OpenCode to modify files autonomously
- Allowing AI-generated migrations
- Connecting Telegram `/approve` to execution
- Running production deploys
- Pushing directly to a protected main branch
- Force pushing

## Safety Baseline

Phase 0 safety posture:

- Active mode: `approval`
- Secrets injection: disabled in Phase 0 policy
- Production DB access: disabled
- Agent execution: read-only verification only
- Gate Runner: dry-run only
- Approval system: file scaffolding only, not connected to execution

## Phase 0 Completion Criteria

Phase 0 can be considered complete when all of the following are true:

- [x] `.ralph` state files exist
- [x] Policy files exist
- [x] Gate Runner dry-run works
- [x] Supabase local starts successfully
- [x] Playwright tests pass locally
- [x] OpenCode can read the repository without modifying files
- [ ] Working tree is clean after pulling this checklist
- [ ] Phase 0 checklist is committed and pushed

## Next Phase

Phase 1 should focus on implementing the local control plane before any autonomous execution:

1. Ralph Core state machine
2. Approval object schema
3. Risk evaluator
4. CLI-only Approval Manager
5. Audit log writer
6. Gate Runner real checks

Telegram Bridge, OpenCode write execution, and LangGraph Planning Layer should remain disconnected until the local state machine and approval logic are stable.
