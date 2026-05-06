const { appendAuditEvent } = require('../ralph/audit-log');

function auditTelegramCommand(event, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  return appendAuditEvent({
    event: 'telegram_command',
    command_type: event.command_type,
    user_id: event.user_id,
    chat_id: event.chat_id,
    ok: event.ok,
    reason: event.reason || null,
    execution_connected: event.execution_connected || false
  }, {
    filePath: `${rootDir}/.ralph/logs/audit.jsonl`
  });
}

module.exports = {
  auditTelegramCommand
};
