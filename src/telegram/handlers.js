const { loadState } = require('../ralph/state-machine');
const { loadMode, requestFullautoMode, confirmFullautoMode, setApprovalMode } = require('../ralph/mode-manager');
const { loadRoles } = require('../ralph/roles');
const { listApprovals, getApproval, summarizeApproval } = require('../ralph/approval-reader');

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

  if (['approve', 'deny', 'modify'].includes(parsed.type)) {
    return textResponse(`${parsed.type} command parsed but runtime action is not wired in Phase 2.`, { parsed, wired_to_runtime: false });
  }

  return textResponse('Unknown or unsupported command in Phase 2 skeleton.', { parsed });
}

module.exports = { handleTelegramCommand };
