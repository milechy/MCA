const { loadState } = require('../ralph/state-machine');
const { loadMode, requestFullautoMode, confirmFullautoMode, setApprovalMode } = require('../ralph/mode-manager');
const { loadRoles } = require('../ralph/roles');

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

  if (parsed.type === 'ping') {
    return textResponse('pong');
  }

  if (parsed.type === 'status') {
    const status = {
      state: loadState(rootDir),
      mode: loadMode(rootDir)
    };
    return textResponse(`Status:${jsonBlock(status)}`, { status });
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
    return textResponse(`${parsed.type} command parsed but execution is not connected in Phase 2 skeleton.`, {
      parsed,
      execution_connected: false
    });
  }

  return textResponse('Unknown or unsupported command in Phase 2 skeleton.', { parsed });
}

module.exports = {
  handleTelegramCommand
};
