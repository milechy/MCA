const fs = require('node:fs');
const path = require('node:path');
const { STORY_STATUSES, readStory, updateStory, summarizeStory } = require('./story-queue');
const { runUltraPlan } = require('./ultraplan-runner');
const { buildRepairDecision, appendRepairHistory } = require('./repair-strategy');
const { buildProviderConfig, safeProviderConfig } = require('./provider-config');
const { createApproval, approveApprovalRecordOnly, readApproval } = require('./approval-manager');
const { APPROVAL_TYPES, APPROVAL_STATUSES } = require('./types');
const { runOpenCodeCandidatePatch } = require('../telegram/opencode-run');
const { runNemoClawOpenCodeCandidatePatch } = require('./nemoclaw-opencode-gateway');
const { dispatchOpenCodeKimi } = require('./opencode-kimi-dispatcher');
const { maybeAutoApproveForFullauto } = require('./fullauto-auto-approver');
const { rollbackAppliedFiles } = require('./apply-rollback');
const { promoteCommitToFeatureBranch, featureBranchForStory } = require('./feature-branch-promote');
const { checkRequestedPathsCoverage, repairInstructionForMissingPaths } = require('./requested-paths-coverage');
const { opencodeSandboxRunnerPreflight, OPENCODE_SANDBOX_ENV } = require('../telegram/opencode-sandbox-preflight');
const { runOpenCodeAppliedPatchGates } = require('../telegram/opencode-gates');
const { createOpenCodePatchPreviewApproval } = require('../telegram/opencode-patch-approval');
const { applyOpenCodeCandidatePatch } = require('../telegram/opencode-apply');
const { createOpenCodeCommitApproval } = require('../telegram/opencode-commit-approval');
const { commitOpenCodeAppliedPatch } = require('../telegram/opencode-commit');

const AUTONOMOUS_LOOP_VERSION = 'autonomous_loop_v0_1';
const OPENCODE_RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;
const OPENCODE_AGENT_OUTPUT_CONTRACT_BACKOFF_MS = 2 * 60 * 1000;
const OPENCODE_RUNTIME_MODES = Object.freeze({ NEMOCLAW: 'nemoclaw-mediated', DIRECT_DEV_ONLY: 'direct-dev-only', OPENCODE_KIMI_DIRECT: 'opencode-kimi-direct' });
function opencodeKimiDirectEnabled(env = process.env) { return env.RALPH_DISPATCHER === 'opencode-kimi' || env.RALPH_EXECUTION_DISPATCHER === 'opencode-kimi'; }
// Per ADR docs/adr-2026-05-14-retire-nemoclaw-mediator-default.md the legacy NemoClaw-mediated path
// becomes opt-in. Operators on a deploy host where openclaw is installed and verified end-to-end
// can re-enable it with RALPH_DISPATCHER=nemoclaw (or the long alias RALPH_EXECUTION_DISPATCHER=nemoclaw).
function nemoclawDispatcherExplicitlyEnabled(env = process.env) { return env.RALPH_DISPATCHER === 'nemoclaw' || env.RALPH_EXECUTION_DISPATCHER === 'nemoclaw'; }
const LOOP_PHASES = Object.freeze({ PLAN: 'PLAN', PLAN_APPROVAL_PENDING: 'PLAN_APPROVAL_PENDING', OPENCODE_RUNNING: 'OPENCODE_RUNNING', PATCH_PREVIEW: 'PATCH_PREVIEW', DIFF_APPROVAL_PENDING: 'DIFF_APPROVAL_PENDING', APPLY: 'APPLY', GATES: 'GATES', FIX_LOOP: 'FIX_LOOP', COMMIT_APPROVAL_PENDING: 'COMMIT_APPROVAL_PENDING', COMMIT: 'COMMIT', PUSH_APPROVAL_PENDING: 'PUSH_APPROVAL_PENDING', PR_APPROVAL_PENDING: 'PR_APPROVAL_PENDING', PR_REVIEW: 'PR_REVIEW', DONE: 'DONE', STOPPED: 'STOPPED', ESCALATED: 'ESCALATED' });

function baseResult(overrides = {}) { return { ok: false, stage: 'autonomous_loop_tick', reason: null, version: AUTONOMOUS_LOOP_VERSION, story_id: null, from_phase: null, to_phase: null, story: null, ultraplan: null, provider_config: null, opencode: null, patch_approval: null, apply: null, gates: null, repair: null, failure_summary: null, approval_id: null, job_id: null, candidate_patch_path: null, opencode_runtime_mode: OPENCODE_RUNTIME_MODES.NEMOCLAW, mediator: 'nemoclaw', execution_connected: false, commands_executed: [], files_modified: [], repository_files_modified: [], apply_allowed: false, commit_allowed: false, push_allowed: false, pr_allowed: false, merge_allowed: false, deploy_allowed: false, migration_allowed: false, next_action: 'inspect_autonomous_loop_failure', ...overrides }; }

function oneLine(value, maxLength = 600) { const normalized = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(); return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`; }
function boundedFailureSummary(result = {}) { return { ok: result.ok === true, stage: result.stage || null, reason: result.reason || null, failed_gate: result.failed_gate || null, command: result.command || null, exit_code: typeof result.exit_code === 'number' ? result.exit_code : null, stdout_preview: oneLine(result.stdout_preview || result.stdout || ''), stderr_preview: oneLine(result.stderr_preview || result.stderr || ''), commands_executed: Array.isArray(result.commands_executed) ? result.commands_executed.map((item) => oneLine(item, 180)).slice(0, 10) : [], files_modified: Array.isArray(result.files_modified) ? result.files_modified.slice(0, 50) : [], repository_files_modified: Array.isArray(result.repository_files_modified) ? result.repository_files_modified.slice(0, 50) : [] }; }
function defaultApprovalId(story) { return `APR-OPENCODE-AUTO-${story.story_id.replace(/^STORY-/, '')}`; }
function defaultApplyApprovalId(story) { return `APR-OPENCODE-APPLY-${story.story_id.replace(/^STORY-/, '')}`; }
function defaultJobId(story) { return `JOB-OPENCODE-AUTO-${story.story_id.replace(/^STORY-/, '')}`; }
function commitMessageForStory(story) { return oneLine(story.title || story.requirement || `Update ${story.story_id}`, 160); }
function defaultSandboxRoot(story) { return `.ralph/tmp/opencode-sandbox/${defaultApprovalId(story)}`; }
function taskForStory(story) { const plan = story.last_ultraplan || {}; const task = Array.isArray(plan.tasks) ? plan.tasks.find((item) => item.agent === 'opencode') : null; if (story.last_repair_instruction) return `${task?.objective || story.requirement}\n${story.last_repair_instruction}`; if (story.last_gate_failure_summary) return `${task?.objective || story.requirement}\nFix bounded gate failure: ${JSON.stringify(story.last_gate_failure_summary)}`; return task?.objective || story.requirement; }
function phaseForUltraPlan(ultraplan) { const action = ultraplan?.control_decision?.action; if (action === 'stop' || action === 'escalate') return LOOP_PHASES.ESCALATED; if (action === 'require_plan_approval') return LOOP_PHASES.PLAN_APPROVAL_PENDING; if (action === 'require_diff_approval') return LOOP_PHASES.DIFF_APPROVAL_PENDING; return LOOP_PHASES.OPENCODE_RUNNING; }
function statusForPhase(phase) { if ([LOOP_PHASES.PLAN_APPROVAL_PENDING, LOOP_PHASES.DIFF_APPROVAL_PENDING, LOOP_PHASES.COMMIT_APPROVAL_PENDING, LOOP_PHASES.PUSH_APPROVAL_PENDING, LOOP_PHASES.PR_APPROVAL_PENDING].includes(phase)) return STORY_STATUSES.WAITING_APPROVAL; if ([LOOP_PHASES.DONE].includes(phase)) return STORY_STATUSES.COMPLETED; if ([LOOP_PHASES.STOPPED].includes(phase)) return STORY_STATUSES.STOPPED; if ([LOOP_PHASES.ESCALATED].includes(phase)) return STORY_STATUSES.FAILED; return STORY_STATUSES.RUNNING; }
function nextActionForPhase(phase) { switch (phase) { case LOOP_PHASES.PLAN_APPROVAL_PENDING: return 'request_plan_approval_then_resume'; case LOOP_PHASES.DIFF_APPROVAL_PENDING: return 'request_diff_approval_then_resume'; case LOOP_PHASES.OPENCODE_RUNNING: return 'dispatch_opencode_candidate_patch_via_nemoclaw'; case LOOP_PHASES.PATCH_PREVIEW: return 'preview_candidate_patch_and_decide_apply'; case LOOP_PHASES.APPLY: return 'apply_approved_candidate_patch'; case LOOP_PHASES.GATES: return 'run_gates_for_applied_patch'; case LOOP_PHASES.FIX_LOOP: return 'dispatch_opencode_fix_candidate_patch_via_nemoclaw'; case LOOP_PHASES.COMMIT_APPROVAL_PENDING: return 'request_commit_approval_then_resume'; case LOOP_PHASES.COMMIT: return 'commit_approved_patch'; case LOOP_PHASES.PUSH_APPROVAL_PENDING: return 'request_push_approval_then_resume'; case LOOP_PHASES.PR_APPROVAL_PENDING: return 'request_pr_approval_then_resume'; case LOOP_PHASES.PR_REVIEW: return 'review_pull_request_then_complete'; case LOOP_PHASES.DONE: return 'story_complete'; case LOOP_PHASES.ESCALATED: return 'human_escalation_required'; case LOOP_PHASES.STOPPED: return 'story_stopped'; default: return 'advance_autonomous_loop'; } }
function updateStoryForPhase(story, phase, patch, options) { return updateStory(story.story_id, { status: statusForPhase(phase), current_phase: phase, ...patch }, options); }
function currentSafeProviderConfig(env = process.env) { return safeProviderConfig(buildProviderConfig({ env })); }
function failedOpenCodeNextAction(opencode = {}) { return opencode.next_action || (opencode.reason === 'provider_rate_limited' ? 'retry_after_provider_rate_limit' : 'fix_opencode_dispatch_failure'); }
function retryAfterForOpenCodeFailure(opencode = {}, now = new Date()) { if (opencode.reason === 'provider_rate_limited') return new Date(now.getTime() + OPENCODE_RATE_LIMIT_BACKOFF_MS).toISOString(); if (opencode.reason === 'candidate_patch_missing') return new Date(now.getTime() + OPENCODE_AGENT_OUTPUT_CONTRACT_BACKOFF_MS).toISOString(); return null; }

function persistedApprovalIsApproved({ rootDir, approval_id, now = new Date() } = {}) { if (!approval_id) return false; try { const approval = readApproval(rootDir, approval_id); if (approval.status !== APPROVAL_STATUSES.APPROVED) return false; if (new Date(approval.expires_at).getTime() < now.getTime()) return false; return true; } catch { return false; } }

function ensureOpenCodeApprovalRecord(story, { rootDir, approval_id, now }) { const plan = story.last_ultraplan || { story_id: story.story_id, objective: story.requirement, requested_paths: story.requested_paths || [] }; const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString(); try { createApproval(plan, { score: 0, category: 'low', label: 'RISK_0_LOW', requires_approval: true }, { rootDir, approval_id, approval_type: APPROVAL_TYPES.DIFF, requested_action: 'opencode_candidate_patch', allowed_user_ids: [], expires_at: expiresAt }); approveApprovalRecordOnly(approval_id, 'autonomous-loop', { rootDir, channel: 'ralph' }); return { ok: true, approval_id, created: true, approved_record_only: true }; } catch (error) { return { ok: false, reason: 'approval_record_create_failed', approval_id, error_preview: oneLine(error && error.message ? error.message : String(error)) }; } }

function safePatchPath(rootDir, candidatePatchPath) { if (!candidatePatchPath) return null; const absolute = path.resolve(rootDir, candidatePatchPath); const expectedPrefix = path.resolve(rootDir, '.ralph', 'tmp'); if (!absolute.startsWith(expectedPrefix)) return null; return absolute; }
function filesTouchedFromPatchText(patchText) { const files = new Set(); for (const line of String(patchText || '').split('\n')) { const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/); if (!match) continue; const target = match[2].replace(/^b\//, '').trim(); if (target && !target.startsWith('/') && !target.includes('..')) files.add(target); } return [...files].sort(); }
function buildPatchPreviewForStory(story, { rootDir }) { const candidatePatchPath = story.current_candidate_patch_path; const patchPath = safePatchPath(rootDir, candidatePatchPath); if (!patchPath || !fs.existsSync(patchPath)) return { ok: false, reason: 'candidate_patch_missing' }; const patchText = fs.readFileSync(patchPath, 'utf8'); const filesTouched = filesTouchedFromPatchText(patchText); if (filesTouched.length === 0) return { ok: false, reason: 'candidate_patch_files_unavailable' }; return { ok: true, reason: null, requires_approval: true, apply_allowed: false, risk: { score: 0, category: 'low', label: 'RISK_0_LOW' }, approval_id: story.current_approval_id || defaultApprovalId(story), candidate_patch_path: candidatePatchPath, sandbox_root: story.current_sandbox_root || defaultSandboxRoot(story), files_touched: filesTouched, blocked_paths: [], diff_bytes: Buffer.byteLength(patchText, 'utf8') }; }

function advancePlanPhase(story, { rootDir, now, env = process.env }) { const providerConfig = currentSafeProviderConfig(env); const ultraplan = runUltraPlan(story); if (!ultraplan.ok) { const failed = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, { blocked_reason: ultraplan.reason, last_provider_config: providerConfig }, { rootDir, now, event: 'ultraplan_failed' }); return baseResult({ ok: false, reason: ultraplan.reason, story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.ESCALATED, story: failed.summary || summarizeStory(failed.story || story), ultraplan, provider_config: providerConfig, next_action: 'human_escalation_required' }); } const nextPhase = phaseForUltraPlan(ultraplan); const blockedReason = nextPhase === LOOP_PHASES.ESCALATED ? ultraplan.control_decision?.reason || 'control_decision_escalated' : null; const updated = updateStoryForPhase(story, nextPhase, { current_plan_hash: ultraplan.plan_hash, blocked_reason: blockedReason, last_ultraplan: ultraplan.plan, last_provider_config: providerConfig, planning_provider: providerConfig.planning.provider, execution_provider: providerConfig.execution.provider, execution_mediator: providerConfig.execution.mediated_by, requested_paths: ultraplan.requested_paths, retry_after_at: null }, { rootDir, now, event: 'ultraplan_created' }); return baseResult({ ok: nextPhase !== LOOP_PHASES.ESCALATED, reason: blockedReason, story_id: story.story_id, from_phase: story.current_phase, to_phase: nextPhase, story: updated.summary, ultraplan, provider_config: providerConfig, next_action: nextActionForPhase(nextPhase) }); }

function advanceWaitingApprovalPhase(story, { rootDir, now, approvals = {} }) { const approvalId = story.current_approval_id; let approved = approvalId && (approvals[approvalId] === 'approved' || persistedApprovalIsApproved({ rootDir, approval_id: approvalId, now })); let autoApprove = null; if (!approved && approvalId) { autoApprove = maybeAutoApproveForFullauto({ rootDir, story, now }); if (autoApprove && autoApprove.approved === true) { approved = true; } } if (!approved) { return baseResult({ ok: true, reason: 'waiting_for_approval', story_id: story.story_id, from_phase: story.current_phase, to_phase: story.current_phase, story: summarizeStory(story), approval_id: approvalId || null, provider_config: story.last_provider_config || null, fullauto_auto_approve: autoApprove, next_action: 'approve_or_modify_story_before_resume' }); } let nextPhase;
  if (story.current_phase === LOOP_PHASES.PLAN_APPROVAL_PENDING) nextPhase = LOOP_PHASES.OPENCODE_RUNNING;
  else if (story.current_phase === LOOP_PHASES.DIFF_APPROVAL_PENDING) nextPhase = LOOP_PHASES.APPLY;
  else if (story.current_phase === LOOP_PHASES.COMMIT_APPROVAL_PENDING) nextPhase = LOOP_PHASES.COMMIT;
  else if (story.current_phase === LOOP_PHASES.PUSH_APPROVAL_PENDING) nextPhase = LOOP_PHASES.PR_APPROVAL_PENDING;
  else if (story.current_phase === LOOP_PHASES.PR_APPROVAL_PENDING) nextPhase = LOOP_PHASES.DONE;
  else return baseResult({ ok: false, reason: 'approval_phase_not_supported_yet', story_id: story.story_id, from_phase: story.current_phase, to_phase: story.current_phase, story: summarizeStory(story), approval_id: approvalId, provider_config: story.last_provider_config || null, next_action: 'implement_next_approval_resume_phase' }); const updated = updateStoryForPhase(story, nextPhase, { blocked_reason: null, retry_after_at: null }, { rootDir, now, event: 'approval_resumed' }); return baseResult({ ok: true, story_id: story.story_id, from_phase: story.current_phase, to_phase: nextPhase, story: updated.summary, approval_id: approvalId, provider_config: story.last_provider_config || null, next_action: nextActionForPhase(nextPhase) }); }

function buildOpenCodePreflight(story, { rootDir, now, env, pre_secret_scan_ok }) { const approvalId = story.current_approval_id || defaultApprovalId(story); const sandboxRoot = story.current_sandbox_root || defaultSandboxRoot(story); const runEnv = { ...env, [OPENCODE_SANDBOX_ENV]: env?.[OPENCODE_SANDBOX_ENV] || 'true' }; const worktreeIsolated = opencodeKimiDirectEnabled(env) || !nemoclawDispatcherExplicitlyEnabled(env); return opencodeSandboxRunnerPreflight({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot, requested_paths: story.requested_paths || [], pre_secret_scan_ok: pre_secret_scan_ok === true, env: runEnv, now, worktree_isolated: worktreeIsolated }); }
function directOpenCodeDevOnlyAllowed(env = process.env) { return env.RALPH_OPENCODE_DIRECT_DEV_ONLY === 'true'; }
function buildDefaultOpenCodeDispatcher(story, { rootDir, now, env, pre_secret_scan_ok, opencode_command, opencode_args, timeout_ms, nemclaw_spawn }) { return ({ approval_id, job_id, sandbox_root, task, requested_paths }) => { const preflight = buildOpenCodePreflight(story, { rootDir, now, env, pre_secret_scan_ok }); if (!preflight.ok) return { ...preflight, job_id, approval_id, sandbox_root, task_preview: task, candidate_patch_path: null, patch_preview: null, opencode_runtime_mode: OPENCODE_RUNTIME_MODES.OPENCODE_KIMI_DIRECT, mediator: 'opencode-direct' }; if (nemoclawDispatcherExplicitlyEnabled(env)) return runNemoClawOpenCodeCandidatePatch({ rootDir, approval_id, job_id, sandbox_root, requested_paths, task, env, timeout_ms, spawn: nemclaw_spawn, now: () => now }); if (directOpenCodeDevOnlyAllowed(env)) return { ...runOpenCodeCandidatePatch(preflight, { rootDir, task, command: opencode_command, args: opencode_args, env: { ...env, [OPENCODE_SANDBOX_ENV]: 'true' }, timeout_ms, now: () => now }), opencode_runtime_mode: OPENCODE_RUNTIME_MODES.DIRECT_DEV_ONLY, mediator: 'none', direct_dev_only: true }; return dispatchOpenCodeKimi({ rootDir, story, approval_id, job_id, sandbox_root, task, requested_paths, env, timeout_ms, now: () => now }); }; }
function advanceOpenCodeRunningPhase(story, { rootDir, now, env = process.env, pre_secret_scan_ok = false, opencode_dispatcher, opencode_command, opencode_args, timeout_ms, nemclaw_spawn }) { const approvalId = story.current_approval_id || defaultApprovalId(story); const jobId = story.current_job_id || defaultJobId(story); const sandboxRoot = story.current_sandbox_root || defaultSandboxRoot(story); const task = taskForStory(story); const approvalRecord = ensureOpenCodeApprovalRecord(story, { rootDir, approval_id: approvalId, now }); if (!approvalRecord.ok) { const updated = updateStoryForPhase(story, LOOP_PHASES.OPENCODE_RUNNING, { current_approval_id: approvalId, current_job_id: jobId, current_sandbox_root: sandboxRoot, blocked_reason: approvalRecord.reason }, { rootDir, now, event: 'opencode_approval_record_failed' }); return baseResult({ ok: false, reason: approvalRecord.reason, story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.OPENCODE_RUNNING, story: updated.summary, approval_id: approvalId, job_id: jobId, provider_config: story.last_provider_config || null, next_action: 'fix_opencode_approval_record_failure' }); } const dispatcher = opencode_dispatcher || buildDefaultOpenCodeDispatcher(story, { rootDir, now, env, pre_secret_scan_ok, opencode_command, opencode_args, timeout_ms, nemclaw_spawn }); const opencode = dispatcher({ rootDir, story, approval_id: approvalId, job_id: jobId, sandbox_root: sandboxRoot, task, requested_paths: story.requested_paths || [], now }); const ok = opencode.ok === true; const nextPhase = ok ? LOOP_PHASES.PATCH_PREVIEW : LOOP_PHASES.OPENCODE_RUNNING; const nextAction = ok ? nextActionForPhase(LOOP_PHASES.PATCH_PREVIEW) : failedOpenCodeNextAction(opencode); const retryAfterAt = ok ? null : retryAfterForOpenCodeFailure(opencode, now); const updated = updateStoryForPhase(story, nextPhase, { current_approval_id: approvalId, current_job_id: opencode.job_id || jobId, current_sandbox_root: sandboxRoot, current_candidate_patch_path: opencode.candidate_patch_path || null, current_opencode_runtime_mode: opencode.opencode_runtime_mode || OPENCODE_RUNTIME_MODES.OPENCODE_KIMI_DIRECT, current_opencode_mediator: opencode.mediator || 'opencode-direct', blocked_reason: ok ? null : opencode.reason || 'opencode_dispatch_failed', retry_after_at: retryAfterAt }, { rootDir, now, event: ok ? 'opencode_candidate_patch_created' : 'opencode_dispatch_failed' }); return baseResult({ ok, reason: ok ? null : opencode.reason || 'opencode_dispatch_failed', story_id: story.story_id, from_phase: story.current_phase, to_phase: nextPhase, story: updated.summary, opencode, approval_id: approvalId, job_id: opencode.job_id || jobId, candidate_patch_path: opencode.candidate_patch_path || null, provider_config: story.last_provider_config || null, opencode_runtime_mode: opencode.opencode_runtime_mode || OPENCODE_RUNTIME_MODES.OPENCODE_KIMI_DIRECT, mediator: opencode.mediator || 'opencode-direct', execution_connected: opencode.execution_connected === true, commands_executed: opencode.commands_executed || [], files_modified: opencode.files_modified || [], repository_files_modified: [], next_action: nextAction }); }

function advancePatchPreviewPhase(story, { rootDir, now }) { const preview = buildPatchPreviewForStory(story, { rootDir }); if (!preview.ok) { const updated = updateStoryForPhase(story, LOOP_PHASES.DIFF_APPROVAL_PENDING, { blocked_reason: 'diff_approval_required', retry_after_at: null }, { rootDir, now, event: 'diff_approval_required' }); return baseResult({ ok: true, reason: 'diff_approval_required', story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.DIFF_APPROVAL_PENDING, story: updated.summary, approval_id: story.current_approval_id || null, job_id: story.current_job_id || null, candidate_patch_path: story.current_candidate_patch_path || null, provider_config: story.last_provider_config || null, next_action: nextActionForPhase(LOOP_PHASES.DIFF_APPROVAL_PENDING) }); }
  const approvalId = defaultApplyApprovalId(story);
  const patchApproval = createOpenCodePatchPreviewApproval(preview, { rootDir, now, approval_id: approvalId });
  if (!patchApproval.ok) { const summary = boundedFailureSummary(patchApproval); const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, { blocked_reason: patchApproval.reason || 'patch_preview_approval_failed', last_gate_failure_summary: summary }, { rootDir, now, event: 'patch_preview_approval_failed' }); return baseResult({ ok: false, reason: patchApproval.reason || 'patch_preview_approval_failed', story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.ESCALATED, story: updated.summary, patch_approval: patchApproval, failure_summary: summary, provider_config: story.last_provider_config || null, next_action: 'human_escalation_required' }); }
  const updated = updateStoryForPhase(story, LOOP_PHASES.DIFF_APPROVAL_PENDING, { current_approval_id: patchApproval.approval_id, current_patch_hash: patchApproval.patch_hash, blocked_reason: 'diff_approval_required', retry_after_at: null }, { rootDir, now, event: 'diff_approval_required' });
  return baseResult({ ok: true, reason: 'diff_approval_required', story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.DIFF_APPROVAL_PENDING, story: updated.summary, patch_approval: patchApproval, approval_id: patchApproval.approval_id, job_id: story.current_job_id || null, candidate_patch_path: story.current_candidate_patch_path || null, provider_config: story.last_provider_config || null, next_action: nextActionForPhase(LOOP_PHASES.DIFF_APPROVAL_PENDING) }); }

function advanceApplyPhase(story, { rootDir, now, apply_result = null, timeout_ms }) {
  const effectiveApply = apply_result || (story.current_candidate_patch_path && story.current_patch_hash
    ? applyOpenCodeCandidatePatch({ rootDir, approval_id: story.current_approval_id, patch_hash: story.current_patch_hash, timeout_ms, now: () => now })
    : null);

  // Hard-fail path: the apply itself returned ok=false.
  if (effectiveApply && effectiveApply.ok === false) {
    const summary = boundedFailureSummary(effectiveApply);
    const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, {
      blocked_reason: effectiveApply.reason || 'apply_failed',
      last_gate_failure_summary: summary
    }, { rootDir, now, event: 'apply_failed' });
    return baseResult({
      ok: false,
      reason: effectiveApply.reason || 'apply_failed',
      story_id: story.story_id,
      from_phase: story.current_phase,
      to_phase: LOOP_PHASES.ESCALATED,
      story: updated.summary,
      apply: effectiveApply,
      failure_summary: summary,
      provider_config: story.last_provider_config || null,
      execution_connected: effectiveApply.execution_connected === true,
      commands_executed: effectiveApply.commands_executed || [],
      files_modified: effectiveApply.files_modified || [],
      repository_files_modified: effectiveApply.repository_files_modified || [],
      next_action: 'human_escalation_required'
    });
  }

  // Phase 2 #3b: requested_paths coverage gate.
  //
  // Run between APPLY success and GATES to catch the partial-implementation
  // failure mode observed in PR #137 (smoke) and PR #139 (3a dogfood) where
  // Kimi K2.6 touched only a subset of the declared requested_paths. If any
  // declared path was not touched, route to FIX_LOOP (or ESCALATED if max
  // attempts exhausted) with a focused repair instruction listing exactly
  // the missing paths.
  if (effectiveApply) {
    const coverage = checkRequestedPathsCoverage({ rootDir, story, apply_result: effectiveApply });
    if (!coverage.ok) {
      const attempts = (Number.isInteger(story.attempts) ? story.attempts : 0) + 1;
      const maxAttempts = Number.isInteger(story.max_attempts) ? story.max_attempts : 3;
      const escalate = attempts >= maxAttempts;
      const nextPhase = escalate ? LOOP_PHASES.ESCALATED : LOOP_PHASES.FIX_LOOP;
      const failureSummary = boundedFailureSummary({
        ok: false,
        stage: 'requested_paths_coverage',
        reason: 'requested_paths_coverage_incomplete',
        missing_paths: coverage.missing_paths.slice(0, 20),
        touched_paths: coverage.touched_paths.slice(0, 20),
        stdout_preview: `missing ${coverage.missing_paths.length}/${coverage.requested_paths.length}: ${coverage.missing_paths.join(', ').slice(0, 200)}`,
        stderr_preview: ''
      });
      // Rollback the partial apply so the FIX_LOOP starts clean. Bounded to
      // requested_paths so we never touch operator-owned files.
      const rollback = rollbackAppliedFiles({
        rootDir,
        apply_result: effectiveApply,
        requested_paths: Array.isArray(story.requested_paths) ? story.requested_paths : []
      });
      const updated = updateStoryForPhase(story, nextPhase, {
        attempts,
        blocked_reason: 'requested_paths_coverage_incomplete',
        last_gate_failure_summary: failureSummary,
        last_repair_type: 'requested_paths_coverage',
        last_repair_instruction: escalate ? null : repairInstructionForMissingPaths(coverage.missing_paths),
        last_apply_rollback: rollback,
        last_requested_paths_coverage: {
          ok: false,
          missing_paths: coverage.missing_paths,
          touched_paths: coverage.touched_paths,
          fallback_used: coverage.fallback_used
        }
      }, { rootDir, now, event: escalate ? 'requested_paths_coverage_escalated' : 'requested_paths_coverage_fix_required' });
      return baseResult({
        ok: false,
        reason: 'requested_paths_coverage_incomplete',
        story_id: story.story_id,
        from_phase: story.current_phase,
        to_phase: nextPhase,
        story: updated.summary,
        apply: effectiveApply,
        apply_rollback: rollback,
        coverage,
        failure_summary: failureSummary,
        provider_config: story.last_provider_config || null,
        execution_connected: effectiveApply.execution_connected === true,
        commands_executed: effectiveApply.commands_executed || [],
        files_modified: effectiveApply.files_modified || [],
        repository_files_modified: effectiveApply.repository_files_modified || [],
        next_action: escalate ? 'human_escalation_required' : nextActionForPhase(LOOP_PHASES.FIX_LOOP)
      });
    }
  }

  // Happy path: coverage ok, advance to GATES as before.
  const updated = updateStoryForPhase(story, LOOP_PHASES.GATES, {
    blocked_reason: null,
    retry_after_at: null,
    last_apply_result: effectiveApply ? boundedFailureSummary(effectiveApply) : null
  }, { rootDir, now, event: 'apply_completed_or_deferred' });
  return baseResult({
    ok: true,
    reason: null,
    story_id: story.story_id,
    from_phase: story.current_phase,
    to_phase: LOOP_PHASES.GATES,
    story: updated.summary,
    apply: effectiveApply,
    provider_config: story.last_provider_config || null,
    execution_connected: effectiveApply?.execution_connected === true,
    commands_executed: effectiveApply?.commands_executed || [],
    files_modified: effectiveApply?.files_modified || [],
    repository_files_modified: effectiveApply?.repository_files_modified || [],
    next_action: nextActionForPhase(LOOP_PHASES.GATES)
  });
}
function gateFailureReason(gates, repair) { if (!repair.escalation_required) return gates.reason || 'gates_failed'; if (repair.immediate_escalation) return repair.repair_event.reason; return 'retry_exhausted'; }
function gateBlockedReason(gates, repair) { if (!repair.escalation_required) return gates.reason || 'gates_failed'; if (repair.immediate_escalation) return repair.repair_event.reason; return gates.reason || 'gates_failed'; }
function advanceGatesPhase(story, { rootDir, now, gate_runner, timeout_ms }) {
  const runner = gate_runner || (() => runOpenCodeAppliedPatchGates({ rootDir, approval_id: story.current_approval_id, patch_hash: story.current_patch_hash, timeout_ms, now: () => now }));
  const gates = runner({ rootDir, story, now });

  if (gates.ok === true) {
    let commitApproval = null;
    let nextApprovalId = story.current_approval_id;

    if (!gate_runner) {
      commitApproval = createOpenCodeCommitApproval({
        rootDir,
        approval_id: story.current_approval_id,
        patch_hash: story.current_patch_hash,
        commit_message: commitMessageForStory(story),
        allowed_user_ids: [],
        now
      });

      if (!commitApproval.ok) {
        const summary = boundedFailureSummary(commitApproval);
        const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, { blocked_reason: commitApproval.reason || 'commit_approval_create_failed', last_gate_failure_summary: summary }, { rootDir, now, event: 'commit_approval_create_failed' });
        return baseResult({ ok: false, reason: commitApproval.reason || 'commit_approval_create_failed', story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.ESCALATED, story: updated.summary, gates, failure_summary: summary, provider_config: story.last_provider_config || null, execution_connected: gates.execution_connected === true, commands_executed: gates.commands_executed || [], files_modified: gates.files_modified || [], repository_files_modified: gates.repository_files_modified || [], next_action: 'human_escalation_required' });
      }

      nextApprovalId = commitApproval.approval_id;
    }

    const updated = updateStoryForPhase(story, LOOP_PHASES.COMMIT_APPROVAL_PENDING, {
      current_approval_id: nextApprovalId,
      blocked_reason: null,
      retry_after_at: null,
      last_gate_failure_summary: null,
      last_repair_instruction: null,
      last_commit_approval: commitApproval,
      current_commit_message: commitApproval?.commit_message || commitMessageForStory(story)
    }, { rootDir, now, event: 'gates_passed' });

    return baseResult({ ok: true, reason: null, story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.COMMIT_APPROVAL_PENDING, story: updated.summary, gates, commit_approval: commitApproval, approval_id: nextApprovalId, provider_config: story.last_provider_config || null, execution_connected: gates.execution_connected === true, commands_executed: gates.commands_executed || [], files_modified: gates.files_modified || [], repository_files_modified: gates.repository_files_modified || [], next_action: nextActionForPhase(LOOP_PHASES.COMMIT_APPROVAL_PENDING) });
  }

  const attempts = Number.isInteger(story.attempts) ? story.attempts + 1 : 1;
  const maxAttempts = Number.isInteger(story.max_attempts) ? story.max_attempts : 3;
  const summary = boundedFailureSummary(gates);
  const repair = buildRepairDecision({ story, failure: summary, attempts, max_attempts: maxAttempts, now });
  const nextPhase = repair.escalation_required ? LOOP_PHASES.ESCALATED : LOOP_PHASES.FIX_LOOP;
  const repairHistory = appendRepairHistory(story, repair.repair_event);
  // Phase 1 #7 fix: when GATES -> ESCALATED, roll back the APPLY step so the
  // applied file does not linger in the working tree and trip
  // working_tree_dirty on every subsequent story's sandbox preflight.
  // Phase 5 #7 extension: also roll back when GATES -> FIX_LOOP. Otherwise
  // the next Kimi dispatch produces a patch claiming `new file mode 100644`
  // for the just-applied path; the dispatcher's pathExistsInRepo validator
  // (nemoclaw-opencode-gateway.js::validateCandidatePatchAgainstRepository)
  // then rejects every retry with `candidate_patch_existing_file_marked_new`,
  // burning all attempts before any real repair can happen. Phase 5 #7 E2E
  // smoke walked into this exact trap: story succeeded through APPLY,
  // gates failed, FIX_LOOP triggered without rollback, all 3 attempts
  // rejected by the validator. The rollback is bounded to
  // (repository_files_modified ∩ requested_paths) of this story; no other
  // path can be touched.
  const rollback = rollbackAppliedFiles({
    rootDir,
    apply_result: story.last_apply_result || gates,
    requested_paths: Array.isArray(story.requested_paths) ? story.requested_paths : []
  });
  const updated = updateStoryForPhase(story, nextPhase, { attempts, blocked_reason: gateBlockedReason(gates, repair), retry_after_at: null, last_gate_failure_summary: summary, last_repair_type: repair.failure_type, last_repair_instruction: repair.escalation_required ? null : repair.repair_instruction, repair_history: repairHistory, last_apply_rollback: rollback }, { rootDir, now, event: repair.escalation_required ? 'gate_repair_escalated' : 'gate_failed_fix_required' });
  return baseResult({ ok: false, reason: gateFailureReason(gates, repair), story_id: story.story_id, from_phase: story.current_phase, to_phase: nextPhase, story: updated.summary, gates, repair, apply_rollback: rollback, failure_summary: summary, provider_config: story.last_provider_config || null, execution_connected: gates.execution_connected === true, commands_executed: gates.commands_executed || [], files_modified: gates.files_modified || [], repository_files_modified: gates.repository_files_modified || [], next_action: repair.next_action });
}

function trunkBranchForPromotion(env = process.env) {
  return env.RALPH_PR_BASE_BRANCH || env.RALPH_TRUNK_BRANCH || 'infra/phase0-autonomous-foundation';
}

function advanceCommitPhase(story, { rootDir, now, timeout_ms, env = process.env }) {
  const commit = commitOpenCodeAppliedPatch({ rootDir, approval_id: story.current_approval_id, timeout_ms, now: () => now });
  if (!commit.ok) {
    const summary = boundedFailureSummary(commit);
    // Phase 1 #8 fix: a commit failure leaves the applied file uncommitted in
    // the working tree. The scheduler's critical-section lock prevents new
    // stories from starting an APPLY while this story is in COMMIT, but the
    // failed story itself must clean up after itself or the leftover file
    // would block the next preflight after the lock releases.
    const rollback = rollbackAppliedFiles({
      rootDir,
      apply_result: story.last_apply_result || commit,
      requested_paths: Array.isArray(story.requested_paths) ? story.requested_paths : []
    });
    const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, { blocked_reason: commit.reason || 'commit_failed', last_gate_failure_summary: summary, last_apply_rollback: rollback }, { rootDir, now, event: 'commit_failed' });
    return baseResult({ ok: false, reason: commit.reason || 'commit_failed', story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.ESCALATED, story: updated.summary, failure_summary: summary, apply_rollback: rollback, provider_config: story.last_provider_config || null, execution_connected: commit.execution_connected === true, commands_executed: commit.commands_executed || [], files_modified: commit.files_modified || [], repository_files_modified: commit.repository_files_modified || [], commit_allowed: false, next_action: 'human_escalation_required' });
  }

  // Phase 1 #13: promote the just-created commit onto a per-story feature
  // branch and rewind trunk back to its prior tip. Without this, the
  // autonomous loop pushes every story's commit directly to trunk and the
  // subsequent PR creation fails with `base_branch_matches_head`
  // (head=base=trunk). After this step, head=auto/<story-id>, base=trunk.
  const trunkBranch = trunkBranchForPromotion(env);
  const featureBranch = featureBranchForStory(story.story_id);
  const promote = promoteCommitToFeatureBranch({
    rootDir,
    story_id: story.story_id,
    commit_sha: commit.commit_sha,
    trunk_branch: trunkBranch,
    feature_branch: featureBranch
  });
  if (!promote.ok) {
    const summary = boundedFailureSummary(commit);
    const rollback = rollbackAppliedFiles({
      rootDir,
      apply_result: story.last_apply_result || commit,
      requested_paths: Array.isArray(story.requested_paths) ? story.requested_paths : []
    });
    const updated = updateStoryForPhase(story, LOOP_PHASES.ESCALATED, { blocked_reason: promote.reason || 'feature_branch_promote_failed', last_gate_failure_summary: summary, last_apply_rollback: rollback, last_feature_branch_promote: promote }, { rootDir, now, event: 'feature_branch_promote_failed' });
    return baseResult({ ok: false, reason: promote.reason || 'feature_branch_promote_failed', story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.ESCALATED, story: updated.summary, failure_summary: summary, apply_rollback: rollback, feature_branch_promote: promote, provider_config: story.last_provider_config || null, execution_connected: false, commands_executed: commit.commands_executed || [], files_modified: commit.files_modified || [], repository_files_modified: commit.repository_files_modified || [], commit_allowed: false, next_action: 'human_escalation_required' });
  }

  const updated = updateStoryForPhase(story, LOOP_PHASES.PUSH_APPROVAL_PENDING, {
    blocked_reason: null,
    retry_after_at: null,
    last_commit_result: boundedFailureSummary(commit),
    current_commit_sha: commit.commit_sha || null,
    current_branch: promote.feature_branch,
    base_branch: promote.trunk_branch,
    last_feature_branch_promote: promote
  }, { rootDir, now, event: 'commit_completed' });
  return baseResult({ ok: true, reason: null, story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.PUSH_APPROVAL_PENDING, story: updated.summary, provider_config: story.last_provider_config || null, execution_connected: commit.execution_connected === true, commands_executed: commit.commands_executed || [], files_modified: commit.files_modified || [], repository_files_modified: commit.repository_files_modified || [], commit_allowed: false, feature_branch_promote: promote, next_action: nextActionForPhase(LOOP_PHASES.PUSH_APPROVAL_PENDING) });
}

function advanceFixLoopPhase(story, { rootDir, now }) { const updated = updateStoryForPhase(story, LOOP_PHASES.OPENCODE_RUNNING, { blocked_reason: null, retry_after_at: null, current_job_id: null, current_candidate_patch_path: null }, { rootDir, now, event: 'fix_loop_dispatch_ready' }); return baseResult({ ok: true, reason: null, story_id: story.story_id, from_phase: story.current_phase, to_phase: LOOP_PHASES.OPENCODE_RUNNING, story: updated.summary, failure_summary: story.last_gate_failure_summary || null, repair: { failure_type: story.last_repair_type || null, repair_instruction: story.last_repair_instruction || null }, provider_config: story.last_provider_config || null, next_action: nextActionForPhase(LOOP_PHASES.OPENCODE_RUNNING) }); }
function advanceTerminalPhase(story) { return baseResult({ ok: true, reason: 'story_terminal', story_id: story.story_id, from_phase: story.current_phase, to_phase: story.current_phase, story: summarizeStory(story), provider_config: story.last_provider_config || null, next_action: nextActionForPhase(story.current_phase) }); }
function tickAutonomousLoop({ rootDir = process.cwd(), story_id, now = new Date(), approvals = {}, env = process.env, pre_secret_scan_ok = false, opencode_dispatcher, opencode_command, opencode_args, gate_runner, apply_result, timeout_ms, nemclaw_spawn } = {}) { if (!story_id) return baseResult({ reason: 'story_id_required' }); const story = readStory(rootDir, story_id); if (!story) return baseResult({ reason: 'story_not_found', story_id }); if (story.status === STORY_STATUSES.STOPPED || story.current_phase === LOOP_PHASES.STOPPED) return advanceTerminalPhase(story); if (story.status === STORY_STATUSES.COMPLETED || story.current_phase === LOOP_PHASES.DONE) return advanceTerminalPhase(story); if (story.status === STORY_STATUSES.FAILED || story.current_phase === LOOP_PHASES.ESCALATED) return advanceTerminalPhase(story); switch (story.current_phase || LOOP_PHASES.PLAN) { case LOOP_PHASES.PLAN: return advancePlanPhase(story, { rootDir, now, env }); case LOOP_PHASES.PLAN_APPROVAL_PENDING: case LOOP_PHASES.DIFF_APPROVAL_PENDING: case LOOP_PHASES.COMMIT_APPROVAL_PENDING: case LOOP_PHASES.PUSH_APPROVAL_PENDING: case LOOP_PHASES.PR_APPROVAL_PENDING: return advanceWaitingApprovalPhase(story, { rootDir, now, approvals }); case LOOP_PHASES.OPENCODE_RUNNING: return advanceOpenCodeRunningPhase(story, { rootDir, now, env, pre_secret_scan_ok, opencode_dispatcher, opencode_command, opencode_args, timeout_ms, nemclaw_spawn }); case LOOP_PHASES.PATCH_PREVIEW: return advancePatchPreviewPhase(story, { rootDir, now }); case LOOP_PHASES.APPLY: return advanceApplyPhase(story, { rootDir, now, apply_result, timeout_ms }); case LOOP_PHASES.GATES: return advanceGatesPhase(story, { rootDir, now, gate_runner, timeout_ms }); case LOOP_PHASES.COMMIT: return advanceCommitPhase(story, { rootDir, now, timeout_ms, env }); case LOOP_PHASES.FIX_LOOP: return advanceFixLoopPhase(story, { rootDir, now }); default: return baseResult({ ok: false, reason: 'loop_phase_not_supported_yet', story_id: story.story_id, from_phase: story.current_phase, to_phase: story.current_phase, story: summarizeStory(story), provider_config: story.last_provider_config || null, next_action: 'implement_next_autonomous_loop_phase' }); } }
function pauseStory(story_id, { rootDir = process.cwd(), now = new Date(), reason = 'operator_pause' } = {}) { const updated = updateStory(story_id, { status: STORY_STATUSES.STOPPED, current_phase: LOOP_PHASES.STOPPED, blocked_reason: reason }, { rootDir, now, event: 'story_paused' }); if (!updated.ok) return baseResult({ reason: updated.reason, story_id }); return baseResult({ ok: true, story_id, from_phase: null, to_phase: LOOP_PHASES.STOPPED, story: updated.summary, provider_config: updated.story?.last_provider_config || null, reason: null, next_action: 'story_stopped' }); }

module.exports = { AUTONOMOUS_LOOP_VERSION, OPENCODE_RATE_LIMIT_BACKOFF_MS, OPENCODE_AGENT_OUTPUT_CONTRACT_BACKOFF_MS, OPENCODE_RUNTIME_MODES, LOOP_PHASES, boundedFailureSummary, defaultApprovalId, defaultApplyApprovalId, defaultJobId, defaultSandboxRoot, taskForStory, phaseForUltraPlan, statusForPhase, nextActionForPhase, currentSafeProviderConfig, failedOpenCodeNextAction, retryAfterForOpenCodeFailure, persistedApprovalIsApproved, buildPatchPreviewForStory, buildOpenCodePreflight, directOpenCodeDevOnlyAllowed, opencodeKimiDirectEnabled, nemoclawDispatcherExplicitlyEnabled, buildDefaultOpenCodeDispatcher, tickAutonomousLoop, pauseStory };
