const { appendAuditEvent } = require('../ralph/audit-log');

function auditTelegramCommand(event, options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const auditEvent = {
    event: 'telegram_command',
    command_type: event.command_type,
    user_id: event.user_id,
    chat_id: event.chat_id,
    ok: event.ok,
    reason: event.reason || null,
    execution_connected: event.execution_connected || false
  };

  if (event.summary) {
    auditEvent.summary = event.summary;
  }

  return appendAuditEvent(auditEvent, {
    filePath: `${rootDir}/.ralph/logs/audit.jsonl`
  });
}

module.exports = {
  auditTelegramCommand
};
