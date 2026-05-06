const { loadState } = require('../ralph/state-machine');
const { loadMode, requestFullautoMode, confirmFullautoMode, setApprovalMode } = require('../ralph/mode-manager');
const { loadRoles } = require('../ralph/roles');
const { listApprovals, getApproval, summarizeApproval } = require('../ralph/approval-reader');
const { approveFromTelegram, denyFromTelegram, modifyFromTelegram } = require('./approval-adapter');
const { executeNoopFromTelegram } = require('./execution-adapter');

function textResponse(text, extra = {}) {
  return { ok: true, text, ...extra };
}

function jsonBlock(value) {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
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

  return textResponse('Unknown or unsupported command in Phase 2 skeleton.', { parsed });
}

module.exports = { handleTelegramCommand };
