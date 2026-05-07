const { loadState } = require('../ralph/state-machine');
const { loadMode, requestFullautoMode, confirmFullautoMode, setApprovalMode } = require('../ralph/mode-manager');
const { loadRoles } = require('../ralph/roles');
const { listApprovals, getApproval, summarizeApproval } = require('../ralph/approval-reader');
const { approveFromTelegram, denyFromTelegram, modifyFromTelegram } = require('./approval-adapter');
const { executeNoopFromTelegram, runAllFromTelegram } = require('./execution-adapter');
const { executionPolicyStatus } = require('./policy-reader');
const { makeOpenCodeDryRunPlan, summarizeOpenCodeDryRunPlan } = require('./opencode-dry-run');
const { makeOpenCodeSandboxPlan, summarizeOpenCodeSandboxPlan } = require('./opencode-sandbox-plan');
const { opencodeSandboxRunnerPreflight } = require('./opencode-sandbox-preflight');
const { runOpenCodeCandidatePatch } = require('./opencode-run');
const { previewOpenCodeCandidatePatch } = require('./opencode-patch-preview');
const { createOpenCodePatchPreviewApproval } = require('./opencode-patch-approval');
const { approvedOpenCodeApplyPreflight } = require('./opencode-apply-preflight');
const { applyOpenCodeCandidatePatch } = require('./opencode-apply');
const { runOpenCodeAppliedPatchGates } = require('./opencode-gates');
const { createOpenCodeCommitApproval } = require('./opencode-commit-approval');
const { commitOpenCodeAppliedPatch } = require('./opencode-commit');
const {
  RUN_ALL_FAILURE_REASON_TAXONOMY,
  normalizeRunAllReason
} = require('./run-all-taxonomy');

function textResponse(text, extra = {}) {
  return { ok: true, text, ...extra };
}

function jsonBlock(value) {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function durationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function summarizeRunAllResult(result) {
  const startedAt = result.started_at || null;
  const finishedAt = result.finished_at || null;
  const reason = normalizeRunAllReason(result.reason);
  return {
    ok: result.ok,
    reason,
    reason_taxonomy: result.ok ? null : RUN_ALL_FAILURE_REASON_TAXONOMY,
    stage: result.stage || null,
    executor: result.executor || null,
    command: result.command || 'scripts/gates/run-all.sh',
    exit_code: typeof result.exit_code === 'number' ? result.exit_code : null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs(startedAt, finishedAt),
    run_all_enabled: result.run_all_enabled === true,
    wired_to_runtime: result.wired_to_runtime === true,
    execution_connected: result.execution_connected === true,
    commands_executed: result.commands_executed || [],
    files_modified: result.files_modified || [],
    approval_id: result.approval_id || result.execution_preflight?.approval?.approval_id || null,
    plan_path: result.plan_path || null,
    log_path: '.ralph/logs/execution.jsonl'
  };
}

function runAllResponseText(result) {
  const summary = summarizeRunAllResult(result);
  if (!result.ok) return `Run-all failed: ${summary.reason || 'unknown'}${jsonBlock(summary)}`;
  if (summary.commands_executed.length > 0) return `Run-all execution completed.${jsonBlock(summary)}`;
  return `Run-all preflight passed. ${summary.reason}.${jsonBlock(summary)}`;
}

function openCodePlanResponseText(plan) {
  const summary = summarizeOpenCodeDryRunPlan(plan);
  if (!summary.ok) return `OpenCode dry-run plan blocked: ${summary.reason}${jsonBlock(summary)}`;
  return `OpenCode dry-run plan ready. Execution remains disconnected.${jsonBlock(summary)}`;
}

function openCodeSandboxPlanResponseText(plan) {
  const summary = summarizeOpenCodeSandboxPlan(plan);
  if (!summary.ok) return `OpenCode sandbox plan blocked: ${summary.reason}${jsonBlock(summary)}`;
  return `OpenCode sandbox plan ready. OpenCode execution remains disabled.${jsonBlock(summary)}`;
}

function openCodeSandboxPreflightResponseText(result) {
  if (!result.ok) return `OpenCode sandbox runner preflight blocked: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode sandbox runner preflight passed. Execution still not started.${jsonBlock(result)}`;
}

function openCodeRunResponseText(result) {
  if (!result.ok) return `OpenCode run failed: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode run completed. candidate.patch is ready; apply remains disabled.${jsonBlock(result)}`;
}

function openCodePatchPreviewResponseText(result) {
  if (!result.ok) return `OpenCode candidate patch preview blocked: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode candidate patch preview ready. Patch apply remains disabled.${jsonBlock(result)}`;
}

function openCodePatchApprovalResponseText(result) {
  if (!result.ok) return `OpenCode patch preview approval blocked: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode patch preview approval requested. Patch apply remains disabled.${jsonBlock(result)}`;
}

function openCodeApplyPreflightResponseText(result) {
  if (!result.ok) return `OpenCode apply preflight blocked: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode apply preflight passed. Patch may be applied by controlled apply step.${jsonBlock(result)}`;
}

function openCodeApplyResponseText(result) {
  if (!result.ok) return `OpenCode apply failed: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode apply completed. Review diff and run gates.${jsonBlock(result)}`;
}

function openCodeGatesResponseText(result) {
  if (!result.ok) return `OpenCode gates failed: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode gates passed. Review diff before commit.${jsonBlock(result)}`;
}

function openCodeCommitApprovalResponseText(result) {
  if (!result.ok) return `OpenCode commit approval blocked: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode commit approval requested. Commit remains disabled until approval.${jsonBlock(result)}`;
}

function openCodeCommitResponseText(result) {
  if (!result.ok) return `OpenCode commit failed: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode commit completed. Push remains disabled.${jsonBlock(result)}`;
}

function handleTelegramCommand(parsed, context = {}) {
  const rootDir = context.rootDir || process.cwd();
  const userId = context.user_id;
  const roles = context.roles || loadRoles(rootDir);

  if (parsed.type === 'ping') return textResponse('pong');
  if (parsed.type === 'status') {
    const status = { state: loadState(rootDir), mode: loadMode(rootDir) };
    return textResponse(`Status:${jsonBlock(status)}`, { status });
  }
  if (parsed.type === 'policy') {
    const policy = executionPolicyStatus(context.env || process.env);
    return textResponse(`Execution policy:${jsonBlock(policy)}`, { policy, wired_to_runtime: false });
  }
  if (parsed.type === 'opencode_plan') {
    const plan = makeOpenCodeDryRunPlan(parsed.args.join(' '));
    return textResponse(openCodePlanResponseText(plan), { result: plan, summary: summarizeOpenCodeDryRunPlan(plan), wired_to_runtime: false, execution_connected: false });
  }
  if (parsed.type === 'opencode_sandbox_plan') {
    const [approvalId, ...intentParts] = parsed.args;
    const plan = makeOpenCodeSandboxPlan({ approval_id: approvalId, intent: intentParts.join(' ') });
    return textResponse(openCodeSandboxPlanResponseText(plan), { result: plan, summary: summarizeOpenCodeSandboxPlan(plan), wired_to_runtime: false, execution_connected: false, opencode_execution_enabled: false });
  }
  if (parsed.type === 'opencode_sandbox_preflight') {
    const [approvalId, sandboxRoot, ...requestedPaths] = parsed.args;
    const result = opencodeSandboxRunnerPreflight({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot, requested_paths: requestedPaths, pre_secret_scan_ok: context.pre_secret_scan_ok === true, env: context.env || process.env, now: context.now || new Date() });
    return textResponse(openCodeSandboxPreflightResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: false, opencode_execution_started: false });
  }
  if (parsed.type === 'opencode_run') {
    const [approvalId, sandboxRoot, ...taskParts] = parsed.args;
    const preflight = opencodeSandboxRunnerPreflight({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot, requested_paths: context.requested_paths || [], pre_secret_scan_ok: context.pre_secret_scan_ok === true, env: context.env || process.env, now: context.now || new Date() });
    const result = runOpenCodeCandidatePatch(preflight, { rootDir, task: taskParts.join(' '), command: context.opencode_command, args: context.opencode_args, env: context.env || process.env, timeout_ms: context.timeout_ms, now: context.nowFn });
    return textResponse(openCodeRunResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: result.execution_connected === true, apply_allowed: false });
  }
  if (parsed.type === 'opencode_patch_preview') {
    const [approvalId, sandboxRoot, candidatePatchPath] = parsed.args;
    const result = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot, candidate_patch_path: candidatePatchPath });
    return textResponse(openCodePatchPreviewResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: false, apply_allowed: false });
  }
  if (parsed.type === 'opencode_patch_approval') {
    const [approvalId, sandboxRoot, candidatePatchPath, patchApprovalId] = parsed.args;
    const preview = previewOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, sandbox_root: sandboxRoot, candidate_patch_path: candidatePatchPath });
    const result = createOpenCodePatchPreviewApproval(preview, { rootDir, approval_id: patchApprovalId || undefined, allowed_user_ids: userId ? [userId] : [], now: context.now || new Date() });
    return textResponse(openCodePatchApprovalResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: false, apply_allowed: false });
  }
  if (parsed.type === 'opencode_apply_preflight') {
    const [approvalId, patchHash] = parsed.args;
    const result = approvedOpenCodeApplyPreflight({ rootDir, approval_id: approvalId, patch_hash: patchHash });
    return textResponse(openCodeApplyPreflightResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: false, apply_allowed: result.apply_allowed === true });
  }
  if (parsed.type === 'opencode_apply') {
    const [approvalId, patchHash] = parsed.args;
    const result = applyOpenCodeCandidatePatch({ rootDir, approval_id: approvalId, patch_hash: patchHash, timeout_ms: context.timeout_ms, now: context.nowFn });
    return textResponse(openCodeApplyResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: result.execution_connected === true, apply_allowed: result.apply_allowed === true });
  }
  if (parsed.type === 'opencode_gates') {
    const [approvalId, patchHash] = parsed.args;
    const result = runOpenCodeAppliedPatchGates({ rootDir, approval_id: approvalId, patch_hash: patchHash, timeout_ms: context.timeout_ms, now: context.nowFn });
    return textResponse(openCodeGatesResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: result.execution_connected === true });
  }
  if (parsed.type === 'opencode_commit_approval') {
    const [approvalId, patchHash, ...messageParts] = parsed.args;
    const result = createOpenCodeCommitApproval({ rootDir, approval_id: approvalId, patch_hash: patchHash, commit_message: messageParts.join(' '), allowed_user_ids: userId ? [userId] : [], now: context.now || new Date() });
    return textResponse(openCodeCommitApprovalResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: false, commit_allowed: false });
  }
  if (parsed.type === 'opencode_commit') {
    const [approvalId] = parsed.args;
    const result = commitOpenCodeAppliedPatch({ rootDir, approval_id: approvalId, timeout_ms: context.timeout_ms, now: context.nowFn });
    return textResponse(openCodeCommitResponseText(result), { result, summary: result, wired_to_runtime: false, execution_connected: result.execution_connected === true, commit_allowed: result.commit_allowed === true });
  }
  if (parsed.type === 'approvals') {
    const approvals = listApprovals({ rootDir, status: parsed.args[0] || null }).map(summarizeApproval);
    return textResponse(`Approvals:${jsonBlock(approvals)}`, { approvals, wired_to_runtime: false });
  }
  if (parsed.type === 'approval_detail') {
    const [approvalId] = parsed.args;
    if (!approvalId) return textResponse('Usage: /approval <approval_id>', { wired_to_runtime: false });
    const approval = getApproval(approvalId, { rootDir });
    if (!approval) return textResponse(`Approval not found: ${approvalId}`, { wired_to_runtime: false });
    return textResponse(`Approval:${jsonBlock(summarizeApproval(approval))}`, { approval: summarizeApproval(approval), wired_to_runtime: false });
  }
  if (parsed.type === 'mode_approval') return textResponse(setApprovalMode(userId, { rootDir, roles, reason: 'telegram_mode_approval' }).ok ? `Mode changed to approval.${jsonBlock(loadMode(rootDir))}` : 'Mode change denied', { result: setApprovalMode(userId, { rootDir, roles, reason: 'telegram_mode_approval' }) });
  if (parsed.type === 'mode_fullauto_request') {
    const result = requestFullautoMode(userId, { rootDir, roles, hours: parsed.args[0] ? Number(parsed.args[0]) : undefined });
    return result.ok ? textResponse(`Fullauto confirmation required. Run:\n/confirm ${result.token}`, { result }) : textResponse(`Fullauto request denied: ${result.reason}`, { result });
  }
  if (parsed.type === 'confirm') {
    const result = confirmFullautoMode(parsed.args[0], userId, { rootDir, roles });
    return textResponse(result.ok ? `Fullauto enabled.${jsonBlock(result.mode)}` : `Confirm failed: ${result.reason}`, { result });
  }
  if (parsed.type === 'approve') {
    const result = approveFromTelegram(parsed.args[0], userId, { rootDir });
    return textResponse(result.ok ? `Approval marked approved. Execution remains disconnected.${jsonBlock(result)}` : `Approve failed: ${result.reason}${jsonBlock(result)}`, { result, wired_to_runtime: false });
  }
  if (parsed.type === 'deny') {
    const result = denyFromTelegram(parsed.args[0], userId, { rootDir });
    return textResponse(result.ok ? `Approval denied. Execution remains disconnected.${jsonBlock(result)}` : `Deny failed: ${result.reason}${jsonBlock(result)}`, { result, wired_to_runtime: false });
  }
  if (parsed.type === 'modify') {
    const [approvalId, ...instructionParts] = parsed.args;
    const result = modifyFromTelegram(approvalId, userId, instructionParts.join(' '), { rootDir });
    return textResponse(result.ok ? `Approval superseded. Replan required. Execution remains disconnected.${jsonBlock(result)}` : `Modify failed: ${result.reason}${jsonBlock(result)}`, { result, wired_to_runtime: false });
  }
  if (parsed.type === 'execute_noop') {
    const result = executeNoopFromTelegram(parsed.args[0], parsed.args[1], { rootDir });
    return textResponse(result.ok ? `No-op execution completed. Execution remains disconnected.${jsonBlock(result)}` : `No-op execution failed: ${result.reason}${jsonBlock(result)}`, { result, wired_to_runtime: false });
  }
  if (parsed.type === 'run_all') {
    const result = runAllFromTelegram(parsed.args[0], parsed.args[1], { rootDir, env: context.env });
    return textResponse(runAllResponseText(result), { result, summary: summarizeRunAllResult(result), wired_to_runtime: result.wired_to_runtime === true });
  }
  return textResponse('Unknown or unsupported command in Phase 2 skeleton.', { parsed });
}

module.exports = { handleTelegramCommand, summarizeRunAllResult, runAllResponseText, durationMs, normalizeRunAllReason, RUN_ALL_FAILURE_REASON_TAXONOMY, openCodePlanResponseText, openCodeSandboxPlanResponseText, openCodeSandboxPreflightResponseText, openCodeRunResponseText, openCodePatchPreviewResponseText, openCodePatchApprovalResponseText, openCodeApplyPreflightResponseText, openCodeApplyResponseText, openCodeGatesResponseText, openCodeCommitApprovalResponseText, openCodeCommitResponseText };
