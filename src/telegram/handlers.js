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
const { previewOpenCodeCandidatePatch } = require('./opencode-patch-preview');
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
  if (!result.ok) {
    return `Run-all failed: ${summary.reason || 'unknown'}${jsonBlock(summary)}`;
  }

  if (summary.commands_executed.length > 0) {
    return `Run-all execution completed.${jsonBlock(summary)}`;
  }

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

function openCodePatchPreviewResponseText(result) {
  if (!result.ok) return `OpenCode candidate patch preview blocked: ${result.reason}${jsonBlock(result)}`;
  return `OpenCode candidate patch preview ready. Patch apply remains disabled.${jsonBlock(result)}`;
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
    const intent = parsed.args.join(' ');
    const plan = makeOpenCodeDryRunPlan(intent);
    const summary = summarizeOpenCodeDryRunPlan(plan);
    return textResponse(openCodePlanResponseText(plan), {
      result: plan,
      summary,
      wired_to_runtime: false,
      execution_connected: false
    });
  }

  if (parsed.type === 'opencode_sandbox_plan') {
    const [approvalId, ...intentParts] = parsed.args;
    const plan = makeOpenCodeSandboxPlan({ approval_id: approvalId, intent: intentParts.join(' ') });
    const summary = summarizeOpenCodeSandboxPlan(plan);
    return textResponse(openCodeSandboxPlanResponseText(plan), {
      result: plan,
      summary,
      wired_to_runtime: false,
      execution_connected: false,
      opencode_execution_enabled: false
    });
  }

  if (parsed.type === 'opencode_sandbox_preflight') {
    const [approvalId, sandboxRoot, ...requestedPaths] = parsed.args;
    const result = opencodeSandboxRunnerPreflight({
      rootDir,
      approval_id: approvalId,
      sandbox_root: sandboxRoot,
      requested_paths: requestedPaths,
      pre_secret_scan_ok: context.pre_secret_scan_ok === true,
      env: context.env || process.env,
      now: context.now || new Date()
    });
    return textResponse(openCodeSandboxPreflightResponseText(result), {
      result,
      summary: result,
      wired_to_runtime: false,
      execution_connected: false,
      opencode_execution_started: false
    });
  }

  if (parsed.type === 'opencode_patch_preview') {
    const [approvalId, sandboxRoot, candidatePatchPath] = parsed.args;
    const result = previewOpenCodeCandidatePatch({
      rootDir,
      approval_id: approvalId,
      sandbox_root: sandboxRoot,
      candidate_patch_path: candidatePatchPath
    });
    return textResponse(openCodePatchPreviewResponseText(result), {
      result,
      summary: result,
      wired_to_runtime: false,
      execution_connected: false,
      apply_allowed: false
    });
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
    const summary = summarizeApproval(approval);
    return textResponse(`Approval:${jsonBlock(summary)}`, { approval: summary, wired_to_runtime: false });
  }

  if (parsed.type === 'mode_approval') {
    const result = setApprovalMode(userId, { rootDir, roles, reason: 'telegram_mode_approval' });
    return textResponse(result.ok ? `Mode changed to approval.${jsonBlock(result.mode)}` : `Mode change denied: ${result.reason}`, { result });
  }

  if (parsed.type === 'mode_fullauto_request') {
    const hours = parsed.args[0] ? Number(parsed.args[0]) : undefined;
    const result = requestFullautoMode(userId, { rootDir, roles, hours });
    if (!result.ok) return textResponse(`Fullauto request denied: ${result.reason}`, { result });
    return textResponse(`Fullauto confirmation required. Run:\n/confirm ${result.token}`, { result });
  }

  if (parsed.type === 'confirm') {
    const [token] = parsed.args;
    const result = confirmFullautoMode(token, userId, { rootDir, roles });
    return textResponse(result.ok ? `Fullauto enabled.${jsonBlock(result.mode)}` : `Confirm failed: ${result.reason}`, { result });
  }

  if (parsed.type === 'approve') {
    const [approvalId] = parsed.args;
    if (!approvalId) return textResponse('Usage: /approve <approval_id>', { wired_to_runtime: false });
    const result = approveFromTelegram(approvalId, userId, { rootDir });
    return textResponse(result.ok ? `Approval marked approved. Execution remains disconnected.${jsonBlock(result)}` : `Approve failed: ${result.reason}${jsonBlock(result)}`, { result, wired_to_runtime: false });
  }

  if (parsed.type === 'deny') {
    const [approvalId] = parsed.args;
    if (!approvalId) return textResponse('Usage: /deny <approval_id>', { wired_to_runtime: false });
    const result = denyFromTelegram(approvalId, userId, { rootDir });
    return textResponse(result.ok ? `Approval denied. Execution remains disconnected.${jsonBlock(result)}` : `Deny failed: ${result.reason}${jsonBlock(result)}`, { result, wired_to_runtime: false });
  }

  if (parsed.type === 'modify') {
    const [approvalId, ...instructionParts] = parsed.args;
    if (!approvalId || instructionParts.length === 0) return textResponse('Usage: /modify <approval_id> <instruction>', { wired_to_runtime: false });
    const result = modifyFromTelegram(approvalId, userId, instructionParts.join(' '), { rootDir });
    return textResponse(result.ok ? `Approval superseded. Replan required. Execution remains disconnected.${jsonBlock(result)}` : `Modify failed: ${result.reason}${jsonBlock(result)}`, { result, wired_to_runtime: false });
  }

  if (parsed.type === 'execute_noop') {
    const [approvalId, planPath] = parsed.args;
    if (!approvalId || !planPath) return textResponse('Usage: /execute-noop <approval_id> .ralph/tmp/<plan>.json', { wired_to_runtime: false });
    const result = executeNoopFromTelegram(approvalId, planPath, { rootDir });
    return textResponse(result.ok ? `No-op execution completed. Execution remains disconnected.${jsonBlock(result)}` : `No-op execution failed: ${result.reason}${jsonBlock(result)}`, { result, wired_to_runtime: false });
  }

  if (parsed.type === 'run_all') {
    const [approvalId, planPath] = parsed.args;
    if (!approvalId || !planPath) return textResponse('Usage: /run-all <approval_id> .ralph/tmp/<plan>.json', { wired_to_runtime: false });
    const result = runAllFromTelegram(approvalId, planPath, { rootDir, env: context.env });
    const summary = summarizeRunAllResult(result);
    return textResponse(runAllResponseText(result), { result, summary, wired_to_runtime: result.wired_to_runtime === true });
  }

  return textResponse('Unknown or unsupported command in Phase 2 skeleton.', { parsed });
}

module.exports = { handleTelegramCommand, summarizeRunAllResult, runAllResponseText, durationMs, normalizeRunAllReason, RUN_ALL_FAILURE_REASON_TAXONOMY, openCodePlanResponseText, openCodeSandboxPlanResponseText, openCodeSandboxPreflightResponseText, openCodePatchPreviewResponseText };
